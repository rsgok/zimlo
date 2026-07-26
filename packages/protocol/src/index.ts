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

export const SessionSchema = z.object({
  id: z.string(),
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

export const FeedActionSchema = z.enum(["approve", "reject", "reply", "open_diff"]);
export type FeedAction = z.infer<typeof FeedActionSchema>;

export const FeedPostInputSchema = z.object({
  task_id: z.string().min(1).max(160),
  kind: FeedPostKindSchema,
  template: FeedTemplateSchema,
  headline: z.string().min(1).max(72),
  takeaway: z.string().min(1).max(320),
  highlights: z.array(z.string().min(1).max(100)).max(3).default([]),
  proof: z.string().min(1).max(160).optional(),
  action_required: z.boolean().default(false),
  action_prompt: z.string().min(1).max(240).optional(),
  actions: z.array(FeedActionSchema).max(4).default([]),
  dedupe_key: z.string().min(1).max(240),
}).superRefine((post, context) => {
  if (post.action_required && !post.action_prompt) {
    context.addIssue({ code: "custom", path: ["action_prompt"], message: "需要用户处理时必须提供 action_prompt" });
  }
  if (!post.action_required && post.action_prompt) {
    context.addIssue({ code: "custom", path: ["action_prompt"], message: "无需用户处理时不能提供 action_prompt" });
  }
  if (post.action_required && !post.actions.some((action) => action === "reply" || action === "approve" || action === "reject")) {
    context.addIssue({ code: "custom", path: ["actions"], message: "需要用户处理时必须提供 reply、approve 或 reject 操作" });
  }
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
  actionRequired: z.boolean(),
  actionPrompt: z.string().optional(),
  actions: z.array(FeedActionSchema),
  pendingActionIds: z.array(z.string()),
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
  idempotencyKey: z.string(),
  kind: z.enum(["create", "follow_up"]),
  provider: ProviderSchema,
  sessionId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  cwd: z.string(),
  text: z.string(),
  state: TaskCommandStateSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  error: z.string().optional(),
});
export type TaskCommand = z.infer<typeof TaskCommandSchema>;

export const TrustedWorkspaceSchema = z.object({
  id: z.string(),
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
  sessionId: z.string(),
  pinnedAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
});
export type TaskPreference = z.infer<typeof TaskPreferenceSchema>;

export const ReviewStateSchema = z.enum(["unreviewed", "accepted", "changes_requested", "superseded"]);
export type ReviewState = z.infer<typeof ReviewStateSchema>;

export const ReviewEvidenceSourceSchema = z.enum(["app_server", "hook", "agent_reported"]);
export type ReviewEvidenceSource = z.infer<typeof ReviewEvidenceSourceSchema>;

export const ReviewEvidenceSchema = z.object({
  source: ReviewEvidenceSourceSchema,
  label: z.string(),
  detail: z.string(),
});
export type ReviewEvidence = z.infer<typeof ReviewEvidenceSchema>;

export const ReviewBundleSchema = z.object({
  conclusion: z.string(),
  impact: z.string().optional(),
  changedFiles: z.array(z.string()),
  diffSummary: z.string().optional(),
  tests: z.array(ReviewEvidenceSchema),
  links: z.array(z.object({ label: z.string(), url: z.string() })),
  evidenceSource: ReviewEvidenceSourceSchema,
});
export type ReviewBundle = z.infer<typeof ReviewBundleSchema>;

export const TaskReviewSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  sessionId: z.string(),
  postId: z.string(),
  version: z.number().int().positive(),
  state: ReviewStateSchema,
  bundle: ReviewBundleSchema,
  decisionNote: z.string().optional(),
  decidedByDeviceId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  legacy: z.boolean(),
});
export type TaskReview = z.infer<typeof TaskReviewSchema>;

export const ReviewDecisionSchema = z.enum(["accept", "request_changes"]);
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

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
  projectId: z.string(),
  preset: z.enum(["ask", "safe_automation"]),
  autoAllow: z.array(ApprovalCategorySchema),
  updatedAt: z.string(),
  updatedByDeviceId: z.string(),
});
export type ProjectTrustPolicy = z.infer<typeof ProjectTrustPolicySchema>;

export const TrustAuditEntrySchema = z.object({
  id: z.string(),
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
  failures: z.boolean(),
  reviews: z.boolean(),
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
  registeredAt: z.string(),
  updatedAt: z.string(),
});
export type PushDeviceRegistration = z.infer<typeof PushDeviceRegistrationSchema>;

