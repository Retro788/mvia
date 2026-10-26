import * as THREE from 'three';
import type { MapData } from '../core/types';
import { rng } from '../core/geo';
import { BOX_EDGE_GLSL, MACHINE_COLORS, WPOS_VERT, glc, machineMaterial, patchMaterial } from './materials';
import { ROAD_WIDTH } from './roads';

const N_CARS = 1200;
const N_BUSES = 80;

/**
 * CPU traffic: vehicles ping-pong along arterial polylines. Paths are flattened into typed arrays
 * (x, y, z per point + cumulative length); each frame we advance `s`, walk the cached segment index and
 * write the 16-float instance matrix in place — no allocations, ~1.3k vehicles ≈ 0.1 ms.
 */
export class Traffic {
  readonly cars: THREE.InstancedMesh;
  readonly buses: THREE.InstancedMesh;
  readonly beauty: THREE.MeshLambertMaterial;
  readonly machine: THREE.ShaderMaterial;
  private px: Float32Array;
  private py: Float32Array;
  private pz: Float32Array;
  private cum: Float32Array;
  private pathStart: Int32Array;
  private pathEnd: Int32Array; // index of last point
  private pathLane: Float32Array;
  // vehicle state
  private vPath: Int32Array;
  private vSeg: Int32Array;
  private vS: Float32Array;
  private vSpeed: Float32Array;
  private vDir: Float32Array;
  readonly count: number;

