import type { Area, AreaKind, MapData, Road, RoadClass, Waterway } from '../core/types';
import { ZONES, LANDMARKS, PROTECTED_AREAS } from './xalapa';
import { generateProceduralMap } from './procedural';

/**
 * Compact OSM bake produced at build time (public/data/xalapa-osm.json):
 * { v:1, names:string[], roads:[cls,nameIdx,x0,z0,x1,z1,...][], water:[nameIdx,width,x0,z0,...][], areas:[kind,nameIdx,x0,z0,...][] }
 * coordinates already in world units.
 */
interface OsmBake {
  v: number;
  names: string[];
  roads: number[][];
  water: number[][];
  areas: number[][];
}

export const ROAD_CLASSES: RoadClass[] = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'pedestrian'];
export const AREA_KINDS: AreaKind[] = [
  'park', 'water', 'forest', 'protected', 'farmland', 'cemetery', 'industrial', 'commercial', 'university', 'hospital', 'stadium',
];

function pts(arr: number[], from: number) {
  const out = [];
  for (let k = from; k + 1 < arr.length; k += 2) out.push({ x: arr[k], z: arr[k + 1] });
  return out;
}

function decode(b: OsmBake): Pick<MapData, 'roads' | 'waterways' | 'areas'> {
  const roads: Road[] = b.roads.map((r, n) => ({ id: `r${n}`, cls: ROAD_CLASSES[r[0]] ?? 'residential', name: b.names[r[1]] ?? '', points: pts(r, 2) }));
  const waterways: Waterway[] = b.water.map((w, n) => ({ id: `w${n}`, name: b.names[w[0]] ?? '', width: w[1], points: pts(w, 2) }));
  const areas: Area[] = b.areas.map((a, n) => ({ id: `a${n}`, kind: AREA_KINDS[a[0]] ?? 'park', name: b.names[a[1]] ?? '', polygon: pts(a, 2) }));
  return { roads, waterways, areas };
}

export async function loadMapData(onProgress?: (p: number, label: string) => void): Promise<MapData> {
  onProgress?.(0.02, 'Descargando cartografía de Xalapa');
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/xalapa-osm.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bake = (await res.json()) as OsmBake;
    const geo = decode(bake);
    if (geo.roads.length < 50) throw new Error('bake vacío');
    onProgress?.(0.12, `Cartografía OSM: ${geo.roads.length.toLocaleString('es-MX')} vialidades`);
    return { source: 'osm', ...geo, areas: [...geo.areas, ...PROTECTED_AREAS], zones: ZONES, landmarks: LANDMARKS };
  } catch (err) {
    console.warn('[MVIA] OSM bake unavailable, using procedural Xalapa', err);
    const geo = generateProceduralMap();
    onProgress?.(0.12, 'Cartografía procedural MVIA');
    return { source: 'procedural', ...geo, areas: [...geo.areas, ...PROTECTED_AREAS], zones: ZONES, landmarks: LANDMARKS };
  }
}
