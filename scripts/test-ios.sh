#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Keep every app/test/extension deployment target compatible before preferring
# a booted device; CI can have an older iPhone simulator booted already.
zimlo_simulator="${ZIMLO_IOS_SIMULATOR_ID:-$(xcrun simctl list devices available -j | python3 -c '
import json, pathlib, re, sys

def version(value):
    parts = [int(part) for part in re.split(r"[.-]", value)]
    return tuple((parts + [0, 0])[:3])

targets = re.findall(r"\bIPHONEOS_DEPLOYMENT_TARGET\s*=\s*\"?([0-9.]+)\"?\s*;", pathlib.Path(sys.argv[1]).read_text())
if not targets:
    sys.exit("Cannot determine the project iOS deployment target")
minimum = max(map(version, targets))
devices = []
for runtime, group in json.load(sys.stdin)["devices"].items():
    match = re.fullmatch(r"com\.apple\.CoreSimulator\.SimRuntime\.iOS-([0-9-]+)", runtime)
    if match and version(match[1]) >= minimum:
        devices.extend(device for device in group if device["name"].startswith("iPhone") and device.get("isAvailable", True))
devices.sort(key=lambda device: device["state"] != "Booted")
print(devices[0]["udid"] if devices else "")
' apps/ios/Zimlo.xcodeproj/project.pbxproj)}"
if [[ -z "$zimlo_simulator" ]]; then echo "No available iPhone simulator runtime meets the project deployment target. Install a compatible runtime in Xcode Settings > Components." >&2; exit 1; fi
xcodebuild test -project apps/ios/Zimlo.xcodeproj -scheme Zimlo \
  -destination "platform=iOS Simulator,id=$zimlo_simulator" \
  -derivedDataPath "${ZIMLO_IOS_DERIVED_DATA:-apps/ios/.build/DerivedData}" \
  CODE_SIGNING_ALLOWED=NO
