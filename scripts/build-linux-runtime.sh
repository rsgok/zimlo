#!/usr/bin/env bash
set -euo pipefail

if (( $# > 1 )); then
  printf 'usage: build-linux-runtime.sh [x86_64|aarch64]\n' >&2
  exit 64
fi
if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'Linux Runtime packages must be built on Linux.\n' >&2
  exit 69
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "${script_dir}/.." && pwd)
architecture=${1:-$(uname -m)}
version=${ZIMLO_VERSION:-$(node -e 'process.stdout.write(require(process.argv[1]).productVersion)' "${repo_root}/config/zimlo-contract.json")}
output_root=${ZIMLO_RUNTIME_OUTPUT_ROOT:-"${repo_root}/dist/linux"}

case "${architecture}" in
  x86_64) rust_target=x86_64-unknown-linux-musl ;;
  aarch64|arm64)
    architecture=aarch64
    rust_target=aarch64-unknown-linux-musl
    ;;
  *)
    printf 'Unsupported Linux Runtime architecture: %s\n' "${architecture}" >&2
    exit 64
    ;;
esac
if [[ ! "${version}" =~ ^[0-9A-Za-z._-]{1,96}$ ]]; then
  printf 'ZIMLO_VERSION contains unsupported characters.\n' >&2
  exit 64
fi

if [[ "${ZIMLO_SKIP_PROJECT_BUILD:-0}" != "1" ]]; then
  cd "${repo_root}"
  pnpm --filter @zimlo/protocol build
  pnpm --filter @zimlo/web build
fi

cd "${repo_root}/runtime"
cargo build --release --locked --target "${rust_target}" -p zimlo-cli
cargo_target_root=$(cargo metadata --format-version 1 --no-deps | node -e '
let value = "";
process.stdin.on("data", (chunk) => { value += chunk; });
process.stdin.on("end", () => { process.stdout.write(JSON.parse(value).target_directory); });
')

package_name="zimlo-${version}-linux-${architecture}"
staging="${output_root}/${package_name}"
archive="${output_root}/${package_name}.tar.gz"
if [[ -e "${staging}" ]]; then
  rm -r "${staging}"
fi
mkdir -p "${staging}/bin" "${staging}/share/zimlo/public" "${staging}/share/zimlo/plugin"
install -m 0755 "${cargo_target_root}/${rust_target}/release/zimlo" "${staging}/bin/zimlo"
cp -R "${repo_root}/apps/web/dist/." "${staging}/share/zimlo/public/"
cp -R "${repo_root}/apps/cli/plugin/." "${staging}/share/zimlo/plugin/"
install -m 0755 "${repo_root}/scripts/install-linux.sh" "${staging}/install.sh"
install -m 0644 "${repo_root}/docs/LINUX_HEADLESS.md" "${staging}/README.md"

mkdir -p "${output_root}"
rm -f "${archive}"
tar -C "${output_root}" -czf "${archive}" "${package_name}"
printf '%s\n' "${archive}"
