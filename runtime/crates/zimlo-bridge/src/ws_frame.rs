use axum::extract::ws::{CloseFrame, Message, WebSocket};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
pub(super) struct SecureFrame {
    pub r#type: String,
    pub counter: u64,
    pub ciphertext: String,
}

pub(super) enum Incoming {
    Payload(Vec<u8>),
    Closed,
    Ignore,
}

pub(super) fn incoming(message: Message) -> Incoming {
    match message {
        Message::Text(text) => Incoming::Payload(text.as_bytes().to_vec()),
        Message::Binary(bytes) => Incoming::Payload(bytes.to_vec()),
        Message::Close(_) => Incoming::Closed,
        Message::Ping(_) | Message::Pong(_) => Incoming::Ignore,
    }
}

pub(super) async fn close_socket(socket: &mut WebSocket, code: u16, reason: &'static str) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })))
        .await;
}
