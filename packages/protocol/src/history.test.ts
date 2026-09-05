import { describe, expect, it } from "vitest";
import { ClientCommandSchema } from "./index.js";
describe("history wire contract", () => {
  it("accepts bounded read requests and rejects invalid filters", () => {
    expect(ClientCommandSchema.parse({ type: "history.search", requestId: "one", hostId: "host" })).toMatchObject({ kind: "all", query: "", limit: 30, hostId: "host" });
    for (const values of [{ limit: 101 }, { cursor: "x".repeat(2049) }, { kind: "raw_events" }, { query: "x".repeat(201) }]) {
      expect(ClientCommandSchema.safeParse({ type: "history.search", requestId: "one", ...values }).success).toBe(false);
    }
  });
});
