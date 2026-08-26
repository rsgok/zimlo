import { EMPTY_FEATURE_CAPABILITIES, type Host, type Snapshot } from "@zimlo/protocol";
import { normalizeSnapshot } from "./feedCompatibility";

export interface HostSnapshot {
  host: Host;
  snapshot: Snapshot;
}

function withHost<T extends object>(values: T[], hostId: string): Array<T & { hostId: string }> {
  return values.map((value) => ({ ...value, hostId }));
}

function newest<T>(values: T[], timestamp: (value: T) => string): T | undefined {
  return [...values].sort((a, b) => timestamp(b).localeCompare(timestamp(a)))[0];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Merge independent, authoritative Bridge snapshots into one reading model.
 * Execution identity is never discarded: every routable entity is tagged with
 * the Host that owns it, while user consumption state is unioned across Hosts.
 */
export function mergeHostSnapshots(sources: HostSnapshot[]): Snapshot {
  if (sources.length === 0) {
    return normalizeSnapshot({
      userProfile: { avatarId: "user-01", updatedAt: "" }, projects: [], sessions: [], cards: [], posts: [],
      materials: [], tasks: [], commands: [], workspaces: [], seenPostIds: [], dismissedFeedItemIds: [],
      taskTimelineCursors: {}, taskPreferences: [], actions: [], trustPolicies: [], trustAudit: [],
      notificationSettings: { enabled: false, approvals: true, results: true, failures: true, criticalOnly: false, quietHoursEnabled: false, timeZoneOffsetMinutes: 0, showTaskTitle: false, updatedAt: "" },
      pushDevices: [], features: EMPTY_FEATURE_CAPABILITIES, sequence: 0, lanApprovalsEnabled: false,
      trustManagementEnabled: false,
    });
  }
  const normalized = sources.map(({ host, snapshot }) => ({ host, snapshot: normalizeSnapshot(snapshot) }));
  const primary = newest(normalized, (source) => source.host.lastSeenAt) ?? normalized[0]!;
  const profileSource = newest(normalized, (source) => source.snapshot.userProfile.updatedAt) ?? primary;
  const notificationSource = newest(normalized, (source) => source.snapshot.notificationSettings.updatedAt) ?? primary;
  return {
    host: primary.host,
    userProfile: profileSource.snapshot.userProfile,
    projects: normalized.flatMap(({ host, snapshot }) => withHost(snapshot.projects, host.id)),
    sessions: normalized.flatMap(({ host, snapshot }) => withHost(snapshot.sessions, host.id)),
    cards: normalized.flatMap(({ snapshot }) => snapshot.cards),
    posts: normalized.flatMap(({ host, snapshot }) => withHost(snapshot.posts, host.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    materials: normalized.flatMap(({ host, snapshot }) => withHost(snapshot.materials, host.id)),
    tasks: normalized.flatMap(({ host, snapshot }) => withHost(snapshot.tasks, host.id)),
    commands: normalized.flatMap(({ host, snapshot }) => withHost(snapshot.commands, host.id)),
    workspaces: normalized.flatMap(({ host, snapshot }) => withHost(snapshot.workspaces, host.id)),
    seenPostIds: unique(normalized.flatMap(({ snapshot }) => snapshot.seenPostIds)),
    dismissedFeedItemIds: unique(normalized.flatMap(({ snapshot }) => snapshot.dismissedFeedItemIds)),
    taskTimelineCursors: Object.assign({}, ...normalized.map(({ snapshot }) => snapshot.taskTimelineCursors)),
    taskPreferences: normalized.flatMap(({ host, snapshot }) => withHost(snapshot.taskPreferences, host.id)),
    actions: normalized.flatMap(({ host, snapshot }) => withHost(snapshot.actions, host.id)),
    trustPolicies: normalized.flatMap(({ host, snapshot }) => withHost(snapshot.trustPolicies, host.id)),
    trustAudit: normalized.flatMap(({ host, snapshot }) => withHost(snapshot.trustAudit, host.id)),
    notificationSettings: notificationSource.snapshot.notificationSettings,
    pushDevices: normalized.flatMap(({ snapshot }) => snapshot.pushDevices),
    features: {
      projectTrustPolicy: normalized.some(({ snapshot }) => snapshot.features.projectTrustPolicy),
      pushNotifications: normalized.some(({ snapshot }) => snapshot.features.pushNotifications),
      remoteSync: normalized.some(({ snapshot }) => snapshot.features.remoteSync),
      multiHost: true,
    },
    sequence: Math.max(...normalized.map(({ snapshot }) => snapshot.sequence)),
    lanApprovalsEnabled: normalized.some(({ snapshot }) => snapshot.lanApprovalsEnabled),
    trustManagementEnabled: normalized.some(({ snapshot }) => snapshot.trustManagementEnabled),
  };
}

export function commandHostId(command: object, snapshot: Snapshot, fallbackHostId?: string): string | undefined {
  const value = command as Record<string, unknown>;
  if (typeof value.hostId === "string") return value.hostId;
  const lookup = (key: string): string | undefined => typeof value[key] === "string" ? value[key] as string : undefined;
  const sessionId = lookup("sessionId");
  if (sessionId) return snapshot.sessions.find((item) => item.id === sessionId)?.hostId ?? fallbackHostId;
  const projectId = lookup("projectId");
  if (projectId) return snapshot.projects.find((item) => item.id === projectId)?.hostId ?? fallbackHostId;
  const workspaceId = lookup("workspaceId");
  if (workspaceId) return snapshot.workspaces.find((item) => item.id === workspaceId)?.hostId ?? fallbackHostId;
  const postId = lookup("postId") ?? lookup("itemId")?.replace(/^post:/u, "");
  if (postId) return snapshot.posts.find((item) => item.id === postId)?.hostId ?? fallbackHostId;
  const actionId = lookup("actionId") ?? lookup("itemId")?.replace(/^action:/u, "");
  if (actionId) return snapshot.actions.find((item) => item.actionId === actionId)?.hostId ?? fallbackHostId;
  return fallbackHostId;
}
