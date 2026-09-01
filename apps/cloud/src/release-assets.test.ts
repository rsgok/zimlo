import { describe, expect, it } from "vitest";
import { latestMacReleaseName, releaseAssetHeaders, releaseAssetKey } from "./release-assets.js";

describe("macOS release assets", () => {
  it("maps only flat, safe release filenames into the bucket prefix", () => {
    expect(releaseAssetKey("/releases/macos/appcast.xml")).toBe("macos/appcast.xml");
    expect(releaseAssetKey("/releases/macos/Zimlo-0.3.0.dmg")).toBe("macos/Zimlo-0.3.0.dmg");
    expect(releaseAssetKey("/releases/macos/runtime-latest.json")).toBe("macos/runtime-latest.json");
    expect(releaseAssetKey("/releases/macos/ZimloRuntime-0.3.0-1-arm64.zip"))
      .toBe("macos/ZimloRuntime-0.3.0-1-arm64.zip");
    expect(releaseAssetKey("/releases/macos/../secret")).toBeNull();
    expect(releaseAssetKey("/releases/macos/%2e%2e%2fsecret")).toBeNull();
    expect(releaseAssetKey("/releases/ios/appcast.xml")).toBeNull();
  });

  it("keeps appcasts fresh and immutable disk images cacheable", () => {
    expect(releaseAssetHeaders("latest.json")).toMatchObject({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300, must-revalidate",
      "access-control-allow-origin": "*",
    });
    expect(releaseAssetHeaders("runtime-latest.json")).toMatchObject({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300, must-revalidate",
      "access-control-allow-origin": "*",
    });
    expect(releaseAssetHeaders("appcast.xml")).toMatchObject({
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=300, must-revalidate",
    });
    expect(releaseAssetHeaders("Zimlo-0.3.0.dmg")).toMatchObject({
      "content-type": "application/x-apple-diskimage",
      "cache-control": "public, max-age=31536000, immutable",
    });
    expect(releaseAssetHeaders("ZimloRuntime-0.3.0-1-arm64.zip")).toMatchObject({
      "content-type": "application/zip",
      "cache-control": "public, max-age=31536000, immutable",
    });
  });

  it("accepts only a flat signed-release filename from the latest manifest", () => {
    expect(latestMacReleaseName({ fileName: "Zimlo-0.3.0.dmg" })).toBe("Zimlo-0.3.0.dmg");
    expect(latestMacReleaseName({ fileName: "../Zimlo-0.3.0.dmg" })).toBeNull();
    expect(latestMacReleaseName({ fileName: "Other-0.3.0.dmg" })).toBeNull();
    expect(latestMacReleaseName(null)).toBeNull();
  });
});
