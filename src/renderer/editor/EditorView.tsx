// The editor screen: preview canvas, inspector and timeline.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { EditorController } from './editor-controller';
import { Inspector } from './Inspector';
import { Timeline } from './Timeline';

function Preview({ editor, selectedManualZoom }: { editor: EditorController; selectedManualZoom: string | null }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [cssSize, setCssSize] = useState({ w: 0, h: 0 });
  const stage = editor.scene.layout.stage;

  useEffect(() => {
    void editor.attachCanvas(canvas.current!);
    return () => editor.detachCanvas();
  }, [editor]);

  useEffect(() => {
    const fit = () => {
      const r = box.current!.getBoundingClientRect();
      const s = Math.min((r.width - 48) / stage.width, (r.height - 48) / stage.height);
      const w = Math.max(160, stage.width * s);
      setCssSize({ w, h: (w * stage.height) / stage.width });
      editor.resizeCanvas(w * devicePixelRatio);
    };
    const ro = new ResizeObserver(fit);
    ro.observe(box.current!);
    fit();
    return () => ro.disconnect();
  }, [editor, stage.width, stage.height]);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!selectedManualZoom) return;
    const r = e.currentTarget.getBoundingClientRect();
    editor.setManualTarget(selectedManualZoom, { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
  };

  return (
    <div className="preview" ref={box}>
      <canvas ref={canvas} className={selectedManualZoom ? 'targeting' : ''} style={{ width: cssSize.w, height: cssSize.h }} onClick={onClick} />
    </div>
  );
}

export function EditorView({ editor }: { editor: EditorController }) {
  // Re-render on any project edit.
  useSyncExternalStore(
    (l) => editor.subscribe(l),
    () => editor.version,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = editor.project.zooms.find((z) => z.id === selectedId) ?? null;
  const clipIndex = selectedId?.startsWith('clip:') ? Number(selectedId.slice(5)) : null;
  const selectedClip = clipIndex !== null && clipIndex < editor.project.slices.length ? clipIndex : null;

  return (
    <div className="editor">
      <Preview editor={editor} selectedManualZoom={selected?.type === 'manual' ? selected.id : null} />
      <Inspector editor={editor} selectedZoom={selected} selectedClip={selectedClip} onDeselect={() => setSelectedId(null)} />
      <Timeline editor={editor} selectedId={selectedId} onSelect={setSelectedId} />
    </div>
  );
}
