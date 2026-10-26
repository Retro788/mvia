/**
 * Commercial / real-estate establishments: catalogue, site evaluation (pro-forma), site suggestion
 * and Spanish naming. Evaluation is O(1) on the grid (summed-area tables) + O(establishments + landmarks).
 */
import type { Establishment, EstablishmentSpec, EstablishmentType, Landmark, SiteEvaluation, Verdict } from '../core/types';
import type { CityGrid } from './grid';
import type { Market } from './market';
import { clamp, clamp01, km, metres, money } from './util';
import { fmtInt, fmtPct } from '../core/geo';

export const SPECS: Record<EstablishmentType, EstablishmentSpec> = {
  plaza: {
    type: 'plaza', label: 'Plaza comercial', short: 'PLZ', color: '#ff6a2b', footprint: 9, height: 1.8,
    areaM2: [4000, 12000], costM2: 16500,
    description: 'Centro de barrio con locales, ancla de supermercado o farmacia y estacionamiento.',
  },
  plazoleta: {
    type: 'plazoleta', label: 'Plazoleta', short: 'PZT', color: '#3ddc84', footprint: 3, height: 0.3,
    areaM2: [400, 1500], costM2: 9000,
    description: 'Espacio público con locales pequeños y comercio de proximidad.',
  },
  tienda: {
    type: 'tienda', label: 'Tienda de conveniencia', short: 'TDA', color: '#f5b83d', footprint: 1.8, height: 0.6,
    areaM2: [80, 250], costM2: 12500,
    description: 'Tienda de abarrotes o conveniencia abierta 24 h para la colonia.',
  },
  supermercado: {
    type: 'supermercado', label: 'Supermercado', short: 'SUP', color: '#5ab0ff', footprint: 6, height: 1.2,
    areaM2: [2500, 6000], costM2: 15500,
    description: 'Autoservicio de escala sectorial con estacionamiento propio.',
  },
  centroComercial: {
    type: 'centroComercial', label: 'Centro comercial', short: 'CC', color: '#b45cff', footprint: 16, height: 3,
    areaM2: [25000, 70000], costM2: 24000,
    description: 'Centro comercial regional con tiendas ancla, cines y área de comida.',
  },
  vivienda: {
    type: 'vivienda', label: 'Conjunto de vivienda', short: 'VIV', color: '#4fd1ff', footprint: 5, height: 2.4,
    areaM2: [3000, 9000], costM2: 13500,
    description: 'Vivienda vertical en renta o venta, 4–8 niveles.',
  },
  oficinas: {
    type: 'oficinas', label: 'Edificio de oficinas', short: 'OFI', color: '#74767d', footprint: 4, height: 5,
    areaM2: [3500, 12000], costM2: 28000,
    description: 'Oficinas corporativas y de gobierno clase A/B.',
  },
};

export const SPEC_ORDER: EstablishmentType[] = ['plaza', 'plazoleta', 'tienda', 'supermercado', 'centroComercial', 'vivienda', 'oficinas'];

interface TypeModel {
  /** catchment radius in cells (100 m) */
  R: number;
  /** share of catchment visiting per day */
  capture: number;
  /** operator model: sales × margin; otherwise rent model */
  ticket?: number;
  margin?: number;
  /** MXN / m² / month for rent model */
  rent?: number;
  leasable?: number;
  opex?: number;
  /** persons served (commercial supply) */
  supply: number;
  /** land value uplift within 40 units */
  boost: number;
  /** min separation (world units) between suggestions of this type */
  minSep: number;
  commercial: boolean;
}

export const MODEL: Record<EstablishmentType, TypeModel> = {
  tienda: { R: 4, capture: 0.025, ticket: 78, margin: 0.05, supply: 1500, boost: 0.03, minSep: 30, commercial: true },
  plazoleta: { R: 5, capture: 0.04, rent: 190, leasable: 0.85, opex: 0.22, supply: 3000, boost: 0.05, minSep: 40, commercial: true },
  supermercado: { R: 10, capture: 0.02, ticket: 285, margin: 0.045, supply: 15000, boost: 0.07, minSep: 90, commercial: true },
  plaza: { R: 15, capture: 0.06, rent: 260, leasable: 0.8, opex: 0.22, supply: 25000, boost: 0.09, minSep: 110, commercial: true },
  centroComercial: { R: 30, capture: 0.045, rent: 360, leasable: 0.75, opex: 0.28, supply: 80000, boost: 0.12, minSep: 220, commercial: true },
  vivienda: { R: 8, capture: 0, rent: 150, leasable: 0.85, opex: 0.25, supply: 0, boost: 0.03, minSep: 60, commercial: false },
  oficinas: { R: 15, capture: 0, rent: 280, leasable: 0.82, opex: 0.22, supply: 0, boost: 0.06, minSep: 60, commercial: false },
};

