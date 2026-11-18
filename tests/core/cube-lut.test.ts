import { describe, expect, it } from 'vitest';
import { parseCube } from '../../src/core/color/cube-lut';

describe('.cube LUT parser', () => {
  it('reads a 2x2x2 identity LUT with comments and a title', () => {
    const rows: string[] = [];
    for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) rows.push(`${r} ${g} ${b}`);
    const lut = parseCube(`# made by hand\nTITLE "id"\nLUT_3D_SIZE 2\n${rows.join('\n')}\n`);
    expect(lut.size).toBe(2);
    expect(Array.from(lut.data.slice(0, 6))).toEqual([0, 0, 0, 1, 0, 0]);
  });
  it('rejects a LUT with the wrong number of entries', () => {
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n')).toThrow(/should have 8 colour entries/);
  });
});
