//! Live music relay — one continuous PCM pipeline per lobby, Opus-encoded once
//! and fanned out to every listener's WebTransport session (see quic.rs), plus
//! the per-track PCM seek cache, the gapless preload, the debug push and the
//! staged audio-analysis orchestration.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::StreamExt;
use indexmap::IndexMap;
use parking_lot::{Mutex, RwLock};
use serde_json::{json, Map, Value};
use socketioxide::socket::Sid;
use tokio::sync::{Notify, Semaphore};
use tokio::task::JoinHandle;

use crate::analysis::{self, BeatsOut, StageInfo};
use crate::config;
use crate::lobby::{populate_recommendations, track_brief, track_encoded, track_info, LobbyHandle, DEBUG_LIST_CAP};
use crate::nodelink;
use crate::pool;
use crate::sio;
use crate::util::{jf, now_ms, now_secs, py_round, truthy, Event};

pub const PCM_RATE: usize = 48000;
pub const PCM_CHANNELS: usize = 2;
pub const PCM_FRAME_SAMPLES: usize = 960; // 20ms @ 48kHz
pub const PCM_FRAME_BYTES: usize = PCM_FRAME_SAMPLES * PCM_CHANNELS * 2; // s16le
/// Opus bitrate of the separate full-track /api/download encoder.
pub const OPUS_BITRATE: i32 = 96000;

/// How many 20ms frames a single listener's outbound queue holds before the
/// OLDEST queued frame is dropped (~4s of slack).
const WT_LISTENER_QUEUE_FRAMES: usize = 200;

/// How often the idle loop wakes to top up silence while the queue is empty.
const IDLE_KEEPALIVE_SECONDS: f64 = 1.0;

/// finished analyses remembered per lobby
const ANALYSIS_KEEP: usize = 12;

// ───────────────────────── listener ─────────────────────────

/// One connected browser tab's WebTransport session. A bounded queue decouples
/// "the relay just produced a frame" from "this listener's stream can currently
/// accept more data": push() never blocks, and a listener that can't keep up
/// only ever hurts itself.
pub struct WtListener {
    queue: Mutex<VecDeque<Bytes>>,
    notify: Notify,
    closed: AtomicBool,
}

impl WtListener {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { queue: Mutex::new(VecDeque::new()), notify: Notify::new(), closed: AtomicBool::new(false) })
    }

    pub fn push(&self, data: Bytes) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        {
            let mut q = self.queue.lock();
            if q.len() >= WT_LISTENER_QUEUE_FRAMES {
                // Drop the oldest queued frame, not the new one.
                q.pop_front();
            }
            q.push_back(data);
        }
        self.notify.notify_one();
    }

    /// Next frame to write, or None once closed.
    pub async fn next(&self) -> Option<Bytes> {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.closed.load(Ordering::SeqCst) {
                return None;
            }
            if let Some(b) = self.queue.lock().pop_front() {
                return Some(b);
            }
            notified.await;
        }
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
        self.notify.notify_one();
    }
}

// ───────────────────────── Opus fan-out ─────────────────────────

struct QState {
    code: String,
    listeners: Vec<Arc<WtListener>>,
    bytes_out: u64,
    pos_ms: f64,
    running: bool,
    since_sync: u32,
    last_push: Option<Instant>,
    enc: Option<crate::opus::Encoder>,
    ok: bool,
}

/// Fans the real-time-paced PCM out to every listener, Opus-encoded ONCE here.
///
/// Wire format on each listener's single unidirectional stream: a sequence of
/// `[uint16 BE length][payload]`, where payload[0] is a type:
///   0x00  Opus packet (20ms) — payload[1:] is the packet
///   0x01  TIMELINE sync — `[flags u8][positionMs f64 BE]`
///           flags bit0 = running, bit1 = cut (discard everything buffered)
pub struct QuicPcmRelay {
    s: Mutex<QState>,
}

const SYNC_EVERY_FRAMES: u32 = 50; // re-assert the timeline every ~1s
const STALL_SECONDS: f64 = 0.08; // gap since last push that forces a fresh sync

fn sync_packet(pos_ms: f64, running: bool, cut: bool) -> Bytes {
    let flags: u8 = (running as u8) | ((cut as u8) << 1);
    let mut v = Vec::with_capacity(12);
    v.extend_from_slice(&10u16.to_be_bytes());
    v.push(0x01);
    v.push(flags);
    v.extend_from_slice(&pos_ms.to_be_bytes());
    Bytes::from(v)
}

fn make_encoder() -> Result<crate::opus::Encoder, crate::opus::Error> {
    let mut enc = crate::opus::Encoder::new(PCM_RATE as u32, crate::opus::Channels::Stereo, crate::opus::Application::Audio)?;
    enc.set_bitrate(crate::opus::Bitrate::Bits(config::QUIC_OPUS_BITRATE))?;
    enc.set_vbr(true)?;
    enc.set_vbr_constraint(false)?;
    enc.set_complexity(10)?;
    enc.set_lsb_depth(16)?;
    Ok(enc)
}

impl QuicPcmRelay {
    pub fn new(code: String) -> Arc<Self> {
        let (enc, ok) = match make_encoder() {
            Ok(e) => (Some(e), true),
            Err(e) => {
                eprintln!("[quic {code}] failed to open libopus encoder — lobby audio will not work ({e})");
                (None, false)
            }
        };
        Arc::new(Self {
            s: Mutex::new(QState {
                code,
                listeners: vec![],
                bytes_out: 0,
                pos_ms: 0.0,
                running: false,
                since_sync: 0,
                last_push: None,
                enc,
                ok,
            }),
        })
    }

    pub fn set_code(&self, code: &str) {
        self.s.lock().code = code.to_string();
    }

    pub fn pos_ms(&self) -> f64 {
        self.s.lock().pos_ms
    }

    pub fn bytes_out(&self) -> u64 {
        self.s.lock().bytes_out
    }

    pub fn listener_count(&self) -> usize {
        self.s.lock().listeners.len()
    }

    fn broadcast(s: &QState, framed: &Bytes) {
        for l in &s.listeners {
            l.push(framed.clone());
        }
    }

    /// Declare where the NEXT audio frame sits on the track timeline. Call BEFORE
    /// pushing the frame it describes.
    pub fn set_timeline(&self, pos_ms: f64, running: bool, cut: bool) {
        let mut s = self.s.lock();
        s.pos_ms = pos_ms;
        s.running = running;
        s.since_sync = 0;
        let p = sync_packet(s.pos_ms, s.running, cut);
        Self::broadcast(&s, &p);
    }

    pub fn add_listener(&self, listener: Arc<WtListener>) {
        let mut s = self.s.lock();
        if !s.listeners.iter().any(|l| Arc::ptr_eq(l, &listener)) {
            s.listeners.push(listener.clone());
        }
        // A joiner needs the timeline before its first audio packet.
        listener.push(sync_packet(s.pos_ms, s.running, false));
    }

    pub fn remove_listener(&self, listener: &Arc<WtListener>) {
        self.s.lock().listeners.retain(|l| !Arc::ptr_eq(l, listener));
        listener.close();
    }

