import * as THREE from 'three';
import type {
  Establishment, IBus, ICityWorld, IStore, LayerId, MapData, MapStyle, RenderPass, Selection, Vec2,
} from '../core/types';
import { U } from './materials';
import { Terrain } from './terrain';
import { Landuse } from './landuse';
import { Occupancy } from './occupancy';
import { buildRoads, buildWaterways } from './roads';
import {
  GrowthLots, applyBuildingYears, buildBuildings, buildingBeautyMaterial, buildingDepthMaterial,
  buildingMachineMaterial, computeCellZones, type BuildingSet,
} from './buildings';
import { applyTreeYears, buildVegetation, type TreeSet } from './vegetation';
import { buildLandmarks, reserveLandmarks, solidBeautyMaterial, solidMachineMaterial } from './landmarks';
import { Traffic } from './traffic';
import { Establishments } from './establishments';
import { Overlay, SelectionMarker } from './overlay';
import { loadEsriSatellite, proceduralSatellite } from './satellite';

interface MatEntry {
  mesh: THREE.Mesh;
  beauty: THREE.Material;
  machine: THREE.Material;
}

const STYLE_INDEX: Record<MapStyle, number> = { clay: 0, satellite: 1, night: 2, scan: 0 };
const SUN_DIR = new THREE.Vector3(0.48, 0.78, 0.4).normalize(); // sun from the south-east, ~51° high

const yieldFrame = () => new Promise<void>((r) => setTimeout(r));

/**
 * The 3D city of Xalapa: terrain, roads, water, buildings (+ sprawl growth lots), trees, landmarks,
 * traffic, establishments, overlays, selection — with a lit beauty look (clay / satellite / night) and an
 * unlit MVIA machine-scan look swapped per render pass.
 */
export class CityWorld implements ICityWorld {
  readonly scene = new THREE.Scene();
  readonly pickables: THREE.Object3D[] = [];

  private entries: MatEntry[] = [];
  private style: MapStyle = 'clay';
  private pass: RenderPass = 'beauty';
  private machineActive = false;

  private terrain!: Terrain;
  private landuse!: Landuse;
  private occ = new Occupancy();
  private cellZone!: Int16Array;
  private buildings!: BuildingSet;
  private growth!: GrowthLots;
  private trees!: TreeSet;
  private traffic: Traffic | null = null;
  private est = new Establishments();
  private overlay = new Overlay();
  private marker = new SelectionMarker();
  private years: Float32Array | null = null;

  private hemi = new THREE.HemisphereLight(0xffffff, 0xd6d3cb, 1.9);
  private sun = new THREE.DirectionalLight(0xfffaf0, 1.5);
  private fog = new THREE.Fog(0xf1f0ec, 900, 2200);
  private showTraffic = true;

  private focusTarget = new THREE.Vector2();
  private focusOn = 0;
  private satRequested = false;
  private satProcedural: THREE.Texture | null = null;

  // scratch (no per-frame allocations)
  private tmpDir = new THREE.Vector3();
  private tmpTarget = new THREE.Vector3();
  private shadowHalf = 0;

  constructor(private bus: IBus, private store: IStore, private map: MapData) {
    this.scene.name = 'mvia-city';
    this.scene.background = null;
    this.scene.fog = this.fog;
    this.scene.matrixWorldAutoUpdate = true;
  }

