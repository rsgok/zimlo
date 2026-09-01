import { CardBlockSchema, ResolvedCardPresentationSchema, resolveCardPresentation, USER_AVATAR_IDS } from "@zimlo/protocol";
import type {
  ApprovalCategory,
  CardBlock,
  FeedCard,
  FeedContent,
  FeedPost,
  FeedPostKind,
  Material,
  NotificationSettings,
  PendingAction,
  ProjectTrustPolicy,
  PushDeviceRegistration,
  ResolvedCardPresentation,
  Session,
  SessionCapabilities,
  TaskCommand,
  TaskRecord,
  TrustAuditEntry,
  UnifiedEvent,
} from "@zimlo/protocol";

export interface DeviceRow {
  id: string;
  name: string;
  key_base64: string;
  created_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  is_local_admin: number;
  can_approve: number;
  can_manage_trust: number;
}

export interface DeviceRecord {
  id: string;
  name: string;
  keyBase64: string;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  isLocalAdmin: boolean;
  canApprove: boolean;
  canManageTrust: boolean;
}

export interface StoredFeedContentV2 {
  template: string;
  headline: string;
  takeaway: string;
  highlights: string[];
  proof?: string;
  content?: FeedContent;
}

export interface StoredFeedContentV3 {
  presentation: ResolvedCardPresentation;
  headline: string;
  takeaway: string;
  highlights: string[];
  blocks: CardBlock[];
  proof?: string;
  content?: FeedContent;
}

export function defaultPresentation(kind: string, content: FeedContent = { type: "text" }, blocks: CardBlock[] = []): ResolvedCardPresentation {
  const semanticKind = ["progress", "decision", "attention", "result", "failure"].includes(kind)
    ? kind as FeedPostKind
    : "progress";
  return resolveCardPresentation({
    kind: semanticKind,
    presentation: { system: "auto", theme: "auto", layout: "auto", typography: "auto", density: "auto", mediaPlacement: "auto" },
    blocks,
    content,
  });
}

export function json<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function sessionFromRow(row: Record<string, unknown>): Session {
  return {
    id: String(row.id),
    projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
    provider: row.provider as Session["provider"],
    surface: (row.surface ?? "unknown") as Session["surface"],
    providerSessionId: String(row.provider_session_id),
    title: String(row.title),
    cwd: row.cwd === null ? null : String(row.cwd),
    transcriptPath: row.transcript_path === null ? null : String(row.transcript_path),
    status: row.status as Session["status"],
    lastActivityAt: String(row.last_activity_at),
    createdAt: String(row.created_at),
    activePid: row.active_pid === null ? null : Number(row.active_pid),
    processStartedAt: row.process_started_at === null ? null : String(row.process_started_at),
    tty: row.tty === null ? null : String(row.tty),
    correlationUncertain: Number(row.correlation_uncertain) === 1,
    capabilities: json<SessionCapabilities>(String(row.capabilities_json)),
  };
}

export function eventFromRow(row: Record<string, unknown>): UnifiedEvent {
  return {
    id: String(row.id),
    sequence: Number(row.sequence),
    provider: row.provider as UnifiedEvent["provider"],
    sessionId: String(row.session_id),
    providerSessionId: String(row.provider_session_id),
    ...(row.turn_id === null ? {} : { turnId: String(row.turn_id) }),
    ...(row.item_id === null ? {} : { itemId: String(row.item_id) }),
    kind: row.kind as UnifiedEvent["kind"],
    source: row.source as UnifiedEvent["source"],
    occurredAt: String(row.occurred_at),
    payload: json(String(row.payload_json)),
    provenance: row.provenance as UnifiedEvent["provenance"],
  };
}

export function cardFromRow(row: Record<string, unknown>): FeedCard {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    turnId: row.turn_id === null ? null : String(row.turn_id),
    kind: row.kind as FeedCard["kind"],
    title: String(row.title),
    summary: String(row.summary),
    priority: Number(row.priority),
    status: row.status as FeedCard["status"],
    actionIds: json<string[]>(String(row.action_ids_json)),
    updatedAt: String(row.updated_at),
    provenance: row.provenance as FeedCard["provenance"],
  };
}

export function feedPostFromRow(row: Record<string, unknown>): FeedPost {
  let content: StoredFeedContentV3;
  try {
    content = row.content_json
      ? json<StoredFeedContentV3>(String(row.content_json))
      : fallbackFeedContent(row);
  } catch {
    content = fallbackFeedContent(row);
  }
  const parsedBlocks = CardBlockSchema.array().max(8).safeParse(content.blocks);
  const blocks = parsedBlocks.success ? parsedBlocks.data : [];
  const parsedPresentation = ResolvedCardPresentationSchema.safeParse(content.presentation);
  const presentation = parsedPresentation.success
    ? parsedPresentation.data
    : defaultPresentation(String(row.kind), content.content, blocks);
  return {
    id: String(row.id),
    projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
    taskId: String(row.task_id),
    runId: String(row.run_id),
    agentId: String(row.agent_id),
    sessionId: row.session_id === null ? null : String(row.session_id),
    kind: row.kind as FeedPost["kind"],
    presentation,
    headline: content.headline,
    takeaway: content.takeaway,
    highlights: content.highlights,
    blocks,
    ...(content.proof ? { proof: content.proof } : {}),
    content: content.content ?? { type: "text" },
    dedupeKey: String(row.dedupe_key),
    source: "agent",
    createdAt: String(row.created_at),
  };
}

