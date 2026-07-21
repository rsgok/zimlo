import { z } from "zod";

export const ProviderSchema = z.enum(["codex", "claude"]);
export type Provider = z.infer<typeof ProviderSchema>;

export const EventKindSchema = z.enum([
  "session_started",
  "plan_updated",
  "files_changed",
  "command_started",
  "command_completed",
  "tests_passed",
  "tests_failed",
  "needs_input",
  "needs_approval",
  "blocked",
  "completed",
  "failed",
  "session_ended",
]);
export type EventKind = z.infer<typeof EventKindSchema>;

export const EventSourceSchema = z.enum([
  "process",
  "transcript",
  "hook",
  "app_server",
  "managed_runner",
]);
export type EventSource = z.infer<typeof EventSourceSchema>;

export const ProvenanceSchema = z.enum(["verified", "agent_reported", "inferred"]);
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const SessionCapabilitiesSchema = z.object({
  discovered: z.boolean(),
  liveObserved: z.boolean(),
  replyable: z.boolean(),
  approvableOnce: z.boolean(),
  approvableSession: z.boolean(),
  approvablePersistent: z.boolean(),
  resumable: z.boolean(),
  diffAvailable: z.boolean(),
});
export type SessionCapabilities = z.infer<typeof SessionCapabilitiesSchema>;

export const UnifiedEventSchema = z.object({
  id: z.string(),
  sequence: z.number().int().nonnegative(),
  provider: ProviderSchema,
  sessionId: z.string(),
  providerSessionId: z.string(),
  turnId: z.string().optional(),
  itemId: z.string().optional(),
  kind: EventKindSchema,
  source: EventSourceSchema,
  occurredAt: z.string(),
  payload: z.unknown(),
  provenance: ProvenanceSchema,
});
export type UnifiedEvent = z.infer<typeof UnifiedEventSchema>;

export const SessionStatusSchema = z.enum([
  "running",
  "waiting",
  "idle",
  "completed",
  "failed",
  "ended",
  "unknown",
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  provider: ProviderSchema,
  providerSessionId: z.string(),
  title: z.string(),
  cwd: z.string().nullable(),
  transcriptPath: z.string().nullable(),
  status: SessionStatusSchema,
  lastActivityAt: z.string(),
  createdAt: z.string(),
  activePid: z.number().int().positive().nullable(),
  processStartedAt: z.string().nullable(),
  tty: z.string().nullable(),
  correlationUncertain: z.boolean(),
  capabilities: SessionCapabilitiesSchema,
});
export type Session = z.infer<typeof SessionSchema>;

export const DecisionSchema = z.object({
  id: z.string(),
  label: z.string(),
  scope: z.enum(["once", "session", "persistent", "deny", "input"]),
  value: z.unknown(),
  confirmationPhrase: z.string().optional(),
  risk: z.enum(["low", "medium", "high"]),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const PendingActionSchema = z.object({
  actionId: z.string(),
  sessionId: z.string(),
  upstreamRequestId: z.string().optional(),
  kind: z.enum(["input", "approval"]),
  title: z.string(),
  detail: z.string(),
  availableDecisions: z.array(DecisionSchema),
  expiresAt: z.string(),
  state: z.enum(["pending", "submitted", "resolved", "expired"]),
  createdAt: z.string(),
  resolvedAt: z.string().optional(),
});
export type PendingAction = z.infer<typeof PendingActionSchema>;

export const FeedPostKindSchema = z.enum([
  "instruction",
  "progress",
  "decision",
  "attention",
  "result",
  "failure",
]);
export type FeedPostKind = z.infer<typeof FeedPostKindSchema>;

export const FeedActionSchema = z.enum(["approve", "reject", "reply", "open_diff"]);
export type FeedAction = z.infer<typeof FeedActionSchema>;

export const FeedPostInputSchema = z.object({
  task_id: z.string().min(1).max(160),
  kind: FeedPostKindSchema.exclude(["instruction"]),
  title: z.string().min(1).max(160),
  body: z.string().min(1).max(4_000),
  action_required: z.boolean().default(false),
  actions: z.array(FeedActionSchema).max(4).default([]),
  dedupe_key: z.string().min(1).max(240),
});
export type FeedPostInput = z.infer<typeof FeedPostInputSchema>;

export const FeedSkipInputSchema = z.object({
  task_id: z.string().min(1).max(160),
  reason: z.string().min(1).max(500),
});
export type FeedSkipInput = z.infer<typeof FeedSkipInputSchema>;

export const TaskStateSchema = z.enum([
  "running",
  "waiting_input",
  "reviewing",
  "user_review",
  "failed",
  "completed",
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const SignalTransitionInputSchema = z.object({
  task_id: z.string().min(1).max(160),
  state: TaskStateSchema,
  reason: z.string().min(1).max(500),
});
export type SignalTransitionInput = z.infer<typeof SignalTransitionInputSchema>;

export const FeedPostSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  runId: z.string(),
  agentId: z.string(),
  sessionId: z.string().nullable(),
  kind: FeedPostKindSchema,
  title: z.string(),
  body: z.string(),
  actionRequired: z.boolean(),
  actions: z.array(FeedActionSchema),
  pendingActionIds: z.array(z.string()),
  dedupeKey: z.string(),
  source: z.enum(["user", "agent"]),
  createdAt: z.string(),
});
export type FeedPost = z.infer<typeof FeedPostSchema>;

export const TaskRecordSchema = z.object({
  id: z.string(),
  runId: z.string(),
  agentId: z.string(),
  sessionId: z.string().nullable(),
  state: TaskStateSchema,
  reason: z.string(),
  updatedAt: z.string(),
});
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

export const FeedCardSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  turnId: z.string().nullable(),
  kind: z.enum(["attention", "progress", "result", "completed", "failure"]),
  title: z.string(),
  summary: z.string(),
  priority: z.number().int(),
  status: z.enum(["active", "resolved"]),
  actionIds: z.array(z.string()),
  updatedAt: z.string(),
  provenance: ProvenanceSchema,
});
export type FeedCard = z.infer<typeof FeedCardSchema>;

