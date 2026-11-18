// Parser for .cube 3D colour LUTs (the Adobe/Resolve text format), used to grade the webcam.

export interface CubeLut {
  size: number; // entries per axis
  data: Float32Array; // size³ RGB triples, red changing fastest, values 0..1
}

export function parseCube(text: string): CubeLut {
  let size = 0;
  let min = [0, 0, 0];
  let max = [1, 1, 1];
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('TITLE')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'LUT_3D_SIZE') size = Number(parts[1]);
    else if (parts[0] === 'LUT_1D_SIZE') throw new Error('1D LUTs are not supported; use a 3D .cube LUT.');
    else if (parts[0] === 'DOMAIN_MIN') min = parts.slice(1, 4).map(Number);
    else if (parts[0] === 'DOMAIN_MAX') max = parts.slice(1, 4).map(Number);
    else if (/^[-+.\d]/.test(parts[0]) && parts.length >= 3) values.push(Number(parts[0]), Number(parts[1]), Number(parts[2]));
  }
  if (!(size >= 2 && size <= 256)) throw new Error(`The .cube file has no valid LUT_3D_SIZE (got ${size || 'none'}).`);
  if (values.length !== size * size * size * 3) throw new Error(`The .cube file should have ${size ** 3} colour entries for size ${size}, but has ${values.length / 3}.`);
  if (values.some((v) => !Number.isFinite(v))) throw new Error('The .cube file has entries that are not numbers.');
  const data = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const c = i % 3;
    data[i] = (values[i] - min[c]) / (max[c] - min[c] || 1);
  }
  return { size, data };
}
