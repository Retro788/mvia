import * as THREE from 'three';
import type { MapData, RoadClass } from '../core/types';
import { GRID, cellIndexAt } from '../core/geo';
import { MACHINE_COLORS, WPOS_VERT, glc, machineMaterial, patchMaterial } from './materials';
import { OCC_ROAD, type Occupancy } from './occupancy';
import { RibbonBatch } from './ribbon';

export const ROAD_CLS_INDEX: Record<RoadClass, number> = {
  motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, residential: 5, pedestrian: 6,
};
export const ROAD_WIDTH: Record<RoadClass, number> = {
  motorway: 2.2, trunk: 1.9, primary: 1.6, secondary: 1.3, tertiary: 1.0, residential: 0.7, pedestrian: 0.5,
};

const ROAD_VERT_HEAD = 'attribute vec3 aRoad; varying vec3 vRoad; varying vec3 vWPos;';

export function roadBeautyMaterial(key: string): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    transparent: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  return patchMaterial(m, `road-${key}`, {
    vertHead: ROAD_VERT_HEAD,
    vertBegin: 'vRoad = aRoad;',
    vertEnd: WPOS_VERT,
    fragHead: 'varying vec3 vRoad; varying vec3 vWPos; vec3 mRoadGlow;',
    fragColor: /* glsl */ `
      float cls = vRoad.x;
      float side = abs(vRoad.y);
      float along = vRoad.z;
      // casing: darker outer band (strong on primaries, faint on secondaries)
      float casing = cls < 2.5 ? smoothstep(0.74, 0.82, side) : (cls < 4.5 ? smoothstep(0.84, 0.92, side) * 0.55 : 0.0);
      float center = cls < 3.5 ? (1.0 - smoothstep(0.035, 0.07, side)) * step(0.45, fract(along / 3.2)) : 0.0;
      mRoadGlow = vec3(0.0);
      if (uStyle < 0.5) {
        vec3 c = cls < 2.5 ? ${glc('#d4d3cd')} : ${glc('#d9d8d3')};
        if (cls > 5.5) c = ${glc('#e3e1da')};
        c = mix(c, ${glc('#b7b5ae')}, casing);
        c = mix(c, vec3(1.0), center * 0.9);
        diffuseColor = vec4(c, 1.0);
      } else if (uStyle < 1.5) {
        diffuseColor = vec4(mix(vec3(0.24), vec3(0.08), casing), 0.35);
      } else {
        diffuseColor = vec4(mix(${glc('#1a1f29')}, ${glc('#0c0f15')}, casing), 1.0);
        float k = cls < 2.5 ? 1.0 : (cls < 4.5 ? 0.55 : (cls < 5.5 ? 0.28 : 0.12));
        // sodium lamps: warm glow strongest at the road axis, with lamp pulses every ~4 units
        float lamp = 0.75 + 0.25 * smoothstep(0.6, 1.0, abs(fract(along / 4.0) - 0.5) * 2.0);
        mRoadGlow = ${glc('#ff9a3c')} * k * (0.25 + 0.75 * (1.0 - side * side)) * lamp * 0.9;
        mRoadGlow += ${glc('#ffd9a0')} * center * 0.25;
      }
    `,
    fragEmissive: 'totalEmissiveRadiance += mRoadGlow;',
  });
}

