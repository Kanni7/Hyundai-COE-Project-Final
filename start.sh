#!/usr/bin/env sh
# One-command start on Linux/macOS: sets up the backend venv and frontend build on first run,
# then serves the whole app at http://127.0.0.1:8000
#   ./start.sh [--rebuild] [port]
set -e
root="$(cd "$(dirname "$0")" && pwd)"
rebuild=0
[ "$1" = "--rebuild" ] && { rebuild=1; shift; }
port="${1:-8000}"
py="$root/backend/.venv/bin/python"

if [ ! -x "$py" ]; then
  echo "[setup] Creating backend virtual environment..."
  python3 -m venv "$root/backend/.venv"
  "$py" -m pip install --upgrade pip
  "$py" -m pip install -r "$root/backend/requirements-app.txt"
  "$py" -m pip install -e "$root/backend"
fi

model_needs_build=0
if [ ! -f "$root/frontend/dist/mediapipe/efficientdet_lite0.tflite" ] || [ "$root/frontend/public/mediapipe/efficientdet_lite0.tflite" -nt "$root/frontend/dist/mediapipe/efficientdet_lite0.tflite" ]; then
  model_needs_build=1
fi

if [ "$rebuild" = 1 ] || [ ! -f "$root/frontend/dist/index.html" ] || [ "$model_needs_build" = 1 ]; then
  echo "[setup] Building frontend..."
  (cd "$root/frontend" && { [ -d node_modules ] || npm install; } && npm run build)
fi

echo "[run] http://127.0.0.1:$port"
cd "$root/backend" && exec "$py" -m bhashadrive.cli serve --port "$port"
