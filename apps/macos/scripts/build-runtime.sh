#!/bin/zsh
set -euo pipefail

if (( $# > 1 )); then
  echo "usage: build-runtime.sh [arm64|x86_64]" >&2
  exit 64
fi

script_dir=${0:A:h}
macos_root=${script_dir:h}
repo_root=${macos_root:h:h}
architecture=${1:-$(uname -m)}
version=${ZIMLO_VERSION:-0.3.0}
build_number=${ZIMLO_BUILD_NUMBER:-1}
runtime_version=${ZIMLO_RUNTIME_VERSION:-${version}-${build_number}}
output_root=${ZIMLO_RUNTIME_OUTPUT_ROOT:-"${macos_root}/.build/runtime-${runtime_version}"}
architecture_root="${output_root}/${architecture}"
helper_path="${architecture_root}/ZimloBridgeRuntime.app"
binary_path="${helper_path}/Contents/MacOS/zimlo"
resources_path="${helper_path}/Contents/Resources"
public_path="${resources_path}/public"
archive_path="${output_root}/ZimloRuntime-${runtime_version}-${architecture}.zip"
sign_identity=${ZIMLO_SIGN_IDENTITY:--}
protocol_version=$(plutil -extract protocolVersion raw -o - "${repo_root}/config/zimlo-contract.json")

case "${architecture}" in
  arm64|x86_64) ;;
  *)
    echo "Unsupported Runtime architecture: ${architecture}" >&2
    exit 64
    ;;
esac
if [[ ! "${runtime_version}" =~ '^[0-9A-Za-z._-]{1,96}$' ]]; then
  echo "ZIMLO_RUNTIME_VERSION contains unsupported characters." >&2
  exit 64
fi

if [[ "${ZIMLO_SKIP_PROJECT_BUILD:-0}" != "1" ]]; then
  cd "${repo_root}"
  pnpm --filter @zimlo/web build
fi

if [[ -e "${architecture_root}" ]]; then
  rm -rf "${architecture_root}"
fi
mkdir -p "${helper_path}/Contents/MacOS" "${resources_path}"

case "${architecture}" in
  arm64) rust_target=aarch64-apple-darwin ;;
  x86_64) rust_target=x86_64-apple-darwin ;;
esac
cd "${repo_root}/runtime"
cargo build --release --locked --target "${rust_target}" -p zimlo-cli
cp "${repo_root}/runtime/target/${rust_target}/release/zimlo" "${binary_path}"
ditto "${repo_root}/apps/web/dist" "${public_path}"
ditto "${repo_root}/apps/cli/plugin" "${resources_path}/plugin"

info_path="${helper_path}/Contents/Info.plist"
plutil -create xml1 "${info_path}"
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string app.zimlo.bridge-runtime" "${info_path}"
/usr/libexec/PlistBuddy -c "Add :CFBundleName string ZimloBridgeRuntime" "${info_path}"
/usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Zimlo Bridge Runtime" "${info_path}"
/usr/libexec/PlistBuddy -c "Add :CFBundleExecutable string zimlo" "${info_path}"
/usr/libexec/PlistBuddy -c "Add :CFBundlePackageType string APPL" "${info_path}"
/usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string ${runtime_version}" "${info_path}"
/usr/libexec/PlistBuddy -c "Add :CFBundleVersion string ${build_number}" "${info_path}"
/usr/libexec/PlistBuddy -c "Add :LSMinimumSystemVersion string 14.0" "${info_path}"
/usr/libexec/PlistBuddy -c "Add :LSBackgroundOnly bool true" "${info_path}"
/usr/libexec/PlistBuddy -c "Add :ZimloProtocolVersion integer ${protocol_version}" "${info_path}"
/usr/libexec/PlistBuddy -c "Add :ZimloRuntimeArchitecture string ${architecture}" "${info_path}"

typeset -a sign_options
sign_options=(--force --options runtime --sign "${sign_identity}")
if [[ "${sign_identity}" != "-" ]]; then
  sign_options+=(--timestamp)
fi
codesign "${sign_options[@]}" "${helper_path}"
codesign --verify --deep --strict --verbose=2 "${helper_path}"
lipo "${binary_path}" -verify_arch "${architecture}"

rm -f "${archive_path}"
ditto -c -k --sequesterRsrc --keepParent "${helper_path}" "${archive_path}"
echo "${helper_path}"
