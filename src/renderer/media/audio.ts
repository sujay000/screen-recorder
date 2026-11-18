// Audio: decodes the recorded microphone / system-audio files, mixes them onto the playback
// timeline and encodes AAC for export.

import type { MediaTrack, Project } from '../../core/project/model';
import type { TimeMap } from '../../core/project/timemap';

export const SAMPLE_RATE = 48000;

export interface AudioClip {
  buffer: AudioBuffer;
  startMs: number; // recording (source) time of the first sample
  gain: number;
}

// Unreadable tracks are skipped and described in `problems` so the caller can report them.
export async function loadAudioClips(mediaBase: string, project: Project, ctx: BaseAudioContext): Promise<{ clips: AudioClip[]; problems: string[] }> {
  const { recording, config } = project;
  const wanted: { track: MediaTrack; gain: number }[] = [
    ...(config.audio.muteMicrophone ? [] : recording.microphone.map((t) => ({ track: t, gain: config.audio.volume }))),
    ...(config.audio.muteSystemAudio ? [] : recording.systemAudio.map((t) => ({ track: t, gain: config.audio.volume }))),
  ];
  const clips: AudioClip[] = [];
  const problems: string[] = [];
  for (const { track, gain } of wanted) {
    // Prefer the single-file copy (.m4a / .webm); playlists are only a segmented duplicate.
    const name = track.file ?? track.playlist?.replace(/\.m3u8$/, '.m4a');
    if (!name) continue;
    try {
      const r = await fetch(mediaBase + encodeURIComponent(name));
      if (!r.ok) {
        problems.push(`Audio file ${name} could not be read (HTTP ${r.status}); it is left out.`);
        continue;
      }
      const bytes = await r.arrayBuffer();
      const buffer = await ctx.decodeAudioData(bytes);
      clips.push({ buffer, startMs: track.startOffsetMs, gain });
    } catch (err) {
      problems.push(`Audio file ${name} could not be decoded (${(err as Error).name}: ${(err as Error).message}); it is left out.`);
    }
  }
  return { clips, problems };
}

// One piece of a clip to play: the part of the clip inside one slice, placed on the playback
// timeline. Slices can cut, reorder and speed up the recording (speed changes pitch, like a
// tape played faster).
export interface ClipSegment {
  clip: AudioClip;
  whenS: number; // playback time where it starts
  offsetS: number; // position in the clip buffer
  durationS: number; // length in buffer time
  rate: number;
}

export function clipSegments(clips: AudioClip[], timeMap: TimeMap): ClipSegment[] {
  const out: ClipSegment[] = [];
  for (const link of timeMap.links) {
    for (const clip of clips) {
      const a = Math.max(link.sourceStartMs, clip.startMs);
      const b = Math.min(link.sourceEndMs, clip.startMs + clip.buffer.duration * 1000);
      if (b <= a) continue;
      out.push({ clip, whenS: link.sourceToPlayback(a) / 1000, offsetS: (a - clip.startMs) / 1000, durationS: (b - a) / 1000, rate: link.slice.timeScale });
    }
  }
  return out;
}

// Starts the segments on ctx, as if playback were at `fromS` when ctx.currentTime == `nowS`.
export function scheduleSegments(ctx: BaseAudioContext, segments: ClipSegment[], fromS: number, nowS: number, limitS = Infinity): AudioBufferSourceNode[] {
  const nodes: AudioBufferSourceNode[] = [];
  for (const seg of segments) {
    let when = seg.whenS - fromS;
    let offset = seg.offsetS;
    let duration = seg.durationS;
    if (when < 0) {
      offset -= when * seg.rate;
      duration += when * seg.rate;
      when = 0;
    }
    if (duration <= 0 || when >= limitS) continue;
    const src = ctx.createBufferSource();
    src.buffer = seg.clip.buffer;
    src.playbackRate.value = seg.rate;
    const g = ctx.createGain();
    g.gain.value = seg.clip.gain;
    src.connect(g).connect(ctx.destination);
    src.start(nowS + when, offset, duration);
    nodes.push(src);
  }
  return nodes;
}

const MIX_CHUNK_S = 30;

// Mixes the clips onto the playback timeline and feeds the encoder, 30 s at a time so memory
// stays flat for long recordings.
export async function encodeMix(clips: AudioClip[], timeMap: TimeMap, durationMs: number, encoder: AudioEncoder): Promise<void> {
  const total = durationMs / 1000;
  const segments = clipSegments(clips, timeMap);
  for (let start = 0; start < total; start += MIX_CHUNK_S) {
    const len = Math.min(MIX_CHUNK_S, total - start);
    const frames = Math.max(1, Math.ceil(len * SAMPLE_RATE));
    const ctx = new OfflineAudioContext(2, frames, SAMPLE_RATE);
    scheduleSegments(ctx, segments, start, 0, len);
    encodeAudioBuffer(await ctx.startRendering(), encoder, Math.round(start * SAMPLE_RATE));
  }
}

export async function pickAudioCodec(): Promise<AudioEncoderConfig | null> {
  const candidates: AudioEncoderConfig[] = [
    { codec: 'mp4a.40.2', sampleRate: SAMPLE_RATE, numberOfChannels: 2, bitrate: 192000 },
    { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 2, bitrate: 160000 },
  ];
  for (const c of candidates) {
    try {
      if ((await AudioEncoder.isConfigSupported(c)).supported) return c;
    } catch {
      // try the next codec
    }
  }
  return null;
}

// Feeds a mixed buffer to an AudioEncoder in 1024-frame chunks; firstFrame places it on the timeline.
function encodeAudioBuffer(buffer: AudioBuffer, encoder: AudioEncoder, firstFrame: number): void {
  const chunk = 1024;
  const ch = buffer.numberOfChannels;
  for (let start = 0; start < buffer.length; start += chunk) {
    const n = Math.min(chunk, buffer.length - start);
    const planar = new Float32Array(n * ch);
    for (let c = 0; c < ch; c++) planar.set(buffer.getChannelData(c).subarray(start, start + n), c * n);
    const data = new AudioData({ format: 'f32-planar', sampleRate: buffer.sampleRate, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round(((firstFrame + start) / buffer.sampleRate) * 1e6), data: planar });
    encoder.encode(data);
    data.close();
  }
}
