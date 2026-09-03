#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
install_prefix=${ZIMLO_INSTALL_PREFIX:-"${HOME:?HOME is required}/.local"}
bin_root="${install_prefix}/bin"
share_root="${install_prefix}/share/zimlo"
temporary_share="${install_prefix}/share/.zimlo-install-$$"
previous_share="${install_prefix}/share/.zimlo-previous-$$"

cleanup() {
  if [[ -e "${temporary_share}" ]]; then rm -r "${temporary_share}"; fi
}
trap cleanup EXIT

mkdir -p "${bin_root}" "${install_prefix}/share"
install -m 0755 "${script_dir}/bin/zimlo" "${bin_root}/.zimlo-install-$$"
mv "${bin_root}/.zimlo-install-$$" "${bin_root}/zimlo"
cp -R "${script_dir}/share/zimlo" "${temporary_share}"
if [[ -e "${share_root}" ]]; then
  mv "${share_root}" "${previous_share}"
fi
if ! mv "${temporary_share}" "${share_root}"; then
  if [[ -e "${previous_share}" ]]; then mv "${previous_share}" "${share_root}"; fi
  exit 1
fi
if [[ -e "${previous_share}" ]]; then rm -r "${previous_share}"; fi

"${bin_root}/zimlo" service install
printf '\nZimlo 已安装到 %s 并作为用户服务启动。\n' "${install_prefix}"
printf '下一步：%s integrations install --target cli\n' "${bin_root}/zimlo"
printf '然后运行：%s pair\n' "${bin_root}/zimlo"
if [[ ":${PATH}:" != *":${bin_root}:"* ]]; then
  printf '提示：将 %s 加入 PATH 后可直接使用 zimlo 命令。\n' "${bin_root}"
fi
