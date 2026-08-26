export type APNsEnvironment = "development" | "production";

export interface APNsSecretBindings {
  APNS_SANDBOX_PRIVATE_KEY_P8?: string;
  APNS_SANDBOX_KEY_ID?: string;
  APNS_PRODUCTION_PRIVATE_KEY_P8?: string;
  APNS_PRODUCTION_KEY_ID?: string;
  // Legacy keys created before Apple introduced environment-scoped APNs keys.
  APNS_PRIVATE_KEY_P8?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_TOPIC?: string;
}

export interface APNsCredentials {
  privateKeyPEM: string;
  keyId: string;
  teamId: string;
  topic: string;
}

export function apnsCredentialsFor(
  env: APNsSecretBindings,
  environment: APNsEnvironment,
): APNsCredentials | null {
  if (!env.APNS_TEAM_ID || !env.APNS_TOPIC) return null;

  const scopedPrivateKey = environment === "production"
    ? env.APNS_PRODUCTION_PRIVATE_KEY_P8
    : env.APNS_SANDBOX_PRIVATE_KEY_P8;
  const scopedKeyId = environment === "production"
    ? env.APNS_PRODUCTION_KEY_ID
    : env.APNS_SANDBOX_KEY_ID;
  const hasScopedValue = Boolean(scopedPrivateKey || scopedKeyId);

  // Never combine one half of an environment-scoped key with a legacy key.
  // A partial rotation must fail closed instead of signing with a mismatched ID.
  const privateKeyPEM = hasScopedValue ? scopedPrivateKey : env.APNS_PRIVATE_KEY_P8;
  const keyId = hasScopedValue ? scopedKeyId : env.APNS_KEY_ID;
  if (!privateKeyPEM || !keyId) return null;

  return {
    privateKeyPEM,
    keyId,
    teamId: env.APNS_TEAM_ID,
    topic: env.APNS_TOPIC,
  };
}

export function apnsConfigurationStatus(env: APNsSecretBindings): {
  development: boolean;
  production: boolean;
  configured: boolean;
} {
  const development = apnsCredentialsFor(env, "development") !== null;
  const production = apnsCredentialsFor(env, "production") !== null;
  return { development, production, configured: development && production };
}
