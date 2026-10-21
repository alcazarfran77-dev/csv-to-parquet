#!/usr/bin/env bash
# Double-click in Finder to open the app (macOS).
cd "$(dirname "$0")" || exit 1
exec bash ./start_macos_linux.sh "$@"
