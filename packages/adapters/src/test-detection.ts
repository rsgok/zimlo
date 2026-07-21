const TEST_COMMAND = /(?:^|\s|\/)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|(?:^|\s)(?:pytest|jest|vitest|mocha|cargo\s+test|swift\s+test|go\s+test|dotnet\s+test|mvn\s+test|gradle\s+test)\b/iu;

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command);
}

export function findExitCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    try {
      return findExitCode(JSON.parse(value));
    } catch {
      const match = value.match(/(?:exit(?:_code| code)?|process exited with code)\D{0,8}(-?\d+)/iu);
      return match ? Number(match[1]) : null;
    }
  }
  if (Array.isArray(value)) {
    for (const nested of value) {
      const result = findExitCode(nested);
      if (result !== null) return result;
    }
    return null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["exit_code", "exitCode", "code"]) {
      if (typeof record[key] === "number") return record[key];
    }
    for (const nested of Object.values(record)) {
      const result = findExitCode(nested);
      if (result !== null) return result;
    }
  }
  return null;
}

export function readCommand(input: Record<string, unknown>): string | null {
  for (const key of ["command", "cmd", "script"]) {
    if (typeof input[key] === "string") return input[key];
  }
  return null;
}
