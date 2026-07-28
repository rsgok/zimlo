import { describe, expect, it } from "vitest";
import { claudeMcpConfiguredFromConfig } from "../src/integration-status";

describe("claudeMcpConfiguredFromConfig", () => {
  const executable = "/Applications/Zimlo.app/Contents/Resources/runtime/node";
  const entrypoint = "/Applications/Zimlo.app/Contents/Resources/runtime/cli/dist/index.js";

  it("recognizes the user-scoped Zimlo MCP server without launching Claude", () => {
    expect(claudeMcpConfiguredFromConfig({
      mcpServers: {
        zimlo: {
          type: "stdio",
          command: executable,
          args: [entrypoint, "mcp", "--provider", "claude"],
        },
      },
    }, entrypoint, executable)).toBe(true);
  });

  it("rejects a stale executable or entrypoint", () => {
    const config = {
      mcpServers: {
        zimlo: {
          command: "/tmp/node",
          args: ["/tmp/zimlo.js", "mcp"],
        },
      },
    };
    expect(claudeMcpConfiguredFromConfig(config, entrypoint, executable)).toBe(false);
    expect(claudeMcpConfiguredFromConfig({}, entrypoint, executable)).toBe(false);
  });
});
