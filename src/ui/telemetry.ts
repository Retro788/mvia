/** Bottom-left telemetry list (machine-sight style): mono key/value rows, right-aligned values, alert dots. */
import type { AppContext, CityMetrics } from '../core/types';
import { fmtMXN, fmtPct } from '../core/geo';
import { h, n0, n1, setStyle, setText, throttle } from './dom';

type Level = 'idle' | 'ok' | 'note' | 'warn' | 'risk';
interface Row {
  key: string;
  label: string;
  value: HTMLElement;
  dot: HTMLElement;
  row: HTMLElement;
}

const ROWS: Array<[string, string]> = [
  ['year', 'Año'],
  ['pop', 'Población'],
  ['area', 'Área urbana'],
  ['value', 'Valor medio m²'],
  ['rate', 'Tasa hip. mediana'],
  ['default', 'Riesgo impago'],
  ['green', 'Pérdida verde'],
  ['sprawl', 'Dispersión'],
  ['shops', 'Comercios'],
  ['bldg', 'Edificios'],
  ['cars', 'Vehículos'],
  ['fps', 'FPS'],
];

const LEVEL_COLOR: Record<Level, string> = {
  idle: 'var(--ink-4)',
  ok: 'var(--ok)',
  note: 'var(--note)',
  warn: 'var(--warn)',
  risk: 'var(--risk)',
};

export function createTelemetry(ctx: AppContext): HTMLElement {
  const { bus, sim, world, store } = ctx;
  const el = h('section', 'ui-panel ui-telemetry');
  el.innerHTML = `
    <header class="panel-head">
      <span class="kicker">Telemetría</span>
      <span class="kicker-r mono tel-live"><i class="dot dot-live"></i><span class="tel-src">EN VIVO</span></span>
    </header>
    <div class="tel-list"></div>`;
  const list = el.querySelector<HTMLElement>('.tel-list')!;
  const src = el.querySelector<HTMLElement>('.tel-src')!;
  const rows = new Map<string, Row>();
  for (const [key, label] of ROWS) {
    const row = h('div', 'tel-row');
    const dot = h('i', 'tel-dot');
    const k = h('span', 'tel-k', null, label);
    const value = h('span', 'tel-v');
    row.append(dot, k, value);
    list.appendChild(row);
    rows.set(key, { key, label, value, dot, row });
  }

  const put = (key: string, v: string, level: Level = 'idle') => {
    const r = rows.get(key);
    if (!r) return;
    setText(r.value, v);
    setStyle(r.dot, 'background', LEVEL_COLOR[level]);
    r.row.classList.toggle('alert', level === 'warn' || level === 'risk');
  };

  let base: CityMetrics | null = null;
  let fps = 60;
  let frames = 0;
  let acc = 0;

  const render = () => {
    const m = sim.metrics();
    if (!base) {
      const hist = sim.history();
      base = hist[0] ?? m;
    }
    const st = world.stats();
    put('year', String(Math.floor(m.year)), 'note');
    put('pop', n0(m.population));
    const areaGrowth = base.urbanAreaKm2 > 0 ? (m.urbanAreaKm2 / base.urbanAreaKm2 - 1) * 100 : 0;
    put('area', `${n1(m.urbanAreaKm2)} km²`, areaGrowth > 30 ? 'risk' : areaGrowth > 12 ? 'warn' : 'idle');
    put('value', `${fmtMXN(m.avgLandValue)}/m²`);
    put('rate', fmtPct(m.medianMortgageRate), m.medianMortgageRate > 12 ? 'warn' : 'idle');
    put('default', fmtPct(m.creditDefaultRisk * 100), m.creditDefaultRisk > 0.12 ? 'risk' : m.creditDefaultRisk > 0.07 ? 'warn' : 'ok');
    put('green', `${n0(m.greenLossHa)} ha`, m.greenLossHa > 600 ? 'risk' : m.greenLossHa > 150 ? 'warn' : 'idle');
    put('sprawl', m.sprawlIndex.toFixed(2), m.sprawlIndex > 0.6 ? 'risk' : m.sprawlIndex > 0.45 ? 'warn' : 'ok');
    put('shops', n0(m.commercialCount), m.commercialCount > 0 ? 'note' : 'idle');
    put('bldg', n0(st.buildings));
    put('cars', store.get().showTraffic ? n0(st.vehicles) : 'OFF');
    put('fps', String(Math.round(fps)), fps < 30 ? 'risk' : fps < 50 ? 'warn' : 'ok');
    setText(src, store.get().playing ? 'SIMULANDO' : 'EN VIVO');
  };
  const renderSoon = throttle(render, 120);

  // FPS: count frames over a 0.5 s window from the render loop's own dt
  bus.on('view:frame', ({ dt }) => {
    frames++;
    acc += dt;
    if (acc >= 0.5) {
      fps = frames / acc;
      frames = 0;
      acc = 0;
    }
  });
  bus.on('sim:tick', renderSoon);
  bus.on('sim:projection', () => {
    base = null;
    renderSoon();
  });
  window.setInterval(() => {
    if (store.get().ready && !document.hidden) render();
  }, 500);
  render();
  return el;
}
