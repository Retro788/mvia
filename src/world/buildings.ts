import * as THREE from 'three';
import type { MapData, Zone } from '../core/types';
import { GRID, YEAR_START, cellIndexAt, rng, valueNoise } from '../core/geo';
import {
  BOX_EDGE_GLSL, GROW_VERT_BEGIN, GROW_VERT_HEAD, MACHINE_BOX_FRAG, MACHINE_BOX_VERT, WPOS_VERT,
  depthMaterial, glc, machineMaterial, patchMaterial,
} from './materials';
import { OCC_BUILDING, OCC_LANDMARK, OCC_ROAD, type Occupancy } from './occupancy';
import type { Landuse } from './landuse';
import { ROAD_CLS_INDEX, ROAD_WIDTH } from './roads';
import { RibbonBatch } from './ribbon';

export const MAX_BUILDINGS = 65000;
export const MAX_GROWTH_HOUSES = 36000;
/** world units per floor: 3.2 m × 1.4 vertical exaggeration */
export const FLOOR_H = 0.32 * 1.4;

/** shared unit box, base at y=0, spans x,z ∈ [-0.5, 0.5] */
export const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);

// ───────────────────────────── materials ─────────────────────────────
export function buildingBeautyMaterial(): THREE.MeshLambertMaterial {
  return patchMaterial(new THREE.MeshLambertMaterial({ color: 0xffffff }), 'building', {
    vertHead: GROW_VERT_HEAD,
    vertBegin: GROW_VERT_BEGIN,
    vertEnd: WPOS_VERT,
    fragHead: `${BOX_EDGE_GLSL}
      varying vec3 vLocal; varying vec3 vScale; varying vec3 vObjN; varying vec3 vWPos; varying float vSeed; vec3 mWin;`,
    fragColor: /* glsl */ `
      float edge = mBoxEdge(vLocal, vScale, vObjN, 0.12);
      float hgt = vLocal.y * vScale.y;
      // fake ambient occlusion: darken the first ~1.4 units above the base
      float ao = mix(0.74, 1.0, smoothstep(0.0, 1.4, hgt));
      bool roof = vObjN.y > 0.5;
      vec3 c;
      mWin = vec3(0.0);
      if (uStyle < 0.5) {
        c = ${glc('#fbfbf9')} * (1.0 - 0.14 * edge) * ao * (0.985 + 0.03 * vSeed);
      } else if (uStyle < 1.5) {
        vec3 concrete = mix(${glc('#8f8d88')}, ${glc('#b8b1a3')}, fract(vSeed * 7.0));
        vec3 roofC = mix(concrete, ${glc('#9c5236')}, step(0.62, fract(vSeed * 13.0)));
        c = roof ? roofC * (0.88 + 0.12 * fract(vSeed * 29.0)) : ${glc('#7d7a74')} * ao;
        c *= 1.0 - 0.18 * edge;
      } else {
        c = ${glc('#1b2230')} * (roof ? 0.75 : 1.0) * (1.0 - 0.25 * edge) * ao;
        if (!roof && hgt > 0.25) {
          // procedural window grid in face space: 0.5 u wide bays, one floor tall
          float u = abs(vObjN.x) > 0.5 ? (vLocal.z + 0.5) * vScale.z : (vLocal.x + 0.5) * vScale.x;
          vec2 g = vec2(u / 0.5, hgt / ${FLOOR_H.toFixed(3)});
          vec2 f = fract(g);
          float win = step(0.22, f.x) * step(f.x, 0.78) * step(0.28, f.y) * step(f.y, 0.8);
          float r = mHash(floor(g) + vec2(vSeed * 91.7, vSeed * 17.3));
          float lit = step(0.56, r);
          mWin = mix(${glc('#ffc77a')}, ${glc('#d6ecff')}, step(0.87, r)) * win * lit * (0.5 + 0.7 * fract(r * 13.0));
        }
      }
      vec4 ov = mOverlay(vWPos.xz);
      c = mix(c, ov.rgb, ov.a * 0.75);
      diffuseColor.rgb = c;
    `,
    fragEmissive: 'totalEmissiveRadiance += mWin;',
  });
}

export function buildingMachineMaterial(tint = '#ffffff'): THREE.ShaderMaterial {
  return machineMaterial(
    'building',
    MACHINE_BOX_VERT,
    MACHINE_BOX_FRAG,
    { uTint: { value: new THREE.Color(tint) }, uAlpha: { value: 0.8 } },
    { transparent: true, depthWrite: true },
  );
}

