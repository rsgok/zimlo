#!/bin/zsh
set -euo pipefail

if (( $# != 1 )); then
  echo "usage: publish-release.sh PATH_TO_RELEASE_DIRECTORY" >&2
  exit 64
fi

script_dir=${0:A:h}
macos_root=${script_dir:h}
repo_root=${macos_root:h:h}
release_dir=${1:A}
release_name=${release_dir:t}
if [[ ! "${release_name}" =~ '^release-([0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?)$' ]]; then
  echo "Release directory must be named release-VERSION." >&2
  exit 64
fi
version=${match[1]}

runtime_dir="${release_dir}/runtime"
runtime_manifest_path="${runtime_dir}/runtime-latest.json"
release_manifest_path="${release_dir}/latest.json"
verified_manifest_path="${release_dir}/latest.verified.json"
verified_runtime_manifest_path="${release_dir}/runtime-latest.verified.json"
bucket=${ZIMLO_RELEASE_BUCKET:-zimlo-releases}
public_base_url=${ZIMLO_RELEASE_BASE_URL:-https://cloud.zimlo.app/releases/macos}
sparkle_tools=${SPARKLE_TOOLS_DIR:-}
if [[ -z "${sparkle_tools}" ]]; then
  for candidate in \
    "${macos_root}/.build/artifacts/sparkle/Sparkle/bin" \
    "${macos_root}/.build/swift-arm64/artifacts/sparkle/Sparkle/bin" \
    "${macos_root}/.build/swift-x86_64/artifacts/sparkle/Sparkle/bin"; do
    if [[ -x "${candidate}/generate_appcast" ]]; then
      sparkle_tools=${candidate}
      break
    fi
  done
fi
typeset -a architectures
architectures=(arm64 x86_64)

for architecture in "${architectures[@]}"; do
  dmg_path="${release_dir}/Zimlo-${version}-${architecture}.dmg"
  if [[ ! -f "${dmg_path}" ]]; then
    echo "Release DMG does not exist: ${dmg_path}" >&2
    exit 1
  fi
done

if [[ ! -f "${runtime_manifest_path}" ]]; then
  echo "Runtime release manifest does not exist: ${runtime_manifest_path}" >&2
  exit 1
fi
if [[ ! -x "${sparkle_tools}/generate_appcast" ]]; then
  echo "Sparkle tools are missing. Run pnpm macos:build once first." >&2
  exit 1
fi

typeset -a runtime_files
runtime_files=("${(@f)$(node -e '
  const payload = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (
    payload.schemaVersion !== 1
    || typeof payload.runtimeVersion !== "string"
    || !Number.isSafeInteger(payload.protocolVersion)
    || !payload.artifacts
  ) throw new Error("Runtime manifest is invalid.");
  for (const architecture of ["arm64", "x86_64"]) {
    const artifact = payload.artifacts[architecture];
    const url = new URL(artifact?.downloadURL ?? "");
    const fileName = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    if (
      url.protocol !== "https:"
      || !/^ZimloRuntime-[0-9A-Za-z._-]+-(arm64|x86_64)\.zip$/u.test(fileName)
      || !/^[a-f0-9]{64}$/u.test(artifact?.sha256 ?? "")
      || !Number.isSafeInteger(artifact?.size)
      || artifact.size < 1
    ) throw new Error(`Runtime artifact ${architecture} is invalid.`);
    const path = require("node:path").join(process.argv[2], fileName);
    const data = require("node:fs").readFileSync(path);
    const digest = require("node:crypto").createHash("sha256").update(data).digest("hex");
    if (digest !== artifact.sha256 || data.byteLength !== artifact.size) {
      throw new Error(`Runtime artifact ${architecture} does not match its manifest.`);
    }
    console.log(fileName);
  }
' "${runtime_manifest_path}" "${runtime_dir}")}")
if (( ${#runtime_files[@]} != 2 )); then
  echo "Runtime manifest must contain arm64 and x86_64 artifacts." >&2
  exit 1
fi

runtime_verification_root=$(mktemp -d)
appcast_work_root=$(mktemp -d)
trap 'rm -rf "${runtime_verification_root}" "${appcast_work_root}"' EXIT
for runtime_file in "${runtime_files[@]}"; do
  runtime_extract="${runtime_verification_root}/${runtime_file:r}"
  mkdir -p "${runtime_extract}"
  ditto -x -k "${runtime_dir}/${runtime_file}" "${runtime_extract}"
  runtime_helper="${runtime_extract}/ZimloBridgeRuntime.app"
  codesign --verify --deep --strict --verbose=2 "${runtime_helper}"
  xcrun stapler validate "${runtime_helper}"
done

typeset -a key_options
if [[ -n "${SPARKLE_PRIVATE_KEY_FILE:-}" ]]; then
  key_options=(--ed-key-file "${SPARKLE_PRIVATE_KEY_FILE}")
else
  key_options=(--account "${SPARKLE_KEY_ACCOUNT:-zimlo}")
fi

for architecture in "${architectures[@]}"; do
  dmg_path="${release_dir}/Zimlo-${version}-${architecture}.dmg"
  appcast_path="${release_dir}/appcast-${architecture}.xml"
  appcast_source="${appcast_work_root}/${architecture}"
  mkdir -p "${appcast_source}"
  ditto "${dmg_path}" "${appcast_source}/${dmg_path:t}"

  codesign --verify --strict --verbose=2 "${dmg_path}"
  xcrun stapler validate "${dmg_path}"
  spctl --assess --type open --context context:primary-signature --verbose=2 "${dmg_path}"

  appcast_status=$(
    curl --silent --show-error --location \
      --output "${appcast_source}/appcast.xml" \
      --write-out "%{http_code}" \
      "${public_base_url}/appcast-${architecture}.xml?preflight=${version}"
  )
  case "${appcast_status}" in
    200) ;;
    404) rm -f "${appcast_source}/appcast.xml" ;;
    *)
      echo "Unable to read the ${architecture} appcast (HTTP ${appcast_status}); refusing to overwrite update history." >&2
      exit 1
      ;;
  esac

  "${sparkle_tools}/generate_appcast" \
    "${key_options[@]}" \
    --download-url-prefix "${public_base_url}/" \
    --maximum-versions 3 \
    --maximum-deltas 0 \
    "${appcast_source}"
  ditto "${appcast_source}/appcast.xml" "${appcast_path}"

  if ! grep -Fq "${dmg_path:t}" "${appcast_path}" || ! grep -Fq "sparkle:edSignature=" "${appcast_path}"; then
    echo "Generated ${architecture} appcast does not contain the signed ${dmg_path:t} update." >&2
    exit 1
  fi
done

# Keep the legacy architecture-neutral feed alive for already-installed
# universal builds. Sparkle inspects both thin App bundles and writes the
# hardware requirement that selects the compatible update.
legacy_appcast_source="${appcast_work_root}/legacy"
legacy_appcast_path="${release_dir}/appcast.xml"
mkdir -p "${legacy_appcast_source}"
for architecture in "${architectures[@]}"; do
  dmg_path="${release_dir}/Zimlo-${version}-${architecture}.dmg"
  ditto "${dmg_path}" "${legacy_appcast_source}/${dmg_path:t}"
done
legacy_appcast_status=$(
  curl --silent --show-error --location \
    --output "${legacy_appcast_source}/appcast.xml" \
    --write-out "%{http_code}" \
    "${public_base_url}/appcast.xml?preflight=${version}"
)
case "${legacy_appcast_status}" in
  200) ;;
  404) rm -f "${legacy_appcast_source}/appcast.xml" ;;
  *)
    echo "Unable to read the legacy appcast (HTTP ${legacy_appcast_status}); refusing to overwrite update history." >&2
    exit 1
    ;;
esac
"${sparkle_tools}/generate_appcast" \
  "${key_options[@]}" \
  --download-url-prefix "${public_base_url}/" \
  --maximum-versions 3 \
  --maximum-deltas 0 \
  "${legacy_appcast_source}"
ditto "${legacy_appcast_source}/appcast.xml" "${legacy_appcast_path}"
for architecture in "${architectures[@]}"; do
  if ! grep -Fq "Zimlo-${version}-${architecture}.dmg" "${legacy_appcast_path}"; then
    echo "Legacy appcast does not contain the ${architecture} update." >&2
    exit 1
  fi
done

node -e '
  const [path, version, armName, intelName, baseURL] = process.argv.slice(1);
  const artifact = (fileName) => ({
    fileName,
    downloadURL: `${baseURL}/${encodeURIComponent(fileName)}`,
  });
  const payload = {
    schemaVersion: 2,
    version,
    minimumSystemVersion: "14.0",
    artifacts: {
      arm64: artifact(armName),
      x86_64: artifact(intelName),
    },
  };
  require("node:fs").writeFileSync(path, `${JSON.stringify(payload)}\n`, { mode: 0o644 });
' \
  "${release_manifest_path}" \
  "${version}" \
  "Zimlo-${version}-arm64.dmg" \
  "Zimlo-${version}-x86_64.dmg" \
  "${public_base_url}"

cd "${repo_root}"
for runtime_file in "${runtime_files[@]}"; do
  pnpm --filter @zimlo/cloud exec wrangler r2 object put --remote \
    "${bucket}/macos/${runtime_file}" \
    --file "${runtime_dir}/${runtime_file}" \
    --content-type "application/zip"
done
pnpm --filter @zimlo/cloud exec wrangler r2 object put --remote \
  "${bucket}/macos/runtime-latest.json" \
  --file "${runtime_manifest_path}" \
  --content-type "application/json; charset=utf-8"
for architecture in "${architectures[@]}"; do
  dmg_path="${release_dir}/Zimlo-${version}-${architecture}.dmg"
  pnpm --filter @zimlo/cloud exec wrangler r2 object put --remote \
    "${bucket}/macos/${dmg_path:t}" \
    --file "${dmg_path}" \
    --content-type "application/x-apple-diskimage"
done
for architecture in "${architectures[@]}"; do
  appcast_path="${release_dir}/appcast-${architecture}.xml"
  pnpm --filter @zimlo/cloud exec wrangler r2 object put --remote \
    "${bucket}/macos/${appcast_path:t}" \
    --file "${appcast_path}" \
    --content-type "application/xml; charset=utf-8"
done
pnpm --filter @zimlo/cloud exec wrangler r2 object put --remote \
  "${bucket}/macos/appcast.xml" \
  --file "${legacy_appcast_path}" \
  --content-type "application/xml; charset=utf-8"
pnpm --filter @zimlo/cloud exec wrangler r2 object put --remote \
  "${bucket}/macos/latest.json" \
  --file "${release_manifest_path}" \
  --content-type "application/json; charset=utf-8"

for architecture in "${architectures[@]}"; do
  appcast_path="${release_dir}/appcast-${architecture}.xml"
  verified_appcast_path="${release_dir}/appcast-${architecture}.verified.xml"
  dmg_path="${release_dir}/Zimlo-${version}-${architecture}.dmg"
  curl --fail --silent --show-error --location \
    "${public_base_url}/appcast-${architecture}.xml?verify=${version}" \
    --output "${verified_appcast_path}"
  if ! grep -Fq "${dmg_path:t}" "${verified_appcast_path}"; then
    echo "Published ${architecture} appcast does not reference ${dmg_path:t}." >&2
    exit 1
  fi
  curl --fail --silent --show-error --head \
    "${public_base_url}/${dmg_path:t}?verify=${version}" >/dev/null
done
verified_legacy_appcast_path="${release_dir}/appcast.verified.xml"
curl --fail --silent --show-error --location \
  "${public_base_url}/appcast.xml?verify=${version}" \
  --output "${verified_legacy_appcast_path}"
for architecture in "${architectures[@]}"; do
  if ! grep -Fq "Zimlo-${version}-${architecture}.dmg" "${verified_legacy_appcast_path}"; then
    echo "Published legacy appcast does not reference the ${architecture} update." >&2
    exit 1
  fi
done

curl --fail --silent --show-error --location \
  "${public_base_url}/latest.json?verify=${version}" \
  --output "${verified_manifest_path}"
node -e '
  const [expectedPath, actualPath] = process.argv.slice(1);
  const expected = JSON.parse(require("node:fs").readFileSync(expectedPath, "utf8"));
  const actual = JSON.parse(require("node:fs").readFileSync(actualPath, "utf8"));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Published release manifest does not match local architecture artifacts.");
  }
' "${release_manifest_path}" "${verified_manifest_path}"

curl --fail --silent --show-error --location \
  "${public_base_url}/runtime-latest.json?verify=${version}" \
  --output "${verified_runtime_manifest_path}"
node -e '
  const [expectedPath, actualPath] = process.argv.slice(1);
  const expected = JSON.parse(require("node:fs").readFileSync(expectedPath, "utf8"));
  const actual = JSON.parse(require("node:fs").readFileSync(actualPath, "utf8"));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Published Runtime manifest does not match local artifacts.");
  }
' "${runtime_manifest_path}" "${verified_runtime_manifest_path}"
for runtime_file in "${runtime_files[@]}"; do
  curl --fail --silent --show-error --head \
    "${public_base_url}/${runtime_file}?verify=${version}" >/dev/null
done

echo "${public_base_url}/appcast-arm64.xml"
echo "${public_base_url}/appcast-x86_64.xml"
