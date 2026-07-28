#!/bin/zsh
set -euo pipefail

if (( $# != 1 )); then
  echo "usage: publish-release.sh PATH_TO_NOTARIZED_DMG" >&2
  exit 64
fi

script_dir=${0:A:h}
macos_root=${script_dir:h}
repo_root=${macos_root:h:h}
dmg_path=${1:A}
release_dir=${dmg_path:h}
appcast_path="${release_dir}/appcast.xml"
downloaded_appcast_path="${release_dir}/appcast.download.xml"
verified_appcast_path="${release_dir}/appcast.verified.xml"
release_manifest_path="${release_dir}/latest.json"
verified_manifest_path="${release_dir}/latest.verified.json"
bucket=${ZIMLO_RELEASE_BUCKET:-zimlo-releases}
public_base_url=${ZIMLO_RELEASE_BASE_URL:-https://zimlo-cloud.zimlo.workers.dev/releases/macos}
sparkle_tools="${macos_root}/.build/artifacts/sparkle/Sparkle/bin"

if [[ ! -f "${dmg_path}" ]]; then
  echo "Release DMG does not exist: ${dmg_path}" >&2
  exit 1
fi
if [[ ! -x "${sparkle_tools}/generate_appcast" ]]; then
  echo "Sparkle tools are missing. Run pnpm macos:build once first." >&2
  exit 1
fi
if [[ ! "${dmg_path:t}" =~ '^Zimlo-([0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?)\.dmg$' ]]; then
  echo "Release DMG must be named Zimlo-VERSION.dmg." >&2
  exit 64
fi
version=${match[1]}

# Publishing is deliberately fail-closed: a locally generated or modified DMG
# must never become an update merely because it has the expected filename.
codesign --verify --strict --verbose=2 "${dmg_path}"
xcrun stapler validate "${dmg_path}"
spctl --assess --type open --context context:primary-signature --verbose=2 "${dmg_path}"

cd "${repo_root}"
rm -f "${downloaded_appcast_path}" "${verified_appcast_path}" "${verified_manifest_path}"
appcast_status=$(
  curl --silent --show-error --location \
    --output "${downloaded_appcast_path}" \
    --write-out "%{http_code}" \
    "${public_base_url}/appcast.xml?preflight=${version}"
)
case "${appcast_status}" in
  200) mv "${downloaded_appcast_path}" "${appcast_path}" ;;
  404) rm -f "${downloaded_appcast_path}" "${appcast_path}" ;;
  *)
    echo "Unable to read the current appcast (HTTP ${appcast_status}); refusing to overwrite update history." >&2
    exit 1
    ;;
esac

typeset -a key_options
if [[ -n "${SPARKLE_PRIVATE_KEY_FILE:-}" ]]; then
  key_options=(--ed-key-file "${SPARKLE_PRIVATE_KEY_FILE}")
else
  key_options=(--account "${SPARKLE_KEY_ACCOUNT:-zimlo}")
fi

"${sparkle_tools}/generate_appcast" \
  "${key_options[@]}" \
  --download-url-prefix "${public_base_url}/" \
  --maximum-versions 3 \
  --maximum-deltas 0 \
  -o "${appcast_path}" \
  "${release_dir}"

if ! grep -Fq "${dmg_path:t}" "${appcast_path}" || ! grep -Fq "sparkle:edSignature=" "${appcast_path}"; then
  echo "Generated appcast does not contain the signed ${dmg_path:t} update." >&2
  exit 1
fi

node -e '
  const [path, version, fileName, baseURL] = process.argv.slice(1);
  const payload = {
    version,
    fileName,
    downloadURL: `${baseURL}/${encodeURIComponent(fileName)}`,
    minimumSystemVersion: "14.0",
  };
  require("node:fs").writeFileSync(path, `${JSON.stringify(payload)}\n`, { mode: 0o644 });
' "${release_manifest_path}" "${version}" "${dmg_path:t}" "${public_base_url}"

pnpm --filter @zimlo/cloud exec wrangler r2 object put --remote \
  "${bucket}/macos/${dmg_path:t}" \
  --file "${dmg_path}" \
  --content-type "application/x-apple-diskimage"
pnpm --filter @zimlo/cloud exec wrangler r2 object put --remote \
  "${bucket}/macos/appcast.xml" \
  --file "${appcast_path}" \
  --content-type "application/xml; charset=utf-8"
pnpm --filter @zimlo/cloud exec wrangler r2 object put --remote \
  "${bucket}/macos/latest.json" \
  --file "${release_manifest_path}" \
  --content-type "application/json; charset=utf-8"

curl --fail --silent --show-error --location \
  "${public_base_url}/appcast.xml?verify=${version}" \
  --output "${verified_appcast_path}"
if ! grep -Fq "${dmg_path:t}" "${verified_appcast_path}"; then
  echo "Published appcast does not reference ${dmg_path:t}." >&2
  exit 1
fi
curl --fail --silent --show-error --head \
  "${public_base_url}/${dmg_path:t}?verify=${version}" >/dev/null
curl --fail --silent --show-error --location \
  "${public_base_url}/latest.json?verify=${version}" \
  --output "${verified_manifest_path}"
node -e '
  const [path, version, fileName, baseURL] = process.argv.slice(1);
  const payload = JSON.parse(require("node:fs").readFileSync(path, "utf8"));
  if (
    payload.version !== version
    || payload.fileName !== fileName
    || payload.downloadURL !== `${baseURL}/${encodeURIComponent(fileName)}`
  ) {
    throw new Error("Published release manifest does not match the signed disk image.");
  }
' "${verified_manifest_path}" "${version}" "${dmg_path:t}" "${public_base_url}"
echo "${public_base_url}/appcast.xml"
