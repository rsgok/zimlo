use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, close_code};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::{MissedTickBehavior, interval};
use zimlo_protocol::crypto::{
    ConnectionKeys, decrypt_frame, derive_connection_keys, fixed_bytes, from_base64_url,
    make_proof, random_bytes, to_base64_url, verify_proof,
};
use zimlo_store::{DeviceAuthRecord, SnapshotOptions, Store, StoreError};

use crate::{
    ActionBroker, CloudService,
    dispatcher::{self, DispatchContext, DispatchResult},
    pairing::PairingManager,
    ws_frame::{Incoming, SecureFrame, close_socket, incoming},
};

const SNAPSHOT_POLL_INTERVAL: Duration = Duration::from_millis(250);

struct MessageContext<'a> {
    store: &'a Store,
    host_name: &'a str,
    writable: bool,
    pairing: Option<&'a PairingManager>,
    action_broker: &'a ActionBroker,
    cloud: Option<&'a CloudService>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthRequest {
    r#type: String,
    device_id: String,
    client_nonce: String,
    proof: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthResponse<'a> {
    r#type: &'static str,
    server_nonce: &'a str,
    proof: String,
}

struct SecureConnection {
    device: DeviceAuthRecord,
    client_tx_key: [u8; 32],
    server_tx_key: [u8; 32],
    receive_counter: u64,
    send_counter: u64,
}

impl SecureConnection {
    fn new(device: DeviceAuthRecord, keys: ConnectionKeys) -> Self {
        Self {
            device,
            client_tx_key: keys.client_tx,
            server_tx_key: keys.server_tx,
            receive_counter: 0,
            send_counter: 0,
        }
    }

    fn aad(&self) -> String {
        format!("zimlo-ws-v1:{}", self.device.id)
    }
}

pub(super) async fn serve(
    mut socket: WebSocket,
    store: Store,
    host_name: String,
    writable: bool,
    pairing: Option<PairingManager>,
    cloud: Option<CloudService>,
    action_broker: ActionBroker,
) {
    let Some(auth) = receive_authentication(&mut socket).await else {
        return;
    };
    let mut connection = match authenticate(&mut socket, &store, auth, writable).await {
        Ok(connection) => connection,
        Err(close) => {
            close_socket(&mut socket, close.code, close.reason).await;
            return;
        }
    };

    if let Err(error) = send_snapshot(&mut socket, &mut connection, &store, &host_name).await {
        close_for_store_error(&mut socket, error).await;
        return;
    }
    let mut data_version = match store.data_version().await {
        Ok(version) => version,
        Err(error) => {
            eprintln!("[zimlo:rust-bridge] 读取 SQLite data_version 失败: {error}");
            close_socket(&mut socket, close_code::ERROR, "Store unavailable").await;
            return;
        }
    };

    let mut poll = interval(SNAPSHOT_POLL_INTERVAL);
    poll.set_missed_tick_behavior(MissedTickBehavior::Skip);
    poll.tick().await;
    let context = MessageContext {
        store: &store,
        host_name: &host_name,
        writable,
        pairing: pairing.as_ref(),
        action_broker: &action_broker,
        cloud: cloud.as_ref(),
    };
    loop {
        tokio::select! {
            message = socket.recv() => {
                let Some(message) = message else { return };
                let Ok(message) = message else { return };
                match incoming(message) {
                    Incoming::Payload(payload) => {
                        if !handle_secure_message(
                            &mut socket,
                            &mut connection,
                            &context,
                            &payload,
                        ).await {
                            return;
                        }
                    }
                    Incoming::Closed => return,
                    Incoming::Ignore => {}
                }
            }
            _ = poll.tick() => {
                match store.active_device(&connection.device.id).await {
                    Ok(Some(device)) => connection.device = device,
                    Ok(None) => {
                        close_socket(&mut socket, close_code::POLICY, "Device revoked").await;
                        return;
                    }
                    Err(error) => {
                        eprintln!("[zimlo:rust-bridge] 校验设备状态失败: {error}");
                        close_socket(&mut socket, close_code::ERROR, "Store unavailable").await;
                        return;
                    }
                }
                match store.data_version().await {
                    Ok(version) if version != data_version => {
                        data_version = version;
                        if let Err(error) = send_snapshot(
                            &mut socket,
                            &mut connection,
                            &store,
                            &host_name,
                        ).await {
                            close_for_store_error(&mut socket, error).await;
                            return;
                        }
                    }
                    Ok(_) => {}
                    Err(error) => {
                        eprintln!("[zimlo:rust-bridge] 监听 SQLite 变更失败: {error}");
                        close_socket(&mut socket, close_code::ERROR, "Store unavailable").await;
                        return;
                    }
                }
            }
        }
    }
}

