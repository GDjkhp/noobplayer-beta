//! Community skin + visualizer galleries (skins.json / visualizers.json in the
//! project root). No accounts: the edit token handed back on publish is the only
//! proof of authorship. Skins are sanitised (CSS); visualizer code is stored
//! verbatim — the safety for that lives in the client's sandboxed iframe.

use std::sync::LazyLock;

use axum::body::Bytes;
use axum::extract::{Path, RawQuery};
use axum::response::Response;
use indexmap::IndexMap;
use parking_lot::Mutex;
use regex::{Captures, Regex};
use serde_json::{json, Map, Value};

use crate::auth::url_pairs;
use crate::static_files;
use crate::util::{http_error, jerr, jf, jsonify, now_ms, parse_body, py_str, truthy, trunc_chars, uuid_hex};

const SKIN_FIELD_LIMIT: usize = 4000;
const VIZ_CODE_LIMIT: usize = 20000;

type Store = IndexMap<String, Value>;

static SKINS: LazyLock<Mutex<Store>> = LazyLock::new(|| Mutex::new(Store::new()));
static VISUALIZERS: LazyLock<Mutex<Store>> = LazyLock::new(|| Mutex::new(Store::new()));

static CSS_BANNED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(@import|javascript\s*:|expression\s*\(|</\s*style|behavior\s*:|-moz-binding)").unwrap());
static CSS_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)url\(\s*['"]?([^)'"]*)['"]?\s*\)"#).unwrap());
static VAR_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9-]{1,32}$").unwrap());
static OPT_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-zA-Z0-9_-]{1,32}$").unwrap());

fn skins_file() -> std::path::PathBuf {
    static_files::root().join("skins.json")
}
fn viz_file() -> std::path::PathBuf {
    static_files::root().join("visualizers.json")
}

// ───────────────────────── persistence ─────────────────────────

/// `json.dumps(obj, indent=2)` (ensure_ascii, `", "`-less item separator because of indent)
fn dumps_pretty(v: &Value, indent: usize, out: &mut String) {
    match v {
        Value::Object(m) if m.is_empty() => out.push_str("{}"),
        Value::Array(a) if a.is_empty() => out.push_str("[]"),
        Value::Object(m) => {
            out.push_str("{\n");
            let n = m.len();
            for (i, (k, val)) in m.iter().enumerate() {
                out.push_str(&" ".repeat(indent + 2));
                out.push_str(&ascii_string(k));
                out.push_str(": ");
                dumps_pretty(val, indent + 2, out);
                if i + 1 < n {
                    out.push(',');
                }
                out.push('\n');
            }
            out.push_str(&" ".repeat(indent));
            out.push('}');
        }
        Value::Array(a) => {
            out.push_str("[\n");
            let n = a.len();
            for (i, val) in a.iter().enumerate() {
                out.push_str(&" ".repeat(indent + 2));
                dumps_pretty(val, indent + 2, out);
                if i + 1 < n {
                    out.push(',');
                }
                out.push('\n');
            }
            out.push_str(&" ".repeat(indent));
            out.push(']');
        }
        Value::String(s) => out.push_str(&ascii_string(s)),
        Value::Number(_) => out.push_str(&py_str(v)),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Null => out.push_str("null"),
    }
}

/// A JSON string literal with every non-ASCII char escaped (`ensure_ascii=True`).
fn ascii_string(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            '\u{8}' => o.push_str("\\b"),
            '\u{c}' => o.push_str("\\f"),
            c if (c as u32) < 0x20 || (c as u32) > 0x7e => {
                let mut b = [0u16; 2];
                for u in c.encode_utf16(&mut b) {
                    o.push_str(&format!("\\u{:04x}", u));
                }
            }
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn load(path: &std::path::Path) -> Store {
    match std::fs::read_to_string(path) {
        Ok(txt) => match serde_json::from_str::<Store>(&txt) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("{e}");
                Store::new()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Store::new(),
        Err(e) => {
            eprintln!("{e}");
            Store::new()
        }
    }
}

fn save(path: &std::path::Path, store: &Store) {
    let obj: Map<String, Value> = Map::new();
    let _ = obj;
    // keep insertion order: write the entries by hand
    let mut out = String::new();
    if store.is_empty() {
        out.push_str("{}");
    } else {
        out.push_str("{\n");
        let n = store.len();
        for (i, (k, v)) in store.iter().enumerate() {
            out.push_str("  ");
            out.push_str(&ascii_string(k));
            out.push_str(": ");
            dumps_pretty(v, 2, &mut out);
            if i + 1 < n {
                out.push(',');
            }
            out.push('\n');
        }
        out.push('}');
    }
    if let Err(e) = std::fs::write(path, out) {
        eprintln!("{e}");
    }
}

/// Load both galleries from disk (module import time in the original).
pub fn load_all() {
    *SKINS.lock() = load(&skins_file());
    *VISUALIZERS.lock() = load(&viz_file());
}

// ───────────────────────── helpers ─────────────────────────

/// `(data.get(key) or "").strip()` — a truthy non-string is an AttributeError (500) in the original.
fn strip_field(data: &Map<String, Value>, key: &str) -> Result<String, ()> {
    match data.get(key) {
        Some(v) if truthy(v) => match v {
            Value::String(s) => Ok(s.trim().to_string()),
            _ => Err(()),
        },
        _ => Ok(String::new()),
    }
}

fn num(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::Bool(b)) => *b as i64 as f64,
        _ => 0.0,
    }
}

