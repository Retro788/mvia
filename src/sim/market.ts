/**
 * Year-dependent fields: built density, population, land value, appreciation, flood, credit risk,
 * mortgage rate and commercial demand. All buffers are allocated once and rewritten in place.
 *
 * Land value is analytic in time so any year is O(cells):
 *   v(y) = base · exp( ln(1+a)·(y−2026) + B·σ((y−tc)/w) ) · estBoost
 * where a is the cell's trend appreciation and B a one-off log uplift (rural→urban conversion,
 * corridor upgrade, or core degradation when B<0) centred on year tc with width w.
 * The instantaneous appreciation is d ln v/dy = ln(1+a) + B·σ(1−σ)/w.
 */
import { YEAR_START } from '../core/geo';
import type { CityGrid } from './grid';
import { POP_2026 } from './grid';
import type { Projection } from './growth';
import { boxSum, buildSAT, clamp, clamp01, sigmoid, smoothstep } from './util';

export const BASE_MORTGAGE_RATE = 10.4;
export const MAX_SPREAD = 3.2;
/** rural land trades at ~30% of serviced urban land */
const RURAL_FACTOR = 0.3;
const RATE_BINS = 64;

export interface YearAggregate {
  year: number;
  population: number;
  urbanCells: number;
  avgLandValue: number;
  medianRate: number;
  creditRisk: number;
  /** Σ density × floors: proxy of housing stock */
  capacity: number;
}

export class Market {
  readonly density: Float32Array;
  readonly pop: Float32Array;
  readonly value: Float32Array;
  readonly appr: Float32Array;
  readonly flood: Float32Array;
  readonly risk: Float32Array;
  readonly rate: Float32Array;
  readonly demand: Float32Array;
  /** urban or adjacent to urban at the computed year */
  readonly near: Uint8Array;
  /** multiplicative land-value uplift from placed establishments (≥1) */
  readonly estBoost: Float32Array;
  /** persons served by placed establishments */
  readonly estSupply: Float32Array;

  private readonly popSAT: Float64Array;
  private readonly supSAT: Float64Array;
  private readonly supTmp: Float32Array;
  private readonly hist = new Float64Array(RATE_BINS);

  // per-projection
  private proj: Projection | null = null;
  private readonly base: Float32Array;
  private readonly lnA: Float32Array;
  private readonly B: Float32Array;
  private readonly tc: Float32Array;
  private readonly tw: Float32Array;
  /** trend appreciation % (exact when B = 0) */
  private readonly aPct: Float32Array;
  /** static credit-risk term: distance to jobs */
  private readonly jobsRisk: Float32Array;

  year = YEAR_START;
  totalPop = POP_2026;
  meanPopBox = 1;

  constructor(private readonly g: CityGrid) {
    const n = g.n;
    const F = () => new Float32Array(n);
    this.density = F(); this.pop = F(); this.value = F(); this.appr = F(); this.flood = F();
    this.risk = F(); this.rate = F(); this.demand = F(); this.near = new Uint8Array(n);
    this.estBoost = F().fill(1); this.estSupply = F(); this.supTmp = F();
    this.base = F(); this.lnA = F(); this.B = F(); this.tc = F(); this.tw = F(); this.aPct = F();
    this.jobsRisk = F();
    for (let k = 0; k < n; k++) this.jobsRisk[k] = 1 - Math.exp(-g.jobsDist[k] / 150);
    const satN = (g.cols + 1) * (g.rows + 1);
    this.popSAT = new Float64Array(satN);
    this.supSAT = new Float64Array(satN);
  }

  get projection(): Projection {
    if (!this.proj) throw new Error('Market sin proyección');
    return this.proj;
  }

