import * as THREE from 'three';

/*
 * CPU mirror of three.js' ACESFilmicToneMapping (r169) so the clear colour of the beauty pass can be
 * "pre-inverted": after the composite tone-maps it, the empty sky/background lands exactly on the
 * design token (e.g. --paper #f1f0ec) instead of a greyish ACES shift.
 */
// rows of the GLSL mat3 (which is written column-major there)
const IN = [0.59719, 0.35458, 0.04823, 0.076, 0.90834, 0.01566, 0.0284, 0.13383, 0.83777];
const OUT = [1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602];

const rrt = (v: number): number => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
const sat = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function aces(c: number[], exposure: number, out: number[]): void {
  const s = exposure / 0.6;
  const r = c[0] * s;
  const g = c[1] * s;
  const b = c[2] * s;
  const a0 = rrt(IN[0] * r + IN[1] * g + IN[2] * b);
  const a1 = rrt(IN[3] * r + IN[4] * g + IN[5] * b);
  const a2 = rrt(IN[6] * r + IN[7] * g + IN[8] * b);
  out[0] = sat(OUT[0] * a0 + OUT[1] * a1 + OUT[2] * a2);
  out[1] = sat(OUT[3] * a0 + OUT[4] * a1 + OUT[5] * a2);
  out[2] = sat(OUT[6] * a0 + OUT[7] * a1 + OUT[8] * a2);
}

/**
 * Linear colour x such that ACES(x) ≈ hex (both in linear sRGB). Gauss–Seidel over channels with a
 * bisection per channel: the ACES matrices are diagonally dominant, so this converges in a few sweeps.
 */
export function preToneMapped(hex: number, exposure: number, out: THREE.Color): THREE.Color {
  const target = new THREE.Color(hex); // sRGB hex → linear working space
  const t = [target.r, target.g, target.b];
  const x = [t[0], t[1], t[2]];
  const y = [0, 0, 0];
  for (let sweep = 0; sweep < 8; sweep++) {
    for (let ch = 0; ch < 3; ch++) {
      let lo = 0;
      let hi = 24;
      for (let k = 0; k < 26; k++) {
        const mid = (lo + hi) * 0.5;
        x[ch] = mid;
        aces(x, exposure, y);
        if (y[ch] < t[ch]) lo = mid;
        else hi = mid;
      }
      x[ch] = (lo + hi) * 0.5;
    }
  }
  return out.setRGB(x[0], x[1], x[2], THREE.LinearSRGBColorSpace);
}
