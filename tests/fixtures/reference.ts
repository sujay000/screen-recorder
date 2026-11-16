// Access to the reference projects recorded by Screen Studio on this Mac. Tests that need them
// are skipped when they are not present (for example on CI).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const REFERENCE_DIR = path.join(os.homedir(), 'Screen Studio Projects');

export function referenceProjects(): string[] {
  if (!fs.existsSync(REFERENCE_DIR)) return [];
  return fs
    .readdirSync(REFERENCE_DIR)
    .filter((n) => n.endsWith('.screenstudio'))
    .map((n) => path.join(REFERENCE_DIR, n))
    .filter((p) => fs.existsSync(path.join(p, 'project.json')));
}

export interface ReferenceZoom {
  sourceStartMs: number;
  sourceEndMs: number;
  zoom: number;
}

// Zoom ranges the reference app saved at project creation (before any user edit).
export function referenceZooms(bundle: string): ReferenceZoom[] {
  const j = JSON.parse(fs.readFileSync(path.join(bundle, 'project.json'), 'utf8'));
  return (j.json.scenes[0].zooms as ReferenceZoom[]).map((z) => ({ sourceStartMs: z.sourceStartMs, sourceEndMs: z.sourceEndMs, zoom: z.zoom }));
}
