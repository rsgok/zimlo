import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, webcrypto } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import WebSocket from "../apps/cli/node_modules/ws/wrapper.mjs";
import { ZimloStore } from "../apps/cli/dist/store.js";
import {
  createKeyPair,
  decryptFrame,
  deriveConnectionKeys,
  deriveDeviceKey,
  derivePairKey,
  encryptFrame,
  fromBase64Url,
  makeProof,
  randomBytes,
  toBase64Url,
  verifyProof,
} from "../packages/protocol/dist/crypto.js";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runtimeBinary = join(repositoryRoot, "runtime/target/debug/zimlo");
const fixturePath = join(repositoryRoot, "packages/protocol/test-vectors/snapshot-compat.sql");
const temporaryRoot = mkdtempSync(join(tmpdir(), "zimlo-rust-write-smoke-"));
const databasePath = join(temporaryRoot, "zimlo.db");
const workspacePath = join(temporaryRoot, "workspace");
const fakeClaudePath = join(temporaryRoot, "fake-claude");
const fakeCodexPath = join(temporaryRoot, "fake-codex");
const materialId = "material_nodecrossimpl1234";
const materialBytes = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("node-to-rust-material"),
]);
let runtime;
let socket;

function prepareFakeClaude() {
  mkdirSync(workspacePath);
  const records = [
    { type: "system", subtype: "init", sessionId: "claude-rust-smoke", cwd: workspacePath, model: "claude", timestamp: "2026-09-02T00:00:00.000Z", uuid: "turn-rust-smoke" },
    { type: "assistant", sessionId: "claude-rust-smoke", timestamp: "2026-09-02T00:00:01.000Z", uuid: "turn-rust-smoke", message: { stop_reason: "end_turn", content: [{ type: "text", text: "Rust Claude smoke completed" }] } },
  ];
  const output = records.map((record) => `printf '%s\\n' '${JSON.stringify(record)}'`).join("\n");
  writeFileSync(fakeClaudePath, `#!/bin/sh\n${output}\n`);
  chmodSync(fakeClaudePath, 0o700);
}

function prepareFakeCodex() {
  const script = `#!/bin/sh
IFS= read -r line
printf '%s\\n' '{"id":1,"result":{}}'
IFS= read -r line
IFS= read -r line
printf '%s\\n' '{"id":2,"result":{"thread":{"id":"codex-rust-smoke","status":{"type":"idle"}}}}'
IFS= read -r line
printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-codex-smoke","status":"inProgress"}}}'
printf '%s\\n' '{"method":"turn/started","params":{"threadId":"codex-rust-smoke","turn":{"id":"turn-codex-smoke","status":"inProgress"}}}'
printf '%s\\n' '{"id":100,"method":"item/commandExecution/requestApproval","params":{"threadId":"codex-rust-smoke","turnId":"turn-codex-smoke","itemId":"safe-command-codex-smoke","command":"cargo test"}}'
IFS= read -r automatic
case "$automatic" in *'"decision":"accept"'*) ;; *) exit 40;; esac
printf '%s\\n' '{"id":101,"method":"item/commandExecution/requestApproval","params":{"threadId":"codex-rust-smoke","turnId":"turn-codex-smoke","itemId":"command-codex-smoke","command":"git push origin main"}}'
IFS= read -r approval
case "$approval" in *'"decision":"accept"'*) ;; *) exit 41;; esac
printf '%s\\n' '{"id":102,"method":"item/tool/requestUserInput","params":{"threadId":"codex-rust-smoke","turnId":"turn-codex-smoke","itemId":"input-codex-smoke","questions":[{"id":"q1","header":"Continue","question":"Proceed?"}]}}'
IFS= read -r input
case "$input" in *'rust-phone-answer'*) ;; *) exit 42;; esac
printf '%s\\n' '{"method":"item/completed","params":{"threadId":"codex-rust-smoke","turnId":"turn-codex-smoke","item":{"id":"command-codex-smoke","type":"commandExecution","command":"cargo test","exitCode":0}}}'
printf '%s\\n' '{"method":"turn/completed","params":{"threadId":"codex-rust-smoke","turn":{"id":"turn-codex-smoke","status":"completed"}}}'
`;
  writeFileSync(fakeCodexPath, script);
  chmodSync(fakeCodexPath, 0o700);
}

