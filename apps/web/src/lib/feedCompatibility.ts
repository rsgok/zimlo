import { EMPTY_FEATURE_CAPABILITIES, USER_AVATAR_IDS } from "@zimlo/protocol";
import type { FeedAction, FeedPost, FeedPostKind, FeedTemplate, Project, Snapshot, UserAvatarId } from "@zimlo/protocol";

const KINDS = new Set<FeedPostKind>(["progress", "decision", "attention", "result", "failure"]);
const TEMPLATES = new Set<FeedTemplate>(["paper", "grid", "sticky", "marker", "poster"]);
const ACTIONS = new Set<FeedAction>(["approve", "reject", "reply", "open_diff"]);

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
  const actions = Array.isArray(post.actions)
    ? post.actions.filter((item): item is FeedAction => ACTIONS.has(item as FeedAction)).slice(0, 4)
    : [];
  const pendingActionIds = Array.isArray(post.pendingActionIds)
    ? post.pendingActionIds.filter((item): item is string => typeof item === "string")
    : [];
  const actionRequired = post.actionRequired === true;

  return {
    id,
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
    actionRequired,
    ...(actionRequired && typeof post.actionPrompt === "string" && post.actionPrompt ? { actionPrompt: post.actionPrompt } : {}),
    actions,
    pendingActionIds,
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
    tasks: Array.isArray(snapshot.tasks) ? snapshot.tasks : [],
    commands: Array.isArray(snapshot.commands) ? snapshot.commands : [],
    workspaces: Array.isArray(snapshot.workspaces) ? snapshot.workspaces : [],
    seenPostIds: Array.isArray(snapshot.seenPostIds) ? snapshot.seenPostIds : [],
    dismissedFeedItemIds: Array.isArray(snapshot.dismissedFeedItemIds) ? snapshot.dismissedFeedItemIds : [],
    taskTimelineCursors: snapshot.taskTimelineCursors && typeof snapshot.taskTimelineCursors === "object" ? snapshot.taskTimelineCursors : {},
    taskPreferences: Array.isArray(snapshot.taskPreferences) ? snapshot.taskPreferences : [],
    actions: Array.isArray(snapshot.actions) ? snapshot.actions.filter((action) => !isInternalZimloAction(action)) : [],
    reviews: Array.isArray(snapshot.reviews) ? snapshot.reviews : [],
    trustPolicies: Array.isArray(snapshot.trustPolicies) ? snapshot.trustPolicies : [],
    trustAudit: Array.isArray(snapshot.trustAudit) ? snapshot.trustAudit : [],
    notificationSettings: snapshot.notificationSettings ?? {
      enabled: false,
      approvals: true,
      failures: true,
      reviews: true,
      showTaskTitle: false,
      updatedAt: "",
    },
    pushDevices: Array.isArray(snapshot.pushDevices) ? snapshot.pushDevices : [],
    features: snapshot.features ?? EMPTY_FEATURE_CAPABILITIES,
    sequence: typeof snapshot.sequence === "number" ? snapshot.sequence : 0,
    lanApprovalsEnabled: snapshot.lanApprovalsEnabled === true,
  };
}
