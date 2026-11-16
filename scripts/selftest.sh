#!/bin/sh
# Runs the in-app self-test: opens a recording, exports it, prints the result JSON.
# Usage: scripts/selftest.sh <bundle> <out.mp4> [fps] [height]
set -e
cd "$(dirname "$0")/.."
rm -f "$2.json"
RECORDER_SELFTEST="{\"bundle\":\"$1\",\"out\":\"$2\",\"fps\":${3:-60},\"height\":${4:-1080}}" npx electron . > "$2.log" 2>&1 &
pid=$!
i=0
while [ ! -f "$2.json" ] && kill -0 $pid 2>/dev/null && [ $i -lt 600 ]; do sleep 1; i=$((i+1)); done
kill $pid 2>/dev/null || true
if [ -f "$2.json" ]; then cat "$2.json"; else echo "NO RESULT"; tail -30 "$2.log"; fi
