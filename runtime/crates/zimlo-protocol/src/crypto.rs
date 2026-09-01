use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chacha20poly1305::{
    ChaCha20Poly1305, XChaCha20Poly1305,
    aead::{Aead, KeyInit, Payload},
};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::Sha256;
use thiserror::Error;
use x25519_dalek::{X25519_BASEPOINT_BYTES, x25519};

const INFO_PAIR: &[u8] = b"zimlo-pair-v1";
const INFO_DEVICE: &[u8] = b"zimlo-device-v1";
const INFO_CLIENT_TX: &[u8] = b"zimlo-ws-client-tx-v1";
const INFO_SERVER_TX: &[u8] = b"zimlo-ws-server-tx-v1";
const INFO_PUSH_ROUTE: &[u8] = b"zimlo-push-route-v1";

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("invalid {name} length: expected {expected}, got {actual}")]
    InvalidLength {
        name: &'static str,
        expected: usize,
        actual: usize,
    },
    #[error("invalid base64url value")]
    InvalidBase64(#[from] base64::DecodeError),
    #[error("key derivation failed")]
    KeyDerivation,
    #[error("authenticated encryption failed")]
    Encryption,
    #[error("authenticated decryption failed")]
    Decryption,
    #[error("invalid authentication proof")]
    InvalidProof,
    #[error("random byte generation failed")]
    Random(#[from] getrandom::Error),
    #[error("JSON encoding failed")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyPair {
    pub private_key: [u8; 32],
    pub public_key: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionKeys {
    pub client_tx: [u8; 32],
    pub server_tx: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushRouteEnvelope {
    pub ephemeral_public_key: String,
    pub nonce: String,
    pub ciphertext: String,
}

pub fn to_base64_url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn from_base64_url(value: &str) -> Result<Vec<u8>, CryptoError> {
    Ok(URL_SAFE_NO_PAD.decode(value)?)
}

pub fn fixed_bytes<const N: usize>(
    name: &'static str,
    bytes: &[u8],
) -> Result<[u8; N], CryptoError> {
    bytes.try_into().map_err(|_| CryptoError::InvalidLength {
        name,
        expected: N,
        actual: bytes.len(),
    })
}

pub fn create_key_pair() -> Result<KeyPair, CryptoError> {
    let private_key = random_bytes()?;
    Ok(KeyPair {
        public_key: public_key(&private_key),
        private_key,
    })
}

pub fn random_bytes<const N: usize>() -> Result<[u8; N], CryptoError> {
    let mut bytes = [0_u8; N];
    getrandom::fill(&mut bytes)?;
    Ok(bytes)
}

pub fn public_key(private_key: &[u8; 32]) -> [u8; 32] {
    x25519(*private_key, X25519_BASEPOINT_BYTES)
}

pub fn derive_pair_key(
    private_key: &[u8; 32],
    peer_public_key: &[u8; 32],
    secret: &[u8],
) -> Result<[u8; 32], CryptoError> {
    derive_key(&x25519(*private_key, *peer_public_key), secret, INFO_PAIR)
}

pub fn derive_device_key(pair_key: &[u8; 32], secret: &[u8]) -> Result<[u8; 32], CryptoError> {
    derive_key(pair_key, secret, INFO_DEVICE)
}

pub fn make_proof(key: &[u8], message: &str) -> Result<String, CryptoError> {
    let mut mac =
        <Hmac<Sha256> as Mac>::new_from_slice(key).map_err(|_| CryptoError::InvalidProof)?;
    mac.update(message.as_bytes());
    Ok(to_base64_url(&mac.finalize().into_bytes()))
}

pub fn verify_proof(key: &[u8], message: &str, proof: &str) -> Result<(), CryptoError> {
    let proof = from_base64_url(proof)?;
    let mut mac =
        <Hmac<Sha256> as Mac>::new_from_slice(key).map_err(|_| CryptoError::InvalidProof)?;
    mac.update(message.as_bytes());
    mac.verify_slice(&proof)
        .map_err(|_| CryptoError::InvalidProof)
}

pub fn derive_connection_keys(
    device_key: &[u8; 32],
    client_nonce: &[u8; 24],
    server_nonce: &[u8; 24],
) -> Result<ConnectionKeys, CryptoError> {
    let mut salt = [0_u8; 48];
    salt[..24].copy_from_slice(client_nonce);
    salt[24..].copy_from_slice(server_nonce);
    Ok(ConnectionKeys {
        client_tx: derive_key(device_key, &salt, INFO_CLIENT_TX)?,
        server_tx: derive_key(device_key, &salt, INFO_SERVER_TX)?,
    })
}

pub fn encrypt_frame<T: Serialize>(
    key: &[u8; 32],
    counter: u64,
    value: &T,
    aad: &str,
) -> Result<String, CryptoError> {
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| CryptoError::Encryption)?;
    let plaintext = serde_json::to_vec(value)?;
    let ciphertext = cipher
        .encrypt(
            (&counter_nonce(counter)).into(),
            Payload {
                msg: &plaintext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| CryptoError::Encryption)?;
    Ok(to_base64_url(&ciphertext))
}

pub fn decrypt_frame<T: DeserializeOwned>(
    key: &[u8; 32],
    counter: u64,
    ciphertext: &str,
    aad: &str,
) -> Result<T, CryptoError> {
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| CryptoError::Decryption)?;
    let ciphertext = from_base64_url(ciphertext)?;
    let plaintext = cipher
        .decrypt(
            (&counter_nonce(counter)).into(),
            Payload {
                msg: &ciphertext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| CryptoError::Decryption)?;
    Ok(serde_json::from_slice(&plaintext)?)
}

pub fn seal_push_route<T: Serialize>(
    peer_public_key: &[u8; 32],
    value: &T,
) -> Result<PushRouteEnvelope, CryptoError> {
    let ephemeral = create_key_pair()?;
    let mut nonce = [0_u8; 12];
    getrandom::fill(&mut nonce)?;
    seal_push_route_with_material(peer_public_key, &ephemeral.private_key, &nonce, value)
}

pub fn seal_push_route_with_material<T: Serialize>(
    peer_public_key: &[u8; 32],
    ephemeral_private_key: &[u8; 32],
    nonce: &[u8; 12],
    value: &T,
) -> Result<PushRouteEnvelope, CryptoError> {
    let ephemeral_public_key = public_key(ephemeral_private_key);
    let shared = x25519(*ephemeral_private_key, *peer_public_key);
    let key = derive_key(&shared, &[], INFO_PUSH_ROUTE)?;
    let cipher = ChaCha20Poly1305::new_from_slice(&key).map_err(|_| CryptoError::Encryption)?;
    let plaintext = serde_json::to_vec(value)?;
    let ciphertext = cipher
        .encrypt(
            nonce.into(),
            Payload {
                msg: &plaintext,
                aad: INFO_PUSH_ROUTE,
            },
        )
        .map_err(|_| CryptoError::Encryption)?;
    Ok(PushRouteEnvelope {
        ephemeral_public_key: to_base64_url(&ephemeral_public_key),
        nonce: to_base64_url(nonce),
        ciphertext: to_base64_url(&ciphertext),
    })
}

pub fn open_push_route<T: DeserializeOwned>(
    private_key: &[u8; 32],
    envelope: &PushRouteEnvelope,
) -> Result<T, CryptoError> {
    let ephemeral_public_key = fixed_bytes::<32>(
        "ephemeral public key",
        &from_base64_url(&envelope.ephemeral_public_key)?,
    )?;
    let nonce = fixed_bytes::<12>("push route nonce", &from_base64_url(&envelope.nonce)?)?;
    let ciphertext = from_base64_url(&envelope.ciphertext)?;
    let shared = x25519(*private_key, ephemeral_public_key);
    let key = derive_key(&shared, &[], INFO_PUSH_ROUTE)?;
    let cipher = ChaCha20Poly1305::new_from_slice(&key).map_err(|_| CryptoError::Decryption)?;
    let plaintext = cipher
        .decrypt(
            (&nonce).into(),
            Payload {
                msg: &ciphertext,
                aad: INFO_PUSH_ROUTE,
            },
        )
        .map_err(|_| CryptoError::Decryption)?;
    Ok(serde_json::from_slice(&plaintext)?)
}

fn derive_key(
    input_key_material: &[u8],
    salt: &[u8],
    info: &[u8],
) -> Result<[u8; 32], CryptoError> {
    let hkdf = Hkdf::<Sha256>::new(Some(salt), input_key_material);
    let mut output = [0_u8; 32];
    hkdf.expand(info, &mut output)
        .map_err(|_| CryptoError::KeyDerivation)?;
    Ok(output)
}

fn counter_nonce(counter: u64) -> [u8; 24] {
    let mut nonce = [0_u8; 24];
    nonce[16..].copy_from_slice(&counter.to_be_bytes());
    nonce
}
