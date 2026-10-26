/**
 * MVIA · Cartografía procedural de Xalapa (fallback cuando no existe el bake OSM).
 *
 * Builds a convincing street network from the knowledge base in ./xalapa:
 *  1. arterial skeleton (MAIN_ROADS) and rivers, smoothed with Catmull–Rom and resampled;
 *  2. land-use polygons (parks, lakes, cemetery, industry, campuses, malls, farmland, ravine forest);
 *  3. per-colonia organic street grids: rotated per zone, bent with fbm, spacing driven by density,
 *     partitioned between neighbouring colonias (normalised-distance "power diagram"), clipped to a
 *     noisy zone edge and masked by water, protected land, large lots and steep slopes.
 * Fully deterministic (seeded rng + shared noise), ~100k road vertices, well under 300 ms.
 */
import type { Area, AreaKind, MapData, Road, RoadClass, Vec2, Waterway, Zone, ZoneKind } from '../core/types';
import { GRID, WORLD, fbm, lonLatToWorld, rng, slopeAt } from '../core/geo';
import { LANDMARKS, MAIN_ROADS, PROTECTED_AREAS, RIVERS, ZONES, blobPolygon } from './xalapa';

/** hard cap on total road vertices handed to the renderer */
const MAX_ROAD_VERTS = 118_000;
/** street sampling step along a local street (world units) */
const STREET_STEP = 2.25;
/** largest street reach (× zone radius) of any style — bounds the neighbour search */
const MAX_COVER = 1.9;

const ll = (lon: number, lat: number): Vec2 => lonLatToWorld(lon, lat);

// ───────────────────────────── geometry helpers ─────────────────────────────
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const inWorld = (x: number, z: number): boolean => x > WORLD.minX && x < WORLD.maxX && z > WORLD.minZ && z < WORLD.maxZ;

/** Uniform Catmull–Rom through the control points, resampled every ~`step` units (endpoints kept). */
function smoothPolyline(pts: Vec2[], step: number): Vec2[] {
  const n = pts.length;
  if (n < 2) return pts.slice();
  const out: Vec2[] = [{ x: pts[0].x, z: pts[0].z }];
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(n - 1, i + 2)];
    const steps = Math.max(1, Math.ceil(Math.hypot(p2.x - p1.x, p2.z - p1.z) / step));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      // P(t) = ½[2P1 + (P2−P0)t + (2P0−5P1+4P2−P3)t² + (−P0+3P1−3P2+P3)t³]
      out.push({
        x: 0.5 * (2 * p1.x + (p2.x - p0.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (3 * p1.x - p0.x - 3 * p2.x + p3.x) * t3),
        z: 0.5 * (2 * p1.z + (p2.z - p0.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (3 * p1.z - p0.z - 3 * p2.z + p3.z) * t3),
      });
    }
  }
  return out;
}

