---
name: zimlo-feed
description: Use for every Codex coding task when the Zimlo MCP tools are available. Publishes only meaningful, human-readable checkpoints while allowing ordinary turns to stay silent.
---

# Zimlo Feed Protocol V2

Zimlo is the user's attention feed for this coding task. It is not a transcript, log stream, or task-state database.

- `signal.transition` records reliable machine state.
- `feed.post` publishes one Agent-edited reading card.
- `feed.skip` records that a managed checkpoint has nothing worth publishing.

## Lifecycle

1. Keep one stable `task_id` for the task.
2. Post only when the information changes the user's judgment, action, or confidence.
3. Before asking for input, publish `kind=attention`, then transition to `waiting_input`.
4. Before entering user review, publish `kind=result`, then transition to `user_review`.
5. Before reporting failure, publish `kind=failure`, then transition to `failed`.
6. A normal turn may end silently. Use `feed.skip` only for a managed runner or explicit `completed` checkpoint.

If Zimlo is unavailable, make at most one attempt and continue the coding task normally. Never claim a post succeeded without confirmation.

## Editorial gate

Publish only:

- a milestone that materially changes what the user can now do;
- a new fact that changes the plan or confidence in it;
- a decision, risk, failure, blocker, or input request;
- a result ready for review, or the final result and its impact.

Keep silent for:

- ordinary file reads, searches, tool calls, builds, or test execution;
- raw logs, internal protocol details, temporary retries, or heartbeat updates;
- repeated progress with no new user consequence;
- the user's original prompt, which belongs in Task details.

## Writing frame

Every post follows this reading order:

> Conclusion → user impact → key facts → proof → next step

- `headline`: State the changed reality in outcome language. Avoid empty labels such as “Progress update”, “Task completed”, or “Update”.
- `takeaway`: In one or two sentences, explain why this deserves the user's attention now.
- `highlights`: Add at most three verifiable facts. Each item expresses one fact, not a paragraph.
- `proof`: Add the single strongest test, check, or first-party fact. Never paste raw logs.
- `action_prompt`: When action is required, ask one direct question and recommend a default when appropriate.
- Write in the user's primary language. Prefer user and product impact over internal symbol names.

## Kind guide

- `progress`: A meaningful milestone and how it changes confidence or what remains.
- `decision`: What was learned, what changed, and why the new direction is better.
- `attention`: What needs the user, why it cannot proceed safely, and the recommended response.
- `result`: What the user can now do, how it was verified, and any remaining boundary.
- `failure`: What failed, the impact, what was ruled out, and the recovery path.

## Template guide

Choose exactly one visual template. Do not request colors, fonts, or CSS.

- `paper`: Explanations, ordinary results, and complete summaries.
- `grid`: Progress, checklists, or evidence-heavy milestones.
- `sticky`: Discoveries, decisions, and changes of direction.
- `marker`: Risks, approvals, input requests, and urgent attention.
- `poster`: A major result that stands on one short statement.

## Examples

Good result:

```json
{
  "task_id": "auth-refresh",
  "kind": "result",
  "template": "paper",
  "headline": "登录刷新不再重复提交",
  "takeaway": "刷新竞态已经被消除，用户在弱网下也不会被重复登出。",
  "highlights": ["刷新请求现在只保留一个在途实例", "失败时仍保留原有会话"],
  "proof": "认证定向测试与完整构建均通过",
  "action_required": false,
  "actions": ["open_diff"],
  "dedupe_key": "auth-refresh:result"
}
```

Good attention post:

```json
{
  "task_id": "storage-migration",
  "kind": "attention",
  "template": "marker",
  "headline": "旧客户端会阻止这次迁移",
  "takeaway": "继续发布会让仍在使用旧协议的客户端无法读取新记录。",
  "highlights": ["线上仍有两个旧版本设备"],
  "proof": "设备列表与服务端版本统计一致",
  "action_required": true,
  "action_prompt": "建议先保留兼容读取一版；是否按此方案继续？",
  "actions": ["reply"],
  "dedupe_key": "storage-migration:compat-choice"
}
```

Bad post:

```json
{
  "headline": "阶段进展",
  "takeaway": "读取了文件，运行了测试，正在继续处理。"
}
```

It has no changed reality, user impact, evidence, or decision and must not be published.