export const FeatureCapabilitiesSchema = z.object({
  taskReview: z.boolean(),
  projectTrustPolicy: z.boolean(),
  pushNotifications: z.boolean(),
});
export type FeatureCapabilities = z.infer<typeof FeatureCapabilitiesSchema>;

export const FEATURE_CAPABILITIES: FeatureCapabilities = {
  taskReview: true,
  projectTrustPolicy: true,
  pushNotifications: true,
};

export const EMPTY_FEATURE_CAPABILITIES: FeatureCapabilities = {
  taskReview: false,
  projectTrustPolicy: false,
  pushNotifications: false,
};

export const SnapshotSchema = z.object({
  userProfile: UserProfileSchema,
  projects: z.array(ProjectSchema),
  sessions: z.array(SessionSchema),
  cards: z.array(FeedCardSchema),
  posts: z.array(FeedPostSchema),
  tasks: z.array(TaskRecordSchema),
  commands: z.array(TaskCommandSchema),
  workspaces: z.array(TrustedWorkspaceSchema),
  seenPostIds: z.array(z.string()),
  dismissedFeedItemIds: z.array(z.string()),
  taskTimelineCursors: z.record(z.string(), z.string()),
  taskPreferences: z.array(TaskPreferenceSchema),
  actions: z.array(PendingActionSchema),
  reviews: z.array(TaskReviewSchema),
  trustPolicies: z.array(ProjectTrustPolicySchema),
  trustAudit: z.array(TrustAuditEntrySchema),
  notificationSettings: NotificationSettingsSchema,
  pushDevices: z.array(PushDeviceRegistrationSchema),
  features: FeatureCapabilitiesSchema,
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
  z.object({
    type: z.literal("task.create"),
    provider: ProviderSchema,
    workspaceId: z.string(),
    text: z.string().min(1).max(20_000),
    idempotencyKey: z.string(),
  }),
  z.object({
    type: z.literal("task.follow_up"),
    sessionId: z.string(),
    text: z.string().min(1).max(20_000),
    idempotencyKey: z.string(),
  }),
  z.object({
    type: z.literal("task.command.retry"),
    commandId: z.string(),
    idempotencyKey: z.string(),
  }),
  z.object({ type: z.literal("feed.seen"), postId: z.string() }),
  z.object({ type: z.literal("feed.dismiss"), itemId: z.string().min(1).max(240) }),
  z.object({ type: z.literal("task.timeline.seen"), sessionId: z.string(), itemId: z.string().min(1).max(240) }),
  z.object({ type: z.literal("task.pin"), sessionId: z.string(), pinned: z.boolean() }),
  z.object({ type: z.literal("task.archive"), sessionId: z.string(), archived: z.boolean() }),
  z.object({
    type: z.literal("review.respond"),
    reviewId: z.string(),
    decision: ReviewDecisionSchema,
    note: z.string().max(2_000).optional(),
    idempotencyKey: z.string(),
  }),
  z.object({ type: z.literal("review.list"), sessionId: z.string().optional() }),
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
    endpoint: z.string().min(1).max(2_000),
    publicKey: z.string().min(1).max(2_000),
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
  }),
  z.object({ type: z.literal("session.events.request"), sessionId: z.string() }),
  z.object({ type: z.literal("devices.request") }),
  z.object({ type: z.literal("integrations.request") }),
  z.object({ type: z.literal("integrations.cli.install") }),
  z.object({ type: z.literal("device.approvals.set"), deviceId: z.string(), enabled: z.boolean() }),
  z.object({ type: z.literal("device.trust.set"), deviceId: z.string(), enabled: z.boolean() }),
  z.object({ type: z.literal("codex.plugin.request") }),
  z.object({ type: z.literal("codex.plugin.install") }),
  z.object({ type: z.literal("pairing.create") }),
  z.object({ type: z.literal("lan.approvals.set"), enabled: z.boolean() }),
]);
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
  | { type: "task.updated"; task: TaskRecord }
  | { type: "task.command.updated"; command: TaskCommand }
  | { type: "feed.seen.updated"; postId: string }
  | { type: "feed.dismissed.updated"; itemId: string }
  | { type: "task.timeline.seen.updated"; sessionId: string; itemId: string }
  | { type: "task.preference.updated"; preference: TaskPreference }
  | { type: "review.updated"; review: TaskReview }
  | { type: "reviews.list"; reviews: TaskReview[] }
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
  | { type: "pairing.created"; pairUrl: string; qrDataUrl: string; expiresAt: string }
  | { type: "lan.approvals.changed"; enabled: boolean }
  | { type: "integrations.status"; integrations: IntegrationStatus[] }
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
