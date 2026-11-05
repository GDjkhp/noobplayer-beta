//! Lobby data model (in-memory), track helpers, the recommendation populator
//! and participant-departure logic.
//!
//! Everything runs on a single-threaded tokio runtime and no lock guard is ever
//! held across an `.await`, so each synchronous stretch of code is atomic with
//! respect to every other task — the same guarantee the original asyncio event
//! loop gave.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Weak};

use indexmap::IndexMap;
use parking_lot::Mutex;
use rand::seq::SliceRandom;
use rand::Rng;
use regex::Regex;
use serde_json::{json, Map, Value};
use socketioxide::socket::Sid;

use crate::config;
use crate::nodelink;
use crate::relay::Relay;
use crate::sio;
use crate::util::{now_ms, now_secs, str_or, trunc_chars, truthy, truthy_opt, TaskDone};

// ───────────────────────── track helpers ─────────────────────────

/// source name (as NodeLink reports it) -> recommendation search prefix
fn rec_prefix(source: &str) -> Option<&'static str> {
    match source {
        "spotify" => Some("sprec"),
        "deezer" => Some("dzrec"),
        "tidal" => Some("tdrec"),
        "jiosaavn" => Some("jsrec"),
        _ => None,
    }
}

const YOUTUBE_SOURCES: [&str; 4] = ["youtube", "youtubemusic", "ytmusic", "youtube_music"];

/// Python truthiness-based `a or b` on two optional JSON values, then to a
/// hashable identity string.
fn ident_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::String(_) | Value::Null => None,
        other if truthy(other) => Some(other.to_string()),
        _ => None,
    }
}

pub fn track_info(track: &Value) -> Option<&Map<String, Value>> {
    track.get("info").and_then(|i| i.as_object())
}

pub fn track_encoded(track: &Value) -> Option<&str> {
    track.get("encoded").and_then(|e| e.as_str())
}

/// Stable per-track identity: the source's own id, else the encoded blob.
pub fn track_id(track: &Value) -> Option<String> {
    if !truthy(track) {
        return None;
    }
    if let Some(id) = track_info(track).and_then(|i| i.get("identifier")).and_then(ident_string) {
        return Some(id);
    }
    track.get("encoded").and_then(ident_string)
}

pub fn track_id_opt(track: Option<&Value>) -> Option<String> {
    track.and_then(track_id)
}

pub const DEBUG_LIST_CAP: usize = 100;

/// Lightweight {title, author, ...} view of a track for the Debug tab.
pub fn track_brief(track: &Value) -> Value {
    let info = track_info(track);
    let g = |k: &str| info.and_then(|i| i.get(k)).cloned().unwrap_or(Value::Null);
    json!({
        "title": g("title"),
        "author": g("author"),
        "length": g("length"),
        "sourceName": g("sourceName"),
    })
}

/// Tag a track with who added it.
pub fn stamp_requester(track: Option<Value>, participant: Option<&Participant>) -> Option<Value> {
    match track {
        Some(Value::Object(mut o)) => {
            if let Some(p) = participant {
                o.insert("requester".into(), json!({"id": p.uid, "name": p.name}));
            }
            Some(Value::Object(o))
        }
        other => other,
    }
}

/// A participant renamed themselves: rewrite every track they added.
pub fn relabel_requester(lobby: &mut Lobby, uid: &str, name: &str) -> bool {
    let mut changed = false;
    let mut fix = |t: &mut Value| {
        if let Some(req) = t.get_mut("requester").and_then(|r| r.as_object_mut()) {
            if req.get("id").and_then(|i| i.as_str()) == Some(uid) && req.get("name").and_then(|n| n.as_str()) != Some(name) {
                req.insert("name".into(), Value::String(name.to_string()));
                changed = true;
            }
        }
    };
    for t in lobby.queue.iter_mut() {
        fix(t);
    }
    for t in lobby.history.iter_mut() {
        fix(t);
    }
    for t in lobby.auto_queue.iter_mut() {
        fix(t);
    }
    if let Some(t) = lobby.current_track.as_mut() {
        fix(t);
    }
    changed
}