export const buildingDepthMaterial = (): THREE.MeshDepthMaterial => depthMaterial('grow', GROW_VERT_HEAD, GROW_VERT_BEGIN);

// ───────────────────────────── zone lookup ─────────────────────────────
/** per sim cell: index of the dominant zone (min distance/radius), -1 if far from every zone */
export function computeCellZones(zones: Zone[]): Int16Array {
  const out = new Int16Array(GRID.cols * GRID.rows).fill(-1);
  for (let j = 0; j < GRID.rows; j++) {
    const z = GRID.minZ + (j + 0.5) * GRID.cellSize;
    for (let i = 0; i < GRID.cols; i++) {
      const x = GRID.minX + (i + 0.5) * GRID.cellSize;
      let best = -1;
      let bestR = 1.5;
      for (let k = 0; k < zones.length; k++) {
        const zn = zones[k];
        const r = Math.hypot(x - zn.center.x, z - zn.center.z) / Math.max(zn.radius, 1);
        if (r < bestR) {
          bestR = r;
          best = k;
        }
      }
      out[j * GRID.cols + i] = best;
    }
  }
  return out;
}

// ───────────────────────────── instance writer ─────────────────────────────
class InstanceWriter {
  matrices: Float32Array;
  years: Float32Array;
  seeds: Float32Array;
  cells: Int32Array;
  jitter: Float32Array;
  rural: Uint8Array;
  n = 0;
  constructor(readonly cap: number) {
    this.matrices = new Float32Array(cap * 16);
    this.years = new Float32Array(cap);
    this.seeds = new Float32Array(cap);
    this.cells = new Int32Array(cap);
    this.jitter = new Float32Array(cap);
    this.rural = new Uint8Array(cap);
  }
  /** T · Ry · S written column-major; local x = frontage (along ux,uz), local z = depth */
  push(x: number, y: number, z: number, ux: number, uz: number, w: number, h: number, d: number, seed: number, year: number): number {
    if (this.n >= this.cap) return -1;
    const m = this.matrices;
    const o = this.n * 16;
    // Ry maps local x → (ux, 0, uz) and local z → (-uz, 0, ux)
    m[o] = ux * w; m[o + 1] = 0; m[o + 2] = uz * w; m[o + 3] = 0;
    m[o + 4] = 0; m[o + 5] = h; m[o + 6] = 0; m[o + 7] = 0;
    m[o + 8] = -uz * d; m[o + 9] = 0; m[o + 10] = ux * d; m[o + 11] = 0;
    m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
    this.seeds[this.n] = seed;
    this.years[this.n] = year;
    return this.n++;
  }
}

function makeInstanced(geo: THREE.BufferGeometry, mat: THREE.Material, w: InstanceWriter, cap: number): THREE.InstancedMesh {
  const g = geo.clone();
  const yearAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
  yearAttr.array.set(w.years.subarray(0, w.n));
  const seedAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
  seedAttr.array.set(w.seeds.subarray(0, w.n));
  g.setAttribute('aYear', yearAttr);
  g.setAttribute('aSeed', seedAttr);
  const mesh = new THREE.InstancedMesh(g, mat, cap);
  (mesh.instanceMatrix.array as Float32Array).set(w.matrices.subarray(0, w.n * 16));
  mesh.count = w.n;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false; // single huge batch; per-object culling would only cost CPU
  return mesh;
}

export interface BuildingSet {
  mesh: THREE.InstancedMesh;
  cells: Int32Array;
  jitter: Float32Array;
  rural: Uint8Array;
  count: number;
}

