#!/bin/bash
# Quick launch for TOKENICODE (Tauri 2 dev build) on macOS.
# Double-click this file in Finder to compile & open the app.
#
# Mirrors start.bat: prepends tool dirs to PATH (the double-click shell's PATH
# is often stale), loads fnm-managed Node, and runs from the script's own
# directory so it works from any cwd.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Homebrew (pnpm, fnm) + rustup (cargo) live outside the login PATH.
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"

# fnm-managed Node: pnpm needs `node` on PATH.
if command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env --shell bash)"
fi

command -v node  >/dev/null 2>&1 || { echo "ERROR: node not found (install via fnm/nvm)"; exit 1; }
command -v pnpm  >/dev/null 2>&1 || { echo "ERROR: pnpm not found"; exit 1; }
command -v cargo >/dev/null 2>&1 || { echo "ERROR: cargo not found (install Rust via rustup)"; exit 1; }

echo "Starting TOKENICODE (first build is slow, later launches are fast)..."
exec pnpm tauri dev
