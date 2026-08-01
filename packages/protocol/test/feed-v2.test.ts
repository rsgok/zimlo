import { describe, expect, it } from "vitest";
import { FeedPostInputSchema } from "../src/index.js";

const base = {
  task_id: "task-a",
  kind: "result",
  template: "paper",
  headline: "普通任务不再被打断",
  takeaway: "没有重要信息的轮次现在会静默结束。",
  highlights: ["关键状态提醒仍然保留"],
  proof: "Stop 回归测试通过",
  dedupe_key: "task-a:result",
};

describe("Feed V3 protocol", () => {
  it("accepts structured reading cards and all supported templates", () => {
    for (const template of ["paper", "grid", "sticky", "marker", "poster"]) {
      expect(FeedPostInputSchema.safeParse({ ...base, template }).success).toBe(true);
    }
  });

  it("rejects the removed card action contract", () => {
    expect(FeedPostInputSchema.safeParse({ ...base, action_required: true }).success).toBe(false);
    expect(FeedPostInputSchema.safeParse({ ...base, action_prompt: "请确认。" }).success).toBe(false);
    expect(FeedPostInputSchema.safeParse({ ...base, actions: ["reply"] }).success).toBe(false);
  });

  it("rejects legacy free-form posts", () => {
    expect(FeedPostInputSchema.safeParse({
      task_id: "task-a",
      kind: "result",
      title: "旧标题",
      body: "旧正文",
      dedupe_key: "legacy",
    }).success).toBe(false);
  });
});
