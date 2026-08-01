import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentAvatar, ZimloAvatar } from "./UserAvatar";

describe("AgentAvatar", () => {
  it("uses bundled images for preset ids", () => {
    const markup = renderToStaticMarkup(<AgentAvatar avatar="user-24" className="timeline-avatar" alt="" />);
    expect(markup).toContain('/avatars/user-24.png');
    expect(markup).toContain("agent-avatar-image");
  });

  it("keeps legacy custom text avatars visible", () => {
    const markup = renderToStaticMarkup(<AgentAvatar avatar="📈" className="timeline-avatar" alt="" />);
    expect(markup).toContain("📈");
    expect(markup).not.toContain("<img");
  });

  it("uses the shared Zimlo brand mark in app headers", () => {
    const markup = renderToStaticMarkup(<ZimloAvatar />);
    expect(markup).toContain('src="/zimlo-icon.svg?brand=2"');
  });
});
