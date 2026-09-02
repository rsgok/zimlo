const RELEASE_PREFIX = "/releases/macos/";
const SAFE_RELEASE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;
const MAC_DISK_IMAGE_NAME = /^Zimlo-[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.dmg$/u;

export function releaseAssetKey(pathname: string): string | null {
  if (!pathname.startsWith(RELEASE_PREFIX)) return null;
  let name: string;
  try {
    name = decodeURIComponent(pathname.slice(RELEASE_PREFIX.length));
  } catch {
    return null;
  }
  if (!SAFE_RELEASE_NAME.test(name) || name.includes("..")) return null;
  return `macos/${name}`;
}

export function releaseAssetHeaders(name: string): Record<string, string> {
  if (name === "latest.json" || name === "runtime-latest.json") {
    return {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300, must-revalidate",
      "access-control-allow-origin": "*",
    };
  }
  if (name === "appcast.xml" || /^appcast-(arm64|x86_64)\.xml$/u.test(name)) {
    return {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=300, must-revalidate",
    };
  }
  if (name.endsWith(".dmg")) {
    return {
      "content-type": "application/x-apple-diskimage",
      "cache-control": "public, max-age=31536000, immutable",
      "content-disposition": `attachment; filename="${name}"`,
    };
  }
  if (name.endsWith(".zip")) {
    return {
      "content-type": "application/zip",
      "cache-control": "public, max-age=31536000, immutable",
      "content-disposition": `attachment; filename="${name}"`,
    };
  }
  return {
    "content-type": "application/octet-stream",
    "cache-control": "public, max-age=3600",
  };
}

export type MacReleaseArchitecture = "arm64" | "x86_64";

export function latestMacReleaseName(
  value: unknown,
  architecture: MacReleaseArchitecture,
): string | null {
  if (!value || typeof value !== "object") return null;
  const manifest = value as {
    schemaVersion?: unknown;
    artifacts?: Partial<Record<MacReleaseArchitecture, { fileName?: unknown }>>;
  };
  if (manifest.schemaVersion !== 2) return null;
  const fileName = manifest.artifacts?.[architecture]?.fileName;
  if (typeof fileName !== "string"
      || !MAC_DISK_IMAGE_NAME.test(fileName)
      || fileName.includes("..")
      || !fileName.endsWith(`-${architecture}.dmg`)) {
    return null;
  }
  return fileName;
}
