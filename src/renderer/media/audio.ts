// Audio: decodes the recorded microphone / system-audio files, mixes them onto the playback
// timeline and encodes AAC for export.

import type { MediaTrack, Project } from '../../core/project/model';

export const SAMPLE_RATE = 48000;

export interface AudioClip {
  buffer: AudioBuffer;
  startMs: number; // playback time of the first sample
  gain: number;
}

export async function loadAudioClips(mediaBase: string, project: Project, ctx: BaseAudioContext): Promise<AudioClip[]> {
  const { recording, config } = project;
  const wanted: { track: MediaTrack; gain: number }[] = [
    ...(config.audio.muteMicrophone ? [] : recording.microphone.map((t) => ({ track: t, gain: config.audio.volume }))),
    ...(config.audio.muteSystemAudio ? [] : recording.systemAudio.map((t) => ({ track: t, gain: config.audio.volume }))),
  ];
  const clips: AudioClip[] = [];
  for (const { track, gain } of wanted) {
    // Prefer the single-file copy (.m4a / .webm); playlists are only a segmented duplicate.
    const name = track.file ?? track.playlist?.replace(/\.m3u8$/, '.m4a');
    if (!name) continue;
    try {
      const r = await fetch(mediaBase + encodeURIComponent(name));
      if (!r.ok) continue;
      const buffer = await ctx.decodeAudioData(await r.arrayBuffer());
      clips.push({ buffer, startMs: track.startOffsetMs, gain });
    } catch (err) {
      console.warn(`Skipping unreadable audio track ${name}`, err);
    }
  }
  return clips;
}

// Mixes clips into one stereo buffer covering [0, durationMs).
export async function mixClips(clips: AudioClip[], durationMs: number): Promise<AudioBuffer | null> {
  if (clips.length === 0) return null;
  const frames = Math.max(1, Math.ceil((durationMs / 1000) * SAMPLE_RATE));
  const ctx = new OfflineAudioContext(2, frames, SAMPLE_RATE);
  for (const c of clips) {
    const src = ctx.createBufferSource();
    src.buffer = c.buffer;
    const g = ctx.createGain();
    g.gain.value = c.gain;
    src.connect(g).connect(ctx.destination);
    const when = c.startMs / 1000;
    if (when >= 0) src.start(when);
    else src.start(0, -when);
  }
  return ctx.startRendering();
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

// Feeds a mixed buffer to an AudioEncoder in 1024-frame chunks.
export function encodeAudioBuffer(buffer: AudioBuffer, encoder: AudioEncoder): void {
  const chunk = 1024;
  const ch = buffer.numberOfChannels;
  for (let start = 0; start < buffer.length; start += chunk) {
    const n = Math.min(chunk, buffer.length - start);
    const planar = new Float32Array(n * ch);
    for (let c = 0; c < ch; c++) planar.set(buffer.getChannelData(c).subarray(start, start + n), c * n);
    const data = new AudioData({ format: 'f32-planar', sampleRate: buffer.sampleRate, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round((start / buffer.sampleRate) * 1e6), data: planar });
    encoder.encode(data);
    data.close();
  }
}
