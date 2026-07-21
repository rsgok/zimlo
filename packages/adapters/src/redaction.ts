const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/giu, "[REDACTED_PRIVATE_KEY]"],
  [/\b(?:sk|pk)-(?:live|test|proj)?[_-]?[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED_API_KEY]"],
  [/\b(?:ghp|github_pat|glpat)-[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED_TOKEN]"],
  [/\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/giu, "Bearer [REDACTED]"],
  [/\b((?:API|ACCESS|AUTH|SECRET|PRIVATE|SESSION|DATABASE|DB|OPENAI|ANTHROPIC)[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|URL)?)\s*=\s*([^\s"']+|"[^"]*"|'[^']*')/giu, "$1=[REDACTED]"],
  [/\b([A-Z][A-Z0-9_]{1,})\s*=\s*([^\s"']+|"[^"]*"|'[^']*')/gu, "$1=[REDACTED]"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, "[REDACTED_AWS_KEY]"],
];

export function redactText(value: string, maxLength = 4096): string {
  let redacted = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  if (redacted.length <= maxLength) return redacted;
  const half = Math.floor((maxLength - 32) / 2);
  return `${redacted.slice(0, half)}\n… [TRUNCATED] …\n${redacted.slice(-half)}`;
}

export function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const path = Object.entries(source).find(([key, nested]) => {
      return /^(?:path|file_?path|filename|name)$/iu.test(key) && typeof nested === "string";
    })?.[1];
    const isEnvFile = typeof path === "string" && /(?:^|\/)\.env(?:\.[^/]+)?$/iu.test(path);
    return Object.fromEntries(
      Object.entries(source).map(([key, nested]) => {
        if (/^(?:env|environment|secrets?)$/iu.test(key)) return [key, "[REDACTED]"];
        if (isEnvFile && /^(?:content|text|output|value|data|diff|patch)$/iu.test(key)) return [key, "[REDACTED_ENV_FILE]"];
        return [key, redactUnknown(nested)];
      }),
    );
  }
  return value;
}
