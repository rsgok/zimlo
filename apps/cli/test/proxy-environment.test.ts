import { describe, expect, it } from "vitest";
import { proxyURLFor } from "../src/proxy-environment.js";

describe("proxyURLFor", () => {
  it("uses the HTTPS proxy for secure cloud sockets", () => {
    expect(proxyURLFor(new URL("wss://cloud.example/v1/sync/mac"), {
      HTTPS_PROXY: "http://127.0.0.1:7897",
    })).toBe("http://127.0.0.1:7897/");
  });

  it("bypasses loopback and matching domains", () => {
    const environment = {
      HTTPS_PROXY: "http://127.0.0.1:7897",
      NO_PROXY: "127.0.0.1,localhost,.internal.example",
    };
    expect(proxyURLFor(new URL("ws://127.0.0.1:4747/ws"), environment)).toBeNull();
    expect(proxyURLFor(new URL("wss://relay.internal.example/ws"), environment)).toBeNull();
  });

  it("ignores unsupported or malformed proxy URLs", () => {
    expect(proxyURLFor(new URL("wss://cloud.example/ws"), { HTTPS_PROXY: "socks5://127.0.0.1:7897" })).toBeNull();
    expect(proxyURLFor(new URL("wss://cloud.example/ws"), { HTTPS_PROXY: "://bad" })).toBeNull();
  });
});
