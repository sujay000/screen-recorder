import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { generateAutoZooms, mergeRanges } from '../../src/core/camera/zoom';
import { loadRecording } from '../../src/core/project/loader';
import { bundleReader } from '../../src/node/bundle';
import { referenceProjects, referenceZooms } from '../fixtures/reference';

describe('mergeRanges', () => {
  it('fuses adjacent and near ranges, end takes the later range end', () => {
    expect(mergeRanges([[1, 10], [11, 20], [3000, 4000]], 2500)).toEqual([[1, 20], [3000, 4000]]);
    expect(mergeRanges([[1, 100], [2600, 2700]], 2500)).toEqual([[1, 2700]]);
    expect(mergeRanges([[1, 100], [2601, 2700]], 2500)).toEqual([[1, 100], [2601, 2700]]);
  });
});

const projects = referenceProjects();
describe.skipIf(projects.length === 0)('auto zooms vs reference projects', () => {
  for (const p of projects) {
    it(`reproduces the saved zooms of ${path.basename(p)}`, () => {
      const rec = loadRecording(bundleReader(path.join(p, 'recording')));
      const ours = generateAutoZooms(rec).map((z) => [z.sourceStartMs, z.sourceEndMs, z.zoom]);
      const ref = referenceZooms(p).map((z) => [z.sourceStartMs, z.sourceEndMs, z.zoom]);
      expect(ours).toEqual(ref);
    });
  }
});
