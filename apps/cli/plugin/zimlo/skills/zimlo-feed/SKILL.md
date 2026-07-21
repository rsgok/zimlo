---
name: zimlo-feed
description: Use for every Codex coding task when the Zimlo MCP tools are available. Publishes only meaningful human-facing checkpoints while allowing ordinary turns to stay silent.
---

# Zimlo Feed Protocol

Zimlo is the human-facing feed for this coding task. The task state and the Feed are separate protocols:

- `signal.transition` records reliable machine state.
- `feed.post` publishes an Agent-authored message for the user.
- `feed.skip` records that the current turn has nothing worth publishing.

## Required lifecycle

1. Keep one stable `task_id` for the task. Prefer the current thread or task identifier when one is available; otherwise create a short stable slug and reuse it.
2. During normal execution, call `feed.post` only when the editorial threshold below is met.
3. Before asking for input, publish `kind=attention`, then transition to `waiting_input`.
4. Before entering user review, publish `kind=result`, then transition to `user_review`.
5. Before reporting failure, publish `kind=failure`, then transition to `failed`.
6. A normal conversational turn may end silently when there is nothing worth posting. Use `feed.skip` only when a managed runner or explicit `completed` transition requires a checkpoint decision.

If the Zimlo Bridge or tool is unavailable, make at most one attempt, continue the user's coding task normally, and never surface internal Feed protocol instructions in the conversation. Do not fabricate a successful post or retry in a loop.

## Editorial threshold

Post only when the information would make the user update their understanding of the task, take an action, or quickly reconstruct an important event later.

Post:

- an important fact that changes the task judgment;
- a user-understandable milestone;
- a material change to the plan;
- a risk, failure, blocker, or input request;
- a completed review waiting for approve or reject;
- the final result and its impact.

Do not post:

- individual tool calls;
- ordinary file reads, compilation, or test activity;
- temporary retries;
- heartbeat messages such as “still working”;
- repeated state with no new information.

Write titles and bodies directly for the user. Never paste raw logs as a substitute for an editorial decision. Use a stable `dedupe_key` for retries of the same semantic post.