    /// Called for every 20ms PCM frame. `silence=true` frames never advance the
    /// track timeline.
    pub fn push(&self, pcm: &[u8], silence: bool) {
        let mut s = self.s.lock();
        if !s.ok {
            return;
        }
        let now = Instant::now();
        let stalled = s.last_push.map(|t| now.duration_since(t).as_secs_f64() > STALL_SECONDS).unwrap_or(false);
        s.last_push = Some(now);
        if !s.listeners.is_empty() && (stalled || s.since_sync >= SYNC_EVERY_FRAMES) {
            s.since_sync = 0;
            let p = sync_packet(s.pos_ms, s.running, false);
            Self::broadcast(&s, &p);
        }
        s.since_sync += 1;
        let samples: Vec<i16> = pcm.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
        let mut out = [0u8; 4000];
        let n = match s.enc.as_mut().map(|e| e.encode(&samples, &mut out)) {
            Some(Ok(n)) => n,
            Some(Err(e)) => {
                eprintln!("[quic {}] opus encode failed: {e}", s.code);
                return;
            }
            None => return,
        };
        if s.running && !silence {
            s.pos_ms += PCM_FRAME_SAMPLES as f64 * 1000.0 / PCM_RATE as f64;
        }
        s.bytes_out += n as u64;
        if !s.listeners.is_empty() {
            let mut v = Vec::with_capacity(n + 3);
            v.extend_from_slice(&((n + 1) as u16).to_be_bytes());
            v.push(0);
            v.extend_from_slice(&out[..n]);
            let framed = Bytes::from(v);
            Self::broadcast(&s, &framed);
        }
    }

    pub fn close(&self) {
        let mut s = self.s.lock();
        for l in s.listeners.drain(..) {
            l.close();
        }
        s.ok = false;
    }
}

// ───────────────────────── PCM cache ─────────────────────────

/// One track's raw PCM, downloaded from NodeLink at position 0 and kept in
/// memory so the relay can seek by BYTE OFFSET (sample-exact: s16le/48kHz/stereo
/// is a fixed 192000 bytes/s).
pub struct PcmCache {
    pub key: Option<String>,
    pub encoded: Option<String>,
    pub buf: RwLock<Vec<u8>>,
    /// NodeLink stream ended cleanly: buf is the whole track
    done: AtomicBool,
    /// connection died before done: buf is partial
    failed: AtomicBool,
    task: Mutex<Option<JoinHandle<()>>>,
    first_byte_at: Mutex<Option<Instant>>,
}

impl PcmCache {
    fn new(key: Option<String>, encoded: Option<String>) -> Arc<Self> {
        Arc::new(Self {
            key,
            encoded,
            buf: RwLock::new(Vec::new()),
            done: AtomicBool::new(false),
            failed: AtomicBool::new(false),
            task: Mutex::new(None),
            first_byte_at: Mutex::new(None),
        })
    }
    pub fn is_done(&self) -> bool {
        self.done.load(Ordering::SeqCst)
    }
    pub fn is_failed(&self) -> bool {
        self.failed.load(Ordering::SeqCst)
    }
    pub fn len(&self) -> usize {
        self.buf.read().len()
    }
    /// `cache.task is not None and cache.task.done()`
    fn task_done(&self) -> bool {
        self.task.lock().as_ref().map(|t| t.is_finished()).unwrap_or(false)
    }
    fn cancel_task(&self) {
        if let Some(t) = self.task.lock().as_ref() {
            if !t.is_finished() {
                t.abort();
            }
        }
    }
    /// Copy of bytes [start, end) (clamped).
    pub fn read_range(&self, start: usize, end: usize) -> Vec<u8> {
        let b = self.buf.read();
        let end = end.min(b.len());
        let start = start.min(end);
        b[start..end].to_vec()
    }
}

struct Preload {
    track: Value,
    cache: Arc<PcmCache>,
}

/// Decode gate: pcm_to_mono needs ~1.5-3x the mono result as scratch, so only one runs at a time.
static DECODE_SEM: Semaphore = Semaphore::const_new(1);

#[derive(PartialEq)]
enum PumpResult {
    Ended,
    Interrupted,
    Error,
}

struct Stats {
    frames_sent: u64,
    pcm_bytes_in: u64,
    pace_drift_ms: VecDeque<f64>,
    sessions_started: u64,
    last_frame_ts: Option<f64>,
}

struct AnalysisSlot {
    id: u64,
    map: Map<String, Value>,
}

struct RState {
    task: Option<JoinHandle<()>>,
    preload: Option<Preload>,
    /// The CURRENT track's full PCM.
    cache: Option<Arc<PcmCache>>,
    idle: bool,
    /// (track, position_ms) waiting to resume with
    pending: Option<(Option<Value>, f64)>,
    pace_next: Option<Instant>,
    stats: Stats,
    debug_subscribers: HashSet<Sid>,
    debug_task_running: bool,
    // audio analysis
    analysis: IndexMap<String, AnalysisSlot>,
    analysis_tasks: HashMap<String, JoinHandle<()>>,
    beats_events: HashMap<String, Arc<Event>>,
    analysis_dl: HashMap<String, Arc<PcmCache>>,
    next_slot_id: u64,
}

pub struct Relay {
    lobby: Weak<LobbyHandle>,
    pub audio_out: Arc<QuicPcmRelay>,
    generation: AtomicU64,
    st: Mutex<RState>,
    resume_event: Event,
    idle_event: Event,
}

/// Where the first-frame clock correction and state broadcasts need the lobby.
fn pos_to_offset(position_ms: f64) -> usize {
    ((position_ms.max(0.0) * PCM_RATE as f64 / 1000.0).round_ties_even() as usize) * (PCM_CHANNELS * 2)
}

