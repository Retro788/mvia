import * as THREE from 'three';
import type { Establishment, EstablishmentType } from '../core/types';
import { GeoBuilder, local } from './builder';
import { solidBeautyMaterial, solidMachineMaterial } from './landmarks';
import { machineMaterial } from './materials';

export const EST_COLORS: Record<EstablishmentType, string> = {
  plaza: '#ff8a2b',
  plazoleta: '#3ddc84',
  tienda: '#5ab0ff',
  supermercado: '#f5b83d',
  centroComercial: '#ff4d4f',
  vivienda: '#b28dff',
  oficinas: '#4fd1ff',
};

const WALL = '#fbfaf6';
const PAVE = '#e9e6de';
const PARK = '#e4e1da';
const GLASS = '#dfe9ef';
const TREE = '#eef3e6';
const MAX_BEACONS = 512;

/** typical model height (world units) per type → beacon altitude */
const TOP: Record<EstablishmentType, number> = {
  plaza: 2.6, plazoleta: 1.6, tienda: 1.6, supermercado: 2.4, centroComercial: 4.4, vivienda: 5.2, oficinas: 9.5,
};

function model(b: GeoBuilder, e: Establishment, y: number): void {
  const { x, z } = e.pos;
  const acc = EST_COLORS[e.type];
  const r = ((e.id.charCodeAt(e.id.length - 1) || 0) % 8) * (Math.PI / 16);
  const at = (lx: number, lz: number) => local(x, z, r, lx, lz);
  switch (e.type) {
    case 'plaza': {
      // L-shaped strip mall + parking
      const [ax, az] = at(-1.6, -1.2);
      b.box(ax, y, az, 2.2, 2.2, 5.2, r, WALL);
      const [bx, bz] = at(1.0, -3.0);
      b.box(bx, y, bz, 5.0, 2.2, 1.8, r, WALL);
      b.box(ax, y + 2.2, az, 2.3, 0.3, 5.3, r, acc);
      b.box(bx, y + 2.2, bz, 5.1, 0.3, 1.9, r, acc);
      const [px, pz] = at(1.4, 0.6);
      b.box(px, y, pz, 4.6, 0.36, 4.4, r, PAVE);
      break;
    }
    case 'plazoleta': {
      b.box(x, y, z, 5.5, 0.38, 5.5, r, PAVE);
      b.cyl(x, y + 0.38, z, 0.9, 0.9, 0.12, 8, acc);
      b.cone(x, y + 1.4, z, 1.1, 0.5, 8, WALL);
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + 0.4;
        b.cyl(x + Math.cos(a) * 0.7, y + 0.38, z + Math.sin(a) * 0.7, 0.05, 0.05, 1.05, 4, WALL);
      }
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + r;
        const tx = x + Math.cos(a) * 2.2;
        const tz = z + Math.sin(a) * 2.2;
        b.cyl(tx, y + 0.3, tz, 0.06, 0.08, 0.7, 5, PARK);
        b.sphere(tx, y + 1.25, tz, 0.55, TREE, 0);
      }
      break;
    }
    case 'tienda': {
      b.box(x, y, z, 2.2, 1.5, 2.0, r, WALL);
      const [ax, az] = at(0, 1.15);
      b.box(ax, y + 1.0, az, 2.3, 0.12, 0.6, r, acc); // awning
      b.box(x, y + 1.5, z, 2.25, 0.18, 2.05, r, acc);
      break;
    }
    case 'supermercado': {
      b.box(x, y, z, 6.0, 2.2, 4.2, r, WALL);
      const [sx, sz] = at(0, 2.12);
      b.box(sx, y + 1.5, sz, 6.05, 0.6, 0.1, r, acc); // sign band
      const [px, pz] = at(0, 4.4);
      b.box(px, y, pz, 6.4, 0.36, 3.6, r, PAVE);
      break;
    }
    case 'centroComercial': {
      b.box(x, y, z, 9.0, 3.2, 6.0, r, WALL);
      const [ax, az] = at(-2.6, 0);
      b.box(ax, y + 3.2, az, 3.0, 1.2, 4.0, r, WALL);
      b.cyl(x, y + 3.2, z, 1.6, 1.8, 1.2, 16, GLASS); // atrium
      b.sphere(x, y + 4.3, z, 1.2, acc, 1);
      const [bx, bz] = at(3.3, -1.0);
      b.box(bx, y + 3.2, bz, 2.4, 0.4, 3.6, r, acc);
      const [px, pz] = at(0, 6.0);
      b.box(px, y, pz, 10, 0.36, 5.0, r, PAVE);
      break;
    }
    case 'vivienda': {
      b.box(x, y, z, 2.4, 5.0, 2.4, r, WALL);
      b.box(x, y + 5.0, z, 2.5, 0.25, 2.5, r, acc);
      for (let k = 0; k < 4; k++) {
        const [hx, hz] = at(-2.6 + (k % 2) * 5.2, -1.6 + Math.floor(k / 2) * 3.2);
        b.box(hx, y, hz, 1.4, 1.0, 1.4, r, WALL);
        b.box(hx, y + 1.0, hz, 1.45, 0.12, 1.45, r, acc);
      }
      break;
    }
    case 'oficinas': {
      b.box(x, y, z, 3.0, 9.0, 3.0, r, GLASS);
      b.box(x, y + 9.0, z, 2.2, 0.6, 2.2, r, acc);
      for (let k = 1; k < 9; k++) b.box(x, y + k * 1.0, z, 3.04, 0.07, 3.04, r, WALL);
      const [px, pz] = at(0, 2.8);
      b.box(px, y, pz, 4.4, 0.34, 2.0, r, PAVE);
      break;
    }
  }
}

