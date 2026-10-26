/** Top-left brand block: kicker, title, description, numbered map-style pills, scenario control, lens toggle.
 *  Also the small top-right "Voz MVIA / Chat MVIA" action group. */
import type { AppContext, MapStyle, ScenarioId } from '../core/types';
import { h } from './dom';
import { ICON } from './icons';
import { SCENARIOS, STYLES } from './meta';

export function createBrand(ctx: AppContext): HTMLElement {
  const { store } = ctx;
  const el = h('section', 'ui-panel ui-brand', { 'aria-label': 'MVIA' });
  el.innerHTML = `
    <div class="kicker"><span class="dot dot-live"></span>NODE 01 · XALAPA-ENRÍQUEZ, VER.</div>
    <h1 class="brand-title">MVIA<span class="brand-sep">·</span>Xalapa</h1>
    <p class="brand-desc">La ciudad, leída como la lee MVIA. Mueve el cursor para ver a través del modelo; analiza valor, crédito y crecimiento.</p>
    <div class="brand-row">
      <div class="pill-row" role="radiogroup" aria-label="Estilo de mapa">
        ${STYLES.map((s, i) => `<button class="pill" data-style="${s.id}" role="radio"><span class="pill-num">${i + 1}</span>${s.label}</button>`).join('')}
      </div>
    </div>
    <div class="brand-row brand-row-2">
      <div class="seg seg-scenario" role="radiogroup" aria-label="Escenario">
        ${SCENARIOS.map((s) => `<button class="seg-btn" data-scenario="${s.id}" role="radio"><i class="seg-dot" style="background:${s.color}"></i>${s.label}</button>`).join('')}
      </div>
      <button class="pill pill-lens" data-act="lens" title="Lente MVIA (L)"><i class="lens-ring"></i>Lente</button>
    </div>`;

  el.addEventListener('click', (ev) => {
    const t = (ev.target as HTMLElement).closest<HTMLElement>('button');
    if (!t) return;
    if (t.dataset.style) store.set({ mapStyle: t.dataset.style as MapStyle });
    else if (t.dataset.scenario) store.set({ scenario: t.dataset.scenario as ScenarioId });
    else if (t.dataset.act === 'lens') store.set({ lens: !store.get().lens });
  });

  const styleBtns = [...el.querySelectorAll<HTMLElement>('[data-style]')];
  const scenBtns = [...el.querySelectorAll<HTMLElement>('[data-scenario]')];
  const lensBtn = el.querySelector<HTMLElement>('[data-act="lens"]')!;
  const sync = () => {
    const s = store.get();
    for (const b of styleBtns) {
      const on = b.dataset.style === s.mapStyle;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    for (const b of scenBtns) {
      const on = b.dataset.scenario === s.scenario;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    lensBtn.classList.toggle('on', s.lens);
  };
  store.subscribe(sync, ['mapStyle', 'scenario', 'lens']);
  sync();
  return el;
}

export function createActions(ctx: AppContext): HTMLElement {
  const { store } = ctx;
  const el = h('div', 'ui-panel ui-actions');
  el.innerHTML = `
    <button class="act-btn" data-act="voice" title="Voice Studio (V)">${ICON.voice}<span>Voz MVIA</span></button>
    <button class="act-btn act-dark" data-act="chat" title="Chat MVIA (C)">${ICON.chat}<span>Chat MVIA</span></button>`;
  el.addEventListener('click', (ev) => {
    const t = (ev.target as HTMLElement).closest<HTMLElement>('button');
    if (!t) return;
    if (t.dataset.act === 'voice') store.set({ voiceOpen: !store.get().voiceOpen });
    if (t.dataset.act === 'chat') store.set({ chatOpen: !store.get().chatOpen });
  });
  const [vb, cb] = [...el.querySelectorAll<HTMLElement>('button')];
  const sync = () => {
    const s = store.get();
    vb.classList.toggle('on', s.voiceOpen);
    cb.classList.toggle('on', s.chatOpen);
  };
  store.subscribe(sync, ['voiceOpen', 'chatOpen']);
  sync();
  return el;
}
