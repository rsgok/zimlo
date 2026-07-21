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
  action_required: false,
  actions: ["open_diff"],
  dedupe_key: "task-a:result",
};

describe("Feed V2 protocol", () => {
  it("accepts structured reading cards and all supported templates", () => {
    for (const template of ["paper", "grid", "sticky", "marker", "poster"]) {
      expect(FeedPostInputSchema.safeParse({ ...base, template }).success).toBe(true);
    }
  });

  it("requires a prompt and actionable affordance only when action is required", () => {
    expect(FeedPostInputSchema.safeParse({ ...base, action_required: true, actions: ["reply"] }).success).toBe(false);
    expect(FeedPostInputSchema.safeParse({ ...base, action_required: true, action_prompt: "请确认。", actions: ["open_diff"] }).success).toBe(false);
    expect(FeedPostInputSchema.safeParse({ ...base, action_required: true, action_prompt: "请确认。", actions: ["reply"] }).success).toBe(true);
    expect(FeedPostInputSchema.safeParse({ ...base, action_prompt: "不应出现" }).success).toBe(false);
  });

  it("rejects legacy free-form posts", () => {
    expect(FeedPostInputSchema.safeParse({
      task_id: "task-a",
      kind: "result",
      title: "旧标题",
      body: "旧正文",
      action_required: false,
      actions: [],
      dedupe_key: "legacy",
    }).success).toBe(false);
  });
});
