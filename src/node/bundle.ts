// Node-side access to a recording bundle on disk (used by the main process and the tests).

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BundleReader } from '../core/project/loader';
import { loadRecording } from '../core/project/loader';
import { defaultConfig, defaultSlices, type Project, type ProjectConfig, type Slice, type Zoom } from '../core/project/model';
import { generateAutoZooms } from '../core/camera/zoom';

export const EDITOR_FILE = 'recorder-project.json';

export function bundleReader(recordingDir: string): BundleReader {
  return {
    readJson<T>(rel: string): T | null {
      const p = path.join(recordingDir, rel);
      if (!fs.existsSync(p)) return null;
      return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
    },
  };
}

interface SavedEditorState {
  version: 1;
  config: ProjectConfig;
  zooms: Zoom[];
  slices: Slice[];
}

// Opens a bundle: <bundle>/recording/* plus our editor state. On first open the editor state is
// created with automatic zooms, exactly as the reference does at project creation.
export function openProject(bundlePath: string): Project {
  const recording = loadRecording(bundleReader(path.join(bundlePath, 'recording')));
  const statePath = path.join(bundlePath, EDITOR_FILE);
  const name = path.basename(bundlePath).replace(/\.(screenstudio|recording)$/, '');
  if (fs.existsSync(statePath)) {
    const s = JSON.parse(fs.readFileSync(statePath, 'utf8')) as SavedEditorState;
    return { path: bundlePath, name, recording, config: { ...defaultConfig(), ...s.config }, zooms: s.zooms, slices: s.slices };
  }
  return { path: bundlePath, name, recording, config: defaultConfig(), zooms: generateAutoZooms(recording), slices: defaultSlices(recording) };
}

export function saveProject(p: Project): void {
  const s: SavedEditorState = { version: 1, config: p.config, zooms: p.zooms, slices: p.slices };
  fs.writeFileSync(path.join(p.path, EDITOR_FILE), JSON.stringify(s, null, 2));
}

// Hover-change times computed by the reference app, if this bundle came from it. Stored per
// session in session time; mapped to recording time with each session's start offset.
export function readReferenceHoverTimes(bundlePath: string, sessionStartsMs: number[]): number[] {
  const dir = path.join(bundlePath, 'cache', 'cursor-hover_v3-all');
  if (!fs.existsSync(dir)) return [];
  const out: number[] = [];
  for (const f of fs.readdirSync(dir)) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { json: { sessionIndex: number; result: number[] }[] };
      for (const s of j.json) for (const ms of s.result) out.push(ms + (sessionStartsMs[s.sessionIndex] ?? 0));
    } catch {
      // An unreadable cache file only means no hover sync points.
    }
  }
  return out.sort((a, b) => a - b);
}
