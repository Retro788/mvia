/** Global keyboard shortcuts + "?" help overlay. Ignored while typing in inputs. */
import type { AppContext, MapStyle } from '../core/types';
import { YEAR_END, YEAR_START } from '../core/geo';
import { clamp, h, isTypingTarget } from './dom';
import { ICON } from './icons';

const STYLE_KEYS: Record<string, MapStyle> = { '1': 'clay', '2': 'satellite', '3': 'scan', '4': 'night' };

const HELP: Array<[string, string]> = [
  ['1 – 4', 'Estilo de mapa: Clay · Satélite · Scan · Noche'],
  ['L', 'Lente MVIA (visión de máquina)'],
  ['Espacio', 'Reproducir / pausar simulación'],
  [', .', 'Año anterior / siguiente'],
  ['C', 'Chat MVIA'],
  ['V', 'Voice Studio'],
  ['B', 'Mostrar / ocultar edificios'],
  ['T', 'Mostrar / ocultar tráfico'],
  ['E', 'Mostrar / ocultar etiquetas'],
  ['Esc', 'Salir de herramienta / quitar selección'],
  ['?', 'Esta ayuda'],
];

export function createHelp(): HTMLElement {
  const el = h('div', 'ui-help', { role: 'dialog', 'aria-label': 'Atajos de teclado' });
  el.innerHTML = `
    <div class="help-card">
      <header class="help-head"><span class="kicker">${ICON.key}Atajos de teclado</span><button class="icon-btn" data-act="close" aria-label="Cerrar">${ICON.close}</button></header>
      <h2 class="help-title">Controla MVIA sin soltar el teclado</h2>
      <div class="help-list">${HELP.map(([k, d]) => `<div class="help-row"><kbd class="mono">${k}</kbd><span>${d}</span></div>`).join('')}</div>
      <p class="help-foot mono">Arrastra para mover · rueda para zoom · clic derecho + arrastrar para rotar</p>
    </div>`;
  el.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    if (t === el || t.closest('[data-act="close"]')) el.classList.remove('show');
  });
  return el;
}

export function initShortcuts(ctx: AppContext, help: HTMLElement): void {
  const { store } = ctx;
  window.addEventListener('keydown', (ev) => {
    if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (isTypingTarget(ev.target)) return;
    const s = store.get();
    if (!s.ready) return;
    const k = ev.key;
    const lower = k.length === 1 ? k.toLowerCase() : k;
    // the Voice Studio modal owns the keyboard (incl. Esc) while open; only V toggles it back
    if (s.voiceOpen && lower !== 'v') return;

    if (STYLE_KEYS[k]) {
      store.set({ mapStyle: STYLE_KEYS[k] });
    } else if (lower === 'l') store.set({ lens: !s.lens });
    else if (k === ' ' || ev.code === 'Space') {
      // a focused button would also "click" on keyup: drop focus so Space only toggles playback
      if (ev.target instanceof HTMLButtonElement) ev.target.blur();
      if (!s.playing && s.year >= YEAR_END - 0.01) store.set({ year: YEAR_START, playing: true });
      else store.set({ playing: !s.playing });
    } else if (lower === 'c') store.set({ chatOpen: !s.chatOpen });
    else if (lower === 'v') store.set({ voiceOpen: !s.voiceOpen });
    else if (lower === 'b') store.set({ showBuildings: !s.showBuildings });
    else if (lower === 't') store.set({ showTraffic: !s.showTraffic });
    else if (lower === 'e') store.set({ showLabels: !s.showLabels });
    else if (k === '.' || k === ',') {
      // arrows are left to the map view (panning); comma / period step the year
      store.set({ year: clamp(Math.round(s.year) + (k === '.' ? 1 : -1), YEAR_START, YEAR_END), playing: false });
    } else if (k === '?' || (k === '/' && ev.shiftKey)) help.classList.toggle('show');
    else if (k === 'Escape') {
      if (help.classList.contains('show')) help.classList.remove('show');
      else if (s.tool !== 'inspect') store.set({ tool: 'inspect' });
      else if (s.selection) store.set({ selection: null });
      return; // never swallow Esc: chat / voice modules may also close on it
    } else return;
    ev.preventDefault();
  });
}