fn sort_items(items: &mut [Map<String, Value>], popular: bool) {
    items.sort_by(|a, b| {
        let ca = -num(a.get("createdAt"));
        let cb = -num(b.get("createdAt"));
        if popular {
            let ia = -num(a.get("installs"));
            let ib = -num(b.get("installs"));
            ia.partial_cmp(&ib).unwrap_or(std::cmp::Ordering::Equal).then(ca.partial_cmp(&cb).unwrap_or(std::cmp::Ordering::Equal))
        } else {
            ca.partial_cmp(&cb).unwrap_or(std::cmp::Ordering::Equal)
        }
    });
}

fn query_sort(q: &Option<String>) -> bool {
    let pairs = url_pairs(q.as_deref().unwrap_or(""));
    pairs.iter().find(|(k, _)| k == "sort").map(|(_, v)| v == "popular").unwrap_or(false)
}

fn as_obj(v: &Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m.clone(),
        _ => Map::new(),
    }
}

// ───────────────────────── skins ─────────────────────────

fn sanitize_css(raw: Option<&Value>) -> String {
    let Some(raw) = raw else { return String::new() };
    if !truthy(raw) {
        return String::new();
    }
    let css = trunc_chars(&py_str(raw), SKIN_FIELD_LIMIT);
    let css = CSS_BANNED.replace_all(&css, "").to_string();
    CSS_URL
        .replace_all(&css, |m: &Captures| {
            let target = m.get(1).map(|g| g.as_str()).unwrap_or("").trim();
            if target.starts_with("https://") || target.starts_with("data:image/") {
                m[0].to_string()
            } else {
                "none".to_string()
            }
        })
        .to_string()
}

/// Normalise whatever the client sent into the shape we store. Err = a 500 in the original.
fn clean_skin(payload: &Value) -> Result<Map<String, Value>, ()> {
    let payload = match payload {
        Value::Object(m) => m.clone(),
        Value::Null => Map::new(),
        v if !truthy(v) => Map::new(),
        _ => return Err(()),
    };
    let mut variables = Map::new();
    match payload.get("vars") {
        Some(Value::Object(m)) => {
            for (k, v) in m {
                if !VAR_KEY.is_match(k) {
                    continue;
                }
                if matches!(v, Value::String(_) | Value::Number(_) | Value::Bool(_)) {
                    variables.insert(k.clone(), Value::String(trunc_chars(&py_str(v), 120)));
                }
            }
        }
        Some(v) if truthy(v) => return Err(()),
        _ => {}
    }
    let mut opts = Map::new();
    match payload.get("opts") {
        Some(Value::Object(m)) => {
            for (k, v) in m {
                if OPT_KEY.is_match(k) {
                    let nv = if matches!(v, Value::Number(_) | Value::Bool(_)) { v.clone() } else { Value::String(trunc_chars(&py_str(v), 300)) };
                    opts.insert(k.clone(), nv);
                }
            }
        }
        Some(v) if truthy(v) => return Err(()),
        _ => {}
    }
    let name = match payload.get("name") {
        Some(v) if truthy(v) => py_str(v),
        _ => "Untitled Skin".into(),
    };
    let author = match payload.get("author") {
        Some(v) if truthy(v) => py_str(v),
        _ => "Anonymous".into(),
    };
    let mut m = Map::new();
    m.insert("name".into(), json!(trunc_chars(&name, 40)));
    m.insert("author".into(), json!(trunc_chars(&author, 24)));
    m.insert("vars".into(), Value::Object(variables));
    m.insert("opts".into(), Value::Object(opts));
    m.insert("css".into(), json!(sanitize_css(payload.get("css"))));
    Ok(m)
}

