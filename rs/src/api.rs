//! Lobby REST API (every `/api/lobby/*` route). The handlers keep the original's
//! order of checks, status codes and error messages. Lobby locks are never held
//! across an `.await` or while calling into the relay (which locks the lobby too).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Path, RawQuery};
use axum::response::Response;
use parking_lot::Mutex;
use rand::seq::SliceRandom;
use regex::Regex;
use serde_json::{json, Map, Value};

use crate::auth::{url_pairs, ClientIp};
use crate::config;
use crate::lobby::*;
use crate::sio;
use crate::util::*;

// ───────────────────────── small helpers ─────────────────────────

type Data = Map<String, Value>;
type Resp = Response;

/// Python `isinstance(x, int)` for a JSON value (bool counts, floats don't).
fn py_int(v: Option<&Value>) -> Option<i64> {
    match v {
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::Bool(b)) => Some(*b as i64),
        _ => None,
    }
}

/// `str(v)[:n]`-style slicing of `(data.get(key) or default)` — a truthy non-string
/// would raise in the original (500).
fn slice_field(v: Option<&Value>, default: &str, n: usize) -> Result<String, ()> {
    match v {
        Some(v) if truthy(v) => match v {
            Value::String(s) => Ok(trunc_chars(s, n)),
            _ => Err(()),
        },
        _ => Ok(trunc_chars(default, n)),
    }
}

/// `(data.get(key) or "")` that must be a string for the following `.strip()` / `.upper()`.
fn str_field(v: Option<&Value>) -> Result<String, ()> {
    match v {
        Some(v) if truthy(v) => match v {
            Value::String(s) => Ok(s.clone()),
            _ => Err(()),
        },
        _ => Ok(String::new()),
    }
}

fn lobby_and_data(code: &str, body: &Bytes) -> Result<(Arc<LobbyHandle>, Data), Resp> {
    match get_lobby_or_404(code) {
        Some(l) => Ok((l, parse_body(body))),
        None => Err(jerr(404, "not found")),
    }
}

macro_rules! lobby_data {
    ($code:expr, $body:expr) => {
        match lobby_and_data(&$code, &$body) {
            Ok(v) => v,
            Err(r) => return r,
        }
    };
}

macro_rules! need_controller {
    ($l:expr, $data:expr) => {
        if !require_controller(&$l.st.lock(), client_id_of(&$data).as_deref()) {
            return jerr(403, "host or DJ only");
        }
    };
}

macro_rules! need_host {
    ($l:expr, $data:expr) => {
        if !require_host(&$l.st.lock(), client_id_of(&$data).as_deref()) {
            return jerr(403, "host only");
        }
    };
}

macro_rules! or500 {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(_) => return http_error(500),
        }
    };
}

fn system_chat(text: String) -> Value {
    json!({"system": true, "text": text, "ts": now_ms()})
}

/// broadcast the lobby state and return it
async fn push_state(l: &Arc<LobbyHandle>) -> Value {
    let s = l.public_state();
    sio::broadcast(&l.code(), "state", s.clone()).await;
    s
}

async fn state_ok(l: &Arc<LobbyHandle>) -> Resp {
    let state = push_state(l).await;
    jsonify(json!({"ok": true, "state": state}))
}