/** Placed / suggested establishments + floating beacon rings. Rebuilt on every list change (lists are small). */
export class Establishments {
  readonly group = new THREE.Group();
  readonly mesh: THREE.Mesh;
  readonly beauty: THREE.MeshLambertMaterial;
  readonly machine: THREE.ShaderMaterial;
  readonly beacons: THREE.InstancedMesh;
  readonly beaconMat: THREE.ShaderMaterial;
  count = 0;

  constructor() {
    this.beauty = solidBeautyMaterial('est', true);
    this.machine = solidMachineMaterial('est', '#ff8a2b', 0.9);
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.beauty);
    this.mesh.name = 'establishments';
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false; // empty until the first set()

    const ring = new THREE.RingGeometry(0.8, 1.0, 40).rotateX(-Math.PI / 2);
    ring.setAttribute('aPhase', new THREE.InstancedBufferAttribute(new Float32Array(MAX_BEACONS), 1));
    this.beaconMat = machineMaterial(
      'beacon',
      /* glsl */ `
      attribute float aPhase;
      varying vec3 vColor;
      varying float vPulse;
      varying vec3 vWPos;
      void main() {
        float t = fract(uTime * 0.45 + aPhase);
        vPulse = 1.0 - t;
        vColor = vec3(1.0);
        #ifdef USE_INSTANCING_COLOR
        vColor = instanceColor;
        #endif
        vec3 p = position * (1.0 + t * 1.6);
        p.y += sin(uTime * 2.0 + aPhase * 6.28) * 0.25;
        vec4 wp = vec4(p, 1.0);
        #ifdef USE_INSTANCING
        wp = instanceMatrix * wp;
        #endif
        wp = modelMatrix * wp;
        vWPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
      /* glsl */ `
      varying vec3 vColor;
      varying float vPulse;
      varying vec3 vWPos;
      void main() {
        gl_FragColor = vec4(vColor * 1.2, 0.25 + 0.75 * vPulse);
        #include <colorspace_fragment>
      }`,
      {},
      { transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending },
    );
    this.beacons = new THREE.InstancedMesh(ring, this.beaconMat, MAX_BEACONS);
    this.beacons.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BEACONS * 3), 3);
    this.beacons.count = 0;
    this.beacons.frustumCulled = false;
    this.beacons.name = 'establishment-beacons';
    this.beacons.renderOrder = 5;
    this.group.add(this.mesh, this.beacons);
  }

  set(list: Establishment[], ground: (x: number, z: number) => number): void {
    const b = new GeoBuilder();
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    const phase = this.beacons.geometry.getAttribute('aPhase') as THREE.InstancedBufferAttribute;
    let n = 0;
    for (const e of list) {
      const y = ground(e.pos.x, e.pos.z) - 0.3;
      model(b, e, y);
      if (n < MAX_BEACONS) {
        const s = e.type === 'centroComercial' ? 3.2 : e.type === 'oficinas' || e.type === 'supermercado' ? 2.4 : 1.8;
        m.makeScale(s, 1, s).setPosition(e.pos.x, y + TOP[e.type] + 1.6, e.pos.z);
        this.beacons.setMatrixAt(n, m);
        this.beacons.setColorAt(n, c.set(EST_COLORS[e.type]));
        phase.setX(n, (n * 0.37) % 1);
        n++;
      }
    }
    const geo = b.build();
    const old = this.mesh.geometry;
    this.mesh.geometry = geo ?? new THREE.BufferGeometry();
    old.dispose();
    this.mesh.visible = !!geo;
    this.beacons.count = n;
    this.beacons.instanceMatrix.needsUpdate = true;
    if (this.beacons.instanceColor) this.beacons.instanceColor.needsUpdate = true;
    phase.needsUpdate = true;
    this.count = list.length;
  }
}