fn skin_summary(sid: &str, skin: &Map<String, Value>) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("id".into(), json!(sid));
    m.insert("name".into(), skin.get("name").cloned().unwrap_or(Value::Null));
    m.insert("author".into(), skin.get("author").cloned().unwrap_or(Value::Null));
    m.insert("vars".into(), skin.get("vars").cloned().unwrap_or_else(|| json!({})));
    m.insert("opts".into(), skin.get("opts").cloned().unwrap_or_else(|| json!({})));
    m.insert("hasCss".into(), json!(skin.get("css").map(truthy).unwrap_or(false)));
    m.insert("installs".into(), skin.get("installs").cloned().unwrap_or(json!(0)));
    m.insert("createdAt".into(), skin.get("createdAt").cloned().unwrap_or(Value::Null));
    m
}

pub async fn skins_list(RawQuery(q): RawQuery) -> Response {
    let mut items: Vec<Map<String, Value>> = SKINS.lock().iter().map(|(sid, s)| skin_summary(sid, &as_obj(s))).collect();
    sort_items(&mut items, query_sort(&q));
    items.truncate(200);
    jsonify(Value::Array(items.into_iter().map(Value::Object).collect()))
}

pub async fn skin_get(Path(sid): Path<String>) -> Response {
    let skin = SKINS.lock().get(&sid).cloned();
    let Some(skin) = skin.filter(truthy) else { return jerr(404, "not found") };
    let skin = as_obj(&skin);
    let mut out = skin_summary(&sid, &skin);
    out.insert("css".into(), skin.get("css").cloned().unwrap_or_else(|| json!("")));
    jsonify(Value::Object(out))
}

pub async fn skin_publish(body: Bytes) -> Response {
    let data = parse_body(&body);
    let payload = match data.get("skin") {
        Some(v) if truthy(v) => v.clone(),
        _ => Value::Object(data.clone()),
    };
    let Ok(mut skin) = clean_skin(&payload) else { return http_error(500) };
    let vars_empty = skin.get("vars").and_then(|v| v.as_object()).map(|m| m.is_empty()).unwrap_or(true);
    let css_empty = skin.get("css").and_then(|v| v.as_str()).map(|s| s.is_empty()).unwrap_or(true);
    if vars_empty && css_empty {
        return jerr(400, "skin is empty");
    }
    let (Ok(mut sid), Ok(token)) = (strip_field(&data, "id"), strip_field(&data, "editToken")) else { return http_error(500) };

    let mut store = SKINS.lock();
    if !sid.is_empty() && store.contains_key(&sid) {
        let old = as_obj(&store[&sid]);
        if old.get("editToken") != Some(&Value::String(token)) {
            return jerr(403, "wrong edit token");
        }
        skin.insert("editToken".into(), old.get("editToken").cloned().unwrap_or(Value::Null));
        skin.insert("createdAt".into(), old.get("createdAt").cloned().unwrap_or_else(|| jf(now_ms())));
        skin.insert("installs".into(), old.get("installs").cloned().unwrap_or(json!(0)));
    } else {
        sid = uuid_hex()[..10].to_string();
        skin.insert("editToken".into(), json!(uuid_hex()));
        skin.insert("createdAt".into(), jf(now_ms()));
        skin.insert("installs".into(), json!(0));
    }
    let tok = skin["editToken"].clone();
    store.insert(sid.clone(), Value::Object(skin));
    save(&skins_file(), &store);
    jsonify(json!({"ok": true, "id": sid, "editToken": tok}))
}

fn delete_entry(store: &Mutex<Store>, id: &str, body: &Bytes, file: std::path::PathBuf) -> Response {
    let data = parse_body(body);
    let mut st = store.lock();
    let Some(entry) = st.get(id).cloned().filter(truthy) else { return jerr(404, "not found") };
    let provided = match data.get("editToken") {
        Some(v) if truthy(v) => v.clone(),
        _ => Value::String(String::new()),
    };
    if as_obj(&entry).get("editToken") != Some(&provided) {
        return jerr(403, "wrong edit token");
    }
    st.shift_remove(id);
    save(&file, &st);
    jsonify(json!({"ok": true}))
}

fn install_entry(store: &Mutex<Store>, id: &str, file: std::path::PathBuf) -> Response {
    let mut st = store.lock();
    let Some(entry) = st.get(id).cloned().filter(truthy) else { return jerr(404, "not found") };
    let mut m = as_obj(&entry);
    let cur = m.get("installs").cloned().unwrap_or(json!(0));
    let next = match cur.as_i64() {
        Some(i) => json!(i + 1),
        None => jf(cur.as_f64().unwrap_or(0.0) + 1.0),
    };
    m.insert("installs".into(), next.clone());
    st.insert(id.to_string(), Value::Object(m));
    save(&file, &st);
    jsonify(json!({"ok": true, "installs": next}))
}

pub async fn skin_delete(Path(sid): Path<String>, body: Bytes) -> Response {
    delete_entry(&SKINS, &sid, &body, skins_file())
}

pub async fn skin_install(Path(sid): Path<String>) -> Response {
    install_entry(&SKINS, &sid, skins_file())
}