pub fn requester_key(track: Option<&Value>) -> String {
    let id = track.and_then(|t| t.get("requester")).and_then(|r| r.get("id"));
    match id {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        Some(v) if truthy(v) => v.to_string(),
        _ => "__unknown__".to_string(),
    }
}

/// Round-robin `queue` between whoever added each track, keeping every
/// person's own tracks in their existing relative order. Returns the new order
/// as indices into `queue` (so "did anything move" is an identity comparison,
/// exactly like the original `a is b` check).
pub fn fair_order(queue: &[Value], current_track: Option<&Value>) -> Vec<usize> {
    let mut order: Vec<String> = Vec::new();
    let mut by_requester: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, t) in queue.iter().enumerate() {
        let key = requester_key(Some(t));
        if !by_requester.contains_key(&key) {
            order.push(key.clone());
        }
        by_requester.entry(key).or_default().push(i);
    }
    if order.len() <= 1 {
        return (0..queue.len()).collect();
    }
    let current_key = requester_key(current_track);
    if let Some(pos) = order.iter().position(|k| *k == current_key) {
        let k = order.remove(pos);
        order.push(k);
    }
    let rounds = by_requester.values().map(|v| v.len()).max().unwrap_or(0);
    let mut out = Vec::with_capacity(queue.len());
    for rnd in 0..rounds {
        for key in &order {
            let tracks = &by_requester[key];
            if rnd < tracks.len() {
                out.push(tracks[rnd]);
            }
        }
    }
    out
}

/// The identifier to hand /v4/loadtracks to get tracks like this one, or None
/// if the source doesn't support recommendations.
pub fn recommendation_query(track: &Value) -> Option<String> {
    let info = track_info(track);
    let source = info
        .and_then(|i| i.get("sourceName"))
        .map(|s| str_or(Some(s), ""))
        .unwrap_or_default()
        .to_lowercase()
        .replace(' ', "");
    let identifier = info.and_then(|i| i.get("identifier")).filter(|v| truthy(v))?;
    let identifier = crate::util::py_str(identifier);
    if YOUTUBE_SOURCES.contains(&source.as_str()) {
        // YouTube has no rec endpoint — its "radio" playlist (RD + video id) is the equivalent.
        return Some(format!("https://www.youtube.com/watch?v={identifier}&list=RD{identifier}"));
    }
    if let Some(prefix) = rec_prefix(&source) {
        return Some(format!("{prefix}:{identifier}"));
    }
    if config::RECOMMEND_FALLBACK_SEARCH {
        if let Some(author) = info.and_then(|i| i.get("author")).filter(|a| truthy(a)) {
            return Some(format!("ytmsearch:{}", crate::util::py_str(author)));
        }
    }
    None
}

/// Returns a list of track dicts similar to `track` (possibly empty).
pub async fn fetch_recommendations(track: &Value) -> Vec<Value> {
    let Some(query) = recommendation_query(track) else {
        return vec![];
    };
    let data = match nodelink::get_json_lenient("/v4/loadtracks", &[("identifier", query.as_str())]).await {
        Some(d) => d,
        None => return vec![],
    };
    let load_type = data.get("loadType").and_then(|v| v.as_str());
    let payload = data.get("data");
    let tracks: Vec<Value> = match load_type {
        Some("playlist") => payload
            .and_then(|p| p.get("tracks"))
            .and_then(|t| t.as_array())
            .cloned()
            .unwrap_or_default(),
        Some("search") => payload.and_then(|p| p.as_array()).cloned().unwrap_or_default(),
        Some("track") => match payload {
            Some(p) if truthy(p) => vec![p.clone()],
            _ => vec![],
        },
        _ => vec![],
    };
    tracks
        .into_iter()
        .filter(|t| t.is_object() && t.get("encoded").map(truthy).unwrap_or(false))
        .collect()
}

