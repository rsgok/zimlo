import { describe, expect, it } from "vitest";
import { validPairingId } from "./identifiers.js";

describe("cloud identifiers", () => {
  it("accepts UUIDv7 pairing ids across timestamp-prefix boundaries", () => {
    expect(validPairingId("019fffff-ffff-7abc-8def-0123456789ab")).toBe(true);
    expect(validPairingId("01a00000-0000-7abc-8def-0123456789ab")).toBe(true);
  });

  it("rejects non-v7 and unsafe pairing ids", () => {
    expect(validPairingId("01a00000-0000-4abc-8def-0123456789ab")).toBe(false);
    expect(validPairingId("device_01a00000-0000-7abc-8def-0123456789ab")).toBe(false);
    expect(validPairingId("01a00000-0000-7abc-8def-../../secret")).toBe(false);
  });
});