// ───────────────────────── visualizers ─────────────────────────

fn clean_viz(payload: &Value) -> Result<Map<String, Value>, ()> {
    let payload = match payload {
        Value::Object(m) => m.clone(),
        v if !truthy(v) => Map::new(),
        _ => return Err(()),
    };
    let name = match payload.get("name") {
        Some(v) if truthy(v) => py_str(v),
        _ => "Untitled Visualizer".into(),
    };
    let author = match payload.get("author") {
        Some(v) if truthy(v) => py_str(v),
        _ => "Anonymous".into(),
    };
    let code = match payload.get("code") {
        Some(v) if truthy(v) => py_str(v),
        _ => String::new(),
    };
    let mut m = Map::new();
    m.insert("name".into(), json!(trunc_chars(&name, 40)));
    m.insert("author".into(), json!(trunc_chars(&author, 24)));
    m.insert("code".into(), json!(trunc_chars(&code, VIZ_CODE_LIMIT)));
    Ok(m)
}

fn viz_summary(vid: &str, viz: &Map<String, Value>) -> Map<String, Value> {
    let code = match viz.get("code") {
        Some(v) if truthy(v) => py_str(v),
        _ => String::new(),
    };
    let mut m = Map::new();
    m.insert("id".into(), json!(vid));
    m.insert("name".into(), viz.get("name").cloned().unwrap_or(Value::Null));
    m.insert("author".into(), viz.get("author").cloned().unwrap_or(Value::Null));
    m.insert("lines".into(), json!(code.matches('\n').count() + 1));
    m.insert("installs".into(), viz.get("installs").cloned().unwrap_or(json!(0)));
    m.insert("createdAt".into(), viz.get("createdAt").cloned().unwrap_or(Value::Null));
    m
}

pub async fn viz_list(RawQuery(q): RawQuery) -> Response {
    let mut items: Vec<Map<String, Value>> = VISUALIZERS.lock().iter().map(|(vid, v)| viz_summary(vid, &as_obj(v))).collect();
    sort_items(&mut items, query_sort(&q));
    items.truncate(200);
    jsonify(Value::Array(items.into_iter().map(Value::Object).collect()))
}

pub async fn viz_get(Path(vid): Path<String>) -> Response {
    let viz = VISUALIZERS.lock().get(&vid).cloned();
    let Some(viz) = viz.filter(truthy) else { return jerr(404, "not found") };
    let viz = as_obj(&viz);
    let mut out = viz_summary(&vid, &viz);
    out.insert("code".into(), viz.get("code").cloned().unwrap_or_else(|| json!("")));
    jsonify(Value::Object(out))
}

pub async fn viz_publish(body: Bytes) -> Response {
    let data = parse_body(&body);
    let payload = match data.get("viz") {
        Some(v) if truthy(v) => v.clone(),
        _ => Value::Object(data.clone()),
    };
    let Ok(mut viz) = clean_viz(&payload) else { return http_error(500) };
    let code = viz["code"].as_str().unwrap_or("").to_string();
    if code.trim().is_empty() {
        return jerr(400, "visualizer has no code");
    }
    if !code.contains("function draw") && !code.contains("draw =") {
        return jerr(400, "no draw(ctx, v) function found");
    }
    let (Ok(mut vid), Ok(token)) = (strip_field(&data, "id"), strip_field(&data, "editToken")) else { return http_error(500) };

    let mut store = VISUALIZERS.lock();
    if !vid.is_empty() && store.contains_key(&vid) {
        let old = as_obj(&store[&vid]);
        if old.get("editToken") != Some(&Value::String(token)) {
            return jerr(403, "wrong edit token");
        }
        viz.insert("editToken".into(), old.get("editToken").cloned().unwrap_or(Value::Null));
        viz.insert("createdAt".into(), old.get("createdAt").cloned().unwrap_or_else(|| jf(now_ms())));
        viz.insert("installs".into(), old.get("installs").cloned().unwrap_or(json!(0)));
    } else {
        vid = uuid_hex()[..10].to_string();
        viz.insert("editToken".into(), json!(uuid_hex()));
        viz.insert("createdAt".into(), jf(now_ms()));
        viz.insert("installs".into(), json!(0));
    }
    let tok = viz["editToken"].clone();
    store.insert(vid.clone(), Value::Object(viz));
    save(&viz_file(), &store);
    jsonify(json!({"ok": true, "id": vid, "editToken": tok}))
}

pub async fn viz_delete(Path(vid): Path<String>, body: Bytes) -> Response {
    delete_entry(&VISUALIZERS, &vid, &body, viz_file())
}

pub async fn viz_install(Path(vid): Path<String>) -> Response {
    install_entry(&VISUALIZERS, &vid, viz_file())
}
