import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const root = resolve(import.meta.dirname, "..");
const definitions = [
  { name: "node", command: process.execPath, prefix: [join(root, "apps/cli/dist/index.js")] },
  { name: "rust", command: join(root, "runtime/target/release/zimlo"), prefix: [] },
];

const results = { generatedAt: new Date().toISOString(), checks: [] };
const record = (name, detail) => results.checks.push({ name, status: "pass", detail });

function environment(home) {
  return {
    ...process.env,
    HOME: home,
    ZIMLO_HOME: join(home, ".zimlo"),
    ZIMLO_CLOUD_DISABLED: "1",
    NO_PROXY: "127.0.0.1,localhost",
  };
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Runtime exited with ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("Runtime health timeout");
}

async function startRuntime(definition) {
  const home = await mkdtemp(join(tmpdir(), `zimlo-parity-${definition.name}-`));
  await mkdir(join(home, ".zimlo"), { recursive: true });
  const port = await freePort();
  const output = [];
  const child = spawn(
    definition.command,
    [...definition.prefix, "start", "--port", String(port)],
    { cwd: root, env: environment(home), stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  try {
    const health = await waitForHealth(port, child);
    return { definition, home, port, child, health, output };
  } catch (error) {
    child.kill("SIGTERM");
    await rm(home, { recursive: true, force: true });
    throw new Error(`${definition.name}: ${error.message}\n${output.join("")}`);
  }
}

async function stopRuntime(runtime) {
  if (runtime.child.exitCode === null) {
    runtime.child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveWait) => runtime.child.once("exit", resolveWait)),
      new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
    ]);
    if (runtime.child.exitCode === null) runtime.child.kill("SIGKILL");
  }
  await rm(runtime.home, { recursive: true, force: true });
}

async function json(port, path, options) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
  assert.equal(response.ok, true, `${path}: ${response.status}`);
  return response.json();
}

