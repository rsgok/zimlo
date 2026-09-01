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
- `presentation`: always provide all six keys. Prefer `auto` unless a visual choice materially improves the message; Bridge resolves `auto` to a stable, fully explicit card before storage.
- `blocks`: optional structured facts, metrics, steps, quotes, or comparisons. Use them only when they make evidence easier to scan; they never grant or represent interaction permissions.

## Card presentation

The tool schema is the source of truth and includes descriptions for every selectable value. You may choose:

- `system`: `editorial` for narrative/judgment/summary, `swiss` for metrics/steps/comparison/evidence/alerts.
- Editorial themes: `ink_classic`, `indigo_porcelain`, `forest_ink`, `kraft_paper`, `dune`, `midnight_ink`.
- Swiss themes: `ikb`, `lemon`, `lemon_green`, `safety_orange`.
- Editorial layouts: `feature`, `field_note`, `quote`, `story_split`, `media_quiet_zone`, `document_excerpt`.
- Swiss layouts: `metric_grid`, `status_board`, `evidence_top`, `comparison`, `steps`, `alert`.
- `typography`: `serif`, `sans`, `mono`, `rounded`; these are semantic system-font roles, not arbitrary font names.
- `density`: `airy`, `balanced`, `compact`.
- `mediaPlacement`: `hero`, `full_bleed`, `split`, `evidence`, `inline`.

Every presentation key also accepts `auto`. Do not send raw CSS, hex colors, font family names, HTML, or rendering instructions. Explicit themes and layouts must belong to the chosen system. Layouts such as `metric_grid`, `quote`, `comparison`, and `steps` require the matching block; media layouts require registered media; `alert` requires `attention` or `failure`.

If Zimlo is unavailable, try once and continue the coding task. Never claim a post succeeded without confirmation.

## Media

For a final image, video, PDF, or document inside the workspace, call `material.publish`, then reference its `material_id` from `feed.post.content`. Never paste binary data, base64, raw file contents, or local paths into card copy.
