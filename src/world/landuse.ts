import * as THREE from 'three';
import type { AreaKind, MapData, Vec2 } from '../core/types';
import { WORLD, WORLD_D, WORLD_W } from '../core/geo';

/**
 * Land-use raster over the whole world (canvas, ~0.82 units/px). Channels are additive masks:
 *   R = parks / gardens / cemeteries,  G = forest / protected / coffee farmland,  B = water.
 * Sampled by the terrain shaders (soft linear edges, no draped decal geometry → no z-fighting)
 * and on the CPU to keep buildings and roads-side trees out of water / reserves.
 */
export const LU_W = 2048;
export const LU_H = Math.round((LU_W * WORLD_D) / WORLD_W);
const SX = LU_W / WORLD_W;
const SZ = LU_H / WORLD_D;

const AREA_RGB: Partial<Record<AreaKind, [number, number, number]>> = {
  park: [255, 0, 0],
  cemetery: [150, 0, 0],
  stadium: [110, 0, 0],
  university: [70, 0, 0],
  hospital: [30, 0, 0],
  forest: [0, 255, 0],
  protected: [0, 235, 0],
  farmland: [0, 120, 0],
  water: [0, 0, 255],
};

export class Landuse {
  readonly texture: THREE.CanvasTexture;
  readonly canvas: HTMLCanvasElement;
  private data: Uint8ClampedArray;

  constructor(map: MapData) {
    const cv = document.createElement('canvas');
    cv.width = LU_W;
    cv.height = LU_H;
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, LU_W, LU_H);
    ctx.globalCompositeOperation = 'lighter';
    const px = (p: Vec2): [number, number] => [(p.x - WORLD.minX) * SX, (p.z - WORLD.minZ) * SZ];

    // big areas first (protected) so small parks still add on top
    const areas = [...map.areas].sort((a, b) => (a.kind === 'protected' ? -1 : 0) - (b.kind === 'protected' ? -1 : 0));
    for (const a of areas) {
      const rgb = AREA_RGB[a.kind];
      if (!rgb || a.polygon.length < 3) continue;
      ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
      ctx.beginPath();
      a.polygon.forEach((p, k) => {
        const [x, y] = px(p);
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = 'rgb(0,0,255)';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const w of map.waterways) {
      if (w.points.length < 2) continue;
      ctx.lineWidth = Math.max(1.4, w.width * SX);
      ctx.beginPath();
      w.points.forEach((p, k) => {
        const [x, y] = px(p);
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    this.canvas = cv;
    this.data = ctx.getImageData(0, 0, LU_W, LU_H).data;
    const tex = new THREE.CanvasTexture(cv);
    tex.flipY = false; // canvas row 0 = WORLD.minZ (north) = world-uv v 0
    tex.colorSpace = THREE.NoColorSpace;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = 4;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    this.texture = tex;
  }

  private idx(x: number, z: number): number {
    const i = Math.floor((x - WORLD.minX) * SX);
    const j = Math.floor((z - WORLD.minZ) * SZ);
    if (i < 0 || j < 0 || i >= LU_W || j >= LU_H) return -1;
    return (j * LU_W + i) * 4;
  }
  /** 0..1 park mask */
  park(x: number, z: number): number {
    const k = this.idx(x, z);
    return k < 0 ? 0 : this.data[k] / 255;
  }
  /** 0..1 forest / protected / farmland mask */
  green(x: number, z: number): number {
    const k = this.idx(x, z);
    return k < 0 ? 0 : this.data[k + 1] / 255;
  }
  water(x: number, z: number): number {
    const k = this.idx(x, z);
    return k < 0 ? 0 : this.data[k + 2] / 255;
  }
  /** true where nothing should be built (water, reserves, parks) */
  blocked(x: number, z: number): boolean {
    const k = this.idx(x, z);
    if (k < 0) return true;
    return this.data[k + 2] > 90 || this.data[k + 1] > 200 || this.data[k] > 200;
  }
}
