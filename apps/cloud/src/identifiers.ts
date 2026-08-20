const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Pairing ids are UUIDv7 values. Their leading timestamp hex changes over
 * time, so validation must check the UUID shape instead of a current prefix.
 */
export function validPairingId(value: unknown): value is string {
  return typeof value === "string" && UUID_V7.test(value);
}
