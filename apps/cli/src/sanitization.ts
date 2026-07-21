import { redactUnknown } from "@zimlo/adapters";

export function sanitizeEventPayload(payload: unknown): unknown {
  const redacted = redactUnknown(payload);
  const safe = redacted === undefined ? null : redacted;
  const serialized = JSON.stringify(safe);
  if (Buffer.byteLength(serialized, "utf8") <= 4_096) return safe;
  let preview = serialized;
  let result = { truncated: true, preview: `${preview}\n… [TRUNCATED] …` };
  while (Buffer.byteLength(JSON.stringify(result), "utf8") > 4_096 && preview.length > 64) {
    preview = preview.slice(0, Math.floor(preview.length * 0.8));
    result = { truncated: true, preview: `${preview}\n… [TRUNCATED] …` };
  }
  return result;
}
