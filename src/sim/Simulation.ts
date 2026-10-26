/**
 * MVIA simulation + financial engine.
 * Owns the static city raster (CityGrid), the active growth projection (cached per scenario),
 * the year-dependent market fields (Market) and the establishment portfolio.
 * Talks to the rest of the app only through the Store and the Bus.
 */
import type {
  CellInfo, CellReading, CityMetrics, Establishment, EstablishmentSpec, EstablishmentType, GridSpec, IBus,
  ISimulation, IStore, LayerId, MapData, MortgageParams, MortgageQuote, ScenarioId, SiteEvaluation, Verdict, Zone,
  ZoneStats,
} from '../core/types';
import { GRID, YEAR_END, YEAR_START, cellIndexAt, fmtInt, fmtPct } from '../core/geo';
import { CityGrid, POP_2026 } from './grid';
import { SCENARIOS, YEARS, runProjection, type Projection } from './growth';
import { BASE_MORTGAGE_RATE, MAX_SPREAD, Market, type YearAggregate } from './market';
import { MODEL, SPECS, SPEC_ORDER, establishmentName, evaluateSite, suggestSites, type EvalContext } from './establishments';
import { quoteMortgage } from './finance';
import { clamp, km, matchScore, money } from './util';

const HOUSEHOLD_SIZE = 3.5;
/** 2026 housing stock covers ~95.5% of households (≈ 10k dwellings deficit) */
const STOCK_COVERAGE_2026 = 0.955;
/** log-normalisation range of land value layer (MXN/m²); fixed so the overlay "heats up" over time */
const LV_LO = Math.log(800);
const LV_HI = Math.log(90000);
const EST_RADIUS = 40; // world units of land-value uplift around an establishment

type RankKey = 'landValue' | 'appreciation' | 'creditRisk' | 'commercialDemand' | 'growth';

const riskWord = (r: number): string => (r < 0.3 ? 'bajo' : r < 0.5 ? 'medio' : 'alto');
const levelWord = (v: number): string => (v < 0.25 ? 'bajo' : v < 0.5 ? 'medio' : v < 0.75 ? 'alto' : 'muy alto');

export class Simulation implements ISimulation {
  readonly grid: GridSpec = GRID;
  readonly mapData: MapData;

  private g!: CityGrid;
  private m!: Market;
  private proj!: Projection;
  private readonly projCache = new Map<ScenarioId, Projection>();
  private _scenario: ScenarioId;
  private _year: number = YEAR_START;
  private yearKey = -1;
  private lastTickYear = -1;
  private ready = false;

  private agg: YearAggregate[] = [];
  private hist: CityMetrics[] = [];
  private estList: Establishment[] = [];
  private estSeq = 0;
  private estVersion = 0;
  private readonly layerBuf = new Map<LayerId, Float32Array>();
  private zoneCache: { key: string; stats: ZoneStats[] } | null = null;
  private readonly zoneIndex = new Map<string, number>();

  constructor(private readonly bus: IBus, private readonly store: IStore, mapData: MapData) {
    this.mapData = mapData;
    this._scenario = store.get().scenario;
    mapData.zones.forEach((z, i) => this.zoneIndex.set(z.id, i));
  }

  get scenario(): ScenarioId {
    return this._scenario;
  }

