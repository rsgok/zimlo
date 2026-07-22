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
  it("shows GUI and CLI as separate integration surfaces without implying automatic installation", () => {
    const markup = renderToStaticMarkup(
      <ProfileView
        localAdmin
        devices={[]}
        pairing={null}
        lanApprovalsEnabled={false}
        codexPlugin={null}
        integrations={integrations}
        sessions={[]}
        send={vi.fn()}
        forgetDevice={vi.fn()}
      />,
    );
    expect(markup).toContain("Codex · GUI");
    expect(markup).toContain("Codex · CLI");
    expect(markup).toContain("Claude Code · GUI");
    expect(markup).toContain("共享配置");
    expect(markup).toContain("不会在启动时静默修改 Agent 配置");
  });
});
