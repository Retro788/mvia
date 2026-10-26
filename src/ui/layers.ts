/** Left column: thematic layer list with swatches + gradient legend, and map visibility toggles. Collapsible. */
import type { AppContext, AppState, LayerId } from '../core/types';
import { fmtMXN } from '../core/geo';
import { h, setText, throttle } from './dom';
import { ICON } from './icons';
import { LAYERS, layerMeta, rampCss } from './meta';

type ToggleKey = 'showBuildings' | 'showTraffic' | 'showLabels';
const TOGGLES: Array<{ key: ToggleKey; label: string; kbd: string }> = [
  { key: 'showBuildings', label: 'Edificios', kbd: 'B' },
  { key: 'showTraffic', label: 'Tráfico', kbd: 'T' },
  { key: 'showLabels', label: 'Etiquetas', kbd: 'E' },
];

export function createLayers(ctx: AppContext): HTMLElement {
  const { store, sim, bus } = ctx;
  const el = h('section', 'ui-panel ui-layers');
  el.innerHTML = `
    <header class="panel-head" data-act="collapse">
      <span class="kicker">${ICON.layers}Capas de análisis</span>
      <span class="kicker-r mono">0${LAYERS.length - 1}</span>
      <button class="icon-btn chev" aria-label="Contraer capas">${ICON.chevron}</button>
    </header>
    <div class="collapse-body">
      <div class="layer-list" role="radiogroup" aria-label="Capa temática">
        ${LAYERS.map(
          (l, i) => `<button class="layer-item" data-layer="${l.id}" role="radio">
            <i class="sw" style="background:${rampCss(l.ramp, '135deg')}"></i>
            <span class="layer-name">${l.label}</span>
            <em class="layer-unit mono">${i === 0 ? '' : l.unit}</em>
          </button>`,
        ).join('')}
      </div>
      <div class="legend">
        <div class="legend-head"><span class="kicker legend-title"></span><span class="kicker-r mono legend-unit"></span></div>
        <div class="legend-bar"></div>
        <div class="legend-ticks mono"><span class="lg-lo"></span><span class="lg-mid"></span><span class="lg-hi"></span></div>
        <p class="legend-note"></p>
      </div>
      <div class="toggle-row">
        ${TOGGLES.map((t) => `<button class="tgl" data-toggle="${t.key}" title="${t.label} (${t.kbd})"><i class="tgl-box"></i>${t.label}</button>`).join('')}
      </div>
    </div>`;

  const items = [...el.querySelectorAll<HTMLElement>('[data-layer]')];
  const toggles = [...el.querySelectorAll<HTMLElement>('[data-toggle]')];
  const legend = el.querySelector<HTMLElement>('.legend')!;
  const lgTitle = el.querySelector<HTMLElement>('.legend-title')!;
  const lgUnit = el.querySelector<HTMLElement>('.legend-unit')!;
  const lgBar = el.querySelector<HTMLElement>('.legend-bar')!;
  const lgLo = el.querySelector<HTMLElement>('.lg-lo')!;
  const lgMid = el.querySelector<HTMLElement>('.lg-mid')!;
  const lgHi = el.querySelector<HTMLElement>('.lg-hi')!;
  const lgNote = el.querySelector<HTMLElement>('.legend-note')!;

  el.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const btn = t.closest<HTMLElement>('button, [data-act]');
    if (!btn) return;
    if (btn.dataset.layer) {
      const id = btn.dataset.layer as LayerId;
      store.set({ layer: store.get().layer === id && id !== 'none' ? 'none' : id });
    } else if (btn.dataset.toggle) {
      const k = btn.dataset.toggle as ToggleKey;
      store.set({ [k]: !store.get()[k] } as Partial<AppState>);
    } else if (btn.dataset.act === 'collapse' || btn.classList.contains('chev')) {
      el.classList.toggle('collapsed');
    }
  });

  /** Live min/max labels for the legend where the sim gives us real units. */
  const legendRange = (id: LayerId): [string, string, string] => {
    const m = layerMeta(id);
    if (id === 'landValue' || id === 'mortgage') {
      const zs = sim.zones();
      if (zs.length) {
        let lo = Infinity;
        let hi = -Infinity;
        for (const z of zs) {
          const v = id === 'landValue' ? z.landValue : z.mortgageRate;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (id === 'landValue') return [fmtMXN(lo), fmtMXN((lo + hi) / 2), fmtMXN(hi)];
        return [`${lo.toFixed(1)}%`, `${((lo + hi) / 2).toFixed(1)}%`, `${hi.toFixed(1)}%`];
      }
    }
    return [m.lo, m.mid, m.hi];
  };

  const syncLegend = () => {
    const id = store.get().layer;
    const m = layerMeta(id);
    legend.classList.toggle('empty', id === 'none');
    setText(lgTitle, id === 'none' ? 'Sin capa' : m.label);
    setText(lgUnit, id === 'none' ? '' : m.unit);
    lgBar.style.background = rampCss(m.ramp);
    const [lo, mid, hi] = legendRange(id);
    setText(lgLo, lo);
    setText(lgMid, mid);
    setText(lgHi, hi);
    setText(lgNote, m.note);
  };
  const syncLegendSoon = throttle(syncLegend, 600);

  const sync = (s: AppState) => {
    for (const b of items) {
      const on = b.dataset.layer === s.layer;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    for (const b of toggles) b.classList.toggle('on', Boolean(s[b.dataset.toggle as ToggleKey]));
  };
  store.subscribe((s, changed) => {
    sync(s);
    if (changed.includes('layer')) syncLegend();
  }, ['layer', 'showBuildings', 'showTraffic', 'showLabels']);
  store.subscribe(() => {
    const l = store.get().layer;
    if (l === 'landValue' || l === 'mortgage') syncLegendSoon();
  }, ['year']);
  bus.on('sim:projection', syncLegendSoon);
  sync(store.get());
  syncLegend();
  return el;
}
