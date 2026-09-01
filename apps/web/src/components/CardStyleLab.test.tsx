import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CardStyleLab } from "./CardStyleLab";

describe("CardStyleLab", () => {
  it("renders both original Zimlo visual systems from the same mock story", () => {
    const markup = renderToStaticMarkup(<CardStyleLab />);

    expect(markup).toContain("Zimlo Editorial");
    expect(markup).toContain("Zimlo Swiss");
    expect(markup.match(/通知链路现在会自己恢复/g)).toHaveLength(2);
    expect(markup.match(/打开任务/g)).toHaveLength(4);
    expect(markup).toContain("/card-lab/editorial-workspace.jpg");
    expect(markup).toContain("/card-lab/swiss-connection.jpg");
    expect(markup).toContain("带图版本");
  });
});
