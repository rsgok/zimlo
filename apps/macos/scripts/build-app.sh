#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
macos_root=${script_dir:h}
repo_root=${macos_root:h:h}
build_root="${macos_root}/.build/app"
app_path=${ZIMLO_APP_OUTPUT:-"${macos_root}/.build/Zimlo.app"}
runtime_path="${app_path}/Contents/Resources/runtime"
products_path="${macos_root}/.build/apple/Products/Release"
icon_source="${macos_root}/Resources/AppIcon-1024.png"
sign_identity=${ZIMLO_SIGN_IDENTITY:--}
version=${ZIMLO_VERSION:-0.3.0}
build_number=${ZIMLO_BUILD_NUMBER:-1}
sparkle_public_key=${SPARKLE_PUBLIC_KEY:-__SPARKLE_PUBLIC_KEY__}

if [[ "${ZIMLO_RELEASE:-0}" == "1" ]]; then
  if [[ "${sign_identity}" == "-" ]]; then
    echo "ZIMLO_SIGN_IDENTITY must be a Developer ID Application identity for release builds." >&2
    exit 1
  fi
  if [[ "${sparkle_public_key}" == "__SPARKLE_PUBLIC_KEY__" || -z "${sparkle_public_key}" ]]; then
    echo "SPARKLE_PUBLIC_KEY must be set for release builds." >&2
    exit 1
  fi
fi

cd "${repo_root}"
pnpm build

cd "${macos_root}"
swift build -c release --arch arm64 --arch x86_64

if [[ -e "${app_path}" ]]; then
  rm -rf "${app_path}"
fi
rm -rf "${build_root}"
mkdir -p \
  "${app_path}/Contents/MacOS" \
  "${app_path}/Contents/Frameworks" \
  "${app_path}/Contents/Resources" \
  "${runtime_path}"

cp "${products_path}/Zimlo" "${app_path}/Contents/MacOS/Zimlo"
ditto "${products_path}/Sparkle.framework" "${app_path}/Contents/Frameworks/Sparkle.framework"
install_name_tool -add_rpath "@executable_path/../Frameworks" "${app_path}/Contents/MacOS/Zimlo"
cp "${macos_root}/Resources/Info.plist" "${app_path}/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${version}" "${app_path}/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${build_number}" "${app_path}/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :SUPublicEDKey ${sparkle_public_key}" "${app_path}/Contents/Info.plist"

"${script_dir}/prepare-universal-node.sh" "${runtime_path}/node"

cd "${repo_root}"
pnpm \
  --config.package-import-method=copy \
  --filter @zimlo/cli \
  --prod \
  deploy \
  --legacy \
  "${runtime_path}/cli"
# pnpm's legacy deploy creates a self-reference that points back to the source
# workspace. The packaged runtime executes dist/index.js directly and does not
# need this link; keeping it would make the signed bundle non-relocatable.
rm -f "${runtime_path}/cli/node_modules/.pnpm/node_modules/@zimlo/cli"
detached_cli="${build_root}/detached-cli"
ditto "${runtime_path}/cli" "${detached_cli}"
rm -rf "${runtime_path}/cli"
mv "${detached_cli}" "${runtime_path}/cli"
source_protocol="${repo_root}/packages/protocol/dist/index.js"
packaged_protocol="${runtime_path}/cli/node_modules/.pnpm/@zimlo+protocol@file+packages+protocol/node_modules/@zimlo/protocol/dist/index.js"
if [[ -f "${source_protocol}" && -f "${packaged_protocol}" ]]; then
  source_inode=$(stat -f "%d:%i" "${source_protocol}")
  packaged_inode=$(stat -f "%d:%i" "${packaged_protocol}")
  if [[ "${source_inode}" == "${packaged_inode}" ]]; then
    echo "Packaged runtime still shares writable files with the source workspace." >&2
    exit 1
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
codesign \
  "${sign_options[@]}" \
  --entitlements "${macos_root}/Resources/Node.entitlements" \
  "${runtime_path}/node"
typeset -a app_sign_options
app_sign_options=("${sign_options[@]}")
if [[ "${sign_identity}" == "-" ]]; then
  app_sign_options+=(--entitlements "${macos_root}/Resources/AppDebug.entitlements")
fi
codesign "${app_sign_options[@]}" "${app_path}"
codesign --verify --deep --strict --verbose=2 "${app_path}"

lipo "${app_path}/Contents/MacOS/Zimlo" -verify_arch arm64 x86_64
lipo "${runtime_path}/node" -verify_arch arm64 x86_64
echo "${app_path}"
