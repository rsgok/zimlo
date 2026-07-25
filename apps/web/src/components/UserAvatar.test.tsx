import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentAvatar } from "./UserAvatar";

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
});
