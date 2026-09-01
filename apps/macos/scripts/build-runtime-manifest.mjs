#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const [outputPath, baseURL, runtimeVersion, protocolVersionValue, arm64Path, x86Path] = process.argv.slice(2);
if (!outputPath || !baseURL || !runtimeVersion || !protocolVersionValue || !arm64Path || !x86Path) {
  throw new Error("usage: build-runtime-manifest.mjs OUTPUT BASE_URL VERSION PROTOCOL ARM64_ZIP X86_64_ZIP");
}
const protocolVersion = Number(protocolVersionValue);
if (!Number.isSafeInteger(protocolVersion) || protocolVersion < 1) {
  throw new Error("protocol version must be a positive integer");
}
if (!/^[0-9A-Za-z._-]{1,96}$/u.test(runtimeVersion)) {
  throw new Error("runtime version contains unsupported characters");
}
const origin = new URL(baseURL);
if (origin.protocol !== "https:") throw new Error("runtime base URL must use HTTPS");

async function artifact(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const fileName = basename(path);
  return {
    downloadURL: new URL(encodeURIComponent(fileName), `${origin.toString().replace(/\/$/u, "")}/`).toString(),
    sha256: hash.digest("hex"),
    size: statSync(path).size,
  };
}

const payload = {
  schemaVersion: 1,
  runtimeVersion,
  protocolVersion,
  artifacts: {
    arm64: await artifact(arm64Path),
    x86_64: await artifact(x86Path),
  },
};
writeFileSync(outputPath, `${JSON.stringify(payload)}\n`, { mode: 0o644 });