/// Refill `lobby.auto_queue` from whatever is playing. Safe to call on every
/// track change — it's a no-op while a fetch is already in flight.
pub async fn populate_recommendations(lobby: &Arc<LobbyHandle>, seed: Option<Value>, broadcast_state: bool) -> u32 {
    let seed = {
        let mut l = lobby.st.lock();
        if l.autoplay == "disabled" {
            return 0;
        }
        if let Some(t) = &l.rec_task {
            if !t.is_done() {
                return 0;
            }
        }
        let seed = match seed {
            Some(s) if truthy(&s) => s,
            _ => match &l.current_track {
                Some(t) if truthy(t) => t.clone(),
                _ => return 0,
            },
        };
        let done = TaskDone::new();
        l.rec_task = Some(done.clone());
        let lobby2 = lobby.clone();
        let seed2 = seed.clone();
        tokio::spawn(async move {
            let _guard = done.guard();
            populate_run(lobby2, seed2, broadcast_state).await;
        });
        seed
    };
    let _ = seed;
    1
}

async fn populate_run(lobby: Arc<LobbyHandle>, seed: Value, broadcast_state: bool) {
    let mut recs = fetch_recommendations(&seed).await;
    if recs.is_empty() {
        return;
    }
    recs.shuffle(&mut rand::thread_rng());
    let code = {
        let mut l = lobby.st.lock();
        let played = l.played_ids();
        let queued = l.queued_ids();
        let mut have: HashSet<Option<String>> = l.auto_queue.iter().map(track_id).collect();
        for mut t in recs {
            let tid = track_id(&t);
            if played.contains(&tid) || queued.contains(&tid) || have.contains(&tid) {
                continue;
            }
            have.insert(tid);
            if let Some(o) = t.as_object_mut() {
                o.entry("requester").or_insert_with(|| json!({"id": "__auto__", "name": "Autoplay"}));
            }
            l.auto_queue.push(t);
        }
        // Shuffle the whole pool, not just this batch.
        l.auto_queue.shuffle(&mut rand::thread_rng());
        l.code.clone()
    };
    if broadcast_state && is_registered(&code, &lobby) {
        let state = lobby.public_state();
        sio::broadcast(&code, "state", state).await;
    }
}

// ───────────────────────── lobby model ─────────────────────────

#[derive(Clone)]
pub struct Participant {
    /// per-join session id (the credential every control call presents)
    pub id: String,
    pub name: String,
    /// Persistent user id generated by the browser and kept in its storage.
    pub uid: String,
}

impl Participant {
    pub fn new(pid: String, name: String, uid: Option<String>) -> Self {
        let uid = uid.unwrap_or_else(|| pid.clone());
        Self { id: pid, name, uid }
    }
}

pub struct Lobby {
    pub code: String,
    pub name: String,
    pub is_public: bool,
    pub host_id: String,
    pub participants: IndexMap<String, Participant>,
    /// client_id -> set of live Socket.IO sids
    pub sids: HashMap<String, HashSet<Sid>>,
    pub queue: Vec<Value>,
    pub current_track: Option<Value>,
    pub paused: bool,
    pub position_anchor_ms: f64,
    pub anchor_time: f64,
    pub chat: Vec<Value>,
    #[allow(dead_code)]
    pub created_at: f64,
    pw_salt: Option<[u8; 16]>,
    pw_hash: Option<[u8; 32]>,
    /// 'none' | 'track' | 'queue'
    pub loop_mode: String,
    /// 'enabled' | 'partial' | 'disabled'
    pub autoplay: String,
    pub history: Vec<Value>,
    pub auto_queue: Vec<Value>,
    pub rec_task: Option<Arc<TaskDone>>,
    pub gapless: bool,
    pub fair: bool,
    pub djs: HashSet<String>,
    pub banned: IndexMap<String, String>,
}

