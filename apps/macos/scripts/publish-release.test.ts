import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const script = readFileSync(new URL("./publish-release.sh", import.meta.url), "utf8");

describe("macOS release publisher", () => {
  it("uploads the app and architecture-specific Runtime artifacts to the remote R2 bucket", () => {
    const uploads = script.match(/wrangler r2 object put[^\n]* \\\n(?:.*\n){3}/gu) ?? [];

    expect(uploads).toHaveLength(5);
    for (const upload of uploads) {
      expect(upload).toContain("object put --remote");
      expect(upload).not.toContain("--local");
    }
  });

  it("publishes both Runtime architectures before the app update becomes visible", () => {
    const runtimeArchiveUpload = script.indexOf('"${bucket}/macos/${runtime_file}"');
    const runtimeManifestUpload = script.indexOf('"${bucket}/macos/runtime-latest.json"');
    const diskImageUpload = script.indexOf('"${bucket}/macos/${dmg_path:t}"');
    const appcastUpload = script.indexOf('"${bucket}/macos/appcast.xml"');
    const manifestUpload = script.indexOf('"${bucket}/macos/latest.json"');

    expect(runtimeArchiveUpload).toBeGreaterThan(-1);
    expect(runtimeManifestUpload).toBeGreaterThan(runtimeArchiveUpload);
    expect(diskImageUpload).toBeGreaterThan(runtimeManifestUpload);
    expect(appcastUpload).toBeGreaterThan(diskImageUpload);
    expect(manifestUpload).toBeGreaterThan(appcastUpload);
    expect(script.indexOf('"${public_base_url}/appcast.xml?verify=${version}"')).toBeGreaterThan(manifestUpload);
    expect(script.indexOf('"${public_base_url}/latest.json?verify=${version}"')).toBeGreaterThan(manifestUpload);
  });
});
