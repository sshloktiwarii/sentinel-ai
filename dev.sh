#!/usr/bin/env bash
set -e

cleanup() {
  echo ""
  echo "Shutting down Sentinel-AI..."
  kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID" 2>/dev/null || true
  wait "$FRONTEND_PID" 2>/dev/null || true
  echo "Done."
  exit 0
}

trap cleanup SIGINT SIGTERM EXIT

# 1. Start FastAPI Telemetry Daemon
source .venv/bin/activate
uvicorn sentinel.server:app --port 8000 &
BACKEND_PID=$!
echo "Started Sentinel daemon [PID: $BACKEND_PID] on port 8000"

# 2. Start Next.js Frontend
(cd web && npm run dev) &
FRONTEND_PID=$!
echo "Started Next.js frontend [PID: $FRONTEND_PID] on port 3000"

echo "Sentinel-AI active. Press Ctrl+C to terminate."
wait
