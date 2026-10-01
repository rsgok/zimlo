import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeProof } from "../packages/protocol/dist/crypto.js";

export async function verifyArtifactDelivery({ repositoryRoot, temporaryRoot, workspacePath, baseUrl, credentials, bridge }) {
  const descriptor = JSON.parse(readFileSync(join(temporaryRoot, "run/service.json"), "utf8"));
  const invoke = (name, args) => new Promise((resolve, reject) => {
    const client = createConnection(descriptor.socketPath);
    let buffer = "";
    client.setTimeout(5000, () => client.destroy(new Error("Agent tool timed out")));
    client.on("error", reject);
    client.on("connect", () => client.write(JSON.stringify({ type: "agent_tool", id: randomUUID(), provider: "codex", parentPid: 0, cwd: workspacePath, name, arguments: args }) + "\n"));
    client.on("data", (data) => {
      buffer += data;
      if (buffer.includes("\n")) { client.destroy(); resolve(JSON.parse(buffer.split("\n")[0])); }
    });
  });
  const sources = ["examples/fieldwork-campaign.png", "zimlo-feed-mobile-en.png", "zimlo-feed-desktop-en.png"];
  const receipts = [];
  for (const [index, source] of sources.entries()) {
    const path = join(workspacePath, `output-${index + 1}.png`);
    copyFileSync(join(repositoryRoot, "landing-page/public", source), path);
    const result = await invoke("material.publish", { path, name: ["户外活动主视觉.png", "手机页面预览.png", "桌面页面预览.png"][index] });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.data.status, "ready");
    assert.equal(result.data.sha256, createHash("sha256").update(readFileSync(path)).digest("hex"));
    receipts.push(result.data);
  }
  assert.equal(new Set(receipts.map((item) => item.material_id)).size, 3);
  assert.equal(new Set(receipts.map((item) => item.sha256)).size, 3);
  const ids = receipts.map((item) => item.material_id);
  const post = {
    task_id: "task-snapshot", kind: "result", headline: "把山野的开阔感，带进主视觉", takeaway: "以山脉、湖泊和橙色帐篷构成画面。另附两张页面预览，可左右滑动查看。", highlights: [],
    presentation: { system: "editorial", theme: "forest_ink", layout: "media_quiet_zone", typography: "sans", density: "compact", mediaPlacement: "hero" },
    content: { type: "image_album", materialIds: ids }, dedupe_key: "artifact-gallery-real-files",
  };
  const missing = await invoke("feed.post", { ...post, content: { type: "image_album", materialIds: [...ids, "material_not_published"] } });
  assert.equal(missing.ok, false);
  const duplicate = await invoke("feed.post", { ...post, content: { type: "image_album", materialIds: [ids[0], ids[0]] } });
  assert.equal(duplicate.ok, false);
  const published = await invoke("feed.post", post);
  assert.equal(published.ok, true, published.message);
  const replay = await invoke("feed.post", post);
  assert.equal(replay.data.deduplicated, true);
  bridge.send({ type: "snapshot.request" });
  const envelope = await bridge.next((message) => message.type === "session.snapshot" && message.snapshot.posts.some((item) => item.dedupeKey === post.dedupe_key));
  const actual = envelope.snapshot.posts.find((item) => item.dedupeKey === post.dedupe_key);
  assert.deepEqual(actual.content.materialIds, ids);
  const output = process.env.ZIMLO_ARTIFACT_REVIEW_DIR;
  if (output) mkdirSync(output, { recursive: true });
  const urls = {};
  for (const id of ids) {
    const timestamp = new Date().toISOString();
    const response = await fetch(`${baseUrl}/api/materials/${id}/content`, { headers: {
      "x-zimlo-device-id": credentials.deviceId, "x-zimlo-timestamp": timestamp,
      "x-zimlo-proof": makeProof(credentials.deviceKey, `material-download:${id}:${timestamp}`),
    } });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    const material = envelope.snapshot.materials.find((item) => item.id === id);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), material.sha256);
    if (output) { urls[id] = join(output, `${id}.png`); writeFileSync(urls[id], bytes); }
  }
  if (output) writeFileSync(join(output, "receipt.json"), JSON.stringify({ host: envelope.snapshot.host, post: { ...actual, hostId: envelope.snapshot.host.id }, materials: envelope.snapshot.materials.filter((item) => ids.includes(item.id)).map((item) => ({ ...item, hostId: envelope.snapshot.host.id })), urls }, null, 2));
}
