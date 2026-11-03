#!/usr/bin/env bash
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

# Ensure mise tool versions are loaded if available
if command -v mise >/dev/null 2>&1; then
    eval "$(mise env 2>/dev/null || true)"
fi

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8080}"

echo "=========================================================="
echo " Starting pdfun — Unlimited PDF Splitter & Tools"
echo " Host: http://${HOST}:${PORT}"
echo "=========================================================="

python3 -m uvicorn app.main:app --host "${HOST}" --port "${PORT}" --reload
