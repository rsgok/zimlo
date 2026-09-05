import { expect, it } from "vitest";
import { withMaterialTransferSlot } from "./materialTransfer";
it("caps overlapping material work and releases slots after failure", async () => {
  let active = 0, peak = 0;
  const jobs = Array.from({ length: 12 }, (_, index) => withMaterialTransferSlot(async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    if (index === 2) throw new Error("decrypt failure");
    return index;
  }));
  const outcomes = await Promise.allSettled(jobs);
  expect(peak).toBe(3); expect(active).toBe(0);
  expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(11);
});