/** Splits a polyline into the runs that lie inside the world rectangle. */
function clipToWorld(pts: Vec2[]): Vec2[][] {
  const runs: Vec2[][] = [];
  let cur: Vec2[] = [];
  for (const p of pts) {
    if (inWorld(p.x, p.z)) cur.push(p);
    else if (cur.length) {
      if (cur.length > 1) runs.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) runs.push(cur);
  return runs;
}

function rectPolygon(c: Vec2, w: number, d: number, rotDeg: number): Vec2[] {
  const r = (rotDeg * Math.PI) / 180;
  const cr = Math.cos(r);
  const sr = Math.sin(r);
  const hw = w / 2;
  const hd = d / 2;
  return [
    [-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd],
  ].map(([lx, lz]) => ({ x: c.x + lx * cr - lz * sr, z: c.z + lx * sr + lz * cr }));
}

function pointInPolygon(x: number, z: number, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

// ───────────────────────────── street-blocking raster ─────────────────────────────
const MASK_RES = 2;
const MASK_COLS = Math.ceil((WORLD.maxX - WORLD.minX) / MASK_RES);
const MASK_ROWS = Math.ceil((WORLD.maxZ - WORLD.minZ) / MASK_RES);

/** 2-unit raster of places where local streets may not run (water, ANPs, parks, big lots, river banks). */
class BlockMask {
  readonly data = new Uint8Array(MASK_COLS * MASK_ROWS);

  blocked(x: number, z: number): boolean {
    const i = ((x - WORLD.minX) / MASK_RES) | 0;
    const j = ((z - WORLD.minZ) / MASK_RES) | 0;
    if (i < 0 || j < 0 || i >= MASK_COLS || j >= MASK_ROWS) return true;
    return this.data[j * MASK_COLS + i] !== 0;
  }

  fillPolygon(poly: Vec2[], pad = 0): void {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of poly) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    const i0 = Math.max(0, Math.floor((minX - pad - WORLD.minX) / MASK_RES));
    const i1 = Math.min(MASK_COLS - 1, Math.floor((maxX + pad - WORLD.minX) / MASK_RES));
    const j0 = Math.max(0, Math.floor((minZ - pad - WORLD.minZ) / MASK_RES));
    const j1 = Math.min(MASK_ROWS - 1, Math.floor((maxZ + pad - WORLD.minZ) / MASK_RES));
    for (let j = j0; j <= j1; j++) {
      const z = WORLD.minZ + (j + 0.5) * MASK_RES;
      for (let i = i0; i <= i1; i++) {
        const x = WORLD.minX + (i + 0.5) * MASK_RES;
        if (pointInPolygon(x, z, poly)) this.data[j * MASK_COLS + i] = 1;
      }
    }
  }

  /** marks a corridor of `radius` around a polyline (river banks) */
  stampPolyline(pts: Vec2[], radius: number): void {
    const rc = Math.ceil(radius / MASK_RES);
    const r2 = radius * radius;
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k];
      const b = pts[k + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.max(1, Math.ceil(len / MASK_RES));
      for (let s = 0; s <= n; s++) {
        const x = a.x + ((b.x - a.x) * s) / n;
        const z = a.z + ((b.z - a.z) * s) / n;
        const ci = Math.floor((x - WORLD.minX) / MASK_RES);
        const cj = Math.floor((z - WORLD.minZ) / MASK_RES);
        for (let dj = -rc; dj <= rc; dj++) {
          const j = cj + dj;
          if (j < 0 || j >= MASK_ROWS) continue;
          const cz = WORLD.minZ + (j + 0.5) * MASK_RES - z;
          for (let di = -rc; di <= rc; di++) {
            const i = ci + di;
            if (i < 0 || i >= MASK_COLS) continue;
            const cx = WORLD.minX + (i + 0.5) * MASK_RES - x;
            if (cx * cx + cz * cz <= r2) this.data[j * MASK_COLS + i] = 1;
          }
        }
      }
    }
  }
}

/** Lazily evaluated slope (degrees) per 100 m simulation cell — slopeAt is 4 elevation samples. */
class SlopeCache {
  private readonly data = new Float32Array(GRID.cols * GRID.rows).fill(-1);

  at(x: number, z: number): number {
    const i = Math.min(GRID.cols - 1, Math.max(0, Math.floor((x - GRID.minX) / GRID.cellSize)));
    const j = Math.min(GRID.rows - 1, Math.max(0, Math.floor((z - GRID.minZ) / GRID.cellSize)));
    const k = j * GRID.cols + i;
    let s = this.data[k];
    if (s < 0) {
      s = slopeAt(GRID.minX + (i + 0.5) * GRID.cellSize, GRID.minZ + (j + 0.5) * GRID.cellSize);
      this.data[k] = s;
    }
    return s;
  }
}

// ───────────────────────────── street styles per colonia type ─────────────────────────────
interface StreetStyle {
  /** streets reach beyond the nominal zone radius (× radius) so colonias tile the urban footprint */
  cover: number;
  /** amplitude of the shared domain warp that bends the whole grid coherently (world units) */
  warp: number;
  /** multiplier on the density-driven spacing (6–12 u) */
  spacingMul: number;
  /** cross-street spacing / main spacing (rectangular blocks) */
  ratio: number;
  /** lateral bend amplitude (world units) */
  amp: number;
  /** bend wavelength along the street (world units) */
  wave: number;
  /** probability a block-long segment is missing (cul-de-sacs, ravines, unbuilt lots) */
  drop: number;
  /** steepest buildable slope in degrees */
  maxSlope: number;
  /** every n-th street of the main family is a collector (tertiary) */
  collectorEvery: number;
  names: 'centro' | 'generic' | 'premium' | 'rural' | 'industrial';
}

