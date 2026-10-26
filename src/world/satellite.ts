import * as THREE from 'three';
import type { MapData } from '../core/types';
import { BBOX, GRID, WORLD, WORLD_D, WORLD_W, fbm, worldToLonLat } from '../core/geo';
import type { Landuse } from './landuse';
import { LU_H, LU_W } from './landuse';

const Z = 15;
const TILE = 256;
const TILE_URL = (z: number, y: number, x: number) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

function mercX(lon: number): number {
  return ((lon + 180) / 360) * TILE * 2 ** Z;
}
function mercY(lat: number): number {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** Z;
}

/**
 * Procedural "satellite" (used until/unless Esri tiles load): canopy greens from fbm, urban greys and
 * terracotta roofs where the city cells are dense, darker road lines, water.
 */
export function proceduralSatellite(map: MapData, landuse: Landuse, urban: (cell: number) => number): THREE.CanvasTexture {
  // low-res base built per pixel, then upscaled with smoothing
  const bw = 420;
  const bh = Math.round((bw * WORLD_D) / WORLD_W);
  const base = document.createElement('canvas');
  base.width = bw;
  base.height = bh;
  const bctx = base.getContext('2d')!;
  const img = bctx.createImageData(bw, bh);
  for (let j = 0; j < bh; j++) {
    for (let i = 0; i < bw; i++) {
      const x = WORLD.minX + ((i + 0.5) / bw) * WORLD_W;
      const z = WORLD.minZ + ((j + 0.5) / bh) * WORLD_D;
      const n = fbm(x / 60, z / 60, 3);
      const n2 = fbm(x / 12 + 5, z / 12, 2);
      let r = 38 + n * 40 + n2 * 18;
      let g = 58 + n * 52 + n2 * 20;
      let b = 30 + n * 22;
      const ci = Math.floor((x - GRID.minX) / GRID.cellSize) + Math.floor((z - GRID.minZ) / GRID.cellSize) * GRID.cols;
      const u = Math.min(1, urban(ci));
      if (u > 0) {
        const terra = n2 > 0.55 ? 1 : 0;
        const ur = terra ? 150 : 128 + n2 * 40;
        const ug = terra ? 104 : 124 + n2 * 36;
        const ub = terra ? 86 : 118 + n2 * 30;
        r = r + (ur - r) * u * 0.85;
        g = g + (ug - g) * u * 0.85;
        b = b + (ub - b) * u * 0.85;
      }
      const w = landuse.water(x, z);
      r = r + (24 - r) * w;
      g = g + (48 - g) * w;
      b = b + (58 - b) * w;
      const k = (j * bw + i) * 4;
      img.data[k] = r;
      img.data[k + 1] = g;
      img.data[k + 2] = b;
      img.data[k + 3] = 255;
    }
  }
  bctx.putImageData(img, 0, 0);

  const cv = document.createElement('canvas');
  cv.width = LU_W;
  cv.height = LU_H;
  const ctx = cv.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(base, 0, 0, LU_W, LU_H);
  // fine grain
  const grain = document.createElement('canvas');
  grain.width = grain.height = 128;
  const gctx = grain.getContext('2d')!;
  const gimg = gctx.createImageData(128, 128);
  for (let k = 0; k < gimg.data.length; k += 4) {
    const v = Math.random() * 255;
    gimg.data[k] = gimg.data[k + 1] = gimg.data[k + 2] = v;
    gimg.data[k + 3] = 22;
  }
  gctx.putImageData(gimg, 0, 0);
  const pattern = ctx.createPattern(grain, 'repeat');
  if (pattern) {
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, LU_W, LU_H);
  }
  // roads
  const sx = LU_W / WORLD_W;
  const sz = LU_H / WORLD_D;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const widths: Record<string, number> = { motorway: 2.2, trunk: 1.9, primary: 1.6, secondary: 1.3, tertiary: 1.0, residential: 0.7, pedestrian: 0.5 };
  for (const r of map.roads) {
    if (r.points.length < 2) continue;
    ctx.strokeStyle = r.cls === 'residential' || r.cls === 'pedestrian' ? 'rgba(70,68,64,0.55)' : 'rgba(52,52,54,0.8)';
    ctx.lineWidth = Math.max(0.8, widths[r.cls] * sx);
    ctx.beginPath();
    r.points.forEach((p, k) => {
      const x = (p.x - WORLD.minX) * sx;
      const y = (p.z - WORLD.minZ) * sz;
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

/**
 * Esri World Imagery at z15 over BBOX, stitched into one canvas (≤ 4096 px). On success also writes a
 * per-vertex mercator UV into the terrain's aSatUv attribute. Rejects if too many tiles fail (CORS / offline).
 */
export async function loadEsriSatellite(terrainGeo: THREE.BufferGeometry): Promise<THREE.CanvasTexture> {
  const x0 = Math.floor(mercX(BBOX.west) / TILE);
  const x1 = Math.floor(mercX(BBOX.east) / TILE);
  const y0 = Math.floor(mercY(BBOX.north) / TILE);
  const y1 = Math.floor(mercY(BBOX.south) / TILE);
  const ntx = x1 - x0 + 1;
  const nty = y1 - y0 + 1;
  const scale = Math.min(1, 4096 / (Math.max(ntx, nty) * TILE));
  const ts = Math.floor(TILE * scale);
  const cv = document.createElement('canvas');
  cv.width = ntx * ts;
  cv.height = nty * ts;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#2b3a2a';
  ctx.fillRect(0, 0, cv.width, cv.height);

  const jobs: Array<[number, number]> = [];
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) jobs.push([tx, ty]);
  let failed = 0;
  let next = 0;
  const loadOne = (tx: number, ty: number) =>
    new Promise<void>((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      const timer = setTimeout(() => {
        failed++;
        img.src = '';
        resolve();
      }, 12000);
      img.onload = () => {
        clearTimeout(timer);
        ctx.drawImage(img, (tx - x0) * ts, (ty - y0) * ts, ts, ts);
        resolve();
      };
      img.onerror = () => {
        clearTimeout(timer);
        failed++;
        resolve();
      };
      img.src = TILE_URL(Z, ty, tx);
    });
  const worker = async () => {
    while (next < jobs.length) {
      const [tx, ty] = jobs[next++];
      await loadOne(tx, ty);
    }
  };
  await Promise.all(Array.from({ length: 10 }, worker));
  if (failed > jobs.length * 0.3) throw new Error(`satellite tiles failed: ${failed}/${jobs.length}`);
  // probe for CORS taint (getImageData throws on tainted canvases → WebGL upload would fail too)
  ctx.getImageData(0, 0, 1, 1);

  // per-vertex UV: world → lon/lat → mercator pixel → canvas UV (v down, texture.flipY = false)
  const uv = terrainGeo.getAttribute('aSatUv') as THREE.BufferAttribute;
  const pos = terrainGeo.getAttribute('position') as THREE.BufferAttribute;
  const W = ntx * TILE;
  const H = nty * TILE;
  for (let k = 0; k < pos.count; k++) {
    const { lon, lat } = worldToLonLat(pos.getX(k), pos.getZ(k));
    uv.setXY(k, (mercX(lon) - x0 * TILE) / W, (mercY(lat) - y0 * TILE) / H);
  }
  uv.needsUpdate = true;

  const tex = new THREE.CanvasTexture(cv);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}
