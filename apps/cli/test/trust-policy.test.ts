import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Project, ProjectTrustPolicy } from "@zimlo/protocol";
import {
  approvalContextForCommand,
  approvalContextForFile,
  canAutoAllow,
  classifyCommandSegment,
} from "../src/trust-policy.js";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zimlo-trust-"));
  roots.push(root);
  const project: Project = {
    id: "project-a",
    name: "project-a",
    primaryPath: root,
    paths: [root],
    providers: ["codex"],
    sessionCount: 0,
    postCount: 0,
    agentProfile: { displayName: "Agent", avatar: "user-01", bio: "", updatedAt: new Date(0).toISOString() },
    createdAt: new Date(0).toISOString(),
    lastUsedAt: new Date(0).toISOString(),
  };
  const policy: ProjectTrustPolicy = {
    projectId: project.id,
    preset: "safe_automation",
    autoAllow: ["read", "search", "test", "build"],
    updatedAt: new Date().toISOString(),
    updatedByDeviceId: "local",
  };
  return { root, project, policy };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("project trust policy", () => {
  it("classifies high-risk actions before permissive categories", () => {
    expect(classifyCommandSegment("pnpm test")).toBe("test");
    expect(classifyCommandSegment("pnpm build")).toBe("build");
    expect(classifyCommandSegment("curl https://example.com")).toBe("network");
    expect(classifyCommandSegment("git push origin main")).toBe("git_publish");
    expect(classifyCommandSegment("rm -rf ./dist")).toBe("destructive");
  });

  it("requires every compound command segment to be safe", () => {
    const { root, project, policy } = fixture();
    const safe = approvalContextForCommand("rg TODO src && pnpm test", root, project);
    const mixed = approvalContextForCommand("pnpm test && git push", root, project);
    expect(canAutoAllow(safe, policy)).toBe(true);
    expect(canAutoAllow(mixed, policy)).toBe(false);
    expect(mixed.category).toBe("git_publish");
  });

  it("fails closed for path traversal and symlink escapes", () => {
    const { root, project, policy } = fixture();
    const outside = mkdtempSync(join(tmpdir(), "zimlo-outside-"));
    roots.push(outside);
    mkdirSync(join(root, "inside"));
    symlinkSync(outside, join(root, "inside", "escape"));
    const traversal = approvalContextForCommand("cat ../secret", root, project);
    const symlink = approvalContextForCommand("cat ./inside/escape/secret", root, project);
    expect(traversal.withinProject).toBe(false);
    expect(symlink.withinProject).toBe(false);
    expect(canAutoAllow(traversal, policy)).toBe(false);
    expect(canAutoAllow(symlink, policy)).toBe(false);
    expect(approvalContextForFile(join(root, "new.txt"), root, project).category).toBe("write");
  });
});
