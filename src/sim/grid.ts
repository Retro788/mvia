/**
 * Static raster of Xalapa on the 168×140 simulation grid (100 m cells = 1 ha each).
 * Everything here is scenario- and year-independent and is computed once at init:
 * zones, terrain, protected/water masks, road rasterisation, distance fields, flood risk,
 * accessibility/amenity multipliers, the 2026 urban footprint and the static commercial supply.
 */
import type { IncomeLevel, LandmarkKind, MapData, RoadClass, Vec2, Zone } from '../core/types';
import { GRID, elevationAt, fbm, slopeAt } from '../core/geo';
import { GROWTH_FRONTS } from '../data/xalapa';
import { buildSAT, boxCount, boxSum, clamp, clamp01, distanceTransform, smoothstep } from './util';

export interface GrowthFront {
  id: string;
  name: string;
  pos: Vec2;
  strength: number;
}

/** contribution of each road class to "local street length" (urban fabric signal) */
const LOCAL_W: Record<RoadClass, number> = {
  motorway: 0.1, trunk: 0.2, primary: 0.45, secondary: 0.65, tertiary: 1, residential: 1, pedestrian: 0.6,
};
const MAIN_ROAD: Record<RoadClass, boolean> = {
  motorway: true, trunk: true, primary: true, secondary: true, tertiary: false, residential: false, pedestrian: false,
};
export const INCOME_RISK: Record<IncomeLevel, number> = { bajo: 1, 'medio-bajo': 0.75, medio: 0.5, 'medio-alto': 0.28, alto: 0.12 };

/** landmark amenity premium (fraction of land value at distance 0) */
const AMENITY: Partial<Record<LandmarkKind, number>> = {
  parque: 0.1, plaza: 0.08, lago: 0.1, catedral: 0.06, museo: 0.06, teatro: 0.05, universidad: 0.06,
  centroComercial: 0.07, hospital: 0.04, mercado: 0.03, estadio: 0.02, gobierno: 0.04, cerro: 0.03, terminal: -0.02,
};
const JOB_LANDMARK = new Set<LandmarkKind>(['gobierno', 'universidad', 'hospital', 'mercado', 'centroComercial', 'terminal', 'plaza', 'catedral']);
/** persons served by existing commercial anchors (before global calibration) */
const SUPPLY_LANDMARK: Partial<Record<LandmarkKind, number>> = { mercado: 30000, centroComercial: 80000, plaza: 6000, terminal: 3000 };

export const POP_2026 = 790_000;

export class CityGrid {
  readonly cols = GRID.cols;
  readonly rows = GRID.rows;
  readonly n = GRID.cols * GRID.rows;
  readonly cs = GRID.cellSize;
  readonly minX = GRID.minX;
  readonly minZ = GRID.minZ;

  readonly cx: Float32Array;
  readonly cz: Float32Array;
  readonly zones: Zone[];
  /** nearest zone by d/radius (always set, even for rural cells) */
  readonly zoneIdx: Int16Array;
  readonly zoneScore: Float32Array;
  readonly rural: Uint8Array;
  readonly growthZone: Uint8Array;
  /** Gaussian-blended zone attributes so prices do not jump at zone borders */
  readonly basePrice: Float32Array;
  readonly zoneDensity: Float32Array;
  readonly zoneFlood: Float32Array;
  readonly incomeRisk: Float32Array;
  readonly floorsMid: Float32Array;

  readonly elevation: Float32Array;
  readonly slope: Float32Array;
  readonly protectedMask: Uint8Array;
  readonly water: Uint8Array;
  /** park / forest / farmland (green land that sprawl consumes) */
  readonly green: Uint8Array;
  readonly commercialArea: Uint8Array;

  /** weighted local street length per cell (world units) */
  readonly roadLen: Float32Array;
  readonly mainDist: Float32Array;
  readonly roadDist: Float32Array;
  readonly waterDist: Float32Array;
  readonly jobsDist: Float32Array;
  readonly parkDist: Float32Array;

