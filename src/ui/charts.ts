/**
 * Minimal canvas chart kit for the HUD: DPR-aware canvases that repaint on resize, plus stateless painters
 * (area/line with gradient fill, multi-line, histogram, sparkline, gauge). Colours come from CSS tokens.
 */
import { cssVar, withAlpha } from './dom';

export type Painter = (g: CanvasRenderingContext2D, w: number, h: number) => void;

/** A canvas sized to its CSS box × devicePixelRatio. Holds the last painter and replays it on resize. */
export class ChartCanvas {
  readonly el: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private painter: Painter | null = null;

  constructor(parent: HTMLElement, height: number, cls = 'chart') {
    this.el = document.createElement('canvas');
    this.el.className = cls;
    this.el.style.height = `${height}px`;
    parent.appendChild(this.el);
    const g = this.el.getContext('2d');
    if (!g) throw new Error('[ui] 2D canvas unavailable');
    this.g = g;
    new ResizeObserver(() => this.resize()).observe(this.el);
  }

  private resize(): void {
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = w;
    this.h = h;
    this.el.width = Math.round(w * dpr);
    this.el.height = Math.round(h * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.paint();
  }

  draw(p: Painter): void {
    this.painter = p;
    if (!this.w) this.resize();
    else this.paint();
  }

  private paint(): void {
    if (!this.painter || !this.w) return;
    this.g.clearRect(0, 0, this.w, this.h);
    this.g.save();
    this.painter(this.g, this.w, this.h);
    this.g.restore();
  }
}

export interface SeriesOpts {
  color?: string;
  min?: number;
  max?: number;
  /** fractional index of a vertical marker (e.g. current year) */
  marker?: number;
  fill?: boolean;
  dashed?: boolean;
  lineWidth?: number;
  /** horizontal hairlines */
  grid?: number;
  pad?: { l: number; r: number; t: number; b: number };
  /** labels printed under the x axis at the first / last sample */
  xLabels?: [string, string];
  /** value label drawn next to the marker */
  markerLabel?: string;
}

const PAD = { l: 2, r: 2, t: 8, b: 4 };

function extent(values: ArrayLike<number>): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return [0, 1];
  if (hi - lo < 1e-9) return [lo - 1, hi + 1];
  return [lo, hi];
}

function gridLines(g: CanvasRenderingContext2D, w: number, h: number, n: number, pad: SeriesOpts['pad'] & object): void {
  g.strokeStyle = cssVar('--line', 'rgba(17,18,20,.1)');
  g.lineWidth = 1;
  g.setLineDash([2, 3]);
  for (let k = 0; k <= n; k++) {
    const y = Math.round(pad.t + ((h - pad.t - pad.b) * k) / n) + 0.5;
    g.beginPath();
    g.moveTo(pad.l, y);
    g.lineTo(w - pad.r, y);
    g.stroke();
  }
  g.setLineDash([]);
}