/** which existing things compete with each type: [establishment types, landmark kinds] */
const COMPETES: Record<EstablishmentType, { types: EstablishmentType[]; landmarks: Array<Landmark['kind']> }> = {
  tienda: { types: ['tienda', 'supermercado'], landmarks: ['mercado'] },
  plazoleta: { types: ['plazoleta', 'plaza'], landmarks: ['plaza'] },
  supermercado: { types: ['supermercado', 'centroComercial'], landmarks: ['mercado', 'centroComercial'] },
  plaza: { types: ['plaza', 'centroComercial'], landmarks: ['centroComercial'] },
  centroComercial: { types: ['centroComercial'], landmarks: ['centroComercial'] },
  vivienda: { types: ['vivienda'], landmarks: [] },
  oficinas: { types: ['oficinas'], landmarks: ['gobierno'] },
};

export interface EvalContext {
  g: CityGrid;
  m: Market;
  year: number;
  list: readonly Establishment[];
  landmarks: readonly Landmark[];
}

function verdictFromScore(score: number, flood: number, risk: number): Verdict {
  if (flood >= 0.6 || risk >= 0.65) return score >= 55 ? 'precaucion' : 'riesgo';
  if (score >= 72) return 'viable';
  if (score >= 56) return 'observar';
  if (score >= 40) return 'precaucion';
  return 'riesgo';
}

function rejected(type: EstablishmentType, x: number, z: number, k: number, reason: string): SiteEvaluation {
  return {
    type, pos: { x, z }, cellIndex: k, allowed: false, reason, score: 0, verdict: 'riesgo', investment: 0, areaM2: 0,
    footfall: 0, annualRevenue: 0, roi: 0, paybackYears: 0, capRate: 0, notes: [reason],
  };
}