  // ───────────────────────────── build ─────────────────────────────
  async build(onProgress: (p: number, label: string) => void): Promise<void> {
    const ground = (x: number, z: number) => this.terrain.sample(x, z);

    onProgress(0.02, 'Modelando relieve');
    await yieldFrame();
    this.terrain = new Terrain();
    this.landuse = new Landuse(this.map);
    U.uLanduse.value = this.landuse.texture;
    this.add(this.terrain.mesh, this.terrain.beauty, this.terrain.machine);
    this.installHeightfieldRaycast(this.terrain.mesh);
    this.pickables.push(this.terrain.mesh);

    onProgress(0.16, 'Trazando vialidades');
    await yieldFrame();
    const roads = buildRoads(this.map, ground, this.occ);
    for (const r of roads.meshes) this.add(r.mesh, r.beauty, r.machine);
    const water = buildWaterways(this.map, ground);
    if (water) this.add(water.mesh, water.beauty, water.machine);
    reserveLandmarks(this.map.landmarks, this.occ);

    onProgress(0.34, 'Levantando edificios');
    await yieldFrame();
    this.cellZone = computeCellZones(this.map.zones);
    const bBeauty = buildingBeautyMaterial();
    const bMachine = buildingMachineMaterial();
    const bDepth = buildingDepthMaterial();
    this.buildings = buildBuildings(this.map, ground, this.occ, this.landuse, this.cellZone, bBeauty);
    this.buildings.mesh.customDepthMaterial = bDepth;
    this.add(this.buildings.mesh, bBeauty, bMachine);
    this.growth = new GrowthLots(bBeauty, bDepth);
    this.add(this.growth.mesh, bBeauty, bMachine);
    this.add(this.growth.streets, this.growth.streetBeauty, this.growth.streetMachine);

    onProgress(0.58, 'Sembrando vegetación');
    await yieldFrame();
    this.trees = buildVegetation(this.map, ground, this.occ, this.landuse, this.cellZone);
    this.add(this.trees.crowns, this.trees.crownBeauty, this.trees.crownMachine);
    this.add(this.trees.trunks, this.trees.trunkBeauty, this.trees.trunkMachine);

    onProgress(0.76, 'Hitos urbanos');
    await yieldFrame();
    const lmGeo = buildLandmarks(this.map.landmarks, ground);
    if (lmGeo) {
      const lmBeauty = solidBeautyMaterial('landmark', false);
      const lmMachine = solidMachineMaterial('landmark', '#7fe3ff', 0.55);
      const lm = new THREE.Mesh(lmGeo, lmBeauty);
      lm.name = 'landmarks';
      lm.castShadow = true;
      lm.receiveShadow = true;
      lm.matrixAutoUpdate = false;
      this.add(lm, lmBeauty, lmMachine);
    }

    onProgress(0.88, 'Tráfico');
    await yieldFrame();
    this.traffic = new Traffic(this.map, ground);
    if (this.traffic.count > 0) {
      this.add(this.traffic.cars, this.traffic.beauty, this.traffic.machine);
      this.add(this.traffic.buses, this.traffic.beauty, this.traffic.machine);
    }
    this.add(this.est.mesh, this.est.beauty, this.est.machine);
    this.scene.add(this.est.group);
    this.scene.add(this.marker.group);
    this.setupLights();

    const s = this.store.get();
    this.setStyle(s.mapStyle);
    this.setVisibility({ buildings: s.showBuildings, traffic: s.showTraffic });
    U.uYear.value = s.year;
    onProgress(1, 'Ciudad lista');
    await yieldFrame();
  }

  private add(mesh: THREE.Mesh, beauty: THREE.Material, machine: THREE.Material): void {
    if (!mesh.parent && mesh !== this.est.mesh) this.scene.add(mesh);
    this.entries.push({ mesh, beauty, machine });
  }

  private setupLights(): void {
    this.scene.add(this.hemi);
    const sun = this.sun;
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    const cam = sun.shadow.camera;
    cam.near = 1;
    cam.far = 1400;
    this.scene.add(sun, sun.target);
    this.updateShadowFrustum(0, 0, 0, 160);
  }

