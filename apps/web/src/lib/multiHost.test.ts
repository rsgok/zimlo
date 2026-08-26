import { describe, expect, it } from "vitest";
import type { Host, Snapshot } from "@zimlo/protocol";
import { commandHostId, mergeHostSnapshots } from "./multiHost";

function snapshot(host: Host, suffix: string): Snapshot {
  return {
    host, userProfile: { avatarId: "user-01", updatedAt: host.lastSeenAt },
    projects: [], cards: [], materials: [], tasks: [], commands: [], workspaces: [], actions: [], trustPolicies: [], trustAudit: [], pushDevices: [],
    sessions: [{ id: `session-${suffix}`, hostId: host.id, projectId: null, provider: "codex", surface: "gui", providerSessionId: suffix, title: suffix, projectName: null, cwd: null, transcriptPath: null, status: "running", lastActivityAt: host.lastSeenAt, createdAt: host.lastSeenAt, activePid: null, processStartedAt: null, tty: null, correlationUncertain: false, capabilities: { discovered: true, liveObserved: true, replyable: true, approvableOnce: false, approvableSession: false, approvablePersistent: false, resumable: true, diffAvailable: false } }],
    posts: [{ id: `post-${suffix}`, hostId: host.id, projectId: null, taskId: suffix, runId: suffix, agentId: suffix, sessionId: `session-${suffix}`, kind: "result", template: "paper", headline: suffix, takeaway: suffix, highlights: [], content: { type: "text" }, dedupeKey: suffix, source: "agent", createdAt: host.lastSeenAt }],
    seenPostIds: [], dismissedFeedItemIds: [], taskTimelineCursors: {}, taskPreferences: [],
    notificationSettings: { enabled: false, approvals: true, results: true, failures: true, criticalOnly: false, quietHoursEnabled: false, timeZoneOffsetMinutes: 0, showTaskTitle: false, updatedAt: host.lastSeenAt },
    features: { projectTrustPolicy: true, pushNotifications: false, remoteSync: true, multiHost: true }, sequence: 1, lanApprovalsEnabled: false,
    trustManagementEnabled: false,
  };
}

describe("multi-host snapshot aggregation", () => {
  it("keeps both Hosts in one Feed and preserves routing identity", () => {
    const one: Host = { id: "host-one", name: "MacBook", platform: "macos", lastSeenAt: "2026-08-01T00:00:00Z" };
    const two: Host = { id: "host-two", name: "Studio", platform: "macos", lastSeenAt: "2026-08-02T00:00:00Z" };
    const merged = mergeHostSnapshots([{ host: one, snapshot: snapshot(one, "one") }, { host: two, snapshot: snapshot(two, "two") }]);
    expect(merged.posts.map((post) => post.hostId)).toEqual(["host-two", "host-one"]);
    expect(commandHostId({ type: "task.follow_up", sessionId: "session-one" }, merged)).toBe("host-one");
    expect(commandHostId({ type: "feed.seen", postId: "post-two" }, merged)).toBe("host-two");
  });
});
