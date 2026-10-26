import type { GridSpec, Vec2 } from './types';

/** Simulation horizon */
export const YEAR_START = 2026;
export const YEAR_END = 2050;

/** Geographic origin (Xalapa centre) */
export const LAT0 = 19.5275;
export const LON0 = -96.92;
/** 1 world unit = 10 m */
export const UNIT_M = 10;
const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON = 111_320 * Math.cos((LAT0 * Math.PI) / 180);

/** World bounds (≈16.8 km × 14 km) */
export const WORLD = { minX: -840, maxX: 840, minZ: -700, maxZ: 700 } as const;
export const WORLD_W = WORLD.maxX - WORLD.minX;
export const WORLD_D = WORLD.maxZ - WORLD.minZ;

/** Lat/lon bbox matching WORLD (for satellite tiles etc.) */
export const BBOX = {
  west: LON0 + (WORLD.minX * UNIT_M) / M_PER_DEG_LON,
  east: LON0 + (WORLD.maxX * UNIT_M) / M_PER_DEG_LON,
  north: LAT0 - (WORLD.minZ * UNIT_M) / M_PER_DEG_LAT,
  south: LAT0 - (WORLD.maxZ * UNIT_M) / M_PER_DEG_LAT,
} as const;

/** Simulation grid: 100 m cells → 168 × 140 */
export const GRID: GridSpec = { cols: 168, rows: 140, cellSize: 10, minX: WORLD.minX, minZ: WORLD.minZ };

/** vertical exaggeration applied to terrain in world units */
export const TERRAIN_EXAGGERATION = 1.6;

export function lonLatToWorld(lon: number, lat: number): Vec2 {
  return {
    x: ((lon - LON0) * M_PER_DEG_LON) / UNIT_M,
    z: (-(lat - LAT0) * M_PER_DEG_LAT) / UNIT_M,
  };
}

export function worldToLonLat(x: number, z: number): { lon: number; lat: number } {
  return {
    lon: LON0 + (x * UNIT_M) / M_PER_DEG_LON,
    lat: LAT0 - (z * UNIT_M) / M_PER_DEG_LAT,
  };
}

export function inWorld(x: number, z: number): boolean {
  return x >= WORLD.minX && x <= WORLD.maxX && z >= WORLD.minZ && z <= WORLD.maxZ;
}

export function cellIndexAt(x: number, z: number, g: GridSpec = GRID): number {
  const i = Math.floor((x - g.minX) / g.cellSize);
  const j = Math.floor((z - g.minZ) / g.cellSize);
  if (i < 0 || j < 0 || i >= g.cols || j >= g.rows) return -1;
  return j * g.cols + i;
}

export function cellCenter(index: number, g: GridSpec = GRID): Vec2 {
  const i = index % g.cols;
  const j = Math.floor(index / g.cols);
  return { x: g.minX + (i + 0.5) * g.cellSize, z: g.minZ + (j + 0.5) * g.cellSize };
}

// ───────────── deterministic noise (shared so terrain, sim and world agree) ─────────────
function hash2(i: number, j: number): number {
  let h = (i * 374761393 + j * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

export function valueNoise(x: number, z: number): number {
  const i = Math.floor(x);
  const j = Math.floor(z);
  const fx = smooth(x - i);
  const fz = smooth(z - j);
  const a = hash2(i, j);
  const b = hash2(i + 1, j);
  const c = hash2(i, j + 1);
  const d = hash2(i + 1, j + 1);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

export function fbm(x: number, z: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * f, z * f);
    f *= 2.03;
    amp *= 0.5;
  }
  return sum; // ~0..1
}

/** Seeded PRNG (mulberry32) */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ───────────── terrain ─────────────
interface Hill { x: number; z: number; h: number; r: number }
/** metres of extra relief: Macuiltépetl, Cerro Colorado, Cerro de la Galaxia, Tejar ravine etc. */
const HILLS: Hill[] = [
  { ...lonLatToWorld(-96.9178, 19.5465), h: 150, r: 42 }, // Macuiltépetl (1590 m)
  { ...lonLatToWorld(-96.9505, 19.5165), h: 70, r: 70 }, // Cerro Colorado
  { ...lonLatToWorld(-96.8890, 19.5530), h: 55, r: 85 }, // lomas noreste
  { ...lonLatToWorld(-96.9800, 19.5600), h: 90, r: 120 }, // Banderilla / faldas Perote
  { ...lonLatToWorld(-96.9020, 19.4930), h: -45, r: 90 }, // barranca sur (Arroyo / Coapexpan)
  { ...lonLatToWorld(-96.9330, 19.5060), h: -30, r: 60 }, // Tejar Garnica
];

/** Real elevation in metres above sea level (≈1150–1650 m). */
export function elevationAt(x: number, z: number): number {
  // regional slope: higher toward NW (Perote), lower toward SE (Emiliano Zapata)
  let e = 1430 - x * 0.16 - z * 0.06;
  for (const hl of HILLS) {
    const dx = x - hl.x;
    const dz = z - hl.z;
    e += hl.h * Math.exp(-(dx * dx + dz * dz) / (2 * hl.r * hl.r));
  }
  e += (fbm(x / 140, z / 140, 4) - 0.5) * 70;
  e += (fbm(x / 35 + 11, z / 35 - 7, 3) - 0.5) * 14;
  return e;
}

/** Ground height in world units (exaggerated), 0 ≈ 1300 m. */
export function heightAt(x: number, z: number): number {
  return ((elevationAt(x, z) - 1300) / UNIT_M) * TERRAIN_EXAGGERATION;
}

/** slope in degrees from real elevation */
export function slopeAt(x: number, z: number): number {
  const d = 3;
  const gx = (elevationAt(x + d, z) - elevationAt(x - d, z)) / (2 * d * UNIT_M);
  const gz = (elevationAt(x, z + d) - elevationAt(x, z - d)) / (2 * d * UNIT_M);
  return (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
}

export const fmtMXN = (v: number): string =>
  v >= 1e9 ? `$${(v / 1e9).toFixed(2)} mmd` : v >= 1e6 ? `$${(v / 1e6).toFixed(2)} M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}k` : `$${v.toFixed(0)}`;
export const fmtPct = (v: number, d = 1): string => `${v.toFixed(d)}%`;
export const fmtInt = (v: number): string => Math.round(v).toLocaleString('es-MX');
