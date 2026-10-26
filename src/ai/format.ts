/** Number formatting for chat text + conversion of chat markdown into speakable Spanish. */
import { fmtMXN } from '../core/geo';
import type { Verdict } from '../core/types';

const MXN0 = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0, minimumFractionDigits: 0 });
const INT = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 });

/** $12,400 (exact, es-MX) */
export const mxn = (v: number): string => MXN0.format(Math.round(v)).replace('MX$', '$');
/** $12,400 below a million, $2.45 M / $1.20 mmd above */
export const mxnBig = (v: number): string => (Math.abs(v) >= 1e6 ? fmtMXN(v) : mxn(v));
export const int = (v: number): string => INT.format(Math.round(v));
export const pct = (v: number, d = 1): string => `${v.toFixed(d)}%`;
export const dec = (v: number, d = 1): string => v.toFixed(d);

export function riskLabel(r: number): string {
  return r < 0.25 ? 'bajo' : r < 0.45 ? 'moderado' : r < 0.65 ? 'alto' : 'muy alto';
}

export function demandLabel(d: number): string {
  return d < 0.3 ? 'baja' : d < 0.55 ? 'media' : d < 0.75 ? 'alta' : 'muy alta';
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  viable: 'VIABLE',
  observar: 'OBSERVAR',
  precaucion: 'PRECAUCIÓN',
  riesgo: 'RIESGO',
};

export const VERDICT_TEXT: Record<Verdict, string> = {
  viable: 'viable',
  observar: 'en observación',
  precaucion: 'de precaución',
  riesgo: 'de riesgo',
};

/** 8-point compass from a world-space direction (+x east, -z north) */
export function compass(dx: number, dz: number): string {
  const deg = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
  const names = ['norte', 'noreste', 'oriente', 'sureste', 'sur', 'suroeste', 'poniente', 'noroeste'];
  return names[Math.round(deg / 45) % 8];
}

// ───────────────────────────── speech ─────────────────────────────
/** 12400 → "12 mil 400"; 2_500_000 → "2 millones 500 mil" (digits left for the TTS to read naturally) */
export function numToSpeech(n: number): string {
  n = Math.round(n);
  if (n < 1000) return String(n);
  const parts: string[] = [];
  const milMill = Math.floor(n / 1e9);
  const mill = Math.floor((n % 1e9) / 1e6);
  const th = Math.floor((n % 1e6) / 1e3);
  const u = n % 1000;
  if (milMill) parts.push(`${milMill === 1 ? 'mil' : `${milMill} mil`}${mill ? '' : ' millones'}`);
  if (mill) parts.push(mill === 1 && !milMill ? 'un millón' : `${mill} millones`);
  if (th) parts.push(th === 1 ? 'mil' : `${th} mil`);
  if (u) parts.push(String(u));
  return parts.join(' ');
}

/** round to 3 significant digits so long amounts sound natural */
function sig3(v: number): number {
  if (v < 1000) return Math.round(v);
  const p = Math.pow(10, Math.floor(Math.log10(v)) - 2);
  return Math.round(v / p) * p;
}

function moneyToSpeech(v: number): string {
  const r = sig3(v);
  const words = numToSpeech(r);
  // "2 millones de pesos" but "2 millones 500 mil pesos"
  return /millones$|millón$/.test(words) ? `${words} de pesos` : `${words} pesos`;
}

const decimalSpeech = (s: string): string => s.replace(/(\d+)\.(\d+)/g, '$1 punto $2');

export function stripMarkdown(md: string): string {
  return md
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*(?:[-•]|\d+\.)\s+/gm, '')
    .trim();
}

/** "**Las Ánimas** cotiza en $12,400/m²" → "Las Ánimas cotiza en 12 mil 400 pesos por metro cuadrado" */
export function toSpeech(md: string): string {
  let s = md
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*(?:[-•]|\d+\.)\s+(.*)$/gm, '$1.')
    .replace(/\n+/g, ' ');

  s = s.replace(/\$\s?(\d[\d,]*(?:\.\d+)?)(?:\s?(mmd|M|k)\b)?(\s?\/\s?m²)?/g, (_m, num: string, unit: string | undefined, perM2: string | undefined) => {
    const base = Number(num.replace(/,/g, ''));
    const mult = unit === 'mmd' ? 1e9 : unit === 'M' ? 1e6 : unit === 'k' ? 1e3 : 1;
    return moneyToSpeech(base * mult) + (perM2 ? ' por metro cuadrado' : '');
  });

  s = s
    .replace(/(\d+(?:\.\d+)?)\s?%/g, (_m, n: string) => `${decimalSpeech(n)} por ciento`)
    .replace(/km²/g, ' kilómetros cuadrados')
    .replace(/m²/g, ' metros cuadrados')
    .replace(/(\d)\s?ha\b/g, '$1 hectáreas')
    .replace(/(\d)\s?msnm\b/g, '$1 metros sobre el nivel del mar')
    .replace(/\/\s?día/g, ' al día')
    .replace(/\/100\b/g, ' de 100')
    .replace(/(\d)\s?×/g, '$1 veces')
    .replace(/\bvs\.?\b/gi, 'contra')
    .replace(/\bCAT\b/g, 'C A T')
    .replace(/\bROI\b/g, 'retorno')
    .replace(/\bLTV\b/g, 'aforo')
    .replace(/[·|]/g, ', ')
    .replace(/→/g, ' a ')
    .replace(/≈/g, 'aproximadamente ')
    .replace(/±/g, 'más menos ');

  // remaining grouped integers (23,520) and decimals (4.5)
  s = s.replace(/\d{1,3}(?:,\d{3})+/g, (m) => numToSpeech(Number(m.replace(/,/g, ''))));
  s = decimalSpeech(s);
  return s.replace(/\s+/g, ' ').replace(/\s+([.,])/g, '$1').trim();
}