pub struct LobbyHandle {
    pub st: Mutex<Lobby>,
    pub relay: Arc<Relay>,
}

impl LobbyHandle {
    pub fn new(code: String, name: String, is_public: bool, host_id: String) -> Arc<Self> {
        Arc::new_cyclic(|weak: &Weak<LobbyHandle>| LobbyHandle {
            relay: Relay::new(weak.clone(), code.clone()),
            st: Mutex::new(Lobby {
                code,
                name,
                is_public,
                host_id,
                participants: IndexMap::new(),
                sids: HashMap::new(),
                queue: vec![],
                current_track: None,
                paused: true,
                position_anchor_ms: 0.0,
                anchor_time: now_secs(),
                chat: vec![],
                created_at: now_secs(),
                pw_salt: None,
                pw_hash: None,
                loop_mode: "none".into(),
                autoplay: "enabled".into(),
                history: vec![],
                auto_queue: vec![],
                rec_task: None,
                gapless: true,
                fair: true,
                djs: HashSet::new(),
                banned: IndexMap::new(),
            }),
        })
    }

    pub fn code(&self) -> String {
        self.st.lock().code.clone()
    }

    /// `lobby.public_state()` (locks the lobby — never call while holding `st`).
    pub fn public_state(&self) -> Value {
        let gen = self.relay.generation();
        self.st.lock().public_state_with(gen)
    }

    pub fn participant_list(&self) -> Value {
        self.st.lock().participant_list()
    }
}

fn pbkdf2(pw: &str, salt: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(pw.as_bytes(), salt, 50_000, &mut out);
    out
}

impl Lobby {
    /// Re-balance the queue if Fair Queue is on. Returns true if the order
    /// actually changed.
    pub fn apply_fair(&mut self) -> bool {
        if !self.fair || self.queue.len() < 2 {
            return false;
        }
        let order = fair_order(&self.queue, self.current_track.as_ref());
        if order.iter().enumerate().all(|(i, &j)| i == j) {
            return false;
        }
        let mut old: Vec<Option<Value>> = std::mem::take(&mut self.queue).into_iter().map(Some).collect();
        self.queue = order.into_iter().map(|i| old[i].take().expect("fair_order is a permutation")).collect();
        true
    }

    pub fn current_position_ms(&self) -> f64 {
        let has = self.current_track.as_ref().map(truthy).unwrap_or(false);
        if self.paused || !has {
            return self.position_anchor_ms;
        }
        let elapsed = (now_secs() - self.anchor_time) * 1000.0;
        self.position_anchor_ms + elapsed
    }

    pub fn has_track(&self) -> bool {
        self.current_track.as_ref().map(truthy).unwrap_or(false)
    }

    pub fn played_ids(&self) -> HashSet<Option<String>> {
        let mut ids: HashSet<Option<String>> = self.history.iter().map(track_id).collect();
        ids.remove(&None);
        ids
    }

    pub fn queued_ids(&self) -> HashSet<Option<String>> {
        let mut ids: HashSet<Option<String>> = self.queue.iter().map(track_id).collect();
        ids.insert(track_id_opt(self.current_track.as_ref()));
        ids.remove(&None);
        ids
    }

    /// First recommendation that isn't already played or queued — the
    /// non-mutating counterpart of drain_auto_queue().
    pub fn next_auto_track(&self) -> Option<Value> {
        if self.autoplay != "enabled" {
            return None;
        }
        let played = self.played_ids();
        let queued = self.queued_ids();
        for t in &self.auto_queue {
            let tid = track_id(t);
            if !played.contains(&tid) && !queued.contains(&tid) {
                return Some(t.clone());
            }
        }
        None
    }