impl Relay {
    pub fn new(lobby: Weak<LobbyHandle>, code: String) -> Arc<Self> {
        let r = Arc::new(Relay {
            lobby,
            audio_out: QuicPcmRelay::new(code),
            generation: AtomicU64::new(0),
            st: Mutex::new(RState {
                task: None,
                preload: None,
                cache: None,
                idle: false,
                pending: None,
                pace_next: None,
                stats: Stats {
                    frames_sent: 0,
                    pcm_bytes_in: 0,
                    pace_drift_ms: VecDeque::new(),
                    sessions_started: 0,
                    last_frame_ts: None,
                },
                debug_subscribers: HashSet::new(),
                debug_task_running: false,
                analysis: IndexMap::new(),
                analysis_tasks: HashMap::new(),
                beats_events: HashMap::new(),
                analysis_dl: HashMap::new(),
                next_slot_id: 1,
            }),
            resume_event: Event::new(),
            idle_event: Event::new(),
        });
        r.resume_event.set(); // not paused by default
        r
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    fn lobby(&self) -> Option<Arc<LobbyHandle>> {
        self.lobby.upgrade()
    }

    fn code(&self) -> String {
        self.lobby().map(|l| l.code()).unwrap_or_default()
    }

    // ───────────── audio analysis ─────────────

    /// Start (once per track) the staged audio analysis of `track`'s PCM. `cache`
    /// is its PcmCache, or None if the track isn't cacheable.
    pub fn ensure_analysis(self: &Arc<Self>, track: Option<&Value>, cache: Option<Arc<PcmCache>>) {
        let Some(key) = track.and_then(track_encoded).filter(|k| !k.is_empty()).map(|k| k.to_string()) else {
            return;
        };
        {
            let mut st = self.st.lock();
            if let Some(old) = st.analysis.get(&key) {
                // An unfinished analysis still waiting on a download that was
                // cancelled / failed is doomed: replace it with one bound to the live cache.
                let dead = st.analysis_dl.get(&key);
                let complete = old.map.get("complete").map(truthy).unwrap_or(false);
                let stale = !complete
                    && match (dead, &cache) {
                        (Some(d), Some(c)) => {
                            !Arc::ptr_eq(d, c) && !d.is_done() && (d.is_failed() || d.task_done())
                        }
                        _ => false,
                    };
                if !stale {
                    return;
                }
                if let Some(t) = st.analysis_tasks.remove(&key) {
                    if !t.is_finished() {
                        t.abort();
                    }
                }
                st.analysis.shift_remove(&key);
                st.analysis_dl.remove(&key);
            }
            let id = st.next_slot_id;
            st.next_slot_id += 1;
            if !config::AUDIO_ANALYSIS_ENABLED {
                st.analysis.insert(
                    key,
                    AnalysisSlot {
                        id,
                        map: obj(json!({"status": "disabled", "complete": true,
                            "reason": "audio analysis is turned off (AUDIO_ANALYSIS_ENABLED = false in config.rs)"})),
                    },
                );
                return;
            }
            let Some(cache) = cache else {
                st.analysis.insert(
                    key,
                    AnalysisSlot {
                        id,
                        map: obj(json!({"status": "unsupported", "complete": true,
                            "reason": "live streams and very long tracks are not analysed"})),
                    },
                );
                return;
            };
            st.analysis.insert(
                key.clone(),
                AnalysisSlot {
                    id,
                    map: obj(json!({"status": "pending", "phase": "download", "complete": false,
                        "stages": {}, "timings": {}})),
                },
            );
            let ev = Arc::new(Event::new());
            st.beats_events.insert(key.clone(), ev.clone());
            st.analysis_dl.insert(key.clone(), cache.clone());
            let me = self.clone();
            let k2 = key.clone();
            let h = tokio::spawn(async move { me.run_analysis(k2, id, cache, ev).await });
            st.analysis_tasks.insert(key, h);
        }
        self.prune_analyses();
    }

    /// Cancel analyses of tracks that are neither playing nor next up.
    fn prune_analyses(&self) {
        let cur = self
            .lobby()
            .and_then(|l| l.st.lock().current_track.as_ref().and_then(|t| track_encoded(t).map(|s| s.to_string())))
            .filter(|s| !s.is_empty());
        let st = self.st.lock();
        let mut keep: HashSet<Option<String>> = HashSet::new();
        if let Some(c) = &st.cache {
            keep.insert(c.key.clone());
        }
        if let Some(p) = &st.preload {
            keep.insert(track_encoded(&p.track).map(|s| s.to_string()));
        }
        if let Some(c) = cur {
            keep.insert(Some(c));
        }
        for (k, t) in st.analysis_tasks.iter() {
            if !keep.contains(&Some(k.clone())) && !t.is_finished() {
                t.abort();
            }
        }
    }

    /// Record a finished stage and push it to the lobby over the socket.
    async fn publish(&self, key: &str, stage: &str, data: Option<Value>, timing: Option<Value>, extra: Vec<(String, Value)>) {
        let payload = {
            let mut st = self.st.lock();
            let Some(slot) = st.analysis.get_mut(key) else { return };
            let e = &mut slot.map;
            if data.is_some() || matches!(stage, "meter" | "key" | "sections") {
                if let Some(Value::Object(stages)) = e.get_mut("stages") {
                    stages.insert(stage.to_string(), data.clone().unwrap_or(Value::Null));
                }
            }
            if let Some(t) = &timing {
                if let Some(Value::Object(tm)) = e.get_mut("timings") {
                    tm.insert(stage.to_string(), t.clone());
                }
            }
            for (k, v) in extra {
                e.insert(k, v);
            }
            json!({
                "encoded": key, "stage": stage, "data": data.unwrap_or(Value::Null), "timing": timing.unwrap_or(Value::Null),
                "status": e.get("status").cloned().unwrap_or(Value::Null),
                "phase": e.get("phase").cloned().unwrap_or(Value::Null),
                "complete": e.get("complete").cloned().unwrap_or(Value::Bool(false)),
                "reason": e.get("reason").cloned().unwrap_or(Value::Null),
            })
        };
        sio::broadcast(&self.code(), "analysis", payload).await;
    }

    fn update_entry(&self, key: &str, kv: Vec<(&str, Value)>) {
        if let Some(slot) = self.st.lock().analysis.get_mut(key) {
            for (k, v) in kv {
                slot.map.insert(k.to_string(), v);
            }
        }
    }

    /// Run one analysis stage in the worker pool. Returns (result, timing).
    async fn job<T, F>(&self, name: &str, t0: Instant, f: F) -> Result<(T, Value), String>
    where
        T: StageInfo + Send + 'static,
        F: Fn() -> T + Send + Sync + 'static,
    {
        let f = Arc::new(f);
        let submitted = Instant::now();
        let mut res: Option<T> = None;
        let mut last_err: Option<String> = None;
        for _attempt in 0..3 {
            let pool = pool::get_pool()?;
            let f2 = f.clone();
            let r = match &pool {
                Some(p) => p.run(move || f2()).await,
                None => tokio::task::spawn_blocking(move || f2()).await.map_err(|e| e.to_string()),
            };
            match r {
                Ok(v) => {
                    res = Some(v);
                    break;
                }
                Err(e) => {
                    if pool.is_none() {
                        return Err(format!("RuntimeError: {e}"));
                    }
                    // A worker died. Replace the pool and retry; after two deaths give up.
                    pool::reset_pool(pool.as_ref());
                    eprintln!(
                        "[analysis] worker died during '{name}' ({e}); {}",
                        if pool::broken() < 2 { "retrying with a fresh pool" } else { "giving up on analysis until restart" }
                    );
                    last_err = Some(e);
                }
            }
        }
        let done = Instant::now();
        let Some(res) = res else {
            return Err(format!("RuntimeError: analysis worker kept crashing ({})", last_err.unwrap_or_default()));
        };
        let wall = done.duration_since(submitted).as_secs_f64();
        let timing = json!({
            "sec": jf(py_round(res.sec().unwrap_or(wall), 3)),
            "steps": res.steps(),
            "startedAt": jf(py_round(submitted.duration_since(t0).as_secs_f64(), 2)),
            "doneAt": jf(py_round(done.duration_since(t0).as_secs_f64(), 2)),
            "wall": jf(py_round(wall, 2)),
        });
        Ok((res, timing))
    }

    async fn run_analysis(self: Arc<Self>, key: String, id: u64, cache: Arc<PcmCache>, ev: Arc<Event>) {
        let t0 = Instant::now();
        // Cleanup that Python ran in `except CancelledError` / `finally`; as a drop
        // guard it also runs when the task is aborted.
        struct Cleanup {
            relay: Arc<Relay>,
            key: String,
            id: u64,
            ev: Arc<Event>,
            cache: Option<Arc<PcmCache>>,
            cancelled: bool,
            task_id: Option<tokio::task::Id>,
        }
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let mut st = self.relay.st.lock();
                if self.cancelled && st.analysis.get(&self.key).map(|s| s.id) == Some(self.id) {
                    st.analysis.shift_remove(&self.key);
                }
                self.ev.set(); // never leave playback waiting on a dead analysis
                if st.analysis_tasks.get(&self.key).map(|h| h.id()) == self.task_id && self.task_id.is_some() {
                    st.analysis_tasks.remove(&self.key);
                }
                if let Some(c) = &self.cache {
                    if st.analysis_dl.get(&self.key).map(|d| Arc::ptr_eq(d, c)).unwrap_or(false) {
                        st.analysis_dl.remove(&self.key);
                    }
                }
                // Bound memory: drop the oldest finished entries.
                let done: Vec<String> = st
                    .analysis
                    .iter()
                    .filter(|(_, v)| v.map.get("complete").map(truthy).unwrap_or(false))
                    .map(|(k, _)| k.clone())
                    .collect();
                let excess = done.len().saturating_sub(ANALYSIS_KEEP);
                for k in done.into_iter().take(excess) {
                    st.analysis.shift_remove(&k);
                    st.beats_events.remove(&k);
                }
                drop(st);
                if config::AUDIO_ANALYSIS_TRIM_SERVER {
                    if let Ok(h) = tokio::runtime::Handle::try_current() {
                        h.spawn_blocking(pool::trim_memory);
                    }
                }
            }
        }
        let mut guard = Cleanup {
            relay: self.clone(),
            key: key.clone(),
            id,
            ev: ev.clone(),
            cache: Some(cache.clone()),
            cancelled: true,
            task_id: tokio::task::try_id(),
        };
        drop(cache);

