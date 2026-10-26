/**
 * Tiny DOM toolkit for the HUD: element factory, change-aware writers (so per-frame / per-tick updates
 * never touch the DOM when nothing changed), formatting helpers and the verdict palette.
 */
import type { Verdict, Vec2 } from '../core/types';

type Attrs = Record<string, string | number | boolean | undefined>;

/** createElement with class, attributes and either children nodes or trusted static markup. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = '',
  attrs?: Attrs | null,
  children?: Array<Node | string> | string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v === undefined || v === false) continue;
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  if (typeof children === 'string') el.innerHTML = children;
  else if (children) el.append(...children);
  return el;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** HTML-escape dynamic text before it goes into a template string. */
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]);

const textCache = new WeakMap<Node, string>();
/** textContent writer that is a no-op when the value did not change. */
export function setText(el: HTMLElement, v: string): void {
  if (textCache.get(el) === v) return;
  textCache.set(el, v);
  el.textContent = v;
}

const htmlCache = new WeakMap<Node, string>();
/** innerHTML writer that is a no-op when the markup did not change (used for small lists only). */
export function setHTML(el: HTMLElement, v: string): boolean {
  if (htmlCache.get(el) === v) return false;
  htmlCache.set(el, v);
  el.innerHTML = v;
  return true;
}

const styleCache = new WeakMap<HTMLElement, Map<string, string>>();
/** style property / custom property writer with change detection. */
export function setStyle(el: HTMLElement, prop: string, v: string): void {
  let m = styleCache.get(el);
  if (!m) styleCache.set(el, (m = new Map()));
  if (m.get(prop) === v) return;
  m.set(prop, v);
  el.style.setProperty(prop, v);
}

export function qs<T extends HTMLElement = HTMLElement>(root: ParentNode, sel: string): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`[ui] missing ${sel}`);
  return el;
}

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Trailing-edge throttle: runs at most once every `ms`, always delivering the last call. */
export function throttle<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let last = 0;
  let timer = 0;
  let pending: A | null = null;
  return (...a: A) => {
    const now = performance.now();
    const wait = ms - (now - last);
    if (wait <= 0 && !timer) {
      last = now;
      fn(...a);
      return;
    }
    pending = a;
    if (!timer) {
      timer = window.setTimeout(() => {
        timer = 0;
        last = performance.now();
        const p = pending;
        pending = null;
        if (p) fn(...p);
      }, Math.max(0, wait));
    }
  };
}

// ───────────── formatting (es-MX) ─────────────
const mxn0 = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 0, maximumFractionDigits: 0 });
const num1 = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const num0 = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 });

/** full currency "$2,450,000" */
export const money = (v: number): string => mxn0.format(Number.isFinite(v) ? v : 0);
export const n1 = (v: number): string => num1.format(Number.isFinite(v) ? v : 0);
export const n0 = (v: number): string => num0.format(Number.isFinite(v) ? v : 0);
export const signed = (v: number, d = 1): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`;

/** "Fraccionamiento Las Ánimas" → "Las Ánimas"; used for compact tags. */
export function shortName(name: string): string {
  return name
    .replace(/^(Col\.?|Colonia|Fracc\.?|Fraccionamiento|Unidad Habitacional|U\.H\.|Barrio|Zona|Residencial)\s+/i, '')
    .trim();
}

export function cellCode(index: number, cols: number): string {
  const i = index % cols;
  const j = Math.floor(index / cols);
  return `${String(j).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
}

export const dist2 = (a: Vec2, x: number, z: number): number => (a.x - x) * (a.x - x) + (a.z - z) * (a.z - z);

// ───────────── verdict palette ─────────────
export interface VerdictStyle {
  label: string;
  color: string; // css colour (var)
  ink: string; // readable text colour on top of `color`
}

export const VERDICTS: Record<Verdict, VerdictStyle> = {
  viable: { label: 'VIABLE', color: 'var(--ok)', ink: 'var(--ok-ink)' },
  observar: { label: 'OBSERVAR', color: 'var(--note)', ink: '#06233d' },
  precaucion: { label: 'PRECAUCIÓN', color: 'var(--warn)', ink: '#3a2804' },
  riesgo: { label: 'RIESGO', color: 'var(--risk)', ink: '#ffffff' },
};

/** Reads a CSS custom property from :root (cached; tokens are static). */
const varCache = new Map<string, string>();
export function cssVar(name: string, fallback = '#111'): string {
  let v = varCache.get(name);
  if (v === undefined) {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
    varCache.set(name, v);
  }
  return v;
}

/** "#rrggbb" (or rgb/rgba) + alpha → rgba() */
export function withAlpha(color: string, a: number): string {
  const c = color.trim();
  if (c.startsWith('#')) {
    let hex = c.slice(1);
    if (hex.length === 3) hex = hex.replace(/./g, (ch) => ch + ch);
    const n = parseInt(hex.slice(0, 6), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b] = m[1].split(',').map((s) => parseFloat(s));
    return `rgba(${r},${g},${b},${a})`;
  }
  return c;
}

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}