fn query_get(q: &Option<String>, key: &str) -> Option<String> {
    url_pairs(q.as_deref().unwrap_or("")).into_iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

// ───────────────────────── passwords ─────────────────────────

static PW_FAILS: LazyLock<Mutex<HashMap<(String, String), Vec<f64>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// None if the caller may enter `lobby`; otherwise the response to return as-is.
fn password_gate(lobby: &Arc<LobbyHandle>, ip: &str, data: &Data) -> Option<Resp> {
    let l = lobby.st.lock();
    if !l.has_password() {
        return None;
    }
    let key = (ip.to_string(), l.code.clone());
    let now = now_secs();
    let mut fails = PW_FAILS.lock();
    let mut hits: Vec<f64> = fails.get(&key).cloned().unwrap_or_default().into_iter().filter(|t| now - t < config::PASSWORD_FAIL_WINDOW).collect();
    if hits.len() >= config::PASSWORD_MAX_FAILS {
        fails.insert(key, hits);
        return Some(jsonify_status(
            json!({"error": "Too many wrong passwords — wait a minute and try again", "reason": "rate_limited"}),
            429,
        ));
    }
    let supplied = data.get("password");
    let empty = match supplied {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s.is_empty(),
        _ => false,
    };
    if empty {
        return Some(jsonify_status(json!({"error": "This lobby needs a password", "reason": "password_required"}), 403));
    }
    if !l.check_password(supplied) {
        hits.push(now);
        fails.insert(key, hits);
        return Some(jsonify_status(json!({"error": "Wrong password", "reason": "wrong_password"}), 403));
    }
    fails.remove(&key);
    None
}

fn banned_response() -> Resp {
    jsonify_status(json!({"error": "You are banned from this lobby", "reason": "banned"}), 403)
}

// ───────────────────────── create / join / public / leave ─────────────────────────

pub async fn create_lobby(body: Bytes) -> Resp {
    let data = parse_body(&body);
    let name = or500!(slice_field(data.get("name"), "Untitled Lobby", 40));
    let is_public = truthy_opt(data.get("isPublic"));
    let display_name = or500!(slice_field(data.get("displayName"), "Guest", 24));

    let code = gen_code();
    let client_id = uuid_hex();
    let lobby = LobbyHandle::new(code.clone(), name, is_public, client_id.clone());
    {
        let mut l = lobby.st.lock();
        l.participants.insert(client_id.clone(), Participant::new(client_id.clone(), display_name, clean_user_id(data.get("userId"))));
        l.set_password(data.get("password"));
    }
    or500!(register_lobby(&lobby));
    jsonify(json!({"code": code, "clientId": client_id, "isHost": true, "state": lobby.public_state()}))
}

pub async fn join_lobby(ClientIp(ip): ClientIp, body: Bytes) -> Resp {
    let data = parse_body(&body);
    let code = or500!(str_field(data.get("code"))).to_uppercase().trim().to_string();
    let display_name = or500!(slice_field(data.get("displayName"), "Guest", 24));

    let Some(lobby) = get_lobby_or_404(&code) else { return jerr(404, "Lobby not found") };

    let user_id = clean_user_id(data.get("userId"));
    if let Some(u) = &user_id {
        if lobby.st.lock().banned.contains_key(u) {
            return banned_response();
        }
    }
    if let Some(r) = password_gate(&lobby, &ip, &data) {
        return r;
    }

    let client_id = uuid_hex();
    lobby.st.lock().participants.insert(client_id.clone(), Participant::new(client_id.clone(), display_name.clone(), user_id));
    let state = lobby.public_state();
    let plist = lobby.participant_list();
    let c = lobby.code();
    sio::broadcast(&c, "participants", plist).await;
    sio::broadcast(&c, "chat", system_chat(format!("{display_name} joined"))).await;
    jsonify(json!({"code": code, "clientId": client_id, "isHost": false, "state": state}))
}

pub async fn list_public() -> Resp {
    let lobbies: Vec<Arc<LobbyHandle>> = LOBBIES.lock().values().cloned().collect();
    let mut out = vec![];
    for lh in lobbies {
        let l = lh.st.lock();
        if !l.is_public {
            continue;
        }
        let cur = l.current_track.as_ref().filter(|t| truthy(t));
        let now_playing = match cur {
            Some(t) => {
                let info = t.get("info").filter(|i| truthy(i));
                json!({
                    "title": info.and_then(|i| i.get("title")).cloned().unwrap_or(Value::Null),
                    "author": info.and_then(|i| i.get("author")).cloned().unwrap_or(Value::Null),
                })
            }
            None => Value::Null,
        };
        out.push(json!({
            "code": l.code, "name": l.name, "participants": l.participants.len(),
            "hasPassword": l.has_password(),
            "nowPlaying": now_playing,
            "paused": l.paused,
            "queueLength": l.queue.len(),
        }));
    }
    jsonify(Value::Array(out))
}

pub async fn leave_lobby(Path(code): Path<String>, body: Bytes) -> Resp {
    let data = parse_body(&body);
    let client_id = data.get("clientId");
    let lobby = get_lobby_or_404(&code);
    if let (Some(l), Some(Value::String(cid))) = (lobby, client_id) {
        if !cid.is_empty() {
            finalize_leave(&l, cid).await;
        }
    }
    jsonify(json!({"ok": true}))
}

// ───────────────────────── self-heal: rejoin / restore ─────────────────────────

/// Keep only what a track needs; reject anything that isn't a real track.
fn clean_track(t: &Value) -> Option<Value> {
    let o = t.as_object()?;
    let encoded = o.get("encoded").and_then(|e| e.as_str()).filter(|e| !e.is_empty())?;
    let info = o.get("info").filter(|i| i.is_object())?;
    let mut out = Map::new();
    out.insert("encoded".into(), json!(encoded));
    out.insert("info".into(), info.clone());
    if let Some(pi) = o.get("pluginInfo").filter(|p| p.is_object()) {
        out.insert("pluginInfo".into(), pi.clone());
    }
    if let Some(req) = o.get("requester").and_then(|r| r.as_object()) {
        if let (Some(id), Some(name)) = (req.get("id").and_then(|v| v.as_str()), req.get("name").and_then(|v| v.as_str())) {
            out.insert("requester".into(), json!({"id": trunc_chars(id, 64), "name": trunc_chars(name, 24)}));
        }
    }
    Some(Value::Object(out))
}

fn join_payload(lobby: &Arc<LobbyHandle>, client_id: &str, extra: Vec<(&str, Value)>) -> Resp {
    let is_host = lobby.st.lock().host_id == client_id;
    let mut m = Map::new();
    m.insert("code".into(), json!(lobby.code()));
    m.insert("clientId".into(), json!(client_id));
    m.insert("isHost".into(), json!(is_host));
    m.insert("state".into(), lobby.public_state());
    for (k, v) in extra {
        m.insert(k.into(), v);
    }
    jsonify(Value::Object(m))
}

pub async fn rejoin_lobby(ClientIp(ip): ClientIp, body: Bytes) -> Resp {
    let data = parse_body(&body);
    let code = clean_code(data.get("code"));
    let client_id = str_or(data.get("clientId"), "");
    let display_name = or500!(slice_field(data.get("displayName"), "Guest", 24));

    // Same identity still valid (a network blip, not a restart).
    if let Some(l) = find_lobby_by_client(Some(&client_id)) {
        return join_payload(&l, &client_id, vec![("rejoined", json!(true))]);
    }

    let Some(lobby) = get_lobby_or_404(&code.unwrap_or_default()) else {
        return jsonify_status(json!({"error": "Lobby not found", "reason": "not_found"}), 404);
    };

    let user_id = clean_user_id(data.get("userId"));
    if let Some(u) = &user_id {
        if lobby.st.lock().banned.contains_key(u) {
            return banned_response();
        }
    }
    if let Some(r) = password_gate(&lobby, &ip, &data) {
        return r;
    }
    let new_id = uuid_hex();
    lobby.st.lock().participants.insert(new_id.clone(), Participant::new(new_id.clone(), display_name.clone(), user_id));
    let c = lobby.code();
    sio::broadcast(&c, "participants", lobby.participant_list()).await;
    sio::broadcast(&c, "chat", system_chat(format!("{display_name} reconnected"))).await;
    join_payload(&lobby, &new_id, vec![("rejoined", json!(true))])
}

/// `(x or [])[:limit]` / `[-limit:]` over a snapshot field, cleaned into tracks.
fn snap_tracks(v: Option<&Value>, limit: usize, tail: bool) -> Result<Vec<Value>, ()> {
    match v {
        Some(v) if truthy(v) => match v {
            Value::Array(a) => {
                let slice: &[Value] = if tail { &a[a.len().saturating_sub(limit)..] } else { &a[..a.len().min(limit)] };
                Ok(slice.iter().filter_map(clean_track).collect())
            }
            Value::String(_) => Ok(vec![]),
            _ => Err(()),
        },
        _ => Ok(vec![]),
    }
}

/// Rebuild a lobby from a snapshot the host's browser saved. The restored lobby
/// starts PAUSED at the saved position, with the saved queue and settings.
pub async fn restore_lobby(body: Bytes) -> Resp {
    let data = parse_body(&body);
    let empty = Map::new();
    let snap: &Data = match data.get("snapshot") {
        Some(Value::Object(m)) => m,
        _ => &empty,
    };
    let orig_code = clean_code(snap.get("code"));
    let Some(mut code) = orig_code.clone() else {
        return jsonify_status(json!({"error": "snapshot has no valid lobby code", "reason": "bad_snapshot"}), 400);
    };

    let mut client_id = str_or(data.get("clientId"), "");
    if !clean_client_id_ok(&client_id) {
        client_id = uuid_hex();
    }
    let dn_src = match data.get("displayName") {
        Some(v) if truthy(v) => Some(v),
        _ => snap.get("displayName"),
    };
    let display_name = or500!(slice_field(dn_src, "Guest", 24));
    let allow_new = truthy_opt(data.get("allowNewCode"));

    let existing = LOBBIES.lock().get(&code).cloned();
    if let Some(ex) = existing {
        let alive = {
            let l = ex.st.lock();
            l.host_id == client_id && l.participants.contains_key(&client_id)
        };
        if alive {
            return join_payload(&ex, &client_id, vec![("restored", json!(false))]);
        }
        if !allow_new {
            return jsonify_status(json!({"error": format!("Code {code} is in use by another lobby"), "reason": "code_in_use"}), 409);
        }
        code = gen_code();
    }

    let name = trunc_chars(&str_or(snap.get("name"), "Untitled Lobby"), 40);
    let is_public = truthy_opt(snap.get("isPublic"));
    let lobby = LobbyHandle::new(code.clone(), name, is_public, client_id.clone());
    let user_id = clean_user_id(data.get("userId"));

    let limit = config::RESTORE_MAX_QUEUE;
    let queue_in = or500!(snap_tracks(snap.get("queue"), limit, false));
    let current_in = snap.get("currentTrack").and_then(clean_track);
    let history = or500!(snap_tracks(snap.get("history"), limit, true));
    let smart_in = or500!(snap_tracks(snap.get("smart"), limit, false));

    let (current, pos) = {
        let mut l = lobby.st.lock();
        l.participants.insert(client_id.clone(), Participant::new(client_id.clone(), display_name.clone(), user_id));
        if let Some(Value::String(m)) = snap.get("loopMode") {
            if matches!(m.as_str(), "none" | "track" | "queue") {
                l.loop_mode = m.clone();
            }
        }
        if let Some(Value::String(m)) = snap.get("autoplay") {
            if matches!(m.as_str(), "enabled" | "partial" | "disabled") {
                l.autoplay = m.clone();
            }
        }
        l.gapless = match snap.get("gapless") {
            None => true,
            Some(v) => truthy(v),
        };
        l.fair = match snap.get("fair") {
            None => true,
            Some(v) => truthy(v),
        };
        l.set_password(snap.get("password"));

        let me = json!({"id": l.participants[&client_id].uid, "name": display_name});
        let mut queue = queue_in;
        let mut current = current_in;
        let mut pos = 0.0f64;
        if let Some(c) = &current {
            pos = match snap.get("positionMs") {
                Some(v) if truthy(v) => py_float(v).map(|f| f.max(0.0)).unwrap_or(0.0),
                _ => 0.0,
            };
            if let Some(Value::Number(n)) = c.get("info").and_then(|i| i.get("length")) {
                let length = n.as_f64().unwrap_or(0.0);
                if length > 0.0 {
                    pos = pos.min((length - 1000.0).max(0.0));
                }
            }
        } else if !queue.is_empty() {
            current = Some(queue.remove(0)); // a queue with nothing playing: line the first one up
        }
        for t in queue.iter_mut().chain(current.iter_mut()) {
            if let Some(o) = t.as_object_mut() {
                o.entry("requester").or_insert_with(|| me.clone());
            }
        }
        l.queue = queue;
        l.history = history;
        // Smart (recommendation) pool, minus anything already queued/played.
        let mut seen: HashSet<Option<String>> = l.queue.iter().chain(l.history.iter()).map(track_id).collect();
        if let Some(c) = &current {
            seen.insert(track_id(c));
        }
        for mut t in smart_in {
            let tid = track_id(&t);
            if seen.contains(&tid) {
                continue;
            }
            seen.insert(tid);
            if let Some(o) = t.as_object_mut() {
                o.entry("requester").or_insert_with(|| json!({"id": "__auto__", "name": "Autoplay"}));
            }
            l.auto_queue.push(t);
        }
        (current, pos)
    };

    or500!(register_lobby(&lobby));
    if let Some(c) = current {
        {
            let mut l = lobby.st.lock();
            l.current_track = Some(c.clone());
            l.paused = true;
            l.position_anchor_ms = pos;
            l.anchor_time = now_secs();
        }
        lobby.relay.start_track(Some(c), pos); // stays gated (silence) until the host presses play
        populate_recommendations(&lobby, None, false).await;
    }
    lobby.st.lock().apply_fair();
    lobby.relay.ensure_preload();
    let code_changed = Some(&code) != orig_code.as_ref();
    join_payload(&lobby, &client_id, vec![("restored", json!(true)), ("codeChanged", json!(code_changed))])
}

// ───────────────────────── chat / reads ─────────────────────────

pub async fn post_chat(Path(code): Path<String>, body: Bytes) -> Resp {
    let Some(lobby) = get_lobby_or_404(&code) else { return jerr(404, "not found") };
    let data = parse_body(&body);
    let name = {
        let l = lobby.st.lock();
        client_id_of(&data).and_then(|c| l.participants.get(&c).map(|p| p.name.clone()))
    };
    let Some(name) = name else { return jerr(403, "not in lobby") };
    let text = match data.get("text") {
        None => String::new(),
        Some(v) => py_str(v),
    };
    let msg = json!({"id": uuid_hex(), "name": name, "text": trunc_chars(&text, 500), "ts": now_ms()});
    lobby.st.lock().chat.push(msg.clone());
    sio::broadcast(&lobby.code(), "chat", msg).await;
    jsonify(json!({"ok": true}))
}

/// History + smart-pool contents (public_state only carries the counts). Controllers only.
pub async fn lobby_history(Path(code): Path<String>, RawQuery(q): RawQuery) -> Resp {
    let Some(lobby) = get_lobby_or_404(&code) else { return jerr(404, "not found") };
    let l = lobby.st.lock();
    if !require_controller(&l, query_get(&q, "clientId").as_deref()) {
        return jerr(403, "host or DJ only");
    }
    let limit = config::RESTORE_MAX_QUEUE;
    let tracks: Vec<Value> = l.history[l.history.len().saturating_sub(limit)..].iter().filter_map(clean_track).collect();
    let smart: Vec<Value> = l.auto_queue[..l.auto_queue.len().min(limit)].iter().filter_map(clean_track).collect();
    jsonify(json!({"history": tracks, "count": l.history.len(), "smart": smart, "smartCount": l.auto_queue.len()}))
}

/// Audio analysis (beats / tempo / meter / key) of the CURRENT track. Members only.
pub async fn lobby_analysis(Path(code): Path<String>, RawQuery(q): RawQuery) -> Resp {
    let Some(lobby) = get_lobby_or_404(&code) else { return jerr(404, "not found") };
    let cur = {
        let l = lobby.st.lock();
        let member = query_get(&q, "clientId").map(|c| l.participants.contains_key(&c)).unwrap_or(false);
        if !member {
            return jerr(403, "not in lobby");
        }
        l.current_track.clone().filter(truthy)
    };
    match cur {
        None => jsonify(json!({"status": "idle", "encoded": null})),
        Some(t) => jsonify(lobby.relay.analysis_for(&t)),
    }
}

// ───────────────────────── player controls ─────────────────────────

pub async fn lobby_play(Path(code): Path<String>, body: Bytes) -> Resp {
    let (lobby, data) = lobby_data!(code, body);
    need_controller!(lobby, data);
    let (was_idle, cur) = {
        let mut l = lobby.st.lock();
        let was_idle = l.current_track.is_none();
        if l.has_track() {
            let c = l.current_track.clone().unwrap();
            l.history.push(c);
        }
        let p = client_id_of(&data).and_then(|c| l.participants.get(&c).cloned());
        l.current_track = stamp_requester(data.get("track").cloned(), p.as_ref());
        l.paused = false;
        l.position_anchor_ms = 0.0;
        l.anchor_time = now_secs();
        (was_idle, l.current_track.clone())
    };
    if was_idle {
        lobby.relay.resume_or_start(cur, 0.0);
    } else {
        lobby.relay.start_track(cur, 0.0);
    }
    populate_recommendations(&lobby, None, true).await;
    state_ok(&lobby).await
}

pub async fn lobby_pause(Path(code): Path<String>, body: Bytes) -> Resp {
    let (lobby, data) = lobby_data!(code, body);
    need_controller!(lobby, data);
    {
        let mut l = lobby.st.lock();
        l.position_anchor_ms = l.current_position_ms();
        l.paused = true;
        l.anchor_time = now_secs();
    }
    lobby.relay.set_paused(true);
    state_ok(&lobby).await
}

pub async fn lobby_resume(Path(code): Path<String>, body: Bytes) -> Resp {
    let (lobby, data) = lobby_data!(code, body);
    need_controller!(lobby, data);
    {
        let mut l = lobby.st.lock();
        l.paused = false;
        l.anchor_time = now_secs();
    }
    lobby.relay.set_paused(false);
    state_ok(&lobby).await
}

pub async fn lobby_seek(Path(code): Path<String>, body: Bytes) -> Resp {
    let (lobby, data) = lobby_data!(code, body);
    need_controller!(lobby, data);
    let pos = match data.get("positionMs") {
        None => 0.0,
        Some(v) => or500!(py_float(v).ok_or(())),
    };
    {
        let mut l = lobby.st.lock();
        l.position_anchor_ms = pos;
        l.anchor_time = now_secs();
    }
    lobby.relay.reseek(pos);
    state_ok(&lobby).await
}

pub async fn lobby_skip(Path(code): Path<String>, body: Bytes) -> Resp {
    let (lobby, data) = lobby_data!(code, body);
    need_controller!(lobby, data);
    // skip_track_loop: pressing next under "repeat one" should move on.
    let nxt = {
        let mut l = lobby.st.lock();
        let nxt = l.advance_track(true);
        match &nxt {
            Some(n) => {
                l.current_track = Some(n.clone());
                l.position_anchor_ms = 0.0;
                l.anchor_time = now_secs();
                l.paused = false;
            }
            None => {
                l.current_track = None;
                l.paused = true;
            }
        }
        nxt
    };
    match nxt {
        Some(n) => {
            lobby.relay.start_track(Some(n), 0.0);
            populate_recommendations(&lobby, None, true).await;
        }
        None => lobby.relay.stop(),
    }
    state_ok(&lobby).await
}

/// Stop playback outright and clear the queue and the recommendation pool.
pub async fn lobby_stop(Path(code): Path<String>, body: Bytes) -> Resp {
    let (lobby, data) = lobby_data!(code, body);
    need_controller!(lobby, data);
    {
        let mut l = lobby.st.lock();
        l.current_track = None;
        l.queue = vec![];
        l.auto_queue = vec![];
        l.paused = true;
        l.position_anchor_ms = 0.0;
        l.anchor_time = now_secs();
    }
    lobby.relay.stop();
    state_ok(&lobby).await
}

pub async fn lobby_prev(Path(code): Path<String>, body: Bytes) -> Resp {
    let (lobby, data) = lobby_data!(code, body);
    need_controller!(lobby, data);
    let (prev, was_idle) = {
        let mut l = lobby.st.lock();
        let prev = l.previous_track();
        let Some(prev) = prev else { drop(l); return jerr(400, "no previous track") };
        let was_idle = l.current_track.is_none();
        l.current_track = Some(prev.clone());
        l.position_anchor_ms = 0.0;
        l.anchor_time = now_secs();
        l.paused = false;
        (prev, was_idle)
    };
    if was_idle {
        lobby.relay.resume_or_start(Some(prev), 0.0);
    } else {
        lobby.relay.start_track(Some(prev), 0.0);
    }
    populate_recommendations(&lobby, None, true).await;
    state_ok(&lobby).await
}

pub async fn lobby_clear_history(Path(code): Path<String>, body: Bytes) -> Resp {
    let (lobby, data) = lobby_data!(code, body);
    need_controller!(lobby, data);
    lobby.st.lock().history.clear();
    state_ok(&lobby).await
}

pub async fn lobby_loop(Path(code): Path<String>, body: Bytes) -> Resp {
    let (lobby, data) = lobby_data!(code, body);
    need_controller!(lobby, data);
    let mode = match data.get("mode") {
        Some(Value::String(m)) if matches!(m.as_str(), "none" | "track" | "queue") => m.clone(),
        _ => return jerr(400, "bad mode"),
    };
    lobby.st.lock().loop_mode = mode;
    // What plays next just changed, so whatever the relay prefetched may be wrong now.
    lobby.relay.ensure_preload();
    state_ok(&lobby).await
}

pub async fn lobby_autoplay(Path(code): Path<String>, body: Bytes) -> Resp {
    let (lobby, data) = lobby_data!(code, body);
    need_controller!(lobby, data);
    let mode = match data.get("mode") {
        Some(Value::String(m)) if matches!(m.as_str(), "enabled" | "partial" | "disabled") => m.clone(),
        _ => return jerr(400, "bad mode"),
    };
    {
        let mut l = lobby.st.lock();
        l.autoplay = mode.clone();
        if mode == "disabled" {
            l.auto_queue = vec![];
        }
    }
    if mode != "disabled" {
        populate_recommendations(&lobby, None, false).await;
    }
    lobby.relay.ensure_preload();
    state_ok(&lobby).await
}

pub async fn lobby_gapless(Path(code): Path<String>, body: Bytes) -> Resp {
    let (lobby, data) = lobby_data!(code, body);
    need_controller!(lobby, data);
    lobby.st.lock().gapless = truthy_opt(data.get("enabled"));
    lobby.relay.ensure_preload(); // ON: start prefetching now; OFF: drop whatever was in flight
    state_ok(&lobby).await
}

pub async fn lobby_fair(Path(code): Path<String>, body: Bytes) -> Resp {
    let (lobby, data) = lobby_data!(code, body);
    need_controller!(lobby, data);
    let changed = {
        let mut l = lobby.st.lock();
        l.fair = truthy_opt(data.get("enabled"));
        l.apply_fair()
    };
    if changed {
        lobby.relay.ensure_preload();
    }
    let state = push_state(&lobby).await;
    jsonify(json!({"ok": true, "changed": changed, "state": state}))
}

// ───────────────────────── DJs, kick / ban ─────────────────────────

pub async fn lobby_dj(Path(code): Path<String>, body: Bytes) -> Resp {
    let (lobby, data) = lobby_data!(code, body);
    need_host!(lobby, data);
    let target_uid = clean_user_id(data.get("targetUid"));
    let (targets, pname, host_is_target) = {
        let l = lobby.st.lock();
        let targets = target_uid.as_deref().map(|u| l.client_ids_for_uid(u)).unwrap_or_default();
        let p = targets.first().and_then(|t| l.participants.get(t)).cloned();
        let Some(p) = p else { drop(l); return jerr(404, "that user isn't in the lobby") };
        let host_is_target = targets.contains(&l.host_id) || target_uid.as_deref() == Some(l.uid_of(&l.host_id).as_str());
        (targets, p.name, host_is_target)
    };
    if host_is_target {
        return jerr(400, "the host already controls everything");
    }
    let all_dj = |l: &Lobby| targets.iter().all(|t| l.djs.contains(t));
    let enabled = {
        let l = lobby.st.lock();
        match data.get("enabled") {
            None | Some(Value::Null) => !all_dj(&l),
            Some(v) => truthy(v),
        }
    };
    if enabled == all_dj(&lobby.st.lock()) {
        return jsonify(json!({"ok": true, "isDj": enabled, "state": lobby.public_state()}));
    }
    {
        let mut l = lobby.st.lock();
        for t in &targets {
            if enabled {
                l.djs.insert(t.clone());
            } else {
                l.djs.remove(t);
            }
        }
    }
    let c = lobby.code();
    let text = if enabled { format!("🎧 {pname} is now a DJ") } else { format!("{pname} is no longer a DJ") };
    sio::broadcast(&c, "chat", system_chat(text)).await;
    sio::broadcast(&c, "participants", lobby.participant_list()).await;
    let state = push_state(&lobby).await;
    jsonify(json!({"ok": true, "isDj": enabled, "state": state}))
}

/// Host action shared by /kick and /ban.
async fn remove_participant(lobby: &Arc<LobbyHandle>, target_id: &str, ban: bool, by_name: &str) -> Option<Participant> {
    let (p, sids) = {
        let mut l = lobby.st.lock();
        let p = l.participants.get(target_id).cloned()?;
        if ban {
            l.banned.insert(p.uid.clone(), p.name.clone());
        }
        let sids: Vec<_> = l.sids.get(target_id).map(|s| s.iter().copied().collect()).unwrap_or_default();
        (p, sids)
    };
    // Notify first, on the sockets finalize_leave is about to disconnect.
    for sid in sids {
        sio::emit_to_sid(sid, "kicked", json!({"banned": ban, "by": by_name})).await;
    }
    finalize_leave(lobby, target_id).await;
    let code = lobby.code();
    if is_registered(&code, lobby) {
        let text = if ban { format!("\u{1F6AB} {} was banned", p.name) } else { format!("{} was kicked", p.name) };
        sio::broadcast(&code, "chat", system_chat(text)).await;
        sio::broadcast(&code, "state", lobby.public_state()).await;
    }
    Some(p)
}

async fn kick_or_ban(code: String, body: Bytes, ban: bool) -> Resp {
    let (lobby, data) = lobby_data!(code, body);
    need_host!(lobby, data);
    let target_uid = clean_user_id(data.get("targetUid"));
    let (targets, host_is_target, host_name) = {
        let l = lobby.st.lock();
        let targets = target_uid.as_deref().map(|u| l.client_ids_for_uid(u)).unwrap_or_default();
        let hit = targets.contains(&l.host_id) || target_uid.as_deref() == Some(l.uid_of(&l.host_id).as_str());
        (targets, hit, l.participants.get(&l.host_id).map(|p| p.name.clone()))
    };
    if targets.is_empty() {
        return jerr(404, "that user isn't in the lobby");
    }
    if host_is_target {
        return jerr(400, "you can't remove the host");
    }
    let by = host_name.unwrap_or_else(|| "the host".into());
    let mut p = None;
    for t in &targets {
        p = remove_participant(&lobby, t, ban, &by).await.or(p);
    }
    if p.is_none() {
        return jerr(404, "that user isn't in the lobby");
    }
    jsonify(json!({"ok": true, "state": lobby.public_state()}))
}

pub async fn lobby_kick(Path(code): Path<String>, body: Bytes) -> Resp {
    kick_or_ban(code, body, false).await
}

pub async fn lobby_ban(Path(code): Path<String>, body: Bytes) -> Resp {
    kick_or_ban(code, body, true).await
}

fn banned_list(l: &Lobby) -> Value {
    Value::Array(l.banned.iter().map(|(u, n)| json!({"uid": u, "name": n})).collect())
}

pub async fn lobby_unban(Path(code): Path<String>, body: Bytes) -> Resp {
    let (lobby, data) = lobby_data!(code, body);
    need_host!(lobby, data);
    let uid = clean_user_id(data.get("uid"));
    let name = {
        let mut l = lobby.st.lock();
        match uid {
            Some(u) if l.banned.contains_key(&u) => l.banned.shift_remove(&u),
            _ => None,
        }
    };
    let Some(name) = name else { return jerr(404, "that user isn't banned") };
    sio::broadcast(&lobby.code(), "chat", system_chat(format!("{name} was unbanned"))).await;
    let state = push_state(&lobby).await;
    let banned = banned_list(&lobby.st.lock());
    jsonify(json!({"ok": true, "banned": banned, "state": state}))
}

pub async fn lobby_banned(Path(code): Path<String>, RawQuery(q): RawQuery) -> Resp {
    let Some(lobby) = get_lobby_or_404(&code) else { return jerr(404, "not found") };
    let l = lobby.st.lock();
    if !require_host(&l, query_get(&q, "clientId").as_deref()) {
        return jerr(403, "host only");
    }
    jsonify(json!({"banned": banned_list(&l)}))
}

// ───────────────────────── settings / code / rename ─────────────────────────

pub async fn lobby_settings(Path(code): Path<String>, body: Bytes) -> Resp {
    let (lobby, data) = lobby_data!(code, body);
    need_host!(lobby, data);
    let new_name = if data.contains_key("name") {
        Some(trunc_chars(or500!(str_field(data.get("name"))).trim(), 40))
    } else {
        None
    };
    {
        let mut l = lobby.st.lock();
        if let Some(n) = new_name {
            if !n.is_empty() {
                l.name = n;
            }
        }
        if data.contains_key("isPublic") {
            l.is_public = truthy_opt(data.get("isPublic"));
        }
        if data.contains_key("password") {
            l.set_password(data.get("password")); // empty string removes it
        }
    }
    state_ok(&lobby).await
}

/// Pick your own lobby code instead of the random one.
pub async fn lobby_change_code(Path(code): Path<String>, body: Bytes) -> Resp {
    let (lobby, data) = lobby_data!(code, body);
    need_host!(lobby, data);
    let Some(new_code) = clean_code(data.get("newCode")) else {
        return jerr(400, &format!("Lobby codes are exactly {} letters (A-Z)", config::LOBBY_CODE_LENGTH));
    };
    if new_code == lobby.code() {
        return jsonify(json!({"ok": true, "state": lobby.public_state()}));
    }
    if code_in_use(&new_code) {
        return jerr(409, &format!("The code {new_code} is already in use by another lobby"));
    }
    let old = lobby.code();
    // Claim + release with no await in between.
    {
        let mut reg = LOBBIES.lock();
        reg.insert(new_code.clone(), lobby.clone());
        reg.shift_remove(&old);
    }
    let moves: Vec<(String, Vec<_>)> = {
        let mut l = lobby.st.lock();
        l.code = new_code.clone();
        l.sids.iter().map(|(c, s)| (c.clone(), s.iter().copied().collect())).collect()
    };
    lobby.relay.audio_out.set_code(&new_code);
    for (cid, sids) in moves {
        for sid in sids {
            SID_REGISTRY.lock().insert(sid, (new_code.clone(), cid.clone()));
            sio::leave_room(sid, &old);
            sio::join_room(sid, &new_code);
        }
    }
    sio::broadcast(&new_code, "chat", system_chat(format!("Lobby code changed to {new_code}"))).await;
    state_ok(&lobby).await
}

/// Anyone can change their OWN display name — not host-gated.
pub async fn lobby_rename(Path(code): Path<String>, body: Bytes) -> Resp {
    let (lobby, data) = lobby_data!(code, body);
    let cid = client_id_of(&data);
    if !cid.as_ref().map(|c| lobby.st.lock().participants.contains_key(c)).unwrap_or(false) {
        return jerr(403, "not in lobby");
    }
    let cid = cid.unwrap();
    let new_name = trunc_chars(or500!(str_field(data.get("displayName"))).trim(), 24);
    let (cur_name, change) = {
        let l = lobby.st.lock();
        let p = &l.participants[&cid];
        (p.name.clone(), !new_name.is_empty() && new_name != p.name)
    };
    if !change {
        return jsonify(json!({"ok": true, "displayName": cur_name}));
    }
    let relabeled = {
        let mut l = lobby.st.lock();
        let uid = {
            let p = l.participants.get_mut(&cid).unwrap();
            p.name = new_name.clone();
            p.uid.clone()
        };
        relabel_requester(&mut l, &uid, &new_name)
    };
    let c = lobby.code();
    sio::broadcast(&c, "participants", lobby.participant_list()).await;
    if relabeled {
        sio::broadcast(&c, "state", lobby.public_state()).await;
    }
    sio::broadcast(&c, "chat", system_chat(format!("{cur_name} is now known as {new_name}"))).await;
    jsonify(json!({"ok": true, "displayName": new_name}))
}

// ───────────────────────── queue ─────────────────────────

pub async fn lobby_queue_add(Path(code): Path<String>, body: Bytes) -> Resp {
    let (lobby, data) = lobby_data!(code, body);
    let cid = client_id_of(&data);
    let (track, start) = {
        let mut l = lobby.st.lock();
        let Some(p) = cid.as_ref().and_then(|c| l.participants.get(c)).cloned() else { drop(l); return jerr(403, "not in lobby") };
        let track = stamp_requester(data.get("track").cloned(), Some(&p));
        if !l.has_track() {
            l.current_track = track.clone();
            l.paused = false;
            l.position_anchor_ms = 0.0;
            l.anchor_time = now_secs();
            (track, true)
        } else {
            l.queue.push(track.clone().unwrap_or(Value::Null));
            l.apply_fair();
            (track, false)
        }
    };
    if start {
        lobby.relay.resume_or_start(track, 0.0);
        populate_recommendations(&lobby, None, true).await;
    } else {
        lobby.relay.ensure_preload(); // queue may have just gone from empty -> non-empty
    }
    state_ok(&lobby).await
}

/// Same as queue/add, but for a whole list of tracks in one request.
pub async fn lobby_queue_add_bulk(Path(code): Path<String>, body: Bytes) -> Resp {
    let (lobby, data) = lobby_data!(code, body);
    let cid = client_id_of(&data);
    let participant = {
        let l = lobby.st.lock();
        cid.as_ref().and_then(|c| l.participants.get(c)).cloned()
    };
    let Some(participant) = participant else { return jerr(403, "not in lobby") };
    let tracks_in = match data.get("tracks") {
        Some(Value::Array(a)) if !a.is_empty() => a.clone(),
        _ => return jerr(400, "no tracks"),
    };
    let tracks: Vec<Option<Value>> = tracks_in.into_iter().map(|t| stamp_requester(Some(t), Some(&participant))).collect();
    let added = tracks.len();
    let as_val = |t: &Option<Value>| t.clone().unwrap_or(Value::Null);

    let (started, cur) = {
        let mut l = lobby.st.lock();
        let started = !l.has_track();
        if started {
            l.current_track = tracks[0].clone();
            l.queue.extend(tracks[1..].iter().map(as_val));
            l.paused = false;
            l.position_anchor_ms = 0.0;
            l.anchor_time = now_secs();
        } else {
            l.queue.extend(tracks.iter().map(as_val));
        }
        l.apply_fair();
        (started, l.current_track.clone())
    };
    if started {
        lobby.relay.resume_or_start(cur, 0.0);
        populate_recommendations(&lobby, None, false).await;
    } else {
        lobby.relay.ensure_preload();
    }
    let state = push_state(&lobby).await;
    jsonify(json!({"ok": true, "state": state, "added": added}))
}

pub async fn lobby_queue_remove(Path(code): Path<String>, body: Bytes) -> Resp {
    let (lobby, data) = lobby_data!(code, body);
    let cid = client_id_of(&data);
    {
        let mut l = lobby.st.lock();
        if !cid.as_ref().map(|c| l.participants.contains_key(c)).unwrap_or(false) {
            return jerr(403, "not in lobby");
        }
        let idx = py_int(data.get("index")).filter(|&i| i >= 0 && (i as usize) < l.queue.len());
        let Some(idx) = idx else { return jerr(400, "bad index") };
        let idx = idx as usize;
        // The host (or a DJ) can remove anything; everyone else only tracks they added themselves.
        let me_key = l.participants.get(cid.as_deref().unwrap()).map(|p| p.uid.clone()).unwrap_or_else(|| cid.clone().unwrap());
        if !require_controller(&l, cid.as_deref()) && requester_key(Some(&l.queue[idx])) != me_key {
            return jerr(403, "you can only remove tracks you added");
        }
        l.queue.remove(idx);
        l.apply_fair();
    }
    lobby.relay.ensure_preload(); // the queue head may have changed
    state_ok(&lobby).await
}

/// Sorted, de-duplicated, in-range queue positions from a client-supplied list.
fn queue_indices(qlen: usize, raw: Option<&Value>) -> Vec<usize> {
    let Some(Value::Array(a)) = raw else { return vec![] };
    let mut set: Vec<usize> = a
        .iter()
        .filter_map(|v| match v {
            Value::Number(n) => n.as_i64(),
            _ => None,
        })
        .filter(|&i| i >= 0 && (i as usize) < qlen)
        .map(|i| i as usize)
        .collect();
    set.sort();
    set.dedup();
    set
}

fn present(data: &Data, key: &str) -> bool {
    !matches!(data.get(key), None | Some(Value::Null))
}

pub async fn lobby_queue_shuffle(Path(code): Path<String>, body: Bytes) -> Resp {
    let (lobby, data) = lobby_data!(code, body);
    need_controller!(lobby, data);
    {
        let mut l = lobby.st.lock();
        let indices = queue_indices(l.queue.len(), data.get("indices"));
        if present(&data, "indices") {
            // Filtered shuffle: only the tracks at these positions trade places.
            if indices.is_empty() {
                drop(l);
                return jerr(400, "bad indices");
            }
            let mut picked: Vec<Value> = indices.iter().map(|&i| l.queue[i].clone()).collect();
            picked.shuffle(&mut rand::thread_rng());
            for (i, t) in indices.iter().zip(picked) {
                l.queue[*i] = t;
            }
        } else {
            l.queue.shuffle(&mut rand::thread_rng());
        }
        l.apply_fair(); // with Fair on this only shuffles within each person's own tracks
    }
    lobby.relay.ensure_preload();
    state_ok(&lobby).await
}

pub async fn lobby_queue_clear(Path(code): Path<String>, body: Bytes) -> Resp {
    let (lobby, data) = lobby_data!(code, body);
    need_controller!(lobby, data);
    let removed = {
        let mut l = lobby.st.lock();
        if present(&data, "indices") {
            let indices = queue_indices(l.queue.len(), data.get("indices"));
            if indices.is_empty() {
                drop(l);
                return jerr(400, "bad indices");
            }
            let gone: HashSet<usize> = indices.iter().copied().collect();
            let q = std::mem::take(&mut l.queue);
            l.queue = q.into_iter().enumerate().filter(|(i, _)| !gone.contains(i)).map(|(_, t)| t).collect();
            l.apply_fair();
            gone.len()
        } else {
            let n = l.queue.len();
            l.queue = vec![];
            l.auto_queue = vec![];
            n
        }
    };
    lobby.relay.ensure_preload();
    let state = push_state(&lobby).await;
    jsonify(json!({"ok": true, "removed": removed, "state": state}))
}

/// `int(x)` with Python's TypeError/ValueError -> None.
fn py_int_conv(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f.trunc() as i64)),
        Value::Bool(b) => Some(*b as i64),
        Value::String(s) => s.trim().replace('_', "").parse::<i64>().ok(),
        _ => None,
    }
}

