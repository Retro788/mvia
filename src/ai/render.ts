/** DOM builders for MVIA messages: markdown-lite text, KPI rows, inline SVG charts, verdict chips, action chips. */
import type { Verdict } from '../core/types';
import type { ActionIcon, Attachment, BarItem, ChatAction } from './types';

const SVGNS = 'http://www.w3.org/2000/svg';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  return e;
}

// ───────────────────────────── markdown-lite ─────────────────────────────
/** inline: **bold**, `code` — built as DOM nodes (never innerHTML) so LLM text is safe */
function inline(parent: HTMLElement, text: string): void {
  const re = /\*\*(.+?)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    if (m[1] !== undefined) parent.appendChild(el('strong', undefined, m[1]));
    else parent.appendChild(el('code', undefined, m[2]));
    last = m.index + m[0].length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

export function renderMarkdown(md: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = md.replace(/\r/g, '').split('\n');
  let list: HTMLUListElement | HTMLOListElement | null = null;
  let para: HTMLParagraphElement | null = null;
  const closeList = () => (list = null);
  const closePara = () => (para = null);

  for (const raw of lines) {
    const line = raw.trimEnd();
    const ul = /^\s*[-•*]\s+(.*)$/.exec(line);
    const ol = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      closePara();
      const want = ul ? 'UL' : 'OL';
      if (!list || list.tagName !== want) {
        list = ul ? el('ul', 'mv-md-list') : el('ol', 'mv-md-list');
        frag.appendChild(list);
      }
      const li = el('li');
      inline(li, ul ? ul[1] : ol![2]);
      list.appendChild(li);
      continue;
    }
    if (!line.trim()) {
      closeList();
      closePara();
      continue;
    }
    closeList();
    if (!para) {
      para = el('p');
      frag.appendChild(para);
    } else {
      para.appendChild(el('br'));
    }
    inline(para, line);
  }
  return frag;
}

// ───────────────────────────── icons ─────────────────────────────
const ICON_PATHS: Record<ActionIcon | 'send' | 'mic' | 'speaker' | 'speakerOff' | 'wave' | 'trash' | 'close' | 'gear' | 'stop', string> = {
  map: 'M12 21s-6-5.6-6-10a6 6 0 1 1 12 0c0 4.4-6 10-6 10z M12 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  layer: 'M12 3 2 8l10 5 10-5-10-5z M2 13l10 5 10-5 M2 17.5l10 5 10-5',
  build: 'M3 21h18 M5 21V10l7-5 7 5v11 M9 21v-6h6v6',
  play: 'M7 4.5v15l12-7.5z',
  voice: 'M4 10v4 M8 7v10 M12 4v16 M16 8v8 M20 11v2',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 16v-5 M12 8h.01',
  send: 'M4 12 20 4l-6 16-3-7-7-1z',
  mic: 'M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3z M5 11a7 7 0 0 0 14 0 M12 18v3',
  speaker: 'M4 9h4l5-4v14l-5-4H4z M16.5 8.5a5 5 0 0 1 0 7 M19 6a8.5 8.5 0 0 1 0 12',
  speakerOff: 'M4 9h4l5-4v14l-5-4H4z M17 9l5 6 M22 9l-5 6',
  wave: 'M3 12h2 M7 8v8 M11 5v14 M15 9v6 M19 7v10 M21 12h0',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
  close: 'M6 6l12 12 M18 6 6 18',
  gear: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4z',
  stop: 'M7 7h10v10H7z',
};

export function icon(name: keyof typeof ICON_PATHS, size = 16): SVGSVGElement {
  const s = svg('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  for (const d of ICON_PATHS[name].split(' M')) {
    s.appendChild(svg('path', { d: d.startsWith('M') ? d : `M${d}` }));
  }
  if (name === 'play' || name === 'stop' || name === 'send') s.setAttribute('fill', 'currentColor');
  return s;
}

/** concentric-ring MVIA mark used in the orb, header and message avatar */
export function mviaMark(size: number, cls = 'mv-mark'): SVGSVGElement {
  const s = svg('svg', { viewBox: '0 0 40 40', width: size, height: size, class: cls, 'aria-hidden': 'true' });
  s.appendChild(svg('circle', { cx: 20, cy: 20, r: 18, class: 'mv-ring r3' }));
  s.appendChild(svg('circle', { cx: 20, cy: 20, r: 13, class: 'mv-ring r2' }));
  s.appendChild(svg('circle', { cx: 20, cy: 20, r: 8, class: 'mv-ring r1' }));
  s.appendChild(svg('path', { d: 'M14.5 24.5v-9l5.5 5.5 5.5-5.5v9', class: 'mv-glyph' }));
  return s;
}

// ───────────────────────────── attachments ─────────────────────────────
const VERDICT_VAR: Record<Verdict, string> = { viable: 'var(--ok)', observar: 'var(--note)', precaucion: 'var(--warn)', riesgo: 'var(--risk)' };

function kpis(a: Extract<Attachment, { kind: 'kpis' }>): HTMLElement {
  const box = el('div', 'mv-att mv-kpis');
  if (a.title) box.appendChild(el('div', 'mv-att-title', a.title));
  for (const [k, v] of a.rows) {
    const row = el('div', 'mv-kpi');
    row.appendChild(el('span', 'k', k));
    row.appendChild(el('span', 'v', v));
    box.appendChild(row);
  }
  return box;
}