  /** per-cell constants of the value model for a projection */
  prepare(proj: Projection): void {
    this.proj = proj;
    const g = this.g;
    const P = proj.params;
    const floodPts = 1 + P.floodWorsening * 4;
    const lnConv = Math.log(1 / RURAL_FACTOR) * P.conversion;
    for (let k = 0; k < g.n; k++) {
      const yu = proj.yearU[k];
      const ub = g.urbanBase[k];
      let a = P.appreciation + (0.5 - g.incomeRisk[k]) * 1.0 - g.flood[k] * floodPts - 0.05 * Math.max(0, g.slope[k] - 15);
      let base = ub;
      let B = 0;
      let tc = 2038;
      let tw = 4;
      if (yu <= YEAR_START) {
        a += proj.edgeBoost[k] * 1.2;
        if (P.id === 'descontrolado' && g.urban0[k] > 0.6) B = Math.log(0.9); // congested core loses ground
        if (proj.corridor[k]) {
          B = Math.log(1.16);
          tc = 2035;
          tw = 3;
        }
      } else if (yu < 9000) {
        base = ub * RURAL_FACTOR;
        B = lnConv * (proj.invaded[k] ? 0.55 : 1);
        tc = yu - 1;
        tw = 1.4;
      } else {
        base = ub * RURAL_FACTOR;
        a += -1.2 + proj.edgeBoost[k] * 1.5; // speculation on rural land next to the front
      }
      if (g.water[k]) base = 0;
      // existing fabric starts every scenario at the same 2026 value
      if (yu <= YEAR_START && B !== 0) base /= Math.exp(B * sigmoid((YEAR_START - tc) / tw));
      const ac = clamp(a, 0.5, 12);
      this.base[k] = base;
      this.aPct[k] = ac;
      this.lnA[k] = Math.log(1 + ac / 100);
      this.B[k] = B;
      this.tc[k] = tc;
      this.tw[k] = tw;
    }
  }

  /**
   * Fill every year field for year y. `full` also computes the near mask and commercial demand
   * (skipped for the history pre-pass). `useEst` applies the establishment uplift.
   */
  computeYear(y: number, full: boolean, useEst: boolean): YearAggregate {
    const g = this.g;
    const proj = this.projection;
    const P = proj.params;
    const n = g.n;
    const t = y - YEAR_START;
    this.year = y;
    const totalPop = POP_2026 * Math.pow(1 + P.popGrowth / 100, t);
    this.totalPop = totalPop;

    // pass 1 — density and population weights
    let sumW = 0;
    const yearU = proj.yearU;
    for (let k = 0; k < n; k++) {
      const yu = yearU[k];
      let d = 0;
      if (yu <= YEAR_START) d = Math.min(1, g.urban0[k] + proj.densify[k] * t);
      else if (yu <= y) d = proj.newDensity[k] * (1 - Math.exp(-(y - yu + 0.3) / 3));
      this.density[k] = d;
      sumW += d * g.floorsMid[k];
    }
    const popScale = sumW > 0 ? totalPop / sumW : 0;
    const fw = (P.floodWorsening * t) / 24;
    const hist = this.hist;
    hist.fill(0);
    let cnt = 0, sumV = 0, riskPop = 0, popSum = 0, cap = 0;

    // pass 2 — value, appreciation, flood, credit risk, mortgage rate
    for (let k = 0; k < n; k++) {
      const d = this.density[k];
      const p = d * g.floorsMid[k] * popScale;
      this.pop[k] = p;
      const B = this.B[k];
      let v: number;
      let ap: number;
      if (B === 0) {
        v = this.base[k] * Math.exp(this.lnA[k] * t);
        ap = this.aPct[k];
      } else {
        const tw = this.tw[k];
        const s = sigmoid((y - this.tc[k]) / tw);
        v = this.base[k] * Math.exp(this.lnA[k] * t + B * s);
        ap = (Math.exp(this.lnA[k] + (B * s * (1 - s)) / tw) - 1) * 100;
      }
      if (useEst) v *= this.estBoost[k];
      this.value[k] = v;
      this.appr[k] = ap;
      const fl = Math.min(1, g.flood[k] * (1 + fw * (0.5 + 0.5 * proj.edgeBoost[k])));
      this.flood[k] = fl;
      const yu = yearU[k];
      const vol = Math.min(1, Math.abs(ap - P.appreciation) / 8);
      const informal = proj.invaded[k] ? 0.3 : P.id === 'descontrolado' && yu > YEAR_START && yu < 9000 ? 0.08 : 0;
      const cr = clamp(0.06 + 0.42 * g.incomeRisk[k] + 0.16 * vol + 0.22 * fl + informal + 0.12 * this.jobsRisk[k] + P.creditMacro, 0.02, 0.98);
      this.risk[k] = cr;
      const r = BASE_MORTGAGE_RATE + MAX_SPREAD * smoothstep(0.15, 0.9, cr);
      this.rate[k] = r;
      if (d > 0) {
        cnt++;
        sumV += v;
        riskPop += cr * p;
        popSum += p;
        cap += d * g.floorsMid[k];
        const b = Math.min(RATE_BINS - 1, Math.max(0, Math.floor(((r - BASE_MORTGAGE_RATE) / MAX_SPREAD) * RATE_BINS)));
        hist[b]++;
      }
    }
    // median from histogram
    let median = BASE_MORTGAGE_RATE;
    if (cnt) {
      let acc = 0;
      for (let b = 0; b < RATE_BINS; b++) {
        acc += hist[b];
        if (acc >= cnt / 2) {
          median = BASE_MORTGAGE_RATE + ((b + 0.5) / RATE_BINS) * MAX_SPREAD;
          break;
        }
      }
    }

    if (full) this.computeSpatial();

    return {
      year: y,
      population: totalPop,
      urbanCells: cnt,
      avgLandValue: cnt ? sumV / cnt : 0,
      medianRate: median,
      creditRisk: popSum > 0 ? riskPop / popSum : 0,
      capacity: cap,
    };
  }

