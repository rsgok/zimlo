import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const path = resolve(root, process.argv[3] ?? "dist/verified-source.json");
const contract = JSON.parse(readFileSync(resolve(root, "config/zimlo-contract.json"), "utf8"));
const sourceRevision = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain", "--untracked-files=normal");
if (dirty) throw new Error("Release provenance requires a clean source checkout. Commit the reviewed changes before a release build.");
if (process.argv[2] === "record") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, sourceRevision, sourceTree: git("rev-parse", "HEAD^{tree}"),
    appVersion: process.env.ZIMLO_VERSION, appBuild: process.env.ZIMLO_BUILD_NUMBER,
    productVersion: contract.productVersion, protocolVersion: contract.protocolVersion,
    verifiedAt: new Date().toISOString(), capabilities: ["snapshot.delta", "history.search", "persistent-outbox", "local-service-identity"] }, null, 2) + "\n");
} else if (process.argv[2] === "check") {
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  if (receipt.sourceRevision !== sourceRevision || receipt.sourceTree !== git("rev-parse", "HEAD^{tree}") || receipt.protocolVersion !== contract.protocolVersion
      || (process.env.ZIMLO_VERSION && receipt.appVersion !== process.env.ZIMLO_VERSION)
      || (process.env.ZIMLO_BUILD_NUMBER && receipt.appBuild !== process.env.ZIMLO_BUILD_NUMBER)) throw new Error("Release source, protocol or app build changed after verification.");
} else throw new Error("Usage: release-provenance.mjs record|check [receipt-path]");
console.log(`Verified source ${sourceRevision.slice(0, 12)} · protocol ${contract.protocolVersion}`);