const STYLES: Record<ZoneKind, StreetStyle> = {
  // terrain here is gentle (p99 ≈ 10°): maxSlope only trims the steepest ravine/cerro flanks
  centro: { cover: 1.85, warp: 1.5, spacingMul: 1, ratio: 1.15, amp: 1.4, wave: 45, drop: 0.03, maxSlope: 11, collectorEvery: 3, names: 'centro' },
  universitaria: { cover: 1.8, warp: 4, spacingMul: 1.1, ratio: 1.25, amp: 3, wave: 32, drop: 0.12, maxSlope: 9, collectorEvery: 3, names: 'generic' },
  comercial: { cover: 1.85, warp: 2.5, spacingMul: 1.1, ratio: 1.3, amp: 1.6, wave: 50, drop: 0.06, maxSlope: 9, collectorEvery: 3, names: 'generic' },
  premium: { cover: 1.8, warp: 6, spacingMul: 1.15, ratio: 1.7, amp: 5, wave: 30, drop: 0.18, maxSlope: 8.5, collectorEvery: 4, names: 'premium' },
  residencial: { cover: 1.85, warp: 4, spacingMul: 1, ratio: 1.35, amp: 2.2, wave: 40, drop: 0.07, maxSlope: 9.5, collectorEvery: 4, names: 'generic' },
  popular: { cover: 1.9, warp: 5, spacingMul: 0.95, ratio: 1.3, amp: 3, wave: 24, drop: 0.1, maxSlope: 11, collectorEvery: 5, names: 'generic' },
  industrial: { cover: 1.7, warp: 1.2, spacingMul: 1.3, ratio: 1.6, amp: 0.8, wave: 60, drop: 0.15, maxSlope: 7, collectorEvery: 2, names: 'industrial' },
  periferia: { cover: 1.5, warp: 5, spacingMul: 1, ratio: 2.2, amp: 3.2, wave: 34, drop: 0.3, maxSlope: 8.5, collectorEvery: 4, names: 'generic' },
  rural: { cover: 1.3, warp: 7, spacingMul: 1.2, ratio: 1.5, amp: 5, wave: 26, drop: 0.55, maxSlope: 9, collectorEvery: 3, names: 'rural' },
};

const CENTRO_NAMES = [
  'Enríquez', 'Zaragoza', 'Xalapeños Ilustres', 'Juárez', 'Úrsulo Galván', 'Clavijero', 'Dr. Lucio', 'Altamirano', 'Revolución',
  'Allende', 'Hidalgo', 'Bravo', 'Sebastián Camacho', 'Insurgentes', 'Guerrero', 'Victoria', 'Carrillo Puerto', 'Poeta Jesús Díaz',
  'Diego Leño', 'Morelos', 'Lerdo', 'Primo Verdad', 'Gutiérrez Zamora', 'Pino Suárez', 'Ignacio de la Llave', 'Leandro Valle',
  'Mariano Escobedo', 'Barragán', 'Azueta', 'Corregidora',
];
const GENERIC_NAMES = [
  'Hidalgo', 'Morelos', 'Allende', 'Aldama', 'Guerrero', 'Independencia', 'Reforma', 'Constitución', '5 de Mayo', '16 de Septiembre',
  'Benito Juárez', 'Emiliano Zapata', 'Francisco Villa', 'Venustiano Carranza', 'Cuauhtémoc', 'Netzahualcóyotl', 'Xicoténcatl',
  'Galeana', 'Mina', 'Matamoros', 'Abasolo', 'Ocampo', 'Las Flores', 'Los Pinos', 'Jazmín', 'Orquídea', 'Gardenia', 'Bugambilia',
  'Magnolia', 'Encino', 'Cedro', 'Fresno', 'Liquidámbar', 'Naranjo', 'Café', 'Cofre de Perote', 'Pico de Orizaba', 'Tajín',
  'Papantla', 'Tuxpan', 'Coatzacoalcos', 'Córdoba', 'Naolinco', 'Teocelo', 'Xico', 'Misantla', 'Actopan', 'Río Pánuco',
  'Río Papaloapan', 'Río Jamapa', 'Sor Juana', 'Amado Nervo', 'Díaz Mirón', 'Agustín Lara', 'Gabino Barreda', 'Justo Sierra',
];
const PREMIUM_NAMES = [
  'de las Ánimas', 'Los Robles', 'Jacarandas', 'Los Fresnos', 'Arboledas', 'Del Lago', 'Las Fuentes', 'Mirador', 'Bellavista',
  'Del Pedregal', 'Monte Blanco', 'Los Álamos', 'Bosques', 'Cumbres', 'Las Lomas', 'Real del Bosque',
];
const RURAL_NAMES = ['Los Potreros', 'El Ojo de Agua', 'La Ceiba', 'El Cafetal', 'La Loma', 'El Llano', 'Las Cruces', 'El Arenal', 'La Joya', 'El Carrizal'];
const INDUSTRIAL_NAMES = ['Industria', 'Logística', 'Comercio', 'Manufactura', 'Transportistas', 'Bodegas', 'Progreso'];

