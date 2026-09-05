use crate::{ActionBroker, BridgeConfig, router_with_config_and_broker, serve_router};
use axum::{
    Router,
    extract::{Request, State},
    http::{HeaderValue, StatusCode},
    middleware::{Next, from_fn_with_state},
    response::Response,
};
use std::{future::Future, io};
use tokio::net::TcpListener;
use zimlo_store::Store;

/// The desktop pins this identity from its private service descriptor. Keep
/// legacy clients working, but reject a pinned request BEFORE running handlers.
#[derive(Clone)]
pub struct LocalServiceIdentity {
    pub host_id: String,
    pub instance_id: String,
}

pub fn with_local_identity(router: Router, identity: LocalServiceIdentity) -> Router {
    router.layer(from_fn_with_state(identity, verify))
}

async fn verify(
    State(identity): State<LocalServiceIdentity>,
    request: Request,
    next: Next,
) -> Response {
    let mismatch = [
        ("x-zimlo-instance-id", &identity.instance_id),
        ("x-zimlo-host-id", &identity.host_id),
    ]
    .iter()
    .any(|(key, expected)| {
        request
            .headers()
            .get(*key)
            .is_some_and(|value| value.to_str().ok() != Some(expected.as_str()))
    });
    let mut response = if mismatch {
        super::api_error(
            StatusCode::CONFLICT,
            "local_identity_mismatch",
            "连接的不是预期运行设备，请检查本机端口与服务。",
            true,
        )
    } else {
        next.run(request).await
    };
    if let (Ok(host), Ok(instance)) = (
        HeaderValue::from_str(&identity.host_id),
        HeaderValue::from_str(&identity.instance_id),
    ) {
        response.headers_mut().insert("x-zimlo-host-id", host);
        response
            .headers_mut()
            .insert("x-zimlo-instance-id", instance);
    }
    response
}

pub async fn serve_runtime_with_broker(
    listener: TcpListener,
    store: Store,
    config: BridgeConfig,
    action_broker: ActionBroker,
    identity: LocalServiceIdentity,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> io::Result<()> {
    serve_router(
        listener,
        with_local_identity(
            router_with_config_and_broker(store, config, action_broker),
            identity,
        ),
        shutdown,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, routing::post};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use tower::ServiceExt as _;

    #[tokio::test]
    async fn rejects_other_instance_without_executing_a_mutation() {
        let writes = Arc::new(AtomicUsize::new(0));
        let counter = writes.clone();
        let app = with_local_identity(
            Router::new().route(
                "/write",
                post(move || {
                    counter.fetch_add(1, Ordering::SeqCst);
                    async { "ok" }
                }),
            ),
            LocalServiceIdentity {
                host_id: "mac".into(),
                instance_id: "new-instance".into(),
            },
        );
        for (pin, status) in [
            (Some("old-instance"), StatusCode::CONFLICT),
            (Some("new-instance"), StatusCode::OK),
            (None, StatusCode::OK),
        ] {
            let mut request = Request::builder().method("POST").uri("/write");
            if let Some(pin) = pin {
                request = request.header("x-zimlo-instance-id", pin);
            }
            let response = app
                .clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), status);
            assert_eq!(response.headers()["x-zimlo-host-id"], "mac");
        }
        assert_eq!(writes.load(Ordering::SeqCst), 2);
    }
}
