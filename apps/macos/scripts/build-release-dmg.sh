#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
macos_root=${script_dir:h}
version=${ZIMLO_VERSION:-0.3.0}
build_number=${ZIMLO_BUILD_NUMBER:-1}
release_root="${macos_root}/.build/release-${version}"
app_path="${release_root}/Zimlo.app"
dmg_path="${release_root}/Zimlo-${version}.dmg"
staging_path="${release_root}/dmg"

if [[ ! "${version}" =~ '^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$' ]]; then
  echo "ZIMLO_VERSION must be a semantic version such as 0.3.0." >&2
  exit 64
fi
if [[ ! "${build_number}" =~ '^[1-9][0-9]*$' ]]; then
  echo "ZIMLO_BUILD_NUMBER must be a positive integer." >&2
  exit 64
fi
if [[ -z "${ZIMLO_SIGN_IDENTITY:-}" ]]; then
  echo "ZIMLO_SIGN_IDENTITY must name a Developer ID Application identity." >&2
  exit 1
fi
if [[ -z "${SPARKLE_PUBLIC_KEY:-}" ]]; then
  echo "SPARKLE_PUBLIC_KEY must be set for release builds." >&2
  exit 1
fi
if [[ -z "${APPLE_NOTARY_PROFILE:-}" ]] \
  && [[ -z "${APPLE_ID:-}" || -z "${APPLE_TEAM_ID:-}" || -z "${APPLE_APP_PASSWORD:-}" ]]; then
  echo "Set APPLE_NOTARY_PROFILE or APPLE_ID, APPLE_TEAM_ID, and APPLE_APP_PASSWORD." >&2
  exit 1
fi

if [[ -e "${release_root}" ]]; then
  rm -rf "${release_root}"
fi
mkdir -p "${release_root}"

ZIMLO_RELEASE=1 \
ZIMLO_APP_OUTPUT="${app_path}" \
ZIMLO_BUILD_NUMBER="${build_number}" \
"${script_dir}/build-app.sh"

mkdir -p "${staging_path}"
ditto "${app_path}" "${staging_path}/Zimlo.app"
ln -s /Applications "${staging_path}/Applications"
hdiutil create \
  -volname "Zimlo" \
  -srcfolder "${staging_path}" \
  -ov \
  -format UDZO \
  "${dmg_path}"
codesign --force --timestamp --sign "${ZIMLO_SIGN_IDENTITY}" "${dmg_path}"
codesign --verify --strict --verbose=2 "${dmg_path}"

if [[ -n "${APPLE_NOTARY_PROFILE:-}" ]]; then
  xcrun notarytool submit "${dmg_path}" --keychain-profile "${APPLE_NOTARY_PROFILE}" --wait
elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_TEAM_ID:-}" && -n "${APPLE_APP_PASSWORD:-}" ]]; then
  xcrun notarytool submit "${dmg_path}" \
    --apple-id "${APPLE_ID}" \
    --team-id "${APPLE_TEAM_ID}" \
    --password "${APPLE_APP_PASSWORD}" \
    --wait
else
  echo "Notary credentials disappeared after preflight." >&2
  exit 1
fi
xcrun stapler staple "${dmg_path}"
xcrun stapler validate "${dmg_path}"
spctl --assess --type open --context context:primary-signature --verbose=2 "${dmg_path}"

echo "${dmg_path}"