function streetName(style: StreetStyle, cls: RoadClass, r: () => number): string {
  const pick = <T>(arr: T[]): T => arr[Math.floor(r() * arr.length)];
  switch (style.names) {
    case 'centro':
      return `${cls === 'tertiary' ? 'Av.' : r() < 0.12 ? 'Callejón' : 'Calle'} ${pick(CENTRO_NAMES)}`;
    case 'premium':
      return `${cls === 'tertiary' ? 'Paseo' : pick(['Circuito', 'Privada', 'Cerrada', 'Calle'])} ${pick(PREMIUM_NAMES)}`;
    case 'rural':
      return `${cls === 'tertiary' ? 'Camino' : pick(['Camino', 'Vereda', 'Callejón'])} ${pick(RURAL_NAMES)}`;
    case 'industrial':
      return `${cls === 'tertiary' ? 'Av.' : 'Calle'} ${pick(INDUSTRIAL_NAMES)}`;
    default:
      return `${cls === 'tertiary' ? 'Av.' : r() < 0.1 ? 'Privada' : r() < 0.06 ? 'Andador' : 'Calle'} ${pick(GENERIC_NAMES)}`;
  }
}

// ───────────────────────────── land use ─────────────────────────────
interface LandUse {
  areas: Area[];
  /** areas that also block local streets */
  blocking: Vec2[][];
}

