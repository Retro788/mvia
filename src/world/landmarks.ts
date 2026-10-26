import * as THREE from 'three';
import type { Landmark } from '../core/types';
import { MACHINE_SOLID_FRAG, MACHINE_SOLID_VERT, WPOS_VERT, glc, machineMaterial, patchMaterial } from './materials';
import { GeoBuilder, local } from './builder';
import { OCC_LANDMARK, type Occupancy } from './occupancy';

/** vertex-coloured lit material; `accent` keeps saturated colours in satellite/night (establishments) */
export function solidBeautyMaterial(key: string, accent: boolean): THREE.MeshLambertMaterial {
  return patchMaterial(new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true }), `solid-${key}`, {
    vertHead: 'varying vec3 vWPos;',
    vertEnd: WPOS_VERT,
    fragHead: 'varying vec3 vWPos; vec3 mLit;',
    fragColor: /* glsl */ `
      mLit = vec3(0.0);
      float sat = max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b)) - min(diffuseColor.r, min(diffuseColor.g, diffuseColor.b));
      if (uStyle > 0.5 && uStyle < 1.5) {
        diffuseColor.rgb *= ${accent ? 'mix(vec3(0.7), vec3(1.0), step(0.25, sat))' : glc('#a39d93')};
      } else if (uStyle > 1.5) {
        // night: dark volumes, flood-lit facades, accents glow
        mLit = diffuseColor.rgb * (${accent ? '0.25 + 0.9 * step(0.25, sat)' : '0.22'});
        diffuseColor.rgb *= 0.18;
      }
    `,
    fragEmissive: 'totalEmissiveRadiance += mLit;',
  });
}

export function solidMachineMaterial(key: string, tint: string, alpha: number): THREE.ShaderMaterial {
  return machineMaterial(`solid-${key}`, MACHINE_SOLID_VERT, MACHINE_SOLID_FRAG, {
    uTint: { value: new THREE.Color(tint) },
    uAlpha: { value: alpha },
  }, { transparent: true });
}

const WALL = '#f5eee3';
const TRIM = '#eadcc6';
const ROOF = '#e3d2b9';
const PAVE = '#ebe6dc';
const GREEN = '#d3e2c4';
const TREE = '#eef3e6';
const WATER = '#bcd3df';

/** minimum visual heights so tiny catalogue values still read as buildings */
const MIN_H: Partial<Record<Landmark['kind'], number>> = {
  catedral: 3, gobierno: 1.8, estadio: 2, centroComercial: 2, museo: 1.6, universidad: 2.4, hospital: 2.4,
  terminal: 1.4, teatro: 2.2, mercado: 1.4, cerro: 3,
};

/** reserve landmark footprints in the occupancy raster before buildings are placed */
export function reserveLandmarks(list: Landmark[], occ: Occupancy): void {
  for (const l of list) {
    if (l.kind === 'lago') continue;
    const s = l.size ?? 8;
    occ.markDisc(l.pos.x, l.pos.z, s * (l.kind === 'cerro' ? 0.25 : 0.62), OCC_LANDMARK);
  }
}

