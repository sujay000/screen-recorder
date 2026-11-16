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

  useEffect(() => {
    if (supported) void window.recorder.listDisplays().then(setDisplays);
  }, [supported]);

  const tryCapture = async (kind: AudioCapture['kind'], open: () => Promise<MediaStream>) => {
    try {
      const stream = await open();
      if (stream.getAudioTracks().length) captures.current.push(await startCapture(kind, stream));
    } catch (err) {
      onError(`${kind === 'microphone' ? 'Microphone' : 'System audio'} unavailable: ${(err as Error).message}`);
    }
  };

  const start = useCallback(async () => {
    setPhase('starting');
    const status = await window.recorder.startRecording({ displayId, microphone, systemAudio });
    if (status.state !== 'recording') {
      setPhase('idle');
      onError(status.message ?? 'Could not start recording');
      return;
    }
    if (microphone) await tryCapture('microphone', () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true } }));
    if (systemAudio) {
      // The main process answers this request with system loopback audio.
      await tryCapture('systemAudio', async () => {
        const s = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        s.getVideoTracks().forEach((t) => t.stop());
        return new MediaStream(s.getAudioTracks());
      });
    }
    setStartedAt(Date.now());
    setPhase('recording');
  }, [displayId, microphone, systemAudio]);

  const stop = useCallback(async () => {
    setPhase('stopping');
    const audio = await Promise.all(captures.current.map(async (c) => ({ c, r: await stopCapture(c) })));
    captures.current = [];
    const bundle = await window.recorder.stopRecording();
    if (!bundle) {
      setPhase('idle');
      onError('Recording failed');
      return;
    }
    for (const { c, r } of audio) {
      const name = c.kind === 'microphone' ? 'microphone-0.webm' : 'system-audio-0.webm';
      await window.recorder.saveAudioTrack(bundle, name, r.data, { kind: c.kind, unixStartMs: c.unixStartMs, durationMs: r.durationMs });
    }
    setPhase('idle');
    onRecorded(bundle);
  }, [onRecorded]);

  return { supported, displays, displayId, setDisplayId, microphone, setMicrophone, systemAudio, setSystemAudio, phase, startedAt, start, stop };
}