    /// Move every still-eligible recommendation into the real queue and empty the pool.
    pub fn drain_auto_queue(&mut self) -> usize {
        if self.autoplay != "enabled" || self.auto_queue.is_empty() {
            return 0;
        }
        let played = self.played_ids();
        let mut queued = self.queued_ids();
        let mut moved = 0;
        let pool = std::mem::take(&mut self.auto_queue);
        for t in pool {
            let tid = track_id(&t);
            if tid.is_none() || (!played.contains(&tid) && !queued.contains(&tid)) {
                if tid.is_some() {
                    queued.insert(tid);
                }
                self.queue.push(t);
                moved += 1;
            }
        }
        moved
    }

    /// What plays after the current track, without touching anything.
    pub fn peek_next_track(&self) -> Option<Value> {
        if self.loop_mode == "track" && self.has_track() {
            return self.current_track.clone();
        }
        if let Some(t) = self.queue.first() {
            return Some(t.clone());
        }
        if self.loop_mode == "queue" && self.has_track() {
            return self.current_track.clone(); // wraps to itself once the queue drains
        }
        self.next_auto_track()
    }

    /// Consume whatever should play next and return it (or None if the lobby
    /// should go idle).
    pub fn advance_track(&mut self, skip_track_loop: bool) -> Option<Value> {
        let finished = self.current_track.clone().filter(truthy);
        if self.loop_mode == "track" && finished.is_some() && !skip_track_loop {
            return finished;
        }
        if let Some(f) = &finished {
            self.history.push(f.clone());
        }
        if self.loop_mode == "queue" {
            if let Some(f) = &finished {
                self.queue.push(f.clone());
            }
        }
        if self.queue.is_empty() {
            self.drain_auto_queue();
        }
        if !self.queue.is_empty() {
            return Some(self.queue.remove(0));
        }
        None
    }

    /// Step backwards through history, pushing the current track back to the
    /// front of the queue so nothing is lost.
    pub fn previous_track(&mut self) -> Option<Value> {
        let prev = self.history.pop()?;
        if self.has_track() {
            let cur = self.current_track.clone().unwrap();
            self.queue.insert(0, cur);
        }
        Some(prev)
    }

    pub fn has_password(&self) -> bool {
        self.pw_hash.is_some()
    }

    /// Set (non-empty string) or clear (empty/None) the join password.
    pub fn set_password(&mut self, pw: Option<&Value>) {
        let pw = trunc_chars(&str_or(pw, ""), config::LOBBY_PASSWORD_MAX);
        if pw.is_empty() {
            self.pw_salt = None;
            self.pw_hash = None;
            return;
        }
        let mut salt = [0u8; 16];
        rand::thread_rng().fill(&mut salt);
        self.pw_salt = Some(salt);
        self.pw_hash = Some(pbkdf2(&pw, &salt));
    }

    pub fn check_password(&self, pw: Option<&Value>) -> bool {
        use subtle::ConstantTimeEq;
        let (Some(salt), Some(hash)) = (self.pw_salt, self.pw_hash) else {
            return true;
        };
        let cand = pbkdf2(&trunc_chars(&str_or(pw, ""), config::LOBBY_PASSWORD_MAX), &salt);
        cand.ct_eq(&hash).into()
    }

    pub fn uid_of(&self, client_id: &str) -> String {
        self.participants.get(client_id).map(|p| p.uid.clone()).unwrap_or_default()
    }

    pub fn public_state_with(&self, relay_gen: u64) -> Value {
        let mut djs: Vec<String> = self.djs.iter().map(|c| self.uid_of(c)).collect::<HashSet<_>>().into_iter().collect();
        djs.sort();
        json!({
            "code": self.code,
            "hasPassword": self.has_password(),
            "name": self.name,
            "isPublic": self.is_public,
            // Public identity only: the host's persistent user id, never their session id.
            "hostId": self.uid_of(&self.host_id),
            "currentTrack": self.current_track.clone().unwrap_or(Value::Null),
            "paused": self.paused,
            "positionMs": crate::util::jf(self.current_position_ms()),
            "queue": self.queue,
            "relayGen": relay_gen,
            "loopMode": self.loop_mode,
            "autoplay": self.autoplay,
            "autoQueueCount": self.auto_queue.len(),
            "historyCount": self.history.len(),
            "gapless": self.gapless,
            "fair": self.fair,
            "djs": djs,
            "bannedCount": self.banned.len(),
        })
    }

