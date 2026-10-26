import { GRID, WORLD, WORLD_D, WORLD_W } from '../core/geo';

/** Fine occupancy raster (0.8-unit cells) shared by roads, buildings, trees and landmarks to avoid overlaps. */
export const OCC_CELL = 0.8;
export const OCC_W = Math.ceil(WORLD_W / OCC_CELL);
export const OCC_H = Math.ceil(WORLD_D / OCC_CELL);

export const OCC_ROAD = 1;
export const OCC_BUILDING = 2;
export const OCC_LANDMARK = 4;
export const OCC_TREE = 8;

export class Occupancy {
  readonly bits = new Uint8Array(OCC_W * OCC_H);
  /** per sim-grid cell: 1 if any road of class ≤ residential crosses it */
  readonly cellRoad = new Uint8Array(GRID.cols * GRID.rows);
  /** per sim-grid cell: orientation (radians) of a road crossing it, NaN if none */
  readonly cellAngle = new Float32Array(GRID.cols * GRID.rows).fill(Number.NaN);

  at(x: number, z: number): number {
    const i = Math.floor((x - WORLD.minX) / OCC_CELL);
    const j = Math.floor((z - WORLD.minZ) / OCC_CELL);
    if (i < 0 || j < 0 || i >= OCC_W || j >= OCC_H) return 255;
    return this.bits[j * OCC_W + i];
  }

  /** mark a disc */
  markDisc(x: number, z: number, r: number, flag: number): void {
    const i0 = Math.max(0, Math.floor((x - r - WORLD.minX) / OCC_CELL));
    const i1 = Math.min(OCC_W - 1, Math.floor((x + r - WORLD.minX) / OCC_CELL));
    const j0 = Math.max(0, Math.floor((z - r - WORLD.minZ) / OCC_CELL));
    const j1 = Math.min(OCC_H - 1, Math.floor((z + r - WORLD.minZ) / OCC_CELL));
    // only cells whose centre lies inside the disc (tight marking keeps road-side lots buildable)
    const r2 = r * r;
    for (let j = j0; j <= j1; j++) {
      const dz = WORLD.minZ + (j + 0.5) * OCC_CELL - z;
      for (let i = i0; i <= i1; i++) {
        const dx = WORLD.minX + (i + 0.5) * OCC_CELL - x;
        if (dx * dx + dz * dz <= r2) this.bits[j * OCC_W + i] |= flag;
      }
    }
    const ci = Math.floor((x - WORLD.minX) / OCC_CELL);
    const cj = Math.floor((z - WORLD.minZ) / OCC_CELL);
    if (ci >= 0 && cj >= 0 && ci < OCC_W && cj < OCC_H) this.bits[cj * OCC_W + ci] |= flag;
  }

  /**
   * Test (and optionally mark) an oriented rectangle centred at (cx,cz) with half extents hw (along ux,uz)
   * and hd (along the perpendicular). Returns false if any sampled cell has one of `mask` bits.
   */
  rect(cx: number, cz: number, ux: number, uz: number, hw: number, hd: number, mask: number, mark: number): boolean {
    const vx = -uz;
    const vz = ux;
    const na = Math.max(1, Math.ceil((hw * 2) / (OCC_CELL * 0.75)));
    const nb = Math.max(1, Math.ceil((hd * 2) / (OCC_CELL * 0.75)));
    for (let pass = 0; pass < (mark ? 2 : 1); pass++) {
      for (let a = 0; a <= na; a++) {
        const sa = -hw + (2 * hw * a) / na;
        for (let b = 0; b <= nb; b++) {
          const sb = -hd + (2 * hd * b) / nb;
          const x = cx + ux * sa + vx * sb;
          const z = cz + uz * sa + vz * sb;
          const i = Math.floor((x - WORLD.minX) / OCC_CELL);
          const j = Math.floor((z - WORLD.minZ) / OCC_CELL);
          if (i < 0 || j < 0 || i >= OCC_W || j >= OCC_H) return false;
          const k = j * OCC_W + i;
          if (pass === 0) {
            if (this.bits[k] & mask) return false;
          } else this.bits[k] |= mark;
        }
      }
    }
    return true;
  }
}
