import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { pendingOperationNotice, SystemNotices } from "./SystemNotices";

describe("SystemNotices", () => {
  it("describes queued operations without implying user approval", () => {
    expect(pendingOperationNotice(true, 1)).toBe("正在发送 1 个操作…");
    expect(pendingOperationNotice(false, 2)).toBe("2 个操作已保存在本机，联网后自动发送");
  });

  it("renders sync and error states with one shared notice structure", () => {
    const markup = renderToStaticMarkup(
      <SystemNotices online pendingCount={1} error="设备身份已失效或被撤销，请重新配对。" />,
    );

    expect(markup.match(/class="system-notice /g)).toHaveLength(2);
    expect(markup).toContain("system-notice-sync");
    expect(markup).toContain("system-notice-error");
    expect(markup).not.toContain("待确认");
  });
});