/** Procedural models by kind, all merged into one mesh. */
export function buildLandmarks(list: Landmark[], ground: (x: number, z: number) => number): THREE.BufferGeometry | null {
  const b = new GeoBuilder();
  for (const l of list) {
    const s = l.size ?? 8;
    const h = Math.max(l.height ?? 4, MIN_H[l.kind] ?? 0.5);
    const x = l.pos.x;
    const z = l.pos.z;
    const y = ground(x, z) - 0.3;
    const r = ((l.id.length * 37) % 7) * 0.12; // stable small rotation per landmark
    const at = (lx: number, lz: number) => local(x, z, r, lx, lz);
    switch (l.kind) {
      case 'catedral': {
        b.box(x, y, z, s * 0.34, h * 0.7, s * 0.86, r, WALL);
        b.box(x, y + h * 0.7, z, s * 0.36, h * 0.12, s * 0.88, r, ROOF);
        for (const sx of [-1, 1]) {
          const [tx, tz] = at(sx * s * 0.17, s * 0.38);
          b.box(tx, y, tz, s * 0.13, h * 1.55, s * 0.13, r, WALL);
          b.cone(tx, y + h * 1.55, tz, s * 0.08, h * 0.35, 4, ROOF);
        }
        const [dx, dz] = at(0, -s * 0.18);
        b.cyl(dx, y + h * 0.8, dz, s * 0.11, s * 0.13, h * 0.35, 12, TRIM);
        b.sphere(dx, y + h * 1.15, dz, s * 0.12, TRIM);
        break;
      }
      case 'gobierno': {
        b.box(x, y, z, s, h * 0.6, s * 0.34, r, WALL);
        b.box(x, y + h * 0.6, z, s * 1.04, h * 0.08, s * 0.38, r, TRIM);
        for (let k = 0; k < 12; k++) {
          const [cx, cz] = at(-s * 0.46 + (k * s * 0.92) / 11, s * 0.21);
          b.cyl(cx, y, cz, 0.13, 0.15, h * 0.6, 6, WALL);
        }
        const [px, pz] = at(0, s * 0.42);
        b.box(px, y, pz, s * 1.1, 0.35, s * 0.4, r, PAVE);
        break;
      }
      case 'estadio': {
        b.cyl(x, y, z, s * 0.5, s * 0.4, h * 0.55, 32, WALL, 1, 0.72, true);
        b.cyl(x, y, z, s * 0.52, s * 0.52, h * 0.6, 32, TRIM, 1, 0.74, true);
        b.cyl(x, y + 0.15, z, s * 0.34, s * 0.34, 0.25, 24, GREEN, 1, 0.68);
        break;
      }
      case 'centroComercial': {
        b.box(x, y, z, s, h * 0.5, s * 0.6, r, WALL);
        b.box(x, y + h * 0.5, z, s * 0.4, h * 0.2, s * 0.3, r, TRIM);
        const [px, pz] = at(0, s * 0.62);
        b.box(px, y, pz, s * 1.05, 0.38, s * 0.55, r, '#e3e1dc');
        for (let k = 0; k < 6; k++) {
          const [lx, lz] = at(-s * 0.42 + k * s * 0.17, s * 0.62);
          b.box(lx, y + 0.38, lz, 0.08, 0.02, s * 0.46, r, '#ffffff');
        }
        break;
      }
      case 'lago': {
        const [kx, kz] = at(s * 0.45, 0);
        b.box(kx, y, kz, 2.5, 0.5, 0.8, r, TRIM);
        b.cyl(kx, y + 0.5, kz, 0.6, 0.6, 1.2, 8, WALL);
        break;
      }
      case 'cerro': {
        const top = ground(x, z);
        b.cyl(x, top - 0.5, z, 0.35, 0.55, h * 1.6 + 0.5, 8, WALL);
        b.cyl(x, top + h * 1.6, z, 1.6, 1.4, 0.35, 12, TRIM);
        b.cyl(x, top + h * 1.6 + 0.35, z, 0.18, 0.18, 1.2, 6, WALL);
        for (let k = 0; k < 18; k++) {
          const a = (k / 18) * Math.PI * 2;
          const rr = 4 + (k % 4) * 2.2;
          const tx = x + Math.cos(a) * rr;
          const tz = z + Math.sin(a) * rr;
          const ty = ground(tx, tz);
          b.cyl(tx, ty - 0.1, tz, 0.08, 0.1, 0.9, 5, TRIM);
          b.sphere(tx, ty + 1.4, tz, 0.75, TREE, 0);
        }
        break;
      }
      case 'museo': {
        for (let k = 0; k < 3; k++) b.box(x, y + k * h * 0.22, z, s * (1 - k * 0.22), h * 0.22, s * 0.34 * (1 - k * 0.15), r, k === 2 ? TRIM : WALL);
        const [px, pz] = at(0, s * 0.32);
        b.box(px, y, pz, s * 0.9, 0.32, s * 0.22, r, GREEN);
        break;
      }
      case 'universidad': {
        const quad: Array<[number, number, number, number, number]> = [
          [-0.32, -0.3, 0.3, 0.2, 0.9], [0.32, -0.3, 0.3, 0.2, 1.2], [-0.35, 0.25, 0.2, 0.36, 0.7], [0.35, 0.25, 0.2, 0.36, 0.8], [0, -0.05, 0.36, 0.14, 1.5],
        ];
        for (const [lx, lz, w, d, hh] of quad) {
          const [bx, bz] = at(lx * s, lz * s);
          b.box(bx, y, bz, w * s, h * 0.5 * hh, d * s, r, WALL);
        }
        const [gx, gz] = at(0, s * 0.25);
        b.box(gx, y, gz, s * 0.42, 0.34, s * 0.3, r, GREEN);
        break;
      }
      case 'hospital': {
        b.box(x, y, z, s * 0.9, h * 0.75, s * 0.26, r, WALL);
        b.box(x, y, z, s * 0.26, h * 0.95, s * 0.9, r, WALL);
        b.cyl(x, y + h * 0.95, z, s * 0.1, s * 0.1, 0.12, 16, '#e6574f');
        b.box(x, y + h * 1.07, z, s * 0.12, 0.05, s * 0.03, r, '#ffffff');
        b.box(x, y + h * 1.07, z, s * 0.03, 0.05, s * 0.12, r, '#ffffff');
        break;
      }
      case 'terminal': {
        b.box(x, y, z, s * 0.9, h * 0.35, s * 0.25, r, WALL);
        const [cx, cz] = at(0, s * 0.28);
        b.box(cx, y + h * 0.5, cz, s * 1.05, 0.18, s * 0.34, r, TRIM);
        for (let k = 0; k < 8; k++) {
          const [px, pz] = at(-s * 0.48 + (k * s * 0.96) / 7, s * 0.42);
          b.cyl(px, y, pz, 0.1, 0.1, h * 0.5, 5, WALL);
        }
        break;
      }
      case 'teatro': {
        b.box(x, y, z, s * 0.6, h * 0.6, s * 0.7, r, WALL);
        const [fx, fz] = at(0, -s * 0.15);
        b.box(fx, y, fz, s * 0.4, h * 1.05, s * 0.3, r, WALL);
        const [px, pz] = at(0, s * 0.4);
        b.box(px, y, pz, s * 0.64, h * 0.42, s * 0.12, r, TRIM);
        break;
      }
      case 'mercado': {
        b.box(x, y, z, s * 0.85, h * 0.4, s * 0.6, r, WALL);
        for (let k = 0; k < 4; k++) {
          const [rx, rz] = at(0, -s * 0.22 + k * s * 0.15);
          b.box(rx, y + h * 0.4, rz, s * 0.86, h * 0.14, s * 0.07, r, ROOF);
        }
        break;
      }
      case 'parque':
      case 'plaza':
      default: {
        // plinth spans the slope: base at the lowest corner, top just above the highest one
        const hw = s * 0.5;
        const hd = s * 0.4;
        let lo = Infinity;
        let hi = -Infinity;
        for (const [cx, cz] of [at(-hw, -hd), at(hw, -hd), at(-hw, hd), at(hw, hd), [x, z]]) {
          const g = ground(cx, cz);
          lo = Math.min(lo, g);
          hi = Math.max(hi, g);
        }
        const top = hi + 0.12;
        if (s <= 12) b.box(x, lo - 0.3, z, s, top - lo + 0.3, s * 0.8, r, l.kind === 'parque' ? GREEN : PAVE);
        const fy = s <= 12 ? top : ground(x, z);
        b.cyl(x, fy - 0.1, z, 1.3, 1.4, 0.4, 16, TRIM);
        b.cyl(x, fy + 0.2, z, 1.0, 1.0, 0.08, 16, WATER);
        b.cyl(x, fy + 0.2, z, 0.12, 0.16, 0.9, 6, WALL);
        const nTrees = Math.round(8 + s * 0.9);
        for (let k = 0; k < nTrees; k++) {
          const a = (k / nTrees) * Math.PI * 2 + r;
          const rr = 0.38 - (k % 3) * 0.08;
          const tx = x + Math.cos(a) * s * rr;
          const tz = z + Math.sin(a) * s * rr * 0.8;
          const ty = s <= 12 ? top : ground(tx, tz);
          b.cyl(tx, ty - 0.2, tz, 0.07, 0.09, 0.9, 5, TRIM);
          b.sphere(tx, ty + 1.3, tz, 0.7, TREE, 0);
        }
        if (l.kind === 'plaza') {
          const [kx, kz] = at(-s * 0.3, -s * 0.25);
          b.cyl(kx, fy, kz, 0.9, 0.9, 0.12, 8, TRIM);
          b.cone(kx, fy + 1.0, kz, 1.1, 0.6, 8, ROOF);
          for (let k = 0; k < 4; k++) {
            const a = (k / 4) * Math.PI * 2 + 0.4;
            b.cyl(kx + Math.cos(a) * 0.75, fy, kz + Math.sin(a) * 0.75, 0.05, 0.05, 1.0, 4, WALL);
          }
        }
        break;
      }
    }
  }
  return b.build();
}
