/**
 * Top-right analytics dock (340px) with four tabs bound to store.panel:
 * Mercado · Crédito · Comercio · Crecimiento. Only the active tab renders; updates are throttled and
 * write the DOM only when values change.
 */
import type {
  AppContext,
  EstablishmentType,
  MortgageParams,
  PanelId,
  ScenarioId,
  SiteEvaluation,
  ZoneStats,
} from '../core/types';
import { YEAR_END, YEAR_START, fmtMXN, fmtPct } from '../core/geo';
import { ChartCanvas, drawArea, drawGauge, drawHistogram, drawLines, type LineSeries } from './charts';
import { clamp, cssVar, esc, h, money, n0, n1, qs, setHTML, setStyle, setText, shortName, signed, throttle, VERDICTS } from './dom';
import { ICON } from './icons';
import { SCENARIOS, scenarioMeta } from './meta';
import { isBuildTool, selectEstablishment, selectPoint, selectZone } from './interaction';

interface Tab {
  id: PanelId;
  el: HTMLElement;
  /** full = structure may have changed (projection / tab shown); otherwise a cheap year refresh */
  render(full: boolean): void;
}

const TABS: Array<{ id: PanelId; label: string }> = [
  { id: 'mercado', label: 'Mercado' },
  { id: 'credito', label: 'Crédito' },
  { id: 'comercio', label: 'Comercio' },
  { id: 'crecimiento', label: 'Crecimiento' },
];

/** 'var(--risk)' → resolved colour usable on canvas */
const resolveColor = (c: string): string => {
  const m = c.match(/var\((--[\w-]+)\)/);
  return m ? cssVar(m[1]) : c;
};

const verdictDot = (v: keyof typeof VERDICTS): string => `<i class="vdot" style="background:${VERDICTS[v].color}"></i>`;

export function createDock(ctx: AppContext): HTMLElement {
  const { store, bus } = ctx;
  const el = h('aside', 'ui-panel ui-dock', { 'aria-label': 'Análisis MVIA' });
  el.innerHTML = `
    <header class="dock-head">
      <nav class="dock-tabs" role="tablist">
        ${TABS.map((t, i) => `<button class="dock-tab" role="tab" data-tab="${t.id}"><span class="tab-num mono">0${i + 1}</span>${t.label}</button>`).join('')}
      </nav>
      <button class="icon-btn dock-min" data-act="min" aria-label="Minimizar panel">${ICON.chevron}</button>
    </header>
    <div class="dock-body"></div>`;
  const body = qs(el, '.dock-body');
  const tabBtns = [...el.querySelectorAll<HTMLElement>('[data-tab]')];

  const tabs: Tab[] = [marketTab(ctx), creditTab(ctx), commerceTab(ctx), growthTab(ctx)];
  for (const t of tabs) {
    t.el.classList.add('dock-pane');
    t.el.hidden = true;
    body.appendChild(t.el);
  }
  const active = (): Tab => tabs.find((t) => t.id === store.get().panel) ?? tabs[0];
  const visible = () => !el.classList.contains('collapsed') && store.get().ready;

  el.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('button');
    if (!b) return;
    if (b.dataset.tab) {
      el.classList.remove('collapsed');
      if (store.get().panel === b.dataset.tab) render(true);
      store.set({ panel: b.dataset.tab as PanelId });
    } else if (b.dataset.act === 'min') el.classList.toggle('collapsed');
  });

  const render = (full: boolean) => {
    if (!visible()) return;
    active().render(full);
  };
  const showPanel = () => {
    const id = store.get().panel;
    for (const b of tabBtns) {
      const on = b.dataset.tab === id;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    }
    for (const t of tabs) t.el.hidden = t.id !== id;
    el.classList.remove('collapsed');
    body.scrollTop = 0;
    render(true);
  };
  const soft = throttle(() => render(false), 250);
  const hard = throttle(() => render(true), 120);

  store.subscribe(showPanel, ['panel']);
  store.subscribe(soft, ['year', 'selection', 'tool']);
  store.subscribe(hard, ['scenario', 'ready']);
  bus.on('sim:projection', hard);
  bus.on('sim:establishments', hard);
  new MutationObserver(() => render(true)).observe(el, { attributes: true, attributeFilter: ['class'] });
  showPanel();
  return el;
}