  constructor(map: MapData, ground: (x: number, z: number) => number) {
    const rand = rng(4242);
    const roads = map.roads.filter(
      (r) => (r.cls === 'motorway' || r.cls === 'trunk' || r.cls === 'primary' || r.cls === 'secondary') && r.points.length >= 2,
    );
    // flatten + densify (≤ 3 units) so the per-point y follows the terrain
    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    const cum: number[] = [];
    const starts: number[] = [];
    const ends: number[] = [];
    const lanes: number[] = [];
    const lengths: number[] = [];
    for (const r of roads) {
      const s0 = xs.length;
      let acc = 0;
      for (let k = 0; k < r.points.length; k++) {
        const p = r.points[k];
        if (k > 0) {
          const q = r.points[k - 1];
          const len = Math.hypot(p.x - q.x, p.z - q.z);
          if (len < 1e-3) continue;
          const n = Math.ceil(len / 3);
          for (let s = 1; s <= n; s++) {
            const x = q.x + ((p.x - q.x) * s) / n;
            const z = q.z + ((p.z - q.z) * s) / n;
            acc += len / n;
            xs.push(x); zs.push(z); ys.push(ground(x, z) + 0.12); cum.push(acc);
          }
        } else {
          xs.push(p.x); zs.push(p.z); ys.push(ground(p.x, p.z) + 0.12); cum.push(0);
        }
      }
      if (xs.length - s0 < 2 || acc < 15) {
        xs.length = ys.length = zs.length = cum.length = s0;
        continue;
      }
      starts.push(s0);
      ends.push(xs.length - 1);
      lanes.push(ROAD_WIDTH[r.cls] * 0.26);
      lengths.push(acc);
    }
    this.px = Float32Array.from(xs);
    this.py = Float32Array.from(ys);
    this.pz = Float32Array.from(zs);
    this.cum = Float32Array.from(cum);
    this.pathStart = Int32Array.from(starts);
    this.pathEnd = Int32Array.from(ends);
    this.pathLane = Float32Array.from(lanes);

    const nPaths = starts.length;
    const total = nPaths ? N_CARS + N_BUSES : 0;
    this.count = total;
    this.vPath = new Int32Array(total);
    this.vSeg = new Int32Array(total);
    this.vS = new Float32Array(total);
    this.vSpeed = new Float32Array(total);
    this.vDir = new Float32Array(total);
    // distribute vehicles proportionally to path length (binary search on the length CDF)
    const cdf = new Float32Array(nPaths);
    let sum = 0;
    for (let p = 0; p < nPaths; p++) cdf[p] = sum += lengths[p];
    for (let v = 0; v < total; v++) {
      const t = rand() * sum;
      let lo = 0;
      let hi = nPaths - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cdf[mid] < t) lo = mid + 1;
        else hi = mid;
      }
      this.vPath[v] = lo;
      const L = lengths[lo];
      this.vS[v] = rand() * L;
      this.vSeg[v] = this.pathStart[lo];
      this.vDir[v] = rand() < 0.5 ? 1 : -1;
      this.vSpeed[v] = (v >= N_CARS ? 1.7 : 2.2 + rand() * 2.2) * (this.pathLane[lo] > 0.45 ? 1.35 : 1); // units/s (time-lapse)
    }

    this.beauty = patchMaterial(new THREE.MeshLambertMaterial({ color: 0xffffff }), 'vehicle', {
      vertHead: 'varying vec3 vLocal; varying vec3 vObjN; varying vec3 vWPos; varying vec3 vScale;',
      vertBegin: `vLocal = position; vObjN = normal;
        #ifdef USE_INSTANCING
        vScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        #else
        vScale = vec3(1.0);
        #endif`,
      vertEnd: WPOS_VERT,
      fragHead: `${BOX_EDGE_GLSL} varying vec3 vLocal; varying vec3 vObjN; varying vec3 vWPos; varying vec3 vScale; vec3 mLamp;`,
      fragColor: /* glsl */ `
        float edge = mBoxEdge(vLocal, vScale, vObjN, 0.05);
        mLamp = vec3(0.0);
        vec3 c = diffuseColor.rgb;
        if (uStyle > 0.5 && uStyle < 1.5) c *= 0.8;
        if (uStyle > 1.5) {
          c = ${glc('#1c222c')};
          // headlights on the front face, tail lights on the back face
          float front = step(0.45, vLocal.z) * step(0.25, vLocal.y);
          float back = step(vLocal.z, -0.45) * step(0.25, vLocal.y);
          mLamp = ${glc('#fff2d0')} * front * 2.2 + ${glc('#ff2a2a')} * back * 1.4;
        }
        diffuseColor.rgb = c * (1.0 - 0.15 * edge);
      `,
      fragEmissive: 'totalEmissiveRadiance += mLamp;',
    });
    this.machine = machineMaterial(
      'vehicle',
      /* glsl */ `
      varying vec3 vWPos;
      varying vec3 vLocal;
      void main() {
        vLocal = position;
        vec4 wp = vec4(position, 1.0);
        #ifdef USE_INSTANCING
        wp = instanceMatrix * wp;
        #endif
        wp = modelMatrix * wp;
        vWPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
      /* glsl */ `
      varying vec3 vWPos;
      varying vec3 vLocal;
      void main() {
        vec3 col = mix(${MACHINE_COLORS.scan4}, vec3(1.0), 0.5) * (0.85 + 0.3 * step(0.99, vLocal.y));
        col += ${glc('#ff8a2b')} * step(vLocal.z, -0.42) * 0.8;
        gl_FragColor = vec4(col * 1.3, 1.0);
        #include <colorspace_fragment>
      }`,
    );

    const carGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    this.cars = new THREE.InstancedMesh(carGeo, this.beauty, Math.max(1, Math.min(total, N_CARS)));
    this.buses = new THREE.InstancedMesh(carGeo, this.beauty, N_BUSES);
    this.cars.count = Math.min(total, N_CARS);
    this.buses.count = Math.max(0, total - N_CARS);
    for (const m of [this.cars, this.buses]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = true;
    }
    this.cars.name = 'traffic-cars';
    this.buses.name = 'traffic-buses';
    const col = new THREE.Color();
    for (let v = 0; v < this.cars.count; v++) {
      const r = rand();
      col.set(r < 0.72 ? '#f7f7f4' : r < 0.84 ? '#d9dadc' : r < 0.92 ? '#c9d6e4' : '#e7d6c9');
      this.cars.setColorAt(v, col);
    }
    for (let v = 0; v < this.buses.count; v++) this.buses.setColorAt(v, col.set(v % 3 === 0 ? '#f3e6c4' : '#eef1f4'));
    this.update(0);
  }

  update(dt: number): void {
    const step = Math.min(dt, 0.1);
    const carArr = this.cars.instanceMatrix.array as Float32Array;
    const busArr = this.buses.instanceMatrix.array as Float32Array;
    const { px, py, pz, cum } = this;
    for (let v = 0; v < this.count; v++) {
      const p = this.vPath[v];
      const a = this.pathStart[p];
      const b = this.pathEnd[p];
      const L = cum[b];
      let s = this.vS[v] + this.vSpeed[v] * step * this.vDir[v];
      // ping-pong at path ends (U-turn → switches to the opposite lane)
      if (s > L) {
        s = 2 * L - s;
        this.vDir[v] = -1;
      } else if (s < 0) {
        s = -s;
        this.vDir[v] = 1;
      }
      this.vS[v] = s;
      let k = this.vSeg[v];
      if (k < a || k >= b) k = a;
      while (k < b - 1 && cum[k + 1] < s) k++;
      while (k > a && cum[k] > s) k--;
      this.vSeg[v] = k;
      const segLen = cum[k + 1] - cum[k] || 1;
      const f = (s - cum[k]) / segLen;
      let tx = (px[k + 1] - px[k]) / segLen;
      let tz = (pz[k + 1] - pz[k]) / segLen;
      const d = this.vDir[v];
      // right-hand traffic: offset to the right of the travel direction
      const lane = this.pathLane[p];
      const x = px[k] + (px[k + 1] - px[k]) * f - tz * lane * d;
      const z = pz[k] + (pz[k + 1] - pz[k]) * f + tx * lane * d;
      const y = py[k] + (py[k + 1] - py[k]) * f;
      tx *= d;
      tz *= d;
      const bus = v >= N_CARS;
      const arr = bus ? busArr : carArr;
      const o = (bus ? v - N_CARS : v) * 16;
      const sw = bus ? 0.55 : 0.42;
      const sh = bus ? 0.5 : 0.3;
      const sl = bus ? 2.1 : 0.85;
      // local z (length) → travel dir (tx,tz); local x → (tz, -tx)
      arr[o] = tz * sw; arr[o + 1] = 0; arr[o + 2] = -tx * sw; arr[o + 3] = 0;
      arr[o + 4] = 0; arr[o + 5] = sh; arr[o + 6] = 0; arr[o + 7] = 0;
      arr[o + 8] = tx * sl; arr[o + 9] = 0; arr[o + 10] = tz * sl; arr[o + 11] = 0;
      arr[o + 12] = x; arr[o + 13] = y; arr[o + 14] = z; arr[o + 15] = 1;
    }
    this.cars.instanceMatrix.needsUpdate = true;
    this.buses.instanceMatrix.needsUpdate = true;
  }
}