  readonly flood: Float32Array;
  readonly access: Float32Array;
  readonly amenity: Float32Array;
  readonly frontAttr: Float32Array;
  readonly frontIdx: Int16Array;
  readonly frontDist: Float32Array;
  readonly fronts: GrowthFront[];

  /** 2026 built density 0..1 (0 = not urban) */
  readonly urban0: Float32Array;
  /** approximate year each 2026-urban cell was first built (≤ 2026) */
  readonly yearBuilt0: Float32Array;
  urbanCount0 = 0;
  /** 2026 land price as urban land (MXN/m²) */
  readonly urbanBase: Float32Array;
  /** persons served by existing retail (calibrated to ~80% of 2026 demand) */
  readonly supplyStatic: Float32Array;

  constructor(readonly map: MapData) {
    const n = this.n;
    const F = () => new Float32Array(n);
    const U = () => new Uint8Array(n);
    this.cx = F(); this.cz = F();
    this.zones = map.zones;
    this.zoneIdx = new Int16Array(n); this.zoneScore = F(); this.rural = U(); this.growthZone = U();
    this.basePrice = F(); this.zoneDensity = F(); this.zoneFlood = F(); this.incomeRisk = F(); this.floorsMid = F();
    this.elevation = F(); this.slope = F();
    this.protectedMask = U(); this.water = U(); this.green = U(); this.commercialArea = U();
    this.roadLen = F(); this.mainDist = F(); this.roadDist = F(); this.waterDist = F(); this.jobsDist = F(); this.parkDist = F();
    this.flood = F(); this.access = F(); this.amenity = F(); this.frontAttr = F();
    this.frontIdx = new Int16Array(n); this.frontDist = F();
    this.urban0 = F(); this.yearBuilt0 = F(); this.urbanBase = F(); this.supplyStatic = F();
    this.fronts = this.resolveFronts();

    for (let k = 0; k < n; k++) {
      const i = k % this.cols;
      const j = (k - i) / this.cols;
      this.cx[k] = this.minX + (i + 0.5) * this.cs;
      this.cz[k] = this.minZ + (j + 0.5) * this.cs;
    }
    this.buildZones();
    this.buildTerrain();
    const masks = this.buildAreas();
    this.buildRoads();
    this.buildDistances(masks.park, masks.jobs);
    this.buildFlood();
    this.buildAmenity();
    this.buildFronts();
    this.buildFootprint();
    this.buildPrices();
    this.buildSupply();
  }

  index(i: number, j: number): number {
    return j * this.cols + i;
  }

