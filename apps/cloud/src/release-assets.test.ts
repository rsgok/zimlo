import { describe, expect, it } from "vitest";
import { releaseAssetHeaders, releaseAssetKey } from "./release-assets.js";

describe("macOS release assets", () => {
  it("maps only flat, safe release filenames into the bucket prefix", () => {
    expect(releaseAssetKey("/releases/macos/appcast.xml")).toBe("macos/appcast.xml");
    expect(releaseAssetKey("/releases/macos/Zimlo-0.3.0.dmg")).toBe("macos/Zimlo-0.3.0.dmg");
    expect(releaseAssetKey("/releases/macos/../secret")).toBeNull();
    expect(releaseAssetKey("/releases/macos/%2e%2e%2fsecret")).toBeNull();
    expect(releaseAssetKey("/releases/ios/appcast.xml")).toBeNull();
  });

  it("keeps appcasts fresh and immutable disk images cacheable", () => {
    expect(releaseAssetHeaders("appcast.xml")).toMatchObject({
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=300, must-revalidate",
    });
    expect(releaseAssetHeaders("Zimlo-0.3.0.dmg")).toMatchObject({
      "content-type": "application/x-apple-diskimage",
      "cache-control": "public, max-age=31536000, immutable",
    });
  });
});
