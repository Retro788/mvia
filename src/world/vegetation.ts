import * as THREE from 'three';
import type { MapData, Zone } from '../core/types';
import { GRID, WORLD, WORLD_D, WORLD_W, YEAR_START, cellIndexAt, rng } from '../core/geo';
import { MACHINE_COLORS, SHRINK_VERT_BEGIN, SHRINK_VERT_HEAD, WPOS_VERT, depthMaterial, glc, machineMaterial, patchMaterial } from './materials';
import { OCC_BUILDING, OCC_LANDMARK, OCC_ROAD, type Occupancy } from './occupancy';
import type { Landuse } from './landuse';
import { ROAD_WIDTH } from './roads';

export const MAX_TREES = 32000;

export interface TreeSet {
  crowns: THREE.InstancedMesh;
  trunks: THREE.InstancedMesh;
  cells: Int32Array;
  jitter: Float32Array;
  count: number;
  crownBeauty: THREE.Material;
  crownMachine: THREE.Material;
  trunkBeauty: THREE.Material;
  trunkMachine: THREE.Material;
}

/** Low-poly clay trees: dense in reserves / cloud forest, parks, coffee farmland, sparse along streets. */
export function buildVegetation(
  map: MapData,
  ground: (x: number, z: number) => number,
  occ: Occupancy,
  landuse: Landuse,
  cellZone: Int16Array,
): TreeSet {
  const rand = rng(777);
  const mats = new Float32Array(MAX_TREES * 16);
  const seeds = new Float32Array(MAX_TREES);
  const cells = new Int32Array(MAX_TREES);
  const jitter = new Float32Array(MAX_TREES);
  let n = 0;
  const MASK = OCC_ROAD | OCC_BUILDING | OCC_LANDMARK;

  const push = (x: number, z: number, s: number): void => {
    if (n >= MAX_TREES) return;
    const a = rand() * Math.PI * 2;
    const ca = Math.cos(a) * s;
    const sa = Math.sin(a) * s;
    const sy = s * (0.85 + rand() * 0.45);
    const o = n * 16;
    mats[o] = ca; mats[o + 1] = 0; mats[o + 2] = -sa; mats[o + 3] = 0;
    mats[o + 4] = 0; mats[o + 5] = sy; mats[o + 6] = 0; mats[o + 7] = 0;
    mats[o + 8] = sa; mats[o + 9] = 0; mats[o + 10] = ca; mats[o + 11] = 0;
    mats[o + 12] = x; mats[o + 13] = ground(x, z) - 0.05; mats[o + 14] = z; mats[o + 15] = 1;
    seeds[n] = rand();
    cells[n] = cellIndexAt(x, z, GRID);
    jitter[n] = rand() * 0.8;
    n++;
  };

  // 1) street trees along residential / tertiary roads
  const streetBudget = 5000;
  for (const r of map.roads) {
    if (n >= streetBudget) break;
    if (r.cls !== 'residential' && r.cls !== 'tertiary') continue;
    const hw = ROAD_WIDTH[r.cls] * 0.5;
    for (let k = 1; k < r.points.length; k++) {
      const a = r.points[k - 1];
      const b = r.points[k];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 2) continue;
      const ux = (b.x - a.x) / len;
      const uz = (b.z - a.z) / len;
      for (let t = rand() * 6; t < len; t += 5 + rand() * 6) {
        if (rand() > 0.3) continue;
        const side = rand() < 0.5 ? -1 : 1;
        const off = (hw + 0.45) * side;
        const x = a.x + ux * t - uz * off;
        const z = a.z + uz * t + ux * off;
        if (occ.at(x, z) & (OCC_BUILDING | OCC_LANDMARK)) continue;
        push(x, z, 0.75 + rand() * 0.5);
      }
    }
  }

  // 2) area scatter: rejection sampling driven by land use and zone
  const zones = map.zones;
  const zoneP = (zn: Zone | null): number => {
    if (!zn) return 0.09;
    if (zn.kind === 'rural') return 0.1;
    if (zn.kind === 'periferia') return 0.05;
    return 0.018 * (1.2 - zn.density);
  };
  for (let tries = 0; tries < 520000 && n < MAX_TREES; tries++) {
    const x = WORLD.minX + rand() * WORLD_W;
    const z = WORLD.minZ + rand() * WORLD_D;
    if (landuse.water(x, z) > 0.3) continue;
    const g = landuse.green(x, z);
    const p = landuse.park(x, z);
    let prob: number;
    let s: number;
    if (g > 0.75) {
      prob = 0.5; // cloud forest / reserve
      s = 1.3 + rand() * 1.1;
    } else if (g > 0.3) {
      prob = 0.24; // coffee plantations under shade trees
      s = 0.9 + rand() * 0.8;
    } else if (p > 0.5) {
      prob = 0.32 * p;
      s = 1.0 + rand() * 0.8;
    } else {
      const c = cellIndexAt(x, z, GRID);
      const k = c >= 0 ? cellZone[c] : -1;
      prob = zoneP(k >= 0 ? zones[k] : null);
      s = 0.9 + rand() * 0.9;
    }
    if (rand() > prob) continue;
    if (occ.at(x, z) & MASK) continue;
    push(x, z, s);
  }

  // geometry: crown sits on a short trunk; instancing shares one matrix buffer between both meshes
  const crownGeo = new THREE.IcosahedronGeometry(0.55, 0).translate(0, 1.15, 0);
  const trunkGeo = new THREE.CylinderGeometry(0.06, 0.08, 0.75, 5, 1, true).translate(0, 0.375, 0);
  const yearAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_TREES).fill(9999), 1);
  const seedAttr = new THREE.InstancedBufferAttribute(seeds, 1);
  crownGeo.setAttribute('aYear', yearAttr);
  crownGeo.setAttribute('aSeed', seedAttr);
  trunkGeo.setAttribute('aYear', yearAttr);
  trunkGeo.setAttribute('aSeed', seedAttr);

  const crownBeauty = patchMaterial(new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), 'tree-crown', {
    vertHead: SHRINK_VERT_HEAD,
    vertBegin: SHRINK_VERT_BEGIN,
    vertEnd: WPOS_VERT,
    fragHead: 'varying vec3 vWPos; varying float vSeed; varying vec3 vObjN;',
    fragColor: /* glsl */ `
      vec3 c;
      if (uStyle < 0.5) c = mix(${glc('#f6f8f2')}, ${glc('#e3ecd9')}, vSeed);
      else if (uStyle < 1.5) c = mix(${glc('#2c4a26')}, ${glc('#4c6a35')}, vSeed);
      else c = mix(${glc('#0d1712')}, ${glc('#14241a')}, vSeed);
      diffuseColor.rgb = c;
    `,
  });
  const trunkBeauty = patchMaterial(new THREE.MeshLambertMaterial({ color: 0xffffff }), 'tree-trunk', {
    vertHead: SHRINK_VERT_HEAD,
    vertBegin: SHRINK_VERT_BEGIN,
    vertEnd: WPOS_VERT,
    fragHead: 'varying vec3 vWPos; varying float vSeed; varying vec3 vObjN;',
    fragColor: `diffuseColor.rgb = uStyle < 0.5 ? ${glc('#e4e0d6')} : (uStyle < 1.5 ? ${glc('#4a3b2c')} : ${glc('#0b0d10')});`,
  });
  const crownMachine = machineMaterial(
    'tree',
    /* glsl */ `
    attribute float aYear;
    attribute float aSeed;
    varying vec3 vWPos;
    varying float vSeed;
    varying vec3 vObjN;
    void main() {
      vec3 transformed = position;
      ${SHRINK_VERT_BEGIN}
      // collapse the crown into a small marker around its centre
      transformed = (transformed - vec3(0.0, 1.15 * mk, 0.0)) * 0.42 + vec3(0.0, 1.15 * mk, 0.0);
      vec4 wp = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
      wp = instanceMatrix * wp;
      #endif
      wp = modelMatrix * wp;
      vWPos = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
    /* glsl */ `
    varying vec3 vWPos;
    varying float vSeed;
    varying vec3 vObjN;
    void main() {
      vec3 col = mix(${MACHINE_COLORS.scan2}, ${MACHINE_COLORS.scan3}, 0.35 + 0.4 * vSeed) * 0.8;
      col += ${MACHINE_COLORS.scan4} * mRings(vWPos.xz) * 0.5;
      col = mDepthTint(col, vWPos);
      gl_FragColor = vec4(col, 1.0);
      #include <colorspace_fragment>
    }`,
  );
  const trunkMachine = new THREE.MeshBasicMaterial();
  trunkMachine.visible = false;

  const crowns = new THREE.InstancedMesh(crownGeo, crownBeauty, MAX_TREES);
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkBeauty, MAX_TREES);
  (crowns.instanceMatrix.array as Float32Array).set(mats);
  trunks.instanceMatrix = crowns.instanceMatrix; // shared buffer
  crowns.count = trunks.count = n;
  crowns.instanceMatrix.needsUpdate = true;
  crowns.name = 'tree-crowns';
  trunks.name = 'tree-trunks';
  crowns.castShadow = true;
  crowns.receiveShadow = true;
  trunks.receiveShadow = true;
  crowns.frustumCulled = trunks.frustumCulled = false;
  const depth = depthMaterial('shrink', SHRINK_VERT_HEAD, SHRINK_VERT_BEGIN);
  crowns.customDepthMaterial = depth;
  return {
    crowns, trunks, cells: cells.slice(0, n), jitter: jitter.slice(0, n), count: n,
    crownBeauty, crownMachine, trunkBeauty, trunkMachine,
  };
}

/** deforestation by sprawl: trees in cells urbanised after 2026 shrink out at that year */
export function applyTreeYears(set: TreeSet, years: Float32Array): void {
  const attr = set.crowns.geometry.getAttribute('aYear') as THREE.InstancedBufferAttribute;
  const arr = attr.array as Float32Array;
  for (let k = 0; k < set.count; k++) {
    const c = set.cells[k];
    const y = c >= 0 && c < years.length ? years[c] : 9999;
    arr[k] = y > YEAR_START && y < 9000 ? y + set.jitter[k] : 9999;
  }
  attr.needsUpdate = true;
}