        let outcome = self.analysis_body(&key, &mut guard.cache, t0, &ev).await;
        match outcome {
            Ok(Flow::Finished) => {
                guard.cancelled = false;
            }
            Ok(Flow::DropEntry) => {
                // download died / was cancelled: forget it so a later play can try again
                guard.cancelled = true;
            }
            Err(e) => {
                guard.cancelled = false;
                eprintln!("[analysis {key}] failed: {e}");
                let exists = self.st.lock().analysis.contains_key(&key);
                if exists {
                    self.update_entry(&key, vec![("status", json!("error")), ("complete", json!(true)), ("phase", json!("done")), ("reason", json!(e))]);
                    self.publish(&key, "error", None, None, vec![]).await;
                }
            }
        }
    }

    async fn analysis_body(&self, key: &str, cache_slot: &mut Option<Arc<PcmCache>>, t0: Instant, ev: &Arc<Event>) -> Result<Flow, String> {
        // ---- download (the relay's own PCM cache; shared with playback)
        let cache = cache_slot.clone().ok_or("no cache")?;
        while !cache.is_done() {
            if cache.is_failed() || cache.task_done() {
                return Ok(Flow::DropEntry);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        {
            let mut st = self.st.lock();
            if st.analysis_dl.get(key).map(|d| Arc::ptr_eq(d, &cache)).unwrap_or(false) {
                st.analysis_dl.remove(key); // downloaded: stop referencing the PCM
            }
        }
        let dl = py_round(t0.elapsed().as_secs_f64(), 2);
        self.publish(
            key,
            "download",
            None,
            Some(json!({"sec": jf(dl), "steps": [], "startedAt": 0, "doneAt": jf(dl), "wall": jf(dl)})),
            vec![("phase".into(), json!("decode"))],
        )
        .await;

        // ---- decode: 48k stereo s16 -> 22.05k mono float
        let permit = DECODE_SEM.acquire().await.map_err(|e| e.to_string())?;
        let td = Instant::now();
        let c2 = cache.clone();
        let mono = tokio::task::spawn_blocking(move || {
            let total = c2.len();
            analysis::pcm_to_mono(total, &|a, b| c2.read_range(a, b))
        })
        .await
        .map_err(|e| format!("RuntimeError: {e}"))?;
        drop(permit);
        *cache_slot = None; // don't pin the track's PCM for the rest of the analysis
        drop(cache);
        let ds = py_round(td.elapsed().as_secs_f64(), 3);
        self.publish(
            key,
            "decode",
            None,
            Some(json!({"sec": jf(ds), "steps": [{"name": "resample to 22.05 kHz mono", "sec": jf(ds)}],
                "startedAt": jf(py_round(td.duration_since(t0).as_secs_f64(), 2)),
                "doneAt": jf(py_round(t0.elapsed().as_secs_f64(), 2)), "wall": jf(ds)})),
            vec![("phase".into(), json!("beats"))],
        )
        .await;

        // ---- 1. beats + tempo: the only stage playback waits for
        let mono = Arc::new(mono);
        let m2 = mono.clone();
        let (res, tm) = self.job("beats", t0, move || analysis::stage_beats(&m2)).await?;
        let (state, bdata) = match res {
            BeatsOut::Error(msg) => {
                self.update_entry(key, vec![("status", json!("error")), ("complete", json!(true)), ("reason", json!(msg)), ("phase", json!("done"))]);
                self.publish(key, "beats", None, Some(tm), vec![]).await;
                return Ok(Flow::Finished);
            }
            BeatsOut::Ok { state, data, .. } => (Arc::new(state), data),
        };
        let duration = bdata.get("durationSec").cloned().unwrap_or(Value::Null);
        let dur_f = duration.as_f64().unwrap_or(0.0);
        self.update_entry(key, vec![("status", json!("ready")), ("phase", json!("refine")), ("durationSec", duration)]);
        self.publish(key, "beats", Some(bdata.clone()), Some(tm), vec![]).await;
        ev.set();

        let mut beats: Vec<f64> = bdata
            .get("beats")
            .and_then(|b| b.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_f64()).collect())
            .unwrap_or_default();

        // The key stages only read a centred excerpt (240 s / 60 s).
        let kq = Arc::new(analysis::key_excerpt(&mono, false));
        let kr = Arc::new(analysis::key_excerpt(&mono, true));
        drop(mono);
        let tuning = state.tuning;

        // ---- 2. tempo sections || quick key (parallel workers)
        let sections_stage = async {
            if beats.is_empty() {
                return Ok::<Option<(analysis::StageOut, Value)>, String>(None);
            }
            let st2 = state.clone();
            let r = self.job("sections", t0, move || analysis::stage_sections(&st2, dur_f)).await?;
            Ok(Some(r))
        };
        let key_stage = async {
            let kq2 = kq.clone();
            let (r, t) = self.job("key", t0, move || analysis::stage_key(&kq2, tuning, false)).await?;
            self.publish(key, "key", Some(r.data.clone()), Some(t), vec![]).await;
            Ok::<(), String>(())
        };
        let (sec_res, key_res) = tokio::join!(sections_stage, key_stage);
        let sec_out = match sec_res {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[analysis {key}] sections failed: {e}");
                self.publish(key, "sections", None, None, vec![("sectionsError".into(), json!(e))]).await;
                None
            }
        };
        if let Err(e) = key_res {
            eprintln!("[analysis {key}] key failed: {e}");
            self.publish(key, "key", None, None, vec![("keyError".into(), json!(e))]).await;
        }
        let mut sections: Option<Vec<Value>> = None;
        if let Some((sres, st)) = sec_out {
            let sd = sres.data.clone();
            sections = sd.get("sections").and_then(|s| s.as_array()).cloned();
            self.publish(key, "sections", Some(sd.clone()), Some(st), vec![]).await;
            if sd.get("changed").map(truthy).unwrap_or(false) {
                beats = sd.get("beats").and_then(|b| b.as_array()).map(|a| a.iter().filter_map(|v| v.as_f64()).collect()).unwrap_or_default();
            }
        }

        // ---- 3. meter on the final beat grid  ||  4. refined key (HPSS, slow)
        let meter_stage = async {
            if beats.is_empty() {
                self.publish(key, "meter", None, None, vec![]).await;
                return Ok::<(), String>(());
            }
            let st2 = state.clone();
            let b2 = beats.clone();
            let s2 = sections.clone();
            let (r, t) = self.job("meter", t0, move || analysis::stage_meter(&st2, &b2, s2.as_deref())).await?;
            self.publish(key, "meter", Some(r.data.clone()), Some(t), vec![]).await;
            Ok(())
        };
        let key_refine_stage = async {
            let kr2 = kr.clone();
            let (r, t) = self.job("key-refine", t0, move || analysis::stage_key(&kr2, tuning, true)).await?;
            if truthy(&r.data) {
                self.publish(key, "key", Some(r.data.clone()), None, vec![]).await;
            }
            let exists = {
                let mut st = self.st.lock();
                if let Some(slot) = st.analysis.get_mut(key) {
                    if let Some(Value::Object(tm)) = slot.map.get_mut("timings") {
                        tm.insert("key-refine".into(), t.clone());
                    }
                    true
                } else {
                    false
                }
            };
            if exists {
                self.publish(key, "key-refine", None, Some(t), vec![]).await;
            }
            Ok::<(), String>(())
        };
        let (m_res, k_res) = tokio::join!(meter_stage, key_refine_stage);
        if let Err(e) = m_res {
            eprintln!("[analysis {key}] meter failed: {e}");
            self.publish(key, "meter", None, None, vec![("meterError".into(), json!(e))]).await;
        }
        if let Err(e) = k_res {
            eprintln!("[analysis {key}] key-refine failed: {e}");
            self.publish(key, "key-refine", None, None, vec![("key-refineError".into(), json!(e))]).await;
        }

        let total = py_round(t0.elapsed().as_secs_f64(), 2);
        self.publish(
            key,
            "done",
            None,
            None,
            vec![("complete".into(), json!(true)), ("phase".into(), json!("done")), ("totalSec".into(), jf(total))],
        )
        .await;
        Ok(Flow::Finished)
    }

    /// Hold playback until the BPM/beat stage of `track` is done (bounded, and
    /// abandoned if the session moves on).
    async fn wait_for_beats(&self, track: &Value, my_generation: u64) {
        if !config::AUDIO_ANALYSIS_GATE_PLAYBACK {
            return;
        }
        let Some(key) = track_encoded(track) else { return };
        let ev = self.st.lock().beats_events.get(key).cloned();
        let Some(ev) = ev else { return };
        if ev.is_set() {
            return;
        }
        let limit = config::AUDIO_ANALYSIS_GATE_SECONDS;
        let t0 = Instant::now();
        while t0.elapsed().as_secs_f64() < limit {
            if self.generation() != my_generation {
                return;
            }
            if ev.wait_timeout(Duration::from_millis(250)).await {
                return;
            }
        }
        println!("[relay {}] BPM analysis not ready after {:.0}s — playing anyway", self.code(), limit);
    }

    /// Snapshot of everything computed so far (for a client that just joined /
    /// changed track; live updates come over the `analysis` socket event).
    pub fn analysis_for(&self, track: &Value) -> Value {
        let key = track_encoded(track).map(|s| s.to_string());
        let st = self.st.lock();
        match key.as_ref().and_then(|k| st.analysis.get(k)) {
            None => json!({"status": "none", "encoded": key}),
            Some(slot) => {
                let mut m = slot.map.clone();
                m.insert("encoded".into(), json!(key));
                Value::Object(m)
            }
        }
    }

    fn cancel_analyses(&self) {
        let mut st = self.st.lock();
        for (_, t) in st.analysis_tasks.iter() {
            if !t.is_finished() {
                t.abort();
            }
        }
        st.analysis_tasks.clear();
    }

    // ───────────── debug ─────────────

    fn cache_progress(&self, cache: &PcmCache, track: Option<&Value>) -> Value {
        let info = track.and_then(track_info);
        let g = |k: &str| info.and_then(|i| i.get(k)).filter(|v| truthy(v)).cloned();
        let got = cache.len();
        let length = g("length").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let total = pos_to_offset(length);
        let percent: Option<f64> = if cache.is_done() {
            Some(100.0)
        } else if total > 0 {
            Some((got as f64 * 100.0 / total as f64).min(99.9))
        } else {
            None
        };
        json!({
            "title": g("title").unwrap_or(json!("")),
            "author": g("author").unwrap_or(json!("")),
            "bytes": got,
            "totalBytes": total,
            "percent": percent.map(|p| jf(py_round(p, 1))).unwrap_or(Value::Null),
            "done": cache.is_done(),
            "failed": cache.is_failed() && !cache.is_done(),
        })
    }

    /// Read-only stats snapshot for the client Debug tab.
    pub fn debug_snapshot(&self) -> Value {
        let lobby = self.lobby();
        // lobby data first (never hold both locks at once)
        let (cur_track, participants, queue_len, paused, pos_ms, auto_count, auto_list, hist_count, hist_list) = match &lobby {
            Some(l) => {
                let g = l.st.lock();
                (
                    g.current_track.clone(),
                    g.participants.len(),
                    g.queue.len(),
                    g.paused,
                    g.current_position_ms(),
                    g.auto_queue.len(),
                    g.auto_queue.iter().take(DEBUG_LIST_CAP).map(track_brief).collect::<Vec<_>>(),
                    g.history.len(),
                    g.history.iter().rev().take(DEBUG_LIST_CAP).map(track_brief).collect::<Vec<_>>(),
                )
            }
            None => (None, 0, 0, true, 0.0, 0, vec![], 0, vec![]),
        };
        let st = self.st.lock();
        let drift: Vec<f64> = st.stats.pace_drift_ms.iter().copied().collect();
        let avg = if drift.is_empty() { Value::Null } else { jf(py_round(drift.iter().sum::<f64>() / drift.len() as f64, 3)) };
        let preload = st.preload.as_ref().map(|p| self.cache_progress(&p.cache, Some(&p.track)));
        let current = st.cache.as_ref().map(|c| {
            let track = cur_track.as_ref().filter(|t| track_encoded(t).map(|e| e.to_string()) == c.key);
            self.cache_progress(c, track)
        });
        json!({
            "generation": self.generation(),
            "idle": st.idle,
            "listeners": self.audio_out.listener_count(),
            "hasPreload": st.preload.is_some(),
            "preload": preload.unwrap_or(Value::Null),
            "current": current.unwrap_or(Value::Null),
            "seekCacheBytes": st.cache.as_ref().map(|c| c.len()).unwrap_or(0),
            "framesSent": st.stats.frames_sent,
            "pcmBytesIn": st.stats.pcm_bytes_in,
            "wireBytesOut": self.audio_out.bytes_out(),
            "paceDriftMsAvg": avg,
            "paceDriftMsMax": if drift.is_empty() { Value::Null } else { jf(py_round(drift.iter().cloned().fold(f64::MIN, f64::max), 3)) },
            "sessionsStarted": st.stats.sessions_started,
            "lastFrameAgeMs": st.stats.last_frame_ts.map(|t| jf(py_round((now_secs() - t) * 1000.0, 1))).unwrap_or(Value::Null),
            "participants": participants,
            "queueLength": queue_len,
            "paused": paused,
            "positionMs": jf(pos_ms),
            "autoQueueCount": auto_count,
            "autoQueue": auto_list,
            "historyCount": hist_count,
            "history": hist_list,
        })
    }

    pub fn debug_subscribe(self: &Arc<Self>, sid: Sid) {
        let mut st = self.st.lock();
        st.debug_subscribers.insert(sid);
        if !st.debug_task_running {
            st.debug_task_running = true;
            let me = self.clone();
            tokio::spawn(async move { me.debug_push_loop().await });
        }
    }

    pub fn debug_unsubscribe(&self, sid: Sid) {
        // The push task checks the subscriber set each cycle and exits once it's empty.
        self.st.lock().debug_subscribers.remove(&sid);
    }

    async fn debug_push_loop(self: Arc<Self>) {
        struct Reset(Arc<Relay>);
        impl Drop for Reset {
            fn drop(&mut self) {
                self.0.st.lock().debug_task_running = false;
            }
        }
        let _reset = Reset(self.clone());
        loop {
            let subs: Vec<Sid> = self.st.lock().debug_subscribers.iter().copied().collect();
            if subs.is_empty() {
                break;
            }
            let snap = self.debug_snapshot();
            for sid in subs {
                if !sio::emit_to_sid(sid, "debug_stats", snap.clone()).await {
                    self.st.lock().debug_subscribers.remove(&sid);
                }
            }
            tokio::time::sleep(Duration::from_millis(1500)).await;
        }
    }

    // ───────────── gapless preload ─────────────

    /// Call whenever the queue changes, a track starts, or the host flips the
    /// Gapless toggle, so the prefetch always targets whatever will actually play next.
    pub fn ensure_preload(self: &Arc<Self>) {
        let Some(lobby) = self.lobby() else { return };
        let (gapless, next_track) = {
            let l = lobby.st.lock();
            (l.gapless, l.peek_next_track())
        };
        if !gapless {
            self.cancel_preload();
            return;
        }
        let want_id = next_track.as_ref().and_then(|t| track_encoded(t).map(|s| s.to_string()));
        let have_id = self.st.lock().preload.as_ref().map(|p| track_encoded(&p.track).map(|s| s.to_string()));
        if let Some(h) = have_id {
            if want_id == h {
                return;
            }
        } else if want_id.is_none() {
            return;
        }
        self.cancel_preload();
        let Some(next_track) = next_track else { return };
        let enc = track_encoded(&next_track).map(|s| s.to_string());
        let cache = PcmCache::new(enc.clone(), enc);
        let me = self.clone();
        let c2 = cache.clone();
        let h = tokio::spawn(async move { me.fill_cache(c2).await });
        *cache.task.lock() = Some(h);
        self.st.lock().preload = Some(Preload { track: next_track.clone(), cache: cache.clone() });
        if self.cacheable(&next_track) {
            self.ensure_analysis(Some(&next_track), Some(cache)); // analyse ahead of time
        }
    }

    fn cancel_preload(&self) {
        {
            let mut st = self.st.lock();
            if let Some(p) = &st.preload {
                p.cache.cancel_task();
            }
            st.preload = None;
        }
        self.prune_analyses();
    }

    // ───────────── seek cache ─────────────

    fn cacheable(&self, track: &Value) -> bool {
        if !config::SEEK_CACHE_ENABLED {
            return false;
        }
        let info = track_info(track);
        if info.and_then(|i| i.get("isStream")).map(truthy).unwrap_or(false) {
            return false;
        }
        match info.and_then(|i| i.get("length")) {
            Some(Value::Number(n)) if !n.is_u64() || true => {
                let l = n.as_f64().unwrap_or(0.0);
                l > 0.0 && l <= config::SEEK_CACHE_MAX_SECONDS * 1000.0
            }
            _ => false,
        }
    }

    fn cancel_cache(&self) {
        let mut st = self.st.lock();
        if let Some(c) = &st.cache {
            c.cancel_task();
        }
        st.cache = None;
    }

    fn set_cache(&self, cache: Arc<PcmCache>) {
        let same = self.st.lock().cache.as_ref().map(|c| Arc::ptr_eq(c, &cache)).unwrap_or(false);
        if !same {
            self.cancel_cache();
        }
        self.st.lock().cache = Some(cache);
    }

    /// The cache for `track`, starting its download if needed. None if this
    /// track can't/shouldn't be cached.
    fn acquire_cache(self: &Arc<Self>, track: &Value) -> Option<Arc<PcmCache>> {
        if !self.cacheable(track) {
            self.cancel_cache();
            return None;
        }
        let key = track_encoded(track).map(|s| s.to_string());
        {
            let st = self.st.lock();
            if let Some(c) = &st.cache {
                if c.key == key && !(c.is_failed() && !c.is_done()) {
                    return Some(c.clone());
                }
            }
        }
        self.cancel_cache();
        let c = PcmCache::new(key.clone(), key);
        let me = self.clone();
        let c2 = c.clone();
        let h = tokio::spawn(async move { me.fill_cache(c2).await });
        *c.task.lock() = Some(h);
        self.st.lock().cache = Some(c.clone());
        Some(c)
    }

    /// Background task: pull the whole track from NodeLink at position 0 (NOT
    /// the seek target) into cache.buf as fast as NodeLink sends it.
    async fn fill_cache(self: Arc<Self>, cache: Arc<PcmCache>) {
        let body = json!({"encodedTrack": cache.encoded, "position": 0});
        let r = match nodelink::request("POST", "/v4/loadstream", &[], Some(&body), true).await {
            Ok(r) => r,
            Err(_) => {
                cache.failed.store(true, Ordering::SeqCst); // best-effort: _pump_track falls back / retries
                return;
            }
        };
        if r.status().as_u16() != 200 {
            let txt = r.text().await.unwrap_or_default();
            println!("[relay {}] NodeLink loadstream {} (seek cache): {}", self.code(), "non-200", txt);
            cache.failed.store(true, Ordering::SeqCst);
            return;
        }
        let mut stream = Box::pin(nodelink::chunked(r.bytes_stream(), 65536));
        while let Some(item) = stream.next().await {
            match item {
                Ok(chunk) => {
                    {
                        let mut fb = cache.first_byte_at.lock();
                        if fb.is_none() {
                            *fb = Some(Instant::now());
                        }
                    }
                    cache.buf.write().extend_from_slice(&chunk);
                }
                Err(_) => {
                    cache.failed.store(true, Ordering::SeqCst);
                    return;
                }
            }
        }
        cache.done.store(true, Ordering::SeqCst);
    }

    /// Wait until the cache reaches byte `need`. True = go ahead and play from
    /// the cache. False = it can't get there quickly enough (or the download
    /// failed) — play live from NodeLink instead.
    async fn cache_wait(&self, cache: &PcmCache, need: usize, my_generation: u64) -> bool {
        let limit = config::SEEK_CACHE_WAIT_SECONDS;
        let t0 = Instant::now();
        loop {
            let have = cache.len();
            if have >= need || cache.is_done() {
                return true; // (done + need past the end = seeking past the end -> track just ends)
            }
            if self.generation() != my_generation {
                return true; // caller notices and stops
            }
            if cache.is_failed() {
                return false;
            }
            let now = Instant::now();
            let waited = now.duration_since(t0).as_secs_f64();
            if have == 0 {
                // Nothing yet — a live fetch would be just as slow, so keep waiting.
                if waited > 45.0 {
                    return false;
                }
            } else {
                if waited > limit * 3.0 {
                    return false;
                }
                let first = cache.first_byte_at.lock().unwrap_or(now);
                let flowing = now.duration_since(first).as_secs_f64();
                if flowing >= 1.0 {
                    let rate = have as f64 / flowing; // bytes/s NodeLink is actually delivering
                    if (need - have) as f64 / rate.max(1.0) > limit {
                        return false;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    // ───────────── session control ─────────────

    /// (Re)start the pipeline for `track` at `position_ms`. Bumps `generation`.
    pub fn start_track(self: &Arc<Self>, track: Option<Value>, position_ms: f64) {
        self.cancel_task();
        self.cancel_preload();
        {
            let mut st = self.st.lock();
            st.idle = false;
            st.pending = None;
            st.pace_next = None;
        }
        self.idle_event.clear();
        let gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        // A seek while PAUSED must stay paused.
        let paused = self.lobby().map(|l| l.st.lock().paused).unwrap_or(false);
        if paused {
            self.resume_event.clear();
        } else {
            self.resume_event.set();
        }
        // Hard cut: every listener discards whatever it has buffered.
        self.audio_out.set_timeline(if track.is_some() { position_ms } else { 0.0 }, false, true);
        let Some(track) = track else { return };
        let me = self.clone();
        let h = tokio::spawn(async move { me.run(track, position_ms, gen).await });
        self.st.lock().task = Some(h);
    }

    pub fn reseek(self: &Arc<Self>, position_ms: f64) {
        let track = self.lobby().and_then(|l| l.st.lock().current_track.clone());
        let Some(t) = track else { return };
        self.start_track(Some(t), position_ms);
    }

    /// Cheap path back from silence: if the pipeline is still alive and sitting
    /// in the idle wait, hand it this track and wake it up.
    pub fn resume_or_start(self: &Arc<Self>, track: Option<Value>, position_ms: f64) {
        let alive_idle = {
            let st = self.st.lock();
            st.task.as_ref().map(|t| !t.is_finished()).unwrap_or(false) && st.idle
        };
        if alive_idle {
            let paused = self.lobby().map(|l| l.st.lock().paused).unwrap_or(false);
            if paused {
                self.resume_event.clear();
            } else {
                self.resume_event.set();
            }
            {
                let mut st = self.st.lock();
                st.pending = Some((track, position_ms));
                st.idle = false;
            }
            self.idle_event.set();
            return;
        }
        self.start_track(track, position_ms);
    }

    pub fn set_paused(&self, paused: bool) {
        // Freezes the relay's own real-time pacing loop in place.
        if paused {
            self.resume_event.clear();
        } else {
            self.resume_event.set();
        }
    }

    /// Server-side pause: while paused the relay keeps the SAME stream flowing —
    /// real-time silence, timeline frozen. Returns once resumed.
    async fn gate(&self) {
        if self.resume_event.is_set() {
            return;
        }
        let ao = &self.audio_out;
        ao.set_timeline(ao.pos_ms(), false, false);
        while !self.resume_event.is_set() {
            if !self.resume_event.wait_timeout(Duration::from_millis(20)).await {
                self.feed_silence();
            }
        }
        ao.set_timeline(ao.pos_ms(), true, false);
        // Keep the lobby's own clock exactly on the stream position.
        if let Some(l) = self.lobby() {
            let mut g = l.st.lock();
            g.position_anchor_ms = ao.pos_ms();
            g.anchor_time = now_secs();
        }
    }

    fn cancel_task(&self) {
        if let Some(t) = self.st.lock().task.take() {
            if !t.is_finished() {
                t.abort();
            }
        }
    }

    /// Cancel the pipeline task without tearing down the relay output itself.
    pub fn stop(&self) {
        self.cancel_task();
        self.cancel_preload();
        self.cancel_cache();
        self.prune_analyses();
        {
            let mut st = self.st.lock();
            st.idle = false;
            st.pending = None;
        }
        self.idle_event.clear();
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.audio_out.set_timeline(0.0, false, true);
    }

    /// Full teardown — called once, when the lobby's last participant leaves.
    pub async fn shutdown(&self) {
        self.stop();
        self.cancel_analyses();
        self.audio_out.close();
    }

    // ───────────── the actual pipeline ─────────────

    async fn run(self: Arc<Self>, track: Value, position_ms: f64, my_generation: u64) {
        self.st.lock().stats.sessions_started += 1;
        let mut cur_track = track;
        let mut cur_pos = position_ms;
        let mut retry_count = 0u32;
        loop {
            if self.generation() != my_generation {
                return;
            }
            self.st.lock().idle = false;

            let result = self.pump_track(&cur_track, cur_pos, my_generation).await;
            if self.generation() != my_generation {
                return;
            }
            if result == PumpResult::Interrupted {
                return; // something else already changed the session
            }

            if result == PumpResult::Error {
                // The NodeLink connection dropped or timed out mid-track:
                // reconnect at the current position.
                retry_count += 1;
                if retry_count > 5 {
                    if let Some(lobby) = self.lobby() {
                        let code = lobby.code();
                        sio::broadcast(
                            &code,
                            "chat",
                            json!({"system": true, "text": "Playback connection kept failing — try skipping or replaying the track.", "ts": now_ms()}),
                        )
                        .await;
                        lobby.st.lock().paused = true;
                        sio::broadcast(&code, "state", lobby.public_state()).await;
                    }
                    return;
                }
                println!("[relay {}] stream error, reconnecting (attempt {})", self.code(), retry_count);
                tokio::time::sleep(Duration::from_secs_f64((0.5 * retry_count as f64).min(3.0))).await;
                if self.generation() != my_generation {
                    return;
                }
                cur_pos = self.lobby().map(|l| l.st.lock().current_position_ms()).unwrap_or(0.0);
                continue; // retry the SAME track from the recovered position
            }

            retry_count = 0; // that track segment streamed cleanly
            let nxt = self.advance_for_gapless(my_generation).await;
            if self.generation() != my_generation {
                return;
            }
            if let Some(n) = nxt {
                cur_track = n;
                cur_pos = 0.0;
                continue;
            }

            // Queue (and autoplay) are genuinely empty. Stay right here: the task
            // stays alive, the relay keeps flowing, nobody reconnects.
            self.audio_out.set_timeline(0.0, false, false); // nothing playing: timeline frozen while silence keeps flowing
            self.st.lock().idle = true;
            self.cancel_preload(); // nothing to predict past — re-established on resume
            self.idle_event.clear();
            loop {
                if self.generation() != my_generation {
                    return;
                }
                if self.idle_event.wait_timeout(Duration::from_secs_f64(IDLE_KEEPALIVE_SECONDS)).await {
                    break; // woken by resume_or_start with a real track queued in `pending`
                }
                if self.generation() != my_generation {
                    return;
                }
                self.feed_silence();
            }
            if self.generation() != my_generation {
                return;
            }
            let pending = self.st.lock().pending.take();
            match pending {
                Some((Some(t), p)) => {
                    cur_track = t;
                    cur_pos = p;
                }
                _ => {
                    eprintln!("[relay {}] resumed with no track", self.code());
                    return;
                }
            }
        }
    }

    /// Streams ONE track's PCM into the relay.
    async fn pump_track(self: &Arc<Self>, track: &Value, position_ms: f64, my_generation: u64) -> PumpResult {
        let mut pump = Pump { relay: self, pcm_buf: Vec::new(), anchor_corrected: false, position_ms, my_generation };

        // Where PCM comes from, best first: a running gapless preload of this
        // exact track (position 0 only), the seek cache, or a live fetch.
        let preload_hit = {
            let mut st = self.st.lock();
            let hit = st
                .preload
                .as_ref()
                .map(|p| position_ms == 0.0 && track_encoded(&p.track) == track_encoded(track))
                .unwrap_or(false);
            if hit {
                st.preload.take().map(|p| p.cache)
            } else {
                None
            }
        };
        let cache = if let Some(c) = preload_hit {
            // this track is live now, not "next" anymore
            self.set_cache(c.clone());
            Some(c)
        } else {
            self.acquire_cache(track)
        };
        self.ensure_analysis(Some(track), cache.clone()); // no-op if already analysed / in flight

        // Now that `track`'s own preload has been claimed, it's safe to start
        // prefetching whatever plays AFTER `track`.
        self.ensure_preload();

        if let Some(cache) = cache {
            // BPM first: hold the first frame until beats/tempo are known.
            self.wait_for_beats(track, my_generation).await;
            if self.generation() != my_generation {
                return PumpResult::Interrupted;
            }
            let target = pos_to_offset(position_ms);
            if self.cache_wait(&cache, target + PCM_FRAME_BYTES * 10, my_generation).await {
                let mut off = target;
                loop {
                    if self.generation() != my_generation {
                        return PumpResult::Interrupted;
                    }
                    self.gate().await; // server-side pause: streams silence here, resumes exactly in place
                    if self.generation() != my_generation {
                        return PumpResult::Interrupted;
                    }
                    let have = cache.len();
                    if off < have {
                        let end = (off + 8192).min(have);
                        let chunk = cache.read_range(off, end);
                        off = end;
                        pump.feed_chunk(&chunk).await;
                    } else if cache.is_done() {
                        break;
                    } else if cache.is_failed() {
                        return PumpResult::Error;
                    } else {
                        tokio::time::sleep(Duration::from_millis(20)).await; // download still catching up to real time
                    }
                }
                pump.flush_tail();
                return PumpResult::Ended;
            }
            if self.generation() != my_generation {
                return PumpResult::Interrupted;
            }
            println!(
                "[relay {}] seek to {:.0}ms is past what the cache can reach in time — live fetch fallback",
                self.code(),
                position_ms
            );
        }

        // Live fetch at `position` — the fallback described above.
        let body = json!({"encodedTrack": track.get("encoded").cloned().unwrap_or(Value::Null), "position": position_ms.round_ties_even() as i64});
        let r = match nodelink::request("POST", "/v4/loadstream", &[], Some(&body), true).await {
            Ok(r) => r,
            Err(e) => {
                println!("[relay {}] NodeLink stream dropped: {e:?}", self.code());
                return PumpResult::Error;
            }
        };
        if r.status().as_u16() != 200 {
            let status = r.status().as_u16();
            let txt = r.text().await.unwrap_or_default();
            println!("[relay {}] NodeLink loadstream {}: {}", self.code(), status, txt);
            return PumpResult::Error;
        }
        let mut stream = Box::pin(nodelink::chunked(r.bytes_stream(), 8192));
        while let Some(item) = stream.next().await {
            let chunk = match item {
                Ok(c) => c,
                Err(e) => {
                    println!("[relay {}] NodeLink stream dropped: {e:?}", self.code());
                    return PumpResult::Error;
                }
            };
            if self.generation() != my_generation {
                return PumpResult::Interrupted;
            }
            self.gate().await; // server-side pause
            if self.generation() != my_generation {
                return PumpResult::Interrupted;
            }
            pump.feed_chunk(&chunk).await;
        }
        pump.flush_tail();
        PumpResult::Ended
    }

    /// Enough digital silence to keep the SAME real-time clock feed_chunk uses
    /// caught up to wall time — exactly as much as time has actually elapsed.
    fn feed_silence(&self) {
        let frame_dur = Duration::from_secs_f64(PCM_FRAME_SAMPLES as f64 / PCM_RATE as f64);
        let now = Instant::now();
        let frame_count = {
            let mut st = self.st.lock();
            let mut pn = match st.pace_next {
                Some(p) if now.saturating_duration_since(p) <= frame_dur * 2 => p,
                // No schedule yet, or a gap big enough that catching it up would
                // mean firehosing frames that were never really owed — start fresh.
                _ => now,
            };
            let mut n = 0;
            while pn <= now {
                n += 1;
                pn += frame_dur;
            }
            st.pace_next = Some(pn);
            n
        };
        if frame_count == 0 {
            return;
        }
        let silent = [0u8; PCM_FRAME_BYTES];
        for _ in 0..frame_count {
            self.audio_out.push(&silent, true);
        }
    }

    /// A track's audio source just ended naturally: pop the next one off the
    /// queue, update the lobby's authoritative state and broadcast it — WITHOUT
    /// touching `generation`.
    async fn advance_for_gapless(self: &Arc<Self>, my_generation: u64) -> Option<Value> {
        if self.generation() != my_generation {
            return None;
        }
        let lobby = self.lobby()?;
        let (nxt, code) = {
            let mut l = lobby.st.lock();
            let nxt = l.advance_track(false);
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
            (nxt, l.code.clone())
        };
        sio::broadcast(&code, "state", lobby.public_state()).await;
        if nxt.is_some() {
            // NOTE: deliberately NOT calling ensure_preload() here — see _pump_track.
            populate_recommendations(&lobby, None, true).await;
        }
        nxt
    }
}

enum Flow {
    Finished,
    DropEntry,
}

fn obj(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

/// feed_chunk / flush_tail of one `_pump_track` call.
struct Pump<'a> {
    relay: &'a Arc<Relay>,
    pcm_buf: Vec<u8>,
    anchor_corrected: bool,
    position_ms: f64,
    #[allow(dead_code)]
    my_generation: u64,
}

impl Pump<'_> {
    /// feed_chunk only ever pushes whole PCM_FRAME_BYTES frames, so whatever's
    /// left when the source genuinely ends is padded out with silence here.
    fn flush_tail(&mut self) {
        if self.pcm_buf.is_empty() {
            return;
        }
        let mut frame = std::mem::take(&mut self.pcm_buf);
        frame.resize(PCM_FRAME_BYTES, 0);
        self.relay.audio_out.push(&frame, false);
    }

    async fn feed_chunk(&mut self, chunk: &[u8]) {
        let relay = self.relay;
        self.pcm_buf.extend_from_slice(chunk);
        let frame_dur = Duration::from_secs_f64(PCM_FRAME_SAMPLES as f64 / PCM_RATE as f64);
        while self.pcm_buf.len() >= PCM_FRAME_BYTES {
            let frame: Vec<u8> = self.pcm_buf.drain(..PCM_FRAME_BYTES).collect();
            if !self.anchor_corrected {
                // Frame 0 of this track/segment sits at position_ms and the timeline runs from here.
                relay.audio_out.set_timeline(self.position_ms, true, false);
            }
            relay.audio_out.push(&frame, false);
            {
                let mut st = relay.st.lock();
                st.stats.frames_sent += 1;
                st.stats.pcm_bytes_in += frame.len() as u64;
                st.stats.last_frame_ts = Some(now_secs());
            }

            if !self.anchor_corrected {
                // The first frame of audio actually ready to go out is the true
                // moment `position_ms` becomes "now", not whenever the command
                // was issued; correct the lobby's anchor right here.
                self.anchor_corrected = true;
                if let Some(lobby) = relay.lobby() {
                    let code = {
                        let mut l = lobby.st.lock();
                        l.position_anchor_ms = self.position_ms;
                        l.anchor_time = now_secs();
                        l.code.clone()
                    };
                    sio::broadcast(&code, "state", lobby.public_state()).await;
                }
            }

            // Real-time pacing: sleep to an absolute deadline so per-frame
            // overhead never compounds into drift.
            let now = Instant::now();
            let delay = {
                let mut st = relay.st.lock();
                let mut pn = match st.pace_next {
                    Some(p) if now.saturating_duration_since(p) <= frame_dur * 2 => p,
                    // First frame of a session, or a big gap since the last one — start fresh.
                    _ => now,
                };
                pn += frame_dur;
                st.pace_next = Some(pn);
                if pn > now {
                    Some(pn - now)
                } else {
                    st.stats.pace_drift_ms.push_back((now - pn).as_secs_f64() * 1000.0);
                    while st.stats.pace_drift_ms.len() > 200 {
                        st.stats.pace_drift_ms.pop_front();
                    }
                    None
                }
            };
            if let Some(d) = delay {
                tokio::time::sleep(d).await;
            }
        }
    }
}