function fallbackFeedContent(row: Record<string, unknown>): StoredFeedContentV3 {
  return {
    presentation: defaultPresentation(String(row.kind)),
    headline: String(row.title).slice(0, 72),
    takeaway: String(row.body).slice(0, 320),
    highlights: [],
    blocks: [],
  };
}

export function taskFromRow(row: Record<string, unknown>): TaskRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    agentId: String(row.agent_id),
    sessionId: row.session_id === null ? null : String(row.session_id),
    state: row.state as TaskRecord["state"],
    reason: String(row.reason),
    updatedAt: String(row.updated_at),
  };
}

export function taskCommandFromRow(row: Record<string, unknown>): TaskCommand {
  return {
    id: String(row.id),
    idempotencyKey: String(row.idempotency_key),
    kind: row.kind as TaskCommand["kind"],
    provider: row.provider as TaskCommand["provider"],
    sessionId: row.session_id === null ? null : String(row.session_id),
    workspaceId: row.workspace_id === null ? null : String(row.workspace_id),
    cwd: String(row.cwd),
    text: String(row.text),
    materialIds: row.material_ids_json ? json<string[]>(String(row.material_ids_json)) : [],
    state: row.state as TaskCommand["state"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.error === null ? {} : { error: String(row.error) }),
  };
}

export function materialFromRow(row: Record<string, unknown>): Material {
  return {
    id: String(row.id),
    kind: row.kind as Material["kind"],
    name: String(row.name),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    sha256: String(row.sha256),
    ...(row.width === null || row.width === undefined ? {} : { width: Number(row.width) }),
    ...(row.height === null || row.height === undefined ? {} : { height: Number(row.height) }),
    ...(row.duration_ms === null || row.duration_ms === undefined ? {} : { durationMs: Number(row.duration_ms) }),
    ...(row.preview_material_id ? { previewMaterialId: String(row.preview_material_id) } : {}),
    origin: row.origin as Material["origin"],
    status: row.status as Material["status"],
    createdAt: String(row.created_at),
    ...(row.error ? { error: String(row.error) } : {}),
  };
}

export function trustPolicyFromRow(row: Record<string, unknown>): ProjectTrustPolicy {
  return {
    projectId: String(row.project_id),
    preset: row.preset as ProjectTrustPolicy["preset"],
    autoAllow: json<ApprovalCategory[]>(String(row.auto_allow_json)),
    updatedAt: String(row.updated_at),
    updatedByDeviceId: String(row.updated_by_device_id),
  };
}

export function trustAuditFromRow(row: Record<string, unknown>): TrustAuditEntry {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    sessionId: String(row.session_id),
    deviceId: String(row.device_id),
    category: row.category as TrustAuditEntry["category"],
    decision: row.decision as TrustAuditEntry["decision"],
    reason: String(row.reason),
    actionSummary: String(row.action_summary),
    createdAt: String(row.created_at),
  };
}

export function notificationSettingsFromRow(row: Record<string, unknown>): NotificationSettings {
  return {
    enabled: Number(row.enabled) === 1,
    approvals: Number(row.approvals) === 1,
    results: row.results === undefined || Number(row.results) === 1,
    failures: Number(row.failures) === 1,
    criticalOnly: Number(row.critical_only) === 1,
    quietHoursEnabled: Number(row.quiet_hours_enabled) === 1,
    timeZoneOffsetMinutes: Number(row.timezone_offset_minutes ?? 0),
    showTaskTitle: Number(row.show_task_title) === 1,
    updatedAt: String(row.updated_at),
  };
}

export function pushDeviceFromRow(row: Record<string, unknown>): PushDeviceRegistration {
  return {
    deviceId: String(row.device_id),
    platform: "ios",
    endpoint: String(row.endpoint),
    publicKey: String(row.public_key),
    active: Number(row.active) === 1,
    environment: row.environment === "development" ? "development" : "production",
    registeredAt: String(row.registered_at),
    updatedAt: String(row.updated_at),
    ...(row.last_delivery_kind === null || row.last_delivery_kind === undefined
      ? {}
      : { lastDeliveryKind: row.last_delivery_kind as PushDeviceRegistration["lastDeliveryKind"] }),
    ...(row.last_delivery_status === null || row.last_delivery_status === undefined
      ? {}
      : { lastDeliveryStatus: Number(row.last_delivery_status) }),
    ...(row.last_delivery_at === null || row.last_delivery_at === undefined
      ? {}
      : { lastDeliveryAt: String(row.last_delivery_at) }),
  };
}

export function actionFromRow(row: Record<string, unknown>): PendingAction {
  return {
    actionId: String(row.action_id),
    sessionId: String(row.session_id),
    ...(row.upstream_request_id === null ? {} : { upstreamRequestId: String(row.upstream_request_id) }),
    kind: row.kind as PendingAction["kind"],
    title: String(row.title),
    detail: String(row.detail),
    availableDecisions: json(String(row.decisions_json)),
    expiresAt: String(row.expires_at),
    state: row.state as PendingAction["state"],
    createdAt: String(row.created_at),
    ...(row.resolved_at === null ? {} : { resolvedAt: String(row.resolved_at) }),
    ...(row.approval_context_json ? { approvalContext: json(String(row.approval_context_json)) } : {}),
  };
}

export function deviceFromRow(row: DeviceRow): DeviceRecord {
  return {
    id: row.id,
    name: row.name,
    keyBase64: row.key_base64,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    isLocalAdmin: row.is_local_admin === 1,
    canApprove: row.can_approve === 1,
    canManageTrust: row.can_manage_trust === 1,
  };
}
