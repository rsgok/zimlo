import { z } from "zod";

export const ProviderSchema = z.enum(["codex", "claude"]);
export type Provider = z.infer<typeof ProviderSchema>;

export const SessionSurfaceSchema = z.enum(["gui", "cli", "managed", "unknown"]);
export type SessionSurface = z.infer<typeof SessionSurfaceSchema>;

export const EventKindSchema = z.enum([
  "session_started",
  "user_instruction",
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

// A Host is one Mac running Zimlo Bridge.  It is intentionally separate from
// a paired client device: one user can view many Hosts from the same iPhone,
// while every command still has a single, explicit execution destination.
export const HostSchema = z.object({
  id: z.string().min(8).max(160),
  name: z.string().min(1).max(120),
  platform: z.literal("macos"),
  lastSeenAt: z.string(),
});
export type Host = z.infer<typeof HostSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  hostId: z.string().optional(),
  projectId: z.string().nullable().optional(),
  provider: ProviderSchema,
  surface: SessionSurfaceSchema,
  providerSessionId: z.string(),
  title: z.string(),
  projectName: z.string().nullable().optional(),
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
  hostId: z.string().optional(),
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
  approvalContext: z.lazy(() => ApprovalContextSchema).optional(),
});
export type PendingAction = z.infer<typeof PendingActionSchema>;

export const FeedPostKindSchema = z.enum([
  "progress",
  "decision",
  "attention",
  "result",
  "failure",
]);
export type FeedPostKind = z.infer<typeof FeedPostKindSchema>;

export const FeedTemplateSchema = z.enum(["paper", "grid", "sticky", "marker", "poster"]);
export type FeedTemplate = z.infer<typeof FeedTemplateSchema>;

export const MaterialKindSchema = z.enum(["image", "video", "pdf", "document"]);
export type MaterialKind = z.infer<typeof MaterialKindSchema>;

export const MaterialStatusSchema = z.enum(["ready", "failed"]);
export type MaterialStatus = z.infer<typeof MaterialStatusSchema>;

// Material bytes never travel in snapshots or WebSocket messages. This safe
// descriptor is all a paired client needs to render an attachment. Encryption
// keys and temporary transport locations are accepted only by material.register
// and are persisted separately on the Mac.
export const MaterialSchema = z.object({
  id: z.string().min(12).max(160),
  hostId: z.string().optional(),
  kind: MaterialKindSchema,
  name: z.string().min(1).max(180),
  mimeType: z.string().min(1).max(120),
  sizeBytes: z.number().int().positive().max(50 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  width: z.number().int().positive().max(20_000).optional(),
  height: z.number().int().positive().max(20_000).optional(),
  durationMs: z.number().int().positive().max(180_000).optional(),
  previewMaterialId: z.string().min(12).max(160).optional(),
  origin: z.enum(["user", "agent"]),
  status: MaterialStatusSchema,
  createdAt: z.string(),
  error: z.string().max(500).optional(),
});
export type Material = z.infer<typeof MaterialSchema>;

export const MaterialPublishInputSchema = z.object({
  path: z.string().min(1).max(2_000),
  name: z.string().min(1).max(180).optional(),
});
export type MaterialPublishInput = z.infer<typeof MaterialPublishInputSchema>;

export const FeedContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text") }),
  z.object({
    type: z.literal("image_album"),
    materialIds: z.array(z.string()).min(1).max(10),
    caption: z.string().max(240).optional(),
  }),
  z.object({
    type: z.literal("video"),
    materialId: z.string(),
    posterMaterialId: z.string().optional(),
    caption: z.string().max(240).optional(),
  }),
  z.object({
    type: z.literal("document"),
    materialId: z.string(),
    coverMaterialId: z.string().optional(),
    summary: z.string().max(320).optional(),
  }),
]);
export type FeedContent = z.infer<typeof FeedContentSchema>;