async function runHook(runtime, payload) {
  const child = spawn(
    runtime.definition.command,
    [...runtime.definition.prefix, "hook", "--provider", "codex", "--surface", "cli"],
    { cwd: root, env: environment(runtime.home), stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdin.end(JSON.stringify(payload));
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  const code = await new Promise((resolveExit) => child.once("exit", resolveExit));
  assert.equal(code, 0, stderr.join(""));
}

async function commandOutput(definition, args) {
  const child = spawn(definition.command, [...definition.prefix, ...args], {
    cwd: root,
    env: { ...process.env, ZIMLO_CLOUD_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  const code = await new Promise((resolveExit) => child.once("exit", resolveExit));
  assert.equal(code, 0, `${definition.name} ${args.join(" ")} failed:\n${output.join("")}`);
  return output.join("");
}

async function verifyOperatorCommands() {
  const surfaces = [
    { args: ["--help"], commands: ["start", "status", "stop", "logs", "doctor", "hooks", "codex-plugin", "devices", "open", "hook", "mcp"] },
    { args: ["hooks", "--help"], commands: ["diff", "status", "install", "uninstall"] },
    { args: ["codex-plugin", "--help"], commands: ["status", "install", "uninstall"] },
    { args: ["devices", "--help"], commands: ["list", "revoke"] },
  ];
  for (const surface of surfaces) {
    const outputs = await Promise.all(definitions.map((definition) => commandOutput(definition, surface.args)));
    for (const command of surface.commands) {
      for (const [index, output] of outputs.entries()) {
        assert.match(output, new RegExp(`\\b${command.replace("-", "[-]")}\\b`, "u"), `${definitions[index].name} is missing ${command}`);
      }
    }
  }
  const commandCount = surfaces.reduce((total, surface) => total + surface.commands.length, 0);
  record("operator-command-surface", `${commandCount} top-level and nested operator commands retained by Rust`);
}

async function mcpExchange(runtime, messages) {
  const child = spawn(
    runtime.definition.command,
    [...runtime.definition.prefix, "mcp", "--provider", "codex"],
    { cwd: root, env: environment(runtime.home), stdio: ["pipe", "pipe", "pipe"] },
  );
  const responses = new Map();
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(chunk.toString()));
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    responses.set(value.id, value);
  });
  for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  const deadline = Date.now() + 5_000;
  while (responses.size < messages.length && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  child.stdin.end();
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 1_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGTERM");
  assert.equal(responses.size, messages.length, errors.join(""));
  return messages.map((message) => responses.get(message.id));
}

function keys(value) {
  return Object.keys(value).sort();
}

function normalizeSchema(value) {
  if (Array.isArray(value)) return value.map(normalizeSchema);
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value)
    .filter(([key]) => !["description", "title", "default"].includes(key))
    .map(([key, nested]) => [key, normalizeSchema(nested)]);
  const normalized = Object.fromEntries(entries);
  if (Array.isArray(normalized.oneOf)
      && normalized.oneOf.every((item) => item && typeof item === "object" && "const" in item)) {
    normalized.enum = normalized.oneOf.map((item) => item.const);
    delete normalized.oneOf;
  }
  return normalized;
}

function semanticSnapshot(snapshot) {
  return {
    session: snapshot.sessions.find((session) => session.providerSessionId === "parity-session") && {
      provider: "codex",
      surface: snapshot.sessions.find((session) => session.providerSessionId === "parity-session").surface,
      providerSessionId: "parity-session",
      status: snapshot.sessions.find((session) => session.providerSessionId === "parity-session").status,
    },
    posts: snapshot.posts.map((post) => ({
      taskId: post.taskId,
      kind: post.kind,
      presentation: post.presentation,
      headline: post.headline,
      takeaway: post.takeaway,
      highlights: post.highlights,
      blocks: post.blocks,
      proof: post.proof,
      content: post.content,
      dedupeKey: post.dedupeKey,
      source: post.source,
    })),
    tasks: snapshot.tasks.map((task) => ({
      id: task.id,
      state: task.state,
      reason: task.reason,
    })),
  };
}

async function verifyCommandInventory() {
  const protocol = await readFile(join(root, "packages/protocol/src/index.ts"), "utf8");
  const commandSection = protocol.slice(
    protocol.indexOf("const ClientCommandPayloadSchema"),
    protocol.indexOf("export const ClientCommandSchema"),
  );
  const commands = [...commandSection.matchAll(/type:\s*z\.literal\("([^"]+)"\)/g)]
    .map((match) => match[1]);
  const unique = [...new Set(commands)].sort();
  const node = await readFile(join(root, "apps/cli/src/bridge.ts"), "utf8");
  const rust = `${await readFile(join(root, "runtime/crates/zimlo-bridge/src/dispatcher.rs"), "utf8")}\n${await readFile(join(root, "runtime/crates/zimlo-bridge/src/websocket.rs"), "utf8")}`;
  const missingNode = unique.filter((command) => !node.includes(`\"${command}\"`));
  const missingRust = unique.filter((command) => !rust.includes(`\"${command}\"`));
  assert.deepEqual(missingNode, []);
  assert.deepEqual(missingRust, []);
  record("client-command-inventory", `${unique.length} protocol commands implemented by both runtimes`);
  return unique;
}

const runtimes = [];
try {
  const commands = await verifyCommandInventory();
  await verifyOperatorCommands();
  runtimes.push(...await Promise.all(definitions.map(startRuntime)));
  assert.deepEqual(runtimes[0].health, runtimes[1].health);
  record("health-contract", "health payloads are byte-semantic equivalents");

  const bootstraps = await Promise.all(runtimes.map((runtime) => json(runtime.port, "/api/local-bootstrap")));
  for (const bootstrap of bootstraps) {
    assert.deepEqual(keys(bootstrap), ["deviceId", "deviceKey", "host"]);
    assert.equal(Buffer.from(bootstrap.deviceKey.replaceAll("-", "+").replaceAll("_", "/"), "base64").length, 32);
    assert.deepEqual(keys(bootstrap.host), ["id", "lastSeenAt", "name", "platform"]);
  }
  record("local-bootstrap", "same response fields and 256-bit local device key contract");

  const initialSnapshots = await Promise.all(runtimes.map((runtime) => json(runtime.port, "/api/local/snapshot")));
  assert.deepEqual(keys(initialSnapshots[0]), keys(initialSnapshots[1]));
  assert.deepEqual(initialSnapshots.map((snapshot) => snapshot.features), [runtimes[0].health.features, runtimes[1].health.features]);
  record("snapshot-contract", `${keys(initialSnapshots[0]).length} top-level fields and feature flags match`);

  const startPayload = {
    session_id: "parity-session",
    hook_event_name: "SessionStart",
    cwd: root,
  };
  const promptPayload = {
    session_id: "parity-session",
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "验证 OPENAI_API_KEY=parity-secret 的 Runtime 行为",
  };
  for (const runtime of runtimes) {
    await runHook(runtime, startPayload);
    await runHook(runtime, promptPayload);
  }
  const feedArguments = {
    task_id: "parity-session",
    kind: "result",
    presentation: {
      system: "auto", theme: "auto", layout: "auto",
      typography: "auto", density: "auto", mediaPlacement: "auto",
    },
    headline: "Runtime 对拍完成",
    takeaway: "两个实现返回相同语义结果",
    highlights: ["协议一致", "状态一致"],
    blocks: [{ type: "fact", label: "结果", detail: "同一输入已通过" }],
    dedupe_key: "runtime-parity-result-v1",
    state: "completed",
    state_reason: "对拍用例完成",
  };
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "feed.post", arguments: feedArguments } },
  ];
  const mcp = await Promise.all(runtimes.map((runtime) => mcpExchange(runtime, messages)));
  assert.deepEqual(mcp.map((set) => set[0].result), [mcp[0][0].result, mcp[0][0].result]);
  const toolNames = mcp.map((set) => set[1].result.tools.map((tool) => tool.name));
  assert.deepEqual(toolNames[0], toolNames[1]);
  const schemas = mcp.map((set) => Object.fromEntries(set[1].result.tools.map((tool) => [tool.name, normalizeSchema(tool.inputSchema)])));
  assert.deepEqual(schemas[0], schemas[1]);
  const calls = mcp.map((set) => JSON.parse(set[2].result.content[0].text));
  assert.equal(calls[0].ok, true);
  assert.equal(calls[1].ok, true);
  assert.deepEqual(
    calls.map((call) => ({ message: call.message, deduplicated: call.data.deduplicated, coalesced: call.data.coalesced, task_state: call.data.task_state })),
    [
      { message: "Feed 已发布。", deduplicated: false, coalesced: false, task_state: "completed" },
      { message: "Feed 已发布。", deduplicated: false, coalesced: false, task_state: "completed" },
    ],
  );
  record("mcp-tools", `${toolNames[0].length} tools have equivalent schemas and live feed.post behavior`);

  for (const runtime of runtimes) {
    await runHook(runtime, {
      session_id: "parity-session",
      hook_event_name: "Stop",
      cwd: root,
    });
  }
  const snapshots = await Promise.all(runtimes.map((runtime) => json(runtime.port, "/api/local/snapshot")));
  assert.deepEqual(semanticSnapshot(snapshots[0]), semanticSnapshot(snapshots[1]));
  const sessionIds = snapshots.map((snapshot) => snapshot.sessions.find((session) => session.providerSessionId === "parity-session").id);
  assert.equal(sessionIds[0], sessionIds[1]);
  const eventKinds = await Promise.all(runtimes.map((runtime, index) => json(runtime.port, `/api/local/sessions/${sessionIds[index]}/events`)));
  assert.deepEqual(
    eventKinds[0].events.map((event) => event.kind),
    eventKinds[1].events.map((event) => event.kind),
  );
  assert.equal(JSON.stringify(eventKinds[0]).includes("parity-secret"), false);
  assert.equal(JSON.stringify(eventKinds[1]).includes("parity-secret"), false);
  record("hook-and-state-flow", "stable IDs, event kinds, redaction, Feed and task terminal state match");

  results.commandCount = commands.length;
  results.toolNames = toolNames[0];
  results.summary = { passed: results.checks.length, failed: 0 };
  await writeFile(join(root, "docs/runtime-parity-results.json"), `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} finally {
  await Promise.all(runtimes.map(stopRuntime));
}
