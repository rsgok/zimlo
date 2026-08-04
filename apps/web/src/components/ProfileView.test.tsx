import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { IntegrationStatus } from "@zimlo/protocol";
import { ProfileView } from "./ProfileView";

const integrations: IntegrationStatus[] = [
  { id: "codex_gui", provider: "codex", surface: "gui", state: "ready", label: "Codex · GUI", detail: "Personal Plugin 已就绪。" },
  { id: "codex_cli", provider: "codex", surface: "cli", state: "ready", label: "Codex · CLI", detail: "Hooks 与 MCP 已配置。" },
  { id: "claude_gui", provider: "claude", surface: "gui", state: "shared", label: "Claude Code · GUI", detail: "与 CLI 共用用户级配置。" },
  { id: "claude_cli", provider: "claude", surface: "cli", state: "partial", label: "Claude Code · CLI", detail: "还需 MCP。" },
];

describe("ProfileView", () => {
  it("leads with user-facing status and keeps technical integration details secondary", () => {
    const markup = renderToStaticMarkup(
      <ProfileView
        localAdmin
        devices={[]}
        pairing={null}
        lanApprovalsEnabled={false}
        trustManagementEnabled={false}
        codexPlugin={null}
        integrations={integrations}
        sessions={[]}
        userProfile={{ avatarId: "user-01", updatedAt: "2026-07-23T00:00:00.000Z" }}
        send={vi.fn()}
        forgetDevice={vi.fn()}
      />,
    );
    expect(markup).toContain("<h2>Zimlo</h2>");
    expect(markup).not.toContain("SETTINGS");
    expect(markup).toContain("Runtime");
    expect(markup).toContain("Codex");
    expect(markup).toContain("Claude Code");
    expect(markup).toContain("部分可用");
    expect(markup).not.toContain("管理你的头像、Agent 接入和手机设备");
    expect(markup).toContain("<details");
    expect(markup).toContain("接入与安全");
    expect(markup).toContain("Codex · GUI");
    expect(markup).toContain("Codex · CLI");
    expect(markup).toContain("Claude Code · GUI");
    expect(markup).toContain("共用配置");
    expect(markup).toContain("敏感消息使用设备密钥加密");
    expect(markup).toContain('aria-label="更换头像"');
    expect(markup.match(/aria-label="选择头像 /gu)).toBeNull();
    expect(markup).not.toContain("上传头像");
    expect(markup).not.toContain("Runtime 工作能力");
    expect(markup).not.toContain("WebSocket");
    expect(markup).not.toContain("Zimlo 手机配对二维码");
    expect(markup).toContain("显示二维码");
  });

  it("keeps revoked devices out of the primary settings list", () => {
    const markup = renderToStaticMarkup(
      <ProfileView
        localAdmin
        devices={[
          { id: "active", name: "我的 iPhone", createdAt: "2026-07-23T00:00:00.000Z", lastSeenAt: "2026-07-23T00:00:00.000Z", revokedAt: null, isLocalAdmin: false, canApprove: true, canManageTrust: false },
          { id: "local", name: "Local Mac browser", createdAt: "2026-07-23T00:00:00.000Z", lastSeenAt: "2026-07-23T00:00:00.000Z", revokedAt: null, isLocalAdmin: true, canApprove: true, canManageTrust: true },
          { id: "revoked", name: "Cloud pairing smoke", createdAt: "2026-07-22T00:00:00.000Z", lastSeenAt: "2026-07-22T00:00:00.000Z", revokedAt: "2026-07-22T01:00:00.000Z", isLocalAdmin: false, canApprove: false, canManageTrust: false },
        ]}
        pairing={null}
        lanApprovalsEnabled={false}
        trustManagementEnabled={false}
        codexPlugin={null}
        integrations={integrations}
        sessions={[]}
        userProfile={{ avatarId: "user-01", updatedAt: "2026-07-23T00:00:00.000Z" }}
        send={vi.fn()}
        forgetDevice={vi.fn()}
      />,
    );

    expect(markup).toContain("我的 iPhone");
    expect(markup).toContain("审批与回复");
    expect(markup).toContain("安全自动化");
    expect(markup).toContain("已开启审批");
    expect(markup).toContain("最近使用");
    expect(markup).toContain("device-item");
    expect(markup).not.toContain("Local Mac browser");
    expect(markup).not.toContain("Cloud pairing smoke");
    expect(markup).toContain("1 条已撤销设备记录");
  });
});
