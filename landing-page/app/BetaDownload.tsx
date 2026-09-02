"use client";

import { useCallback, useEffect, useState } from "react";

const RELEASE_MANIFEST_URL = "https://cloud.zimlo.app/releases/macos/latest.json";
const RELEASE_BASE_URL = "https://cloud.zimlo.app/releases/macos/";

interface MacReleaseArtifact {
  fileName: string;
  downloadURL: string;
}

interface MacRelease {
  schemaVersion: 2;
  version: string;
  minimumSystemVersion: string;
  artifacts: {
    arm64: MacReleaseArtifact;
    x86_64: MacReleaseArtifact;
  };
}

function isMacReleaseArtifact(value: unknown, architecture: "arm64" | "x86_64"): value is MacReleaseArtifact {
  if (!value || typeof value !== "object") return false;
  const artifact = value as Partial<MacReleaseArtifact>;
  return (
    typeof artifact.fileName === "string"
    && artifact.fileName.endsWith(`-${architecture}.dmg`)
    && /^Zimlo-[0-9A-Za-z._-]+\.dmg$/u.test(artifact.fileName)
    && typeof artifact.downloadURL === "string"
    && artifact.downloadURL.startsWith(RELEASE_BASE_URL)
  );
}

function isMacRelease(value: unknown): value is MacRelease {
  if (!value || typeof value !== "object") return false;
  const release = value as Partial<MacRelease>;
  return (
    release.schemaVersion === 2
    && typeof release.version === "string"
    && /^\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/u.test(release.version)
    && typeof release.minimumSystemVersion === "string"
    && isMacReleaseArtifact(release.artifacts?.arm64, "arm64")
    && isMacReleaseArtifact(release.artifacts?.x86_64, "x86_64")
  );
}

type ReleaseState =
  | { status: "loading" }
  | { status: "ready"; release: MacRelease }
  | { status: "closed" }   // manifest reachable, but no Beta published yet
  | { status: "error" };   // network/parse failure — offer a retry

export function BetaDownload() {
  const [state, setState] = useState<ReleaseState>({ status: "loading" });

  const load = useCallback((signal?: AbortSignal) => {
    return fetch(RELEASE_MANIFEST_URL, { cache: "no-store", signal })
      .then(async (response) => {
        if (!response.ok) return { status: "closed" } as const;
        const value: unknown = await response.json().catch(() => null);
        return isMacRelease(value)
          ? { status: "ready", release: value } as const
          : { status: "closed" } as const;
      })
      .then((next) => {
        if (!signal?.aborted) setState(next);
      })
      .catch(() => {
        if (!signal?.aborted) setState({ status: "error" });
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  function retry() {
    setState({ status: "loading" });
    void load();
  }

  return (
    <>
      <div className="beta-actions" aria-live="polite" aria-busy={state.status === "loading"}>
        {state.status === "loading" && (
          <span className="button button--primary button--disabled" aria-disabled="true">
            Checking for the Beta…
          </span>
        )}
        {state.status === "closed" && (
          <span className="button button--primary button--disabled" aria-disabled="true">
            Beta opening soon
          </span>
        )}
        {state.status === "error" && (
          <button
            className="button button--primary"
            type="button"
            onClick={retry}
          >
            Retry Beta check <span aria-hidden="true">↻</span>
          </button>
        )}
        {state.status === "ready" && (
          <>
            <a className="button button--primary" href={state.release.artifacts.arm64.downloadURL}>
              Apple silicon <span aria-hidden="true">↓</span>
            </a>
            <a className="button button--dark" href={state.release.artifacts.x86_64.downloadURL}>
              Intel Mac <span aria-hidden="true">↓</span>
            </a>
          </>
        )}
        <a className="button button--dark" href="#demo">See real cards ↓</a>
      </div>
      <p className="beta-release-note">
        {state.status === "ready"
          ? `Zimlo ${state.release.version} · Apple silicon or Intel · macOS ${state.release.minimumSystemVersion}+`
          : state.status === "error"
            ? "Could not reach the release server. Check your connection and retry."
            : "Signed Mac download and iPhone TestFlight access will appear here when the Beta opens."}
      </p>
    </>
  );
}
