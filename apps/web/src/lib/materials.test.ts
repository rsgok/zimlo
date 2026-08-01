import { describe, expect, it } from "vitest";
import { materialKind, validateFile } from "./materials";

describe("browser material policy", () => {
  it("recognizes supported files when the platform only reports a generic MIME type", () => {
    expect(materialKind(new File(["PK"], "brief.docx", { type: "application/octet-stream" }))).toBe("document");
    expect(materialKind(new File(["image"], "photo.heic", { type: "" }))).toBe("image");
    expect(materialKind(new File(["binary"], "installer.dmg", { type: "application/octet-stream" }))).toBeNull();
  });

  it("rejects empty files before encryption or upload", () => {
    expect(validateFile(new File([], "empty.pdf", { type: "application/pdf" }))).toEqual({ error: "文件内容为空" });
  });
});
