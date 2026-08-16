import { execFileSync, spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ignoredDirectories = new Set([".build", ".git", ".next", ".swiftpm", "build", "coverage", "dist", "node_modules"]);
const sourceExtensions = new Set([".js", ".mjs", ".swift", ".ts", ".tsx"]);
const failures = [];

async function sourceFiles(directory) {
  if (directory === "apps/cli/public") return [];
  const entries = await readdir(resolve(repositoryRoot, directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const relativePath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await sourceFiles(relativePath));
    else if (sourceExtensions.has(extname(entry.name))) files.push(relativePath);
  }
  return files;
}

const files = [...await sourceFiles("apps"), ...await sourceFiles("packages"), ...await sourceFiles("scripts")];
const importPattern = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;

for (const relativePath of files) {
  const contents = await readFile(resolve(repositoryRoot, relativePath), "utf8");
  const lines = contents.split("\n");
  const oversizedLine = lines.findIndex((line) => line.length > 4_000);
  if (oversizedLine >= 0) {
    failures.push(`${relativePath}:${oversizedLine + 1} embeds more than 4,000 characters on one line; move generated or binary data to a resource`);
  }
  if (/data:image\/[^;]+;base64,[A-Za-z0-9+/=]{512}/.test(contents)) {
    failures.push(`${relativePath} embeds image data; use apps/shared/branding resources`);
  }

  if (!relativePath.startsWith("packages/")) continue;
  for (const match of contents.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier) continue;
    if (specifier.includes("/apps/") || specifier.startsWith("../../apps")) {
      failures.push(`${relativePath} imports application code (${specifier}); packages must remain app-independent`);
    }
    if (relativePath.startsWith("packages/protocol/") && specifier.startsWith("@zimlo/")) {
      failures.push(`${relativePath} imports ${specifier}; protocol is the dependency root`);
    }
    if (
      relativePath.startsWith("packages/adapters/")
      && specifier.startsWith("@zimlo/")
      && specifier !== "@zimlo/protocol"
      && specifier !== "@zimlo/protocol/crypto"
    ) {
      failures.push(`${relativePath} imports ${specifier}; adapters may depend only on protocol`);
    }
  }
}

const lineBudgets = {
  "apps/cli/src/store.ts": 1_500,
  "apps/ios/Zimlo/AppModel.swift": 1_300,
  "apps/ios/Zimlo/SecondaryViews.swift": 1_400,
  "apps/macos/Sources/ZimloMac/OnboardingView.swift": 1_200,
  "apps/macos/Sources/ZimloMac/ServiceController.swift": 1_000,
  "apps/web/src/hooks/useBridge.ts": 850,
  "packages/protocol/src/index.ts": 800,
};

for (const [relativePath, maximum] of Object.entries(lineBudgets)) {
  const contents = await readFile(resolve(repositoryRoot, relativePath), "utf8");
  const count = contents.split("\n").length - 1;
  if (count > maximum) failures.push(`${relativePath} has ${count} lines; architecture budget is ${maximum}`);
}

const contractCheck = spawnSync(process.execPath, [resolve(repositoryRoot, "scripts/generate-contract.mjs"), "--check"], {
  cwd: repositoryRoot,
  encoding: "utf8",
});
if (contractCheck.status !== 0) failures.push(contractCheck.stderr.trim() || "generated contract files are stale");

const contract = JSON.parse(await readFile(resolve(repositoryRoot, "config/zimlo-contract.json"), "utf8"));
for (const packagePath of [
  "package.json",
  "apps/cli/package.json",
  "apps/cloud/package.json",
  "apps/web/package.json",
  "packages/adapters/package.json",
  "packages/protocol/package.json",
]) {
  const manifest = JSON.parse(await readFile(resolve(repositoryRoot, packagePath), "utf8"));
  if (manifest.version !== contract.productVersion) {
    failures.push(`${packagePath} version ${manifest.version} does not match config/zimlo-contract.json (${contract.productVersion})`);
  }
}

const trackedFiles = execFileSync("git", ["ls-files", "-z"], { cwd: repositoryRoot, encoding: "utf8" }).split("\0").filter(Boolean);
for (const relativePath of trackedFiles) {
  if (/(^|\/)(?:node_modules|dist|\.build|DerivedData)(?:\/|$)/.test(relativePath)) {
    failures.push(`${relativePath} is generated output and must not be tracked`);
  }
}

if (failures.length > 0) {
  console.error(`Architecture checks failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Architecture checks passed (${files.length} source files inspected).`);
}
