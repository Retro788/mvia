import * as THREE from 'three';
import { WORLD, WORLD_D, WORLD_W, heightAt } from '../core/geo';
import { MACHINE_COLORS, WPOS_VERT, glc, machineMaterial, patchMaterial } from './materials';

export const TER_NX = 336;
export const TER_NZ = 280;
const DX = WORLD_W / TER_NX;
const DZ = WORLD_D / TER_NZ;

/**
 * Terrain = one regular grid mesh. We build our own index buffer with a known diagonal so that
 * `sample()` reproduces the exact piecewise-planar surface the GPU rasterises — roads and objects
 * draped with it sit on the visible ground instead of the analytic heightAt().
 */
export class Terrain {
  readonly heights = new Float32Array((TER_NX + 1) * (TER_NZ + 1));
  readonly geometry: THREE.BufferGeometry;
  readonly mesh: THREE.Mesh;
  readonly beauty: THREE.MeshLambertMaterial;
  readonly machine: THREE.ShaderMaterial;

  constructor() {
    const nx = TER_NX + 1;
    const nz = TER_NZ + 1;
    const pos = new Float32Array(nx * nz * 3);
    const nor = new Float32Array(nx * nz * 3);
    const sat = new Float32Array(nx * nz * 2);
    for (let j = 0; j < nz; j++) {
      const z = WORLD.minZ + j * DZ;
      for (let i = 0; i < nx; i++) {
        const x = WORLD.minX + i * DX;
        const h = heightAt(x, z);
        const k = j * nx + i;
        this.heights[k] = h;
        pos[k * 3] = x;
        pos[k * 3 + 1] = h;
        pos[k * 3 + 2] = z;
        sat[k * 2] = i / TER_NX;
        sat[k * 2 + 1] = j / TER_NZ;
      }
    }
    // central-difference normals from the height grid
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const hl = this.heights[j * nx + Math.max(i - 1, 0)];
        const hr = this.heights[j * nx + Math.min(i + 1, nx - 1)];
        const hu = this.heights[Math.max(j - 1, 0) * nx + i];
        const hd = this.heights[Math.min(j + 1, nz - 1) * nx + i];
        const gx = (hr - hl) / (2 * DX);
        const gz = (hd - hu) / (2 * DZ);
        const inv = 1 / Math.hypot(gx, 1, gz);
        const k = (j * nx + i) * 3;
        nor[k] = -gx * inv;
        nor[k + 1] = inv;
        nor[k + 2] = -gz * inv;
      }
    }
    const idx = new Uint32Array(TER_NX * TER_NZ * 6);
    let n = 0;
    for (let j = 0; j < TER_NZ; j++) {
      for (let i = 0; i < TER_NX; i++) {
        const a = j * nx + i; // (i, j)
        const b = a + 1; // (i+1, j)
        const c = a + nx; // (i, j+1)
        const d = c + 1; // (i+1, j+1)
        // diagonal b–c; CCW seen from +y
        idx[n++] = a; idx[n++] = c; idx[n++] = b;
        idx[n++] = b; idx[n++] = c; idx[n++] = d;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('aSatUv', new THREE.BufferAttribute(sat, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    this.geometry = g;

    this.beauty = patchMaterial(new THREE.MeshLambertMaterial({ color: 0xffffff }), 'terrain', {
      uniforms: {},
      vertHead: 'attribute vec2 aSatUv; varying vec2 vSatUv; varying vec3 vWPos;',
      vertBegin: 'vSatUv = aSatUv;',
      vertEnd: WPOS_VERT,
      fragHead: 'uniform sampler2D uLanduse; uniform sampler2D uSat; uniform float uSatMode; varying vec2 vSatUv; varying vec3 vWPos; vec3 mBase; vec3 mGlow;',
      fragColor: /* glsl */ `
        vec4 lu = texture2D(uLanduse, mWorldUv(vWPos.xz));
        // faint parcel tones: per-parcel brightness jitter on a ~6-unit lattice warped by a second hash
        vec2 pc = floor(vWPos.xz / 6.0 + vec2(mHash(floor(vWPos.xz / 23.0)) * 0.7));
        float parcel = mHash(pc);
        mGlow = vec3(0.0);
        if (uStyle < 0.5) {
          mBase = ${glc('#eeede8')} * (0.982 + 0.03 * parcel);
          mBase = mix(mBase, ${glc('#dfe8d4')}, clamp(lu.r * 1.2, 0.0, 1.0));
          mBase = mix(mBase, ${glc('#cfdcc3')}, lu.g);
          mBase = mix(mBase, ${glc('#bcd3df')}, lu.b);
        } else if (uStyle < 1.5) {
          vec2 suv = uSatMode > 0.5 ? vSatUv : mWorldUv(vWPos.xz);
          mBase = texture2D(uSat, suv).rgb;
          mGlow = mBase * 0.22;
        } else {
          mBase = ${glc('#0b1018')} * (0.9 + 0.2 * parcel);
          mBase = mix(mBase, ${glc('#0d1a17')}, lu.g * 0.8);
          mBase = mix(mBase, ${glc('#0a1a2c')}, lu.b);
        }
        vec4 ov = mOverlay(vWPos.xz);
        mBase = mix(mBase, ov.rgb, ov.a);
        mGlow += ov.rgb * ov.a * (uStyle > 1.5 ? 0.35 : 0.0);
        diffuseColor.rgb = mBase;
      `,
      fragEmissive: 'totalEmissiveRadiance += mGlow;',
    });

    this.machine = machineMaterial(
      'terrain',
      /* glsl */ `
      varying vec3 vWPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
      /* glsl */ `
      uniform sampler2D uLanduse;
      varying vec3 vWPos;
      void main() {
        vec2 xz = vWPos.xz;
        float dist = length(cameraPosition - vWPos);
        vec4 lu = texture2D(uLanduse, mWorldUv(xz));
        vec3 col = mix(${MACHINE_COLORS.scan0}, ${MACHINE_COLORS.scan1}, 0.25 + 0.5 * smoothstep(-25.0, 45.0, vWPos.y));
        float g1 = max(mLine(xz.x, 10.0, 1.0), mLine(xz.y, 10.0, 1.0)) * (1.0 - smoothstep(250.0, 800.0, dist));
        float g5 = max(mLine(xz.x, 50.0, 1.3), mLine(xz.y, 50.0, 1.3)) * (1.0 - smoothstep(900.0, 2200.0, dist));
        col += ${MACHINE_COLORS.scan2} * g1 * 0.35 + ${MACHINE_COLORS.scan3} * g5 * 0.22;
        // contour every 20 m of real elevation = 3.2 world units with the 1.6× exaggeration
        float ct = mLine(vWPos.y, 3.2, 1.0);
        float ct5 = mLine(vWPos.y, 16.0, 1.2);
        col += ${MACHINE_COLORS.scan2} * ct * 0.45 + ${MACHINE_COLORS.scan3} * ct5 * 0.25;
        col = mix(col, ${glc('#020c24')}, lu.b * 0.85);
        col += ${MACHINE_COLORS.scan3} * lu.b * mLine(vWPos.x + vWPos.z, 4.0, 1.0) * 0.12;
        col += ${MACHINE_COLORS.scan2} * lu.g * 0.07;
        vec4 ov = mOverlay(xz);
        col = mix(col, ov.rgb * 0.85, ov.a * 0.55);
        col = mDepthTint(col, vWPos);
        col += ${MACHINE_COLORS.scan3} * mRings(xz) * 0.9;
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
    );

    this.mesh = new THREE.Mesh(g, this.beauty);
    this.mesh.name = 'terrain';
    this.mesh.receiveShadow = true;
    this.mesh.matrixAutoUpdate = false;
  }

  /** exact height of the rendered terrain surface (falls back to heightAt outside the grid) */
  sample(x: number, z: number): number {
    const fx = (x - WORLD.minX) / DX;
    const fz = (z - WORLD.minZ) / DZ;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= TER_NX || j >= TER_NZ) return heightAt(x, z);
    const u = fx - i;
    const v = fz - j;
    const nx = TER_NX + 1;
    const k = j * nx + i;
    const h00 = this.heights[k];
    const h10 = this.heights[k + 1];
    const h01 = this.heights[k + nx];
    const h11 = this.heights[k + nx + 1];
    // two triangles split along the (1,0)–(0,1) diagonal
    if (u + v <= 1) return h00 + (h10 - h00) * u + (h01 - h00) * v;
    return h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
  }
}