    /// Every live session id belonging to a persistent user id.
    pub fn client_ids_for_uid(&self, uid: &str) -> Vec<String> {
        self.participants.iter().filter(|(_, p)| p.uid == uid).map(|(c, _)| c.clone()).collect()
    }

    pub fn participant_list(&self) -> Value {
        // Session ids are credentials — never put them on the wire here.
        Value::Array(
            self.participants
                .values()
                .map(|p| {
                    json!({
                        "uid": p.uid,
                        "name": p.name,
                        "isHost": p.id == self.host_id,
                        "isDj": self.djs.contains(&p.id),
                    })
                })
                .collect(),
        )
    }
}

// ───────────────────────── registry ─────────────────────────

/// LOBBIES IS the registry of every running lobby code.
pub static LOBBIES: LazyLock<Mutex<IndexMap<String, Arc<LobbyHandle>>>> = LazyLock::new(|| Mutex::new(IndexMap::new()));

/// Socket.IO sid -> (lobby_code, client_id), so the disconnect handler knows who dropped.
pub static SID_REGISTRY: LazyLock<Mutex<HashMap<Sid, (String, String)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

static LOBBY_CODE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("^[A-Z]{{{}}}$", config::LOBBY_CODE_LENGTH)).unwrap());
static ID32_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new("^[0-9a-f]{32}$").unwrap());

pub fn clean_client_id_ok(s: &str) -> bool {
    ID32_RE.is_match(s)
}

/// The browser's persistent user id if it's well-formed, else None.
pub fn clean_user_id(raw: Option<&Value>) -> Option<String> {
    let uid = str_or(raw, "").trim().to_lowercase();
    if ID32_RE.is_match(&uid) {
        Some(uid)
    } else {
        None
    }
}

/// Normalise user input to a valid lobby code (exactly N letters A-Z), or None.
pub fn clean_code(raw: Option<&Value>) -> Option<String> {
    let code = str_or(raw, "").trim().to_uppercase();
    if LOBBY_CODE_RE.is_match(&code) {
        Some(code)
    } else {
        None
    }
}

pub fn code_in_use(code: &str) -> bool {
    LOBBIES.lock().contains_key(code)
}

pub fn register_lobby(lobby: &Arc<LobbyHandle>) -> Result<(), String> {
    let code = lobby.code();
    let mut reg = LOBBIES.lock();
    if reg.contains_key(&code) {
        return Err(format!("lobby code {code} is already in use"));
    }
    reg.insert(code, lobby.clone());
    Ok(())
}

/// Only ever frees the code if it still points at THIS lobby.
pub fn unregister_lobby(lobby: &Arc<LobbyHandle>) {
    let code = lobby.code();
    let mut reg = LOBBIES.lock();
    if let Some(cur) = reg.get(&code) {
        if Arc::ptr_eq(cur, lobby) {
            reg.shift_remove(&code);
        }
    }
}

pub fn is_registered(code: &str, lobby: &Arc<LobbyHandle>) -> bool {
    LOBBIES.lock().get(code).map(|l| Arc::ptr_eq(l, lobby)).unwrap_or(false)
}

pub fn gen_code() -> String {
    let mut rng = rand::thread_rng();
    loop {
        let code: String = (0..config::LOBBY_CODE_LENGTH).map(|_| (b'A' + rng.gen_range(0..26u8)) as char).collect();
        if !code_in_use(&code) {
            return code;
        }
    }
}

pub fn get_lobby_or_404(code: &str) -> Option<Arc<LobbyHandle>> {
    LOBBIES.lock().get(&code.to_uppercase()).cloned()
}

