#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Choose an available simulator by identifier, avoiding OS/name ambiguity in CI.
zimlo_simulator="${ZIMLO_IOS_SIMULATOR_ID:-$(xcrun simctl list devices available -j | python3 -c 'import json,sys; ds=[d for group in json.load(sys.stdin)["devices"].values() for d in group if d["name"].startswith("iPhone")]; ds.sort(key=lambda d:d["state"] != "Booted"); print(ds[0]["udid"] if ds else "")')}"
if [[ -z "$zimlo_simulator" ]]; then echo "No available iPhone simulator runtime. Install one in Xcode Settings > Components." >&2; exit 1; fi
xcodebuild test -project apps/ios/Zimlo.xcodeproj -scheme Zimlo \
  -destination "platform=iOS Simulator,id=$zimlo_simulator" \
  -derivedDataPath "${ZIMLO_IOS_DERIVED_DATA:-apps/ios/.build/DerivedData}" \
  CODE_SIGNING_ALLOWED=NO