function buildLandUse(): LandUse {
  const areas: Area[] = [];
  const blocking: Vec2[][] = [];
  let n = 0;
  const add = (name: string, kind: AreaKind, polygon: Vec2[], blocks = true): void => {
    areas.push({ id: `pa${n++}`, name, kind, polygon });
    if (blocks) blocking.push(polygon);
  };
  const lm = (id: string): Vec2 => LANDMARKS.find((l) => l.id === id)?.pos ?? { x: 0, z: 0 };

  // plazas y parques históricos
  add('Parque Juárez', 'park', rectPolygon(lm('parque-juarez'), 8, 5.5, -6));
  add('Plaza Lerdo', 'park', rectPolygon(ll(-96.9226, 19.5284), 3.6, 2.8, -6));
  add('Parque Los Berros', 'park', blobPolygon(lm('los-berros'), 8, 5.5, 30, 10, 201));
  add('Parque de los Tecajetes', 'park', blobPolygon(ll(-96.9268, 19.5302), 4.5, 3.5, 10, 9, 202));
  add('Parque Juárez de Ánimas', 'park', blobPolygon(ll(-96.8905, 19.5170), 4, 3, 0, 9, 203));

  // Paseo de los Lagos: cadena de tres lagos a lo largo de la cañada (eje NO→SE)
  const lakeA = ll(-96.9203, 19.5260);
  const lakeB = ll(-96.9160, 19.5224);
  const lakeNames = ['Lago del Dique', 'Lago Central · Paseo de los Lagos', 'Lago Sur · Paseo de los Lagos'];
  for (let k = 0; k < 3; k++) {
    const t = k / 2;
    const c = { x: lakeA.x + (lakeB.x - lakeA.x) * t, z: lakeA.z + (lakeB.z - lakeA.z) * t };
    add(lakeNames[k], 'water', blobPolygon(c, 10 - k * 1.5, 3.8, 42, 12, 210 + k, 0.08));
  }
  add('Lago de Ánimas', 'water', blobPolygon(ll(-96.8935, 19.5145), 5, 3, 15, 10, 214, 0.1));
  add('Lago del Parque Natura', 'water', blobPolygon(ll(-96.8955, 19.5207), 4.5, 2.6, -10, 10, 215, 0.1));

  // equipamientos de gran lote
  add('Panteón Palo Verde', 'cemetery', rectPolygon(ll(-96.9015, 19.5330), 16, 11, 10));
  add('Zona Universitaria UV', 'university', rectPolygon(lm('rectoria-uv'), 14, 9, 40));
  add('Campus USBI · UV', 'university', rectPolygon(lm('usbi'), 13, 9, 15));
  add('Estadio Xalapeño', 'stadium', blobPolygon(lm('estadio'), 11, 8, 30, 14, 220, 0.02));
  add('Hospital Civil', 'hospital', rectPolygon(lm('hospital-civil'), 7, 6, 5));
  add('Torre Médica · IMSS', 'hospital', rectPolygon(lm('torre-medica'), 8, 7, 20));
  add('Plaza Américas', 'commercial', rectPolygon(lm('plaza-americas'), 16, 11, 14));
  add('Plaza Ánimas', 'commercial', rectPolygon(lm('plaza-animas'), 12, 9, 70));
  add('Plaza Crystal', 'commercial', rectPolygon(lm('plaza-crystal'), 12, 9, 25));
  add('Plaza Museo', 'commercial', rectPolygon(lm('plaza-museo'), 9, 7, 80));
  add('Central de Abastos', 'commercial', rectPolygon(lm('central-abastos'), 16, 10, 20));
  add('CAXA', 'commercial', rectPolygon(lm('caxa'), 11, 7, 22));
  add('Museo de Antropología', 'park', rectPolygon(lm('max'), 14, 10, 75));

  // industria sobre la carretera a Veracruz (sin bloqueo: tiene su propia retícula de naves)
  add('Zona Industrial Carretera Veracruz', 'industrial', blobPolygon(ll(-96.8690, 19.5040), 40, 17, 14, 12, 230, 0.08), false);
  add('Bodegas Las Trancas', 'industrial', blobPolygon(ll(-96.8535, 19.4995), 22, 13, 40, 10, 231, 0.08), false);

  // barrancas boscosas fuera de las ANP
  add('Barranca de Coapexpan', 'forest', blobPolygon(ll(-96.9800, 19.5200), 40, 26, 35, 12, 240));
  add('Bosque mesófilo de El Tronconal', 'forest', blobPolygon(ll(-96.9770, 19.5470), 44, 28, -20, 12, 241));
  add('Barranca del Río Sordo', 'forest', blobPolygon(ll(-96.9660, 19.4830), 50, 20, 25, 12, 242));
  add('Barranca del Sedeño', 'forest', blobPolygon(ll(-96.9050, 19.5690), 55, 9, -6, 12, 243, 0.1));

  // parcelas agrícolas / cafetales y parques vecinales derivados de cada colonia
  for (const z of ZONES) {
    const r = rng(hashStr(z.id) ^ 0x9e3779b9);
    if (z.kind === 'rural' || z.kind === 'periferia') {
      const crop = z.center.z > 250 ? 'Cafetales' : z.center.x > 300 ? 'Cañaverales' : 'Potreros';
      const count = z.kind === 'rural' ? 4 : 2;
      for (let k = 0; k < count; k++) {
        const a = r() * Math.PI * 2;
        const d = z.radius * (0.35 + r() * 0.75);
        const c = { x: z.center.x + Math.cos(a) * d, z: z.center.z + Math.sin(a) * d };
        if (!inWorld(c.x, c.z)) continue;
        add(`${crop} de ${z.name}`, 'farmland', blobPolygon(c, 12 + r() * 18, 8 + r() * 12, r() * 180, 10, hashStr(z.id) + k), false);
      }
    } else if ((z.kind === 'residencial' || z.kind === 'popular' || z.kind === 'premium') && r() < 0.6) {
      const c = { x: z.center.x + (r() - 0.5) * z.radius * 0.6, z: z.center.z + (r() - 0.5) * z.radius * 0.6 };
      const sport = z.kind === 'popular' && r() < 0.5;
      add(sport ? `Unidad Deportiva ${z.name}` : `Parque ${z.name}`, 'park', rectPolygon(c, 4 + r() * 3, 3 + r() * 2.5, r() * 90));
    }
  }
  return { areas, blocking };
}

