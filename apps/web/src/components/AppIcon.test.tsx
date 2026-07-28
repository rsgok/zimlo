import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppIcon } from "./AppIcon";

describe("AppIcon", () => {
  it("renders navigation and action icons as scalable vectors", () => {
    for (const name of ["feed", "tasks", "plus", "agents", "mic", "stop", "send", "check"] as const) {
      const markup = renderToStaticMarkup(createElement(AppIcon, { name }));
      expect(markup).toContain("<svg");
      expect(markup).toContain('aria-hidden="true"');
    }
  });
});
