/** Bottom-centre timeline 2026→2050: play/pause, big year readout, scrubber with yearly ticks and a mini
 *  urban-area chart behind the track, speed selector and compare-year control (split view). */
import type { AppContext } from '../core/types';
import { YEAR_END, YEAR_START } from '../core/geo';
import { ChartCanvas, drawArea } from './charts';
import { clamp, cssVar, h, n1, setStyle, setText } from './dom';
import { ICON } from './icons';
import { scenarioMeta } from './meta';

const SPEEDS = [0.5, 1, 2, 4];
const SPAN = YEAR_END - YEAR_START;

export function createTimeline(ctx: AppContext): HTMLElement {
  const { store, sim, bus } = ctx;
  const el = h('section', 'ui-panel ui-timeline', { 'aria-label': 'Línea de tiempo' });
  const ticks: string[] = [];
  const labels: string[] = [];
  for (let y = YEAR_START; y <= YEAR_END; y++) {
    const p = ((y - YEAR_START) / SPAN) * 100;
    const major = y % 5 === 0 || y === YEAR_START;
    ticks.push(`<i class="tl-tick${major ? ' major' : ''}" style="left:${p}%"></i>`);
    if (major) labels.push(`<span style="left:${p}%">${y}</span>`);
  }
  el.innerHTML = `
    <div class="tl-top">
      <button class="tl-play" data-act="play" aria-label="Reproducir">${ICON.play}</button>
      <div class="tl-readout">
        <div class="tl-year mono"><span class="tl-year-num">2026</span><span class="tl-year-frac">.0</span></div>
        <div class="kicker tl-scn"><i class="seg-dot"></i><span class="tl-scn-name"></span><span class="tl-area mono"></span></div>
      </div>
      <div class="tl-spacer"></div>
      <div class="seg seg-speed mono" role="radiogroup" aria-label="Velocidad">
        ${SPEEDS.map((s) => `<button class="seg-btn" data-speed="${s}" role="radio">${s}×</button>`).join('')}
      </div>
      <button class="pill tl-compare" data-act="compare" title="Vista dividida: año comparado vs año activo"><i class="cmp-ico"></i>Comparar</button>
      <div class="tl-chip mono" title="Año de comparación (lado izquierdo)">
        <button data-step="-1" aria-label="Año anterior">‹</button><span class="tl-chip-y">2026</span><button data-step="1" aria-label="Año siguiente">›</button>
      </div>
    </div>
    <div class="tl-track" tabindex="0" role="slider" aria-label="Año de simulación" aria-valuemin="${YEAR_START}" aria-valuemax="${YEAR_END}">
      <div class="tl-chart"><div class="tl-chart-base"></div><div class="tl-chart-played"></div></div>
      <div class="tl-rail"><i class="tl-fill"></i></div>
      <div class="tl-ticks">${ticks.join('')}</div>
      <div class="tl-labels mono">${labels.join('')}</div>
      <div class="tl-cmp"><span class="mono">A</span></div>
      <div class="tl-thumb"><span class="tl-thumb-lbl mono">2026</span></div>
    </div>`;

  const playBtn = el.querySelector<HTMLElement>('[data-act="play"]')!;
  const yearNum = el.querySelector<HTMLElement>('.tl-year-num')!;
  const yearFrac = el.querySelector<HTMLElement>('.tl-year-frac')!;
  const scnDot = el.querySelector<HTMLElement>('.tl-scn .seg-dot')!;
  const scnName = el.querySelector<HTMLElement>('.tl-scn-name')!;
  const areaLbl = el.querySelector<HTMLElement>('.tl-area')!;
  const speedBtns = [...el.querySelectorAll<HTMLElement>('[data-speed]')];
  const cmpBtn = el.querySelector<HTMLElement>('[data-act="compare"]')!;
  const chip = el.querySelector<HTMLElement>('.tl-chip')!;
  const chipY = el.querySelector<HTMLElement>('.tl-chip-y')!;
  const track = el.querySelector<HTMLElement>('.tl-track')!;
  const thumb = el.querySelector<HTMLElement>('.tl-thumb')!;
  const thumbLbl = el.querySelector<HTMLElement>('.tl-thumb-lbl')!;
  const cmpMarker = el.querySelector<HTMLElement>('.tl-cmp')!;
  const played = el.querySelector<HTMLElement>('.tl-chart-played')!;
  const baseChart = new ChartCanvas(el.querySelector<HTMLElement>('.tl-chart-base')!, 30, 'chart');
  const playedChart = new ChartCanvas(played, 30, 'chart');

  // ── mini urban-area chart (redrawn only when the projection changes) ──
  const drawHistory = () => {
    const hist = sim.history();
    const vals = hist.map((m) => m.urbanAreaKm2);
    const pad = { l: 0, r: 0, t: 3, b: 0 };
    baseChart.draw((g, w, hh) => drawArea(g, w, hh, vals, { color: cssVar('--ink-4'), pad, lineWidth: 1 }));
    playedChart.draw((g, w, hh) => drawArea(g, w, hh, vals, { color: cssVar('--live'), pad, lineWidth: 1.25 }));
  };

  // ── interaction ──
  el.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('button');
    if (!b) return;
    const s = store.get();
    if (b.dataset.act === 'play') {
      if (!s.playing && s.year >= YEAR_END - 0.01) store.set({ year: YEAR_START, playing: true });
      else store.set({ playing: !s.playing });
    } else if (b.dataset.speed) store.set({ speed: Number(b.dataset.speed) });
    else if (b.dataset.act === 'compare') {
      const cy = s.compareYear >= Math.floor(s.year) ? YEAR_START : s.compareYear;
      store.set({ compare: !s.compare, compareYear: cy });
    } else if (b.dataset.step) {
      store.set({ compareYear: clamp(Math.round(s.compareYear + Number(b.dataset.step)), YEAR_START, YEAR_END), compare: true });
    }
  });

  const yearAt = (clientX: number): number => {
    const r = track.getBoundingClientRect();
    return YEAR_START + clamp((clientX - r.left) / r.width, 0, 1) * SPAN;
  };
  let drag: 'year' | 'compare' | null = null;
  let resumePlay = false;
  track.addEventListener('pointerdown', (ev) => {
    const s = store.get();
    const r = track.getBoundingClientRect();
    const cmpX = r.left + ((s.compareYear - YEAR_START) / SPAN) * r.width;
    drag = s.compare && Math.abs(ev.clientX - cmpX) < 10 ? 'compare' : 'year';
    resumePlay = s.playing && drag === 'year';
    track.setPointerCapture(ev.pointerId);
    track.classList.add('dragging');
    move(ev);
  });
  const move = (ev: PointerEvent) => {
    if (!drag) return;
    const y = yearAt(ev.clientX);
    if (drag === 'compare') store.set({ compareYear: Math.round(y) });
    else store.set({ year: y, playing: false });
  };
  track.addEventListener('pointermove', move);
  const end = () => {
    if (!drag) return;
    drag = null;
    track.classList.remove('dragging');
    if (resumePlay) store.set({ playing: true });
  };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
  track.addEventListener('keydown', (ev) => {
    const step = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    ev.preventDefault();
    ev.stopPropagation();
    store.set({ year: clamp(Math.round(store.get().year) + step, YEAR_START, YEAR_END) });
  });

  // ── state → DOM ──
  const syncYear = () => {
    const s = store.get();
    const p = clamp((s.year - YEAR_START) / SPAN, 0, 1);
    const yi = Math.floor(s.year + 1e-6);
    setText(yearNum, String(yi));
    setText(yearFrac, `.${Math.floor((s.year - yi) * 10)}`);
    setText(thumbLbl, String(yi));
    setStyle(thumb, 'left', `${(p * 100).toFixed(3)}%`);
    setStyle(el, '--tl-p', p.toFixed(4));
    // clip the "played" chart copy so the line lights up as time advances
    setStyle(played, 'clip-path', `inset(0 ${((1 - p) * 100).toFixed(2)}% 0 0)`);
    track.setAttribute('aria-valuenow', String(yi));
  };
  const syncArea = () => setText(areaLbl, `${n1(sim.metrics().urbanAreaKm2)} km²`);
  const syncRest = () => {
    const s = store.get();
    playBtn.innerHTML = s.playing ? ICON.pause : ICON.play;
    playBtn.classList.toggle('on', s.playing);
    playBtn.setAttribute('aria-label', s.playing ? 'Pausar' : 'Reproducir');
    // highlight the closest preset (store default may be a non-preset value)
    let best = SPEEDS[0];
    for (const sp of SPEEDS) if (Math.abs(sp - s.speed) < Math.abs(best - s.speed)) best = sp;
    for (const b of speedBtns) b.classList.toggle('on', Number(b.dataset.speed) === best);
    cmpBtn.classList.toggle('on', s.compare);
    chip.classList.toggle('show', s.compare);
    cmpMarker.classList.toggle('show', s.compare);
    setText(chipY, String(Math.round(s.compareYear)));
    setStyle(cmpMarker, 'left', `${(((s.compareYear - YEAR_START) / SPAN) * 100).toFixed(3)}%`);
    const sc = scenarioMeta(s.scenario);
    setText(scnName, sc.label);
    setStyle(scnDot, 'background', sc.color);
  };

  store.subscribe(syncYear, ['year']);
  store.subscribe(syncRest, ['playing', 'speed', 'compare', 'compareYear', 'scenario']);
  bus.on('sim:tick', syncArea);
  bus.on('sim:projection', () => {
    drawHistory();
    syncArea();
  });
  syncYear();
  syncRest();
  syncArea();
  drawHistory();
  return el;
}