// ───────────────────────────── local streets ─────────────────────────────
interface ZoneCtx {
  zone: Zone;
  k: number;
  invR2: number;
  neighbours: number[];
}

function buildZoneContexts(): ZoneCtx[] {
  const ctx: ZoneCtx[] = ZONES.map((zone, k) => ({ zone, k, invR2: 1 / (zone.radius * zone.radius), neighbours: [] }));
  for (const a of ctx) {
    for (const b of ctx) {
      if (a === b) continue;
      const d = Math.hypot(a.zone.center.x - b.zone.center.x, a.zone.center.z - b.zone.center.z);
      if (d < (a.zone.radius + b.zone.radius) * MAX_COVER * 1.25) a.neighbours.push(b.k);
    }
  }
  return ctx;
}

interface StreetEnv {
  ctx: ZoneCtx[];
  mask: BlockMask;
  slope: SlopeCache;
  roads: Road[];
  verts: number;
}

/** True when point (x,z) belongs to zone `zc`'s street territory and is buildable. */
function streetCell(env: StreetEnv, zc: ZoneCtx, style: StreetStyle, x: number, z: number): boolean {
  if (!inWorld(x, z)) return false;
  const c = zc.zone.center;
  const dx = x - c.x;
  const dz = z - c.z;
  const dk = (dx * dx + dz * dz) * zc.invR2; // squared normalised distance
  // noisy colonia edge: cover·(≈0.77‥1.05); 3-octave fbm has mean ≈ 0.4375
  const lim = style.cover * (0.91 + 1.1 * (fbm(x / 55 + zc.k * 5.3, z / 55 - zc.k * 2.1, 3) - 0.4375));
  if (dk > lim * lim) return false;
  // ownership: the neighbour with the smallest normalised distance draws here
  for (const j of zc.neighbours) {
    const o = env.ctx[j];
    const ex = x - o.zone.center.x;
    const ez = z - o.zone.center.z;
    if ((ex * ex + ez * ez) * o.invR2 < dk) return false;
  }
  if (env.mask.blocked(x, z)) return false;
  return env.slope.at(x, z) <= style.maxSlope;
}

function generateZoneStreets(env: StreetEnv, zc: ZoneCtx): void {
  const { zone } = zc;
  const style = STYLES[zone.kind];
  const r = rng(hashStr(zone.id));
  const reach = zone.radius * style.cover * 1.2;
  const reach2 = reach * reach;
  const spacing = (12 - 6 * zone.density) * style.spacingMul;
  const theta = r() * Math.PI;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const step = zone.kind === 'rural' ? STREET_STEP * 1.3 : STREET_STEP;

  for (let fam = 0; fam < 2; fam++) {
    const s = fam === 0 ? spacing : spacing * style.ratio; // spacing between lines of this family
    const blockLen = fam === 0 ? spacing * style.ratio : spacing; // distance between crossings along a line
    const seedA = r() * 100;
    const seedB = r() * 100;
    const phase = r() * s;
    let lineIdx = 0;
    for (let c = -reach + phase; c <= reach; c += s, lineIdx++) {
      const half = Math.sqrt(Math.max(0, reach2 - c * c));
      if (half < step * 2) continue;
      const cls: RoadClass = lineIdx % style.collectorEvery === 0 && zone.density > 0.25 ? 'tertiary' : 'residential';
      const name = streetName(style, cls, r);
      let run: Vec2[] = [];
      let block = Number.NaN;
      let dropped = false;
      const flush = (): void => {
        if (run.length >= 3 && env.verts + run.length <= MAX_ROAD_VERTS) {
          env.roads.push({ id: `${zone.id}-${fam}-${lineIdx}-${env.roads.length}`, name, cls, points: run });
          env.verts += run.length;
        }
        run = [];
      };
      for (let t = -half; t <= half; t += step) {
        // missing block segments → cul-de-sacs, ravines, unbuilt lots (collectors stay continuous)
        const b = Math.floor((t + reach) / blockLen);
        if (b !== block) {
          block = b;
          dropped = cls !== 'tertiary' && r() < style.drop;
        }
        // lateral bend: low-frequency fbm across lines (neighbours bend alike, never cross)
        const bend = style.amp * (fbm(c / 55 + seedA, t / style.wave + seedB, 2) - 0.375) * 2.6;
        const lu = fam === 0 ? c + bend : t;
        const lv = fam === 0 ? t : c + bend;
        let x = zone.center.x + lu * cos - lv * sin;
        let z = zone.center.z + lu * sin + lv * cos;
        // shared domain warp (same field for both families → intersections survive, the fabric bends as one)
        const wx = x / 80 + zc.k * 17.3;
        const wz = z / 80 - zc.k * 9.1;
        x += style.warp * (fbm(wx, wz, 2) - 0.375) * 2.6;
        z += style.warp * (fbm(wx + 31.7, wz + 47.1, 2) - 0.375) * 2.6;
        if (!dropped && streetCell(env, zc, style, x, z)) run.push({ x, z });
        else if (run.length) flush();
      }
      if (run.length) flush();
    }
  }
}

