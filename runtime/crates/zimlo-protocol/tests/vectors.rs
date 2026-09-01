use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use zimlo_protocol::{
    crypto::{
        PushRouteEnvelope, decrypt_frame, derive_connection_keys, derive_device_key,
        derive_pair_key, encrypt_frame, fixed_bytes, from_base64_url, make_proof, open_push_route,
        public_key, seal_push_route_with_material, verify_proof,
    },
    policy::{
        DecisionSummary, FeedOrderable, FeedPostKind, FeedPostSummary, backoff_delay_ms,
        compare_feed_items, is_command_cancelable, is_post_covered, is_quick_approvable,
        merge_routine_posts, post_priority, semantic_command_key,
    },
};

#[derive(Deserialize)]
struct VectorFile<T> {
    version: u32,
    cases: Vec<T>,
}

#[derive(Deserialize)]
struct NamedCase<I, E> {
    name: String,
    input: I,
    expected: E,
}

fn vectors<T: DeserializeOwned>(contents: &str, version: u32) -> Vec<T> {
    let file: VectorFile<T> = serde_json::from_str(contents).expect("valid shared vector file");
    assert_eq!(file.version, version);
    file.cases
}

#[test]
fn feed_merge_vectors_match_typescript() {
    #[derive(Deserialize)]
    struct Input {
        posts: Vec<FeedPostSummary>,
    }
    #[derive(Deserialize)]
    struct Expected {
        merged: Vec<FeedPostSummary>,
    }
    for test_case in vectors::<NamedCase<Input, Expected>>(
        include_str!("../../../../packages/protocol/test-vectors/feed-merge.json"),
        1,
    ) {
        assert_eq!(
            merge_routine_posts(&test_case.input.posts),
            test_case.expected.merged,
            "{}",
            test_case.name
        );
    }
}

#[test]
fn feed_priority_vectors_match_typescript() {
    #[derive(Deserialize)]
    struct Expected {
        covered: Option<bool>,
        priority: Option<i32>,
        order: Option<Vec<String>>,
    }
    for test_case in vectors::<NamedCase<Value, Expected>>(
        include_str!("../../../../packages/protocol/test-vectors/feed-priority.json"),
        3,
    ) {
        if let Some(items) = test_case.input.get("items") {
            let mut items: Vec<FeedOrderable> =
                serde_json::from_value(items.clone()).expect("valid feed ordering input");
            items.sort_by(compare_feed_items);
            assert_eq!(
                items.into_iter().map(|item| item.id).collect::<Vec<_>>(),
                test_case.expected.order.expect("order expectation"),
                "{}",
                test_case.name
            );
            continue;
        }

        let kind: FeedPostKind =
            serde_json::from_value(test_case.input.get("kind").expect("kind").clone())
                .expect("valid feed kind");
        let created_at = test_case.input["createdAt"].as_str().expect("createdAt");
        let latest = test_case.input["latestOutcomeCreatedAt"].as_str();
        let unread = test_case.input["unread"].as_bool().expect("unread");
        let covered = is_post_covered(kind, created_at, latest);
        assert_eq!(
            Some(covered),
            test_case.expected.covered,
            "{}",
            test_case.name
        );
        assert_eq!(
            Some(post_priority(kind, false, covered, unread)),
            test_case.expected.priority,
            "{}",
            test_case.name
        );
    }
}

#[test]
fn outbox_key_vectors_match_typescript() {
    #[derive(Deserialize)]
    struct Expected {
        key: String,
    }
    for test_case in vectors::<NamedCase<Value, Expected>>(
        include_str!("../../../../packages/protocol/test-vectors/outbox-keys.json"),
        2,
    ) {
        assert_eq!(
            semantic_command_key(&test_case.input),
            test_case.expected.key,
            "{}",
            test_case.name
        );
    }
}

#[test]
fn reconnect_backoff_vectors_match_typescript() {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        attempt: f64,
        random_value: f64,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Expected {
        delay_ms: u64,
    }
    for test_case in vectors::<NamedCase<Input, Expected>>(
        include_str!("../../../../packages/protocol/test-vectors/backoff.json"),
        1,
    ) {
        assert_eq!(
            backoff_delay_ms(test_case.input.attempt, test_case.input.random_value),
            test_case.expected.delay_ms,
            "{}",
            test_case.name
        );
    }
}

