//! Socket.IO real-time push (state / participants / chat / analysis / debug).
//! REST handlers return fresh state to whoever made the change; these events
//! fan it out to everyone else in the lobby (room = lobby code) and track which
//! participants currently have a live connection.

use std::sync::{Arc, OnceLock};

use serde_json::{json, Value};
use socketioxide::extract::{Data, SocketRef, TryData};
use socketioxide::handler::ConnectHandler;
use socketioxide::socket::Sid;
use socketioxide::SocketIo;

use crate::auth;
use crate::lobby::{self, find_lobby_by_client, get_lobby_or_404, SID_REGISTRY};
use crate::nodelink;

static IO: OnceLock<SocketIo> = OnceLock::new();

pub fn init(io: SocketIo) {
    let _ = IO.set(io.clone());
    io.ns("/", on_connect.with(connect_middleware));
}

fn io() -> &'static SocketIo {
    IO.get().expect("socket.io not initialised")
}

/// `sio.emit(event, data, room=lobby.code)`
pub async fn broadcast(code: &str, event: &str, data: Value) {
    let _ = io().to(code.to_string()).emit(event, &(data,)).await;
}

/// Emit to one connection. False if that sid is gone / the send failed.
pub async fn emit_to_sid(sid: Sid, event: &str, data: Value) -> bool {
    match io().get_socket(sid) {
        Some(s) => s.emit(event, &(data,)).is_ok(),
        None => false,
    }
}

pub fn disconnect_sid(sid: Sid) {
    if let Some(s) = io().get_socket(sid) {
        let _ = s.disconnect();
    }
}

pub fn join_room(sid: Sid, room: &str) {
    if let Some(s) = io().get_socket(sid) {
        s.join(room.to_string());
    }
}

pub fn leave_room(sid: Sid, room: &str) {
    if let Some(s) = io().get_socket(sid) {
        s.leave(room.to_string());
    }
}

/// With a server password set, the connection must present the access token
/// (Socket.IO `auth`, or ?token= in the query string).
async fn connect_middleware(s: SocketRef, TryData(auth_data): TryData<Value>) -> Result<(), String> {
    if auth::password_set() {
        let mut tok: Option<String> = auth_data
            .ok()
            .and_then(|a| a.get("token").and_then(|t| t.as_str().map(|s| s.to_string())))
            .filter(|t| !t.is_empty());
        if tok.is_none() {
            tok = auth::query_param(s.req_parts().uri.query(), "token");
        }
        if !auth::token_ok(tok.as_deref()) {
            return Err("password required".into());
        }
    }
    Ok(())
}

async fn on_connect(socket: SocketRef) {
    socket.on("join_lobby", join_lobby);
    socket.on("debug_subscribe", debug_subscribe);
    socket.on("debug_unsubscribe", debug_unsubscribe);
    socket.on_disconnect(on_disconnect);
}

async fn join_lobby(socket: SocketRef, TryData(data): TryData<Value>) {
    let data = data.unwrap_or(Value::Null);
    let code = data.get("code").map(|c| crate::util::str_or(Some(c), "")).unwrap_or_default().to_uppercase();
    let client_id = data.get("clientId").and_then(|c| c.as_str()).map(|s| s.to_string());
    let mut lobby = get_lobby_or_404(&code);
    let known = |l: &Arc<lobby::LobbyHandle>| client_id.as_ref().map(|c| l.st.lock().participants.contains_key(c)).unwrap_or(false);
    if lobby.as_ref().map(|l| !known(l)).unwrap_or(true) {
        // The host may have changed the lobby code while this client was
        // disconnected — the client id still identifies its lobby.
        lobby = find_lobby_by_client(client_id.as_deref());
    }
    let Some(lobby) = lobby else {
        let _ = socket.emit("join_error", &(json!({"error": "not found"}),));
        return;
    };
    let client_id = client_id.unwrap_or_default();
    let code = lobby.code();
    socket.join(code.clone());
    SID_REGISTRY.lock().insert(socket.id, (code, client_id.clone()));
    lobby.st.lock().sids.entry(client_id).or_default().insert(socket.id);

    // Bring this (re)connecting client fully up to date right away.
    let _ = socket.emit("state", &(lobby.public_state(),));
    let _ = socket.emit("participants", &(lobby.participant_list(),));
}

async fn on_disconnect(socket: SocketRef) {
    let sid = socket.id;
    nodelink::DEBUG_SUBSCRIBERS.lock().remove(&sid);
    let info = SID_REGISTRY.lock().remove(&sid);
    let Some((code, client_id)) = info else { return };
    let Some(lobby) = get_lobby_or_404(&code) else { return };
    lobby.relay.debug_unsubscribe(sid);
    {
        let mut l = lobby.st.lock();
        if let Some(s) = l.sids.get_mut(&client_id) {
            s.remove(&sid);
        }
    }
    // Don't remove the participant yet — this may just be a reconnect. See
    // schedule_disconnect_check, which re-checks after a grace period.
    tokio::spawn(lobby::schedule_disconnect_check(lobby, client_id));
}

/// The Debug tab subscribes per-connection (a sid disappears on every reconnect).
async fn debug_subscribe(socket: SocketRef, TryData(data): TryData<Value>) {
    let code = data.ok().and_then(|d| d.get("code").map(|c| crate::util::str_or(Some(c), ""))).unwrap_or_default().to_uppercase();
    if let Some(lobby) = get_lobby_or_404(&code) {
        lobby.relay.debug_subscribe(socket.id);
    }
    nodelink::DEBUG_SUBSCRIBERS.lock().insert(socket.id);
    // NodeLink requests aren't tied to any one lobby: a fresh subscriber gets
    // whatever's already in the log immediately.
    let backlog = nodelink::requests_snapshot();
    if !backlog.is_empty() {
        let _ = socket.emit("nodelink_requests_backlog", &(Value::Array(backlog),));
    }
}

async fn debug_unsubscribe(socket: SocketRef, TryData(data): TryData<Value>) {
    let code = data.ok().and_then(|d| d.get("code").map(|c| crate::util::str_or(Some(c), ""))).unwrap_or_default().to_uppercase();
    if let Some(lobby) = get_lobby_or_404(&code) {
        lobby.relay.debug_unsubscribe(socket.id);
    }
    nodelink::DEBUG_SUBSCRIBERS.lock().remove(&socket.id);
}

#[allow(unused_imports)]
use Data as _Data;