// ───────────────────────────── public entry ─────────────────────────────
export function generateProceduralMap(): Pick<MapData, 'roads' | 'waterways' | 'areas'> {
  // 1 · rivers (smoothed) — also carve a corridor in the street mask
  const waterways: Waterway[] = [];
  for (const w of RIVERS) {
    for (const [k, pts] of clipToWorld(smoothPolyline(w.points, 3)).entries()) {
      waterways.push({ id: k ? `${w.id}-${k}` : w.id, name: w.name, width: w.width, points: pts });
    }
  }

  // 2 · arterial skeleton
  const roads: Road[] = [];
  let verts = 0;
  for (const m of MAIN_ROADS) {
    for (const [k, pts] of clipToWorld(smoothPolyline(m.points, 3)).entries()) {
      roads.push({ id: k ? `${m.id}-${k}` : m.id, name: m.name, cls: m.cls, points: pts });
      verts += pts.length;
    }
  }
  // pedestrian lanes of the historic centre and the lake promenade
  const pedestrian = (id: string, name: string, pts: Vec2[]): void => {
    roads.push({ id, name, cls: 'pedestrian', points: pts });
    verts += pts.length;
  };
  pedestrian('ped-diamante', 'Callejón del Diamante', smoothPolyline([ll(-96.9212, 19.5281), ll(-96.9210, 19.5286), ll(-96.9208, 19.5292), ll(-96.9207, 19.5297)], 2));
  pedestrian('ped-ampare', 'Callejón Jesús te Ampare', smoothPolyline([ll(-96.9248, 19.5292), ll(-96.9244, 19.5297), ll(-96.9241, 19.5302)], 2));
  {
    // closed walking loop around the lake chain (ellipse along its 42° axis)
    const c = ll(-96.9182, 19.5242);
    const rot = (42 * Math.PI) / 180;
    const loop: Vec2[] = [];
    for (let k = 0; k <= 48; k++) {
      const a = (k / 48) * Math.PI * 2;
      const lx = Math.cos(a) * 33;
      const lz = Math.sin(a) * 8.5;
      loop.push({ x: c.x + lx * Math.cos(rot) - lz * Math.sin(rot), z: c.z + lx * Math.sin(rot) + lz * Math.cos(rot) });
    }
    pedestrian('ped-lagos', 'Paseo de los Lagos', loop);
  }

  // 3 · land use + street mask
  const land = buildLandUse();
  const mask = new BlockMask();
  for (const a of PROTECTED_AREAS) mask.fillPolygon(a.polygon);
  for (const poly of land.blocking) mask.fillPolygon(poly);
  for (const w of waterways) mask.stampPolyline(w.points, w.width * 0.5 + 1.4);

  // 4 · local streets, densest colonias first so the vertex budget always covers the core
  const env: StreetEnv = { ctx: buildZoneContexts(), mask, slope: new SlopeCache(), roads, verts };
  const order = env.ctx.slice().sort((a, b) => b.zone.density - a.zone.density);
  for (const zc of order) generateZoneStreets(env, zc);

  return { roads: env.roads, waterways, areas: land.areas };
}