// ═════════════════════════════════ MERCADO ═════════════════════════════════
function marketTab(ctx: AppContext): Tab {
  const { sim, store } = ctx;
  const el = h('section', 'pane-mercado');
  el.innerHTML = `
    <div class="kicker k-year">Valor medio de suelo</div>
    <div class="big-row"><span class="big-num mono m-avg">—</span><span class="big-unit">/m²</span><span class="delta m-delta"></span></div>
    <div class="sub mono m-sub"></div>
    <div class="chart-box m-chart"></div>
    <div class="sec-head"><span class="kicker">Plusvalía · top 6 zonas</span><span class="kicker-r mono">%/año</span></div>
    <div class="bars m-bars"></div>
    <div class="sec-head"><span class="kicker">Distribución de precios</span><span class="kicker-r mono m-n"></span></div>
    <div class="chart-box m-hist"></div>
    <div class="axis mono"><span class="m-lo"></span><span class="m-hi"></span></div>`;
  const kYear = qs(el, '.k-year');
  const avg = qs(el, '.m-avg');
  const delta = qs(el, '.m-delta');
  const sub = qs(el, '.m-sub');
  const bars = qs(el, '.m-bars');
  const nLbl = qs(el, '.m-n');
  const lo = qs(el, '.m-lo');
  const hi = qs(el, '.m-hi');
  const chart = new ChartCanvas(qs(el, '.m-chart'), 92);
  const hist = new ChartCanvas(qs(el, '.m-hist'), 58);
  const BINS = 28;
  const binArr = new Float32Array(BINS);
  let zonesCache: ZoneStats[] = [];
  let lastHistYear = -1;

  bars.addEventListener('click', (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-zone]');
    const z = row && zonesCache.find((s) => s.zone.id === row.dataset.zone);
    if (z) selectZone(ctx, z.zone);
  });

  const drawHist = () => {
    const field = sim.layerField('landValue');
    const yrs = sim.urbanizationYears();
    const y = store.get().year;
    binArr.fill(0);
    let n = 0;
    let minI = -1;
    let maxI = -1;
    let minV = Infinity;
    let maxV = -Infinity;
    for (let i = 0; i < field.length; i++) {
      if (yrs[i] > y) continue; // only cells already urban this year
      const v = field[i];
      binArr[Math.min(BINS - 1, Math.max(0, Math.floor(v * BINS)))]++;
      n++;
      if (v < minV) ((minV = v), (minI = i));
      if (v > maxV) ((maxV = v), (maxI = i));
    }
    const sel = store.get().selection;
    const highlight = sel && sel.cellIndex >= 0 ? field[sel.cellIndex] : undefined;
    const ramp = ['--ramp-0', '--ramp-1', '--ramp-2', '--ramp-3', '--ramp-4'].map((v) => cssVar(v));
    hist.draw((g, w, hh) => drawHistogram(g, w, hh, binArr, { ramp, highlight }));
    setText(nLbl, `n = ${n0(n)} celdas`);
    setText(lo, minI >= 0 ? `mín ${fmtMXN(sim.cell(minI).landValue)}` : '');
    setText(hi, maxI >= 0 ? `máx ${fmtMXN(sim.cell(maxI).landValue)}` : '');
  };

  return {
    id: 'mercado',
    el,
    render(full) {
      const m = sim.metrics();
      const histM = sim.history();
      const base = histM[0]?.avgLandValue ?? m.avgLandValue;
      const d = base > 0 ? (m.avgLandValue / base - 1) * 100 : 0;
      setText(kYear, `Valor medio de suelo · ${Math.floor(m.year)}`);
      setText(avg, fmtMXN(m.avgLandValue));
      setText(delta, `${signed(d)}% vs 2026`);
      delta.classList.toggle('up', d >= 0);
      delta.classList.toggle('down', d < 0);
      setText(sub, `2026 · ${fmtMXN(base)}/m² → 2050 · ${fmtMXN(histM[histM.length - 1]?.avgLandValue ?? m.avgLandValue)}/m²`);
      const vals = histM.map((x) => x.avgLandValue);
      chart.draw((g, w, hh) =>
        drawArea(g, w, hh, vals, {
          color: cssVar('--ink'),
          grid: 3,
          marker: m.year - YEAR_START,
          markerLabel: fmtMXN(m.avgLandValue),
          xLabels: [String(YEAR_START), String(YEAR_END)],
        }),
      );

      zonesCache = sim.topZones('appreciation', 6);
      const maxA = Math.max(0.01, ...zonesCache.map((z) => z.appreciation));
      setHTML(
        bars,
        zonesCache
          .map(
            (z, i) => `<button class="bar-row" data-zone="${esc(z.zone.id)}">
              <span class="bar-rank mono">${String(i + 1).padStart(2, '0')}</span>
              <span class="bar-name">${esc(shortName(z.zone.name))}<em class="mono">${fmtMXN(z.landValue)}/m²</em></span>
              <span class="bar-track"><i style="width:${clamp((z.appreciation / maxA) * 100, 3, 100).toFixed(1)}%"></i></span>
              <span class="bar-val mono">${signed(z.appreciation)}%</span>
            </button>`,
          )
          .join(''),
      );
      if (full || Math.abs(m.year - lastHistYear) >= 0.5) {
        lastHistYear = m.year;
        drawHist();
      }
    },
  };
}

