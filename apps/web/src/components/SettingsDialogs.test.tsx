import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AvatarPickerDialog, PairingDialog } from "./SettingsDialogs";

describe("SettingsDialogs", () => {
  it("keeps avatar choices exposed as real buttons", () => {
    const markup = renderToStaticMarkup(
      <AvatarPickerDialog selectedAvatarId="user-01" onSelect={vi.fn()} onClose={vi.fn()} />,
    );

    expect(markup).toContain('role="group"');
    expect(markup.match(/<button/gu)).toHaveLength(25);
    expect(markup).not.toContain('role="listitem"');
  });

  it("offers a copy fallback next to the pairing QR code", () => {
    const markup = renderToStaticMarkup(
      <PairingDialog
        pairing={{ pairUrl: "zimlo://pair/example", qrDataUrl: "data:image/png;base64,example", expiresAt: "2026-08-01T12:00:00.000Z" }}
        onRefresh={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(markup).toContain("Zimlo 手机配对二维码");
    expect(markup).toContain("复制连接码");
    expect(markup).toContain("刷新二维码");
  });
});
