import * as THREE from 'three';
import { inWorld } from '../core/geo';
import type { ICityWorld } from '../core/types';

/** terrain heights live in roughly this slab (world units), see geo.heightAt */
const SLAB_TOP = 85;
const SLAB_BOTTOM = -45;
const MARCH_STEPS = 96;
const BISECT_STEPS = 10;
/** if the mesh raycast averages more than this (ms), hover switches to the analytic heightfield */
const MESH_BUDGET_MS = 1.5;

/**
 * Ground picking. Clicks raycast world.pickables exactly; hover (30 Hz) uses the same raycast while it
 * is cheap and otherwise ray-marches the analytic heightfield (world.groundY), which is what the
 * terrain mesh is built from — O(100) height samples instead of O(triangles).
 */
export class Picker {
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly hits: THREE.Intersection[] = [];
  private readonly origin = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private meshCost = 0;
  private meshSamples = 0;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly world: ICityWorld,
  ) {}

  pick(nx: number, ny: number, out: THREE.Vector3, precise = false): boolean {
    const pickables = this.world.pickables;
    if (pickables.length > 0 && (precise || this.meshCost < MESH_BUDGET_MS)) {
      this.ndc.set(nx, ny);
      this.raycaster.setFromCamera(this.ndc, this.camera);
      const t0 = performance.now();
      this.hits.length = 0;
      this.raycaster.intersectObjects(pickables, true, this.hits);
      const cost = performance.now() - t0;
      this.meshCost = this.meshSamples++ === 0 ? cost : this.meshCost * 0.8 + cost * 0.2;
      if (this.hits.length > 0) {
        out.copy(this.hits[0].point);
        this.hits.length = 0;
        return inWorld(out.x, out.z);
      }
    }
    return this.march(nx, ny, out);
  }

  /** Ray-march the heightfield, then bisect the first sign change of (ray.y − ground). */
  private march(nx: number, ny: number, out: THREE.Vector3): boolean {
    const o = this.origin.setFromMatrixPosition(this.camera.matrixWorld);
    const d = this.dir.set(nx, ny, 0.5).unproject(this.camera).sub(o).normalize();
    if (d.y > -1e-4) return false;
    const t0 = Math.max(0, (SLAB_TOP - o.y) / d.y);
    const t1 = (SLAB_BOTTOM - o.y) / d.y;
    if (t1 <= t0) return false;
    const step = (t1 - t0) / MARCH_STEPS;
    let prev = t0;
    if (this.gap(t0) <= 0) return this.write(t0, out);
    for (let i = 1; i <= MARCH_STEPS; i++) {
      const t = t0 + step * i;
      if (this.gap(t) <= 0) {
        let lo = prev;
        let hi = t;
        for (let k = 0; k < BISECT_STEPS; k++) {
          const mid = (lo + hi) * 0.5;
          if (this.gap(mid) > 0) lo = mid;
          else hi = mid;
        }
        return this.write((lo + hi) * 0.5, out);
      }
      prev = t;
    }
    return false;
  }

  private gap(t: number): number {
    const o = this.origin;
    const d = this.dir;
    return o.y + d.y * t - this.world.groundY(o.x + d.x * t, o.z + d.z * t);
  }

  private write(t: number, out: THREE.Vector3): boolean {
    out.copy(this.dir).multiplyScalar(t).add(this.origin);
    out.y = this.world.groundY(out.x, out.z);
    return inWorld(out.x, out.z);
  }
}
