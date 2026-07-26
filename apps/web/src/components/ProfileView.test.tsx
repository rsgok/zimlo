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
        codexPlugin={null}
        integrations={integrations}
        sessions={[]}
        userProfile={{ avatarId: "user-01", updatedAt: "2026-07-23T00:00:00.000Z" }}
        send={vi.fn()}
        forgetDevice={vi.fn()}
      />,
    );
    expect(markup).not.toContain("<h2");
    expect(markup).not.toContain("SETTINGS");
    expect(markup).toContain("Agent 状态");
    expect(markup).toContain("部分可用");
    expect(markup).not.toContain("管理你的头像、Agent 接入和手机设备");
    expect(markup).toContain("会显示在你的指令和 Timeline 中");
    expect(markup).toContain("<details");
    expect(markup).toContain("接入与安全详情");
    expect(markup).toContain("Codex · GUI");
    expect(markup).toContain("Codex · CLI");
    expect(markup).toContain("Claude Code · GUI");
    expect(markup).toContain("共用配置");
    expect(markup).toContain("只会在你点击修复或连接时修改 Agent 配置");
    expect(markup.match(/aria-label="选择头像 /gu)).toHaveLength(24);
    expect(markup).not.toContain("上传头像");
    expect(markup).not.toContain("Runtime 工作能力");
    expect(markup).not.toContain("WebSocket");
  });
});
