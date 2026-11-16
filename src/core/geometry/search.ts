// Binary searches with the reference semantics.

// Index of the first element whose key equals v, else the last element with key < v, else null.
// With duplicate keys equal to v this returns the FIRST of them (lower bound), not the last.
export function indexAtOrBefore<T>(list: readonly T[], v: number, key: (x: T, i: number) => number): number | null {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(list[mid], mid) < v) lo = mid + 1;
    else hi = mid;
  }
  if (lo < list.length && key(list[lo], lo) === v) return lo;
  if (lo > 0) return lo - 1;
  return null;
}

export function atOrBefore<T>(list: readonly T[], v: number, key: (x: T, i: number) => number): T | null {
  const i = indexAtOrBefore(list, v, key);
  return i === null ? null : list[i];
}

// Index of the first element with key >= v, else null.
export function indexAtOrAfter<T>(list: readonly T[], v: number, key: (x: T, i: number) => number): number | null {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(list[mid], mid) >= v) hi = mid;
    else lo = mid + 1;
  }
  return lo < list.length ? lo : null;
}

export function atOrAfter<T>(list: readonly T[], v: number, key: (x: T, i: number) => number): T | null {
  const i = indexAtOrAfter(list, v, key);
  return i === null ? null : list[i];
}

// Elements with a <= key <= b (inclusive), in order.
export function sliceBetween<T>(list: readonly T[], a: number, b: number, key: (x: T, i: number) => number): T[] {
  if (list.length === 0 || a > b) return [];
  const s = indexAtOrAfter(list, a, key);
  if (s === null) return [];
  let lo = s;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(list[mid], mid) <= b) lo = mid + 1;
    else hi = mid;
  }
  return lo === s ? [] : list.slice(s, lo);
}
