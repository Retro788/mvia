import * as THREE from 'three';
import { WORLD } from '../core/geo';
import type { CameraState, FlyToOptions } from '../core/types';

/** zoom ∈ [0,1] maps exponentially to orbit distance [DIST_MAX → DIST_MIN] world units */
export const DIST_MAX = 1900;
export const DIST_MIN = 35;
const LN_RANGE = Math.log(DIST_MAX / DIST_MIN);
export const PITCH_MAX = 76;
const DEG = Math.PI / 180;

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
/** frame-rate independent exponential smoothing factor */
const damp = (k: number, dt: number): number => 1 - Math.exp(-k * dt);
const wrap180 = (d: number): number => ((((d + 180) % 360) + 360) % 360) - 180;
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const easeInOutCubic = (u: number): number => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);

export function zoomToDistance(zoom: number): number {
  return DIST_MAX * Math.exp(-zoom * LN_RANGE);
}

/** Ground pick under an NDC point; writes the hit and returns true, false if off-map. */
export type GroundPick = (ndcX: number, ndcY: number, out: THREE.Vector3) => boolean;

interface Flight {
  from: CameraState;
  to: CameraState;
  t: number;
  dur: number;
  /** extra zoom-out at mid flight (Mapbox-style arc) */
  arc: number;
}

