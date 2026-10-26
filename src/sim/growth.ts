/**
 * Land-use projection 2026→2050: a constrained cellular automaton.
 *
 * Each year a quota of new urban cells (logistic cumulative curve towards the scenario target) is
 * allocated to the highest-scoring candidates, where
 *   score = S_static × (leap + w3·share3×3 + w5·share5×5) × jitter
 * S_static mixes road access (main roads dominate), growth-front attraction, slope / flood penalties
 * and land-protection rules. Neighbour counts are maintained incrementally, so a full 24-year run is
 * O(years × cells) plus one native typed-array sort per year (≈ 30–80 ms).
 */
import type { ScenarioId } from '../core/types';
import { YEAR_END, YEAR_START, fbm, rng } from '../core/geo';
import type { CityGrid } from './grid';
import { clamp01, smoothstep } from './util';

export interface ScenarioParams {
  id: ScenarioId;
  label: string;
  /** relative growth of the urban cell count by 2050 */
  target: number;
  /** logistic midpoint year / steepness of the yearly quota */
  mid: number;
  k: number;
  /** share of the yearly quota allocated to detached cells (leapfrog sprawl) */
  leap: number;
  wNb3: number;
  wNb5: number;
  wMain: number;
  wAny: number;
  wFront: number;
  /** slope (deg) tolerated without penalty, and e-folding scale beyond it */
  slopeFree: number;
  slopeScale: number;
  floodW: number;
  /** penalty multiplier on parks / farmland */
  greenMul: number;
  /** max share of protected/forest cells that may be invaded */
  protectedShare: number;
  minNb3: number;
  newDensity: [number, number];
  /** yearly densification of existing fabric (× (1 − d0)) */
  densify: number;
  /** extra yearly densification along main-road corridors (also flags commercial corridors) */
  corridor: number;
  jitter: number;
  /** % per year */
  popGrowth: number;
  /** base nominal land appreciation % per year */
  appreciation: number;
  /** share of the rural→urban conversion premium captured by land owners (informality lowers it) */
  conversion: number;
  /** relative flood-risk increase by 2050 from impervious sprawl */
  floodWorsening: number;
  creditMacro: number;
  seed: number;
}

export const SCENARIOS: Record<ScenarioId, ScenarioParams> = {
  descontrolado: {
    id: 'descontrolado', label: 'Crecimiento descontrolado',
    target: 0.54, mid: 2034, k: 0.28, leap: 0.22, wNb3: 0.7, wNb5: 0.55, wMain: 0.9, wAny: 0.35, wFront: 1.1,
    slopeFree: 14, slopeScale: 12, floodW: 0.25, greenMul: 1, protectedShare: 0.15, minNb3: 0,
    newDensity: [0.18, 0.38], densify: 0.0025, corridor: 0, jitter: 0.75, popGrowth: 1.6, appreciation: 5.0,
    conversion: 0.78, floodWorsening: 0.35, creditMacro: 0.04, seed: 1301,
  },
  tendencial: {
    id: 'tendencial', label: 'Tendencia actual',
    target: 0.28, mid: 2036, k: 0.22, leap: 0.05, wNb3: 1.0, wNb5: 0.5, wMain: 0.7, wAny: 0.5, wFront: 0.75,
    slopeFree: 9, slopeScale: 7, floodW: 0.55, greenMul: 0.7, protectedShare: 0, minNb3: 0,
    newDensity: [0.32, 0.52], densify: 0.006, corridor: 0.002, jitter: 0.45, popGrowth: 1.35, appreciation: 5.8,
    conversion: 0.9, floodWorsening: 0.15, creditMacro: 0.01, seed: 2207,
  },
  ordenado: {
    id: 'ordenado', label: 'Crecimiento ordenado',
    target: 0.1, mid: 2037, k: 0.2, leap: 0, wNb3: 1.25, wNb5: 0.35, wMain: 0.9, wAny: 0.6, wFront: 0.35,
    slopeFree: 6, slopeScale: 4.5, floodW: 0.9, greenMul: 0.3, protectedShare: 0, minNb3: 3,
    newDensity: [0.55, 0.75], densify: 0.012, corridor: 0.01, jitter: 0.2, popGrowth: 1.1, appreciation: 6.4,
    conversion: 1.0, floodWorsening: 0, creditMacro: -0.02, seed: 3119,
  },
};

export const YEARS = YEAR_END - YEAR_START + 1; // 25 integer years incl. both ends

export interface Projection {
  scenario: ScenarioId;
  params: ScenarioParams;
  /** fractional year of urbanization; ≤2026 existing, 9999 never */
  yearU: Float32Array;
  /** final density for cells urbanized after 2026 */
  newDensity: Float32Array;
  /** yearly densification rate for existing cells */
  densify: Float32Array;
  /** commercial corridor (main road frontage inside the city) */
  corridor: Uint8Array;
  /** protected / forest cell invaded by the projection */
  invaded: Uint8Array;
  /** 0..1 share of new growth in the 5×5 neighbourhood (urban edge pressure) */
  edgeBoost: Float32Array;
  /** per integer year (index y − 2026) */
  urbanCells: Int32Array;
  greenLossHa: Float32Array;
  sprawl: Float32Array;
  invadedCells: Int32Array;
  /** cells urbanized 2026→2050 per zone index */
  newByZone: Int32Array;
  cellsByZone: Int32Array;
  ms: number;
}

