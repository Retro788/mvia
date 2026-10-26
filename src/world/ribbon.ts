import * as THREE from 'three';
import type { Vec2 } from '../core/types';

/** Growable typed buffers to merge thousands of ribbons into a single geometry without GC churn. */
export class FloatBuf {
  a: Float32Array;
  n = 0;
  constructor(cap = 1024) {
    this.a = new Float32Array(cap);
  }
  reserve(extra: number): void {
    if (this.n + extra <= this.a.length) return;
    let cap = this.a.length * 2;
    while (cap < this.n + extra) cap *= 2;
    const b = new Float32Array(cap);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
  push3(x: number, y: number, z: number): void {
    this.reserve(3);
    this.a[this.n++] = x;
    this.a[this.n++] = y;
    this.a[this.n++] = z;
  }
  push1(x: number): void {
    this.reserve(1);
    this.a[this.n++] = x;
  }
  view(): Float32Array {
    return this.a.slice(0, this.n);
  }
}

export class IndexBuf {
  a: Uint32Array;
  n = 0;
  constructor(cap = 1024) {
    this.a = new Uint32Array(cap);
  }
  push3(x: number, y: number, z: number): void {
    if (this.n + 3 > this.a.length) {
      const b = new Uint32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = x;
    this.a[this.n++] = y;
    this.a[this.n++] = z;
  }
  view(): Uint32Array {
    return this.a.slice(0, this.n);
  }
}

/**
 * Ribbon batch: polylines → draped triangle strips. Each vertex carries aRoad = (class, side −1|+1, along distance)
 * so shaders can draw casings, centre dashes and flowing light without extra geometry.
 */
export class RibbonBatch {
  pos = new FloatBuf(4096);
  attr = new FloatBuf(4096);
  /** optional per-vertex year (growth streets) */
  year = new FloatBuf(16);
  idx = new IndexBuf(4096);
  private xs: number[] = [];
  private zs: number[] = [];

  get vertexCount(): number {
    return this.pos.n / 3;
  }

  add(points: Vec2[], halfW: number, yOff: number, cls: number, ground: (x: number, z: number) => number, step = 3, year?: number): void {
    const xs = this.xs;
    const zs = this.zs;
    xs.length = 0;
    zs.length = 0;
    for (let k = 0; k < points.length; k++) {
      const p = points[k];
      if (k > 0) {
        const q = points[k - 1];
        const len = Math.hypot(p.x - q.x, p.z - q.z);
        if (len < 1e-3) continue;
        const n = Math.ceil(len / step);
        for (let s = 1; s < n; s++) {
          xs.push(q.x + ((p.x - q.x) * s) / n);
          zs.push(q.z + ((p.z - q.z) * s) / n);
        }
      }
      xs.push(p.x);
      zs.push(p.z);
    }
    const n = xs.length;
    if (n < 2) return;
    const base = this.vertexCount;
    let along = 0;
    for (let k = 0; k < n; k++) {
      // averaged tangent with a miter clamp
      const ax = k > 0 ? xs[k] - xs[k - 1] : xs[k + 1] - xs[k];
      const az = k > 0 ? zs[k] - zs[k - 1] : zs[k + 1] - zs[k];
      const bx = k < n - 1 ? xs[k + 1] - xs[k] : ax;
      const bz = k < n - 1 ? zs[k + 1] - zs[k] : az;
      const la = Math.hypot(ax, az) || 1;
      const lb = Math.hypot(bx, bz) || 1;
      let tx = ax / la + bx / lb;
      let tz = az / la + bz / lb;
      const lt = Math.hypot(tx, tz) || 1;
      tx /= lt;
      tz /= lt;
      const miter = Math.min(1 / Math.max((ax / la) * tx + (az / la) * tz, 0.5), 2);
      const nx = -tz * halfW * miter;
      const nz = tx * halfW * miter;
      if (k > 0) along += la;
      const lx = xs[k] + nx;
      const lz = zs[k] + nz;
      const rx = xs[k] - nx;
      const rz = zs[k] - nz;
      this.pos.push3(lx, ground(lx, lz) + yOff, lz);
      this.pos.push3(rx, ground(rx, rz) + yOff, rz);
      this.attr.push3(cls, 1, along);
      this.attr.push3(cls, -1, along);
      if (year !== undefined) {
        this.year.push1(year);
        this.year.push1(year);
      }
    }
    for (let k = 0; k < n - 1; k++) {
      const l0 = base + k * 2;
      const r0 = l0 + 1;
      const l1 = l0 + 2;
      const r1 = l0 + 3;
      this.idx.push3(l0, l1, r0);
      this.idx.push3(r0, l1, r1);
    }
  }

  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    const pos = this.pos.view();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const nor = new Float32Array(pos.length);
    for (let k = 1; k < nor.length; k += 3) nor[k] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('aRoad', new THREE.BufferAttribute(this.attr.view(), 3));
    if (this.year.n > 0) g.setAttribute('aYear', new THREE.BufferAttribute(this.year.view(), 1));
    g.setIndex(new THREE.BufferAttribute(this.idx.view(), 1));
    g.computeBoundingSphere();
    return g;
  }
}
