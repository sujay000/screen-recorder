// Adds audio tracks recorded by the renderer (microphone, system audio) to a bundle written by
// the native recorder. The track start is stored in the same process-time base as the video, so
// the loader can place it on the recording timeline.

import * as fs from 'node:fs';
import * as path from 'node:path';

interface Track {
  kind: 'microphone' | 'systemAudio';
  fileName: string;
  unixStartMs: number;
  durationMs: number;
}

interface MetaSession {
  processTimeStartMs: number;
  processTimeEndMs: number;
  unixStartMs?: number;
  outputFilename?: string;
  durationMs?: number;
}

interface Meta {
  recorders: { id: string; type: string; sessions?: MetaSession[] }[];
  sessions?: MetaSession[];
}

export function addAudioTrack(recordingDir: string, t: Track): void {
  const file = path.join(recordingDir, 'metadata.json');
  const meta = JSON.parse(fs.readFileSync(file, 'utf8')) as Meta;
  const base = meta.sessions?.[0];
  if (!base || base.unixStartMs === undefined) throw new Error('Recording metadata has no session start');
  const processTimeStartMs = base.processTimeStartMs + (t.unixStartMs - base.unixStartMs);
  meta.recorders = meta.recorders.filter((r) => r.type !== t.kind);
  meta.recorders.push({
    id: `channel-${meta.recorders.length}-${t.kind}`,
    type: t.kind,
    sessions: [
      {
        outputFilename: t.fileName,
        unixStartMs: t.unixStartMs,
        processTimeStartMs,
        processTimeEndMs: processTimeStartMs + t.durationMs,
        durationMs: t.durationMs,
      },
    ],
  });
  fs.writeFileSync(file, JSON.stringify(meta, null, 2));
}