/// Smart Shuffle: top the recommendation pool up, move up to `count` of them
/// into the queue, then shuffle so they're interleaved with what people picked.
pub async fn lobby_queue_smart(Path(code): Path<String>, body: Bytes) -> Resp {
    let (lobby, data) = lobby_data!(code, body);
    need_controller!(lobby, data);
    if !lobby.st.lock().has_track() {
        return jerr(400, "nothing playing to base recommendations on");
    }
    let count: usize = match data.get("count") {
        None => 20,
        Some(v) => py_int_conv(v).map(|c| c.max(1) as usize).unwrap_or(20),
    };

    if lobby.st.lock().auto_queue.len() < count {
        // Fetch inline: the person pressed a button and is waiting for tracks to appear.
        populate_recommendations(&lobby, None, false).await;
        let task = lobby.st.lock().rec_task.clone();
        if let Some(t) = task {
            let _ = tokio::time::timeout(Duration::from_secs(12), t.wait()).await;
        }
    }

    let added = {
        let mut l = lobby.st.lock();
        // Shuffle the pool BEFORE taking from it.
        l.auto_queue.shuffle(&mut rand::thread_rng());
        let played = l.played_ids();
        let mut queued = l.queued_ids();
        let (mut added, mut leftover) = (vec![], vec![]);
        for t in std::mem::take(&mut l.auto_queue) {
            let tid = track_id(&t);
            if added.len() < count && !played.contains(&tid) && !queued.contains(&tid) {
                queued.insert(tid);
                added.push(t);
            } else {
                leftover.push(t);
            }
        }
        l.auto_queue = leftover;
        let n = added.len();
        l.queue.extend(added);
        l.queue.shuffle(&mut rand::thread_rng());
        l.apply_fair();
        n
    };
    lobby.relay.ensure_preload();

    if added > 0 {
        let text = format!("🔀 Smart Shuffle added {} recommended track{}", added, if added != 1 { "s" } else { "" });
        sio::broadcast(&lobby.code(), "chat", system_chat(text)).await;
    }
    let state = push_state(&lobby).await;
    jsonify(json!({"ok": true, "added": added, "state": state}))
}

/// Reorders the shared queue (drag-and-drop in lobby mode).
pub async fn lobby_queue_move(Path(code): Path<String>, body: Bytes) -> Resp {
    let (lobby, data) = lobby_data!(code, body);
    need_controller!(lobby, data);
    let from = py_int(data.get("fromIndex"));
    let to = py_int(data.get("toIndex"));
    let mut fair_snapped = false;
    let mut moved = false;
    {
        let mut l = lobby.st.lock();
        let n = l.queue.len() as i64;
        if let (Some(f), Some(t)) = (from, to) {
            if f >= 0 && f < n && t >= 0 && t < n && f != t {
                let item = l.queue.remove(f as usize);
                l.queue.insert(t as usize, item);
                // With Fair on, a move that crosses between people snaps back.
                fair_snapped = l.apply_fair();
                moved = true;
            }
        }
    }
    if moved {
        lobby.relay.ensure_preload(); // the queue head may have changed
    }
    let state = push_state(&lobby).await;
    jsonify(json!({"ok": true, "state": state, "fairSnapped": fair_snapped}))
}

#[allow(dead_code)]
static _UNUSED: LazyLock<Regex> = LazyLock::new(|| Regex::new("").unwrap());