function prepareNodeDatabase() {
  const store = new ZimloStore(databasePath);
  store.database.exec(readFileSync(fixturePath, "utf8"));
  store.database.prepare("UPDATE project_locations SET path = ? WHERE project_id = 'project-snapshot'").run(workspacePath);
  // Keep the recovered fixture command queued until the encrypted client can
  // cancel it. A deliberately unsupported provider prevents discovery from
  // racing the native Codex/Claude runner while preserving the persistence
  // and cancellation contract under test.
  store.database.prepare(
    "UPDATE task_commands SET state = 'dispatching', provider = 'fixture', error = 'interrupted' WHERE id = 'command-snapshot'",
  ).run();
  store.close();
}

async function startRuntime() {
  runtime = spawn(runtimeBinary, [
    "start",
    "--port", "0",
    "--lan",
    "--database", databasePath,
    "--write",
  ], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ZIMLO_HOST_NAME: "Rust Write Smoke",
      ZIMLO_LAN_HOST: "192.168.1.50",
      ZIMLO_CLAUDE_BIN: fakeClaudePath,
      ZIMLO_CODEX_BIN: fakeCodexPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  runtime.stdout.setEncoding("utf8");
  runtime.stderr.setEncoding("utf8");
  runtime.stdout.on("data", (chunk) => { output += chunk; });
  runtime.stderr.on("data", (chunk) => { output += chunk; });
  const deadline = Date.now() + 10_000;
  let port;
  while (Date.now() < deadline) {
    port = output.match(/http:\/\/127\.0\.0\.1:(\d+)/u)?.[1];
    if (port) {
      const baseUrl = `http://127.0.0.1:${port}`;
      try {
        const response = await fetch(`${baseUrl}/healthz`);
        if (response.ok) return baseUrl;
      } catch {}
    }
    if (runtime.exitCode !== null) throw new Error(`Rust Runtime exited early:\n${output}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Rust Runtime did not become healthy:\n${output}`);
}

async function pair(baseUrl) {
  const created = await fetch(`${baseUrl}/api/local/pairing`, { method: "POST" });
  assert.equal(created.status, 200);
  const payload = await created.json();
  const fragment = new URLSearchParams(new URL(payload.pairUrl).hash.slice(1));
  const pairingId = fragment.get("pairingId");
  const secret = fromBase64Url(fragment.get("secret"));
  const bridgeKey = fromBase64Url(fragment.get("bridgeKey"));
  const client = createKeyPair();
  const pairKey = derivePairKey(client.privateKey, bridgeKey, secret);
  const completed = await fetch(`${baseUrl}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pairingId,
      clientPublicKey: toBase64Url(client.publicKey),
      proof: makeProof(pairKey, `client:${pairingId}`),
      name: "Node Cross-Implementation Smoke",
    }),
  });
  assert.equal(completed.status, 200);
  const credentials = await completed.json();
  assert.equal(verifyProof(pairKey, `server:${credentials.deviceId}`, credentials.serverProof), true);
  const replay = await fetch(`${baseUrl}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pairingId,
      clientPublicKey: toBase64Url(client.publicKey),
      proof: makeProof(pairKey, `client:${pairingId}`),
    }),
  });
  assert.equal(replay.status, 410);
  return { deviceId: credentials.deviceId, deviceKey: deriveDeviceKey(pairKey, secret) };
}

