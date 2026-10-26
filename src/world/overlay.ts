import * as THREE from 'three';
import type { LayerId } from '../core/types';
import { GRID } from '../core/geo';
import { U, machineMaterial } from './materials';

/** layer → ramp index used by mOverlay() in materials.ts */
const KIND: Record<Exclude<LayerId, 'none'>, number> = {
  landValue: 0,
  mortgage: 0,
  creditRisk: 1,
  floodRisk: 1,
  growth: 2,
  commercial: 3,
  density: 4,
};

/** Sim field (rows×cols, 0..1) → R8 DataTexture sampled by world xz in terrain/building shaders. */
export class Overlay {
  private data = new Uint8Array(GRID.cols * GRID.rows);
  readonly texture: THREE.DataTexture;

  constructor() {
    this.texture = new THREE.DataTexture(this.data, GRID.cols, GRID.rows, THREE.RedFormat, THREE.UnsignedByteType);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.flipY = false;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
    U.uOverlay.value = this.texture;
  }

  set(layer: LayerId, field: Float32Array | null): void {
    if (layer === 'none' || !field) {
      U.uOverlayOn.value = 0;
      return;
    }
    const n = Math.min(field.length, this.data.length);
    for (let k = 0; k < n; k++) {
      const v = field[k];
      this.data[k] = v > 0 ? (v >= 1 ? 255 : (v * 255) | 0) : 0;
    }
    this.texture.needsUpdate = true;
    U.uOverlayKind.value = KIND[layer];
    U.uOverlayOn.value = 1;
  }
}

/** Selection marker: pulsing orange ground ring + vertical light beam (same material in both passes). */
export class SelectionMarker {
  readonly group = new THREE.Group();
  readonly materials: THREE.Material[];

  constructor() {
    const ringMat = machineMaterial(
      'sel-ring',
      /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWPos;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
      /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWPos;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        float t = fract(uTime * 0.7);
        float ring = smoothstep(0.86, 0.9, r) * (1.0 - smoothstep(0.94, 0.98, r));
        float inner = smoothstep(0.3, 0.33, r) * (1.0 - smoothstep(0.36, 0.39, r));
        float pulse = smoothstep(t - 0.05, t, r) * (1.0 - smoothstep(t, t + 0.02, r)) * (1.0 - t);
        float dot0 = 1.0 - smoothstep(0.05, 0.08, r);
        // tick marks every 30°
        float ang = atan(vUv.y - 0.5, vUv.x - 0.5);
        float ticks = step(0.92, abs(cos(ang * 6.0))) * step(0.72, r) * (1.0 - step(0.82, r));
        float a = max(max(ring, inner * 0.8), max(pulse, max(dot0, ticks * 0.9)));
        if (a < 0.01) discard;
        gl_FragColor = vec4(${'vec3(1.0, 0.42, 0.13)'} * 1.15, a);
        #include <colorspace_fragment>
      }`,
      {},
      { transparent: true, depthWrite: false, depthTest: false },
    );
    const beamMat = machineMaterial(
      'sel-beam',
      /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
      }`,
      /* glsl */ `
      varying vec2 vUv;
      void main() {
        float a = (1.0 - vUv.y) * 0.55 * (0.8 + 0.2 * sin(uTime * 6.0 + vUv.y * 20.0));
        gl_FragColor = vec4(vec3(1.0, 0.45, 0.15) * 1.3, a);
        #include <colorspace_fragment>
      }`,
      {},
      { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide },
    );
    const ring = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), ringMat);
    ring.scale.setScalar(14);
    ring.renderOrder = 10;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 60, 12, 1, true).translate(0, 30, 0), beamMat);
    beam.renderOrder = 9;
    this.group.add(ring, beam);
    this.group.visible = false;
    this.group.name = 'selection';
    this.materials = [ringMat, beamMat];
  }

  set(p: { x: number; z: number } | null, y: number): void {
    if (!p) {
      this.group.visible = false;
      return;
    }
    this.group.position.set(p.x, y + 0.3, p.z);
    this.group.visible = true;
  }
}
