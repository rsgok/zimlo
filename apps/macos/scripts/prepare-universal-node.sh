#!/bin/zsh
set -euo pipefail

if (( $# != 1 )); then
  echo "usage: prepare-universal-node.sh OUTPUT_PATH" >&2
  exit 64
fi

script_dir=${0:A:h}
macos_root=${script_dir:h}
node_version=${ZIMLO_NODE_VERSION:-24.15.0}
cache_root="${macos_root}/.build/node-${node_version}"
output_path=$1
checksum_url="https://nodejs.org/dist/v${node_version}/SHASUMS256.txt"
checksum_path="${cache_root}/SHASUMS256.txt"

mkdir -p "${cache_root}" "${output_path:h}"
if [[ ! -f "${checksum_path}" ]]; then
  curl --fail --location --retry 3 --output "${checksum_path}" "${checksum_url}"
fi

typeset -a nodes
for architecture in arm64 x64; do
  archive="node-v${node_version}-darwin-${architecture}.tar.gz"
  archive_path="${cache_root}/${archive}"
  extracted_path="${cache_root}/node-v${node_version}-darwin-${architecture}/bin/node"
  if [[ ! -f "${archive_path}" ]]; then
    curl \
      --fail \
      --location \
      --retry 3 \
      --output "${archive_path}" \
      "https://nodejs.org/dist/v${node_version}/${archive}"
  fi
  expected=$(awk -v file="${archive}" '$2 == file { print $1 }' "${checksum_path}")
  if [[ -z "${expected}" ]]; then
    echo "Node checksum is missing for ${archive}" >&2
    exit 1
  fi
  actual=$(shasum -a 256 "${archive_path}" | awk '{ print $1 }')
  if [[ "${actual}" != "${expected}" ]]; then
    echo "Node checksum mismatch for ${archive}" >&2
    exit 1
  fi
  if [[ ! -x "${extracted_path}" ]]; then
    tar -xzf "${archive_path}" -C "${cache_root}"
  fi
  nodes+=("${extracted_path}")
done

lipo -create "${nodes[@]}" -output "${output_path}"
chmod 755 "${output_path}"
lipo "${output_path}" -verify_arch arm64 x86_64
