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

cd "${repo_root}"
pnpm --filter @zimlo/cloud exec wrangler r2 object get \
  "${bucket}/macos/appcast.xml" \
  --file "${appcast_path}" >/dev/null 2>&1 || true

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

pnpm --filter @zimlo/cloud exec wrangler r2 object put \
  "${bucket}/macos/${dmg_path:t}" \
  --file "${dmg_path}" \
  --content-type "application/x-apple-diskimage"
pnpm --filter @zimlo/cloud exec wrangler r2 object put \
  "${bucket}/macos/appcast.xml" \
  --file "${appcast_path}" \
  --content-type "application/xml; charset=utf-8"

curl --fail --silent --show-error "${public_base_url}/appcast.xml" >/dev/null
curl --fail --silent --show-error --head "${public_base_url}/${dmg_path:t}" >/dev/null
echo "${public_base_url}/appcast.xml"
