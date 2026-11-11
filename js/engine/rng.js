// Seeded PRNG (mulberry32) and a string-to-seed hash. No Math.random anywhere in the engine.

// 32-bit FNV-1a with a murmur3 finalizer. Same string, same seed, on every engine.
export function hashString(str) {
  const s = String(str);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

// Numbers are used as-is (as unsigned 32-bit); anything else is hashed as a string.
export function toSeed(seed) {
  if (typeof seed === 'number' && isFinite(seed)) return Math.floor(seed) >>> 0;
  return hashString(seed == null ? '' : String(seed));
}

export function mulberry32(seedInt) {
  let t = seedInt >>> 0;
  return function next() {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// makeRng(seed) -> function returning floats in [0, 1)
export function makeRng(seed) {
  return mulberry32(toSeed(seed));
}
