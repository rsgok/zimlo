import { describe, expect, it } from "vitest";
import { pairingLandingPage } from "./pairing-landing.js";

describe("cloud pairing landing page", () => {
  it("replaces the root 404 with actionable in-app scanning guidance", async () => {
    const response = pairingLandingPage();
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toContain("请在 Zimlo App 内完成连接");
    expect(body).toContain("扫描配对二维码");
    expect(body).toContain("复制连接码");
  });

  it("keeps pairing fragments client-side and locks down the document", async () => {
    const response = pairingLandingPage();
    const body = await response.text();
    const policy = response.headers.get("content-security-policy") ?? "";

    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toMatch(/script-src 'nonce-[a-f0-9]+'/u);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(body).toContain("location.hash.slice(1)");
    expect(body).not.toContain("__NONCE__");
  });

  it("returns headers without a body for HEAD requests", async () => {
    const response = pairingLandingPage(true);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toBe("");
  });
});
