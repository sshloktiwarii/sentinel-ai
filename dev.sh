#!/usr/bin/env bash
# dev.sh — start Sentinel-AI backend + Next.js frontend together
# Usage: ./dev.sh
# Press Ctrl-C (SIGINT) or send SIGTERM to stop both processes cleanly.

set -euo pipefail

BACKEND_PORT=8000

# ── Colour helpers ──────────────────────────────────────────────────────
_blue()  { printf '\033[0;34m%s\033[0m\n' "$*"; }
_green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
_red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }

# ── Cleanup on exit ─────────────────────────────────────────────────────
PIDS=()

cleanup() {
  _blue ""
  _blue "Shutting down…"
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  # Wait briefly so child processes can terminate cleanly
  sleep 0.5
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  _green "Done."
}

trap cleanup SIGINT SIGTERM EXIT

# ── Pre-flight checks ───────────────────────────────────────────────────
if ! command -v uvicorn &>/dev/null; then
  _red "Error: uvicorn not found. Install it with: pip install uvicorn"
  exit 1
fi

if ! command -v npm &>/dev/null; then
  _red "Error: npm not found. Install Node.js from https://nodejs.org"
  exit 1
fi

# ── Launch backend ───────────────────────────────────────────────────────
_blue "Starting Sentinel backend on port ${BACKEND_PORT}…"
uvicorn sentinel.server:app --port "$BACKEND_PORT" --reload &
PIDS+=($!)

# ── Launch frontend ──────────────────────────────────────────────────────
_blue "Starting Next.js dev server…"
npm --prefix web run dev &
PIDS+=($!)

_green "Both processes running. Press Ctrl-C to stop."

# ── Wait for either process to exit ─────────────────────────────────────
wait -n "${PIDS[@]}" 2>/dev/null || true
