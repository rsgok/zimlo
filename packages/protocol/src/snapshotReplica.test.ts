import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SnapshotReplica } from "./snapshotReplica.js";

const vectors = JSON.parse(readFileSync(new URL("../test-vectors/snapshot-delta.json", import.meta.url), "utf8"));
describe("shared snapshot delta vectors", () => {
  for (const vector of vectors) it(vector.name, () => {
    const replica = new SnapshotReplica("mac");
    expect(replica.receive(vector.full)?.negotiateDelta).toBe(true);
    const result = replica.receive(vector.patch);
    if (vector.expected === null) expect(result).toBeNull();
    else expect(result?.message.snapshot).toEqual(vector.expected);
  });
  it("keeps the valid baseline after a rejected patch", () => {
    const replica = new SnapshotReplica("mac");
    replica.receive(vectors[0].full);
    expect(replica.receive(vectors[1].patch)).toBeNull();
    expect(replica.receive(vectors[0].patch)?.message.snapshot).toEqual(vectors[0].expected);
  });
});
