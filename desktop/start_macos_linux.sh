#!/usr/bin/env bash
# Launcher for macOS and Linux. The first time it creates a private
# environment (.venv) and installs pyarrow; afterwards it opens the app directly.
cd "$(dirname "$0")" || exit 1

PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1 && \
     "$c" -c "import sys, tkinter; sys.exit(0 if sys.version_info >= (3, 9) else 1)" 2>/dev/null; then
    PY="$c"; break
  fi
done

if [ -z "$PY" ]; then
  echo "Python 3.9 or later with Tkinter is required."
  echo "  macOS:          install Python from https://www.python.org/downloads/ (includes Tkinter)"
  echo "                  or with Homebrew: brew install python python-tk"
  echo "  Ubuntu/Debian:  sudo apt install python3 python3-venv python3-tk"
  echo "  Fedora:         sudo dnf install python3 python3-tkinter"
  read -r -p "Press Enter to exit..." _
  exit 1
fi

if [ ! -f .venv/.ready ]; then
  echo "Setting up the app for the first time. This takes 1-2 minutes..."
  rm -rf .venv
  if ! "$PY" -m venv .venv; then
    echo "Could not create the environment (on Debian/Ubuntu: sudo apt install python3-venv)."
    read -r -p "Press Enter to exit..." _; exit 1
  fi
  .venv/bin/python -m pip install -q --upgrade pip --disable-pip-version-check
  if ! .venv/bin/python -m pip install -q --disable-pip-version-check "pyarrow>=14"; then
    echo "Could not install pyarrow. Check the internet connection or the proxy (see README.md)."
    read -r -p "Press Enter to exit..." _; exit 1
  fi
  .venv/bin/python -m pip install -q --disable-pip-version-check tkinterdnd2 \
    || echo "(Drag and drop not available; the app works anyway.)"
  touch .venv/.ready
fi

exec .venv/bin/python csv_to_parquet.py "$@"
