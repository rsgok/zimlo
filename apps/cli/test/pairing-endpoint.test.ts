import { describe, expect, it } from "vitest";
import { pairingURLForBase, selectPairingEndpoint } from "../src/pairing-endpoint.js";

describe("selectPairingEndpoint", () => {
  it("prefers cloud when it is ready", () => {
    expect(selectPairingEndpoint({
      cloudReady: true,
      cloudURL: "https://cloud.example",
      lanEnabled: true,
      lanHost: "192.168.1.8",
      port: 4747,
    })).toEqual({ baseURL: "https://cloud.example", transport: "cloud" });
  });

  it("falls back to the trusted LAN listener when cloud is unavailable", () => {
    expect(selectPairingEndpoint({
      cloudReady: false,
      cloudURL: "https://cloud.example",
      lanEnabled: true,
      lanHost: "192.168.1.8",
      port: 4747,
    })).toEqual({ baseURL: "http://192.168.1.8:4747", transport: "lan" });
  });

  it("does not invent a reachable endpoint without cloud or LAN", () => {
    expect(selectPairingEndpoint({
      cloudReady: false,
      cloudURL: "https://cloud.example",
      lanEnabled: false,
      lanHost: "192.168.1.8",
      port: 4747,
    })).toBeNull();
    expect(selectPairingEndpoint({
      cloudReady: false,
      cloudURL: "https://cloud.example",
      lanEnabled: true,
      lanHost: null,
      port: 4747,
    })).toBeNull();
  });
});

describe("pairingURLForBase", () => {
  it("keeps the one-time secret fragment while switching to the LAN Bridge", () => {
    expect(pairingURLForBase(
      "https://relay.example/#pairingId=p1&secret=s1&bridgeKey=k1",
      "http://192.168.1.8:4747",
    )).toBe("http://192.168.1.8:4747/#pairingId=p1&secret=s1&bridgeKey=k1");
  });

  it("rejects malformed or fragment-free pairing URLs", () => {
    expect(pairingURLForBase("not a URL", "http://192.168.1.8:4747")).toBeNull();
    expect(pairingURLForBase("https://relay.example/", "http://192.168.1.8:4747")).toBeNull();
  });
});
