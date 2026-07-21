import { describe, expect, it } from "vitest";
import { isTrustedLanAddress } from "../src/network.js";

describe("trusted LAN boundary", () => {
  it("accepts only loopback, RFC1918 and ULA", () => {
    for (const address of ["127.0.0.1", "::1", "10.2.3.4", "172.16.2.3", "172.31.255.1", "192.168.1.9", "fd00::1"]) {
      expect(isTrustedLanAddress(address), address).toBe(true);
    }
    for (const address of ["8.8.8.8", "172.15.1.1", "172.32.1.1", "169.254.1.1", "fe80::1", "2001:4860:4860::8888"]) {
      expect(isTrustedLanAddress(address), address).toBe(false);
    }
  });
});
