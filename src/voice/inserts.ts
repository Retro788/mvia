/**
 * Quick-insert scripts for the studio, written for the ear (numbers spelled as spoken magnitudes).
 */
import type { AppContext, ScenarioId, Verdict, ZoneStats } from '../core/types';
import { spokenMoney, spokenNumber, spokenPct } from './text';

const SCENARIO: Record<ScenarioId, string> = {
  descontrolado: 'crecimiento descontrolado',
  tendencial: 'crecimiento tendencial',
  ordenado: 'crecimiento ordenado',
};

const VERDICT: Record<Verdict, string> = {
  viable: 'viable',
  observar: 'en observación',
  precaucion: 'de precaución',
  riesgo: 'de riesgo',
};

function list(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
}

const zoneNames = (z: ZoneStats[]) => list(z.map((s) => s.zone.name));

export function cityScript(ctx: AppContext): string {
  const { sim } = ctx;
  const m = sim.metrics();
  const year = Math.floor(m.year);
  const parts = [
    `Resumen MVIA de Xalapa para el año ${year}, en el escenario de ${SCENARIO[sim.scenario] ?? sim.scenario}.`,
    `La población estimada es de ${spokenNumber(m.population)} habitantes, sobre una mancha urbana de ${m.urbanAreaKm2.toLocaleString('es-MX', { maximumFractionDigits: 1 })} kilómetros cuadrados.`,
    `El valor promedio del suelo es de ${spokenMoney(m.avgLandValue)} por metro cuadrado, con una tasa hipotecaria mediana de ${spokenPct(m.medianMortgageRate)}.`,
    `El riesgo de impago crediticio se ubica en ${spokenPct(m.creditDefaultRisk * 100)}, y el índice de dispersión urbana en ${m.sprawlIndex.toLocaleString('es-MX', { maximumFractionDigits: 2 })}.`,
  ];
  if (m.greenLossHa > 0.5) parts.push(`Desde 2026 se han perdido ${spokenNumber(m.greenLossHa, 0)} hectáreas de áreas verdes.`);
  if (m.housingDeficit > 0) parts.push(`El déficit de vivienda asciende a ${spokenNumber(m.housingDeficit, 0)} viviendas.`);
  try {
    const growth = sim.topZones('growth', 3);
    if (growth.length) parts.push(`Los frentes de mayor crecimiento son ${zoneNames(growth)}.`);
    const value = sim.topZones('appreciation', 2);
    if (value.length) parts.push(`La mayor plusvalía anual se registra en ${zoneNames(value)}.`);
  } catch {
    /* ranking unavailable */
  }
  if (m.commercialCount > 0) parts.push(`Hay ${spokenNumber(m.commercialCount, 0)} establecimientos comerciales evaluados por MVIA.`);
  return parts.join(' ');
}

export function zoneScript(ctx: AppContext): string | null {
  const sel = ctx.store.get().selection;
  if (!sel || sel.cellIndex < 0) return null;
  const r = ctx.sim.readCell(sel.cellIndex);
  const parts = [`${r.title}.`, r.summary.trim().replace(/([^.!?])$/, '$1.')];
  parts.push(`Dictamen MVIA: ${VERDICT[r.verdict] ?? r.verdict}.`);
  for (const [k, v] of r.rows.slice(0, 5)) parts.push(`${k}: ${v}.`);
  if (r.footer) parts.push(r.footer.trim().replace(/([^.!?])$/, '$1.'));
  return parts.join(' ');
}

export function creditScript(ctx: AppContext): string {
  const { sim } = ctx;
  const m = sim.metrics();
  const price = 1_800_000;
  const down = 270_000;
  const q = sim.mortgageQuote({ price, downPayment: down, years: 20, product: 'bancario' });
  const parts = [
    `Reporte de crédito MVIA, Xalapa ${Math.floor(m.year)}.`,
    `La tasa hipotecaria mediana es de ${spokenPct(m.medianMortgageRate)} y el riesgo de impago promedio de ${spokenPct(m.creditDefaultRisk * 100)}.`,
    `Para una vivienda de ${spokenMoney(price)} con quince por ciento de enganche a ${q.years} años, la mensualidad estimada es de ${spokenMoney(q.monthlyPayment)}, con una tasa de ${spokenPct(q.rate, 2)} y un costo anual total de ${spokenPct(q.cat)}.`,
    `Se requiere un ingreso mensual de ${spokenMoney(q.requiredIncome)}, y el riesgo del crédito se clasifica como ${q.risk}.`,
  ];
  try {
    const risky = sim.topZones('creditRisk', 3);
    const safe = sim.topZones('creditRisk', 3, true);
    if (risky.length) parts.push(`Las zonas con mayor riesgo crediticio son ${zoneNames(risky)}.`);
    if (safe.length) parts.push(`Las más sólidas para originar hipotecas son ${zoneNames(safe)}.`);
  } catch {
    /* ranking unavailable */
  }
  parts.push('Recomendación: priorizar originación en zonas consolidadas y exigir estudios de riesgo en los frentes de expansión.');
  return parts.join(' ');
}
