// Screen video access. Loads the recorded track (an HLS playlist of fMP4 segments, or one mp4),
// demuxes it with mp4box and decodes with WebCodecs. Frame times are mapped to recording time:
// the first sample is the session start (recording-contract.md §2).

import { createFile, DataStream, type MP4ArrayBuffer, type MP4File, type MP4Sample, type MP4VideoTrack } from 'mp4box';
import type { MediaTrack } from '../../core/project/model';

export interface EncodedSample {
  timeMs: number; // recording time
  durationMs: number;
  isKey: boolean;
  data: Uint8Array;
}

export interface DemuxedVideo {
  config: VideoDecoderConfig;
  width: number;
  height: number;
  samples: EncodedSample[]; // decode order
  bytes: Uint8Array; // the whole (concatenated) file, for <video> playback
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Cannot read ${url}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

// HLS fMP4: init segment (#EXT-X-MAP) followed by the media segments, in playlist order.
async function loadTrackBytes(base: string, track: MediaTrack): Promise<Uint8Array> {
  if (track.file) return fetchBytes(base + encodeURIComponent(track.file));
  const text = new TextDecoder().decode(await fetchBytes(base + encodeURIComponent(track.playlist!)));
  const parts: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const map = /^#EXT-X-MAP:URI="([^"]+)"/.exec(line);
    if (map) parts.push(map[1]);
    else if (line && !line.startsWith('#')) parts.push(line.trim());
  }
  const chunks = await Promise.all(parts.map((p) => fetchBytes(base + encodeURIComponent(p))));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function codecDescription(file: MP4File, trackId: number): Uint8Array | undefined {
  const trak = file.getTrackById(trackId);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
    if (box) {
      const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8); // drop the box header
    }
  }
  return undefined;
}

export async function demuxVideo(base: string, track: MediaTrack): Promise<DemuxedVideo> {
  return demuxBytes(await loadTrackBytes(base, track), track.startOffsetMs);
}

// Demuxes an MP4 (plain or fragmented) held in memory; sample times start at startOffsetMs.
export function demuxBytes(bytes: Uint8Array, startOffsetMs: number): Promise<DemuxedVideo> {
  return new Promise((resolve, reject) => {
    const file = createFile();
    let info: MP4VideoTrack | null = null;
    const samples: MP4Sample[] = [];
    file.onError = (e: string) => reject(new Error(e));
    file.onReady = (i) => {
      info = i.videoTracks[0] ?? null;
      if (!info) {
        reject(new Error('The recording has no video track'));
        return;
      }
      file.setExtractionOptions(info.id, null, { nbSamples: Infinity });
      file.start();
    };
    file.onSamples = (_id, _user, s) => samples.push(...s);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as MP4ArrayBuffer;
    buf.fileStart = 0;
    file.appendBuffer(buf);
    file.flush();
    if (!info) {
      reject(new Error('Unreadable video file'));
      return;
    }
    const v = info as MP4VideoTrack;
    const first = samples.reduce((m, s) => Math.min(m, s.cts), Infinity);
    resolve({
      config: { codec: v.codec, codedWidth: v.video.width, codedHeight: v.video.height, description: codecDescription(file, v.id) },
      width: v.video.width,
      height: v.video.height,
      samples: samples.map((s) => ({
        timeMs: ((s.cts - first) / s.timescale) * 1000 + startOffsetMs,
        durationMs: (s.duration / s.timescale) * 1000,
        isKey: s.is_sync,
        data: s.data,
      })),
      bytes,
    });
  });
}

function keyframeIndexAtOrBefore(samples: EncodedSample[], t: number): number {
  let idx = 0;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].isKey && samples[i].timeMs <= t) idx = i;
    if (samples[i].timeMs > t && samples[i].isKey) break;
  }
  return idx;
}

// Decodes frames in presentation order for a forward pass (export). frameAt(t) returns the
// newest frame with time <= t; the screen video has a variable frame rate, so a frame stays on
// screen until the next one arrives.
export class SequentialFrames {
  private decoder: VideoDecoder;
  private queue: { timeMs: number; frame: VideoFrame }[] = [];
  private current: { timeMs: number; frame: VideoFrame } | null = null;
  private next = 0;
  private error: Error | null = null;
  private readonly order: EncodedSample[];

  // startAtMs: begin decoding at the last keyframe at or before this time (for seeking).
  constructor(
    private readonly video: DemuxedVideo,
    startAtMs = 0,
  ) {
    this.order = video.samples;
    this.next = keyframeIndexAtOrBefore(video.samples, startAtMs);
    this.decoder = new VideoDecoder({
      output: (frame) => this.queue.push({ timeMs: frame.timestamp / 1000, frame }),
      error: (e) => (this.error = e instanceof Error ? e : new Error(String(e))),
    });
    this.decoder.configure(video.config);
  }

  private feed(count: number): void {
    for (let i = 0; i < count && this.next < this.order.length; i++, this.next++) {
      const s = this.order[this.next];
      this.decoder.decode(new EncodedVideoChunk({ type: s.isKey ? 'key' : 'delta', timestamp: Math.round(s.timeMs * 1000), duration: Math.round(s.durationMs * 1000), data: s.data }));
    }
  }

  async frameAt(timeMs: number): Promise<VideoFrame | null> {
    for (;;) {
      if (this.error) throw this.error;
      this.queue.sort((a, b) => a.timeMs - b.timeMs);
      while (this.queue.length && this.queue[0].timeMs <= timeMs + 0.5) {
        this.current?.frame.close();
        this.current = this.queue.shift()!;
      }
      const haveFuture = this.queue.length > 0;
      const exhausted = this.next >= this.order.length;
      if (haveFuture || (exhausted && this.decoder.decodeQueueSize === 0)) break;
      if (exhausted) {
        await this.decoder.flush();
        continue;
      }
      this.feed(8);
      await new Promise((r) => setTimeout(r, 0));
    }
    return this.current?.frame ?? null;
  }

  close(): void {
    this.current?.frame.close();
    for (const q of this.queue) q.frame.close();
    this.queue = [];
    if (this.decoder.state !== 'closed') this.decoder.close();
  }
}
