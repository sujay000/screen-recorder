// Export dialog: pick frame rate and resolution, then watch progress.

import { useRef, useState } from 'react';
import type { EditorController } from '../editor/editor-controller';
import { Button, Row, Segmented } from '../ui/controls';
import { Dialog, toast, toastError } from '../ui/overlay';

type Phase = { kind: 'settings' } | { kind: 'running'; frame: number; frames: number; startedAt: number } | { kind: 'done'; filePath: string; seconds: number };

export function ExportDialog({ editor, open, onClose }: { editor: EditorController; open: boolean; onClose: () => void }) {
  const [fps, setFps] = useState(60);
  const [height, setHeight] = useState(1080);
  const [phase, setPhase] = useState<Phase>({ kind: 'settings' });
  const abort = useRef<AbortController | null>(null);
  const stage = editor.scene.layout.stage;
  const width = Math.round((height * stage.width) / stage.height / 2) * 2;

  const close = () => {
    abort.current?.abort();
    setPhase({ kind: 'settings' });
    onClose();
  };

  const start = async () => {
    const filePath = await window.recorder.chooseExportPath(`${editor.project.name}.mp4`);
    if (!filePath) return;
    abort.current = new AbortController();
    const startedAt = performance.now();
    setPhase({ kind: 'running', frame: 0, frames: 1, startedAt });
    try {
      await editor.export({ fps, height, filePath }, (p) => setPhase({ kind: 'running', frame: p.frame, frames: p.frames, startedAt }), abort.current.signal);
      setPhase({ kind: 'done', filePath, seconds: (performance.now() - startedAt) / 1000 });
    } catch (err) {
      if ((err as Error).name === 'AbortError') toast('Export cancelled');
      else toastError('Export failed', err);
      setPhase({ kind: 'settings' });
    } finally {
      abort.current = null;
    }
  };

  const running = phase.kind === 'running';
  const pct = running ? (phase.frame / phase.frames) * 100 : phase.kind === 'done' ? 100 : 0;
  const eta = running && phase.frame > 10 ? ((performance.now() - phase.startedAt) / phase.frame) * (phase.frames - phase.frame) / 1000 : null;

  return (
    <Dialog open={open} onClose={close} title="Export video" dismissible={!running}>
      {phase.kind === 'settings' && (
        <>
          <Row label="Resolution" hint={`${width} × ${height}`}>
            <Segmented label="Resolution" value={height} onChange={setHeight} options={[720, 1080, 1440, 2160].map((h) => ({ value: h, label: h === 2160 ? '4K' : `${h}p` }))} />
          </Row>
          <Row label="Frame rate">
            <Segmented label="Frame rate" value={fps} onChange={setFps} options={[30, 60].map((f) => ({ value: f, label: `${f} fps` }))} />
          </Row>
          <div className="dialog-actions">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" onClick={start}>
              Export MP4
            </Button>
          </div>
        </>
      )}
      {phase.kind !== 'settings' && (
        <>
          <div className="progress">
            <div className="progress-fill" style={{ transform: `scaleX(${pct / 100})` }} />
          </div>
          <div className="progress-meta">
            {running ? (
              <>
                <span>{Math.floor(pct)}%</span>
                <span className="muted">{eta !== null ? `about ${Math.ceil(eta)} s left` : 'Preparing…'}</span>
              </>
            ) : (
              <>
                <span>Exported in {phase.kind === 'done' ? phase.seconds.toFixed(1) : ''} s</span>
              </>
            )}
          </div>
          <div className="dialog-actions">
            {running ? (
              <Button variant="ghost" onClick={() => abort.current?.abort()}>
                Cancel export
              </Button>
            ) : (
              <>
                <Button variant="ghost" onClick={close}>
                  Close
                </Button>
                <Button variant="primary" onClick={() => phase.kind === 'done' && window.recorder.revealFile(phase.filePath)}>
                  Show in folder
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </Dialog>
  );
}
