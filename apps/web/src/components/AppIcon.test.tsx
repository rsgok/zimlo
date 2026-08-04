import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppIcon } from "./AppIcon";

describe("AppIcon", () => {
  it("renders navigation and action icons as scalable vectors", () => {
    for (const name of ["feed", "tasks", "plus", "conversation", "agents", "mic", "stop", "send", "check", "arrow-left", "arrow-right", "arrow-up", "paperclip", "close", "chevron-down"] as const) {
      const markup = renderToStaticMarkup(createElement(AppIcon, { name }));
      expect(markup).toContain("<svg");
      expect(markup).toContain('aria-hidden="true"');
    }
  });

  it("uses a clean two-bubble symbol for the central conversation action", () => {
    const markup = renderToStaticMarkup(createElement(AppIcon, { name: "conversation" }));
    expect(markup).toContain('fill="none"');
    expect(markup).toContain('stroke-width="1.65"');
    expect(markup.match(/<path/g)).toHaveLength(2);
  });
});
