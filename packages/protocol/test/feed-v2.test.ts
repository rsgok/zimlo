import { describe, expect, it } from "vitest";
import { CARD_CATALOG, FeedPostInputSchema, resolveCardPresentation } from "../src/index.js";

const base = {
  task_id: "task-a",
  kind: "result",
  presentation: { system: "auto", theme: "auto", layout: "auto", typography: "auto", density: "auto", mediaPlacement: "auto" },
  headline: "普通任务不再被打断",
  takeaway: "没有重要信息的轮次现在会静默结束。",
  highlights: ["关键状态提醒仍然保留"],
  proof: "Stop 回归测试通过",
  dedupe_key: "task-a:result",
};

describe("Feed v5 protocol", () => {
  it("accepts the generated card catalog and resolves auto choices", () => {
    expect(CARD_CATALOG.systems.map((system) => system.id)).toEqual(["editorial", "swiss"]);
    expect(CARD_CATALOG.themes).toHaveLength(10);
    expect(CARD_CATALOG.layouts).toHaveLength(12);
    expect(FeedPostInputSchema.safeParse(base).success).toBe(true);
    expect(resolveCardPresentation({ ...base, blocks: [], content: { type: "text" } })).toEqual({
      system: "editorial",
      theme: "ink_classic",
      layout: "field_note",
      typography: "serif",
      density: "airy",
      mediaPlacement: "none",
    });
  });

  it("validates layout semantics and cross-system selections", () => {
    expect(FeedPostInputSchema.safeParse({
      ...base,
      presentation: { ...base.presentation, system: "swiss", theme: "ikb", layout: "metric_grid" },
      blocks: [{ type: "metric", label: "通过", value: "87", unit: "tests" }],
    }).success).toBe(true);
    expect(FeedPostInputSchema.safeParse({
      ...base,
      presentation: { ...base.presentation, system: "editorial", theme: "ikb", layout: "feature" },
    }).success).toBe(false);
    expect(FeedPostInputSchema.safeParse({
      ...base,
      presentation: { ...base.presentation, system: "swiss", theme: "ikb", layout: "metric_grid" },
      blocks: [],
    }).success).toBe(false);
    expect(resolveCardPresentation({
      ...base,
      presentation: { ...base.presentation, theme: "ikb" },
      blocks: [],
      content: { type: "text" },
    }).system).toBe("swiss");
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
