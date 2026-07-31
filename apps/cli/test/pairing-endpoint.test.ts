import { describe, expect, it } from "vitest";
import { selectPairingEndpoint } from "../src/pairing-endpoint.js";

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
