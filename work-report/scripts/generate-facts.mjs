// Generates app/facts.json with verifiable numbers from the Zimlo monorepo.
// Runs as the npm `prebuild` hook. When the monorepo root (`..`) is not
// available (e.g. the site is built standalone), the previously committed
// app/facts.json is kept and a warning is printed instead.

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeVitestList } from "./fact-utils.mjs";

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const monorepoRoot = resolve(siteRoot, "..");
const factsPath = join(siteRoot, "app", "facts.json");

function git(...args) {
  return execFileSync("git", ["-C", monorepoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

// https://github.com/org/repo.git / git@github.com:org/repo.git -> https://github.com/org/repo/commit/
function commitBaseUrl(remote) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/.]+)(?:\.git)?$/.exec(remote ?? "");
  return match ? `https://github.com/${match[1]}/commit/` : null;
}

function reuseExisting(reason) {
  if (existsSync(factsPath)) {
    console.warn(`[generate-facts] ${reason}; keeping committed app/facts.json`);
    return;
  }
  console.error(`[generate-facts] ${reason} and no committed app/facts.json to reuse`);
  process.exit(1);
}

try {
  if (!existsSync(join(monorepoRoot, ".git"))) {
    reuseExisting(`monorepo root ${monorepoRoot} is not a git checkout`);
  } else {
    const listed = execFileSync("pnpm", ["exec", "vitest", "list", "--json"], {
      cwd: monorepoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
    const summary = summarizeVitestList(JSON.parse(listed));
    const facts = {
      ...summary,
      commit: git("rev-parse", "--short", "HEAD"),
      dirty: git("status", "--porcelain").length > 0,
      commitBaseUrl: commitBaseUrl(git("remote", "get-url", "origin")),
      generatedAt: new Date().toISOString(),
    };
    writeFileSync(factsPath, `${JSON.stringify(facts, null, 2)}\n`);
    console.log(`[generate-facts] ${facts.testFiles} test files, ${facts.testCases} test cases, commit ${facts.commit}${facts.dirty ? " + dirty worktree" : ""}`);
  }
} catch (error) {
  reuseExisting(`failed to collect facts (${error.message})`);
}
