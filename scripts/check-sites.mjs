import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const factsPath = resolve(repositoryRoot, "work-report/app/facts.json");
const trackedFacts = await readFile(factsPath);
const checks = [
  ["landing-page", "lint"],
  ["landing-page", "test"],
  ["work-report", "lint"],
  ["work-report", "test"],
];

try {
  for (const [project, command] of checks) {
    const result = spawnSync("npm", ["--prefix", project, "run", command], {
      cwd: repositoryRoot,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  // The report deliberately generates current repository facts before builds.
  // Verification must leave the caller's tracked snapshot untouched.
  await writeFile(factsPath, trackedFacts);
}
