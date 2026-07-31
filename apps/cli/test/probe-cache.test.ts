import { describe, expect, it } from "vitest";
import { ProbeCache } from "../src/probe-cache.js";

describe("ProbeCache", () => {
  it("serves cached values within the TTL and recomputes after expiry", async () => {
    let now = 1_000;
    const cache = new ProbeCache(100, () => now);
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return calls;
    };
    expect(await cache.get("k", compute)).toBe(1);
    expect(await cache.get("k", compute)).toBe(1);
    now += 101;
    expect(await cache.get("k", compute)).toBe(2);
    expect(calls).toBe(2);
  });

  it("coalesces in-flight requests for the same key", async () => {
    const cache = new ProbeCache(1_000);
    let calls = 0;
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const compute = () => {
      calls += 1;
      return gate;
    };
    const pending = Promise.all([cache.get("k", compute), cache.get("k", compute), cache.get("k", compute)]);
    release("value");
    expect(await pending).toEqual(["value", "value", "value"]);
    expect(calls).toBe(1);
  });

  it("does not cache failures", async () => {
    const cache = new ProbeCache(60_000);
    let calls = 0;
    const compute = async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return "ok";
    };
    await expect(cache.get("k", compute)).rejects.toThrow("transient");
    expect(await cache.get("k", compute)).toBe("ok");
    expect(calls).toBe(2);
  });

  it("invalidateAll forces recomputation", async () => {
    const cache = new ProbeCache(60_000);
    let calls = 0;
    const compute = async () => ++calls;
    expect(await cache.get("k", compute)).toBe(1);
    cache.invalidateAll();
    expect(await cache.get("k", compute)).toBe(2);
  });
});