/** Area/line chart with a vertical gradient fill and optional current-value marker. */
export function drawArea(g: CanvasRenderingContext2D, w: number, h: number, values: ArrayLike<number>, o: SeriesOpts = {}): void {
  const n = values.length;
  if (n < 2) return;
  const pad = o.pad ?? (o.xLabels ? { ...PAD, b: 16 } : PAD);
  const color = o.color ?? cssVar('--ink');
  let [lo, hi] = extent(values);
  // add 8% headroom so the curve never kisses the frame
  const span = hi - lo;
  lo = o.min ?? lo - span * 0.08;
  hi = o.max ?? hi + span * 0.08;
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;
  const X = (i: number) => pad.l + (i / (n - 1)) * iw;
  const Y = (v: number) => pad.t + ih - ((v - lo) / (hi - lo)) * ih;

  if (o.grid) gridLines(g, w, h, o.grid, pad);

  g.beginPath();
  g.moveTo(X(0), Y(values[0]));
  for (let i = 1; i < n; i++) g.lineTo(X(i), Y(values[i]));
  if (o.fill !== false) {
    g.save();
    g.lineTo(X(n - 1), pad.t + ih);
    g.lineTo(X(0), pad.t + ih);
    g.closePath();
    const grad = g.createLinearGradient(0, pad.t, 0, pad.t + ih);
    grad.addColorStop(0, withAlpha(color, 0.28));
    grad.addColorStop(1, withAlpha(color, 0.02));
    g.fillStyle = grad;
    g.fill();
    g.restore();
    g.beginPath();
    g.moveTo(X(0), Y(values[0]));
    for (let i = 1; i < n; i++) g.lineTo(X(i), Y(values[i]));
  }
  g.strokeStyle = color;
  g.lineWidth = o.lineWidth ?? 1.5;
  g.lineJoin = 'round';
  if (o.dashed) g.setLineDash([4, 3]);
  g.stroke();
  g.setLineDash([]);

  if (o.xLabels) {
    g.fillStyle = cssVar('--ink-3');
    g.font = `500 9px ${cssVar('--font-mono', 'monospace')}`;
    g.textBaseline = 'bottom';
    g.textAlign = 'left';
    g.fillText(o.xLabels[0], pad.l, h - 1);
    g.textAlign = 'right';
    g.fillText(o.xLabels[1], w - pad.r, h - 1);
  }

  if (o.marker !== undefined) marker(g, values, o.marker, X, Y, pad.t, pad.t + ih, o.markerLabel);
}

function marker(
  g: CanvasRenderingContext2D,
  values: ArrayLike<number>,
  m: number,
  X: (i: number) => number,
  Y: (v: number) => number,
  top: number,
  bottom: number,
  label?: string,
): void {
  const n = values.length;
  const mi = Math.max(0, Math.min(n - 1, m));
  const i0 = Math.floor(mi);
  const i1 = Math.min(n - 1, i0 + 1);
  const v = values[i0] + (values[i1] - values[i0]) * (mi - i0);
  const x = Math.round(X(mi)) + 0.5;
  const y = Y(v);
  const live = cssVar('--live');
  g.strokeStyle = withAlpha(live, 0.55);
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x, top);
  g.lineTo(x, bottom);
  g.stroke();
  g.fillStyle = '#fff';
  g.strokeStyle = live;
  g.lineWidth = 2;
  g.beginPath();
  g.arc(x, y, 3.5, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  if (label) {
    g.font = `600 10px ${cssVar('--font-mono', 'monospace')}`;
    const tw = g.measureText(label).width + 10;
    const right = x + tw + 8 > X(n - 1);
    const bx = right ? x - tw - 6 : x + 6;
    const by = Math.max(top, y - 22);
    g.fillStyle = cssVar('--ink');
    g.beginPath();
    g.roundRect(bx, by, tw, 16, 3);
    g.fill();
    g.fillStyle = '#fff';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText(label, bx + 5, by + 8.5);
  }
}

export interface LineSeries {
  values: ArrayLike<number>;
  color: string;
  dashed?: boolean;
  width?: number;
  fill?: boolean;
}

/** Several series on a shared scale (first series gets the marker). */
export function drawLines(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  series: LineSeries[],
  o: { marker?: number; grid?: number; xLabels?: [string, string]; markerLabel?: string } = {},
): void {
  if (!series.length) return;
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) {
    const [a, b] = extent(s.values);
    lo = Math.min(lo, a);
    hi = Math.max(hi, b);
  }
  const span = hi - lo || 1;
  lo -= span * 0.1;
  hi += span * 0.1;
  // paint back-to-front so the primary series sits on top
  for (let k = series.length - 1; k >= 0; k--) {
    const s = series[k];
    drawArea(g, w, h, s.values, {
      color: s.color,
      min: lo,
      max: hi,
      fill: s.fill ?? k === 0,
      dashed: s.dashed,
      lineWidth: s.width,
      grid: k === series.length - 1 ? o.grid : undefined,
      xLabels: k === 0 ? o.xLabels : undefined,
      pad: o.xLabels ? { ...PAD, b: 16 } : PAD,
      marker: k === 0 ? o.marker : undefined,
      markerLabel: k === 0 ? o.markerLabel : undefined,
    });
  }
}

