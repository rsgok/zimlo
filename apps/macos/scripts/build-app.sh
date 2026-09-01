#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
macos_root=${script_dir:h}
repo_root=${macos_root:h:h}
build_root="${macos_root}/.build/app"
app_path=${ZIMLO_APP_OUTPUT:-"${macos_root}/.build/Zimlo.app"}
products_path="${macos_root}/.build/apple/Products/Release"
icon_source="${macos_root}/Resources/AppIcon-1024.png"
sign_identity=${ZIMLO_SIGN_IDENTITY:--}
version=${ZIMLO_VERSION:-0.3.0}
build_number=${ZIMLO_BUILD_NUMBER:-1}
sparkle_public_key=${SPARKLE_PUBLIC_KEY:-__SPARKLE_PUBLIC_KEY__}
runtime_version=${ZIMLO_RUNTIME_VERSION:-${version}-${build_number}}
runtime_manifest_url=${ZIMLO_RUNTIME_MANIFEST_URL:-https://cloud.zimlo.app/releases/macos/runtime-latest.json}
runtime_team_identifier=${ZIMLO_TEAM_ID:-${APPLE_TEAM_ID:-}}

if [[ "${ZIMLO_RELEASE:-0}" == "1" ]]; then
  if [[ "${sign_identity}" == "-" ]]; then
    echo "ZIMLO_SIGN_IDENTITY must be a Developer ID Application identity for release builds." >&2
    exit 1
  fi
  if [[ "${sparkle_public_key}" == "__SPARKLE_PUBLIC_KEY__" || -z "${sparkle_public_key}" ]]; then
    echo "SPARKLE_PUBLIC_KEY must be set for release builds." >&2
    exit 1
  fi
  if [[ -z "${runtime_team_identifier}" ]]; then
    echo "ZIMLO_TEAM_ID must identify the Developer ID team that signs Bridge Runtime artifacts." >&2
    exit 1
  fi
fi

if [[ "${ZIMLO_SKIP_PROJECT_BUILD:-0}" != "1" ]]; then
  cd "${repo_root}"
  pnpm build
fi

cd "${macos_root}"
swift build -c release --arch arm64 --arch x86_64

if [[ -e "${app_path}" ]]; then
  rm -rf "${app_path}"
fi
rm -rf "${build_root}"
mkdir -p \
  "${app_path}/Contents/MacOS" \
  "${app_path}/Contents/Frameworks" \
  "${app_path}/Contents/Resources"

cp "${products_path}/Zimlo" "${app_path}/Contents/MacOS/Zimlo"
ditto "${products_path}/Sparkle.framework" "${app_path}/Contents/Frameworks/Sparkle.framework"
install_name_tool -add_rpath "@executable_path/../Frameworks" "${app_path}/Contents/MacOS/Zimlo"
cp "${macos_root}/Resources/Info.plist" "${app_path}/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${version}" "${app_path}/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${build_number}" "${app_path}/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :SUPublicEDKey ${sparkle_public_key}" "${app_path}/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :ZimloRuntimeManifestURL string ${runtime_manifest_url}" "${app_path}/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :ZimloRequiredRuntimeVersion string ${runtime_version}" "${app_path}/Contents/Info.plist"
if [[ "${ZIMLO_RELEASE:-0}" == "1" ]]; then
  /usr/libexec/PlistBuddy -c "Add :ZimloRuntimeTeamIdentifier string ${runtime_team_identifier}" "${app_path}/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Add :ZimloAllowsAdHocRuntime bool false" "${app_path}/Contents/Info.plist"
else
  /usr/libexec/PlistBuddy -c "Add :ZimloAllowsAdHocRuntime bool true" "${app_path}/Contents/Info.plist"
  if [[ -n "${ZIMLO_RUNTIME_DEVELOPMENT_PATH:-}" ]]; then
    /usr/libexec/PlistBuddy -c "Add :ZimloRuntimeDevelopmentPath string ${ZIMLO_RUNTIME_DEVELOPMENT_PATH}" "${app_path}/Contents/Info.plist"
  fi
fi

iconset="${build_root}/AppIcon.iconset"
mkdir -p "${iconset}"
for size in 16 32 128 256 512; do
  sips -z "${size}" "${size}" "${icon_source}" --out "${iconset}/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "${double}" "${double}" "${icon_source}" --out "${iconset}/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "${iconset}" -o "${app_path}/Contents/Resources/AppIcon.icns"
cp "${icon_source}" "${app_path}/Contents/Resources/AppIcon-1024.png"
ditto "${repo_root}/apps/ios/Zimlo/Resources/avatars" "${app_path}/Contents/Resources/avatars"
ditto "${repo_root}/apps/shared/branding/providers" "${app_path}/Contents/Resources/providers"

typeset -a sign_options
sign_options=(--force --options runtime --sign "${sign_identity}")
if [[ "${sign_identity}" != "-" ]]; then
  sign_options+=(--timestamp)
fi
codesign \
  "${sign_options[@]}" \
  --deep \
  --preserve-metadata=entitlements \
  "${app_path}/Contents/Frameworks/Sparkle.framework"
typeset -a app_sign_options
app_sign_options=("${sign_options[@]}")
if [[ "${sign_identity}" == "-" ]]; then
  app_sign_options+=(--entitlements "${macos_root}/Resources/AppDebug.entitlements")
fi
codesign "${app_sign_options[@]}" "${app_path}"
codesign --verify --deep --strict --verbose=2 "${app_path}"

lipo "${app_path}/Contents/MacOS/Zimlo" -verify_arch arm64 x86_64
echo "${app_path}"