  /** Cheap ray-vs-heightfield picking: march + bisection on the exact terrain surface (no 188k-tri scan). */
  private installHeightfieldRaycast(mesh: THREE.Mesh): void {
    const box = this.terrain.geometry.boundingBox!.clone();
    box.min.y -= 2;
    box.max.y += 2;
    const entry = new THREE.Vector3();
    mesh.raycast = (raycaster: THREE.Raycaster, intersects: THREE.Intersection[]) => {
      const ray = raycaster.ray;
      const o = ray.origin;
      const d = ray.direction;
      let t = 0;
      if (!box.containsPoint(o)) {
        if (!ray.intersectBox(box, entry)) return;
        t = o.distanceTo(entry);
      }
      const f = (tt: number) => o.y + d.y * tt - this.terrain.sample(o.x + d.x * tt, o.z + d.z * tt);
      let prevT = t;
      let prevF = f(t);
      if (prevF < 0) return;
      const tMax = Math.min(raycaster.far, t + 6000);
      for (let it = 0; it < 6000 && t < tMax; it++) {
        t += 0.8 + t * 0.0015;
        const x = o.x + d.x * t;
        const z = o.z + d.z * t;
        if (x < box.min.x || x > box.max.x || z < box.min.z || z > box.max.z) return;
        const ft = f(t);
        if (ft <= 0) {
          let lo = prevT;
          let hi = t;
          for (let b = 0; b < 14; b++) {
            const mid = (lo + hi) * 0.5;
            if (f(mid) > 0) lo = mid;
            else hi = mid;
          }
          const th = (lo + hi) * 0.5;
          if (th < raycaster.near) return;
          const point = new THREE.Vector3(o.x + d.x * th, 0, o.z + d.z * th);
          point.y = this.terrain.sample(point.x, point.z);
          intersects.push({ distance: th, point, object: mesh });
          return;
        }
        if (d.y > 0 && o.y + d.y * t > box.max.y) return;
        prevT = t;
        prevF = ft;
      }
      void prevF;
    };
  }

  // ───────────────────────────── public API ─────────────────────────────
  setStyle(style: MapStyle): void {
    this.style = style;
    U.uStyle.value = STYLE_INDEX[style];
    const fog = this.fog;
    if (style === 'night') {
      this.hemi.color.set('#2c3b5e');
      this.hemi.groundColor.set('#06080c');
      this.hemi.intensity = 0.9;
      this.sun.color.set('#9fb4e0');
      this.sun.intensity = 0.35;
      fog.color.set('#0b1018');
    } else if (style === 'satellite') {
      this.hemi.color.set('#f4f7ff');
      this.hemi.groundColor.set('#8a8a80');
      this.hemi.intensity = 1.8;
      this.sun.color.set('#fff6e8');
      this.sun.intensity = 1.6;
      fog.color.set('#c8d2d6');
      this.ensureSatellite();
    } else {
      this.hemi.color.set('#ffffff');
      this.hemi.groundColor.set('#d6d3cb');
      this.hemi.intensity = 1.9;
      this.sun.color.set('#fffaf0');
      this.sun.intensity = 1.5;
      fog.color.set(style === 'scan' ? '#061a26' : '#f1f0ec');
    }
    this.applyMaterials();
  }

  setPass(pass: RenderPass): void {
    if (pass === this.pass && this.machineActive === (pass === 'machine' || this.style === 'scan')) return;
    this.pass = pass;
    this.applyMaterials();
  }

  private applyMaterials(): void {
    const machine = this.pass === 'machine' || this.style === 'scan';
    this.machineActive = machine;
    for (let k = 0; k < this.entries.length; k++) {
      const e = this.entries[k];
      e.mesh.material = machine ? e.machine : e.beauty;
    }
    // the scan look is unlit: skip re-rendering the shadow map for it
    this.sun.shadow.autoUpdate = !machine;
  }

  setYear(y: number): void {
    U.uYear.value = y;
  }

  setUrbanizationYears(years: Float32Array): void {
    this.years = years.slice();
    if (!this.buildings) return;
    applyBuildingYears(this.buildings, years);
    applyTreeYears(this.trees, years);
    this.growth.rebuild(years, this.occ, this.landuse, (x, z) => this.terrain.sample(x, z));
  }

  setOverlay(layer: LayerId, field: Float32Array | null): void {
    this.overlay.set(layer, field);
  }

  setFocus(p: Vec2 | null): void {
    if (p) {
      if (this.focusOn < 0.01) {
        U.uFocus.value.x = p.x;
        U.uFocus.value.y = p.z;
      }
      this.focusTarget.set(p.x, p.z);
      this.focusOn = 1;
    } else this.focusOn = 0;
  }

  setEstablishments(list: Establishment[]): void {
    this.est.set(list, (x, z) => this.groundY(x, z));
  }

  setSelection(sel: Selection | null): void {
    this.marker.set(sel ? sel.point : null, sel ? this.groundY(sel.point.x, sel.point.z) : 0);
  }

  setVisibility(v: { buildings: boolean; traffic: boolean }): void {
    if (this.buildings) this.buildings.mesh.visible = v.buildings;
    if (this.growth) this.growth.mesh.visible = v.buildings;
    this.showTraffic = v.traffic;
    if (this.traffic) {
      this.traffic.cars.visible = v.traffic;
      this.traffic.buses.visible = v.traffic;
    }
  }