/// The lobby a client id belongs to, whatever its code is NOW.
pub fn find_lobby_by_client(client_id: Option<&str>) -> Option<Arc<LobbyHandle>> {
    let client_id = client_id.filter(|c| !c.is_empty())?;
    for l in LOBBIES.lock().values() {
        if l.st.lock().participants.contains_key(client_id) {
            return Some(l.clone());
        }
    }
    None
}

// ───────────────────────── participant departure ─────────────────────────

/// Remove a participant for real: promote a new host if they were host,
/// broadcast the change, and tear the whole lobby down (including every
/// listener's session) if that was the last participant.
pub async fn finalize_leave(lobby: &Arc<LobbyHandle>, client_id: &str) {
    let (code, p, was_host, sids) = {
        let mut l = lobby.st.lock();
        if !l.participants.contains_key(client_id) {
            return; // already handled by a prior call
        }
        let p = l.participants.shift_remove(client_id);
        l.djs.remove(client_id);
        let sids = l.sids.remove(client_id).unwrap_or_default();
        (l.code.clone(), p, l.host_id == client_id, sids)
    };
    for sid in sids {
        SID_REGISTRY.lock().remove(&sid);
        sio::disconnect_sid(sid);
    }

    let (empty, new_host_name) = {
        let mut l = lobby.st.lock();
        if was_host && !l.participants.is_empty() {
            let first = l.participants.keys().next().cloned().unwrap();
            l.host_id = first.clone();
            l.djs.remove(&first); // the host already controls everything
        }
        let nh = l.participants.get(&l.host_id).map(|p| p.name.clone());
        (l.participants.is_empty(), nh)
    };

    if empty {
        lobby.relay.shutdown().await;
        unregister_lobby(lobby);
        return; // lobby is gone, nobody left to notify
    }

    if let Some(p) = p {
        sio::broadcast(&code, "participants", lobby.participant_list()).await;
        let mut text = format!("{} left", p.name);
        if was_host {
            if let Some(n) = new_host_name {
                text.push_str(&format!(" \u{b7} {} is now host", n));
            }
        }
        sio::broadcast(&code, "chat", json!({"system": true, "text": text, "ts": now_ms()})).await;
    }

    if was_host {
        // hostId changed — push fresh state so host-only UI locks update everywhere.
        sio::broadcast(&code, "state", lobby.public_state()).await;
    }
}

/// Wait out the grace period after a Socket.IO connection drops; if the client
/// hasn't reconnected (registered a new live sid) by then, treat it as a real
/// departure.
pub async fn schedule_disconnect_check(lobby: Arc<LobbyHandle>, client_id: String) {
    tokio::time::sleep(std::time::Duration::from_secs(config::DISCONNECT_GRACE_SECONDS)).await;
    {
        let l = lobby.st.lock();
        if l.sids.get(&client_id).map(|s| !s.is_empty()).unwrap_or(false) {
            return; // reconnected in time — nothing to do
        }
    }
    finalize_leave(&lobby, &client_id).await;
}

// ───────────────────────── misc shared checks ─────────────────────────

pub fn require_host(l: &Lobby, client_id: Option<&str>) -> bool {
    client_id.map(|c| l.host_id == c).unwrap_or(false)
}

/// Host OR a DJ the host has appointed. The gate for everything that drives
/// the player and the queue.
pub fn require_controller(l: &Lobby, client_id: Option<&str>) -> bool {
    match client_id {
        Some(c) => l.host_id == c || l.djs.contains(c),
        None => false,
    }
}

/// `data.get("clientId")` as a string, when it is one.
pub fn client_id_of(data: &Map<String, Value>) -> Option<String> {
    data.get("clientId").and_then(|v| v.as_str()).map(|s| s.to_string())
}

pub fn truthy_field(data: &Map<String, Value>, key: &str) -> bool {
    truthy_opt(data.get(key))
}
