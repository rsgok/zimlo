import { describe, expect, it } from "vitest";
import { ZimloStore } from "../src/store.js";

describe("interaction v3 persistence", () => {
  it("has no TaskReview storage or review notification preference", () => {
    const store = new ZimloStore(":memory:");
    const tables = store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    const feedColumns = store.database.prepare("PRAGMA table_info(feed_posts)").all() as Array<{ name: string }>;
    const notificationColumns = store.database.prepare("PRAGMA table_info(notification_settings)").all() as Array<{ name: string }>;

    expect(tables.map((row) => row.name)).not.toContain("task_reviews");
    for (const name of ["action_required", "action_prompt", "actions_json", "pending_action_ids_json"]) {
      expect(feedColumns.map((row) => row.name)).not.toContain(name);
    }
    expect(notificationColumns.map((row) => row.name)).not.toContain("reviews");
    expect(store.getNotificationSettings("device-a")).toEqual(expect.objectContaining({
      enabled: false,
      approvals: true,
      failures: true,
      showTaskTitle: false,
    }));
    store.close();
  });
});
