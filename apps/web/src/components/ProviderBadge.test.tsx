import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProviderBadge } from "./ProviderBadge";

describe("ProviderBadge", () => {
  it("uses the provider icon while keeping the complete runtime name accessible", () => {
    const markup = renderToStaticMarkup(<ProviderBadge provider="codex" surface="cli" />);
    expect(markup).toContain('aria-label="Codex · CLI"');
    expect(markup).toContain('aria-hidden="true">CLI</span>');
    expect(markup).toContain("provider-icon");
    expect(markup).toContain("provider-icon-codex");
  });

  it("supports an icon-only Claude badge", () => {
    const markup = renderToStaticMarkup(<ProviderBadge provider="claude" labelMode="icon" />);
    expect(markup).toContain('aria-label="Claude Code"');
    expect(markup).toContain("provider-claude");
    expect(markup).not.toContain(">Claude Code<");
  });

  it("does not expose an unresolved internal surface as source metadata", () => {
    const markup = renderToStaticMarkup(<ProviderBadge provider="codex" surface="unknown" />);
    expect(markup).toContain('aria-label="Codex"');
    expect(markup).not.toContain("来源未知");
  });
});