  groundY(x: number, z: number): number {
    return this.terrain ? this.terrain.sample(x, z) : 0;
  }

  update(dt: number, t: number, camera: THREE.Camera): void {
    U.uTime.value = t;
    // smooth machine focus (rings follow the cursor with a little lag)
    const f = U.uFocus.value;
    const k = Math.min(1, dt * 9);
    f.x += (this.focusTarget.x - f.x) * k;
    f.y += (this.focusTarget.y - f.y) * k;
    f.z += (this.focusOn - f.z) * Math.min(1, dt * 4);
    if (this.traffic && this.showTraffic) this.traffic.update(dt);
    this.followCamera(camera);
  }

  stats(): { buildings: number; vehicles: number; trees: number } {
    return {
      buildings: (this.buildings?.count ?? 0) + (this.growth?.count ?? 0),
      vehicles: this.traffic?.count ?? 0,
      trees: this.trees?.count ?? 0,
    };
  }

  // ───────────────────────────── internals ─────────────────────────────
  /** shadow box + fog follow the point the camera looks at */
  private followCamera(camera: THREE.Camera): void {
    const o = camera.position;
    camera.getWorldDirection(this.tmpDir);
    const d = this.tmpDir;
    const gy = this.groundY(o.x, o.z);
    let tHit = 400;
    if (d.y < -0.02) tHit = Math.min(4000, Math.max(0, (o.y - gy) / -d.y));
    const tx = o.x + d.x * tHit;
    const tz = o.z + d.z * tHit;
    const dist = Math.hypot(tx - o.x, tz - o.z, o.y - gy);
    const half = THREE.MathUtils.clamp(dist * 0.55, 45, 220);
    this.updateShadowFrustum(tx, this.groundY(tx, tz), tz, half);
    // fog only bites beyond the framed area so the whole-city view stays crisp
    this.fog.near = Math.max(900, dist * 1.15);
    this.fog.far = Math.max(2200, dist * 2.8);
  }

  private updateShadowFrustum(x: number, y: number, z: number, half: number): void {
    const sun = this.sun;
    const cam = sun.shadow.camera;
    if (Math.abs(half - this.shadowHalf) > this.shadowHalf * 0.04) {
      this.shadowHalf = half;
      cam.left = -half;
      cam.right = half;
      cam.top = half;
      cam.bottom = -half;
      cam.updateProjectionMatrix();
    }
    // snap to shadow texels to avoid shimmering while panning
    const texel = (this.shadowHalf * 2) / sun.shadow.mapSize.x;
    const sx = Math.round(x / texel) * texel;
    const sz = Math.round(z / texel) * texel;
    this.tmpTarget.set(sx, y, sz);
    sun.target.position.copy(this.tmpTarget);
    sun.position.copy(this.tmpTarget).addScaledVector(SUN_DIR, 600);
    sun.target.updateMatrixWorld();
  }

  private ensureSatellite(): void {
    if (this.satRequested || !this.terrain) return;
    this.satRequested = true;
    const years = this.years;
    const cellZone = this.cellZone;
    const zones = this.map.zones;
    const urban = (c: number): number => {
      if (c < 0 || c >= cellZone.length) return 0;
      if (years) return years[c] <= 2026 ? 1 : 0;
      const z = cellZone[c];
      return z >= 0 ? zones[z].density : 0;
    };
    try {
      this.satProcedural = proceduralSatellite(this.map, this.landuse, urban);
      U.uSat.value = this.satProcedural;
      U.uSatMode.value = 0;
    } catch (err) {
      console.warn('[MVIA world] procedural satellite failed', err);
    }
    loadEsriSatellite(this.terrain.geometry)
      .then((tex) => {
        U.uSat.value = tex;
        U.uSatMode.value = 1;
        this.satProcedural?.dispose();
        this.satProcedural = null;
        this.bus.emit('ui:toast', { text: 'Imagen satelital cargada · Esri World Imagery', kind: 'ok' });
      })
      .catch((err) => {
        console.warn('[MVIA world] Esri imagery unavailable, using procedural satellite', err);
      });
  }
}