export function roadMachineMaterial(key: string): THREE.ShaderMaterial {
  return machineMaterial(
    `road-${key}`,
    /* glsl */ `
    attribute vec3 aRoad;
    varying vec3 vRoad;
    varying vec3 vWPos;
    void main() {
      vRoad = aRoad;
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWPos = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
    /* glsl */ `
    varying vec3 vRoad;
    varying vec3 vWPos;
    void main() {
      float cls = vRoad.x;
      float side = abs(vRoad.y);
      float k = cls < 2.5 ? 1.0 : (cls < 4.5 ? 0.72 : 0.45);
      float core = 1.0 - smoothstep(0.0, 1.0, side);
      float rim = smoothstep(0.78, 0.95, side);
      vec3 col = ${MACHINE_COLORS.scan3} * (0.18 + 0.5 * core) * k + ${MACHINE_COLORS.scan4} * rim * 0.35 * k;
      // light packets flowing along arterials
      float flow = cls < 3.5 ? pow(fract(vRoad.z / 9.0 - uTime * 0.7), 8.0) : 0.0;
      col += ${MACHINE_COLORS.scan4} * flow * core * 0.9;
      col += ${MACHINE_COLORS.scan3} * mRings(vWPos.xz) * 0.5;
      col = mDepthTint(col, vWPos);
      gl_FragColor = vec4(col, 1.0);
      #include <colorspace_fragment>
    }`,
    {},
    { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 },
  );
}

export interface RoadMeshes {
  meshes: Array<{ mesh: THREE.Mesh; beauty: THREE.Material; machine: THREE.Material }>;
  vertexCount: number;
}

/** groups: A = motorway/trunk/primary · B = secondary/tertiary · C = residential/pedestrian (≤ 3 draw calls) */
export function buildRoads(map: MapData, ground: (x: number, z: number) => number, occ: Occupancy): RoadMeshes {
  const groups = [new RibbonBatch(), new RibbonBatch(), new RibbonBatch()];
  const yOff = [0.17, 0.14, 0.11];
  for (const r of map.roads) {
    if (r.points.length < 2) continue;
    const ci = ROAD_CLS_INDEX[r.cls] ?? 5;
    const g = ci <= 2 ? 0 : ci <= 4 ? 1 : 2;
    const hw = ROAD_WIDTH[r.cls] * 0.5;
    groups[g].add(r.points, hw, yOff[g], ci, ground, 3);
    // rasterise into occupancy + per-cell road flags/orientation
    for (let k = 1; k < r.points.length; k++) {
      const a = r.points[k - 1];
      const b = r.points[k];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 1e-3) continue;
      const n = Math.ceil(len / 0.6);
      const ang = Math.atan2(b.z - a.z, b.x - a.x);
      for (let s = 0; s <= n; s++) {
        const x = a.x + ((b.x - a.x) * s) / n;
        const z = a.z + ((b.z - a.z) * s) / n;
        occ.markDisc(x, z, hw + 0.1, OCC_ROAD);
        if (ci <= 5 && (s & 3) === 0) {
          const c = cellIndexAt(x, z, GRID);
          if (c >= 0) {
            occ.cellRoad[c] = 1;
            if (Number.isNaN(occ.cellAngle[c]) || ci < 5) occ.cellAngle[c] = ang;
          }
        }
      }
    }
  }
  const out: RoadMeshes = { meshes: [], vertexCount: 0 };
  const keys = ['a', 'b', 'c'];
  groups.forEach((batch, gi) => {
    if (batch.vertexCount === 0) return;
    const beauty = roadBeautyMaterial(keys[gi]);
    const machine = roadMachineMaterial(keys[gi]);
    const mesh = new THREE.Mesh(batch.toGeometry(), beauty);
    mesh.name = `roads-${keys[gi]}`;
    mesh.receiveShadow = true;
    mesh.renderOrder = 1; // after terrain
    mesh.matrixAutoUpdate = false;
    out.meshes.push({ mesh, beauty, machine });
    out.vertexCount += batch.vertexCount;
  });
  return out;
}

/** rivers / streams as draped ribbons (water areas live in the land-use raster) */
export function buildWaterways(map: MapData, ground: (x: number, z: number) => number): { mesh: THREE.Mesh; beauty: THREE.Material; machine: THREE.Material } | null {
  const batch = new RibbonBatch();
  for (const w of map.waterways) {
    if (w.points.length < 2) continue;
    batch.add(w.points, Math.max(0.5, w.width * 0.5), 0.06, 0, ground, 2.5);
  }
  if (batch.vertexCount === 0) return null;
  const beauty = patchMaterial(
    new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }),
    'water',
    {
      vertHead: ROAD_VERT_HEAD,
      vertBegin: 'vRoad = aRoad;',
      vertEnd: WPOS_VERT,
      fragHead: 'varying vec3 vRoad; varying vec3 vWPos;',
      fragColor: /* glsl */ `
        float side = abs(vRoad.y);
        float ripple = 0.5 + 0.5 * sin(vRoad.z * 1.3 - uTime * 1.5 + side * 3.0);
        vec3 c = uStyle < 0.5 ? ${glc('#bcd3df')} : (uStyle < 1.5 ? ${glc('#2c4a52')} : ${glc('#0a1a2c')});
        c *= 0.97 + 0.05 * ripple;
        diffuseColor = vec4(c, (uStyle > 0.5 && uStyle < 1.5) ? 0.55 : 1.0 - smoothstep(0.8, 1.0, side) * 0.6);
      `,
    },
  );
  const machine = machineMaterial(
    'water',
    /* glsl */ `
    attribute vec3 aRoad;
    varying vec3 vRoad;
    varying vec3 vWPos;
    void main() {
      vRoad = aRoad;
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWPos = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
    /* glsl */ `
    varying vec3 vRoad;
    varying vec3 vWPos;
    void main() {
      float side = abs(vRoad.y);
      float flow = pow(fract(vRoad.z / 6.0 - uTime * 0.25), 4.0);
      vec3 col = ${glc('#03163a')} + ${MACHINE_COLORS.scan2} * (0.3 * (1.0 - side) + flow * 0.4);
      col += ${MACHINE_COLORS.scan3} * smoothstep(0.8, 1.0, side) * 0.4;
      col = mDepthTint(col, vWPos);
      gl_FragColor = vec4(col, 1.0);
      #include <colorspace_fragment>
    }`,
    {},
    { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 },
  );
  const mesh = new THREE.Mesh(batch.toGeometry(), beauty);
  mesh.name = 'waterways';
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  return { mesh, beauty, machine };
}