export const TaskStateSchema = z.enum([
  "running",
  "waiting_input",
  "reviewing",
  "user_review",
  "failed",
  "completed",
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const FeedPostInputSchema = z.object({
  task_id: z.string().min(1).max(160),
  kind: FeedPostKindSchema,
  template: FeedTemplateSchema,
  headline: z.string().min(1).max(72),
  takeaway: z.string().min(1).max(320),
  highlights: z.array(z.string().min(1).max(100)).max(3).default([]),
  proof: z.string().min(1).max(160).optional(),
  content: FeedContentSchema.optional(),
  dedupe_key: z.string().min(1).max(240),
  state: TaskStateSchema.optional(),
  state_reason: z.string().min(1).max(500).optional(),
}).strict().superRefine((value, context) => {
  if (Boolean(value.state) !== Boolean(value.state_reason)) {
    context.addIssue({
      code: "custom",
      path: value.state ? ["state_reason"] : ["state"],
      message: "state 与 state_reason 必须同时提供。",
    });
  }
  const requiredKind = value.state === "waiting_input"
    ? "attention"
    : value.state === "user_review" || value.state === "completed"
      ? "result"
      : value.state === "failed"
        ? "failure"
        : null;
  if (requiredKind && value.kind !== requiredKind) {
    context.addIssue({
      code: "custom",
      path: ["kind"],
      message: `state=${value.state} 必须使用 kind=${requiredKind}。`,
    });
  }
});
export type FeedPostInput = z.infer<typeof FeedPostInputSchema>;

export const FeedSkipInputSchema = z.object({
  task_id: z.string().min(1).max(160),
  reason: z.string().min(1).max(500),
});
export type FeedSkipInput = z.infer<typeof FeedSkipInputSchema>;

export const SignalTransitionInputSchema = z.object({
  task_id: z.string().min(1).max(160),
  state: TaskStateSchema,
  reason: z.string().min(1).max(500),
});
export type SignalTransitionInput = z.infer<typeof SignalTransitionInputSchema>;

export const FeedPostSchema = z.object({
  id: z.string(),
  hostId: z.string().optional(),
  projectId: z.string().nullable().optional(),
  taskId: z.string(),
  runId: z.string(),
  agentId: z.string(),
  sessionId: z.string().nullable(),
  kind: FeedPostKindSchema,
  template: FeedTemplateSchema,
  headline: z.string(),
  takeaway: z.string(),
  highlights: z.array(z.string()),
  proof: z.string().optional(),
  content: FeedContentSchema.optional(),
  dedupeKey: z.string(),
  source: z.literal("agent"),
  createdAt: z.string(),
});
export type FeedPost = z.infer<typeof FeedPostSchema>;

export const AgentProfileSchema = z.object({
  displayName: z.string(),
  avatar: z.string(),
  bio: z.string(),
  defaultProvider: ProviderSchema.nullable(),
  updatedAt: z.string(),
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const USER_AVATAR_IDS = [
  "user-01", "user-02", "user-03", "user-04", "user-05", "user-06",
  "user-07", "user-08", "user-09", "user-10", "user-11", "user-12",
  "user-13", "user-14", "user-15", "user-16", "user-17", "user-18",
  "user-19", "user-20", "user-21", "user-22", "user-23", "user-24",
] as const;

export const UserAvatarIdSchema = z.enum(USER_AVATAR_IDS);
export type UserAvatarId = z.infer<typeof UserAvatarIdSchema>;

export const UserProfileSchema = z.object({
  avatarId: UserAvatarIdSchema,
  updatedAt: z.string(),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  hostId: z.string().optional(),
  name: z.string(),
  primaryPath: z.string(),
  paths: z.array(z.string()),
  providers: z.array(ProviderSchema),
  sessionCount: z.number().int().nonnegative(),
  postCount: z.number().int().nonnegative(),
  agentProfile: AgentProfileSchema,
  createdAt: z.string(),
  lastUsedAt: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const IntegrationStatusSchema = z.object({
  id: z.enum(["codex_gui", "codex_cli", "claude_gui", "claude_cli"]),
  provider: ProviderSchema,
  surface: z.enum(["gui", "cli"]),
  state: z.enum(["ready", "partial", "shared", "unavailable"]),
  label: z.string(),
  detail: z.string(),
});
export type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;

export const TaskRecordSchema = z.object({
  id: z.string(),
  hostId: z.string().optional(),
  runId: z.string(),
  agentId: z.string(),
  sessionId: z.string().nullable(),
  state: TaskStateSchema,
  reason: z.string(),
  updatedAt: z.string(),
});
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

export const TaskCommandStateSchema = z.enum([
  "queued",
  "dispatching",
  "running",
  "completed",
  "failed",
  "canceled",
]);
export type TaskCommandState = z.infer<typeof TaskCommandStateSchema>;

export const TaskCommandSchema = z.object({
  id: z.string(),
  hostId: z.string().optional(),
  idempotencyKey: z.string(),
  kind: z.enum(["create", "follow_up"]),
  provider: ProviderSchema,
  sessionId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  cwd: z.string(),
  text: z.string(),
  materialIds: z.array(z.string()).max(10).optional(),
  state: TaskCommandStateSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  error: z.string().optional(),
});
export type TaskCommand = z.infer<typeof TaskCommandSchema>;

export const TrustedWorkspaceSchema = z.object({
  id: z.string(),
  hostId: z.string().optional(),
  label: z.string(),
  path: z.string(),
  providers: z.array(ProviderSchema),
  lastUsedAt: z.string(),
});
export type TrustedWorkspace = z.infer<typeof TrustedWorkspaceSchema>;

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

export const TaskPreferenceSchema = z.object({
  hostId: z.string().optional(),
  sessionId: z.string(),
  pinnedAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
});
export type TaskPreference = z.infer<typeof TaskPreferenceSchema>;

export const ApprovalCategorySchema = z.enum([
  "read",
  "search",
  "test",
  "build",
  "write",
  "network",
  "install",
  "git_publish",
  "destructive",
  "unknown",
]);
export type ApprovalCategory = z.infer<typeof ApprovalCategorySchema>;

export const ApprovalContextSchema = z.object({
  category: ApprovalCategorySchema,
  projectId: z.string().nullable(),
  cwd: z.string().nullable(),
  command: z.string().optional(),
  segments: z.array(z.string()).default([]),
  withinProject: z.boolean(),
  reason: z.string(),
});
export type ApprovalContext = z.infer<typeof ApprovalContextSchema>;

export const ProjectTrustPolicySchema = z.object({
  hostId: z.string().optional(),
  projectId: z.string(),
  preset: z.enum(["ask", "safe_automation"]),
  autoAllow: z.array(ApprovalCategorySchema),
  updatedAt: z.string(),
  updatedByDeviceId: z.string(),
});
export type ProjectTrustPolicy = z.infer<typeof ProjectTrustPolicySchema>;

export const TrustAuditEntrySchema = z.object({
  id: z.string(),
  hostId: z.string().optional(),
  projectId: z.string(),
  sessionId: z.string(),
  deviceId: z.string(),
  category: ApprovalCategorySchema,
  decision: z.enum(["auto_allowed", "asked", "denied"]),
  reason: z.string(),
  actionSummary: z.string(),
  createdAt: z.string(),
});
export type TrustAuditEntry = z.infer<typeof TrustAuditEntrySchema>;

export const NotificationSettingsSchema = z.object({
  enabled: z.boolean(),
  approvals: z.boolean(),
  results: z.boolean().default(true),
  failures: z.boolean(),
  criticalOnly: z.boolean().default(false),
  quietHoursEnabled: z.boolean().default(false),
  timeZoneOffsetMinutes: z.number().int().min(-840).max(840).default(0),
  showTaskTitle: z.boolean(),
  updatedAt: z.string(),
});
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;

export const PushDeviceRegistrationSchema = z.object({
  deviceId: z.string(),
  platform: z.literal("ios"),
  endpoint: z.string(),
  publicKey: z.string(),
  active: z.boolean(),
  environment: z.enum(["development", "production"]).default("production"),
  registeredAt: z.string(),
  updatedAt: z.string(),
  lastDeliveryKind: z.enum(["approval", "approval_reminder", "result", "failure"]).optional(),
  lastDeliveryStatus: z.number().int().optional(),
  lastDeliveryAt: z.string().optional(),
});
export type PushDeviceRegistration = z.infer<typeof PushDeviceRegistrationSchema>;

// Versioned payload sealed into push routes (sealPushRoute). Version 1 keeps
// the original sessionId/taskTitle fields and adds optional deep-link fields
// so a notification can jump straight to a pending approval. For low-risk
// approvals, `decision`/`denyDecision` carry the once-allow and deny decision
// ids so the lock screen can offer both quick actions without a round trip;
// the server still re-validates state, device permission and idempotency.
export const PushRouteV1Schema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  taskTitle: z.string().optional(),
  summary: z.string().max(120).optional(),
  actionId: z.string().optional(),
  decision: z.string().optional(),
  denyDecision: z.string().optional(),
  expiresAt: z.string().optional(),
  category: ApprovalCategorySchema.optional(),
});
export type PushRouteV1 = z.infer<typeof PushRouteV1Schema>;

export const FeatureCapabilitiesSchema = z.object({
  projectTrustPolicy: z.boolean(),
  pushNotifications: z.boolean(),
  remoteSync: z.boolean(),
  multiHost: z.boolean().optional(),
});
export type FeatureCapabilities = z.infer<typeof FeatureCapabilitiesSchema>;

export const FEATURE_CAPABILITIES: FeatureCapabilities = {
  projectTrustPolicy: true,
  pushNotifications: true,
  remoteSync: true,
  multiHost: true,
};

export const EMPTY_FEATURE_CAPABILITIES: FeatureCapabilities = {
  projectTrustPolicy: false,
  pushNotifications: false,
  remoteSync: false,
  multiHost: false,
};

export const SnapshotSchema = z.object({
  host: HostSchema.optional(),
  userProfile: UserProfileSchema,
  projects: z.array(ProjectSchema),
  sessions: z.array(SessionSchema),
  cards: z.array(FeedCardSchema),
  posts: z.array(FeedPostSchema),
  materials: z.array(MaterialSchema).default([]),
  tasks: z.array(TaskRecordSchema),
  commands: z.array(TaskCommandSchema),
  workspaces: z.array(TrustedWorkspaceSchema),
  seenPostIds: z.array(z.string()),
  dismissedFeedItemIds: z.array(z.string()),
  taskTimelineCursors: z.record(z.string(), z.string()),
  taskPreferences: z.array(TaskPreferenceSchema),
  actions: z.array(PendingActionSchema),
  trustPolicies: z.array(ProjectTrustPolicySchema),
  trustAudit: z.array(TrustAuditEntrySchema),
  notificationSettings: NotificationSettingsSchema,
  pushDevices: z.array(PushDeviceRegistrationSchema),
  features: FeatureCapabilitiesSchema,
  sequence: z.number().int().nonnegative(),
  lanApprovalsEnabled: z.boolean(),
  trustManagementEnabled: z.boolean(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

const ClientCommandPayloadSchema = z.discriminatedUnion("type", [
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
    materialIds: z.array(z.string()).max(10).optional(),
    idempotencyKey: z.string(),
  }),
  z.object({
    type: z.literal("task.create"),
    provider: ProviderSchema,
    workspaceId: z.string(),
    text: z.string().min(1).max(20_000),
    materialIds: z.array(z.string()).max(10).optional(),
    idempotencyKey: z.string(),
  }),
  z.object({
    type: z.literal("task.follow_up"),
    sessionId: z.string(),
    text: z.string().min(1).max(20_000),
    materialIds: z.array(z.string()).max(10).optional(),
    idempotencyKey: z.string(),
  }),
  z.object({
    type: z.literal("material.register"),
    material: MaterialSchema.omit({ status: true, error: true }),
    transport: z.enum(["local", "cloud"]),
    encryptionKey: z.string().min(40).max(80),
    idempotencyKey: z.string(),
  }),
  z.object({
    type: z.literal("material.remote.request"),
    materialId: z.string().regex(/^material_[a-zA-Z0-9_-]{12,140}$/u),
  }),
  z.object({
    type: z.literal("task.command.retry"),
    commandId: z.string(),
    idempotencyKey: z.string(),
  }),
  // 服务端仅允许取消 queued 状态的命令；dispatching/running/终态返回 command_not_cancelable。
  z.object({
    type: z.literal("task.command.cancel"),
    commandId: z.string().optional(),
    idempotencyKey: z.string().optional(),
  }).superRefine((command, context) => {
    if ((command.commandId === undefined) === (command.idempotencyKey === undefined)) {
      context.addIssue({ code: "custom", message: "commandId 与 idempotencyKey 必须恰选其一" });
    }
  }),
  z.object({ type: z.literal("feed.seen"), postId: z.string() }),
  z.object({ type: z.literal("feed.dismiss"), itemId: z.string().min(1).max(240) }),
  z.object({
    type: z.literal("feed.dismiss.set"),
    itemId: z.string().min(1).max(240),
    dismissed: z.boolean(),
    idempotencyKey: z.string(),
  }),
  z.object({ type: z.literal("task.timeline.seen"), sessionId: z.string(), itemId: z.string().min(1).max(240) }),
  z.object({ type: z.literal("task.pin"), sessionId: z.string(), pinned: z.boolean(), idempotencyKey: z.string().optional() }),
  z.object({ type: z.literal("task.archive"), sessionId: z.string(), archived: z.boolean(), idempotencyKey: z.string().optional() }),
  z.object({ type: z.literal("trust.policy.get"), projectId: z.string().optional() }),
  z.object({
    type: z.literal("trust.policy.update"),
    projectId: z.string(),
    preset: z.enum(["ask", "safe_automation"]),
    idempotencyKey: z.string(),
  }),
  z.object({ type: z.literal("notification.settings.get") }),
  z.object({
    type: z.literal("notification.settings.update"),
    settings: NotificationSettingsSchema.omit({ updatedAt: true }),
    idempotencyKey: z.string(),
  }),
  z.object({
    type: z.literal("notification.device.register"),
    endpoint: z.string().min(1).max(2_000).optional(),
    token: z.string().min(1).max(2_000).optional(),
    publicKey: z.string().min(1).max(2_000),
    environment: z.enum(["development", "production"]).optional(),
    idempotencyKey: z.string(),
  }),
  z.object({
    type: z.literal("notification.device.unregister"),
    idempotencyKey: z.string(),
  }),
  z.object({ type: z.literal("user.profile.update"), avatarId: UserAvatarIdSchema }),
  z.object({
    type: z.literal("agent.profile.update"),
    projectId: z.string(),
    displayName: z.string().min(1).max(80),
    avatar: z.string().min(1).max(16),
    bio: z.string().max(280),
    defaultProvider: ProviderSchema.nullable(),
    // Optional for backwards compatibility with older mobile clients.
    idempotencyKey: z.string().optional(),
  }),
  z.object({ type: z.literal("session.events.request"), sessionId: z.string() }),
  z.object({ type: z.literal("devices.request") }),
  z.object({ type: z.literal("device.revoke"), deviceId: z.string() }),
  z.object({ type: z.literal("integrations.request") }),
  z.object({ type: z.literal("integrations.cli.install") }),
  z.object({ type: z.literal("device.approvals.set"), deviceId: z.string(), enabled: z.boolean() }),
  z.object({ type: z.literal("device.trust.set"), deviceId: z.string(), enabled: z.boolean() }),
  z.object({ type: z.literal("codex.plugin.request") }),
  z.object({ type: z.literal("codex.plugin.install") }),
  z.object({ type: z.literal("pairing.create") }),
  z.object({ type: z.literal("lan.approvals.set"), enabled: z.boolean() }),
]);
export const ClientCommandSchema = ClientCommandPayloadSchema.and(z.object({
  // Client-only routing hint. A Host Bridge accepts it but execution remains
  // scoped to the authenticated connection, so it cannot redirect commands.
  hostId: z.string().optional(),
}));
export type ClientCommand = z.infer<typeof ClientCommandSchema>;

export type ServerMessage =
  | { type: "session.snapshot"; snapshot: Snapshot }
  | { type: "user.profile.updated"; userProfile: UserProfile }
  | { type: "project.updated"; project: Project }
  | { type: "session.updated"; session: Session }
  | { type: "session.removed"; sessionId: string }
  | { type: "event.upsert"; event: UnifiedEvent }
  | { type: "card.upsert"; card: FeedCard }
  | { type: "feed.posted"; post: FeedPost }
  | { type: "material.updated"; material: Material }
  | { type: "task.updated"; task: TaskRecord }
  | { type: "task.command.updated"; command: TaskCommand }
  | { type: "task.command.cancel.result"; commandId?: string; idempotencyKey?: string; ok: boolean; message: string }
  | { type: "feed.seen.updated"; postId: string }
  | { type: "feed.dismissed.updated"; itemId: string }
  | { type: "task.timeline.seen.updated"; sessionId: string; itemId: string }
  | { type: "task.preference.updated"; preference: TaskPreference }
  | { type: "trust.policy.updated"; policy: ProjectTrustPolicy }
  | { type: "trust.policies"; policies: ProjectTrustPolicy[]; audit: TrustAuditEntry[] }
  | { type: "notification.settings.updated"; settings: NotificationSettings }
  | { type: "notification.device.updated"; registration: PushDeviceRegistration | null }
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
        canApprove: boolean;
        canManageTrust: boolean;
      }>;
    }
  | { type: "pairing.created"; pairingId: string; pairUrl: string; qrDataUrl: string; expiresAt: string }
  | { type: "lan.approvals.changed"; enabled: boolean }
  | { type: "integrations.status"; integrations: IntegrationStatus[] }
  | {
      type: "codex.plugin.status";
      installed: boolean;
      detail: string;
      pluginPath: string;
      deepLink: string;
    }
  | { type: "error"; code: string; message: string; commandType?: string; idempotencyKey?: string };

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

export * from "./policy.js";