export function runProjection(g: CityGrid, scenario: ScenarioId): Projection {
  const t0 = performance.now();
  const P = SCENARIOS[scenario];
  const { n, cols, rows } = g;
  const rand = rng(P.seed);

  const yearU = new Float32Array(n);
  const newDensity = new Float32Array(n);
  const densify = new Float32Array(n);
  const corridor = new Uint8Array(n);
  const invaded = new Uint8Array(n);
  const edgeBoost = new Float32Array(n);
  const urban = new Uint8Array(n);
  const nb3 = new Uint8Array(n);
  const nb5 = new Uint8Array(n);

  const mark = (k: number): void => {
    urban[k] = 1;
    const i = k % cols;
    const j = (k - i) / cols;
    for (let dj = -2; dj <= 2; dj++) {
      const jj = j + dj;
      if (jj < 0 || jj >= rows) continue;
      for (let di = -2; di <= 2; di++) {
        const ii = i + di;
        if (ii < 0 || ii >= cols || (di === 0 && dj === 0)) continue;
        const q = jj * cols + ii;
        nb5[q]++;
        if (di >= -1 && di <= 1 && dj >= -1 && dj <= 1) nb3[q]++;
      }
    }
  };

  let protectedCount = 0;
  for (let k = 0; k < n; k++) {
    if (g.protectedMask[k]) protectedCount++;
    if (g.urban0[k] > 0) {
      yearU[k] = g.yearBuilt0[k];
      mark(k);
      densify[k] = P.densify * (1 - g.urban0[k]);
    } else yearU[k] = 9999;
  }
  const U0 = g.urbanCount0;
  const T = Math.round(U0 * P.target);
  const protectedCap = Math.round(Math.min(protectedCount * P.protectedShare, T * 0.25));

  // static suitability (scenario specific, year independent)
  const S = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    if (g.water[k] || urban[k]) continue;
    if (g.protectedMask[k] && P.protectedShare <= 0) continue;
    const road = P.wMain * Math.exp(-g.mainDist[k] / 45) + P.wAny * Math.exp(-g.roadDist[k] / 25);
    const front = P.wFront * g.frontAttr[k] + (g.growthZone[k] ? 0.25 * P.wFront : 0);
    const slopePen = Math.exp(-Math.max(0, g.slope[k] - P.slopeFree) / P.slopeScale);
    const floodPen = Math.max(0.02, 1 - P.floodW * g.flood[k]);
    // spatially-correlated noise → organic fingers instead of perfect rings
    const noise = 0.25 + 1.5 * smoothstep(0.28, 0.72, fbm(g.cx[k] / 30 + P.seed * 0.01, g.cz[k] / 30 - P.seed * 0.013, 3));
    let s = (0.15 + road + front) * slopePen * floodPen * noise;
    if (g.green[k] && !g.protectedMask[k]) s *= P.greenMul;
    if (g.protectedMask[k]) s *= 0.6;
    S[k] = s;
  }

  // logistic cumulative quota
  const L = (y: number) => 1 / (1 + Math.exp(-P.k * (y - P.mid)));
  const L0 = L(YEAR_START);
  const L1 = L(YEAR_END);
  const cum = (y: number) => Math.round((T * (L(y) - L0)) / (L1 - L0));

  const candIdx = new Int32Array(n);
  const candScore = new Float32Array(n);
  const urbanCells = new Int32Array(YEARS);
  const greenLossHa = new Float32Array(YEARS);
  const sprawl = new Float32Array(YEARS);
  const invadedCells = new Int32Array(YEARS);
  let urbanCount = U0;
  let green = 0;
  let invadedCount = 0;

  // sprawl index: 2026 baseline from the edge share of the footprint, then driven by how the city
  // grows — low-density and leapfrog (discontinuous) growth and green invasion push it up,
  // densification of the existing fabric pulls it down.
  let edge0 = 0;
  for (let k = 0; k < n; k++) if (urban[k] && nb3[k] < 8) edge0++;
  const s0 = clamp01(0.22 + 0.5 * (edge0 / Math.max(1, U0) - 0.2));
  const leapCum = new Float32Array(YEARS);
  const lowCum = new Float32Array(YEARS);
  let leap = 0;
  let low = 0;

  urbanCells[0] = urbanCount;

  /** commit one cell to urban at year y */
  const urbanize = (k: number, y: number): void => {
    if (g.protectedMask[k]) {
      invaded[k] = 1;
      invadedCount++;
    }
    // spread the event inside the year for smooth building animation
    yearU[k] = y - 0.98 * rand();
    const dn = P.newDensity;
    newDensity[k] = (dn[0] + (dn[1] - dn[0]) * rand()) * (invaded[k] ? 0.75 : 1);
    green += g.protectedMask[k] || g.green[k] ? 1 : 0.55; // 1 cell = 1 ha
    if (nb3[k] <= 1) leap++;
    low += Math.max(0, 1 - newDensity[k] / 0.65);
    mark(k);
    urbanCount++;
  };

  /** take the best `q` of the first m candidates (native typed-array sort for the threshold) */
  const takeTop = (idx: Int32Array, score: Float32Array, m: number, q: number, y: number): number => {
    if (q <= 0 || m <= 0) return 0;
    let thr = -Infinity;
    if (m > q) thr = score.slice(0, m).sort()[m - q];
    let taken = 0;
    for (let c = 0; c < m && taken < q; c++) {
      if (score[c] < thr) continue;
      const k = idx[c];
      if (urban[k]) continue;
      if (g.protectedMask[k] && invadedCount >= protectedCap) continue;
      urbanize(k, y);
      taken++;
    }
    return taken;
  };

  const leapIdx = new Int32Array(n);
  const leapScore = new Float32Array(n);
  for (let y = YEAR_START + 1; y <= YEAR_END; y++) {
    const q = cum(y) - cum(y - 1);
    if (q > 0) {
      const allowProt = invadedCount < protectedCap;
      const minNb = Math.max(1, P.minNb3);
      let m = 0;
      let ml = 0;
      for (let k = 0; k < n; k++) {
        const s = S[k];
        if (s <= 0 || urban[k]) continue;
        const c3 = nb3[k];
        const isProt = g.protectedMask[k] === 1;
        if (c3 === 0) {
          // detached candidates: new nuclei along roads / growth fronts (leapfrog sprawl)
          if (P.leap > 0 && !isProt && nb5[k] <= 2 && (g.roadDist[k] <= 30 || g.frontAttr[k] > 0.2)) {
            leapIdx[ml] = k;
            leapScore[ml] = s * (0.4 + rand());
            ml++;
          }
          continue;
        }
        if (c3 < minNb) continue;
        if (isProt && (!allowProt || c3 < 2)) continue; // only edges of green areas are invaded
        const dyn = P.wNb3 * (c3 / 8) + P.wNb5 * (nb5[k] / 24);
        candIdx[m] = k;
        candScore[m] = s * dyn * (1 - P.jitter + 2 * P.jitter * rand());
        m++;
      }
      const ql = Math.min(ml, Math.round(q * P.leap));
      const tl = takeTop(leapIdx, leapScore, ml, ql, y);
      takeTop(candIdx, candScore, m, q - tl, y);
    }
    const yi = y - YEAR_START;
    urbanCells[yi] = urbanCount;
    greenLossHa[yi] = green;
    invadedCells[yi] = invadedCount;
    leapCum[yi] = leap;
    lowCum[yi] = low;
  }

  // corridors + edge pressure
  const Z = g.zones.length;
  const newByZone = new Int32Array(Math.max(1, Z));
  const cellsByZone = new Int32Array(Math.max(1, Z));
  for (let k = 0; k < n; k++) {
    const zi = g.zoneIdx[k];
    if (zi >= 0 && g.zoneScore[k] <= 1.5) cellsByZone[zi]++;
    const isNew = yearU[k] > YEAR_START && yearU[k] <= YEAR_END;
    if (urban[k] && P.corridor > 0 && g.mainDist[k] <= 12) {
      corridor[k] = 1;
      if (!isNew) densify[k] += P.corridor * (1 - g.urban0[k]);
    }
    if (!isNew) continue;
    if (zi >= 0 && g.zoneScore[k] <= 1.5) newByZone[zi]++;
    const i = k % cols;
    const j = (k - i) / cols;
    for (let dj = -2; dj <= 2; dj++) {
      const jj = j + dj;
      if (jj < 0 || jj >= rows) continue;
      for (let di = -2; di <= 2; di++) {
        const ii = i + di;
        if (ii < 0 || ii >= cols) continue;
        edgeBoost[jj * cols + ii] += 1 / 8;
      }
    }
  }
  for (let k = 0; k < n; k++) if (edgeBoost[k] > 1) edgeBoost[k] = 1;

  let densSum = 0;
  for (let k = 0; k < n; k++) if (yearU[k] <= YEAR_START) densSum += densify[k];
  const avgDensify = U0 ? densSum / U0 : 0;
  for (let yi = 0; yi < YEARS; yi++) {
    const growth = (1.25 * (0.55 * lowCum[yi] + 1.6 * leapCum[yi] + 0.5 * invadedCells[yi])) / Math.max(1, U0);
    sprawl[yi] = clamp01(s0 + growth - 0.5 * avgDensify * yi);
  }

  return {
    scenario, params: P, yearU, newDensity, densify, corridor, invaded, edgeBoost,
    urbanCells, greenLossHa, sprawl, invadedCells, newByZone, cellsByZone, ms: performance.now() - t0,
  };
}
