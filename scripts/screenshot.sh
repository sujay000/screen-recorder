#!/bin/sh
# Opens a recording in the app and saves a screenshot of the window.
# Usage: scripts/screenshot.sh <bundle|""> <out.png> [seekMs]
cd "$(dirname "$0")/.."
rm -f "$2.json"
job=$(node -e 'const [b, o, seek] = process.argv.slice(1); console.log(JSON.stringify({ bundle: b, out: o, screenshot: o, seekMs: Number(seek) }))' "$1" "$2" "${3:-4500}")
RECORDER_SELFTEST="$job" npx electron . > "$2.log" 2>&1 &
pid=$!; i=0
while [ ! -f "$2.json" ] && kill -0 $pid 2>/dev/null && [ $i -lt 120 ]; do sleep 1; i=$((i+1)); done
kill $pid 2>/dev/null || true
cat "$2.json" 2>/dev/null || tail -20 "$2.log"