async fn receive_authentication(socket: &mut WebSocket) -> Option<AuthRequest> {
    loop {
        let message = match socket.recv().await? {
            Ok(message) => message,
            Err(_) => return None,
        };
        match incoming(message) {
            Incoming::Payload(payload) => match serde_json::from_slice::<AuthRequest>(&payload) {
                Ok(auth) if auth.r#type == "auth" => return Some(auth),
                _ => {
                    close_socket(socket, close_code::POLICY, "Authentication required").await;
                    return None;
                }
            },
            Incoming::Closed => return None,
            Incoming::Ignore => {}
        }
    }
}

struct AuthenticationClose {
    code: u16,
    reason: &'static str,
}

async fn authenticate(
    socket: &mut WebSocket,
    store: &Store,
    auth: AuthRequest,
    writable: bool,
) -> Result<SecureConnection, AuthenticationClose> {
    let mut device = store
        .active_device(&auth.device_id)
        .await
        .map_err(|error| {
            eprintln!("[zimlo:rust-bridge] 读取设备凭据失败: {error}");
            AuthenticationClose {
                code: close_code::ERROR,
                reason: "Store unavailable",
            }
        })?
        .ok_or(AuthenticationClose {
            code: close_code::POLICY,
            reason: "Authentication failed",
        })?;
    if writable {
        device = store
            .touch_device(
                &device.id,
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            )
            .await
            .map_err(|_| AuthenticationClose {
                code: close_code::ERROR,
                reason: "Store unavailable",
            })?
            .ok_or_else(authentication_failed)?;
    }
    let client_nonce = fixed_bytes::<24>(
        "client nonce",
        &from_base64_url(&auth.client_nonce).map_err(|_| authentication_failed())?,
    )
    .map_err(|_| AuthenticationClose {
        code: close_code::POLICY,
        reason: "Invalid nonce",
    })?;
    let device_key = fixed_bytes::<32>(
        "device key",
        &from_base64_url(&device.key_base64).map_err(|_| authentication_failed())?,
    )
    .map_err(|_| authentication_failed())?;
    verify_proof(
        &device_key,
        &format!("ws:{}", auth.client_nonce),
        &auth.proof,
    )
    .map_err(|_| authentication_failed())?;

    let server_nonce = random_bytes::<24>().map_err(|_| AuthenticationClose {
        code: close_code::ERROR,
        reason: "Random source unavailable",
    })?;
    let keys = derive_connection_keys(&device_key, &client_nonce, &server_nonce)
        .map_err(|_| authentication_failed())?;
    let server_nonce = to_base64_url(&server_nonce);
    let response = AuthResponse {
        r#type: "auth.ok",
        server_nonce: &server_nonce,
        proof: make_proof(
            &device_key,
            &format!("ws-server:{}:{server_nonce}", auth.client_nonce),
        )
        .map_err(|_| authentication_failed())?,
    };
    let payload = serde_json::to_string(&response).map_err(|_| authentication_failed())?;
    socket
        .send(Message::Text(payload.into()))
        .await
        .map_err(|_| AuthenticationClose {
            code: close_code::ERROR,
            reason: "Unable to send authentication response",
        })?;
    Ok(SecureConnection::new(device, keys))
}

const fn authentication_failed() -> AuthenticationClose {
    AuthenticationClose {
        code: close_code::POLICY,
        reason: "Authentication failed",
    }
}

