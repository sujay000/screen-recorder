// App shell: top bar, welcome screen or editor, export dialog and toasts.

import { useCallback, useEffect, useState } from 'react';
import type { OpenedProject } from '../shared/ipc';
import { EditorController } from './editor/editor-controller';
import { EditorView } from './editor/EditorView';
import { ExportDialog } from './export/ExportDialog';
import { Compositor } from './gpu/compositor';
import { useRecorder } from './recording/use-recorder';
import { Button, Row, Switch } from './ui/controls';
import { ExportIcon, FolderIcon, LogoMark, RecordIcon, StopIcon } from './ui/icons';
import { Toaster, toast } from './ui/overlay';
import { formatTime } from './util';

let compositorPromise: Promise<Compositor> | null = null;
const getCompositor = () => (compositorPromise ??= Compositor.create());

// Opening is also used by the self-test harness, so it is exposed outside React.
export const appActions: { open?: (o: OpenedProject) => Promise<EditorController> } = {};

function RecordingTimer({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  return <span className="rec-timer">{formatTime(now - since, 0)}</span>;
}

export function App() {
  const [editor, setEditor] = useState<EditorController | null>(null);
  const [loading, setLoading] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  const open = useCallback(async (opened: OpenedProject) => {
    setLoading(true);
    try {
      const next = await EditorController.open(opened, await getCompositor());
      setEditor((prev) => {
        prev?.destroy();
        return next;
      });
      document.title = `${opened.project.name} — Recorder`;
      return next;
    } finally {
      setLoading(false);
    }
  }, []);
  appActions.open = open;

  const openDialog = async () => {
    try {
      const o = await window.recorder.openProjectDialog();
      if (o) await open(o);
    } catch (err) {
      toast('Could not open recording', { tone: 'error', description: (err as Error).message });
    }
  };

  const recorder = useRecorder(
    async (bundle) => {
      toast('Recording saved', { tone: 'success' });
      await open(await window.recorder.openProject(bundle));
    },
    (message) => toast(message, { tone: 'error' }),
  );

  const recordControl = recorder.supported ? (
    recorder.phase === 'recording' || recorder.phase === 'stopping' ? (
      <Button variant="record" className="recording" icon={<StopIcon size={14} />} onClick={recorder.stop} disabled={recorder.phase === 'stopping'}>
        <RecordingTimer since={recorder.startedAt} />
      </Button>
    ) : (
      <Button variant="record" icon={<RecordIcon size={14} />} onClick={recorder.start} disabled={recorder.phase === 'starting'}>
        Record
      </Button>
    )
  ) : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <LogoMark />
          <span className="app-name">{editor ? editor.project.name : 'Recorder'}</span>
        </div>
        <div className="topbar-right">
          <Button variant="ghost" icon={<FolderIcon />} onClick={openDialog}>
            Open
          </Button>
          {recordControl}
          <Button variant="primary" icon={<ExportIcon />} disabled={!editor} onClick={() => setExportOpen(true)}>
            Export
          </Button>
        </div>
      </header>

      {editor ? <EditorView key={editor.opened.project.path} editor={editor} /> : <Welcome loading={loading} onOpen={openDialog} recorder={recorder} />}

      {editor && <ExportDialog editor={editor} open={exportOpen} onClose={() => setExportOpen(false)} />}
      <Toaster />
    </div>
  );
}

function Welcome({ loading, onOpen, recorder }: { loading: boolean; onOpen: () => void; recorder: ReturnType<typeof useRecorder> }) {
  return (
    <main className="welcome">
      <div className="welcome-card">
        <LogoMark size={44} />
        <h1>Make your screen recordings look great</h1>
        <p className="muted">Record your screen, and get smooth zooms that follow your clicks, a polished cursor and a beautiful background automatically.</p>
        <div className="welcome-actions">
          {recorder.supported && (
            <div className="record-setup">
              <select value={recorder.displayId} onChange={(e) => recorder.setDisplayId(e.target.value)} aria-label="Display to record">
                {recorder.displays.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <Row label="Microphone">
                <Switch label="Microphone" checked={recorder.microphone} onChange={recorder.setMicrophone} />
              </Row>
              <Row label="System audio">
                <Switch label="System audio" checked={recorder.systemAudio} onChange={recorder.setSystemAudio} />
              </Row>
              <Button variant="record" size="lg" icon={<RecordIcon size={16} />} onClick={recorder.start} disabled={recorder.phase !== 'idle'}>
                Start recording
              </Button>
            </div>
          )}
          <Button size="lg" variant={recorder.supported ? 'default' : 'primary'} icon={<FolderIcon />} onClick={onOpen} disabled={loading}>
            {loading ? 'Opening…' : 'Open a recording'}
          </Button>
        </div>
        {!recorder.supported && <p className="muted small">Recording runs in the Windows app. Here you can edit and export existing recordings.</p>}
      </div>
    </main>
  );
}
