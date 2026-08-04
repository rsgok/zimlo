---
name: zimlo-feed
description: Use for every Codex coding task when the Zimlo MCP tools are available. Publishes only meaningful, human-readable deliverables; ordinary turns stay silent.
---

# Zimlo Feed

Zimlo is an attention feed, not a transcript or log stream. It does not call another model: you decide whether a card is worthwhile and write it with `feed.post`.

## Default: stay silent

Do not call Zimlo for ordinary replies, reads, searches, tool calls, builds, tests, retries, plans, raw logs, heartbeats, or repeated status. A turn can end without any Zimlo call.

Post only when one of these is true:

- the user must act and no approval/structured-input hook already represents it;
- a reviewable intermediate deliverable exists now, with material or concrete verification proof;
- a terminal failure changes the user's next action;
- the final result is ready.

Keep one stable `task_id`. Reuse the same `dedupe_key` for retries. Nearby `progress` posts for one task are coalesced by the server.

## One-call lifecycle

Use optional `state` and `state_reason` on `feed.post` to publish and update task state together:

- important input needed: `kind=attention`, `state=waiting_input`;
- ready for review: `kind=result`, `state=user_review`;
- terminal failure: `kind=failure`, `state=failed`;
- fully finished with no review step: `kind=result`, `state=completed`.

`progress` means an inspectable delivery checkpoint, never activity. It requires `proof` or registered media. Use `state=running` or `reviewing` only when a state update adds real value.

## Editorial frame

Write in the user's primary language and order the card as: conclusion → user impact → key facts → proof → next step.

- `headline`: changed reality, not “progress update” or “completed”.
- `takeaway`: why the user should care now, in one or two sentences.
- `highlights`: up to three verifiable facts.
- `proof`: the strongest concise check or first-party fact, never raw logs.
- `template`: `paper` for summaries, `grid` for evidence, `sticky` for decisions, `marker` for attention, `poster` for one major result.

If Zimlo is unavailable, try once and continue the coding task. Never claim a post succeeded without confirmation.

## Media

For a final image, video, PDF, or document inside the workspace, call `material.publish`, then reference its `material_id` from `feed.post.content`. Never paste binary data, base64, raw file contents, or local paths into card copy.
