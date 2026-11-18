#!/bin/sh
# Runs the in-app self-test: opens a recording, exports it, prints the result JSON.
# Usage: scripts/selftest.sh <bundle> <out.mp4|out.gif> [fps] [height]
# Exits 1 if the app reports a failure or gives no result within SELFTEST_TIMEOUT_S (default 600).
set -e
cd "$(dirname "$0")/.."
rm -f "$2.json"
# Build the job with node so Windows paths (backslashes) are escaped correctly.
job=$(node -e 'const [b, o, fps, h] = process.argv.slice(1); console.log(JSON.stringify({ bundle: b, out: o, fps: Number(fps), height: Number(h), format: o.endsWith(".gif") ? "gif" : "mp4" }))' "$1" "$2" "${3:-60}" "${4:-1080}")
RECORDER_SELFTEST="$job" npx electron . > "$2.log" 2>&1 &
pid=$!
i=0
while [ ! -f "$2.json" ] && kill -0 $pid 2>/dev/null && [ $i -lt "${SELFTEST_TIMEOUT_S:-600}" ]; do sleep 1; i=$((i+1)); done
kill $pid 2>/dev/null || true
if [ ! -f "$2.json" ]; then
  echo "NO RESULT (app exited or timed out after ${i}s). App log:"
  tail -30 "$2.log"
  exit 1
fi
cat "$2.json"
if ! node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).ok ? 0 : 1)' "$2.json"; then
  echo "App log:"
  tail -30 "$2.log"
  exit 1
fi
