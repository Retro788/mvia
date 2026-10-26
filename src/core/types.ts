/**
 * MVIA — Master Validation of Infrastructure Artificial Algorithm
 * Shared contract between every module. Change only in coordination: all modules code against this file.
 *
 * World coordinates: 1 unit = 10 m. Origin = (lat 19.5275, lon -96.9200), Xalapa centre.
 * +x = east, -z = north (camera looks north by default), +y = up (elevation, also in 10 m units, exaggerated).
 */
import type * as THREE from 'three';

export interface Vec2 { x: number; z: number }

// ───────────────────────────── Enumerations ─────────────────────────────
export type MapStyle = 'clay' | 'satellite' | 'scan' | 'night';
export type LayerId = 'none' | 'landValue' | 'growth' | 'creditRisk' | 'mortgage' | 'commercial' | 'floodRisk' | 'density';
export type ScenarioId = 'descontrolado' | 'tendencial' | 'ordenado';
export type EstablishmentType = 'plaza' | 'plazoleta' | 'tienda' | 'supermercado' | 'centroComercial' | 'vivienda' | 'oficinas';
export type ToolId = 'inspect' | EstablishmentType | 'bulldoze';
export type PanelId = 'mercado' | 'credito' | 'comercio' | 'crecimiento';
export type Verdict = 'viable' | 'observar' | 'precaucion' | 'riesgo';
export type RoadClass = 'motorway' | 'trunk' | 'primary' | 'secondary' | 'tertiary' | 'residential' | 'pedestrian';
export type AreaKind =
  | 'park' | 'water' | 'forest' | 'protected' | 'farmland' | 'cemetery'
  | 'industrial' | 'commercial' | 'university' | 'hospital' | 'stadium';

// ───────────────────────────── Static city data ─────────────────────────────
export type ZoneKind = 'centro' | 'residencial' | 'popular' | 'premium' | 'comercial' | 'industrial' | 'periferia' | 'rural' | 'universitaria';
export type IncomeLevel = 'bajo' | 'medio-bajo' | 'medio' | 'medio-alto' | 'alto';

/** A colonia / sector of Xalapa (approximate real geography). */
export interface Zone {
  id: string;
  name: string;
  kind: ZoneKind;
  center: Vec2;
  /** influence radius in world units */
  radius: number;
  /** MXN per m² of land in 2026 */
  basePriceM2: number;
  /** 0..1 built density in 2026 */
  density: number;
  income: IncomeLevel;
  /** 0..1 */
  floodRisk: number;
  /** typical floors of buildings (min,max) */
  floors: [number, number];
  /** true for areas outside the 2026 urban footprint that the uncontrolled scenario pushes into */
  growthFront?: boolean;
  description: string;
}

export type LandmarkKind =
  | 'plaza' | 'catedral' | 'gobierno' | 'parque' | 'estadio' | 'museo' | 'universidad' | 'hospital'
  | 'mercado' | 'centroComercial' | 'lago' | 'cerro' | 'terminal' | 'teatro';

export interface Landmark {
  id: string;
  name: string;
  kind: LandmarkKind;
  pos: Vec2;
  /** visual footprint (world units) */
  size?: number;
  /** visual height (world units) */
  height?: number;
  description: string;
}

export interface Road {
  id: string;
  name: string;
  cls: RoadClass;
  points: Vec2[];
}

export interface Waterway {
  id: string;
  name: string;
  /** visual width in world units */
  width: number;
  points: Vec2[];
}

export interface Area {
  id: string;
  name: string;
  kind: AreaKind;
  polygon: Vec2[];
}

/** Everything geographic the world + sim need. Produced by src/data/loadMapData.ts */
export interface MapData {
  source: 'osm' | 'procedural';
  roads: Road[];
  waterways: Waterway[];
  areas: Area[];
  zones: Zone[];
  landmarks: Landmark[];
}

// ───────────────────────────── Simulation ─────────────────────────────
export interface GridSpec {
  cols: number;
  rows: number;
  /** world units per cell */
  cellSize: number;
  minX: number;
  minZ: number;
}

export interface CellInfo {
  index: number;
  i: number; // column
  j: number; // row
  center: Vec2;
  zoneId: string | null;
  zoneName: string;
  elevation: number; // metres above sea level (real, not exaggerated)
  slope: number; // degrees
  /** 0..1 built density at the current year */
  urban: number;
  /** year the cell becomes urban in the active projection (2026 or earlier = already urban; 9999 = never) */
  yearUrbanized: number;
  /** MXN / m² at current year */
  landValue: number;
  /** annual appreciation % */
  appreciation: number;
  floodRisk: number; // 0..1
  creditRisk: number; // 0..1 probability-of-default style index
  mortgageRate: number; // annual % typical
  commercialDemand: number; // 0..1
  protected: boolean; // ANP / ecological reserve
  population: number; // inhabitants in the cell
}

