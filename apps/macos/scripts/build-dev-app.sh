#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
ZIMLO_RELEASE=0 ZIMLO_SIGN_IDENTITY=- "${script_dir}/build-app.sh"
