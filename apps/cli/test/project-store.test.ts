import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_CAPABILITIES, USER_AVATAR_IDS, type FeedPost, type Session } from "@zimlo/protocol";
import { ZimloStore } from "../src/store.js";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zimlo-project-store-"));
  roots.push(root);
  const projectRoot = join(root, "product");
  execFileSync("git", ["init", "-q", projectRoot]);
  return { root, projectRoot, database: join(root, "zimlo.db") };
}

function session(id: string, cwd: string, at: string): Session {
  return {
    id,
    provider: "codex",
    surface: "cli",
    providerSessionId: `provider-${id}`,
    title: `Task ${id}`,
    cwd,
    transcriptPath: null,
    status: "idle",
    lastActivityAt: at,
    createdAt: at,
    activePid: null,
    processStartedAt: null,
    tty: null,
    correlationUncertain: false,
    capabilities: EMPTY_CAPABILITIES,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("persistent project model", () => {
  it("groups sessions by Git root and makes Feed posts inherit the project", () => {
    const { projectRoot, database } = fixture();
    mkdirSync(join(projectRoot, "apps/web"), { recursive: true });
    mkdirSync(join(projectRoot, "packages/core"), { recursive: true });
    const store = new ZimloStore(database);
    const first = store.upsertSession(session("a", join(projectRoot, "apps/web"), "2026-07-23T00:00:00.000Z"));
    const second = store.upsertSession(session("b", join(projectRoot, "packages/core"), "2026-07-23T01:00:00.000Z"));
    expect(first.projectId).toBeTruthy();
    expect(second.projectId).toBe(first.projectId);
    expect(USER_AVATAR_IDS).toContain(store.getProject(first.projectId!)?.agentProfile.avatar);

    const post: FeedPost = {
      id: "post-a",
      taskId: "task-a",
      runId: first.providerSessionId,
      agentId: "codex",
      sessionId: first.id,
      kind: "result",
      template: "paper",
      headline: "完成",
      takeaway: "任务完成",
      highlights: [],
      actionRequired: false,
      actions: [],
      pendingActionIds: [],
      dedupeKey: "project-post",
      source: "agent",
      createdAt: "2026-07-23T02:00:00.000Z",
    };
    const storedPost = store.insertFeedPost(post).post;
    expect(storedPost.projectId).toBe(first.projectId);
    expect(store.listProjects()).toEqual([
      expect.objectContaining({ name: "product", primaryPath: realpathSync(projectRoot), sessionCount: 2, postCount: 1 }),
    ]);
    expect(store.snapshot(false, "", []).projects).toHaveLength(1);
    store.close();

    const reopened = new ZimloStore(database);
    expect(USER_AVATAR_IDS).toContain(reopened.getProject(first.projectId!)?.agentProfile.avatar);
    reopened.close();
  });

  it("idempotently restores project links on startup without guessing broad roots", () => {
    const { projectRoot, database } = fixture();
    const store = new ZimloStore(database);
    const stored = store.upsertSession(session("a", projectRoot, "2026-07-23T00:00:00.000Z"));
    expect(stored.projectId).toBeTruthy();
    store.database.prepare("UPDATE sessions SET project_id = NULL").run();
    store.database.prepare("DELETE FROM projects").run();
    store.database.prepare("DELETE FROM metadata WHERE key = 'project_backfill_v1'").run();
    store.upsertSession(session("root", "/", "2026-07-23T00:00:00.000Z"));
    store.close();

    const reopened = new ZimloStore(database);
    expect(reopened.getSession("a")?.projectId).toBeTruthy();
    expect(reopened.getSession("root")?.projectId).toBeNull();
    expect(reopened.listProjects()).toHaveLength(1);
    reopened.close();
  });

  it("backfills existing cards when a Session later gains a strong project", () => {
    const { projectRoot, database } = fixture();
    const store = new ZimloStore(database);
    const unresolved = store.upsertSession(session("late", "/", "2026-07-23T00:00:00.000Z"));
    store.insertFeedPost({
      id: "post-late",
      taskId: "task-late",
      runId: unresolved.providerSessionId,
      agentId: "codex",
      sessionId: unresolved.id,
      kind: "result",
      template: "paper",
      headline: "等待归属",
      takeaway: "Session 还没有可信项目。",
      highlights: [],
      actionRequired: false,
      actions: [],
      pendingActionIds: [],
      dedupeKey: "post-late",
      source: "agent",
      createdAt: "2026-07-23T00:01:00.000Z",
    });
    expect(store.listFeedPosts()[0]?.projectId).toBeNull();
    const assigned = store.upsertSession({ ...unresolved, cwd: projectRoot, lastActivityAt: "2026-07-23T00:02:00.000Z" });
    expect(assigned.projectId).toBeTruthy();
    expect(store.listFeedPosts()[0]?.projectId).toBe(assigned.projectId);
    store.close();
  });

  it("keeps stable project ordering and never downgrades a known surface", () => {
    const { root, database } = fixture();
    const alpha = join(root, "alpha");
    const zeta = join(root, "zeta");
    mkdirSync(join(alpha, ".git"), { recursive: true });
    mkdirSync(join(zeta, ".git"), { recursive: true });
    const store = new ZimloStore(database);
    store.upsertSession(session("zeta", zeta, "2026-07-23T02:00:00.000Z"));
    const cli = store.upsertSession(session("alpha", alpha, "2026-07-23T01:00:00.000Z"));
    store.upsertSession({ ...cli, surface: "unknown", lastActivityAt: "2026-07-23T03:00:00.000Z" });
    expect(store.getSession(cli.id)?.surface).toBe("cli");
    expect(store.listProjects().map((project) => project.name)).toEqual(["alpha", "zeta"]);
    store.close();
  });

  it("keeps Agent identity and profile when a Git project moves", () => {
    const { root, database } = fixture();
    const original = join(root, "original");
    const moved = join(root, "moved");
    for (const path of [original, moved]) {
      execFileSync("git", ["init", "-q", path]);
      execFileSync("git", ["-C", path, "remote", "add", "origin", "https://example.com/acme/product.git"]);
    }
    const store = new ZimloStore(database);
    const first = store.upsertSession(session("original", original, "2026-07-23T01:00:00.000Z"));
    expect(first.projectId).toMatch(/^project:[0-9a-f-]{36}$/u);
    const updated = store.updateAgentProfile(first.projectId!, { displayName: "股票研究", avatar: "📈", bio: "跟踪公司和投资论文", defaultProvider: "codex" });
    expect(updated?.agentProfile).toMatchObject({ displayName: "股票研究", avatar: "📈", defaultProvider: "codex" });
    const second = store.upsertSession(session("moved", moved, "2026-07-23T02:00:00.000Z"));
    expect(second.projectId).toBe(first.projectId);
    expect(store.getProject(first.projectId!)?.paths).toEqual([realpathSync(moved), realpathSync(original)]);
    store.close();

    const reopened = new ZimloStore(database);
    expect(reopened.getProject(first.projectId!)?.agentProfile.displayName).toBe("股票研究");
    reopened.close();
  });

  it("backfills a preset avatar only for Agents that were never customized", () => {
    const { projectRoot, database } = fixture();
    const store = new ZimloStore(database);
    const created = store.upsertSession(session("agent-avatar", projectRoot, "2026-07-23T00:00:00.000Z"));
    store.database.prepare("UPDATE projects SET agent_avatar = NULL WHERE id = ?").run(created.projectId);
    store.close();

    const reopened = new ZimloStore(database);
    expect(USER_AVATAR_IDS).toContain(reopened.getProject(created.projectId!)?.agentProfile.avatar);
    reopened.updateAgentProfile(created.projectId!, {
      displayName: "自定义 Agent",
      avatar: "📈",
      bio: "",
      defaultProvider: null,
    });
    reopened.close();

    const customized = new ZimloStore(database);
    expect(customized.getProject(created.projectId!)?.agentProfile.avatar).toBe("📈");
    customized.close();
  });

  it("assigns one preset user avatar and persists later choices", () => {
    const { database } = fixture();
    const store = new ZimloStore(database);
    expect(store.getUserProfile().avatarId).toMatch(/^user-(?:0[1-9]|1[0-9]|2[0-4])$/u);
    expect(store.updateUserProfile("user-24").avatarId).toBe("user-24");
    expect(store.snapshot(false, "", []).userProfile.avatarId).toBe("user-24");
    store.close();

    const reopened = new ZimloStore(database);
    expect(reopened.getUserProfile().avatarId).toBe("user-24");
    reopened.close();
  });
});