export function evaluateSite(ctx: EvalContext, type: EstablishmentType, x: number, z: number, withNotes = true): SiteEvaluation {
  const { g, m } = ctx;
  const spec = SPECS[type];
  const md = MODEL[type];
  const k = g.cellAt(x, z);
  if (k < 0) return rejected(type, x, z, k, 'Fuera del área de estudio MVIA');
  if (g.water[k]) return rejected(type, x, z, k, 'Cuerpo de agua: suelo no urbanizable');
  if (g.protectedMask[k]) return rejected(type, x, z, k, 'Área natural protegida / reserva ecológica: uso de suelo no permitido');
  const slope = g.slope[k];
  if (slope > 26) return rejected(type, x, z, k, `Pendiente de ${slope.toFixed(0)}° supera el máximo constructivo (26°)`);

  const i = k % g.cols;
  const j = (k - i) / g.cols;
  const flood = m.flood[k];
  const dem = m.demand[k];
  const landValue = Math.max(300, m.value[k]);
  const access = Math.exp(-g.mainDist[k] / 30);
  const catchment = m.popBox(i, j, md.R);
  const intensity = Math.min(1, catchment / Math.max(1, 1.3 * m.meanPopBox * ((2 * md.R + 1) / 13) ** 2));

  // competition: same/related establishments + anchoring landmarks, linear decay to the catchment edge
  const compR = md.R * g.cs;
  const comp = COMPETES[type];
  let compSum = 0;
  let nearestName = '';
  let nearestD = Infinity;
  for (const e of ctx.list) {
    if (!comp.types.includes(e.type)) continue;
    const d = Math.hypot(e.pos.x - x, e.pos.z - z);
    if (d >= compR) continue;
    compSum += (e.type === type ? 1 : 0.6) * (1 - d / compR);
    if (d < nearestD) { nearestD = d; nearestName = e.name; }
  }
  for (const l of ctx.landmarks) {
    if (!comp.landmarks.includes(l.kind)) continue;
    const d = Math.hypot(l.pos.x - x, l.pos.z - z);
    if (d >= compR) continue;
    compSum += (l.kind === 'centroComercial' ? 1 : 0.5) * (1 - d / compR);
    if (d < nearestD) { nearestD = d; nearestName = l.name; }
  }
  const compIdx = 1 - Math.exp(-compSum);

  // demand signal per type
  let demandSignal: number;
  if (type === 'vivienda') demandSignal = 0.5 * Math.exp(-g.jobsDist[k] / 120) + 0.3 * (1 - m.risk[k]) + 0.2 * intensity;
  else if (type === 'oficinas') demandSignal = 0.6 * Math.exp(-g.jobsDist[k] / 60) + 0.4 * access;
  else demandSignal = 0.6 * dem + 0.4 * intensity;

  const [a0, a1] = spec.areaM2;
  const sizeT = clamp01(0.25 + 0.6 * demandSignal + 0.15 * access - 0.3 * compIdx);
  const areaM2 = Math.round((a0 + (a1 - a0) * sizeT) / 10) * 10;
  const landM2 = (spec.footprint * g.cs) ** 2; // footprint in world units → m²
  const landCost = landM2 * landValue;
  const construction = areaM2 * spec.costM2 * (1 + 0.012 * Math.max(0, slope - 8)) * (1 + 0.1 * flood);
  const investment = landCost + construction * 1.12; // + soft costs, permits, fees

  let footfall: number;
  let annualRevenue: number;
  let noi: number;
  const locFactor = clamp(Math.pow(landValue / 9000, 0.3), 0.6, 1.6);
  if (type === 'vivienda') {
    footfall = (areaM2 / 72) * 3.5; // residents
  } else if (type === 'oficinas') {
    footfall = ((areaM2 * 0.82) / 11) * 1.15; // workers + visitors
  } else {
    footfall = catchment * md.capture * (0.6 + 0.8 * dem) * (1 - 0.55 * compIdx) * (0.75 + 0.4 * access);
  }
  if (md.ticket && md.margin) {
    annualRevenue = footfall * md.ticket * 365;
    noi = annualRevenue * md.margin;
  } else {
    const occBase = type === 'vivienda' ? 0.7 + 0.25 * (1 - m.risk[k]) : 0.55 + 0.4 * demandSignal + 0.1 * access - 0.25 * compIdx;
    const occ = clamp(occBase, 0.4, 0.97);
    annualRevenue = areaM2 * (md.leasable ?? 0.8) * (md.rent ?? 200) * locFactor * occ * 12;
    noi = annualRevenue * (1 - (md.opex ?? 0.25));
  }
  const appr = m.appr[k];
  const capRate = investment > 0 ? (noi / investment) * 100 : 0;
  // total return = yield + land appreciation on the land component
  const roi = investment > 0 ? ((noi + landCost * (appr / 100)) / investment) * 100 : 0;
  const paybackYears = noi > 0 ? Math.min(99, investment / noi) : 99;

  const sReturn = clamp01((capRate - 3) / 9);
  const sSlope = 1 - clamp01((slope - 5) / 20);
  let score = 100 * (0.28 * demandSignal + 0.18 * access + 0.22 * sReturn + 0.14 * (1 - compIdx) + 0.06 * sSlope + 0.12 * (1 - flood));
  const urbanCtx = m.density[k] > 0 || m.near[k] === 1;
  if (!urbanCtx) score *= 0.8;
  score = Math.round(clamp(score, 0, 100));
  const verdict = verdictFromScore(score, flood, m.risk[k]);

  const notes: string[] = [];
  if (withNotes) {
    if (md.commercial) notes.push(`Captación: ${fmtInt(catchment)} hab. en ${km(md.R * g.cs)} · ${fmtInt(footfall)} visitas/día`);
    else if (type === 'vivienda') notes.push(`${fmtInt(areaM2 / 72)} viviendas · ${fmtInt(footfall)} residentes · empleo a ${metres(g.jobsDist[k])}`);
    else notes.push(`${fmtInt(footfall)} usuarios/día · centro de empleo a ${metres(g.jobsDist[k])}`);
    if (compIdx > 0.3 && nearestName) notes.push(`Competencia ${compIdx > 0.6 ? 'alta' : 'media'}: ${nearestName} a ${metres(nearestD)}`);
    else notes.push(`Competencia baja en un radio de ${km(compR)}`);
    notes.push(`Vialidad principal a ${metres(g.mainDist[k])} · suelo ${money(landValue)}/m², plusvalía ${fmtPct(appr)}`);
    if (flood >= 0.35) notes.push(`Riesgo de inundación ${Math.round(flood * 100)}/100: obras pluviales (+${Math.round(flood * 10)}% costo)`);
    else if (slope >= 12) notes.push(`Pendiente ${slope.toFixed(0)}°: cimentación y terraceo especiales`);
    else if (!urbanCtx) notes.push('Fuera de la mancha urbana: requiere introducir servicios');
  }

  return {
    type, pos: { x, z }, cellIndex: k, allowed: true, score, verdict, investment, areaM2, footfall, annualRevenue,
    roi, paybackYears, capRate, notes: notes.slice(0, 4),
  };
}

