import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const script = readFileSync(new URL("./publish-release.sh", import.meta.url), "utf8");

describe("macOS release publisher", () => {
  it("publishes separate app updates for both Mac architectures", () => {
    expect(script).toContain('architectures=(arm64 x86_64)');
    expect(script).toContain('Zimlo-${version}-${architecture}.dmg');
    expect(script).toContain('appcast-${architecture}.xml');
    expect(script).toContain('legacy_appcast_path="${release_dir}/appcast.xml"');
    expect(script).toContain('schemaVersion: 2');
    expect(script).toContain('x86_64: artifact(intelName)');
    expect(script).not.toContain("object put --local");
  });

  it("finds Sparkle tools produced by architecture-isolated release builds", () => {
    expect(script).toContain("SPARKLE_TOOLS_DIR");
    expect(script).toContain(".build/swift-arm64/artifacts/sparkle/Sparkle/bin");
    expect(script).toContain(".build/swift-x86_64/artifacts/sparkle/Sparkle/bin");
  });

  it("publishes both Runtime architectures before the app update becomes visible", () => {
    const runtimeArchiveUpload = script.indexOf('"${bucket}/macos/${runtime_file}"');
    const runtimeManifestUpload = script.indexOf('"${bucket}/macos/runtime-latest.json"');
    const diskImageUpload = script.indexOf('"${bucket}/macos/${dmg_path:t}"');
    const appcastUpload = script.indexOf('"${bucket}/macos/${appcast_path:t}"');
    const legacyAppcastUpload = script.indexOf('"${bucket}/macos/appcast.xml"');
    const manifestUpload = script.indexOf('"${bucket}/macos/latest.json"');

    expect(runtimeArchiveUpload).toBeGreaterThan(-1);
    expect(runtimeManifestUpload).toBeGreaterThan(runtimeArchiveUpload);
    expect(diskImageUpload).toBeGreaterThan(runtimeManifestUpload);
    expect(appcastUpload).toBeGreaterThan(diskImageUpload);
    expect(legacyAppcastUpload).toBeGreaterThan(appcastUpload);
    expect(manifestUpload).toBeGreaterThan(legacyAppcastUpload);
    expect(script.indexOf('"${public_base_url}/appcast-${architecture}.xml?verify=${version}"')).toBeGreaterThan(manifestUpload);
    expect(script.indexOf('"${public_base_url}/latest.json?verify=${version}"')).toBeGreaterThan(manifestUpload);
  });
});
