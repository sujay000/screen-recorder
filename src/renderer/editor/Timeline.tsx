// Timeline: transport, ruler with scrubbing, the clip lane and the zoom lane. Zoom blocks can be
// selected, moved and resized from either edge. Zoom times are source times; with one untrimmed
// clip they equal playback times.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { makeZoom } from '../../core/camera/zoom';
import type { Zoom } from '../../core/project/model';
import { Button, Kbd } from '../ui/controls';
import { PauseIcon, PlayIcon, PlusIcon, ZoomIcon } from '../ui/icons';
import { formatTime } from '../util';
import type { EditorController } from './editor-controller';

const MIN_ZOOM_MS = 100;
const NEW_ZOOM_MS = 3000;

function niceStep(durationMs: number, widthPx: number): number {
  const target = (durationMs / Math.max(1, widthPx)) * 110;
  for (const s of [500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000]) if (s >= target) return s;
  return 600000;
}

export function Timeline({ editor, selectedId, onSelect }: { editor: EditorController; selectedId: string | null; onSelect: (id: string | null) => void }) {
  const playback = useSyncExternalStore(
    (l) => editor.subscribePlayback(l),
    () => editor.playback,
  );
  const lanes = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const duration = editor.durationMs;
  const zooms = editor.project.zooms;

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    if (lanes.current) ro.observe(lanes.current);
    return () => ro.disconnect();
  }, []);

  const x = (ms: number) => (ms / duration) * width;
  const msAt = (clientX: number) => {
    const r = lanes.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration));
  };

  const ticks = useMemo(() => {
    const step = niceStep(duration, width);
    const out: number[] = [];
    for (let t = 0; t <= duration; t += step) out.push(t);
    return out;
  }, [duration, width]);

  const scrub = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.zoom-block')) return;
    onSelect(null);
    editor.seek(msAt(e.clientX));
    const move = (ev: PointerEvent) => editor.seek(msAt(ev.clientX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const addZoom = () => {
    const t = playback.timeMs;
    if (zooms.some((z) => t >= z.sourceStartMs && t <= z.sourceEndMs)) return;
    const next = zooms.filter((z) => z.sourceStartMs > t).sort((a, b) => a.sourceStartMs - b.sourceStartMs)[0];
    const end = Math.min(t + NEW_ZOOM_MS, next ? next.sourceStartMs - 1 : duration);
    if (end - t < MIN_ZOOM_MS) return;
    const z = makeZoom(Math.round(t), Math.round(end));
    editor.setZooms([...zooms, z].sort((a, b) => a.sourceStartMs - b.sourceStartMs));
    onSelect(z.id);
  };

  const drag = (e: React.PointerEvent, z0: Zoom, mode: 'left' | 'right' | 'move') => {
    e.stopPropagation();
    onSelect(z0.id);
    const startX = e.clientX;
    const others = zooms.filter((o) => o.id !== z0.id);
    const lo = Math.max(0, ...others.filter((o) => o.sourceEndMs <= z0.sourceStartMs).map((o) => o.sourceEndMs + 1));
    const hi = Math.min(duration, ...others.filter((o) => o.sourceStartMs >= z0.sourceEndMs).map((o) => o.sourceStartMs - 1));
    const len = z0.sourceEndMs - z0.sourceStartMs;
    const apply = (ev: PointerEvent, final: boolean) => {
      const d = ((ev.clientX - startX) / width) * duration;
      let s = z0.sourceStartMs;
      let en = z0.sourceEndMs;
      if (mode === 'left') s = Math.min(en - MIN_ZOOM_MS, Math.max(lo, s + d));
      else if (mode === 'right') en = Math.max(s + MIN_ZOOM_MS, Math.min(hi, en + d));
      else {
        s = Math.min(hi - len, Math.max(lo, s + d));
        en = s + len;
      }
      editor.setZooms(
        editor.project.zooms.map((q) => (q.id === z0.id ? { ...q, sourceStartMs: Math.round(s), sourceEndMs: Math.round(en) } : q)),
        final,
      );
    };
    const move = (ev: PointerEvent) => apply(ev, false);
    const up = (ev: PointerEvent) => {
      apply(ev, true);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, [role="slider"]')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        editor.togglePlay();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        editor.deleteZoom(selectedId);
        onSelect(null);
      } else if (e.key.toLowerCase() === 'z' && !e.metaKey && !e.ctrlKey) {
        addZoom();
      } else if (e.key === 'Escape') {
        onSelect(null);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        editor.seek(playback.timeMs + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1000 : 1000 / 60));
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  return (
    <section className="timeline">
      <div className="transport">
        <button className="play-button" onClick={() => editor.togglePlay()} aria-label={playback.playing ? 'Pause' : 'Play'}>
          {playback.playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
        </button>
        <div className="timecode">
          <span>{formatTime(playback.timeMs, 2)}</span>
          <span className="muted"> / {formatTime(duration, 2)}</span>
        </div>
        <div className="spacer" />
        <span className="hint">
          <Kbd>Space</Kbd> play <Kbd>Z</Kbd> add zoom <Kbd>⌫</Kbd> delete
        </span>
        <Button size="sm" icon={<PlusIcon />} onClick={addZoom}>
          Zoom
        </Button>
      </div>
      <div className="lanes" ref={lanes} onPointerDown={scrub}>
        <div className="ruler">
          {ticks.map((t) => (
            <span key={t} style={{ left: x(t) }}>
              {formatTime(t, 0)}
            </span>
          ))}
        </div>
        <div className="lane lane-clip">
          <div className="clip" style={{ width: x(duration) }}>
            <span>Recording</span>
            <span className="muted">{formatTime(duration, 1)}</span>
          </div>
        </div>
        <div className="lane lane-zoom">
          {zooms.length === 0 && <span className="lane-empty">No zooms — press Z to add one</span>}
          {zooms.map((z) => (
            <div
              key={z.id}
              className={`zoom-block ${z.type === 'manual' ? 'manual' : ''} ${z.isDisabled ? 'disabled' : ''} ${z.id === selectedId ? 'selected' : ''}`}
              style={{ left: x(z.sourceStartMs), width: Math.max(8, x(z.sourceEndMs) - x(z.sourceStartMs)) }}
              onPointerDown={(e) => drag(e, z, 'move')}
            >
              <div className="handle left" onPointerDown={(e) => drag(e, z, 'left')} />
              <ZoomIcon size={13} />
              <span>{z.zoom.toFixed(1)}×</span>
              <div className="handle right" onPointerDown={(e) => drag(e, z, 'right')} />
            </div>
          ))}
        </div>
        <div className="playhead" style={{ transform: `translateX(${x(playback.timeMs)}px)` }}>
          <div className="playhead-knob" />
        </div>
      </div>
    </section>
  );
}
