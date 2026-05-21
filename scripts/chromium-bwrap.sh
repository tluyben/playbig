#!/usr/bin/env bash
# Per-session bwrap wrapper for the Chromium browser binary.
#
# Each playbig session creates a private writable directory under
# /tmp/playbig-sessions/<uuid> and points Playwright's executablePath
# at this wrapper. The wrapper re-execs Chromium under bwrap with:
#
#   --unshare-user / pid / ipc / uts / cgroup-try   fresh namespaces
#   --uid 1000                                       stay non-root
#                                                     (Chromium refuses
#                                                     its sandbox at uid 0)
#   --ro-bind / /                                    host fs read-only
#   --proc /proc                                     fresh procfs
#   --dev /dev                                       minimal device tree
#   --tmpfs /tmp                                     ephemeral /tmp
#   --tmpfs /dev/shm                                 ephemeral shm (Chromium
#                                                     uses this for renderer
#                                                     IPC)
#   --bind <session-dir>                             writable per-session dir
#   --die-with-parent                                clean up if playbig exits
#
# Required env (set by playbig before launching):
#   CHROMIUM_REAL_BIN              absolute path to chrome-headless-shell
#   PLAYBIG_BWRAP_SESSION_DIR      per-session writable dir, already mkdir'd
#
# Combined with Chromium's own sandbox (renderer seccomp, nested user-ns)
# this gives:
#   - bwrap-outside  : fs/pid/ipc/uts/cgroup isolation per session
#   - chromium-inside: renderer seccomp BPF + own user-ns + no-new-privs
# i.e. defense in depth — a renderer-escape buys you only the session's
# bwrap'd view of the world.

set -euo pipefail

if [ -z "${CHROMIUM_REAL_BIN:-}" ]; then
  echo "chromium-bwrap.sh: CHROMIUM_REAL_BIN not set" >&2
  exit 1
fi
if [ -z "${PLAYBIG_BWRAP_SESSION_DIR:-}" ]; then
  echo "chromium-bwrap.sh: PLAYBIG_BWRAP_SESSION_DIR not set" >&2
  exit 1
fi

# Resolve PATH for tools the wrapper itself needs (bwrap, runuser, etc.).
# Inside the sandbox the same PATH is preserved via --setenv.
PATH="${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"

# Use the (already root-readable) parent dir of CHROMIUM_REAL_BIN so
# Chromium's resource files (locales, snapshots, etc.) are reachable.
# --ro-bind / / already covers them; this is defensive in case someone
# tightens the bind set later.

exec bwrap \
  --unshare-user \
  --unshare-pid \
  --unshare-ipc \
  --unshare-uts \
  --unshare-cgroup-try \
  --uid 1000 \
  --gid 1000 \
  --ro-bind / / \
  --proc /proc \
  --dev /dev \
  --tmpfs /tmp \
  --tmpfs /dev/shm \
  --bind "$PLAYBIG_BWRAP_SESSION_DIR" "$PLAYBIG_BWRAP_SESSION_DIR" \
  --die-with-parent \
  --setenv HOME /tmp \
  --setenv PATH "$PATH" \
  -- "$CHROMIUM_REAL_BIN" "$@"