async fn handle_secure_message(
    socket: &mut WebSocket,
    connection: &mut SecureConnection,
    context: &MessageContext<'_>,
    payload: &[u8],
) -> bool {
    let MessageContext {
        store,
        host_name,
        writable,
        pairing,
        action_broker,
        cloud,
    } = context;
    let frame = match serde_json::from_slice::<SecureFrame>(payload) {
        Ok(frame) if frame.r#type == "secure" => frame,
        _ => {
            close_socket(socket, close_code::POLICY, "Encrypted frame required").await;
            return false;
        }
    };
    if frame.counter != connection.receive_counter {
        close_socket(socket, close_code::POLICY, "Replay or counter gap").await;
        return false;
    }
    let command = match decrypt_frame::<Value>(
        &connection.client_tx_key,
        frame.counter,
        &frame.ciphertext,
        &connection.aad(),
    ) {
        Ok(command) => command,
        Err(_) => {
            close_socket(socket, close_code::POLICY, "Unable to decrypt frame").await;
            return false;
        }
    };
    let Some(command_type) = command.get("type").and_then(Value::as_str) else {
        return send_invalid_command(socket, connection).await;
    };
    match command_type {
        "snapshot.request" if dispatcher::valid_snapshot_request(&command) => {
            connection.receive_counter += 1;
            if let Err(error) = send_snapshot(socket, connection, store, host_name).await {
                close_for_store_error(socket, error).await;
                return false;
            }
        }
        "session.events.request" => {
            let Some(session_id) = command.get("sessionId").and_then(Value::as_str) else {
                return send_invalid_command(socket, connection).await;
            };
            connection.receive_counter += 1;
            match store.list_events(session_id, 200).await {
                Ok(events) => {
                    if send_secure(
                        socket,
                        connection,
                        &json!({
                            "type": "session.events",
                            "sessionId": session_id,
                            "events": events,
                        }),
                    )
                    .await
                    .is_err()
                    {
                        return false;
                    }
                }
                Err(error) => {
                    eprintln!("[zimlo:rust-bridge] WebSocket 读取事件失败: {error}");
                    return send_error(
                        socket,
                        connection,
                        "command_failed",
                        "操作未完成，请稍后重试。",
                    )
                    .await;
                }
            }
        }
        "snapshot.request" => return send_invalid_command(socket, connection).await,
        _ => {
            let dispatched = dispatcher::dispatch(
                DispatchContext {
                    store,
                    device_id: &connection.device.id,
                    is_local_admin: connection.device.is_local_admin,
                    can_approve: connection.device.can_approve,
                    can_manage_trust: connection.device.can_manage_trust,
                    writable: *writable,
                    pairing: *pairing,
                    cloud: *cloud,
                    action_broker,
                    host_name,
                },
                &command,
            )
            .await;
            match dispatched {
                Ok(DispatchResult::Invalid) | Err(StoreError::InvalidMutation) => {
                    return send_invalid_command(socket, connection).await;
                }
                Ok(DispatchResult::Message(message)) => {
                    connection.receive_counter += 1;
                    return send_secure(socket, connection, &message).await.is_ok();
                }
                Ok(DispatchResult::Messages(messages)) => {
                    connection.receive_counter += 1;
                    for message in messages {
                        if send_secure(socket, connection, &message).await.is_err() {
                            return false;
                        }
                    }
                }
                Ok(DispatchResult::Snapshot) => {
                    connection.receive_counter += 1;
                    if let Err(error) = send_snapshot(socket, connection, store, host_name).await {
                        close_for_store_error(socket, error).await;
                        return false;
                    }
                }
                Err(StoreError::MissingSession) => {
                    connection.receive_counter += 1;
                    return send_error(
                        socket,
                        connection,
                        "session_not_found",
                        "这个任务已不存在。",
                    )
                    .await;
                }
                Err(error) => {
                    eprintln!("[zimlo:rust-bridge] WebSocket 写命令失败: {error}");
                    connection.receive_counter += 1;
                    return send_error(
                        socket,
                        connection,
                        "command_failed",
                        "操作未完成，请稍后重试。",
                    )
                    .await;
                }
            }
        }
    }
    true
}

async fn send_invalid_command(socket: &mut WebSocket, connection: &mut SecureConnection) -> bool {
    send_error(socket, connection, "invalid_command", "消息格式不受支持。").await
}

async fn send_error(
    socket: &mut WebSocket,
    connection: &mut SecureConnection,
    code: &str,
    message: &str,
) -> bool {
    send_secure(
        socket,
        connection,
        &json!({ "type": "error", "code": code, "message": message }),
    )
    .await
    .is_ok()
}

async fn send_snapshot(
    socket: &mut WebSocket,
    connection: &mut SecureConnection,
    store: &Store,
    host_name: &str,
) -> Result<(), StoreError> {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let snapshot = store
        .snapshot(SnapshotOptions::for_device(
            host_name,
            now,
            &connection.device.id,
        ))
        .await?;
    send_secure(
        socket,
        connection,
        &json!({ "type": "session.snapshot", "snapshot": snapshot }),
    )
    .await
    .map_err(|_| StoreError::ActorStopped)
}

async fn send_secure<T: Serialize>(
    socket: &mut WebSocket,
    connection: &mut SecureConnection,
    message: &T,
) -> Result<(), ()> {
    let counter = connection.send_counter;
    let ciphertext = zimlo_protocol::crypto::encrypt_frame(
        &connection.server_tx_key,
        counter,
        message,
        &connection.aad(),
    )
    .map_err(|_| ())?;
    connection.send_counter += 1;
    let frame = SecureFrame {
        r#type: "secure".into(),
        counter,
        ciphertext,
    };
    let payload = serde_json::to_string(&frame).map_err(|_| ())?;
    socket
        .send(Message::Text(payload.into()))
        .await
        .map_err(|_| ())
}

async fn close_for_store_error(socket: &mut WebSocket, error: StoreError) {
    match error {
        StoreError::MissingDevice => {
            close_socket(socket, close_code::POLICY, "Device revoked").await;
        }
        error => {
            eprintln!("[zimlo:rust-bridge] WebSocket Snapshot 失败: {error}");
            close_socket(socket, close_code::ERROR, "Store unavailable").await;
        }
    }
}