async function connect(baseUrl, credentials) {
  const wsUrl = new URL("/ws", baseUrl);
  wsUrl.protocol = "ws:";
  socket = new WebSocket(wsUrl);
  const clientNonce = randomBytes(24);
  const clientNonceText = toBase64Url(clientNonce);
  const aad = `zimlo-ws-v1:${credentials.deviceId}`;
  let clientTx;
  let serverTx;
  let receiveCounter = 0;
  let sendCounter = 0;
  const messages = [];
  const waiters = [];

  function deliver(message) {
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
    else messages.push(message);
  }

  const authenticated = new Promise((resolveAuth, reject) => {
    socket.on("open", () => socket.send(JSON.stringify({
      type: "auth",
      deviceId: credentials.deviceId,
      clientNonce: clientNonceText,
      proof: makeProof(credentials.deviceKey, `ws:${clientNonceText}`),
    })));
    socket.on("error", reject);
    socket.on("message", (raw) => {
      try {
        const frame = JSON.parse(raw.toString());
        if (frame.type === "auth.ok") {
          assert.equal(
            verifyProof(credentials.deviceKey, `ws-server:${clientNonceText}:${frame.serverNonce}`, frame.proof),
            true,
          );
          const keys = deriveConnectionKeys(credentials.deviceKey, clientNonce, fromBase64Url(frame.serverNonce));
          clientTx = keys.clientTx;
          serverTx = keys.serverTx;
          resolveAuth();
          return;
        }
        assert.equal(frame.type, "secure");
        assert.equal(frame.counter, receiveCounter);
        deliver(decryptFrame(serverTx, receiveCounter, frame.ciphertext, aad));
        receiveCounter += 1;
      } catch (error) {
        reject(error);
      }
    });
  });
  await authenticated;

  return {
    send(command) {
      socket.send(JSON.stringify({
        type: "secure",
        counter: sendCounter,
        ciphertext: encryptFrame(clientTx, sendCounter, command, aad),
      }));
      sendCounter += 1;
    },
    next(predicate) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolveMessage, reject) => {
        let timer;
        const waiter = {
          predicate,
          resolve(message) {
            clearTimeout(timer);
            resolveMessage(message);
          },
        };
        waiters.push(waiter);
        timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("Timed out waiting for an encrypted Runtime response"));
        }, 5_000);
      });
    },
  };
}

