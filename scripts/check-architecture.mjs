import { execFileSync, spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ignoredDirectories = new Set([".build", ".git", ".next", ".swiftpm", "build", "coverage", "dist", "node_modules", "target"]);
const sourceExtensions = new Set([".js", ".mjs", ".rs", ".swift", ".ts", ".tsx"]);
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

const files = [
  ...await sourceFiles("apps"),
  ...await sourceFiles("packages"),
  ...await sourceFiles("runtime"),
  ...await sourceFiles("scripts"),
];
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
  // f0b8bf2 added the V3 presentation persistence path after the original
  // 1,500-line budget. Freeze the legacy Node store at its current baseline;
  // new persistence work belongs in the Rust repositories instead.
  "apps/cli/src/store.ts": 1_550,
  "apps/ios/Zimlo/AppModel.swift": 1_300,
  "apps/ios/Zimlo/SecondaryViews.swift": 1_400,
  "apps/macos/Sources/ZimloMac/OnboardingView.swift": 1_200,
  "apps/macos/Sources/ZimloMac/ServiceController.swift": 1_000,
  "apps/web/src/hooks/useBridge.ts": 850,
  "packages/protocol/src/index.ts": 800,
  // Freeze the native Runtime at the full Node-parity cutover baseline. The
  // bridge/store code now owns discovery, Cloud/Push, hooks/MCP and the
  // product service lifecycle; future feature growth still needs extraction.
  "runtime/crates/zimlo-bridge/src/lib.rs": 700,
  "runtime/crates/zimlo-bridge/src/tests.rs": 550,
  "runtime/crates/zimlo-bridge/src/websocket.rs": 525,
  "runtime/crates/zimlo-bridge/src/write_tests.rs": 350,
  "runtime/crates/zimlo-bridge/src/dispatcher.rs": 625,
  "runtime/crates/zimlo-bridge/src/agent_command.rs": 150,
  "runtime/crates/zimlo-bridge/src/action_broker.rs": 425,
  "runtime/crates/zimlo-bridge/src/action_dispatch.rs": 125,
  "runtime/crates/zimlo-bridge/src/action_dispatch_tests.rs": 100,
  "runtime/crates/zimlo-bridge/src/action_broker_tests.rs": 300,
  "runtime/crates/zimlo-bridge/src/claude_executor.rs": 650,
  "runtime/crates/zimlo-bridge/src/claude_executor_tests.rs": 300,
  "runtime/crates/zimlo-bridge/src/claude_stream.rs": 425,
  "runtime/crates/zimlo-bridge/src/codex_app_server.rs": 600,
  "runtime/crates/zimlo-bridge/src/codex_approval.rs": 525,
  "runtime/crates/zimlo-bridge/src/codex_approval_tests.rs": 75,
  "runtime/crates/zimlo-bridge/src/codex_executor.rs": 400,
  "runtime/crates/zimlo-bridge/src/codex_executor_tests.rs": 300,
  "runtime/crates/zimlo-bridge/src/materials.rs": 725,
  "runtime/crates/zimlo-bridge/src/management.rs": 250,
  "runtime/crates/zimlo-bridge/src/management_tests.rs": 350,
  "runtime/crates/zimlo-bridge/src/native_executor.rs": 100,
  "runtime/crates/zimlo-bridge/src/material_validation.rs": 350,
  "runtime/crates/zimlo-bridge/src/material_tests.rs": 450,
  "runtime/crates/zimlo-bridge/src/pairing.rs": 575,
  "runtime/crates/zimlo-bridge/src/task_runner.rs": 350,
  "runtime/crates/zimlo-bridge/src/trust_policy.rs": 375,
  "runtime/crates/zimlo-bridge/src/trust_policy_tests.rs": 175,
  "runtime/crates/zimlo-bridge/src/trust_dispatch.rs": 125,
  "runtime/crates/zimlo-bridge/src/trust_dispatch_tests.rs": 190,
  "runtime/crates/zimlo-bridge/src/task_runner_tests.rs": 325,
  "runtime/crates/zimlo-bridge/src/task_commands.rs": 250,
  "runtime/crates/zimlo-bridge/src/task_enqueue.rs": 375,
  "runtime/crates/zimlo-bridge/src/task_enqueue_tests.rs": 325,
  "runtime/crates/zimlo-store/src/lib.rs": 1_025,
  "runtime/crates/zimlo-store/src/devices.rs": 425,
  "runtime/crates/zimlo-store/src/materials.rs": 250,
  "runtime/crates/zimlo-store/src/mutations.rs": 725,
  "runtime/crates/zimlo-store/src/snapshot.rs": 950,
  "runtime/crates/zimlo-store/src/tests.rs": 250,
  "runtime/crates/zimlo-store/src/task_commands.rs": 600,
  "runtime/crates/zimlo-store/src/actions.rs": 425,
  "runtime/crates/zimlo-store/src/trust.rs": 450,
  "runtime/crates/zimlo-store/src/trust_tests.rs": 225,
  "runtime/crates/zimlo-store/src/task_command_tests.rs": 250,
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

const runtimeSchemaCheck = spawnSync(process.execPath, [resolve(repositoryRoot, "scripts/generate-runtime-schema.mjs"), "--check"], {
  cwd: repositoryRoot,
  encoding: "utf8",
});
if (runtimeSchemaCheck.status !== 0) failures.push(runtimeSchemaCheck.stderr.trim() || "generated Runtime schema is stale");

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
  if (/(^|\/)(?:node_modules|dist|target|\.build|DerivedData)(?:\/|$)/.test(relativePath)) {
    failures.push(`${relativePath} is generated output and must not be tracked`);
  }
}

if (failures.length > 0) {
  console.error(`Architecture checks failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Architecture checks passed (${files.length} source files inspected).`);
}
