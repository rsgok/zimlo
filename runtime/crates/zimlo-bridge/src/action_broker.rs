use std::{collections::HashMap, sync::Arc, time::Duration};

use chrono::{SecondsFormat, Utc};
use serde_json::Value;
use tokio::{sync::Mutex, task::AbortHandle};
use zimlo_store::{
    ActionResult, ApprovalContextRecord, DecisionRecord, PendingActionRecord, Store, StoreError,
    TrustAuditRecord,
};

use crate::{PushService, trust_policy};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(8 * 60);
const REMINDER_LEAD: Duration = Duration::from_secs(5 * 60);
const REMINDER_MIN_DELAY: Duration = Duration::from_secs(60);
const REMINDER_MIN_REMAINING: Duration = Duration::from_secs(90);

fn approval_reminder_delay(action: &PendingActionRecord) -> Option<Duration> {
    if action.state != "pending" {
        return None;
    }
    let expires_at = chrono::DateTime::parse_from_rfc3339(&action.expires_at)
        .ok()?
        .with_timezone(&Utc);
    let now = Utc::now();
    let remaining = (expires_at - now).to_std().ok()?;
    if remaining < REMINDER_MIN_REMAINING {
        return None;
    }
    let delay = remaining
        .saturating_sub(REMINDER_LEAD)
        .max(REMINDER_MIN_DELAY);
    (delay < remaining).then_some(delay)
}

#[derive(Debug, Clone)]
pub struct NewAction {
    pub session_id: String,
    pub upstream_request_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub available_decisions: Vec<DecisionRecord>,
    pub approval_context: Option<Value>,
    pub timeout: Option<Duration>,
}

#[derive(Debug, Clone)]
pub struct DecisionSubmission {
    pub device_id: String,
    pub action_id: String,
    pub session_id: String,
    pub decision_id: String,
    pub idempotency_key: String,
    pub confirmation_phrase: Option<String>,
    pub input: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DecisionResolution {
    pub decision: DecisionRecord,
    pub input: Option<HashMap<String, String>>,
}

pub struct ActionTicket {
    pub action: PendingActionRecord,
    result: tokio::sync::oneshot::Receiver<Option<DecisionResolution>>,
}

impl ActionTicket {
    pub async fn result(self) -> Option<DecisionResolution> {
        self.result.await.unwrap_or(None)
    }
}

struct Resolver {
    sender: tokio::sync::oneshot::Sender<Option<DecisionResolution>>,
    timer: AbortHandle,
}

#[derive(Clone)]
pub struct ActionBroker {
    store: Store,
    resolvers: Arc<Mutex<HashMap<String, Resolver>>>,
    push: Option<PushService>,
}

impl ActionBroker {
    pub fn new(store: Store) -> Self {
        Self::with_push(store, None)
    }

    pub fn with_push(store: Store, push: Option<PushService>) -> Self {
        Self {
            store,
            resolvers: Arc::new(Mutex::new(HashMap::new())),
            push,
        }
    }

    pub async fn create(&self, input: NewAction) -> Result<ActionTicket, StoreError> {
        let now = Utc::now();
        let timeout = input
            .timeout
            .unwrap_or(DEFAULT_TIMEOUT)
            .max(Duration::from_millis(1));
        let expires_at =
            now + chrono::Duration::from_std(timeout).map_err(|_| StoreError::InvalidMutation)?;
        let action = PendingActionRecord {
            action_id: uuid::Uuid::now_v7().to_string(),
            host_id: None,
            session_id: input.session_id,
            upstream_request_id: input.upstream_request_id,
            kind: input.kind,
            title: input.title,
            detail: input.detail,
            available_decisions: input.available_decisions,
            expires_at: expires_at.to_rfc3339_opts(SecondsFormat::Millis, true),
            state: "pending".into(),
            created_at: now.to_rfc3339_opts(SecondsFormat::Millis, true),
            resolved_at: None,
            approval_context: input.approval_context,
        };
        validate_action(&action)?;
        if let Some((action, decision)) = self.automatic_resolution(&action).await? {
            let (sender, result) = tokio::sync::oneshot::channel();
            let _ = sender.send(Some(DecisionResolution {
                decision,
                input: None,
            }));
            return Ok(ActionTicket { action, result });
        }
        let action = self.store.upsert_action(action).await?;
        self.schedule_approval_notifications(action.clone());
        let (sender, result) = tokio::sync::oneshot::channel();
        let broker = self.clone();
        let action_id = action.action_id.clone();
        let timer = tokio::spawn(async move {
            tokio::time::sleep(timeout).await;
            let _ = broker.expire_from_timer(&action_id).await;
        });
        self.resolvers.lock().await.insert(
            action.action_id.clone(),
            Resolver {
                sender,
                timer: timer.abort_handle(),
            },
        );
        Ok(ActionTicket { action, result })
    }