export interface CellReading {
  verdict: Verdict;
  title: string;
  summary: string;
  rows: Array<[string, string]>;
  footer?: string;
}

export interface ZoneStats {
  zone: Zone;
  landValue: number; // avg MXN/m² current year
  appreciation: number; // annual %
  creditRisk: number; // 0..1
  mortgageRate: number; // %
  commercialDemand: number; // 0..1
  population: number;
  urbanShare: number; // 0..1
  verdict: Verdict;
}

export interface CityMetrics {
  year: number;
  population: number;
  urbanAreaKm2: number;
  avgLandValue: number; // MXN/m²
  medianMortgageRate: number; // %
  creditDefaultRisk: number; // 0..1
  sprawlIndex: number; // 0..1 (1 = very dispersed)
  greenLossHa: number; // cumulative since 2026
  housingDeficit: number; // dwellings
  commercialCount: number;
  investmentPipeline: number; // MXN of placed establishments
}

export interface EstablishmentSpec {
  type: EstablishmentType;
  label: string; // 'Plaza comercial'
  short: string; // 'PLZ'
  color: string; // css hex
  /** footprint size in world units (square-ish) */
  footprint: number;
  /** height in world units */
  height: number;
  /** typical built area range m² */
  areaM2: [number, number];
  /** construction cost MXN per m² */
  costM2: number;
  description: string;
}

export interface SiteEvaluation {
  type: EstablishmentType;
  pos: Vec2;
  cellIndex: number;
  allowed: boolean;
  reason?: string; // when not allowed
  score: number; // 0..100
  verdict: Verdict;
  investment: number; // MXN
  areaM2: number;
  footfall: number; // visitors / day
  annualRevenue: number; // MXN
  roi: number; // % annual
  paybackYears: number;
  capRate: number; // %
  notes: string[];
}

export interface Establishment extends SiteEvaluation {
  id: string;
  name: string;
  year: number;
  createdBy: 'user' | 'mvia';
}

export interface MortgageParams {
  price: number; // MXN property price
  downPayment: number; // MXN
  years: number;
  /** if omitted the sim derives it from cell/zone risk + scenario */
  rate?: number;
  cellIndex?: number;
  product?: 'bancario' | 'infonavit' | 'fovissste' | 'cofinavit';
}

export interface MortgageQuote {
  principal: number;
  rate: number; // annual %
  cat: number; // Costo Anual Total %
  years: number;
  monthlyPayment: number;
  totalPaid: number;
  requiredIncome: number; // monthly MXN
  ltv: number; // 0..1
  risk: 'bajo' | 'medio' | 'alto';
  product: string;
}

export interface ISimulation {
  readonly grid: GridSpec;
  readonly mapData: MapData;
  readonly scenario: ScenarioId;
  readonly year: number;
  /** compute initial 2026 footprint from mapData + run the projection for the default scenario */
  init(): void;
  setScenario(s: ScenarioId): void; // re-projects, emits 'sim:projection'
  setYear(y: number): void; // float year 2026..2050; recomputes current-year fields (cheap)
  /** advances store.year while store.playing */
  update(dt: number): void;
  cellIndexAt(x: number, z: number): number; // -1 if outside
  cell(index: number): CellInfo;
  readCell(index: number): CellReading;
  /** normalized 0..1 per cell (row-major, rows*cols) for the current year */
  layerField(layer: LayerId): Float32Array;
  /** per-cell year urbanized for the active projection (9999 = never) */
  urbanizationYears(): Float32Array;
  zones(): ZoneStats[];
  zoneStats(zoneId: string): ZoneStats | null;
  findZone(query: string): ZoneStats | null; // fuzzy, accent-insensitive
  topZones(by: 'landValue' | 'appreciation' | 'creditRisk' | 'commercialDemand' | 'growth', n: number, ascending?: boolean): ZoneStats[];
  metrics(): CityMetrics; // current year
  history(): CityMetrics[]; // one per integer year 2026..2050 for active scenario
  specs(): EstablishmentSpec[];
  spec(type: EstablishmentType): EstablishmentSpec;
  evaluateSite(type: EstablishmentType, x: number, z: number): SiteEvaluation;
  suggestSites(type: EstablishmentType, n: number): SiteEvaluation[];
  placeEstablishment(type: EstablishmentType, x: number, z: number, createdBy?: 'user' | 'mvia'): Establishment | null;
  removeEstablishment(id: string): void;
  establishments(): Establishment[];
  mortgageQuote(p: MortgageParams): MortgageQuote;
}

// ───────────────────────────── App state ─────────────────────────────
export interface Selection {
  kind: 'cell' | 'zone' | 'landmark' | 'establishment';
  id: string; // cell index as string for 'cell'
  point: Vec2;
  cellIndex: number;
}