/** Street-front + block-interior buildings from the road graph (deterministic). */
export function buildBuildings(
  map: MapData,
  ground: (x: number, z: number) => number,
  occ: Occupancy,
  landuse: Landuse,
  cellZone: Int16Array,
  material: THREE.Material,
): BuildingSet {
  const rand = rng(20260101);
  const w = new InstanceWriter(MAX_BUILDINGS);
  const zones = map.zones;
  const zoneAt = (x: number, z: number): Zone | null => {
    const c = cellIndexAt(x, z, GRID);
    if (c < 0) return null;
    const k = cellZone[c];
    return k >= 0 ? zones[k] : null;
  };
  const acceptP = (zn: Zone | null): number => {
    if (!zn) return 0.16;
    if (zn.kind === 'rural') return 0.2;
    if (zn.kind === 'periferia') return 0.45;
    return Math.min(1, 0.35 + zn.density * 0.8);
  };

  const eligible = map.roads.filter((r) => {
    const ci = ROAD_CLS_INDEX[r.cls];
    return ci >= 1 && ci <= 5 && r.points.length >= 2;
  });
  // estimate candidates so the 65k cap is spread uniformly instead of exhausted by the first roads
  let est = 0;
  for (const r of eligible) {
    let len = 0;
    for (let k = 1; k < r.points.length; k++) len += Math.hypot(r.points[k].x - r.points[k - 1].x, r.points[k].z - r.points[k - 1].z);
    const mid = r.points[r.points.length >> 1];
    est += ((len * 2) / 2.6) * acceptP(zoneAt(mid.x, mid.z)) * 0.55; // ~half survive occupancy
  }
  const budget = MAX_BUILDINGS * 0.86;
  const global = Math.min(1, budget / Math.max(est, 1));
  // shuffle roads (Fisher–Yates) so a truncated run is spatially fair
  const order = eligible.map((_, k) => k);
  for (let k = order.length - 1; k > 0; k--) {
    const s = Math.floor(rand() * (k + 1));
    [order[k], order[s]] = [order[s], order[k]];
  }

  const MASK = OCC_ROAD | OCC_BUILDING | OCC_LANDMARK;
  /**
   * `inset` (road-side lots): the occupancy test ignores the strip of the lot nearest to its own street,
   * so the 0.8-unit raster quantisation of the road never rejects a correctly set-back building.
   * (sx,sz) = unit vector from the street toward the lot.
   */
  const place = (
    cx: number, cz: number, ux: number, uz: number, bw: number, bd: number, zn: Zone | null, rural: boolean,
    inset = 0, sx = 0, sz = 0,
  ): boolean => {
    if (landuse.blocked(cx, cz)) return false;
    const tx = cx + sx * inset * 0.5;
    const tz = cz + sz * inset * 0.5;
    if (!occ.rect(tx, tz, ux, uz, Math.max(0.3, bw * 0.5 - 0.25), Math.max(0.3, bd * 0.5 - 0.25 - inset * 0.5), MASK, OCC_BUILDING)) return false;
    const fmin = zn ? zn.floors[0] : 1;
    const fmax = zn ? zn.floors[1] : 2;
    let floors = fmin + (fmax - fmin) * Math.pow(rand(), 1.7) + (valueNoise(cx / 9, cz / 9) - 0.5) * 1.4;
    if (zn && (zn.kind === 'premium' || zn.kind === 'comercial' || zn.kind === 'centro') && rand() < 0.012) floors = fmax * (2 + rand() * 1.5);
    floors = Math.max(1, Math.round(floors));
    const h = floors * FLOOR_H;
    // sink the base to the lowest footprint corner so buildings never float on slopes
    const vx = -uz;
    const vz = ux;
    const hw = bw * 0.5;
    const hd = bd * 0.5;
    const gc = ground(cx, cz);
    const g0 = Math.min(
      gc,
      ground(cx + ux * hw + vx * hd, cz + uz * hw + vz * hd),
      ground(cx - ux * hw + vx * hd, cz - uz * hw + vz * hd),
      ground(cx + ux * hw - vx * hd, cz + uz * hw - vz * hd),
      ground(cx - ux * hw - vx * hd, cz - uz * hw - vz * hd),
    ) - 0.25;
    const id = w.push(cx, g0, cz, ux, uz, bw, gc + h - g0, bd, rand(), 0);
    if (id < 0) return false;
    w.cells[id] = cellIndexAt(cx, cz, GRID);
    w.jitter[id] = rand() * 1.5;
    w.rural[id] = rural ? 1 : 0;
    return true;
  };

  for (const ri of order) {
    if (w.n >= budget) break;
    const r = eligible[ri];
    const hwRoad = ROAD_WIDTH[r.cls] * 0.5;
    for (let k = 1; k < r.points.length; k++) {
      const a = r.points[k - 1];
      const b = r.points[k];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 1.5) continue;
      const ux = (b.x - a.x) / len;
      const uz = (b.z - a.z) / len;
      for (let side = -1; side <= 1; side += 2) {
        let t = rand() * 1.2;
        while (t < len - 0.6) {
          const bw = 1.2 + rand() * 1.6;
          const bd = 1.5 + rand() * 2.0;
          const along = t + bw * 0.5;
          if (along > len) break;
          const off = (hwRoad + bd * 0.5 + 0.35) * side;
          // left normal of (ux,uz) is (-uz, ux)
          const cx = a.x + ux * along - uz * off;
          const cz = a.z + uz * along + ux * off;
          const zn = zoneAt(cx, cz);
          const rural = !zn || zn.kind === 'rural';
          if (rand() < acceptP(zn) * global) place(cx, cz, ux, uz, bw, bd, zn, rural && rand() < 0.35, 0.9, -uz * side, ux * side);
          t += bw + 0.3 + rand() * 0.8;
        }
      }
    }
  }

  // block interiors in dense zones: oriented like the dominant street of the cell
  const interiorBudget = MAX_BUILDINGS - w.n;
  let tries = 0;
  for (let c = 0; c < GRID.cols * GRID.rows && w.n < MAX_BUILDINGS && tries < interiorBudget * 4; c++) {
    const k = cellZone[c];
    if (k < 0 || !occ.cellRoad[c]) continue;
    const zn = zones[k];
    if (zn.density < 0.5 || zn.kind === 'rural') continue;
    const n = Math.round(zn.density * 16);
    const ang = Number.isNaN(occ.cellAngle[c]) ? 0 : occ.cellAngle[c];
    const ux = Math.cos(ang);
    const uz = Math.sin(ang);
    const x0 = GRID.minX + (c % GRID.cols) * GRID.cellSize;
    const z0 = GRID.minZ + Math.floor(c / GRID.cols) * GRID.cellSize;
    for (let s = 0; s < n; s++) {
      tries++;
      place(x0 + rand() * GRID.cellSize, z0 + rand() * GRID.cellSize, ux, uz, 1.4 + rand() * 1.4, 1.4 + rand() * 1.4, zn, false);
    }
  }

  const mesh = makeInstanced(UNIT_BOX, material, w, MAX_BUILDINGS);
  mesh.name = 'buildings';
  return { mesh, cells: w.cells.slice(0, w.n), jitter: w.jitter.slice(0, w.n), rural: w.rural.slice(0, w.n), count: w.n };
}

