/**
 * Machine-sight inspector card: floats next to the projected selection point with a hairline connector.
 * Header bar coloured by verdict, title, summary, chip row, mono key/value table, footer and actions.
 */
import type { AppContext, Selection, Verdict } from '../core/types';
import { fmtMXN, fmtPct } from '../core/geo';
import { cellCode, clamp, esc, h, n0, n1, qs, setHTML, setStyle, setText, shortName, throttle, VERDICTS } from './dom';
import { ICON } from './icons';

interface Content {
  verdict: Verdict;
  id: string;
  kicker: string;
  title: string;
  summary: string;
  chips: Array<[string, string]>;
  rows: Array<[string, string]>;
  notes: string[];
  footer: string;
  score?: number;
  speak: string;
  zone: string;
  /** world-units above ground for the anchor */
  lift: number;
  canBuild: boolean;
  removable?: string;
}

const KIND_LABEL: Record<string, string> = {
  centro: 'Centro histórico',
  residencial: 'Residencial',
  popular: 'Popular',
  premium: 'Premium',
  comercial: 'Comercial',
  industrial: 'Industrial',
  periferia: 'Periferia',
  rural: 'Rural',
  universitaria: 'Universitaria',
};

export function createInspector(ctx: AppContext): HTMLElement {
  const { store, sim, view, world, bus } = ctx;
  const root = h('div', 'ui-inspector ui-pass');
  root.innerHTML = `
    <i class="insp-anchor"></i>
    <i class="insp-line"></i>
    <article class="insp-card" role="dialog" aria-label="Inspector MVIA">
      <header class="insp-head">
        <span class="insp-verdict mono"></span>
        <span class="insp-id mono"></span>
        <button class="insp-x" data-act="close" aria-label="Cerrar">${ICON.close}</button>
      </header>
      <div class="insp-body">
        <div class="kicker insp-kicker"></div>
        <h3 class="insp-title"></h3>
        <p class="insp-summary"></p>
        <div class="insp-chips"></div>
        <div class="insp-score"><div class="score-track"><i></i></div><span class="mono score-v"></span></div>
        <div class="insp-rows mono"></div>
        <ul class="insp-notes"></ul>
        <p class="insp-footer mono"></p>
      </div>
      <footer class="insp-actions">
        <button class="ia-btn ia-ask" data-act="ask">${ICON.chat}Preguntar a MVIA</button>
        <button class="ia-btn" data-act="listen">${ICON.speaker}Escuchar</button>
        <button class="ia-btn ia-build" data-act="build">${ICON.build}Construir aquí</button>
        <button class="ia-btn ia-remove" data-act="remove">${ICON.trash}Eliminar</button>
      </footer>
    </article>`;

  const card = qs(root, '.insp-card');
  const anchor = qs(root, '.insp-anchor');
  const line = qs(root, '.insp-line');
  const head = qs(root, '.insp-head');
  const vLbl = qs(root, '.insp-verdict');
  const idLbl = qs(root, '.insp-id');
  const kicker = qs(root, '.insp-kicker');
  const title = qs(root, '.insp-title');
  const summary = qs(root, '.insp-summary');
  const chips = qs(root, '.insp-chips');
  const scoreBox = qs(root, '.insp-score');
  const scoreBar = qs(root, '.score-track i');
  const scoreV = qs(root, '.score-v');
  const rows = qs(root, '.insp-rows');
  const notes = qs(root, '.insp-notes');
  const footer = qs(root, '.insp-footer');
  const buildBtn = qs(root, '[data-act="build"]');
  const removeBtn = qs(root, '[data-act="remove"]');

  let content: Content | null = null;
  let cardW = 312;
  let cardH = 320;
  let anchorY = 0;

  const read = (sel: Selection): Content | null => {
    const year = Math.floor(store.get().year);
    if (sel.kind === 'establishment') {
      const e = sim.establishments().find((x) => x.id === sel.id);
      if (!e) return null;
      const spec = sim.spec(e.type);
      const zone = e.cellIndex >= 0 ? sim.cell(e.cellIndex).zoneName : '';
      return {
        verdict: e.verdict,
        id: `${spec.short} ${e.id.replace(/\D/g, '').slice(-2).padStart(2, '0')}`,
        kicker: `${spec.label} · ${e.year} · ${e.createdBy === 'mvia' ? 'propuesto por MVIA' : 'usuario'}`,
        title: e.name,
        summary: e.allowed ? `${spec.description}` : `Restricción: ${e.reason ?? 'uso no permitido'}`,
        chips: [
          ['ON', `Zona · ${zone || '—'}`],
          ['M²', `${n0(e.areaM2)} m² construidos`],
        ],
        rows: [
          ['ROI anual', fmtPct(e.roi)],
          ['Inversión', fmtMXN(e.investment)],
          ['Payback', `${n1(e.paybackYears)} años`],
          ['Afluencia', `${n0(e.footfall)} visitas/día`],
          ['Ingreso anual', fmtMXN(e.annualRevenue)],
          ['Cap rate', fmtPct(e.capRate)],
        ],
        notes: e.notes.slice(0, 4),
        footer: `SCORE MVIA ${Math.round(e.score)}/100 · AÑO ${year}`,
        score: e.score,
        speak: `${e.name}. ${VERDICTS[e.verdict].label.toLowerCase()}. Retorno anual de ${e.roi.toFixed(1)} por ciento, recuperación en ${e.paybackYears.toFixed(1)} años. ${e.notes[0] ?? ''}`,
        zone: zone || e.name,
        lift: spec.height + 1,
        canBuild: false,
        removable: e.id,
      };
    }
    if (sel.kind === 'zone') {
      const zs = sim.zoneStats(sel.id);
      if (!zs) return null;
      const z = zs.zone;
      return {
        verdict: zs.verdict,
        id: `ZONA ${z.id.toUpperCase().slice(0, 4)}`,
        kicker: `${KIND_LABEL[z.kind] ?? z.kind} · ingreso ${z.income} · ${year}`,
        title: z.name,
        summary: z.description,
        chips: [
          ['ON', `Zona · ${shortName(z.name)}`],
          ...(z.growthFront ? ([['GRW', 'Frente de crecimiento']] as Array<[string, string]>) : []),
          ...(z.floodRisk > 0.5 ? ([['H2O', 'Riesgo de inundación']] as Array<[string, string]>) : []),
        ],
        rows: [
          ['Valor de suelo', `${fmtMXN(zs.landValue)}/m²`],
          ['Plusvalía', `${fmtPct(zs.appreciation)} anual`],
          ['Riesgo crediticio', fmtPct(zs.creditRisk * 100)],
          ['Tasa hipotecaria', fmtPct(zs.mortgageRate, 2)],
          ['Demanda comercial', `${Math.round(zs.commercialDemand * 100)}/100`],
          ['Población', n0(zs.population)],
          ['Urbanizado', fmtPct(zs.urbanShare * 100, 0)],
        ],
        notes: [],
        footer: `PISOS TÍPICOS ${z.floors[0]}–${z.floors[1]} · DENSIDAD 2026 ${Math.round(z.density * 100)}%`,
        speak: `${z.name}. ${z.description} Valor de suelo de ${Math.round(zs.landValue).toLocaleString('es-MX')} pesos por metro cuadrado, plusvalía de ${zs.appreciation.toFixed(1)} por ciento anual.`,
        zone: z.name,
        lift: 2,
        canBuild: true,
      };
    }
    const idx = sel.cellIndex;
    if (idx < 0) return null;
    const r = sim.readCell(idx);
    const c = sim.cell(idx);
    const chipsC: Array<[string, string]> = [['ON', `Zona · ${c.zoneName || 'Sin zona'}`]];
    if (c.protected) chipsC.push(['ANP', 'Reserva ecológica']);
    if (c.floodRisk > 0.5) chipsC.push(['H2O', 'Inundable']);
    if (c.yearUrbanized <= 2026) chipsC.push(['URB', 'Urbano 2026']);
    else if (c.yearUrbanized < 9999) chipsC.push(['GRW', `Urbaniza ${Math.round(c.yearUrbanized)}`]);
    else chipsC.push(['—', 'Sin urbanizar']);
    if (sel.kind === 'landmark') {
      const l = sim.mapData.landmarks.find((x) => x.id === sel.id);
      if (l) {
        return {
          verdict: r.verdict,
          id: `◆ ${l.kind.toUpperCase()}`,
          kicker: `Hito urbano · ${year}`,
          title: l.name,
          summary: l.description,
          chips: chipsC,
          rows: r.rows,
          notes: [],
          footer: `${r.title.toUpperCase()} · ${Math.round(c.elevation)} M S.N.M.`,
          speak: `${l.name}. ${l.description} ${r.summary}`,
          zone: c.zoneName || l.name,
          lift: (l.height ?? 3) + 1,
          canBuild: false,
        };
      }
    }
    return {
      verdict: r.verdict,
      id: `CELDA ${cellCode(idx, sim.grid.cols)}`,
      kicker: `Lectura MVIA · ${year} · ${Math.round(c.elevation)} m · ${c.slope.toFixed(1)}°`,
      title: r.title,
      summary: r.summary,
      chips: chipsC,
      rows: r.rows,
      notes: [],
      footer: r.footer ?? `${fmtMXN(c.landValue)}/M² · ${fmtPct(c.appreciation)} ANUAL · ${n0(c.population)} HAB`,
      speak: `${r.title}. ${r.summary}`,
      zone: c.zoneName || r.title,
      lift: 0.6,
      canBuild: !c.protected,
    };
  };

  const render = () => {
    const sel = store.get().selection;
    content = sel ? read(sel) : null;
    if (!content) {
      root.classList.remove('show');
      return;
    }
    const v = VERDICTS[content.verdict];
    setStyle(head, 'background', v.color);
    setStyle(head, 'color', v.ink);
    setStyle(root, '--v', v.color);
    setText(vLbl, `● ${v.label}`);
    setText(idLbl, content.id);
    setText(kicker, content.kicker);
    setText(title, content.title);
    setText(summary, content.summary);
    setHTML(chips, content.chips.map(([k, t]) => `<span class="chip"><b class="mono">${esc(k)}</b>${esc(t)}</span>`).join(''));
    scoreBox.hidden = content.score === undefined;
    if (content.score !== undefined) {
      setStyle(scoreBar, 'width', `${clamp(content.score, 0, 100).toFixed(0)}%`);
      setText(scoreV, `${Math.round(content.score)}/100`);
    }
    setHTML(rows, content.rows.map(([k, val]) => `<div class="kv"><span>${esc(k)}</span><b>${esc(val)}</b></div>`).join(''));
    setHTML(notes, content.notes.map((n) => `<li>${esc(n)}</li>`).join(''));
    notes.hidden = !content.notes.length;
    setText(footer, content.footer);
    buildBtn.hidden = !content.canBuild;
    removeBtn.hidden = !content.removable;
    anchorY = sel ? world.groundY(sel.point.x, sel.point.z) + content.lift : 0;
    root.classList.add('show');
    cardW = card.offsetWidth || cardW;
    cardH = card.offsetHeight || cardH;
  };

  root.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('button');
    if (!b || !content) return;
    const act = b.dataset.act;
    if (act === 'close') store.set({ selection: null });
    else if (act === 'ask') {
      store.set({ chatOpen: true });
      bus.emit('chat:ask', { text: `Analiza esta zona: ${content.zone}` });
    } else if (act === 'listen') bus.emit('voice:speak', { text: content.speak });
    else if (act === 'build') {
      store.set({ panel: 'comercio' });
      bus.emit('ui:toast', { text: 'Elige un tipo de establecimiento y haz clic en el mapa', kind: 'info' });
    } else if (act === 'remove' && content.removable) {
      sim.removeEstablishment(content.removable);
      store.set({ selection: null });
    }
  });

  // ── anchoring: project the selection each frame and keep the card inside the viewport ──
  bus.on('view:frame', () => {
    const sel = store.get().selection;
    if (!sel || !content) return;
    const p = view.project(sel.point.x, anchorY, sel.point.z);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const narrow = vw < 760;
    const onScreen = p.visible && p.x > -40 && p.x < vw + 40 && p.y > -40 && p.y < vh + 40;
    root.classList.toggle('offscreen', !onScreen && !narrow);
    root.classList.toggle('narrow', narrow);
    if (narrow) {
      setStyle(card, 'transform', `translate3d(12px, ${Math.round(vh - cardH - 150)}px, 0)`);
      setStyle(anchor, 'transform', `translate3d(${Math.round(p.x)}px, ${Math.round(p.y)}px, 0)`);
      return;
    }
    const gap = 44;
    // prefer the right side of the point; flip left when it would collide with the right edge / dock
    let cx = p.x + gap;
    if (cx + cardW > vw - 372 && p.x - gap - cardW > 316) cx = p.x - gap - cardW;
    cx = clamp(cx, 16, vw - cardW - 16);
    const cy = clamp(p.y - 64, 16, vh - cardH - 120);
    setStyle(card, 'transform', `translate3d(${Math.round(cx)}px, ${Math.round(cy)}px, 0)`);
    setStyle(anchor, 'transform', `translate3d(${Math.round(p.x)}px, ${Math.round(p.y)}px, 0)`);
    // connector: from the point to the nearest vertical edge of the card, 26px under its top
    const ex = cx > p.x ? cx : cx + cardW;
    const ey = clamp(p.y, cy + 14, cy + 40);
    const dx = ex - p.x;
    const dy = ey - p.y;
    const len = Math.hypot(dx, dy);
    const ang = Math.atan2(dy, dx);
    setStyle(line, 'width', `${len.toFixed(1)}px`);
    setStyle(line, 'transform', `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0) rotate(${ang.toFixed(4)}rad)`);
  });

  store.subscribe(render, ['selection']);
  const soft = throttle(render, 350);
  store.subscribe(() => store.get().selection && soft(), ['year', 'scenario']);
  bus.on('sim:establishments', ({ removed }) => {
    const sel = store.get().selection;
    if (sel?.kind === 'establishment' && removed === sel.id) store.set({ selection: null });
    else if (sel) soft();
  });
  bus.on('sim:projection', () => store.get().selection && soft());
  render();
  return root;
}
