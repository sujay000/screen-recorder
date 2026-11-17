// Recording state for the Windows build. The native helper records screen, cursor and input;
// the page records microphone and system audio and attaches them when recording stops.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DisplayInfo } from '../../shared/ipc';

interface AudioCapture {
  kind: 'microphone' | 'systemAudio';
  recorder: MediaRecorder;
  chunks: Blob[];
  stream: MediaStream;
  unixStartMs: number;
}

const MIME = 'audio/webm;codecs=opus';

async function startCapture(kind: AudioCapture['kind'], stream: MediaStream): Promise<AudioCapture> {
  const recorder = new MediaRecorder(stream, { mimeType: MIME, audioBitsPerSecond: 160000 });
  const cap: AudioCapture = { kind, recorder, chunks: [], stream, unixStartMs: 0 };
  recorder.ondataavailable = (e) => e.data.size && cap.chunks.push(e.data);
  await new Promise<void>((resolve) => {
    recorder.onstart = () => {
      cap.unixStartMs = Date.now();
      resolve();
    };
    recorder.start(1000);
  });
  return cap;
}

async function stopCapture(cap: AudioCapture): Promise<{ data: ArrayBuffer; durationMs: number }> {
  const stoppedAt = await new Promise<number>((resolve) => {
    cap.recorder.onstop = () => resolve(Date.now());
    cap.recorder.stop();
  });
  cap.stream.getTracks().forEach((t) => t.stop());
  return { data: await new Blob(cap.chunks, { type: MIME }).arrayBuffer(), durationMs: stoppedAt - cap.unixStartMs };
}

export type RecorderPhase = 'idle' | 'starting' | 'recording' | 'stopping';

export function useRecorder(onRecorded: (bundlePath: string) => void, onError: (message: string) => void) {
  const supported = window.recorder.platform === 'win32';
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [displayId, setDisplayId] = useState('0');
  const [microphone, setMicrophone] = useState(true);
  const [systemAudio, setSystemAudio] = useState(true);
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [startedAt, setStartedAt] = useState(0);
  const captures = useRef<AudioCapture[]>([]);
  // Callbacks change identity every render; keep the latest without re-subscribing.
  const callbacks = useRef({ onRecorded, onError });
  callbacks.current = { onRecorded, onError };

  useEffect(() => {
    if (supported) void window.recorder.listDisplays().then(setDisplays);
  }, [supported]);

  // The native recorder can fail mid-recording; stop the audio captures and report it.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  useEffect(() => {
    if (!supported) return;
    return window.recorder.onRecorderStatus((s) => {
      if (s.state === 'idle' && s.message && phaseRef.current === 'recording') {
        for (const c of captures.current) {
          c.recorder.stop();
          c.stream.getTracks().forEach((t) => t.stop());
        }
        captures.current = [];
        setPhase('idle');
        callbacks.current.onError(s.message);
      }
    });
  }, [supported]);

  const tryCapture = async (kind: AudioCapture['kind'], open: () => Promise<MediaStream>) => {
    try {
      const stream = await open();
      if (stream.getAudioTracks().length) captures.current.push(await startCapture(kind, stream));
    } catch (err) {
      callbacks.current.onError(`${kind === 'microphone' ? 'Microphone' : 'System audio'} unavailable: ${(err as Error).message}`);
    }
  };

  const start = useCallback(async () => {
    setPhase('starting');
    const status = await window.recorder.startRecording({ displayId, microphone, systemAudio });
    if (status.state !== 'recording') {
      setPhase('idle');
      callbacks.current.onError(status.message ?? 'Could not start recording');
      return;
    }
    setStartedAt(Date.now());
    if (microphone) await tryCapture('microphone', () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true } }));
    if (systemAudio) {
      // The main process answers this request with system loopback audio.
      await tryCapture('systemAudio', async () => {
        const s = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        s.getVideoTracks().forEach((t) => t.stop());
        return new MediaStream(s.getAudioTracks());
      });
    }
    setPhase('recording');
  }, [displayId, microphone, systemAudio]);

  const stop = useCallback(async () => {
    setPhase('stopping');
    const audio = await Promise.all(captures.current.map(async (c) => ({ c, r: await stopCapture(c) })));
    captures.current = [];
    const result = await window.recorder.stopRecording();
    const bundle = result?.bundle ?? null;
    if (!bundle) {
      setPhase('idle');
      callbacks.current.onError(`Recording failed: ${result?.error ?? 'no recording was in progress'}`);
      return;
    }
    if (result?.error) callbacks.current.onError(`Recorder warning: ${result.error}`);
    for (const { c, r } of audio) {
      const name = c.kind === 'microphone' ? 'microphone-0.webm' : 'system-audio-0.webm';
      try {
        await window.recorder.saveAudioTrack(bundle, name, r.data, { kind: c.kind, unixStartMs: c.unixStartMs, durationMs: r.durationMs });
      } catch (err) {
        callbacks.current.onError(`Saving ${name} (${r.data.byteLength} bytes) failed: ${(err as Error).message}`);
      }
    }
    setPhase('idle');
    callbacks.current.onRecorded(bundle);
  }, []);

  return { supported, displays, displayId, setDisplayId, microphone, setMicrophone, systemAudio, setSystemAudio, phase, startedAt, start, stop };
}
