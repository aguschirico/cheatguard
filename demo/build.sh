#!/usr/bin/env bash
# Regenerates every demo GIF/MP4 from the tapes (requires vhs: https://github.com/charmbracelet/vhs).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p site/assets
bash demo/setup.sh
for tape in demo/tapes/*.tape; do
  echo "recording $tape"
  vhs "$tape"
done
# Poster frames (last frame of each recording) for the landing page's <video> elements.
for mp4 in site/assets/demo-*.mp4; do
  ffmpeg -y -loglevel error -sseof -0.5 -i "$mp4" -frames:v 1 "${mp4%.mp4}.png"
done
