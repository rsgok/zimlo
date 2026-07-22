const CONTEXT_PREFIX = /^<(?:recommended_plugins|environment_context|codex_internal_context|permissions instructions|app-context|skills_instructions|plugins_instructions|apps_instructions)\b/iu;

export function userInstructionText(value: unknown): string {
  if (typeof value === "string") return CONTEXT_PREFIX.test(value.trim()) ? "" : value.trim();
  if (Array.isArray(value)) return value.map(userInstructionText).filter(Boolean).join("\n").trim();
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (record.type === "tool_result") return "";
  if ((record.type === "input_text" || record.type === "text") && typeof record.text === "string") {
    return userInstructionText(record.text);
  }
  return userInstructionText(record.content);
}