async function verifyWriteFlow(baseUrl, credentials) {
  const bridge = await connect(baseUrl, credentials);
  const snapshot = await bridge.next((message) => message.type === "session.snapshot");
  assert.equal(snapshot.snapshot.sessions.some((session) => session.id === "session-snapshot"), true);

  const trustCommand = {
    type: "trust.policy.update",
    projectId: "project-snapshot",
    preset: "safe_automation",
    idempotencyKey: "rust-safe-automation",
  };
  bridge.send(trustCommand);
  const trustPolicy = await bridge.next((message) => message.type === "trust.policy.updated");
  assert.equal(trustPolicy.policy.preset, "safe_automation");
  bridge.send({ ...trustCommand, preset: "ask" });
  const trustReplay = await bridge.next((message) => message.type === "trust.policy.updated");
  assert.equal(trustReplay.policy.preset, "safe_automation");
  assert.equal(trustReplay.policy.updatedAt, trustPolicy.policy.updatedAt);

  const agentProfileCommand = {
    type: "agent.profile.update",
    projectId: "project-snapshot",
    displayName: "Rust Native Agent",
    avatar: "agent-01",
    bio: "Managed by Rust",
    defaultProvider: "codex",
    idempotencyKey: "rust-agent-profile",
  };
  bridge.send(agentProfileCommand);
  const agentProfile = await bridge.next((message) => message.type === "project.updated"
    && message.project.id === "project-snapshot");
  assert.equal(agentProfile.project.agentProfile.displayName, "Rust Native Agent");
  assert.equal(agentProfile.project.agentProfile.defaultProvider, "codex");
  bridge.send({ ...agentProfileCommand, displayName: "Should Not Replace" });
  const agentProfileReplay = await bridge.next((message) => message.type === "project.updated"
    && message.project.id === "project-snapshot");
  assert.equal(agentProfileReplay.project.agentProfile.displayName, "Rust Native Agent");
  assert.equal(agentProfileReplay.project.agentProfile.updatedAt, agentProfile.project.agentProfile.updatedAt);

  bridge.send({
    type: "task.pin",
    sessionId: "session-snapshot",
    pinned: false,
    idempotencyKey: "rust-write-smoke-pin",
  });
  const first = await bridge.next((message) => message.type === "task.preference.updated");
  assert.equal(first.preference.pinnedAt, null);

  bridge.send({
    type: "task.pin",
    sessionId: "session-snapshot",
    pinned: true,
    idempotencyKey: "rust-write-smoke-pin",
  });
  const replay = await bridge.next((message) => message.type === "task.preference.updated");
  assert.equal(replay.preference.pinnedAt, null);

  bridge.send({
    type: "task.command.cancel",
    commandId: "command-snapshot",
  });
  const canceled = await bridge.next(
    (message) => message.type === "task.command.updated" && message.command.id === "command-snapshot",
  );
  assert.equal(canceled.command.state, "canceled");
  const cancelReceipt = await bridge.next((message) => message.type === "task.command.cancel.result");
  assert.equal(cancelReceipt.commandId, "command-snapshot");
  assert.equal(cancelReceipt.ok, true);

  const materialKey = randomBytes(32);
  const nonce = randomBytes(12);
  const imported = await webcrypto.subtle.importKey("raw", materialKey, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    imported,
    materialBytes,
  ));
  const encryptedMaterial = new Uint8Array(nonce.length + ciphertext.length);
  encryptedMaterial.set(nonce);
  encryptedMaterial.set(ciphertext, nonce.length);
  const uploadTimestamp = new Date().toISOString();
  const upload = await fetch(`${baseUrl}/api/materials/${materialId}/blob`, {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "x-zimlo-device-id": credentials.deviceId,
      "x-zimlo-timestamp": uploadTimestamp,
      "x-zimlo-proof": makeProof(
        credentials.deviceKey,
        `material-upload:${materialId}:${uploadTimestamp}:${encryptedMaterial.byteLength}`,
      ),
    },
    body: encryptedMaterial,
  });
  assert.equal(upload.status, 201);
  const materialCommand = {
    type: "material.register",
    material: {
      id: materialId,
      kind: "image",
      name: "node-cross-implementation.png",
      mimeType: "image/png",
      sizeBytes: materialBytes.byteLength,
      sha256: createHash("sha256").update(materialBytes).digest("hex"),
      origin: "user",
      createdAt: new Date().toISOString(),
    },
    transport: "local",
    encryptionKey: toBase64Url(materialKey),
    idempotencyKey: "rust-write-smoke-material",
  };
  bridge.send(materialCommand);
  const material = await bridge.next((message) => message.type === "material.updated");
  assert.equal(material.material.status, "ready");
  bridge.send(materialCommand);
  const materialReplay = await bridge.next((message) => message.type === "material.updated");
  assert.equal(materialReplay.material.status, "ready");
  const downloadTimestamp = new Date().toISOString();
  const download = await fetch(`${baseUrl}/api/materials/${materialId}/content`, {
    headers: {
      "x-zimlo-device-id": credentials.deviceId,
      "x-zimlo-timestamp": downloadTimestamp,
      "x-zimlo-proof": makeProof(
        credentials.deviceKey,
        `material-download:${materialId}:${downloadTimestamp}`,
      ),
    },
  });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), materialBytes);

  bridge.send({
    type: "task.create",
    provider: "claude",
    workspaceId: "project-snapshot",
    text: "Rust Claude smoke create",
    idempotencyKey: "rust-claude-create",
  });
  const queuedClaude = await bridge.next(
    (message) => message.type === "task.command.updated" && message.command.text === "Rust Claude smoke create",
  );
  assert.equal(queuedClaude.command.state, "queued");
  const completedClaude = await bridge.next((message) => message.type === "session.snapshot"
    && message.snapshot.commands.some((command) => command.text === "Rust Claude smoke create" && command.state === "completed"));
  const createdCommand = completedClaude.snapshot.commands.find((command) => command.text === "Rust Claude smoke create");
  const createdSession = completedClaude.snapshot.sessions.find((session) => session.id === createdCommand.sessionId);
  assert.equal(createdSession.providerSessionId, "claude-rust-smoke");
  assert.equal(createdSession.status, "idle");

  bridge.send({
    type: "session.message",
    sessionId: createdSession.id,
    text: "Rust Claude smoke follow-up",
    idempotencyKey: "rust-claude-follow-up",
  });
  const queuedFollowUp = await bridge.next(
    (message) => message.type === "task.command.updated" && message.command.text === "Rust Claude smoke follow-up",
  );
  assert.equal(queuedFollowUp.command.state, "queued");
  const followUpReceipt = await bridge.next((message) => message.type === "session.message.result"
    && message.sessionId === createdSession.id);
  assert.equal(followUpReceipt.ok, true);
  await bridge.next((message) => message.type === "session.snapshot"
    && message.snapshot.commands.some((command) => command.text === "Rust Claude smoke follow-up" && command.state === "completed"));

  bridge.send({
    type: "task.create",
    provider: "codex",
    workspaceId: "project-snapshot",
    text: "Rust Codex smoke create",
    idempotencyKey: "rust-codex-create",
  });
  const queuedCodex = await bridge.next(
    (message) => message.type === "task.command.updated" && message.command.text === "Rust Codex smoke create",
  );
  assert.equal(queuedCodex.command.state, "queued");
  const approvalSnapshot = await bridge.next((message) => message.type === "session.snapshot"
    && message.snapshot.actions.some((action) => action.kind === "approval" && action.state === "pending"
      && action.sessionId !== "session-snapshot"));
  const approval = approvalSnapshot.snapshot.actions.find((action) => action.kind === "approval" && action.state === "pending"
    && action.sessionId !== "session-snapshot");
  bridge.send({
    type: "action.decide",
    actionId: approval.actionId,
    sessionId: approval.sessionId,
    decisionId: "upstream-0-accept",
    confirmationPhrase: "确认执行",
    idempotencyKey: "rust-codex-approval",
  });
  const approvalResult = await bridge.next((message) => message.type === "action.result"
    && message.actionId === approval.actionId);
  assert.equal(approvalResult.ok, true);
  const inputSnapshot = await bridge.next((message) => message.type === "session.snapshot"
    && message.snapshot.actions.some((action) => action.kind === "input" && action.state === "pending"));
  const input = inputSnapshot.snapshot.actions.find((action) => action.kind === "input" && action.state === "pending");
  bridge.send({
    type: "action.decide",
    actionId: input.actionId,
    sessionId: input.sessionId,
    decisionId: "submit-input",
    input: { answer: "rust-phone-answer" },
    idempotencyKey: "rust-codex-input",
  });
  const inputResult = await bridge.next((message) => message.type === "action.result"
    && message.actionId === input.actionId);
  assert.equal(inputResult.ok, true);
  const completedCodex = await bridge.next((message) => message.type === "session.snapshot"
    && message.snapshot.commands.some((command) => command.text === "Rust Codex smoke create" && command.state === "completed"));
  const codexCommand = completedCodex.snapshot.commands.find((command) => command.text === "Rust Codex smoke create");
  const codexSession = completedCodex.snapshot.sessions.find((session) => session.id === codexCommand.sessionId);
  assert.equal(codexSession.providerSessionId, "codex-rust-smoke");
  assert.equal(codexSession.status, "idle");

  bridge.send({ type: "snapshot.request", afterSequence: 0 });
  const persisted = await bridge.next((message) => message.type === "session.snapshot");
  const preference = persisted.snapshot.taskPreferences.find((item) => item.sessionId === "session-snapshot");
  assert.equal(preference.pinnedAt, null);
}