export interface AppState {
  ready: boolean;
  loadingProgress: number; // 0..1
  loadingLabel: string;
  year: number; // float 2026..2050
  playing: boolean;
  speed: number; // years per second
  scenario: ScenarioId;
  mapStyle: MapStyle;
  layer: LayerId;
  lens: boolean; // machine-sight lens following cursor
  lensRadius: number; // css px
  compare: boolean; // split view: left = compareYear, right = current year
  compareYear: number;
  showBuildings: boolean;
  showTraffic: boolean;
  showLabels: boolean;
  tool: ToolId;
  selection: Selection | null;
  panel: PanelId;
  chatOpen: boolean;
  voiceOpen: boolean;
  /** chatbot replies are spoken aloud */
  voiceAuto: boolean;
}

export interface CameraState { x: number; z: number; zoom: number; pitch: number; bearing: number }

export interface FlyToOptions {
  x: number;
  z: number;
  /** distance-ish zoom: 0 = whole city, 1 = street level. default keeps current */
  zoom?: number;
  pitch?: number; // degrees from vertical (0 = top-down, 70 = oblique)
  bearing?: number; // degrees, 0 = north up
  duration?: number; // seconds
}

// ───────────────────────────── Event bus ─────────────────────────────
export interface BusEvents {
  state: { state: AppState; changed: Array<keyof AppState> };
  'sim:tick': { year: number; metrics: CityMetrics };
  'sim:projection': { scenario: ScenarioId };
  'sim:establishments': { list: Establishment[]; added?: Establishment; removed?: string };
  'view:flyTo': FlyToOptions;
  /** pointer moved over the map (throttled by view) */
  'view:hover': { point: Vec2 | null; cellIndex: number; screen: { x: number; y: number } };
  'view:click': { point: Vec2; cellIndex: number; screen: { x: number; y: number }; button: number };
  'view:frame': { dt: number; t: number };
  'ui:toast': { text: string; kind?: 'info' | 'ok' | 'warn' | 'risk' };
  'ui:select': Selection | null;
  'chat:ask': { text: string };
  'voice:speak': { text: string; voiceId?: string };
  'voice:stop': Record<string, never>;
  'voice:state': { speaking: boolean; level: number };
}

export interface IBus {
  on<K extends keyof BusEvents>(type: K, fn: (payload: BusEvents[K]) => void): () => void;
  emit<K extends keyof BusEvents>(type: K, payload: BusEvents[K]): void;
}

export interface IStore {
  get(): Readonly<AppState>;
  set(patch: Partial<AppState>): void;
  /** fires when any of `keys` changes (or any key if omitted) */
  subscribe(fn: (s: AppState, changed: Array<keyof AppState>) => void, keys?: Array<keyof AppState>): () => void;
}

// ───────────────────────────── 3D world & view ─────────────────────────────
export type RenderPass = 'beauty' | 'machine';

export interface ICityWorld {
  /** contains terrain, roads, water, buildings, trees, landmarks, traffic, lights, overlays */
  readonly scene: THREE.Scene;
  /** raycast target for picking */
  readonly pickables: THREE.Object3D[];
  build(onProgress: (p: number, label: string) => void): Promise<void>;
  setStyle(style: MapStyle): void;
  /** swap every material to the beauty (clay/sat/night) or machine (MVIA depth scan) variant */
  setPass(pass: RenderPass): void;
  /** building growth animation: buildings with year > y are hidden / rising */
  setYear(y: number): void;
  setUrbanizationYears(years: Float32Array): void;
  setOverlay(layer: LayerId, field: Float32Array | null): void;
  /** centre of the machine-view rings (cursor world point) */
  setFocus(p: Vec2 | null): void;
  setEstablishments(list: Establishment[]): void;
  setSelection(sel: Selection | null): void;
  setVisibility(v: { buildings: boolean; traffic: boolean }): void;
  /** world-space height of the ground at x,z (same as geo.heightAt) */
  groundY(x: number, z: number): number;
  update(dt: number, t: number, camera: THREE.Camera): void;
  stats(): { buildings: number; vehicles: number; trees: number };
}

export interface IMapView {
  readonly canvas: HTMLCanvasElement;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  /** CSS-pixel position of a world point relative to the viewport */
  project(x: number, y: number, z: number): { x: number; y: number; visible: boolean };
  flyTo(o: FlyToOptions): void;
  zoomBy(delta: number): void; // +1 = closer
  rotateBy(deg: number): void;
  setPitch(deg: number): void;
  resetNorth(): void;
  getCameraState(): CameraState;
  /** current pointer in css px + world hit (null if off-map) */
  readonly pointer: { x: number; y: number; inside: boolean; world: Vec2 | null };
  start(): void;
}

export interface AppContext {
  bus: IBus;
  store: IStore;
  sim: ISimulation;
  world: ICityWorld;
  view: IMapView;
}
