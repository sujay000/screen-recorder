// Checks that a recording bundle is complete and self-consistent. Used on CI after the scripted
// Windows recording, and locally against reference bundles.
// Usage: node scripts/validate-bundle.mjs <bundle> [--expect-clicks N] [--expect-min-seconds S] [--expect-min-moves M]

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const bundle = args[0];
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : null;
};
const rec = join(bundle, 'recording');
const problems = [];
const facts = {};
const check = (ok, msg) => ok || problems.push(msg);
const readJson = (rel) => JSON.parse(readFileSync(join(rec, rel), 'utf8'));

const meta = readJson('metadata.json');
const byType = (t) => meta.recorders.filter((r) => r.type === t);
const session = meta.sessions?.[0];
check(session && session.processTimeEndMs > session.processTimeStartMs, 'session has no positive duration');
const durationMs = session.processTimeEndMs - session.processTimeStartMs;
facts.durationS = +(durationMs / 1000).toFixed(2);

const input = byType('input')[0];
check(!!input, 'no input recorder');
const is = input.sessions[0];
const moves = readJson(is.mouseMovesFilename);
const clicks = readJson(is.mouseClicksFilename);
const keys = readJson(is.keyStrokesFilename);
facts.moves = moves.length;
facts.clicks = clicks.length;
facts.keys = keys.length;
for (const [name, list] of [['moves', moves], ['clicks', clicks], ['keys', keys]]) {
  let prev = -Infinity;
  for (const e of list) {
    check(e.processTimeMs >= prev, `${name} not in time order at ${e.processTimeMs}`);
    prev = e.processTimeMs;
    check(e.processTimeMs >= session.processTimeStartMs - 1 && e.processTimeMs <= session.processTimeEndMs + 1, `${name} event outside the session at ${e.processTimeMs}`);
  }
}
const downs = clicks.filter((c) => c.type === 'mouseDown').length;
const ups = clicks.filter((c) => c.type === 'mouseUp').length;
check(Math.abs(downs - ups) <= 1, `unbalanced clicks: ${downs} down, ${ups} up`);

const display = byType('display')[0]?.sessions?.[0];
check(!!display, 'no display recorder');
const b = display.bounds;
const inside = moves.filter((m) => m.x >= -1 && m.y >= -1 && m.x <= b.width + 1 && m.y <= b.height + 1).length;
facts.movesInsideDisplayPct = moves.length ? Math.round((inside / moves.length) * 100) : 100;

const cursors = readJson('cursors.json');
const ids = new Set(cursors.map((c) => c.id));
const used = new Set([...moves, ...clicks].map((e) => e.cursorId));
facts.cursorShapes = [...used];
for (const id of used) {
  check(ids.has(id), `cursor ${id} used but missing from cursors.json`);
  check(existsSync(join(rec, 'cursors', `${id}.png`)), `cursor image cursors/${id}.png missing`);
}

const videoFile = display.outputFilename;
check(existsSync(join(rec, videoFile)), `video ${videoFile} missing`);
try {
  const probeTarget = videoFile.endsWith('.m3u8') ? join(rec, videoFile) : join(rec, videoFile);
  const out = execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,nb_read_packets:format=duration', '-of', 'json', probeTarget], { encoding: 'utf8' });
  const j = JSON.parse(out);
  const s = j.streams[0];
  facts.video = { codec: s.codec_name, width: s.width, height: s.height, frames: Number(s.nb_read_packets), durationS: Number(j.format.duration) };
  check(facts.video.frames > 0, 'video has no frames');
  check(Math.abs(facts.video.durationS - durationMs / 1000) < 1.5, `video duration ${facts.video.durationS}s differs from session ${durationMs / 1000}s`);
} catch (e) {
  facts.video = `not probed (${e.code === 'ENOENT' ? 'ffprobe missing' : e.message.split('\n')[0]})`;
}

const expectClicks = opt('--expect-clicks');
if (expectClicks !== null) check(downs >= expectClicks, `expected at least ${expectClicks} mouseDown events, got ${downs}`);
const minMoves = opt('--expect-min-moves');
if (minMoves !== null) check(moves.length >= minMoves, `expected at least ${minMoves} mouse moves, got ${moves.length} (pointer moves not captured)`);
const minS = opt('--expect-min-seconds');
if (minS !== null) check(durationMs / 1000 >= minS, `expected at least ${minS}s, got ${durationMs / 1000}s`);

console.log(JSON.stringify({ bundle, ok: problems.length === 0, facts, problems }, null, 2));
process.exit(problems.length ? 1 : 0);