/** Vertical-bar histogram; `highlight` (0..1) tints the bin under that normalized value. */
export function drawHistogram(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  bins: ArrayLike<number>,
  o: { color?: string; highlight?: number; ramp?: string[] } = {},
): void {
  const n = bins.length;
  if (!n) return;
  let max = 0;
  for (let i = 0; i < n; i++) max = Math.max(max, bins[i]);
  if (!max) return;
  const gap = 2;
  const bw = (w - gap * (n - 1)) / n;
  const hb = o.highlight !== undefined ? Math.min(n - 1, Math.floor(o.highlight * n)) : -1;
  const ramp = o.ramp;
  for (let i = 0; i < n; i++) {
    const bh = Math.max(1, (bins[i] / max) * (h - 2));
    const x = i * (bw + gap);
    if (ramp) g.fillStyle = ramp[Math.min(ramp.length - 1, Math.floor((i / n) * ramp.length))];
    else g.fillStyle = o.color ?? cssVar('--ink-2');
    g.globalAlpha = hb < 0 || i === hb ? 1 : 0.55;
    g.fillRect(x, h - bh, bw, bh);
  }
  g.globalAlpha = 1;
  g.fillStyle = cssVar('--line-2');
  g.fillRect(0, h - 1, w, 1);
}

/** Tiny unlabeled trend line. */
export function drawSparkline(g: CanvasRenderingContext2D, w: number, h: number, values: ArrayLike<number>, color?: string): void {
  drawArea(g, w, h, values, { color: color ?? cssVar('--ink'), lineWidth: 1.25, pad: { l: 1, r: 3, t: 3, b: 2 } });
}

/** 220° arc gauge 0..1 coloured ok → warn → risk, with a needle and a centred mono readout. */
export function drawGauge(g: CanvasRenderingContext2D, w: number, h: number, value: number, label: string): void {
  const cx = w / 2;
  const cy = h * 0.62;
  const r = Math.min(w / 2, h * 0.62) - 6;
  // canvas angles grow clockwise (y down): start slightly below the left horizon (0.89π),
  // sweep over the top and end slightly below the right horizon (2.11π).
  const a0 = Math.PI * 0.89;
  const sweep = Math.PI * 1.22;
  const v = Math.max(0, Math.min(1, value));
  g.lineCap = 'round';
  g.lineWidth = 6;
  g.strokeStyle = cssVar('--paper-2', '#e8e7e2');
  g.beginPath();
  g.arc(cx, cy, r, a0, a0 + sweep);
  g.stroke();
  const grad = g.createLinearGradient(cx - r, 0, cx + r, 0);
  grad.addColorStop(0, cssVar('--ok'));
  grad.addColorStop(0.5, cssVar('--warn'));
  grad.addColorStop(1, cssVar('--risk'));
  g.strokeStyle = grad;
  g.beginPath();
  g.arc(cx, cy, r, a0, a0 + sweep * Math.max(0.005, v));
  g.stroke();
  // ticks
  g.lineCap = 'butt';
  g.lineWidth = 1;
  g.strokeStyle = cssVar('--ink-4');
  for (let k = 0; k <= 10; k++) {
    const a = a0 + (sweep * k) / 10;
    const r1 = r - 9;
    const r2 = r - (k % 5 === 0 ? 14 : 11);
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
    g.stroke();
  }
  // needle
  const an = a0 + sweep * v;
  g.strokeStyle = cssVar('--ink');
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(cx, cy);
  g.lineTo(cx + Math.cos(an) * (r - 16), cy + Math.sin(an) * (r - 16));
  g.stroke();
  g.fillStyle = cssVar('--ink');
  g.beginPath();
  g.arc(cx, cy, 3, 0, Math.PI * 2);
  g.fill();
  g.font = `600 13px ${cssVar('--font-mono', 'monospace')}`;
  g.textAlign = 'center';
  g.textBaseline = 'top';
  g.fillText(label, cx, cy + 9);
}