export const SnapshotSchema = z.object({
  sessions: z.array(SessionSchema),
  cards: z.array(FeedCardSchema),
  posts: z.array(FeedPostSchema),
  tasks: z.array(TaskRecordSchema),
  actions: z.array(PendingActionSchema),
  sequence: z.number().int().nonnegative(),
  lanApprovalsEnabled: z.boolean(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const ClientCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot.request"), afterSequence: z.number().int().optional() }),
  z.object({
    type: z.literal("action.decide"),
    actionId: z.string(),
    sessionId: z.string(),
    decisionId: z.string(),
    idempotencyKey: z.string(),
    confirmationPhrase: z.string().optional(),
    input: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    type: z.literal("session.message"),
    sessionId: z.string(),
    text: z.string().min(1).max(20_000),
    idempotencyKey: z.string(),
  }),
  z.object({ type: z.literal("session.events.request"), sessionId: z.string() }),
  z.object({ type: z.literal("devices.request") }),
  z.object({ type: z.literal("codex.plugin.request") }),
  z.object({ type: z.literal("codex.plugin.install") }),
  z.object({ type: z.literal("pairing.create") }),
  z.object({ type: z.literal("lan.approvals.set"), enabled: z.boolean() }),
]);
export type ClientCommand = z.infer<typeof ClientCommandSchema>;

export type ServerMessage =
  | { type: "session.snapshot"; snapshot: Snapshot }
  | { type: "session.updated"; session: Session }
  | { type: "session.removed"; sessionId: string }
  | { type: "event.upsert"; event: UnifiedEvent }
  | { type: "card.upsert"; card: FeedCard }
  | { type: "feed.posted"; post: FeedPost }
  | { type: "task.updated"; task: TaskRecord }
  | { type: "action.upsert"; action: PendingAction }
  | { type: "action.result"; actionId: string; ok: boolean; message: string }
  | { type: "session.message.result"; sessionId: string; ok: boolean; message: string }
  | { type: "session.events"; sessionId: string; events: UnifiedEvent[] }
  | { type: "capabilities.changed"; sessionId: string; capabilities: SessionCapabilities }
  | {
      type: "devices.list";
      devices: Array<{
        id: string;
        name: string;
        createdAt: string;
        lastSeenAt: string;
        revokedAt: string | null;
        isLocalAdmin: boolean;
      }>;
    }
  | { type: "pairing.created"; pairUrl: string; qrDataUrl: string; expiresAt: string }
  | { type: "lan.approvals.changed"; enabled: boolean }
  | {
      type: "codex.plugin.status";
      installed: boolean;
      detail: string;
      pluginPath: string;
      deepLink: string;
    }
  | { type: "error"; code: string; message: string };

export const EMPTY_CAPABILITIES: SessionCapabilities = {
  discovered: true,
  liveObserved: false,
  replyable: false,
  approvableOnce: false,
  approvableSession: false,
  approvablePersistent: false,
  resumable: true,
  diffAvailable: false,
};
