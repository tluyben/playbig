#!/usr/bin/env bash
# install-chromium.sh
#
# Installs system-level dependencies (must be run as root / sudo) and then
# installs the Playwright-managed Chromium binary for the current user.
#
# Usage:
#   sudo bash scripts/install-chromium.sh          # system deps + chromium
#   bash scripts/install-chromium.sh --user-only   # only the chromium binary (already have deps)

set -euo pipefail

USER_ONLY=false
[[ "${1:-}" == "--user-only" ]] && USER_ONLY=true

# ── system dependencies ───────────────────────────────────────────────────────
if [[ "$USER_ONLY" == "false" ]]; then
  if [[ $EUID -ne 0 ]]; then
    echo "ERROR: system dependency install requires root (run with sudo)."
    exit 1
  fi

  echo "==> Installing system dependencies for Chromium…"

  if command -v apt-get &>/dev/null; then
    apt-get update -qq
    apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-liberation \
      libappindicator3-1 \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libatspi2.0-0 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libglib2.0-0 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libpangocairo-1.0-0 \
      libx11-6 \
      libx11-xcb1 \
      libxcb1 \
      libxcomposite1 \
      libxcursor1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxi6 \
      libxkbcommon0 \
      libxrandr2 \
      libxrender1 \
      libxss1 \
      libxtst6 \
      lsb-release \
      wget \
      xdg-utils
    echo "==> System dependencies installed."
  elif command -v yum &>/dev/null; then
    yum install -y \
      alsa-lib \
      atk \
      cups-libs \
      gtk3 \
      ipa-gothic-fonts \
      libXcomposite \
      libXcursor \
      libXdamage \
      libXext \
      libXi \
      libXrandr \
      libXScrnSaver \
      libXtst \
      pango \
      xorg-x11-fonts-100dpi \
      xorg-x11-fonts-75dpi \
      xorg-x11-fonts-cyrillic \
      xorg-x11-fonts-misc \
      xorg-x11-fonts-Type1 \
      xorg-x11-utils
    echo "==> System dependencies installed (yum)."
  else
    echo "WARNING: unknown package manager — skipping system deps."
    echo "         See https://playwright.dev/docs/browsers#install-system-dependencies"
  fi
fi

# ── Playwright Chromium binary ────────────────────────────────────────────────
echo "==> Installing Playwright Chromium binary (runs as current user: $(whoami))…"
cd "$(dirname "$0")/.."

if [[ ! -f package.json ]]; then
  echo "ERROR: run this script from the project root or via scripts/install-chromium.sh"
  exit 1
fi

npm install --ignore-scripts 2>/dev/null || true
npx playwright install chromium

echo ""
echo "==> Done. Chromium is ready."
echo "    Test with:  node -e \"require('playwright').chromium.launch().then(b => { console.log(b.version()); b.close(); })\""
