import { describe, expect, it } from "vitest";
import { apnsConfigurationStatus, apnsCredentialsFor, type APNsSecretBindings } from "./apns-config.js";

const common = {
  APNS_TEAM_ID: "TEAM123456",
  APNS_TOPIC: "com.zimlo.ios",
} satisfies APNsSecretBindings;

describe("APNs environment configuration", () => {
  it("selects independent sandbox and production credentials", () => {
    const env = {
      ...common,
      APNS_SANDBOX_PRIVATE_KEY_P8: "sandbox-key",
      APNS_SANDBOX_KEY_ID: "SANDBOX01",
      APNS_PRODUCTION_PRIVATE_KEY_P8: "production-key",
      APNS_PRODUCTION_KEY_ID: "PRODUCT01",
    };

    expect(apnsCredentialsFor(env, "development")).toEqual({
      privateKeyPEM: "sandbox-key",
      keyId: "SANDBOX01",
      teamId: common.APNS_TEAM_ID,
      topic: common.APNS_TOPIC,
    });
    expect(apnsCredentialsFor(env, "production")?.keyId).toBe("PRODUCT01");
    expect(apnsConfigurationStatus(env)).toEqual({
      development: true,
      production: true,
      configured: true,
    });
  });

  it("keeps legacy cross-environment keys compatible", () => {
    const env = {
      ...common,
      APNS_PRIVATE_KEY_P8: "legacy-key",
      APNS_KEY_ID: "LEGACY0001",
    };

    expect(apnsCredentialsFor(env, "development")?.keyId).toBe("LEGACY0001");
    expect(apnsCredentialsFor(env, "production")?.keyId).toBe("LEGACY0001");
    expect(apnsConfigurationStatus(env).configured).toBe(true);
  });

  it("fails closed for a partial scoped key instead of mixing credentials", () => {
    const env = {
      ...common,
      APNS_PRIVATE_KEY_P8: "legacy-key",
      APNS_KEY_ID: "LEGACY0001",
      APNS_SANDBOX_PRIVATE_KEY_P8: "sandbox-key",
    };

    expect(apnsCredentialsFor(env, "development")).toBeNull();
    expect(apnsCredentialsFor(env, "production")?.keyId).toBe("LEGACY0001");
    expect(apnsConfigurationStatus(env).configured).toBe(false);
  });
});