  get year(): number {
    return this._year;
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  init(): void {
    const t0 = performance.now();
    this.g = new CityGrid(this.mapData);
    this.m = new Market(this.g);
    const s = this.store.get();
    this._scenario = s.scenario;
    this._year = clamp(s.year, YEAR_START, YEAR_END);
    this.applyScenario(s.scenario);
    this.seedEstablishments();
    this.ready = true;
    this.setYear(this._year);
    console.info(
      `[MVIA sim] ${this.g.urbanCount0} ha urbanas 2026 (${this.mapData.source}) · proyección ${this.proj.ms.toFixed(0)} ms · init ${(performance.now() - t0).toFixed(0)} ms`,
    );
  }

  setScenario(s: ScenarioId): void {
    if (!SCENARIOS[s]) return;
    if (s === this._scenario && this.ready) return;
    this._scenario = s;
    this.applyScenario(s);
    this.bus.emit('sim:projection', { scenario: s });
    if (this.store.get().scenario !== s) this.store.set({ scenario: s });
  }

  setYear(y: number): void {
    const yy = clamp(Number.isFinite(y) ? y : YEAR_START, YEAR_START, YEAR_END);
    this._year = yy;
    if (!this.m) return;
    const key = Math.floor(yy * 4);
    if (key !== this.yearKey) {
      this.yearKey = key;
      this.recompute(key / 4);
    }
    const fy = Math.floor(yy);
    if (fy !== this.lastTickYear && this.ready) {
      this.lastTickYear = fy;
      this.bus.emit('sim:tick', { year: yy, metrics: this.metrics() });
    }
  }

  update(dt: number): void {
    const s = this.store.get();
    if (!s.playing) return;
    const step = Math.min(0.1, Math.max(0, dt)) * s.speed;
    if (step <= 0) return;
    const y = s.year + step;
    if (y >= YEAR_END) this.store.set({ year: YEAR_END, playing: false });
    else this.store.set({ year: y });
    this.setYear(this.store.get().year); // no-op when the store wiring already forwarded it
  }

  /** run (or reuse) the projection, rebuild the per-year history and the current year */
  private applyScenario(s: ScenarioId): void {
    let p = this.projCache.get(s);
    if (!p) {
      p = runProjection(this.g, s);
      this.projCache.set(s, p);
    }
    this.proj = p;
    this.m.prepare(p);
    this.buildHistory();
    this.yearKey = -1;
    this.zoneCache = null;
    this.recompute(Math.floor(this._year * 4) / 4);
    this.yearKey = Math.floor(this._year * 4);
  }

  private buildHistory(): void {
    const p = this.proj;
    this.agg = [];
    for (let i = 0; i < YEARS; i++) this.agg.push(this.m.computeYear(YEAR_START + i, false, false));
    const cap0 = this.agg[0].capacity || 1;
    const stock0 = (POP_2026 / HOUSEHOLD_SIZE) * STOCK_COVERAGE_2026;
    this.hist = this.agg.map((a, i) => {
      const households = a.population / HOUSEHOLD_SIZE;
      const stock = stock0 * (a.capacity / cap0);
      return {
        year: a.year,
        population: a.population,
        urbanAreaKm2: p.urbanCells[i] * 0.01, // 1 cell = 1 ha = 0.01 km²
        avgLandValue: a.avgLandValue,
        medianMortgageRate: a.medianRate,
        creditDefaultRisk: a.creditRisk,
        sprawlIndex: p.sprawl[i],
        greenLossHa: p.greenLossHa[i],
        housingDeficit: Math.max(0, Math.round(households - stock)),
        commercialCount: 0,
        investmentPipeline: 0,
      };
    });
  }

  /** current-year fields (lazy, quantised to quarter years) */
  private recompute(y: number): void {
    this.updateEstablishmentFields(y);
    this.m.computeYear(y, true, true);
    this.zoneCache = null;
  }

  private updateEstablishmentFields(y: number): void {
    const { g, m } = this;
    m.estBoost.fill(1);
    m.estSupply.fill(0);
    const R = Math.ceil(EST_RADIUS / g.cs);
    for (const e of this.estList) {
      if (e.year > y) continue;
      const k = g.cellAt(e.pos.x, e.pos.z);
      if (k < 0) continue;
      const md = MODEL[e.type];
      m.estSupply[k] += md.supply;
      const i = k % g.cols;
      const j = (k - i) / g.cols;
      for (let dj = -R; dj <= R; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= g.rows) continue;
        for (let di = -R; di <= R; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= g.cols) continue;
          const q = jj * g.cols + ii;
          const d = Math.hypot(g.cx[q] - e.pos.x, g.cz[q] - e.pos.z);
          if (d >= EST_RADIUS) continue;
          m.estBoost[q] = Math.min(1.3, m.estBoost[q] + md.boost * (1 - d / EST_RADIUS));
        }
      }
    }
  }

  // ───────────────────────────── cells ─────────────────────────────

  cellIndexAt(x: number, z: number): number {
    return cellIndexAt(x, z, this.grid);
  }

  private idx(index: number): number {
    const n = this.g.n;
    if (!Number.isFinite(index)) return 0;
    return clamp(Math.floor(index), 0, n - 1);
  }

  cell(index: number): CellInfo {
    const { g, m } = this;
    const k = this.idx(index);
    const i = k % g.cols;
    const j = (k - i) / g.cols;
    const zi = g.zoneIdx[k];
    const zone: Zone | null = zi >= 0 ? g.zones[zi] : null;
    return {
      index: k,
      i,
      j,
      center: { x: g.cx[k], z: g.cz[k] },
      zoneId: zone && !g.rural[k] ? zone.id : null,
      zoneName: zone ? zone.name : 'Periferia de Xalapa',
      elevation: g.elevation[k],
      slope: g.slope[k],
      urban: m.density[k],
      yearUrbanized: this.proj.yearU[k],
      landValue: m.value[k],
      appreciation: m.appr[k],
      floodRisk: m.flood[k],
      creditRisk: m.risk[k],
      mortgageRate: m.rate[k],
      commercialDemand: m.demand[k],
      protected: g.protectedMask[k] === 1,
      population: m.pop[k],
    };
  }

  readCell(index: number): CellReading {
    const c = this.cell(index);
    const k = c.index;
    const g = this.g;
    const P = this.proj.params;
    const y = this._year;
    const yu = c.yearUrbanized;
    const urbanNow = c.urban > 0;
    const future = yu > y && yu < 9000;
    const recent = yu > YEAR_START && yu <= y;
    const water = g.water[k] === 1;
    const invaded = this.proj.invaded[k] === 1;
    const avgValue = this.metrics().avgLandValue;

    let verdict: Verdict;
    let tag: string;
    if (water) {
      verdict = 'riesgo';
      tag = 'cuerpo de agua';
    } else if (c.protected && (urbanNow || (invaded && future))) {
      verdict = 'riesgo';
      tag = urbanNow ? 'invasión de área protegida' : `invasión proyectada ${Math.ceil(yu)}`;
    } else if (c.protected) {
      verdict = 'precaucion';
      tag = 'reserva ecológica';
    } else if (c.floodRisk >= 0.6) {
      verdict = 'riesgo';
      tag = 'zona inundable';
    } else if (c.creditRisk >= 0.6) {
      verdict = 'riesgo';
      tag = 'riesgo de impago alto';
    } else if (c.slope >= 22) {
      verdict = 'precaucion';
      tag = 'ladera pronunciada';
    } else {
      if (c.floodRisk >= 0.38 || c.creditRisk >= 0.45) verdict = 'precaucion';
      else if (c.appreciation >= P.appreciation + 0.3 && c.creditRisk < 0.33 && (urbanNow || future)) verdict = 'viable';
      else verdict = 'observar';
      if (future) tag = `frente de expansión ${Math.ceil(yu)}`;
      else if (recent) tag = 'urbanización reciente';
      else if (!urbanNow) tag = 'suelo rural';
      else if (c.appreciation >= P.appreciation + 1.5) tag = 'plusvalía acelerada';
      else if (c.landValue >= avgValue * 1.5) tag = 'alto valor consolidado';
      else if (this.proj.corridor[k]) tag = 'corredor comercial';
      else if (c.floodRisk >= 0.38) tag = 'inundación moderada';
      else if (c.appreciation < P.appreciation - 1) tag = 'plusvalía rezagada';
      else tag = 'plusvalía sostenida';
    }

    const title = `${c.zoneName}${g.rural[k] ? ' (periferia)' : ''} · ${tag}`;
    let summary: string;
    if (water) {
      summary = 'Cuerpo de agua: no urbanizable. Las celdas vecinas cargan el mayor riesgo de inundación del sector.';
    } else {
      summary =
        `Suelo a ${money(c.landValue)}/m² con plusvalía de ${fmtPct(c.appreciation)} anual; ` +
        `hipoteca típica ${fmtPct(c.mortgageRate, 2)} y riesgo crediticio ${riskWord(c.creditRisk)} (${c.creditRisk.toFixed(2)}).`;
      if (c.protected && urbanNow) summary += ' Asentamiento irregular sobre área protegida: sin certeza jurídica para crédito.';
      else if (c.protected) summary += ' Reserva ecológica: no apta para desarrollo ni garantía hipotecaria.';
      else if (future) summary += ` El escenario «${P.label.toLowerCase()}» la urbaniza hacia ${Math.ceil(yu)}.`;
      else if (c.floodRisk >= 0.6) summary += ' Alta probabilidad de inundación en temporada de lluvias.';
      else if (c.commercialDemand >= 0.6) summary += ` Demanda comercial insatisfecha (${Math.round(c.commercialDemand * 100)}/100).`;
    }

    const urbanizedLabel =
      yu <= YEAR_START ? `≈${Math.round(yu)} · consolidado` : yu < 9000 ? `${Math.ceil(yu)}${future ? ' · proyección' : ''}` : 'Sin urbanizar a 2050';

    const rows: Array<[string, string]> = [
      ['Valor suelo', `${money(c.landValue)}/m²`],
      ['Plusvalía anual', fmtPct(c.appreciation)],
      ['Tasa hipotecaria', fmtPct(c.mortgageRate, 2)],
      ['Riesgo crediticio', `${Math.round(c.creditRisk * 100)}/100 · ${riskWord(c.creditRisk)}`],
      ['Demanda comercial', `${Math.round(c.commercialDemand * 100)}/100 · ${levelWord(c.commercialDemand)}`],
      ['Riesgo inundación', `${Math.round(c.floodRisk * 100)}/100 · ${levelWord(c.floodRisk)}`],
      ['Pendiente', `${c.slope.toFixed(1)}°`],
      ['Población celda', `${fmtInt(c.population)} hab.`],
      ['Urbanizado desde', urbanizedLabel],
    ];

    const fi = g.frontIdx[k];
    const footer = fi >= 0 && g.fronts[fi] ? `Frente de crecimiento: ${g.fronts[fi].name} · ${km(g.frontDist[k])}` : `Escenario: ${P.label}`;
    return { verdict, title, summary, rows, footer };
  }

  layerField(layer: LayerId): Float32Array {
    const { g, m } = this;
    const n = g.n;
    let buf = this.layerBuf.get(layer);
    if (!buf) {
      buf = new Float32Array(n);
      this.layerBuf.set(layer, buf);
    }
    const near = m.near;
    switch (layer) {
      case 'landValue':
        for (let k = 0; k < n; k++) {
          const v = m.value[k];
          buf[k] = near[k] && v > 0 ? clamp((Math.log(v) - LV_LO) / (LV_HI - LV_LO), 0, 1) : 0;
        }
        break;
      case 'growth': {
        const y = this._year;
        const yearU = this.proj.yearU;
        for (let k = 0; k < n; k++) {
          const yu = yearU[k];
          if (yu <= YEAR_START) buf[k] = 0.25;
          else if (yu <= y) buf[k] = 1;
          else if (yu < y + 6) buf[k] = 0.12 + 0.45 * (1 - (yu - y) / 6); // pressure: urbanizes within 6 years
          else buf[k] = 0;
        }
        break;
      }
      case 'creditRisk':
        for (let k = 0; k < n; k++) buf[k] = near[k] ? m.risk[k] : 0;
        break;
      case 'mortgage':
        for (let k = 0; k < n; k++) buf[k] = near[k] ? clamp((m.rate[k] - BASE_MORTGAGE_RATE) / MAX_SPREAD, 0, 1) : 0;
        break;
      case 'commercial':
        for (let k = 0; k < n; k++) buf[k] = near[k] ? m.demand[k] : 0;
        break;
      case 'floodRisk':
        buf.set(m.flood);
        break;
      case 'density':
        for (let k = 0; k < n; k++) buf[k] = Math.min(1, m.density[k]);
        break;
      case 'none':
      default:
        buf.fill(0);
        break;
    }
    return buf;
  }

  urbanizationYears(): Float32Array {
    return this.proj.yearU;
  }

  // ───────────────────────────── zones ─────────────────────────────

  zones(): ZoneStats[] {
    const key = `${this._scenario}|${this.yearKey}|${this.estVersion}`;
    if (this.zoneCache && this.zoneCache.key === key) return this.zoneCache.stats;
    const { g, m } = this;
    const zones = g.zones;
    const Z = zones.length;
    const cnt = new Float64Array(Z), uc = new Float64Array(Z), pop = new Float64Array(Z), riskPop = new Float64Array(Z);
    const sV = new Float64Array(Z), sA = new Float64Array(Z), sR = new Float64Array(Z), sRate = new Float64Array(Z);
    const sD = new Float64Array(Z), sF = new Float64Array(Z);
    const aV = new Float64Array(Z), aA = new Float64Array(Z), aR = new Float64Array(Z), aRate = new Float64Array(Z);
    const aD = new Float64Array(Z), aF = new Float64Array(Z);
    for (let k = 0; k < g.n; k++) {
      const zi = g.zoneIdx[k];
      if (zi < 0 || g.rural[k] || g.water[k]) continue;
      cnt[zi]++;
      pop[zi] += m.pop[k];
      riskPop[zi] += m.risk[k] * m.pop[k];
      aV[zi] += m.value[k]; aA[zi] += m.appr[k]; aR[zi] += m.risk[k]; aRate[zi] += m.rate[k]; aD[zi] += m.demand[k]; aF[zi] += m.flood[k];
      if (m.density[k] > 0) {
        uc[zi]++;
        sV[zi] += m.value[k]; sA[zi] += m.appr[k]; sR[zi] += m.risk[k]; sRate[zi] += m.rate[k]; sD[zi] += m.demand[k]; sF[zi] += m.flood[k];
      }
    }
    const baseAppr = this.proj.params.appreciation;
    const stats: ZoneStats[] = zones.map((zone, zi) => {
      let landValue: number, appreciation: number, creditRisk: number, mortgageRate: number, commercialDemand: number, flood: number;
      if (uc[zi] > 0) {
        const u = uc[zi];
        landValue = sV[zi] / u; appreciation = sA[zi] / u; creditRisk = sR[zi] / u; mortgageRate = sRate[zi] / u; commercialDemand = sD[zi] / u; flood = sF[zi] / u;
      } else if (cnt[zi] > 0) {
        const c = cnt[zi];
        landValue = aV[zi] / c; appreciation = aA[zi] / c; creditRisk = aR[zi] / c; mortgageRate = aRate[zi] / c; commercialDemand = aD[zi] / c; flood = aF[zi] / c;
      } else {
        const k = this.cellIndexAt(zone.center.x, zone.center.z);
        const kk = k >= 0 ? k : 0;
        landValue = m.value[kk]; appreciation = m.appr[kk]; creditRisk = m.risk[kk]; mortgageRate = m.rate[kk]; commercialDemand = m.demand[kk]; flood = m.flood[kk];
      }
      if (pop[zi] > 0) creditRisk = riskPop[zi] / pop[zi];
      let verdict: Verdict;
      if (flood >= 0.55 || creditRisk >= 0.6) verdict = 'riesgo';
      else if (flood >= 0.38 || creditRisk >= 0.45) verdict = 'precaucion';
      else if (appreciation >= baseAppr + 0.3 && creditRisk < 0.33) verdict = 'viable';
      else verdict = 'observar';
      return {
        zone,
        landValue,
        appreciation,
        creditRisk,
        mortgageRate,
        commercialDemand,
        population: pop[zi],
        urbanShare: cnt[zi] > 0 ? uc[zi] / cnt[zi] : 0,
        verdict,
      };
    });
    this.zoneCache = { key, stats };
    return stats;
  }

  zoneStats(zoneId: string): ZoneStats | null {
    const zi = this.zoneIndex.get(zoneId);
    if (zi === undefined) return null;
    return this.zones()[zi] ?? null;
  }

  findZone(query: string): ZoneStats | null {
    if (!query || !query.trim()) return null;
    const zones = this.mapData.zones;
    let best = -1;
    let bestScore = 0;
    zones.forEach((z, i) => {
      const s = Math.max(matchScore(query, z.name), matchScore(query, z.id) * 0.95);
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    });
    // landmarks ("Plaza Américas", "Los Lagos") resolve to the zone that contains them
    for (const l of this.mapData.landmarks) {
      const s = matchScore(query, l.name) * 0.92;
      if (s > bestScore) {
        const k = this.cellIndexAt(l.pos.x, l.pos.z);
        if (k < 0) continue;
        const zi = this.g.zoneIdx[k];
        if (zi < 0) continue;
        bestScore = s;
        best = zi;
      }
    }
    if (best < 0 || bestScore < 0.55) return null;
    return this.zones()[best] ?? null;
  }

  topZones(by: RankKey, n: number, ascending = false): ZoneStats[] {
    const stats = this.zones();
    const p = this.proj;
    const val = (s: ZoneStats): number => {
      switch (by) {
        case 'landValue': return s.landValue;
        case 'appreciation': return s.appreciation;
        case 'creditRisk': return s.creditRisk;
        case 'commercialDemand': return s.commercialDemand;
        case 'growth': {
          const zi = this.zoneIndex.get(s.zone.id) ?? -1;
          return zi >= 0 ? p.newByZone[zi] / Math.max(1, p.cellsByZone[zi]) + p.newByZone[zi] * 1e-4 : 0;
        }
      }
    };
    const sorted = stats
      .filter((s) => s.population > 0 || by === 'growth' || s.urbanShare > 0 || s.landValue > 0)
      .map((s) => ({ s, v: val(s) }))
      .sort((a, b) => (ascending ? a.v - b.v : b.v - a.v));
    return sorted.slice(0, Math.max(0, n)).map((e) => e.s);
  }

  // ───────────────────────────── metrics ─────────────────────────────

  private establishmentTotals(y: number): { commercial: number; investment: number } {
    let commercial = 0;
    let investment = 0;
    for (const e of this.estList) {
      if (e.year > y) continue;
      investment += e.investment;
      if (MODEL[e.type].commercial) commercial++;
    }
    return { commercial, investment };
  }

  metrics(): CityMetrics {
    const y = this._year;
    if (!this.hist.length) {
      return {
        year: y, population: POP_2026, urbanAreaKm2: 0, avgLandValue: 0, medianMortgageRate: BASE_MORTGAGE_RATE,
        creditDefaultRisk: 0, sprawlIndex: 0, greenLossHa: 0, housingDeficit: 0, commercialCount: 0, investmentPipeline: 0,
      };
    }
    const f = clamp(y - YEAR_START, 0, YEARS - 1);
    const i0 = Math.floor(f);
    const i1 = Math.min(YEARS - 1, i0 + 1);
    const t = f - i0;
    const a = this.hist[i0];
    const b = this.hist[i1];
    const L = (u: number, v: number) => u + (v - u) * t;
    const est = this.establishmentTotals(y);
    const population = L(a.population, b.population);
    return {
      year: y,
      population,
      urbanAreaKm2: L(a.urbanAreaKm2, b.urbanAreaKm2),
      avgLandValue: L(a.avgLandValue, b.avgLandValue),
      medianMortgageRate: L(a.medianMortgageRate, b.medianMortgageRate),
      creditDefaultRisk: L(a.creditDefaultRisk, b.creditDefaultRisk),
      sprawlIndex: L(a.sprawlIndex, b.sprawlIndex),
      greenLossHa: L(a.greenLossHa, b.greenLossHa),
      housingDeficit: Math.round(L(a.housingDeficit, b.housingDeficit)),
      // ~1 retail unit (DENUE comercio) per 55 inhabitants + placed establishments
      commercialCount: Math.round(population / 55) + est.commercial,
      investmentPipeline: est.investment,
    };
  }

  history(): CityMetrics[] {
    return this.hist.map((h) => {
      const est = this.establishmentTotals(h.year);
      return { ...h, commercialCount: Math.round(h.population / 55) + est.commercial, investmentPipeline: est.investment };
    });
  }

  // ───────────────────────────── establishments ─────────────────────────────

  specs(): EstablishmentSpec[] {
    return SPEC_ORDER.map((t) => SPECS[t]);
  }

  spec(type: EstablishmentType): EstablishmentSpec {
    return SPECS[type] ?? SPECS.tienda;
  }

  private ctx(): EvalContext {
    return { g: this.g, m: this.m, year: this._year, list: this.estList, landmarks: this.mapData.landmarks };
  }

  evaluateSite(type: EstablishmentType, x: number, z: number): SiteEvaluation {
    return evaluateSite(this.ctx(), type, x, z, true);
  }

  suggestSites(type: EstablishmentType, n: number): SiteEvaluation[] {
    return suggestSites(this.ctx(), type, Math.min(20, Math.max(0, Math.floor(n))));
  }

  private createEstablishment(ev: SiteEvaluation, createdBy: 'user' | 'mvia'): Establishment {
    const g = this.g;
    const zi = ev.cellIndex >= 0 ? g.zoneIdx[ev.cellIndex] : -1;
    const zone = zi >= 0 ? g.zones[zi] : null;
    const name = establishmentName(ev.type, zone?.name ?? 'Xalapa', zone?.center ?? null, ev.pos, this.estList);
    const est: Establishment = { ...ev, id: `est-${++this.estSeq}`, name, year: Math.floor(this._year), createdBy };
    this.estList.push(est);
    return est;
  }

  private establishmentsChanged(): void {
    this.estVersion++;
    this.recompute(Math.floor(this._year * 4) / 4);
    this.yearKey = Math.floor(this._year * 4);
  }

  placeEstablishment(type: EstablishmentType, x: number, z: number, createdBy: 'user' | 'mvia' = 'user'): Establishment | null {
    const spec = this.spec(type);
    const ev = evaluateSite(this.ctx(), type, x, z, true);
    if (!ev.allowed) {
      this.bus.emit('ui:toast', { text: `No se puede ubicar ${spec.label.toLowerCase()}: ${ev.reason ?? 'sitio no permitido'}`, kind: 'risk' });
      return null;
    }
    const est = this.createEstablishment(ev, createdBy);
    this.establishmentsChanged();
    const list = this.establishments();
    this.bus.emit('sim:establishments', { list, added: est });
    const kind = est.verdict === 'viable' ? 'ok' : est.verdict === 'observar' ? 'info' : est.verdict === 'precaucion' ? 'warn' : 'risk';
    this.bus.emit('ui:toast', {
      text: `${spec.short} · ${est.name} — inversión ${money(est.investment)}, ROI ${fmtPct(est.roi)}, retorno ${est.paybackYears.toFixed(1)} años`,
      kind,
    });
    return est;
  }

  removeEstablishment(id: string): void {
    const i = this.estList.findIndex((e) => e.id === id);
    if (i < 0) return;
    const [removed] = this.estList.splice(i, 1);
    this.establishmentsChanged();
    this.bus.emit('sim:establishments', { list: this.establishments(), removed: id });
    this.bus.emit('ui:toast', { text: `Eliminado: ${removed.name}`, kind: 'info' });
  }

  establishments(): Establishment[] {
    return this.estList.slice();
  }

  /** MVIA's own portfolio so the map is not empty: best sites per type at 2026 */
  private seedEstablishments(): void {
    const plan: Array<[EstablishmentType, number]> = [
      ['supermercado', 2], ['tienda', 2], ['plaza', 1], ['plazoleta', 1], ['vivienda', 1], ['oficinas', 1],
    ];
    const ctx = this.ctx();
    for (const [type, count] of plan) {
      for (const ev of suggestSites(ctx, type, count, this.estList.map((e) => e.pos))) {
        this.createEstablishment(ev, 'mvia');
      }
    }
    this.establishmentsChanged();
  }

  // ───────────────────────────── finance ─────────────────────────────

  mortgageQuote(p: MortgageParams): MortgageQuote {
    let rate: number | null = null;
    let risk: number | null = null;
    if (p.cellIndex !== undefined && p.cellIndex >= 0 && p.cellIndex < this.g.n) {
      rate = this.m.rate[p.cellIndex];
      risk = this.m.risk[p.cellIndex];
    } else if (this.hist.length) {
      const mt = this.metrics();
      rate = mt.medianMortgageRate;
      risk = mt.creditDefaultRisk;
    }
    return quoteMortgage(p, rate, risk);
  }
}
