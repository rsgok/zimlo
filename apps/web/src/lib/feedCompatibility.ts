import { EMPTY_FEATURE_CAPABILITIES, USER_AVATAR_IDS } from "@zimlo/protocol";
import type { FeedContent, FeedPost, FeedPostKind, FeedTemplate, Project, Snapshot, UserAvatarId } from "@zimlo/protocol";

const KINDS = new Set<FeedPostKind>(["progress", "decision", "attention", "result", "failure"]);
const TEMPLATES = new Set<FeedTemplate>(["paper", "grid", "sticky", "marker", "poster"]);

const DEFAULT_TEMPLATE: Record<FeedPostKind, FeedTemplate> = {
  progress: "grid",
  decision: "sticky",
  attention: "marker",
  result: "paper",
  failure: "marker",
};

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function feedContent(value: unknown): FeedContent {
  if (!value || typeof value !== "object") return { type: "text" };
  const content = value as Record<string, unknown>;
  if (content.type === "image_album" && Array.isArray(content.materialIds)) {
    const materialIds = content.materialIds.filter((id): id is string => typeof id === "string").slice(0, 10);
    if (materialIds.length) return { type: "image_album", materialIds, ...(typeof content.caption === "string" ? { caption: content.caption } : {}) };
  }
  if (content.type === "video" && typeof content.materialId === "string") return { type: "video", materialId: content.materialId, ...(typeof content.posterMaterialId === "string" ? { posterMaterialId: content.posterMaterialId } : {}), ...(typeof content.caption === "string" ? { caption: content.caption } : {}) };
  if (content.type === "document" && typeof content.materialId === "string") return { type: "document", materialId: content.materialId, ...(typeof content.coverMaterialId === "string" ? { coverMaterialId: content.coverMaterialId } : {}), ...(typeof content.summary === "string" ? { summary: content.summary } : {}) };
  return { type: "text" };
}

export function isInternalZimloAction(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const action = value as Record<string, unknown>;
  return action.kind === "approval"
    && typeof action.detail === "string"
    && /(?:^|工具：)mcp__zimlo__(?:feed_post|feed_skip|signal_transition)$/mu.test(action.detail.trim());
}

export function normalizeFeedPost(value: unknown): FeedPost | null {
  if (!value || typeof value !== "object") return null;
  const post = value as Record<string, unknown>;
  if (post.source === "user" || post.kind === "instruction") return null;

  const id = text(post.id);
  if (!id) return null;
  const kind = KINDS.has(post.kind as FeedPostKind) ? post.kind as FeedPostKind : "progress";
  const template = TEMPLATES.has(post.template as FeedTemplate) ? post.template as FeedTemplate : DEFAULT_TEMPLATE[kind];
  const headline = text(post.headline, text(post.title, "历史帖子"));
  const takeaway = text(post.takeaway, text(post.body, "历史内容暂不可用。"));
  const highlights = Array.isArray(post.highlights)
    ? post.highlights.filter((item): item is string => typeof item === "string").slice(0, 3)
    : [];
  return {
    id,
    ...(typeof post.hostId === "string" ? { hostId: post.hostId } : {}),
    projectId: typeof post.projectId === "string" ? post.projectId : null,
    taskId: text(post.taskId, id),
    runId: text(post.runId, id),
    agentId: text(post.agentId, "agent"),
    sessionId: typeof post.sessionId === "string" ? post.sessionId : null,
    kind,
    template,
    headline,
    takeaway,
    highlights,
    ...(typeof post.proof === "string" && post.proof ? { proof: post.proof } : {}),
    content: feedContent(post.content),
    dedupeKey: text(post.dedupeKey, id),
    source: "agent",
    createdAt: text(post.createdAt),
  };
}

export function normalizeSnapshot(value: Snapshot): Snapshot {
  const snapshot = value as Partial<Snapshot>;
  const avatarId = USER_AVATAR_IDS.includes(snapshot.userProfile?.avatarId as UserAvatarId)
    ? snapshot.userProfile!.avatarId
    : USER_AVATAR_IDS[0];
  return {
    ...(snapshot.host ? { host: snapshot.host } : {}),
    userProfile: {
      avatarId,
      updatedAt: snapshot.userProfile?.updatedAt ?? "",
    },
    projects: Array.isArray(snapshot.projects) ? snapshot.projects.map((project): Project => ({
      ...project,
      agentProfile: project.agentProfile ?? {
        displayName: project.name,
        avatar: project.name.slice(0, 1).toLocaleUpperCase(),
        bio: `负责 ${project.name} 项目的长期工作与上下文。`,
        defaultProvider: null,
        updatedAt: project.createdAt,
      },
    })) : [],
    sessions: Array.isArray(snapshot.sessions)
      ? snapshot.sessions.map((session) => ({ ...session, surface: session.surface ?? "unknown" }))
      : [],
    cards: Array.isArray(snapshot.cards) ? snapshot.cards : [],
    posts: Array.isArray(snapshot.posts)
      ? snapshot.posts.map(normalizeFeedPost).filter((post): post is FeedPost => post !== null)
      : [],
    materials: Array.isArray(snapshot.materials) ? snapshot.materials : [],
    tasks: Array.isArray(snapshot.tasks) ? snapshot.tasks : [],
    commands: Array.isArray(snapshot.commands) ? snapshot.commands.map((command) => ({ ...command, materialIds: command.materialIds ?? [] })) : [],
    workspaces: Array.isArray(snapshot.workspaces) ? snapshot.workspaces : [],
    seenPostIds: Array.isArray(snapshot.seenPostIds) ? snapshot.seenPostIds : [],
    dismissedFeedItemIds: Array.isArray(snapshot.dismissedFeedItemIds) ? snapshot.dismissedFeedItemIds : [],
    taskTimelineCursors: snapshot.taskTimelineCursors && typeof snapshot.taskTimelineCursors === "object" ? snapshot.taskTimelineCursors : {},
    taskPreferences: Array.isArray(snapshot.taskPreferences) ? snapshot.taskPreferences : [],
    actions: Array.isArray(snapshot.actions) ? snapshot.actions.filter((action) => !isInternalZimloAction(action)) : [],
    trustPolicies: Array.isArray(snapshot.trustPolicies) ? snapshot.trustPolicies : [],
    trustAudit: Array.isArray(snapshot.trustAudit) ? snapshot.trustAudit : [],
    notificationSettings: {
      enabled: false,
      approvals: true,
      failures: true,
      criticalOnly: false,
      quietHoursEnabled: false,
      timeZoneOffsetMinutes: 0,
      showTaskTitle: false,
      updatedAt: "",
      ...(snapshot.notificationSettings ?? {}),
      results: snapshot.notificationSettings?.results ?? true,
    },
    pushDevices: Array.isArray(snapshot.pushDevices) ? snapshot.pushDevices : [],
    features: { ...EMPTY_FEATURE_CAPABILITIES, ...(snapshot.features ?? {}) },
    sequence: typeof snapshot.sequence === "number" ? snapshot.sequence : 0,
    lanApprovalsEnabled: snapshot.lanApprovalsEnabled === true,
    trustManagementEnabled: snapshot.trustManagementEnabled === true,
  };
}
