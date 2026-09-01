#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
macos_root=${script_dir:h}
repo_root=${macos_root:h:h}
version=${ZIMLO_VERSION:-0.3.0}
build_number=${ZIMLO_BUILD_NUMBER:-1}
runtime_version=${ZIMLO_RUNTIME_VERSION:-${version}-${build_number}}
architecture=$(uname -m)

cd "${repo_root}"
pnpm build
ZIMLO_SKIP_PROJECT_BUILD=1 \
ZIMLO_RELEASE=0 \
ZIMLO_SIGN_IDENTITY=- \
ZIMLO_RUNTIME_VERSION="${runtime_version}" \
"${script_dir}/build-runtime.sh" "${architecture}" >/dev/null

runtime_path="${macos_root}/.build/runtime-${runtime_version}/${architecture}/ZimloBridgeRuntime.app"
ZIMLO_SKIP_PROJECT_BUILD=1 \
ZIMLO_RELEASE=0 \
ZIMLO_SIGN_IDENTITY=- \
ZIMLO_RUNTIME_VERSION="${runtime_version}" \
ZIMLO_RUNTIME_DEVELOPMENT_PATH="${runtime_path}" \
"${script_dir}/build-app.sh"