/** Best n distinct sites for a type (cell centres, min separation, away from same-type establishments). */
export function suggestSites(ctx: EvalContext, type: EstablishmentType, n: number, exclude: readonly { x: number; z: number }[] = []): SiteEvaluation[] {
  const { g, m } = ctx;
  if (n <= 0) return [];
  const md = MODEL[type];
  const horizon = ctx.year + 4;
  const yearU = m.projection.yearU;
  const cand: Array<{ k: number; score: number }> = [];
  for (let j = 1; j < g.rows - 1; j += 2) {
    for (let i = 1; i < g.cols - 1; i += 2) {
      const k = j * g.cols + i;
      if (g.water[k] || g.protectedMask[k]) continue;
      if (!(m.density[k] > 0.05 || yearU[k] <= horizon)) continue;
      const ev = evaluateSite(ctx, type, g.cx[k], g.cz[k], false);
      if (!ev.allowed) continue;
      const penalty = ev.verdict === 'riesgo' ? 40 : ev.verdict === 'precaucion' ? 15 : 0;
      cand.push({ k, score: ev.score + Math.min(15, ev.capRate) * 0.15 - penalty });
    }
  }
  cand.sort((a, b) => b.score - a.score);
  const picked: SiteEvaluation[] = [];
  const sep2 = md.minSep * md.minSep;
  const taken: Array<{ x: number; z: number }> = [...exclude];
  for (const e of ctx.list) if (e.type === type) taken.push(e.pos);
  for (const c of cand) {
    const x = g.cx[c.k];
    const z = g.cz[c.k];
    let ok = true;
    for (const p of taken) {
      const dx = p.x - x;
      const dz = p.z - z;
      if (dx * dx + dz * dz < sep2) { ok = false; break; }
    }
    if (!ok) continue;
    taken.push({ x, z });
    picked.push(evaluateSite(ctx, type, x, z, true));
    if (picked.length >= n) break;
  }
  return picked;
}

// ───────────────────────────── naming ─────────────────────────────

function shortZone(name: string): string {
  // "Fraccionamiento Ánimas / Ánimas Marqueza" → "Ánimas"; "Emiliano Zapata (Culturas…)" → "Emiliano Zapata"
  let s = name.split(/\s*[/(]/)[0].trim();
  s = s.replace(/^(fraccionamiento|fracc\.?|colonia|col\.?|unidad|zona|corredor|reserva)\s+/i, '').trim();
  const m = /^(las|los|la|el)\s+(.+)$/i.exec(s);
  if (m) s = m[2];
  return s || name.trim();
}

function direction(dx: number, dz: number): string {
  if (Math.hypot(dx, dz) < 15) return 'Centro';
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 'Oriente' : 'Poniente';
  return dz < 0 ? 'Norte' : 'Sur';
}

export function establishmentName(
  type: EstablishmentType,
  zoneName: string,
  zoneCenter: { x: number; z: number } | null,
  pos: { x: number; z: number },
  existing: readonly Establishment[],
): string {
  const z = shortZone(zoneName);
  const dir = zoneCenter ? direction(pos.x - zoneCenter.x, pos.z - zoneCenter.z) : 'Norte';
  const sameType = existing.filter((e) => e.type === type).length;
  const nn = String(sameType + 1).padStart(2, '0');
  let base: string;
  switch (type) {
    case 'plaza': base = dir === 'Centro' ? `Plaza ${z}` : `Plaza ${z} ${dir}`; break;
    case 'plazoleta': base = `Plazoleta ${z}`; break;
    case 'tienda': base = `Tienda ${z} ${nn}`; break;
    case 'supermercado': base = `Súper ${z}`; break;
    case 'centroComercial': base = `Galerías ${z}`; break;
    case 'vivienda': base = dir === 'Centro' ? `Residencial ${z}` : `Residencial ${z} ${dir}`; break;
    case 'oficinas': base = `Torre ${z}`; break;
  }
  const names = new Set(existing.map((e) => e.name));
  if (!names.has(base)) return base;
  for (let q = 2; q < 100; q++) {
    const candidate = `${base} ${String(q).padStart(2, '0')}`;
    if (!names.has(candidate)) return candidate;
  }
  return `${base} ${Date.now() % 1000}`;
}