function bars(a: Extract<Attachment, { kind: 'bars' }>): HTMLElement {
  const box = el('div', 'mv-att mv-bars');
  if (a.title) box.appendChild(el('div', 'mv-att-title', a.title));
  const W = 352;
  const rowH = 22;
  const labelW = 112;
  const valueW = 74;
  const H = a.items.length * rowH;
  const max = Math.max(1e-9, ...a.items.map((i) => Math.abs(i.value)));
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', preserveAspectRatio: 'xMinYMin meet', role: 'img' });
  a.items.forEach((it: BarItem, i) => {
    const y = i * rowH;
    const label = it.label.length > 17 ? `${it.label.slice(0, 16)}…` : it.label;
    const t = svg('text', { x: 0, y: y + 14, class: 'mv-bar-label' });
    t.textContent = label;
    s.appendChild(t);
    const trackW = W - labelW - valueW;
    s.appendChild(svg('rect', { x: labelW, y: y + 7, width: trackW, height: 8, class: 'mv-bar-track' }));
    const w = Math.max(2, (Math.abs(it.value) / max) * trackW);
    const bar = svg('rect', { x: labelW, y: y + 7, width: w, height: 8, class: it.accent ? 'mv-bar accent' : 'mv-bar' });
    if (it.verdict && !it.accent) bar.setAttribute('style', `--vcol:${VERDICT_VAR[it.verdict]}`);
    s.appendChild(bar);
    const v = svg('text', { x: W, y: y + 14, class: 'mv-bar-value', 'text-anchor': 'end' });
    v.textContent = it.display;
    s.appendChild(v);
  });
  box.appendChild(s);
  return box;
}

function line(a: Extract<Attachment, { kind: 'line' }>): HTMLElement {
  const box = el('div', 'mv-att mv-line');
  if (a.title) box.appendChild(el('div', 'mv-att-title', a.title));
  const W = 352;
  const H = 74;
  const pad = 4;
  const vals = a.values.length ? a.values : [0];
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const px = (i: number) => pad + (i / Math.max(1, vals.length - 1)) * (W - pad * 2);
  const py = (v: number) => H - 14 - ((v - min) / span) * (H - 30);
  const pts = vals.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img' });
  for (let g = 0; g < 3; g++) s.appendChild(svg('line', { x1: 0, x2: W, y1: 16 + g * 20, y2: 16 + g * 20, class: 'mv-grid' }));
  s.appendChild(svg('polygon', { points: `${px(0)},${H - 14} ${pts} ${px(vals.length - 1)},${H - 14}`, class: 'mv-area' }));
  s.appendChild(svg('polyline', { points: pts, class: 'mv-polyline' }));
  const lastI = vals.length - 1;
  s.appendChild(svg('circle', { cx: px(lastI), cy: py(vals[lastI]), r: 3, class: 'mv-dot' }));
  const tFrom = svg('text', { x: 0, y: H - 2, class: 'mv-axis' });
  tFrom.textContent = `${a.from} · ${a.fmt(vals[0])}`;
  const tTo = svg('text', { x: W, y: H - 2, class: 'mv-axis', 'text-anchor': 'end' });
  tTo.textContent = `${a.to} · ${a.fmt(vals[lastI])}`;
  s.append(tFrom, tTo);
  box.appendChild(s);
  return box;
}

function table(a: Extract<Attachment, { kind: 'table' }>): HTMLElement {
  const wrap = el('div', 'mv-att mv-table-wrap');
  const t = el('table', 'mv-table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of a.head) hr.appendChild(el('th', undefined, h));
  thead.appendChild(hr);
  const tb = el('tbody');
  for (const r of a.rows) {
    const tr = el('tr');
    r.forEach((c, i) => tr.appendChild(el(i === 0 ? 'th' : 'td', undefined, c)));
    tb.appendChild(tr);
  }
  t.append(thead, tb);
  wrap.appendChild(t);
  return wrap;
}

function verdicts(a: Extract<Attachment, { kind: 'verdicts' }>): HTMLElement {
  const box = el('div', 'mv-att mv-verdicts');
  for (const v of a.items) {
    const chip = el('span', `mv-verdict v-${v.verdict}`);
    chip.appendChild(el('i'));
    chip.appendChild(document.createTextNode(v.label));
    box.appendChild(chip);
  }
  return box;
}

function actions(a: Extract<Attachment, { kind: 'actions' }>, onAction: (act: ChatAction, btn: HTMLButtonElement) => void): HTMLElement {
  const box = el('div', 'mv-att mv-actions');
  for (const act of a.items) {
    const b = el('button', 'mv-action');
    b.type = 'button';
    b.appendChild(icon(act.icon, 13));
    b.appendChild(el('span', undefined, act.label));
    b.addEventListener('click', () => onAction(act, b));
    box.appendChild(b);
  }
  return box;
}

export function renderAttachment(a: Attachment, onAction: (act: ChatAction, btn: HTMLButtonElement) => void): HTMLElement {
  switch (a.kind) {
    case 'kpis':
      return kpis(a);
    case 'bars':
      return bars(a);
    case 'line':
      return line(a);
    case 'table':
      return table(a);
    case 'verdicts':
      return verdicts(a);
    case 'actions':
      return actions(a, onAction);
  }
}