#[test]
fn quick_approval_vectors_match_typescript() {
    #[derive(Deserialize)]
    struct Input {
        kind: String,
        decisions: Vec<DecisionSummary>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Expected {
        quick_approvable: bool,
    }
    for test_case in vectors::<NamedCase<Input, Expected>>(
        include_str!("../../../../packages/protocol/test-vectors/quick-approve.json"),
        1,
    ) {
        assert_eq!(
            is_quick_approvable(&test_case.input.kind, &test_case.input.decisions),
            test_case.expected.quick_approvable,
            "{}",
            test_case.name
        );
    }
}

#[test]
fn cancelable_state_vectors_match_typescript() {
    #[derive(Deserialize)]
    struct Input {
        state: String,
    }
    #[derive(Deserialize)]
    struct Expected {
        cancelable: bool,
    }
    for test_case in vectors::<NamedCase<Input, Expected>>(
        include_str!("../../../../packages/protocol/test-vectors/cancelable-states.json"),
        1,
    ) {
        assert_eq!(
            is_command_cancelable(&test_case.input.state),
            test_case.expected.cancelable,
            "{}",
            test_case.name
        );
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CryptoVectors {
    version: u32,
    pair: PairVector,
    frame: FrameVector,
    push_route: PushRouteVector,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairVector {
    bridge_private_key: String,
    bridge_public_key: String,
    client_private_key: String,
    client_public_key: String,
    secret: String,
    pair_key: String,
    device_key: String,
    proof_message: String,
    proof: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrameVector {
    device_key: String,
    client_nonce: String,
    server_nonce: String,
    client_tx_key: String,
    server_tx_key: String,
    counter: u64,
    aad: String,
    value: SnapshotRequest,
    ciphertext: String,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotRequest {
    #[serde(rename = "type")]
    message_type: String,
    after_sequence: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushRouteVector {
    private_key: String,
    public_key: String,
    ephemeral_private_key: String,
    envelope: PushRouteEnvelope,
    value: PushRouteValue,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushRouteValue {
    version: u32,
    session_id: String,
    action_id: String,
}

#[test]
fn crypto_vectors_match_typescript_byte_for_byte() {
    let vectors: CryptoVectors = serde_json::from_str(include_str!(
        "../../../../packages/protocol/test-vectors/crypto.json"
    ))
    .expect("valid crypto vector file");
    assert_eq!(vectors.version, 1);

    let bridge_private = decode::<32>(&vectors.pair.bridge_private_key);
    let bridge_public = decode::<32>(&vectors.pair.bridge_public_key);
    let client_private = decode::<32>(&vectors.pair.client_private_key);
    let client_public = decode::<32>(&vectors.pair.client_public_key);
    let secret = from_base64_url(&vectors.pair.secret).expect("secret");
    assert_eq!(public_key(&bridge_private), bridge_public);
    assert_eq!(public_key(&client_private), client_public);

    let pair_key = derive_pair_key(&bridge_private, &client_public, &secret).expect("pair key");
    assert_eq!(pair_key, decode::<32>(&vectors.pair.pair_key));
    let peer_pair_key =
        derive_pair_key(&client_private, &bridge_public, &secret).expect("peer pair key");
    assert_eq!(pair_key, peer_pair_key);
    let device_key = derive_device_key(&pair_key, &secret).expect("device key");
    assert_eq!(device_key, decode::<32>(&vectors.pair.device_key));
    assert_eq!(
        make_proof(&pair_key, &vectors.pair.proof_message).expect("proof"),
        vectors.pair.proof
    );
    verify_proof(&pair_key, &vectors.pair.proof_message, &vectors.pair.proof)
        .expect("proof verifies");

    let frame_device_key = decode::<32>(&vectors.frame.device_key);
    let connection = derive_connection_keys(
        &frame_device_key,
        &decode::<24>(&vectors.frame.client_nonce),
        &decode::<24>(&vectors.frame.server_nonce),
    )
    .expect("connection keys");
    assert_eq!(
        connection.client_tx,
        decode::<32>(&vectors.frame.client_tx_key)
    );
    assert_eq!(
        connection.server_tx,
        decode::<32>(&vectors.frame.server_tx_key)
    );
    assert_eq!(
        encrypt_frame(
            &connection.client_tx,
            vectors.frame.counter,
            &vectors.frame.value,
            &vectors.frame.aad,
        )
        .expect("frame encryption"),
        vectors.frame.ciphertext
    );
    let decrypted: SnapshotRequest = decrypt_frame(
        &connection.client_tx,
        vectors.frame.counter,
        &vectors.frame.ciphertext,
        &vectors.frame.aad,
    )
    .expect("frame decryption");
    assert_eq!(decrypted, vectors.frame.value);

    let push_private = decode::<32>(&vectors.push_route.private_key);
    let push_public = decode::<32>(&vectors.push_route.public_key);
    assert_eq!(public_key(&push_private), push_public);
    let nonce = decode::<12>(&vectors.push_route.envelope.nonce);
    let sealed = seal_push_route_with_material(
        &push_public,
        &decode::<32>(&vectors.push_route.ephemeral_private_key),
        &nonce,
        &vectors.push_route.value,
    )
    .expect("push route encryption");
    assert_eq!(sealed, vectors.push_route.envelope);
    let opened: PushRouteValue =
        open_push_route(&push_private, &sealed).expect("push route decryption");
    assert_eq!(opened, vectors.push_route.value);
}

fn decode<const N: usize>(value: &str) -> [u8; N] {
    fixed_bytes(
        "test vector",
        &from_base64_url(value).expect("base64url test vector"),
    )
    .expect("fixed-size test vector")
}
