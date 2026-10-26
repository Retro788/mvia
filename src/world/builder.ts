import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Tiny CSG-free modeller: accumulates transformed primitives with a per-vertex colour and merges them
 * into ONE geometry (one draw call for all landmarks, one for all establishments).
 */
export class GeoBuilder {
  private parts: THREE.BufferGeometry[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private p = new THREE.Vector3();
  private e = new THREE.Euler();
  private c = new THREE.Color();

  get size(): number {
    return this.parts.length;
  }

  add(geo: THREE.BufferGeometry, x: number, y: number, z: number, rotY: number, sx: number, sy: number, sz: number, color: string | number): void {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    this.e.set(0, rotY, 0);
    this.q.setFromEuler(this.e);
    this.s.set(sx, sy, sz);
    this.p.set(x, y, z);
    this.m.compose(this.p, this.q, this.s);
    g.applyMatrix4(this.m);
    this.c.set(color);
    const n = g.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
      col[k * 3] = this.c.r;
      col[k * 3 + 1] = this.c.g;
      col[k * 3 + 2] = this.c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    this.parts.push(g);
  }

  /** box with its base at y (w along local x, d along local z) */
  box(x: number, y: number, z: number, w: number, h: number, d: number, rotY: number, color: string | number): void {
    this.add(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), x, y, z, rotY, w, h, d, color);
  }

  cyl(x: number, y: number, z: number, rTop: number, rBot: number, h: number, seg: number, color: string | number, sx = 1, sz = 1, open = false): void {
    this.add(new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open).translate(0, h / 2, 0), x, y, z, 0, sx, 1, sz, color);
  }

  sphere(x: number, y: number, z: number, r: number, color: string | number, detail = 1): void {
    this.add(new THREE.IcosahedronGeometry(r, detail), x, y, z, 0, 1, 1, 1, color);
  }

  cone(x: number, y: number, z: number, r: number, h: number, seg: number, color: string | number): void {
    this.add(new THREE.ConeGeometry(r, h, seg).translate(0, h / 2, 0), x, y, z, 0, 1, 1, 1, color);
  }

  /** merges and disposes the parts; returns null when empty */
  build(): THREE.BufferGeometry | null {
    if (!this.parts.length) return null;
    const merged = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts = [];
    if (merged) merged.computeBoundingSphere();
    return merged;
  }
}

/** rotate a local offset (lx along heading, lz across) into world */
export function local(cx: number, cz: number, rot: number, lx: number, lz: number): [number, number] {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  // matches Object3D rotation.y = rot: local x → (c, -s), local z → (s, c)
  return [cx + lx * c + lz * s, cz - lx * s + lz * c];
}