  cellAt(x: number, z: number): number {
    const i = Math.floor((x - this.minX) / this.cs);
    const j = Math.floor((z - this.minZ) / this.cs);
    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) return -1;
    return j * this.cols + i;
  }

  // ───────────────────────────── builders ─────────────────────────────

  private resolveFronts(): GrowthFront[] {
    const src = (GROWTH_FRONTS ?? []) as ReadonlyArray<GrowthFront>;
    if (src.length) return src.map((f) => ({ id: f.id, name: f.name, pos: { x: f.pos.x, z: f.pos.z }, strength: f.strength ?? 0.6 }));
    // fallback: zones flagged as growth fronts
    return this.map.zones
      .filter((z) => z.growthFront)
      .map((z) => ({ id: z.id, name: z.name, pos: { ...z.center }, strength: 0.7 }));
  }

  private buildZones(): void {
    const zones = this.zones;
    const Z = zones.length;
    for (let k = 0; k < this.n; k++) {
      const x = this.cx[k];
      const z = this.cz[k];
      let best = -1;
      let bestS = Infinity;
      let sw = 0, sp = 0, sd = 0, sf = 0, si = 0, sfl = 0;
      for (let q = 0; q < Z; q++) {
        const zn = zones[q];
        const s = Math.hypot(x - zn.center.x, z - zn.center.z) / Math.max(1, zn.radius);
        if (s < bestS) {
          bestS = s;
          best = q;
        }
        if (s < 3) {
          // Gaussian blend weight in normalised zone distance
          const w = Math.exp(-1.6 * s * s);
          sw += w;
          sp += w * zn.basePriceM2;
          sd += w * zn.density;
          sf += w * zn.floodRisk;
          si += w * INCOME_RISK[zn.income];
          sfl += w * (zn.floors[0] + zn.floors[1]) * 0.5;
        }
      }
      this.zoneIdx[k] = best;
      this.zoneScore[k] = bestS;
      this.rural[k] = bestS > 1.35 ? 1 : 0;
      this.growthZone[k] = best >= 0 && zones[best].growthFront && bestS < 1.4 ? 1 : 0;
      const nz = best >= 0 ? zones[best] : null;
      if (sw > 1e-4) {
        this.basePrice[k] = sp / sw;
        this.zoneDensity[k] = sd / sw;
        this.zoneFlood[k] = sf / sw;
        this.incomeRisk[k] = si / sw;
        this.floorsMid[k] = sfl / sw;
      } else {
        this.basePrice[k] = nz ? nz.basePriceM2 * 0.6 : 1500;
        this.zoneDensity[k] = 0;
        this.zoneFlood[k] = nz ? nz.floodRisk : 0.2;
        this.incomeRisk[k] = nz ? INCOME_RISK[nz.income] : 0.8;
        this.floorsMid[k] = 1.5;
      }
    }
  }

  private buildTerrain(): void {
    for (let k = 0; k < this.n; k++) {
      this.elevation[k] = elevationAt(this.cx[k], this.cz[k]);
      this.slope[k] = slopeAt(this.cx[k], this.cz[k]);
    }
  }

  /** scanline polygon fill: calls fn for every cell whose centre lies inside the polygon */
  private fillPolygon(poly: Vec2[], fn: (k: number) => void): number {
    if (poly.length < 3) return 0;
    let minZ = Infinity, maxZ = -Infinity;
    for (const p of poly) {
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    const j0 = Math.max(0, Math.floor((minZ - this.minZ) / this.cs));
    const j1 = Math.min(this.rows - 1, Math.floor((maxZ - this.minZ) / this.cs));
    const xs: number[] = [];
    let filled = 0;
    for (let j = j0; j <= j1; j++) {
      const zc = this.minZ + (j + 0.5) * this.cs;
      xs.length = 0;
      for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
        const pa = poly[a];
        const pb = poly[b];
        if (pa.z <= zc !== pb.z <= zc) xs.push(pa.x + ((zc - pa.z) * (pb.x - pa.x)) / (pb.z - pa.z));
      }
      xs.sort((u, v) => u - v);
      for (let p = 0; p + 1 < xs.length; p += 2) {
        // cell centre x = minX + (i+0.5)cs inside [xa, xb]
        const i0 = Math.max(0, Math.ceil((xs[p] - this.minX) / this.cs - 0.5));
        const i1 = Math.min(this.cols - 1, Math.floor((xs[p + 1] - this.minX) / this.cs - 0.5));
        for (let i = i0; i <= i1; i++) {
          fn(j * this.cols + i);
          filled++;
        }
      }
    }
    return filled;
  }

  private buildAreas(): { park: Uint8Array; jobs: Uint8Array } {
    const park = new Uint8Array(this.n);
    const jobs = new Uint8Array(this.n);
    for (const a of this.map.areas) {
      let fn: ((k: number) => void) | null = null;
      switch (a.kind) {
        case 'protected':
        case 'forest':
          fn = (k) => { this.protectedMask[k] = 1; this.green[k] = 1; park[k] = 1; };
          break;
        case 'water':
          fn = (k) => { this.water[k] = 1; };
          break;
        case 'park':
          fn = (k) => { park[k] = 1; this.green[k] = 1; };
          break;
        case 'farmland':
          fn = (k) => { this.green[k] = 1; };
          break;
        case 'commercial':
          fn = (k) => { this.commercialArea[k] = 1; jobs[k] = 1; };
          break;
        case 'industrial':
        case 'university':
        case 'hospital':
          fn = (k) => { jobs[k] = 1; };
          break;
        default:
          break;
      }
      if (!fn) continue;
      const filled = this.fillPolygon(a.polygon, fn);
      // tiny polygons (smaller than a cell): mark the centroid cell for point-like features
      if (!filled && a.kind !== 'water' && a.polygon.length) {
        let sx = 0, sz = 0;
        for (const p of a.polygon) { sx += p.x; sz += p.z; }
        const k = this.cellAt(sx / a.polygon.length, sz / a.polygon.length);
        if (k >= 0 && (a.kind === 'park' || a.kind === 'commercial' || a.kind === 'university' || a.kind === 'hospital' || a.kind === 'industrial')) fn(k);
      }
    }
    for (const l of this.map.landmarks) {
      const k = this.cellAt(l.pos.x, l.pos.z);
      if (k < 0) continue;
      if (l.kind === 'lago') this.water[k] = 1;
      if (JOB_LANDMARK.has(l.kind)) jobs[k] = 1;
    }
    for (const zn of this.zones) {
      if (zn.kind !== 'centro' && zn.kind !== 'comercial' && zn.kind !== 'industrial' && zn.kind !== 'universitaria') continue;
      const k = this.cellAt(zn.center.x, zn.center.z);
      if (k >= 0) jobs[k] = 1;
    }
    return { park, jobs };
  }

  private buildRoads(): void {
    const main = new Uint8Array(this.n);
    const any = new Uint8Array(this.n);
    for (const r of this.map.roads) {
      const w = LOCAL_W[r.cls] ?? 1;
      const isMain = MAIN_ROAD[r.cls] ?? false;
      const pts = r.points;
      for (let p = 1; p < pts.length; p++) {
        const a = pts[p - 1];
        const b = pts[p];
        const L = Math.hypot(b.x - a.x, b.z - a.z);
        if (L <= 0) continue;
        const steps = Math.max(1, Math.ceil(L / 3));
        const seg = L / steps;
        for (let s = 0; s < steps; s++) {
          const t = (s + 0.5) / steps;
          const k = this.cellAt(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
          if (k < 0) continue;
          this.roadLen[k] += seg * w;
          any[k] = 1;
          if (isMain) main[k] = 1;
        }
      }
    }
    // waterways raster for flood distance
    const wmask = new Uint8Array(this.n);
    for (let k = 0; k < this.n; k++) if (this.water[k]) wmask[k] = 1;
    for (const wv of this.map.waterways) {
      const pts = wv.points;
      for (let p = 1; p < pts.length; p++) {
        const a = pts[p - 1];
        const b = pts[p];
        const L = Math.hypot(b.x - a.x, b.z - a.z);
        const steps = Math.max(1, Math.ceil(L / 4));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const k = this.cellAt(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
          if (k >= 0) wmask[k] = 1;
        }
      }
    }
    distanceTransform(main, this.cols, this.rows, this.cs, this.mainDist, 400);
    distanceTransform(any, this.cols, this.rows, this.cs, this.roadDist, 300);
    distanceTransform(wmask, this.cols, this.rows, this.cs, this.waterDist, 500);
  }

  private buildDistances(park: Uint8Array, jobs: Uint8Array): void {
    distanceTransform(jobs, this.cols, this.rows, this.cs, this.jobsDist, 300);
    distanceTransform(park, this.cols, this.rows, this.cs, this.parkDist, 300);
  }

  private buildFlood(): void {
    const sat = new Float64Array((this.cols + 1) * (this.rows + 1));
    buildSAT(this.elevation, this.cols, this.rows, sat);
    const R = 4;
    for (let k = 0; k < this.n; k++) {
      const i = k % this.cols;
      const j = (k - i) / this.cols;
      const mean = boxSum(sat, this.cols, this.rows, i, j, R) / boxCount(this.cols, this.rows, i, j, R);
      const rel = this.elevation[k] - mean; // metres above (+) or below (−) the surrounding 900 m window
      const depression = clamp01(-rel / 10);
      const flat = 1 - smoothstep(2, 10, this.slope[k]);
      const river = Math.exp(-this.waterDist[k] / 14);
      const noise = (fbm(this.cx[k] / 60 + 3.1, this.cz[k] / 60 - 1.7, 2) - 0.5) * 0.1;
      this.flood[k] = this.water[k]
        ? 1
        : clamp01(0.38 * this.zoneFlood[k] + 0.42 * river * (0.6 + 0.4 * flat) + 0.3 * depression * flat + noise);
    }
  }

  private buildAmenity(): void {
    const lms = this.map.landmarks.filter((l) => AMENITY[l.kind] !== undefined);
    for (let k = 0; k < this.n; k++) {
      const x = this.cx[k];
      const z = this.cz[k];
      let s = 0;
      for (const l of lms) {
        const dx = x - l.pos.x;
        const dz = z - l.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > 250 * 250) continue;
        s += (AMENITY[l.kind] as number) * Math.exp(-Math.sqrt(d2) / 55);
      }
      s += 0.07 * Math.exp(-this.parkDist[k] / 20);
      this.amenity[k] = 1 + clamp(s, -0.05, 0.35);
      // access to the main network + local street fabric
      this.access[k] = 0.78 + 0.32 * Math.exp(-this.mainDist[k] / 35) + 0.12 * clamp01(this.roadLen[k] / 18);
    }
  }

  private buildFronts(): void {
    const fr = this.fronts;
    const sig2 = 2 * 120 * 120; // Gaussian σ = 1.2 km
    for (let k = 0; k < this.n; k++) {
      const x = this.cx[k];
      const z = this.cz[k];
      let a = 0;
      let best = -1;
      let bd = Infinity;
      for (let f = 0; f < fr.length; f++) {
        const dx = x - fr[f].pos.x;
        const dz = z - fr[f].pos.z;
        const d2 = dx * dx + dz * dz;
        a += fr[f].strength * Math.exp(-d2 / sig2);
        if (d2 < bd) {
          bd = d2;
          best = f;
        }
      }
      this.frontAttr[k] = clamp01(a);
      this.frontIdx[k] = best;
      this.frontDist[k] = best >= 0 ? Math.sqrt(bd) : 1e4;
    }
  }

  private buildFootprint(): void {
    const n = this.n;
    const cols = this.cols;
    const rows = this.rows;
    const dens = new Float32Array(n);
    const osm = this.map.source === 'osm';
    // local street length averaged over 3×3 (a lone rural road only gives ~3 units/cell,
    // a 100 m block grid ~20). Street fabric is the strongest signal of the built city in both
    // sources (the procedural map grows colonia street grids out of the zones).
    const sat = new Float64Array((cols + 1) * (rows + 1));
    buildSAT(this.roadLen, cols, rows, sat);
    const zoneTerm = (k: number): number => {
      const zi = this.zoneIdx[k];
      if (zi < 0) return 0;
      const zn = this.zones[zi];
      const falloff = 1 - smoothstep(0.85, 1.5, this.zoneScore[k]);
      let d = zn.density * falloff * (zn.growthFront ? 0.35 : 1);
      if (zn.kind === 'rural') d *= 0.25;
      return d;
    };
    for (let k = 0; k < n; k++) {
      if (this.water[k]) continue;
      const i = k % cols;
      const j = (k - i) / cols;
      const rl = this.roadLen[k];
      const rl3 = boxSum(sat, cols, rows, i, j, 1) / boxCount(cols, rows, i, j, 1);
      const fabric = this.protectedMask[k] ? rl3 >= 10 : rl3 >= 5 || rl >= 8;
      const roadD = Math.pow(clamp01((0.5 * rl + 0.5 * rl3 - 3) / 22), 0.8);
      const zt = zoneTerm(k);
      let d: number;
      if (osm) d = fabric ? 0.6 * roadD + 0.4 * zt : 0;
      else d = fabric ? 0.5 * zt + 0.5 * roadD : zt >= 0.22 ? zt : 0;
      if (this.protectedMask[k]) d *= 0.6;
      dens[k] = d > 0 ? Math.min(1, Math.max(0.12, d)) : 0;
    }
    let count = 0;
    for (let k = 0; k < n; k++) if (dens[k] > 0) count++;
    if (count < 300) {
      // no usable street data: zone density × falloff with organic noise
      dens.fill(0);
      for (let k = 0; k < n; k++) {
        if (this.water[k]) continue;
        const noise = 0.75 + 0.5 * fbm(this.cx[k] / 45 + 7.3, this.cz[k] / 45 + 1.9, 3);
        let d = zoneTerm(k) * noise;
        if (this.protectedMask[k]) d *= 0.4;
        dens[k] = d >= 0.16 ? Math.min(1, d) : 0;
      }
    }
    // one cleaning pass: fill enclosed holes, drop isolated specks, soften density (3×3)
    const out = this.urban0;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        let c = 0;
        let s = 0;
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= rows) continue;
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            if (ii < 0 || ii >= cols || (di === 0 && dj === 0)) continue;
            const v = dens[jj * cols + ii];
            if (v > 0) {
              c++;
              s += v;
            }
          }
        }
        const self = dens[k];
        let v = 0;
        if (this.water[k]) v = 0;
        else if (self === 0) v = c >= 5 && !this.protectedMask[k] ? s / c : 0;
        else if (c <= 1 && this.roadLen[k] < 8) v = 0;
        else v = c ? 0.6 * self + 0.4 * (s / c) : self;
        out[k] = v > 0 ? Math.min(1, Math.max(0.12, v)) : 0;
      }
    }
    let u = 0;
    for (let k = 0; k < n; k++) {
      if (out[k] > 0) {
        u++;
        // older fabric is denser: centro ≈ 1950s, edges ≈ 2010s
        this.yearBuilt0[k] = Math.round(2024 - 62 * out[k] * (0.65 + 0.35 * fbm(this.cx[k] / 30, this.cz[k] / 30, 2)));
      } else this.yearBuilt0[k] = 9999;
    }
    this.urbanCount0 = u;
  }

  private buildPrices(): void {
    for (let k = 0; k < this.n; k++) {
      // natural-risk discount: flood and steep slopes reduce what buyers pay
      const disc = 1 - Math.min(0.3, 0.16 * this.flood[k] + 0.012 * Math.max(0, this.slope[k] - 10));
      this.urbanBase[k] = this.basePrice[k] * this.access[k] * this.amenity[k] * disc;
    }
  }

  private buildSupply(): void {
    const s = this.supplyStatic;
    for (let k = 0; k < this.n; k++) {
      const zi = this.zoneIdx[k];
      const kind = zi >= 0 ? this.zones[zi].kind : 'rural';
      const d = this.urban0[k];
      let v = d * 250; // corner shops everywhere people live
      if (kind === 'comercial') v += d * 3000;
      else if (kind === 'centro') v += d * 4500;
      if (this.commercialArea[k]) v += 2500;
      s[k] = v;
    }
    for (const l of this.map.landmarks) {
      const add = SUPPLY_LANDMARK[l.kind];
      if (!add) continue;
      const k = this.cellAt(l.pos.x, l.pos.z);
      if (k >= 0) s[k] += add;
    }
    // calibrate: in 2026 existing retail serves ~80% of the metro population
    let sum = 0;
    for (let k = 0; k < this.n; k++) sum += s[k];
    const scale = sum > 0 ? (0.8 * POP_2026) / sum : 0;
    for (let k = 0; k < this.n; k++) s[k] *= scale;
  }
}
