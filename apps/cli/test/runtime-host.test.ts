import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeHub } from "../src/runtime.js";
import { ZimloStore } from "../src/store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime Host identity", () => {
  it("persists one stable identity per Mac data directory and tags the snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "zimlo-host-"));
    roots.push(root);
    const path = join(root, "zimlo.db");
    const firstStore = new ZimloStore(path);
    const first = new RuntimeHub(firstStore);
    expect(first.host.id).toMatch(/^host_/u);
    expect(first.snapshot().host?.id).toBe(first.host.id);
    expect(first.snapshot().features.multiHost).toBe(true);
    firstStore.close();

    const reopenedStore = new ZimloStore(path);
    const reopened = new RuntimeHub(reopenedStore);
    expect(reopened.host.id).toBe(first.host.id);
    reopenedStore.close();
  });

  it("gives isolated Mac data directories different identities", () => {
    const stores = [0, 1].map(() => {
      const root = mkdtempSync(join(tmpdir(), "zimlo-host-"));
      roots.push(root);
      return new ZimloStore(join(root, "zimlo.db"));
    });
    const ids = stores.map((store) => new RuntimeHub(store).host.id);
    expect(new Set(ids).size).toBe(2);
    stores.forEach((store) => store.close());
  });
});
