export function summarizeVitestList(value) {
  if (!Array.isArray(value)) throw new Error("vitest list output is not an array");
  const tests = value.filter((entry) => entry && typeof entry === "object"
    && typeof entry.name === "string" && typeof entry.file === "string");
  if (tests.length === 0) throw new Error("vitest list returned no test cases");
  return {
    testFiles: new Set(tests.map((entry) => entry.file)).size,
    testCases: tests.length,
  };
}