function verifyNodeReopen() {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const preference = database.prepare("SELECT pinned_at FROM task_preferences WHERE session_id = ?").get("session-snapshot");
  const command = database.prepare("SELECT state, error FROM task_commands WHERE id = ?").get("command-snapshot");
  const action = database.prepare("SELECT state FROM actions WHERE action_id = ?").get("action-snapshot");
  const paired = database.prepare("SELECT COUNT(*) AS count FROM devices WHERE name = ?").get("Node Cross-Implementation Smoke");
  const material = database.prepare("SELECT status, local_path FROM materials WHERE id = ?").get(materialId);
  const claudeCommands = database.prepare(
    "SELECT state, session_id FROM task_commands WHERE text IN ('Rust Claude smoke create', 'Rust Claude smoke follow-up') ORDER BY created_at",
  ).all();
  const claudeSession = database.prepare(
    "SELECT status, active_pid FROM sessions WHERE provider_session_id = 'claude-rust-smoke'",
  ).get();
  const claudeEvents = database.prepare(
    "SELECT COUNT(*) AS count FROM events WHERE provider_session_id = 'claude-rust-smoke'",
  ).get();
  const codexCommand = database.prepare(
    "SELECT state, session_id FROM task_commands WHERE text = 'Rust Codex smoke create'",
  ).get();
  const codexSession = database.prepare(
    "SELECT status, active_pid FROM sessions WHERE provider_session_id = 'codex-rust-smoke'",
  ).get();
  const codexActions = database.prepare(
    "SELECT kind, state FROM actions WHERE session_id = ? ORDER BY created_at",
  ).all(codexCommand.session_id);
  const trustPolicy = database.prepare(
    "SELECT preset, auto_allow_json FROM project_trust_policies WHERE project_id = 'project-snapshot'",
  ).get();
  const trustAudit = database.prepare(
    "SELECT decision FROM trust_audit WHERE session_id = ? ORDER BY created_at",
  ).all(codexCommand.session_id);
  const agentProfile = database.prepare(
    "SELECT agent_display_name, agent_avatar, agent_bio, agent_default_provider FROM projects WHERE id = 'project-snapshot'",
  ).get();
  const codexEvents = database.prepare(
    "SELECT COUNT(*) AS count FROM events WHERE provider_session_id = 'codex-rust-smoke'",
  ).get();
  database.close();
  assert.equal(preference.pinned_at, null);
  assert.equal(command.state, "canceled");
  assert.equal(command.error, null);
  assert.equal(action.state, "expired");
  assert.equal(paired.count, 1);
  assert.equal(material.status, "ready");
  assert.deepEqual(readFileSync(material.local_path), materialBytes);
  assert.deepEqual(claudeCommands.map((command) => command.state), ["completed", "completed"]);
  assert.equal(claudeCommands[0].session_id, claudeCommands[1].session_id);
  assert.equal(claudeSession.status, "idle");
  assert.equal(claudeSession.active_pid, null);
  assert.equal(claudeEvents.count >= 4, true);
  assert.equal(codexCommand.state, "completed");
  assert.equal(codexSession.status, "idle");
  assert.equal(codexSession.active_pid, null);
  assert.deepEqual(codexActions.map((action) => action.state), ["resolved", "resolved", "resolved"]);
  assert.equal(trustPolicy.preset, "safe_automation");
  assert.deepEqual(JSON.parse(trustPolicy.auto_allow_json), ["read", "search", "test", "build"]);
  assert.equal(trustAudit.some((entry) => entry.decision === "auto_allowed"), true);
  assert.equal(trustAudit.some((entry) => entry.decision === "asked"), true);
  assert.deepEqual({ ...agentProfile }, {
    agent_display_name: "Rust Native Agent",
    agent_avatar: "agent-01",
    agent_bio: "Managed by Rust",
    agent_default_provider: "codex",
  });
  assert.equal(codexEvents.count >= 6, true);
}

try {
  prepareFakeClaude();
  prepareFakeCodex();
  prepareNodeDatabase();
  const baseUrl = await startRuntime();
  const credentials = await pair(baseUrl);
  await verifyWriteFlow(baseUrl, credentials);
  socket.close();
  const runtimeExited = new Promise((resolveExit) => runtime.once("exit", resolveExit));
  runtime.kill("SIGTERM");
  await runtimeExited;
  verifyNodeReopen();
  console.log(JSON.stringify({
    nodeFixture: true,
    rustExclusiveWrite: true,
    pairingCrypto: true,
    idempotentReplay: true,
    nodeToRustMaterialCrypto: true,
    persistentTaskCancellation: true,
    claudeManagedExecution: true,
    codexManagedExecution: true,
    safeAutomation: true,
    agentProfileManagement: true,
    approvalRoundTrip: true,
    restartRecovery: true,
    nodeReopen: true,
  }));
} finally {
  socket?.close();
  if (runtime?.exitCode === null) runtime.kill("SIGKILL");
  rmSync(temporaryRoot, { recursive: true, force: true });
}