  /** near mask + commercial demand (needs population of the computed year) */
  private computeSpatial(): void {
    const g = this.g;
    const { cols, rows, n } = g;
    // near = urban or any 8-neighbour urban
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        let near = this.density[k] > 0 ? 1 : 0;
        for (let dj = -1; dj <= 1 && !near; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= rows) continue;
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            if (ii >= 0 && ii < cols && this.density[jj * cols + ii] > 0) {
              near = 1;
              break;
            }
          }
        }
        this.near[k] = near;
      }
    }
    // commercial demand: population in a 1.3 km window vs. retail supply serving it
    for (let k = 0; k < n; k++) this.supTmp[k] = g.supplyStatic[k] + this.estSupply[k];
    buildSAT(this.pop, cols, rows, this.popSAT);
    buildSAT(this.supTmp, cols, rows, this.supSAT);
    const R = 6;
    let sum = 0;
    let cnt = 0;
    for (let k = 0; k < n; k++) {
      const i = k % cols;
      const j = (k - i) / cols;
      const ps = boxSum(this.popSAT, cols, rows, i, j, R);
      this.demand[k] = ps; // temp: population sum
      if (this.density[k] > 0) {
        sum += ps;
        cnt++;
      }
    }
    const mean = cnt ? sum / cnt : 1;
    this.meanPopBox = mean;
    const corridor = this.projection.corridor;
    for (let k = 0; k < n; k++) {
      const i = k % cols;
      const j = (k - i) / cols;
      const ps = this.demand[k];
      const ss = boxSum(this.supSAT, cols, rows, i, j, R);
      const intensity = Math.min(1, ps / (1.3 * mean));
      const gap = clamp01(1 - ss / (ps + 1));
      this.demand[k] = clamp01(intensity * (0.2 + 0.8 * gap) * (corridor[k] ? 1.15 : 1));
    }
  }

  /** persons living in the (2R+1)² cell box around (i,j) at the computed year */
  popBox(i: number, j: number, R: number): number {
    return boxSum(this.popSAT, this.g.cols, this.g.rows, i, j, R);
  }

  supplyBox(i: number, j: number, R: number): number {
    return boxSum(this.supSAT, this.g.cols, this.g.rows, i, j, R);
  }
}