/** aYear per building from the projection: already-urban → visible, future → rises at its year */
export function applyBuildingYears(set: BuildingSet, years: Float32Array): void {
  const attr = set.mesh.geometry.getAttribute('aYear') as THREE.InstancedBufferAttribute;
  const arr = attr.array as Float32Array;
  for (let k = 0; k < set.count; k++) {
    const c = set.cells[k];
    const y = c >= 0 && c < years.length ? years[c] : 9999;
    if (y <= YEAR_START) arr[k] = 0;
    else if (y >= 9000) arr[k] = set.rural[k] ? 0 : 9999; // a few scattered rural houses always stand
    else arr[k] = y + set.jitter[k];
  }
  attr.needsUpdate = true;
}

// ───────────────────────────── growth lots (sprawl) ─────────────────────────────
export class GrowthLots {
  readonly mesh: THREE.InstancedMesh;
  readonly streets: THREE.Mesh;
  readonly streetBeauty: THREE.MeshLambertMaterial;
  readonly streetMachine: THREE.ShaderMaterial;
  count = 0;

  constructor(material: THREE.Material, depth: THREE.Material) {
    const w = new InstanceWriter(0);
    this.mesh = makeInstanced(UNIT_BOX, material, w, MAX_GROWTH_HOUSES);
    this.mesh.name = 'growth-lots';
    this.mesh.customDepthMaterial = depth;
    this.streetBeauty = patchMaterial(
      new THREE.MeshLambertMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }),
      'growth-street',
      {
        vertHead: 'attribute float aYear; attribute vec3 aRoad; varying vec3 vRoad; varying vec3 vWPos;',
        vertBegin: 'vRoad = aRoad; if (uYear < aYear) transformed = vec3(0.0);',
        vertEnd: WPOS_VERT,
        fragHead: 'varying vec3 vRoad; varying vec3 vWPos;',
        fragColor: /* glsl */ `
          vec3 c = uStyle < 0.5 ? ${glc('#e2dccd')} : (uStyle < 1.5 ? ${glc('#8b7a60')} : ${glc('#211d19')});
          c *= 0.94 + 0.06 * mHash(floor(vWPos.xz * 2.0));
          diffuseColor.rgb = c;
        `,
      },
    );
    this.streetMachine = machineMaterial(
      'growth-street',
      /* glsl */ `
      attribute float aYear;
      attribute vec3 aRoad;
      varying vec3 vWPos;
      varying float vAge;
      void main() {
        vec3 p = uYear < aYear ? vec3(0.0) : position;
        vAge = uYear - aYear;
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vWPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
      /* glsl */ `
      varying vec3 vWPos;
      varying float vAge;
      void main() {
        // freshly opened sprawl streets flash orange, then settle to dim cyan
        float fresh = 1.0 - smoothstep(0.0, 2.0, vAge);
        vec3 col = mix(${glc('#2a9fcf')} * 0.55, ${glc('#ff8a2b')}, fresh);
        col = mDepthTint(col, vWPos);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
      {},
      { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 },
    );
    this.streets = new THREE.Mesh(new THREE.BufferGeometry(), this.streetBeauty);
    this.streets.name = 'growth-streets';
    this.streets.receiveShadow = true;
    this.streets.frustumCulled = false;
    this.streets.visible = false;
  }

  /** (re)build rotated mini-grids of 1–2 floor houses in future-urbanised cells that have no mapped streets */
  rebuild(years: Float32Array, occ: Occupancy, landuse: Landuse, ground: (x: number, z: number) => number): void {
    const cells: number[] = [];
    for (let c = 0; c < years.length; c++) {
      const y = years[c];
      if (y > YEAR_START && y <= 2050.5 && !occ.cellRoad[c]) cells.push(c);
    }
    const perSide = Math.max(2, Math.min(5, Math.floor(MAX_GROWTH_HOUSES / Math.max(1, cells.length * 4))));
    const w = new InstanceWriter(MAX_GROWTH_HOUSES);
    const streets = new RibbonBatch();
    const cs = GRID.cellSize;
    const pa = { x: 0, z: 0 };
    const pb = { x: 0, z: 0 };
    const line = [pa, pb];
    for (const c of cells) {
      if (w.n >= MAX_GROWTH_HOUSES - perSide * 4) break;
      const cx = GRID.minX + ((c % GRID.cols) + 0.5) * cs;
      const cz = GRID.minZ + (Math.floor(c / GRID.cols) + 0.5) * cs;
      if (landuse.water(cx, cz) > 0.4) continue;
      const rand = rng(c * 7919 + 17);
      const y = years[c];
      // low-frequency orientation field → neighbouring lots share a grid, like real fraccionamientos
      const ang = valueNoise(cx / 70 + 3.1, cz / 70 - 1.7) * Math.PI * 1.5;
      const ux = Math.cos(ang);
      const uz = Math.sin(ang);
      const vx = -uz;
      const vz = ux;
      for (const off of [-2.6, 2.6]) {
        pa.x = cx - ux * 5.2 + vx * off;
        pa.z = cz - uz * 5.2 + vz * off;
        pb.x = cx + ux * 5.2 + vx * off;
        pb.z = cz + uz * 5.2 + vz * off;
        streets.add(line, 0.32, 0.09, 5, ground, 2.6, y - 0.25);
        for (let side = -1; side <= 1; side += 2) {
          for (let k = 0; k < perSide; k++) {
            if (rand() < 0.12) continue; // empty lots
            const bw = 0.9 + rand() * 0.45;
            const bd = 1.0 + rand() * 0.5;
            const along = -4.2 + (8.4 * (k + 0.5)) / perSide + (rand() - 0.5) * 0.3;
            const o = off + side * (0.32 + 0.22 + bd * 0.5);
            const hx = cx + ux * along + vx * o;
            const hz = cz + uz * along + vz * o;
            const floors = rand() < 0.3 ? 2 : 1;
            const gc = ground(hx, hz);
            const g0 = gc - 0.35;
            const id = w.push(hx, g0, hz, ux, uz, bw, floors * FLOOR_H + 0.35, bd, rand(), y + rand() * 1.2);
            if (id < 0) break;
          }
        }
      }
    }
    const yearAttr = this.mesh.geometry.getAttribute('aYear') as THREE.InstancedBufferAttribute;
    const seedAttr = this.mesh.geometry.getAttribute('aSeed') as THREE.InstancedBufferAttribute;
    (yearAttr.array as Float32Array).set(w.years.subarray(0, w.n));
    (seedAttr.array as Float32Array).set(w.seeds.subarray(0, w.n));
    (this.mesh.instanceMatrix.array as Float32Array).set(w.matrices.subarray(0, w.n * 16));
    yearAttr.needsUpdate = true;
    seedAttr.needsUpdate = true;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.count = w.n;
    this.count = w.n;
    const old = this.streets.geometry;
    this.streets.geometry = streets.vertexCount > 0 ? streets.toGeometry() : new THREE.BufferGeometry();
    this.streets.visible = streets.vertexCount > 0;
    old.dispose();
  }
}