// ═════════════════════════════════ CRÉDITO ═════════════════════════════════
type Product = NonNullable<MortgageParams['product']>;
const PRODUCTS: Array<{ id: Product; label: string }> = [
  { id: 'bancario', label: 'Bancario' },
  { id: 'infonavit', label: 'Infonavit' },
  { id: 'fovissste', label: 'Fovissste' },
  { id: 'cofinavit', label: 'Cofinavit' },
];
const TERMS = [10, 15, 20, 25, 30];

function creditTab(ctx: AppContext): Tab {
  const { sim, store } = ctx;
  const st = { price: 2_400_000, down: 10, years: 20, product: 'bancario' as Product, auto: true };
  const el = h('section', 'pane-credito');
  el.innerHTML = `
    <div class="kicker">Simulador hipotecario MVIA</div>
    <div class="ctx-chip mono c-ctx"></div>
    <div class="form">
      <label class="f-row"><span class="f-k">Precio de la vivienda</span>
        <span class="f-inp"><input class="inp mono c-price" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" /><button class="mini-btn c-est" title="Estimar con la selección (140 m² terreno + 110 m² construcción)">${ICON.spark}Estimar</button></span>
      </label>
      <label class="f-row"><span class="f-k">Enganche <b class="mono c-down-v"></b></span>
        <input class="range c-down" type="range" min="5" max="50" step="1" />
      </label>
      <div class="f-row"><span class="f-k">Plazo</span>
        <div class="seg seg-fill mono c-terms">${TERMS.map((t) => `<button class="seg-btn" data-term="${t}">${t} a</button>`).join('')}</div>
      </div>
      <div class="f-row"><span class="f-k">Producto</span>
        <div class="seg seg-fill c-prod">${PRODUCTS.map((p) => `<button class="seg-btn" data-prod="${p.id}">${p.label}</button>`).join('')}</div>
      </div>
    </div>
    <div class="quote">
      <div class="quote-head"><span class="kicker">Mensualidad estimada</span><span class="badge c-risk"></span></div>
      <div class="big-row"><span class="big-num mono c-pay">—</span><span class="big-unit">/mes</span></div>
      <div class="kv-grid mono c-grid"></div>
    </div>
    <div class="sec-head"><span class="kicker">Riesgo de impago · ciudad</span><span class="kicker-r mono c-year"></span></div>
    <div class="gauge-row"><div class="chart-box c-gauge"></div><p class="gauge-note c-gnote"></p></div>
    <div class="sec-head"><span class="kicker">Zonas de mayor riesgo crediticio</span><span class="kicker-r mono">P(impago)</span></div>
    <div class="bars bars-risk c-bars"></div>`;

  const price = qs<HTMLInputElement>(el, '.c-price');
  const down = qs<HTMLInputElement>(el, '.c-down');
  const downV = qs(el, '.c-down-v');
  const ctxChip = qs(el, '.c-ctx');
  const termBtns = [...el.querySelectorAll<HTMLElement>('[data-term]')];
  const prodBtns = [...el.querySelectorAll<HTMLElement>('[data-prod]')];
  const pay = qs(el, '.c-pay');
  const risk = qs(el, '.c-risk');
  const grid = qs(el, '.c-grid');
  const yearLbl = qs(el, '.c-year');
  const gnote = qs(el, '.c-gnote');
  const bars = qs(el, '.c-bars');
  const gauge = new ChartCanvas(qs(el, '.c-gauge'), 92);
  let riskZones: ZoneStats[] = [];

  const selCell = (): number => {
    const sel = store.get().selection;
    return sel && sel.cellIndex >= 0 ? sel.cellIndex : -1;
  };
  const estimate = () => {
    const idx = selCell();
    const lv = idx >= 0 ? sim.cell(idx).landValue : sim.metrics().avgLandValue;
    let build = 11_000;
    try {
      build = sim.spec('vivienda').costM2 || build;
    } catch {
      /* spec missing: keep default construction cost */
    }
    st.price = Math.max(300_000, Math.round((lv * 140 + build * 110) / 10_000) * 10_000);
  };

  const quote = () => {
    const idx = selCell();
    const q = sim.mortgageQuote({
      price: st.price,
      downPayment: (st.price * st.down) / 100,
      years: st.years,
      product: st.product,
      cellIndex: idx >= 0 ? idx : undefined,
    });
    setText(pay, money(q.monthlyPayment));
    const rc = q.risk === 'bajo' ? 'ok' : q.risk === 'medio' ? 'warn' : 'risk';
    setText(risk, `● Riesgo ${q.risk}`);
    risk.dataset.kind = rc;
    setHTML(
      grid,
      [
        ['Tasa anual', fmtPct(q.rate, 2)],
        ['CAT', fmtPct(q.cat, 1)],
        ['Ingreso requerido', `${money(q.requiredIncome)}/mes`],
        ['LTV', fmtPct(q.ltv * 100, 0)],
        ['Crédito', money(q.principal)],
        ['Total pagado', fmtMXN(q.totalPaid)],
      ]
        .map(([k, v]) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`)
        .join(''),
    );
  };

  const syncForm = () => {
    if (document.activeElement !== price) price.value = money(st.price);
    down.value = String(st.down);
    setText(downV, `${st.down}% · ${money((st.price * st.down) / 100)}`);
    for (const b of termBtns) b.classList.toggle('on', Number(b.dataset.term) === st.years);
    for (const b of prodBtns) b.classList.toggle('on', b.dataset.prod === st.product);
    const idx = selCell();
    if (idx >= 0) {
      const c = sim.cell(idx);
      setText(ctxChip, `● ${c.zoneName || 'Celda'} · ${fmtMXN(c.landValue)}/m² · riesgo ${(c.creditRisk * 100).toFixed(1)}%`);
      ctxChip.classList.add('on');
    } else {
      setText(ctxChip, '○ Sin selección · se usa el promedio de la ciudad');
      ctxChip.classList.remove('on');
    }
  };

  price.addEventListener('input', () => {
    const v = Number(price.value.replace(/[^\d]/g, ''));
    if (v > 0) {
      st.price = v;
      st.auto = false;
      syncForm();
      quote();
    }
  });
  price.addEventListener('blur', () => (price.value = money(st.price)));
  down.addEventListener('input', () => {
    st.down = Number(down.value);
    syncForm();
    quote();
  });
  el.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('button');
    if (!b) return;
    if (b.dataset.term) st.years = Number(b.dataset.term);
    else if (b.dataset.prod) st.product = b.dataset.prod as Product;
    else if (b.classList.contains('c-est')) {
      st.auto = true;
      estimate();
    } else if (b.dataset.zone) {
      const z = riskZones.find((s) => s.zone.id === b.dataset.zone);
      if (z) selectZone(ctx, z.zone);
      return;
    } else return;
    syncForm();
    quote();
  });

  let lastSel = -2;
  return {
    id: 'credito',
    el,
    render() {
      const idx = selCell();
      if (idx !== lastSel) {
        lastSel = idx;
        if (st.auto && idx >= 0) estimate();
      }
      syncForm();
      quote();
      const m = sim.metrics();
      setText(yearLbl, String(Math.floor(m.year)));
      // gauge spans 0–20 % default probability (a very stressed market sits near the top)
      gauge.draw((g, w, hh) => drawGauge(g, w, hh, m.creditDefaultRisk / 0.2, fmtPct(m.creditDefaultRisk * 100)));
      setText(
        gnote,
        `Tasa mediana ${fmtPct(m.medianMortgageRate, 2)} · déficit de vivienda ${n0(m.housingDeficit)} viviendas. ` +
          (m.creditDefaultRisk > 0.1 ? 'Cartera bajo estrés: endurecer originación en periferia.' : 'Cartera estable con focos en la periferia.'),
      );
      riskZones = sim.topZones('creditRisk', 6);
      const maxR = Math.max(0.001, ...riskZones.map((z) => z.creditRisk));
      setHTML(
        bars,
        riskZones
          .map(
            (z, i) => `<button class="bar-row" data-zone="${esc(z.zone.id)}">
              <span class="bar-rank mono">${String(i + 1).padStart(2, '0')}</span>
              <span class="bar-name">${esc(shortName(z.zone.name))}<em class="mono">${fmtPct(z.mortgageRate, 1)} tasa</em></span>
              <span class="bar-track"><i style="width:${clamp((z.creditRisk / maxR) * 100, 3, 100).toFixed(1)}%"></i></span>
              <span class="bar-val mono">${(z.creditRisk * 100).toFixed(1)}%</span>
            </button>`,
          )
          .join(''),
      );
    },
  };
}

// ═════════════════════════════════ COMERCIO ═════════════════════════════════
function commerceTab(ctx: AppContext): Tab {
  const { sim, store, bus } = ctx;
  const el = h('section', 'pane-comercio');
  el.innerHTML = `
    <div class="kicker">Establecimientos · evaluar y construir</div>
    <div class="tool-row">
      <button class="pill" data-tool="inspect">${ICON.cursor}Inspeccionar</button>
      <button class="pill" data-tool="bulldoze">${ICON.bulldoze}Demoler</button>
    </div>
    <div class="spec-grid k-grid"></div>
    <div class="tool-hint k-hint"><i class="dot dot-live"></i><span class="k-hint-t"></span></div>
    <div class="sug k-sug"></div>
    <div class="sec-head"><span class="kicker k-est-h">En operación</span><span class="kicker-r mono k-est-tot"></span></div>
    <div class="est-list k-est"></div>`;
  const grid = qs(el, '.k-grid');
  const hint = qs(el, '.k-hint');
  const hintT = qs(el, '.k-hint-t');
  const sugBox = qs(el, '.k-sug');
  const estH = qs(el, '.k-est-h');
  const estTot = qs(el, '.k-est-tot');
  const estList = qs(el, '.k-est');
  let suggestions: SiteEvaluation[] = [];
  let sugType: EstablishmentType | null = null;

  const buildGrid = () => {
    setHTML(
      grid,
      sim
        .specs()
        .map(
          (s) => `<div class="spec-card" data-card="${s.type}">
            <button class="spec-main" data-tool="${s.type}" title="${esc(s.description)}">
              <i class="spec-ico mono" style="background:${s.color}">${esc(s.short)}</i>
              <span class="spec-label">${esc(s.label)}</span>
              <span class="spec-cost mono">${fmtMXN(s.costM2)}/m²</span>
            </button>
            <button class="spec-sug mono" data-suggest="${s.type}" title="Sugerir ubicaciones MVIA">${ICON.spark}Sugerir</button>
          </div>`,
        )
        .join(''),
    );
  };

  const renderSug = () => {
    if (!sugType) return setHTML(sugBox, '');
    const spec = sim.spec(sugType);
    setHTML(
      sugBox,
      `<div class="sec-head"><span class="kicker">${ICON.spark}Sugerencias MVIA · ${esc(spec.label)}</span><button class="icon-btn" data-sug-close aria-label="Cerrar sugerencias">${ICON.close}</button></div>
      ${
        suggestions.length
          ? suggestions
              .map((s, i) => {
                const zone = s.cellIndex >= 0 ? sim.cell(s.cellIndex).zoneName : '';
                return `<div class="sug-row" data-go="${i}">
                  <span class="score mono" style="background:${VERDICTS[s.verdict].color};color:${VERDICTS[s.verdict].ink}">${Math.round(s.score)}</span>
                  <span class="sug-name">${esc(zone || 'Sitio ' + (i + 1))}<em class="mono">ROI ${n1(s.roi)}% · ${fmtMXN(s.investment)} · ${n1(s.paybackYears)} a</em></span>
                  <button class="mini-btn dark" data-build="${i}">${ICON.build}Construir</button>
                </div>`;
              })
              .join('')
          : '<p class="empty-note">MVIA no encontró sitios viables para este tipo en el año activo.</p>'
      }`,
    );
  };

  const renderEst = () => {
    const list = sim.establishments();
    setText(estH, `En operación · ${list.length}`);
    setText(estTot, list.length ? fmtMXN(list.reduce((a, e) => a + e.investment, 0)) : '');
    const sel = store.get().selection;
    setHTML(
      estList,
      list.length
        ? list
            .slice()
            .reverse()
            .map(
              (e) => `<div class="est-row${sel?.kind === 'establishment' && sel.id === e.id ? ' on' : ''}" data-est="${esc(e.id)}">
                ${verdictDot(e.verdict)}
                <span class="est-name">${esc(e.name)}<em class="mono">${esc(sim.spec(e.type).short)} · ${e.year} · ${e.createdBy === 'mvia' ? 'MVIA' : 'usuario'}</em></span>
                <span class="est-num mono"><b>${n1(e.roi)}%</b><em>ROI</em></span>
                <span class="est-num mono"><b>${n1(e.paybackYears)} a</b><em>payback</em></span>
                <button class="icon-btn" data-remove="${esc(e.id)}" aria-label="Eliminar">${ICON.close}</button>
              </div>`,
            )
            .join('')
        : '<p class="empty-note">Aún no hay establecimientos. Elige un tipo y haz clic en el mapa, o pide sugerencias a MVIA.</p>',
    );
  };

  const syncTool = () => {
    const tool = store.get().tool;
    for (const b of el.querySelectorAll<HTMLElement>('[data-tool]')) b.classList.toggle('on', b.dataset.tool === tool);
    for (const c of el.querySelectorAll<HTMLElement>('[data-card]')) c.classList.toggle('on', c.dataset.card === tool);
    const build = isBuildTool(tool);
    hint.classList.toggle('show', tool !== 'inspect');
    setText(
      hintT,
      build ? `${sim.spec(tool).label}: haz clic en el mapa para evaluar y construir · Esc para salir` : 'Demoler: haz clic sobre un establecimiento · Esc para salir',
    );
  };

  el.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const b = t.closest<HTMLElement>('button');
    const s = store.get();
    if (b?.dataset.tool) {
      const tool = b.dataset.tool as typeof s.tool;
      store.set({ tool: s.tool === tool && tool !== 'inspect' ? 'inspect' : tool });
      if (isBuildTool(tool)) bus.emit('ui:toast', { text: 'Haz clic en el mapa para evaluar y construir', kind: 'info' });
      return;
    }
    if (b?.dataset.suggest) {
      sugType = b.dataset.suggest as EstablishmentType;
      suggestions = sim.suggestSites(sugType, 5);
      renderSug();
      return;
    }
    if (b && b.hasAttribute('data-sug-close')) {
      sugType = null;
      suggestions = [];
      renderSug();
      return;
    }
    if (b?.dataset.build && sugType) {
      const sgt = suggestions[Number(b.dataset.build)];
      if (!sgt) return;
      const e = sim.placeEstablishment(sugType, sgt.pos.x, sgt.pos.z, 'mvia');
      // sim toasts the outcome (built / rejected) itself
      if (e) {
        selectEstablishment(ctx, e);
        suggestions = sim.suggestSites(sugType, 5);
        renderSug();
      }
      return;
    }
    if (b?.dataset.remove) {
      const id = b.dataset.remove;
      sim.removeEstablishment(id);
      const sel = store.get().selection;
      if (sel?.kind === 'establishment' && sel.id === id) store.set({ selection: null });
      return;
    }
    const go = t.closest<HTMLElement>('[data-go]');
    if (go) {
      const sgt = suggestions[Number(go.dataset.go)];
      if (sgt) selectPoint(ctx, sgt.pos, true, 0.7);
      return;
    }
    const row = t.closest<HTMLElement>('[data-est]');
    if (row) {
      const e = sim.establishments().find((x) => x.id === row.dataset.est);
      if (e) selectEstablishment(ctx, e);
    }
  });

  return {
    id: 'comercio',
    el,
    render(full) {
      if (full || !grid.firstChild) buildGrid();
      syncTool();
      renderEst();
      if (full && sugType) {
        suggestions = sim.suggestSites(sugType, 5);
        renderSug();
      }
    },
  };
}

// ═════════════════════════════════ CRECIMIENTO ═════════════════════════════════
function growthTab(ctx: AppContext): Tab {
  const { sim, store, bus } = ctx;
  const el = h('section', 'pane-crecimiento');
  el.innerHTML = `
    <div class="kicker">Escenarios de crecimiento · 2026 → 2050</div>
    <div class="scn-cards">
      ${SCENARIOS.map(
        (s) => `<button class="scn-card" data-scn="${s.id}">
          <span class="scn-title"><i class="seg-dot" style="background:${s.color}"></i>${s.label}</span>
          <span class="scn-desc">${s.desc}</span>
        </button>`,
      ).join('')}
    </div>
    <div class="kpi-grid g-kpi"></div>
    <div class="sec-head"><span class="kicker">Área urbana · km²</span><span class="legend-chips g-legend"></span></div>
    <div class="chart-box g-chart"></div>
    <div class="sec-head"><span class="kicker">Frentes de crecimiento</span><span class="kicker-r mono">% urbanizado</span></div>
    <div class="bars bars-growth g-fronts"></div>`;
  const cards = [...el.querySelectorAll<HTMLElement>('[data-scn]')];
  const kpi = qs(el, '.g-kpi');
  const legend = qs(el, '.g-legend');
  const fronts = qs(el, '.g-fronts');
  const chart = new ChartCanvas(qs(el, '.g-chart'), 104);
  /** urban-area curves of every scenario the user has already projected (to overlay as ghosts) */
  const curves = new Map<ScenarioId, number[]>();
  let frontZones: ZoneStats[] = [];

  const capture = () => curves.set(sim.scenario, sim.history().map((m) => m.urbanAreaKm2));
  bus.on('sim:projection', capture);
  capture();

  el.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('button');
    if (!b) return;
    if (b.dataset.scn) store.set({ scenario: b.dataset.scn as ScenarioId });
    else if (b.dataset.zone) {
      const z = frontZones.find((s) => s.zone.id === b.dataset.zone);
      if (z) selectZone(ctx, z.zone);
    }
  });

  return {
    id: 'crecimiento',
    el,
    render() {
      const s = store.get();
      for (const c of cards) c.classList.toggle('on', c.dataset.scn === s.scenario);
      const hist = sim.history();
      const a = hist[0];
      const z = hist[hist.length - 1];
      if (a && z) {
        const areaPct = a.urbanAreaKm2 > 0 ? (z.urbanAreaKm2 / a.urbanAreaKm2 - 1) * 100 : 0;
        const popPct = a.population > 0 ? (z.population / a.population - 1) * 100 : 0;
        setHTML(
          kpi,
          [
            ['Área urbana', `${signed(areaPct, 0)}%`, `${n1(a.urbanAreaKm2)} → ${n1(z.urbanAreaKm2)} km²`, areaPct > 30 ? 'risk' : areaPct > 15 ? 'warn' : 'ok'],
            ['Población 2050', n0(z.population), `${signed(popPct, 0)}% vs 2026`, 'note'],
            ['Pérdida verde', `${n0(z.greenLossHa)} ha`, 'acumulada 2026–2050', z.greenLossHa > 600 ? 'risk' : z.greenLossHa > 200 ? 'warn' : 'ok'],
            ['Dispersión', z.sprawlIndex.toFixed(2), `${a.sprawlIndex.toFixed(2)} en 2026`, z.sprawlIndex > 0.6 ? 'risk' : z.sprawlIndex > 0.45 ? 'warn' : 'ok'],
          ]
            .map(([k, v, sub, lvl]) => `<div class="kpi" data-lvl="${lvl}"><span class="kpi-k">${k}</span><b class="kpi-v mono">${v}</b><em class="mono">${sub}</em></div>`)
            .join(''),
        );
      }
      const series: LineSeries[] = [];
      const cur = curves.get(s.scenario) ?? hist.map((m) => m.urbanAreaKm2);
      series.push({ values: cur, color: resolveColor(scenarioMeta(s.scenario).color), width: 2, fill: true });
      for (const sc of SCENARIOS) {
        const c = curves.get(sc.id);
        if (sc.id !== s.scenario && c) series.push({ values: c, color: resolveColor(sc.color), dashed: true, width: 1.25, fill: false });
      }
      const cm = sim.metrics();
      chart.draw((g, w, hh) =>
        drawLines(g, w, hh, series, {
          grid: 3,
          marker: cm.year - YEAR_START,
          markerLabel: `${n1(cm.urbanAreaKm2)} km²`,
          xLabels: [String(YEAR_START), String(YEAR_END)],
        }),
      );
      setHTML(
        legend,
        SCENARIOS.filter((sc) => curves.has(sc.id))
          .map((sc) => `<span class="lchip${sc.id === s.scenario ? ' on' : ''}"><i style="background:${sc.color}"></i>${sc.label.slice(0, 5)}.</span>`)
          .join(''),
      );
      frontZones = sim.topZones('growth', 6);
      setHTML(
        fronts,
        frontZones
          .map(
            (zs, i) => `<button class="bar-row" data-zone="${esc(zs.zone.id)}">
              <span class="bar-rank mono">${String(i + 1).padStart(2, '0')}</span>
              <span class="bar-name">${esc(shortName(zs.zone.name))}<em class="mono">${signed(zs.appreciation)}%/a · ${n0(zs.population)} hab</em></span>
              <span class="bar-track"><i style="width:${clamp(zs.urbanShare * 100, 3, 100).toFixed(1)}%"></i></span>
              <span class="bar-val mono">${(zs.urbanShare * 100).toFixed(0)}%</span>
            </button>`,
          )
          .join(''),
      );
      setStyle(el, '--scn', scenarioMeta(s.scenario).color);
    },
  };
}
