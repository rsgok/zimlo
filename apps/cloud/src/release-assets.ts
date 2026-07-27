const RELEASE_PREFIX = "/releases/macos/";
const SAFE_RELEASE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;

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
  if (name === "appcast.xml") {
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
  return {
    "content-type": "application/octet-stream",
    "cache-control": "public, max-age=3600",
  };
}