    fn schedule_approval_notifications(&self, action: PendingActionRecord) {
        let Some(push) = self.push.clone() else {
            return;
        };
        let store = self.store.clone();
        let immediate = action.clone();
        let immediate_push = push.clone();
        tokio::spawn(async move {
            let title = store
                .get_session(&immediate.session_id)
                .await
                .ok()
                .flatten()
                .map(|session| session.title);
            immediate_push
                .notify_approval(immediate, title, false)
                .await;
        });
        let Some(delay) = approval_reminder_delay(&action) else {
            return;
        };
        let store = self.store.clone();
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            let Ok(Some(current)) = store.get_action(&action.action_id).await else {
                return;
            };
            if current.state != "pending"
                || chrono::DateTime::parse_from_rfc3339(&current.expires_at)
                    .is_ok_and(|expires| expires <= Utc::now())
            {
                return;
            }
            let title = store
                .get_session(&current.session_id)
                .await
                .ok()
                .flatten()
                .map(|session| session.title);
            push.notify_approval(current, title, true).await;
        });
    }

    async fn automatic_resolution(
        &self,
        action: &PendingActionRecord,
    ) -> Result<Option<(PendingActionRecord, DecisionRecord)>, StoreError> {
        if action.kind != "approval" {
            return Ok(None);
        }
        let Some(context) = action.approval_context.clone() else {
            return Ok(None);
        };
        let context = serde_json::from_value::<ApprovalContextRecord>(context)
            .map_err(|_| StoreError::InvalidMutation)?;
        let Some(project_id) = context.project_id.as_deref() else {
            return Ok(None);
        };
        let policy = self.store.get_trust_policy(project_id).await?;
        let decision = action
            .available_decisions
            .iter()
            .find(|decision| decision.scope == "once")
            .cloned();
        let automatic = decision.is_some() && trust_policy::can_auto_allow(&context, &policy);
        self.store
            .insert_trust_audit(TrustAuditRecord {
                id: uuid::Uuid::now_v7().to_string(),
                project_id: project_id.into(),
                session_id: action.session_id.clone(),
                device_id: if automatic && !policy.updated_by_device_id.is_empty() {
                    policy.updated_by_device_id.clone()
                } else if automatic {
                    "local-policy".into()
                } else {
                    "system".into()
                },
                category: context.category,
                decision: if automatic { "auto_allowed" } else { "asked" }.into(),
                reason: if automatic {
                    format!("项目策略 {} 自动允许", policy.preset)
                } else {
                    context.reason
                },
                action_summary: action.detail.chars().take(500).collect(),
                created_at: action.created_at.clone(),
            })
            .await?;
        let Some(decision) = decision.filter(|_| automatic) else {
            return Ok(None);
        };
        self.store.upsert_action(action.clone()).await?;
        let mut resolved = action.clone();
        resolved.state = "resolved".into();
        resolved.resolved_at = Some(action.created_at.clone());
        let resolved = self.store.upsert_action(resolved).await?;
        Ok(Some((resolved, decision)))
    }

    pub async fn decide(&self, submission: DecisionSubmission) -> Result<ActionResult, StoreError> {
        let storage_key = format!("{}:{}", submission.device_id, submission.idempotency_key);
        if let Some(prior) = self.store.get_action_result(&storage_key).await? {
            return Ok(prior.result);
        }
        let Some(action) = self.store.get_action(&submission.action_id).await? else {
            return self
                .save_failure(&submission, &storage_key, "请求已过期或 Runtime 已重启。")
                .await;
        };
        if action.session_id != submission.session_id {
            return self
                .save_failure(&submission, &storage_key, "Session 与审批请求不匹配。")
                .await;
        }
        if action.state != "pending" {
            return self
                .save_failure(&submission, &storage_key, "请求已经处理。")
                .await;
        }
        let expires_at = chrono::DateTime::parse_from_rfc3339(&action.expires_at)
            .map_err(|_| StoreError::InvalidMutation)?;
        if expires_at <= Utc::now() {
            let _ = self.expire(&action.action_id).await;
            return self
                .save_failure(&submission, &storage_key, "请求已过期。")
                .await;
        }
        let Some(decision) = action
            .available_decisions
            .iter()
            .find(|decision| decision.id == submission.decision_id)
            .cloned()
        else {
            return self
                .save_failure(&submission, &storage_key, "上游不支持该决策。")
                .await;
        };
        if decision.confirmation_phrase != submission.confirmation_phrase
            && decision.confirmation_phrase.is_some()
        {
            let message = format!(
                "请输入确认短语：{}",
                decision.confirmation_phrase.as_deref().unwrap_or_default()
            );
            return self.save_failure(&submission, &storage_key, &message).await;
        }

        let resolver = self.resolvers.lock().await.remove(&action.action_id);
        let Some(resolver) = resolver else {
            return self
                .save_failure(&submission, &storage_key, "请求已过期或 Runtime 已重启。")
                .await;
        };
        resolver.timer.abort();
        let accepted = ActionResult {
            ok: true,
            message: "决策已提交给原始请求。".into(),
        };
        let resolved_at = now();
        match self
            .store
            .resolve_action(
                &action.action_id,
                &resolved_at,
                &storage_key,
                accepted.clone(),
            )
            .await
        {
            Ok(Some(_)) => {
                let _ = resolver.sender.send(Some(DecisionResolution {
                    decision,
                    input: submission.input,
                }));
                Ok(accepted)
            }
            Ok(None) => {
                let _ = resolver.sender.send(None);
                self.save_failure(&submission, &storage_key, "请求已经处理。")
                    .await
            }
            Err(error) => {
                let _ = resolver.sender.send(None);
                let _ = self.store.expire_action(&action.action_id, now()).await;
                Err(error)
            }
        }
    }

    pub async fn expire(&self, action_id: &str) -> Result<(), StoreError> {
        if let Some(resolver) = self.resolvers.lock().await.remove(action_id) {
            resolver.timer.abort();
            let _ = resolver.sender.send(None);
        }
        self.store.expire_action(action_id, now()).await.map(|_| ())
    }

    async fn expire_from_timer(&self, action_id: &str) -> Result<(), StoreError> {
        if let Some(resolver) = self.resolvers.lock().await.remove(action_id) {
            let _ = resolver.sender.send(None);
        }
        self.store.expire_action(action_id, now()).await.map(|_| ())
    }

    pub async fn cancel_all(&self) -> Result<(), StoreError> {
        let resolvers = std::mem::take(&mut *self.resolvers.lock().await);
        for (action_id, resolver) in resolvers {
            resolver.timer.abort();
            let _ = resolver.sender.send(None);
            self.store.expire_action(action_id, now()).await?;
        }
        Ok(())
    }

    async fn save_failure(
        &self,
        submission: &DecisionSubmission,
        storage_key: &str,
        message: &str,
    ) -> Result<ActionResult, StoreError> {
        self.store
            .save_action_result(
                storage_key,
                &submission.action_id,
                ActionResult {
                    ok: false,
                    message: message.into(),
                },
                now(),
            )
            .await
    }
}

fn validate_action(action: &PendingActionRecord) -> Result<(), StoreError> {
    let valid = matches!(action.kind.as_str(), "approval" | "input")
        && !action.session_id.is_empty()
        && !action.title.is_empty()
        && !action.available_decisions.is_empty()
        && action.available_decisions.iter().all(|decision| {
            !decision.id.is_empty()
                && matches!(
                    decision.scope.as_str(),
                    "once" | "session" | "persistent" | "deny" | "input"
                )
                && matches!(decision.risk.as_str(), "low" | "medium" | "high")
        });
    if valid {
        Ok(())
    } else {
        Err(StoreError::InvalidMutation)
    }
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
