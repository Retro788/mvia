/**
 * Hover readout following the pointer ("1,427 m · $12.4k/m² · ZONA") and, while a build tool is active,
 * a live site evaluation (score + verdict colour), throttled to 10 Hz. Also the tool banner above the timeline.
 */
import type { AppContext, Vec2 } from '../core/types';
import { fmtMXN } from '../core/geo';
import { h, n0, setStyle, setText, shortName, VERDICTS } from './dom';
import { ICON } from './icons';
import { isBuildTool } from './interaction';

export function createCursor(ctx: AppContext): HTMLElement {
  const { bus, sim, store } = ctx;
  const el = h('div', 'ui-cursor ui-pass');
  el.innerHTML = `<div class="cur-main mono"></div><div class="cur-eval mono"><i class="cur-dot"></i><span class="cur-eval-t"></span></div>`;
  const main = el.querySelector<HTMLElement>('.cur-main')!;
  const evalRow = el.querySelector<HTMLElement>('.cur-eval')!;
  const evalDot = el.querySelector<HTMLElement>('.cur-dot')!;
  const evalT = el.querySelector<HTMLElement>('.cur-eval-t')!;

  let last = 0;
  let pending: { point: Vec2; cell: number } | null = null;
  let timer = 0;

  const describe = (point: Vec2, cell: number) => {
    const tool = store.get().tool;
    if (cell >= 0) {
      const c = sim.cell(cell);
      const zone = c.zoneName ? shortName(c.zoneName).toUpperCase() : 'SIN ZONA';
      setText(main, `${n0(c.elevation)} m · ${fmtMXN(c.landValue)}/m² · ${zone}`);
    } else setText(main, 'Fuera del modelo');
    if (isBuildTool(tool) && cell >= 0) {
      const ev = sim.evaluateSite(tool, point.x, point.z);
      const v = VERDICTS[ev.verdict];
      evalRow.classList.add('show');
      if (ev.allowed) {
        setText(evalT, `${sim.spec(tool).short} · ${Math.round(ev.score)}/100 · ${v.label} · ROI ${ev.roi.toFixed(1)}%`);
        setStyle(evalDot, 'background', v.color);
      } else {
        setText(evalT, `✕ ${ev.reason ?? 'No permitido'}`);
        setStyle(evalDot, 'background', 'var(--risk)');
      }
    } else if (tool === 'bulldoze') {
      evalRow.classList.add('show');
      setText(evalT, 'DEMOLER · clic sobre un establecimiento');
      setStyle(evalDot, 'background', 'var(--risk)');
    } else evalRow.classList.remove('show');
  };

  const flush = () => {
    timer = 0;
    last = performance.now();
    if (pending) describe(pending.point, pending.cell);
    pending = null;
  };

  bus.on('view:hover', ({ point, cellIndex, screen }) => {
    if (!point || !store.get().ready) {
      el.classList.remove('show');
      return;
    }
    el.classList.add('show');
    el.style.transform = `translate3d(${Math.round(screen.x + 16)}px, ${Math.round(screen.y + 16)}px, 0)`;
    pending = { point, cell: cellIndex };
    const wait = 100 - (performance.now() - last);
    if (wait <= 0) flush();
    else if (!timer) timer = window.setTimeout(flush, wait);
  });
  return el;
}

/** "Herramienta activa" banner shown above the timeline while a build / bulldoze tool is armed. */
export function createToolBanner(ctx: AppContext): HTMLElement {
  const { store, sim } = ctx;
  const el = h('div', 'ui-panel ui-toolbar');
  el.innerHTML = `<i class="tb-ico"></i><span class="tb-t"></span><button class="tb-x mono" data-act="exit">Esc · salir</button>`;
  const ico = el.querySelector<HTMLElement>('.tb-ico')!;
  const t = el.querySelector<HTMLElement>('.tb-t')!;
  el.addEventListener('click', (ev) => {
    if ((ev.target as HTMLElement).closest('[data-act="exit"]')) store.set({ tool: 'inspect' });
  });
  const sync = () => {
    const tool = store.get().tool;
    el.classList.toggle('show', tool !== 'inspect');
    if (isBuildTool(tool)) {
      const s = sim.spec(tool);
      ico.innerHTML = ICON.build;
      setStyle(ico, 'background', s.color);
      setText(t, `${s.label} · haz clic en el mapa para evaluar y construir`);
    } else if (tool === 'bulldoze') {
      ico.innerHTML = ICON.bulldoze;
      setStyle(ico, 'background', 'var(--risk)');
      setText(t, 'Demoler · haz clic sobre un establecimiento');
    }
  };
  store.subscribe(sync, ['tool']);
  sync();
  return el;
}