/**
 * Mapbox-GL-like orbit rig around a ground target.
 * State: target (x,z) with y following the terrain, zoom, pitch (0 = top-down), bearing (0 = north up,
 * clockwise). Pan is a true "grab" (the ground point under the cursor stays under it) with release
 * inertia; zoom/pitch/bearing ease toward goals; wheel zoom keeps the cursor point fixed throughout
 * the eased animation.
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  x = 0;
  z = 0;
  y = 0;
  zoom = 0.42;
  pitch = 58;
  bearing = -18;
  /** true when the camera matrix changed during the last update */
  moved = true;

  private readonly goal = { zoom: 0.42, pitch: 58, bearing: -18 };
  private readonly vel = new THREE.Vector2(); // pan inertia, world units / s
  private flight: Flight | null = null;
  private readonly zoomAnchor = { active: false, ndc: new THREE.Vector2(), world: new THREE.Vector3() };
  private readonly pan = { active: false, anchor: new THREE.Vector3(), lastT: 0 };
  private readonly pinch = { zoom0: 0, bearing0: 0, d0: 1, a0: 0, anchor: new THREE.Vector3(), ok: false };
  private readonly origin = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly lastMatrix = new THREE.Matrix4();
  private ySnapped = false;

  constructor(
    private readonly groundY: (x: number, z: number) => number,
    private readonly pickGround: GroundPick,
  ) {
    this.camera = new THREE.PerspectiveCamera(35, 1, 1, 6000);
    this.camera.rotation.order = 'YXZ';
  }

  // ───────────────────────── state ─────────────────────────
  setState(s: CameraState): void {
    this.flight = null;
    this.x = s.x;
    this.z = s.z;
    this.zoom = this.goal.zoom = clamp(s.zoom, 0, 1);
    this.pitch = this.goal.pitch = clamp(s.pitch, 0, PITCH_MAX);
    this.bearing = this.goal.bearing = s.bearing;
    this.vel.set(0, 0);
    this.clampTarget();
    this.y = this.groundY(this.x, this.z);
    this.ySnapped = true;
    this.apply();
  }

  getState(): CameraState {
    return { x: this.x, z: this.z, zoom: this.zoom, pitch: this.pitch, bearing: wrap180(this.bearing) };
  }

  get distance(): number {
    return zoomToDistance(this.zoom);
  }

  get interacting(): boolean {
    return this.pan.active;
  }

  /** max pitch grows with zoom: no horizon-staring from orbit height */
  private maxPitch(zoom: number): number {
    const t = clamp(zoom / 0.3, 0, 1);
    return lerp(58, PITCH_MAX, t * t * (3 - 2 * t));
  }

  private clampTarget(): void {
    this.x = clamp(this.x, WORLD.minX, WORLD.maxX);
    this.z = clamp(this.z, WORLD.minZ, WORLD.maxZ);
  }

  // ───────────────────────── per frame ─────────────────────────
  update(dt: number): void {
    if (this.flight) {
      this.stepFlight(dt);
    } else {
      if (!this.pan.active) {
        const sp = this.vel.length();
        if (sp > 0.02) {
          this.x += this.vel.x * dt;
          this.z += this.vel.y * dt;
          this.vel.multiplyScalar(Math.exp(-4.2 * dt));
        } else this.vel.set(0, 0);
      }
      this.goal.pitch = clamp(this.goal.pitch, 0, this.maxPitch(this.goal.zoom));
      const k = damp(11, dt);
      this.zoom += (this.goal.zoom - this.zoom) * k;
      this.pitch += (this.goal.pitch - this.pitch) * k;
      this.bearing += (this.goal.bearing - this.bearing) * k;
    }
    // keep bearing values bounded without visible jumps
    if (Math.abs(this.bearing) > 540) {
      const w = 360 * Math.round(this.bearing / 360);
      this.bearing -= w;
      this.goal.bearing -= w;
    }
    this.clampTarget();
    const gy = this.groundY(this.x, this.z);
    this.y = this.ySnapped ? this.y + (gy - this.y) * damp(6, dt) : gy;
    this.ySnapped = true;
    this.apply();

    // wheel zoom: re-anchor so the world point under the cursor stays under it during the ease
    const za = this.zoomAnchor;
    if (za.active && !this.pan.active) {
      if (this.planeHit(za.ndc.x, za.ndc.y, za.world.y, this.tmp)) {
        this.x += za.world.x - this.tmp.x;
        this.z += za.world.z - this.tmp.z;
        this.clampTarget();
        this.apply();
      }
      if (Math.abs(this.goal.zoom - this.zoom) < 2e-4) za.active = false;
    }

    const e = this.camera.matrixWorld.elements;
    const l = this.lastMatrix.elements;
    let diff = 0;
    for (let i = 0; i < 16; i++) diff += Math.abs(e[i] - l[i]);
    this.moved = diff > 1e-5;
    if (this.moved) this.lastMatrix.copy(this.camera.matrixWorld);
  }

  /** Place the camera from the current state (immediately, no smoothing). */
  apply(): void {
    const cam = this.camera;
    const d = zoomToDistance(this.zoom);
    const p = this.pitch * DEG;
    const b = this.bearing * DEG;
    const sb = Math.sin(b);
    const cb = Math.cos(b);
    const horiz = d * Math.sin(p);
    // forward on the ground is (sin b, −cos b); the camera sits behind the target
    const px = this.x - sb * horiz;
    const pz = this.z + cb * horiz;
    let py = this.y + d * Math.cos(p);
    const floor = this.groundY(px, pz) + 2.5;
    if (py < floor) py = floor;
    cam.position.set(px, py, pz);
    cam.rotation.set(-(Math.PI / 2 - p), -b, 0, 'YXZ');
    const near = clamp(d * 0.025, 0.5, 40);
    const far = clamp(d * 14, 1500, 7000);
    if (Math.abs(cam.near - near) > near * 0.02 || Math.abs(cam.far - far) > far * 0.02) {
      cam.near = near;
      cam.far = far;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld(true);
  }

  /** Intersect the view ray through an NDC point with the horizontal plane y = h. */
  planeHit(nx: number, ny: number, h: number, out: THREE.Vector3): boolean {
    const cam = this.camera;
    this.origin.setFromMatrixPosition(cam.matrixWorld);
    this.dir.set(nx, ny, 0.5).unproject(cam).sub(this.origin).normalize();
    const dy = this.dir.y;
    if (dy > -0.02) return false; // at/above the horizon: grazing hits explode
    const t = (h - this.origin.y) / dy;
    if (t <= 0) return false;
    out.copy(this.dir).multiplyScalar(t).add(this.origin);
    return true;
  }

  // ───────────────────────── gestures ─────────────────────────
  private interrupt(): void {
    if (this.flight) {
      this.goal.zoom = this.zoom;
      this.goal.pitch = this.pitch;
      this.goal.bearing = this.bearing;
      this.flight = null;
    }
  }

  beginPan(nx: number, ny: number): void {
    this.interrupt();
    this.zoomAnchor.active = false;
    this.vel.set(0, 0);
    const a = this.pan.anchor;
    this.pan.active = this.pickGround(nx, ny, a) || this.planeHit(nx, ny, this.y, a);
    this.pan.lastT = performance.now();
  }

  movePan(nx: number, ny: number): void {
    if (!this.pan.active || !this.planeHit(nx, ny, this.pan.anchor.y, this.tmp)) return;
    let dx = this.pan.anchor.x - this.tmp.x;
    let dz = this.pan.anchor.z - this.tmp.z;
    const lim = zoomToDistance(this.zoom) * 1.5;
    const len = Math.hypot(dx, dz);
    if (len > lim) {
      dx *= lim / len;
      dz *= lim / len;
    }
    const px = this.x;
    const pz = this.z;
    this.x += dx;
    this.z += dz;
    this.clampTarget();
    this.apply();
    const now = performance.now();
    const dts = Math.max(4, now - this.pan.lastT) / 1000;
    this.pan.lastT = now;
    // EMA of the drag velocity → release inertia
    const a = 0.4;
    this.vel.x += ((this.x - px) / dts - this.vel.x) * a;
    this.vel.y += ((this.z - pz) / dts - this.vel.y) * a;
  }

  endPan(): void {
    if (!this.pan.active) return;
    this.pan.active = false;
    if (performance.now() - this.pan.lastT > 90) this.vel.set(0, 0); // held still before release
    const cap = zoomToDistance(this.zoom) * 4;
    if (this.vel.length() > cap) this.vel.setLength(cap);
  }

  /** right-drag / ctrl-drag: horizontal → bearing, vertical → pitch (px deltas) */
  rotateDrag(dx: number, dy: number): void {
    this.interrupt();
    this.goal.bearing += dx * 0.4;
    this.goal.pitch = clamp(this.goal.pitch - dy * 0.32, 0, this.maxPitch(this.goal.zoom));
  }

  /** wheel / double-click: eased zoom that keeps the point under the cursor fixed */
  zoomAt(nx: number, ny: number, dz: number): void {
    this.interrupt();
    this.goal.zoom = clamp(this.goal.zoom + dz, 0, 1);
    const za = this.zoomAnchor;
    za.active = this.pickGround(nx, ny, za.world);
    za.ndc.set(nx, ny);
  }

  beginPinch(nx: number, ny: number, distPx: number, angle: number): void {
    this.interrupt();
    this.pan.active = false;
    this.zoomAnchor.active = false;
    this.vel.set(0, 0);
    const p = this.pinch;
    p.zoom0 = this.zoom;
    p.bearing0 = this.bearing;
    p.d0 = Math.max(1, distPx);
    p.a0 = angle;
    p.ok = this.pickGround(nx, ny, p.anchor) || this.planeHit(nx, ny, this.y, p.anchor);
  }

  movePinch(nx: number, ny: number, distPx: number, angle: number): void {
    const p = this.pinch;
    this.zoom = this.goal.zoom = clamp(p.zoom0 + Math.log(Math.max(1, distPx) / p.d0) / LN_RANGE, 0, 1);
    this.bearing = this.goal.bearing = p.bearing0 - (angle - p.a0) / DEG;
    this.apply();
    if (p.ok && this.planeHit(nx, ny, p.anchor.y, this.tmp)) {
      this.x += p.anchor.x - this.tmp.x;
      this.z += p.anchor.z - this.tmp.z;
      this.clampTarget();
      this.apply();
    }
  }

  // ───────────────────────── programmatic ─────────────────────────
  zoomBy(dz: number): void {
    this.interrupt();
    this.zoomAnchor.active = false;
    this.goal.zoom = clamp(this.goal.zoom + dz, 0, 1);
  }

  rotateBy(deg: number): void {
    this.interrupt();
    this.goal.bearing += deg;
  }

  setPitch(deg: number): void {
    this.interrupt();
    this.goal.pitch = clamp(deg, 0, this.maxPitch(this.goal.zoom));
  }

  resetNorth(): void {
    this.interrupt();
    this.goal.bearing = this.bearing - wrap180(this.bearing);
  }

  /** keyboard: impulse in screen-relative directions (right, forward), scaled by view distance */
  panImpulse(right: number, forward: number): void {
    this.interrupt();
    const d = zoomToDistance(this.zoom);
    const b = this.bearing * DEG;
    const fx = Math.sin(b);
    const fz = -Math.cos(b);
    const rx = Math.cos(b);
    const rz = Math.sin(b);
    this.vel.x += (rx * right + fx * forward) * d * 1.3;
    this.vel.y += (rz * right + fz * forward) * d * 1.3;
  }

  flyTo(o: FlyToOptions): void {
    const from = { x: this.x, z: this.z, zoom: this.zoom, pitch: this.pitch, bearing: this.bearing };
    const toZoom = clamp(o.zoom ?? (this.flight ? this.flight.to.zoom : this.goal.zoom), 0, 1);
    const toBearing = o.bearing ?? (this.flight ? this.flight.to.bearing : this.goal.bearing);
    const to: CameraState = {
      x: clamp(o.x, WORLD.minX, WORLD.maxX),
      z: clamp(o.z, WORLD.minZ, WORLD.maxZ),
      zoom: toZoom,
      pitch: clamp(o.pitch ?? (this.flight ? this.flight.to.pitch : this.goal.pitch), 0, this.maxPitch(toZoom)),
      bearing: from.bearing + wrap180(toBearing - from.bearing), // shortest turn
    };
    const travel = Math.hypot(to.x - from.x, to.z - from.z);
    const screens = travel / Math.max(1, zoomToDistance(Math.min(from.zoom, to.zoom)));
    const arc = clamp(Math.log2(1 + screens) * 0.09, 0, 0.32);
    const auto = 1.1 + Math.sqrt(screens) * 0.55 + Math.abs(to.zoom - from.zoom) * 0.9;
    const dur = Math.max(0.05, o.duration ?? clamp(auto, 1.1, 3.4));
    this.flight = { from, to, t: 0, dur, arc };
    this.vel.set(0, 0);
    this.zoomAnchor.active = false;
    this.pan.active = false;
  }

  private stepFlight(dt: number): void {
    const f = this.flight!;
    f.t += dt;
    const u = clamp(f.t / f.dur, 0, 1);
    const e = easeInOutCubic(u);
    this.x = lerp(f.from.x, f.to.x, e);
    this.z = lerp(f.from.z, f.to.z, e);
    this.zoom = clamp(lerp(f.from.zoom, f.to.zoom, e) - f.arc * Math.sin(Math.PI * u), 0, 1);
    this.pitch = lerp(f.from.pitch, f.to.pitch, e);
    this.bearing = lerp(f.from.bearing, f.to.bearing, e);
    this.goal.zoom = this.zoom;
    this.goal.pitch = this.pitch;
    this.goal.bearing = this.bearing;
    if (u >= 1) this.flight = null;
  }
}
