"use client";

import { useEffect, useState } from "react";

const RELEASE_MANIFEST_URL = "https://zimlo-cloud.zimlo.workers.dev/releases/macos/latest.json";
const RELEASE_BASE_URL = "https://zimlo-cloud.zimlo.workers.dev/releases/macos/";

interface MacRelease {
  version: string;
  fileName: string;
  downloadURL: string;
  minimumSystemVersion: string;
}

function isMacRelease(value: unknown): value is MacRelease {
  if (!value || typeof value !== "object") return false;
  const release = value as Partial<MacRelease>;
  return (
    typeof release.version === "string"
    && /^\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/u.test(release.version)
    && typeof release.fileName === "string"
    && /^Zimlo-[0-9A-Za-z.-]+\.dmg$/u.test(release.fileName)
    && typeof release.downloadURL === "string"
    && release.downloadURL.startsWith(RELEASE_BASE_URL)
    && typeof release.minimumSystemVersion === "string"
  );
}

export function BetaDownload() {
  const [release, setRelease] = useState<MacRelease | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(RELEASE_MANIFEST_URL, { cache: "no-store", signal: controller.signal })
      .then(async (response) => response.ok ? response.json() as Promise<unknown> : null)
      .then((value) => {
        if (isMacRelease(value)) setRelease(value);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  return (
    <>
      <div className="beta-actions">
        {release ? (
          <a className="button button--primary" href={release.downloadURL}>
            Download for Mac <span aria-hidden="true">↓</span>
          </a>
        ) : (
          <span className="button button--primary button--disabled" aria-disabled="true">
            Beta opening soon
          </span>
        )}
        <a className="button button--dark" href="#top">Back to top ↑</a>
      </div>
      <p className="beta-release-note">
        {release
          ? `Zimlo ${release.version} · Universal app · macOS ${release.minimumSystemVersion}+`
          : "Signed Mac download and iPhone TestFlight access will appear here when the Beta opens."}
      </p>
    </>
  );
}
