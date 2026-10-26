/**
 * Text utilities for speech: normalisation of MVIA/markdown text into something a TTS voice reads
 * naturally in es-MX, sentence chunking (Chrome cuts utterances after ~15 s) and a deterministic
 * pseudo-waveform derived from the text for the visualiser.
 */

const ABBREVIATIONS = new Set([
  'av', 'sr', 'sra', 'srta', 'dr', 'dra', 'lic', 'ing', 'arq', 'col', 'no', 'núm', 'num', 'blvd', 'carr', 'km', 'ej', 'aprox', 'etc', 'p', 'pág', 'ver', 'mx', 'cd', 'fracc', 'prol', 'mtro', 'mtra',
]);

/** Spanish spoken form of a magnitude: 612345 → "612 mil", 1.8e6 → "1.8 millones". */
export function spokenNumber(v: number, decimals = 1): string {
  const a = Math.abs(v);
  const f = (x: number, d: number) => x.toLocaleString('es-MX', { maximumFractionDigits: d });
  if (a >= 1e9) return `${f(v / 1e9, decimals)} mil millones`;
  if (a >= 1e6) return `${f(v / 1e6, decimals)} ${Math.abs(v / 1e6) < 1.05 ? 'millón' : 'millones'}`;
  if (a >= 1e4) return `${f(v / 1e3, 0)} mil`;
  return f(v, a < 10 ? decimals : 0);
}

/** "1.8 millones de pesos", "6,850 pesos" */
export function spokenMoney(v: number): string {
  const s = spokenNumber(v, 1);
  return /mill/.test(s) ? `${s} de pesos` : `${s} pesos`;
}

export function spokenPct(v: number, d = 1): string {
  return `${v.toLocaleString('es-MX', { maximumFractionDigits: d })} por ciento`;
}

const MONEY_SUFFIX: Record<string, string> = { mmd: 'mil millones de pesos', m: 'millones de pesos', k: 'mil pesos' };

/** Makes arbitrary MVIA text (chat markdown, fmtMXN output, units) pleasant to hear. */
export function toSpeakable(input: string): string {
  let t = input;
  t = t.replace(/```[\s\S]*?```/g, ' ');
  t = t.replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1'); // markdown links
  t = t.replace(/https?:\/\/\S+/g, ' ');
  t = t.replace(/[*_`#>]+/g, '');
  t = t.replace(/^\s*(?:[-•▸▪◦]|\d+[.)])\s+/gm, ''); // list bullets
  t = t.replace(/\p{Extended_Pictographic}/gu, '');
  // fmtMXN: "$1.23 M", "$12.3k", "$1.20 mmd"
  t = t.replace(/\$\s?([\d.,]+)\s?(mmd|M|k)\b(?:\s*MXN\b)?/g, (_, n: string, s: string) => `${n} ${MONEY_SUFFIX[s.toLowerCase()]}`);
  t = t.replace(/\$\s?([\d.,]+)(?:\s*MXN\b)?/g, '$1 pesos');
  t = t.replace(/\bMXN\s*\/\s*m(?:²|2)(?![\p{L}\p{N}])/gu, 'pesos por metro cuadrado');
  t = t.replace(/\bMXN\b/g, 'pesos');
  t = t.replace(/\/\s*m(?:²|2)(?![\p{L}\p{N}])/gu, ' por metro cuadrado');
  t = t.replace(/(\d)\s*km(?:²|2)(?![\p{L}\p{N}])/gu, '$1 kilómetros cuadrados');
  t = t.replace(/(\d)\s*m(?:²|2)(?![\p{L}\p{N}])/gu, '$1 metros cuadrados');
  t = t.replace(/(\d)\s*ha\b/g, '$1 hectáreas');
  t = t.replace(/(\d)\s*km\/h\b/g, '$1 kilómetros por hora');
  t = t.replace(/(\d)\s*msnm\b/g, '$1 metros sobre el nivel del mar');
  t = t.replace(/(\d)\s*%/g, '$1 por ciento');
  t = t.replace(/\bCAT\b/g, 'C A T');
  t = t.replace(/\bMVIA\b/g, 'Emvía');
  t = t.replace(/\s*[·|]\s*/g, ', ');
  t = t.replace(/\s*(?:→|->|—|–)\s*/g, ', ');
  t = t.replace(/↔/g, ' a ');
  // a line break that does not end a sentence becomes a soft stop
  t = t.replace(/([^\s.!?:;,])\s*\n+/g, '$1. ');
  t = t.replace(/\s+/g, ' ');
  t = t.replace(/\s+([,.;:!?])/g, '$1').replace(/([,;:])(?:\s*[,;:])+/g, '$1');
  return t.trim();
}

export interface Chunk {
  text: string;
  /** offsets into the normalised full text */
  start: number;
  end: number;
  /** terminal punctuation: drives pitch spread & pause length */
  terminal: '.' | '?' | '!' | ',' | '';
}

function isSentenceEnd(t: string, i: number): boolean {
  const c = t[i];
  if (c !== '.' && c !== '!' && c !== '?' && c !== '…') return false;
  const next = t[i + 1];
  if (next !== undefined && !/[\s"'”»)\]]/.test(next)) return false; // "3.5", "x.com"
  if (c === '.') {
    const m = /([\p{L}]+)$/u.exec(t.slice(Math.max(0, i - 8), i));
    if (m && ABBREVIATIONS.has(m[1].toLowerCase())) return false;
  }
  return true;
}

function terminalOf(s: string): Chunk['terminal'] {
  const m = /([.?!,;:…])["'”»)\]]*\s*$/.exec(s);
  if (!m) return '';
  const c = m[1];
  if (c === '?' || c === '!') return c;
  if (c === ',' || c === ';' || c === ':') return ',';
  return '.';
}

/** Split at the last good break (clause punctuation, else whitespace) at or before `max`. */
function hardSplit(s: string, max: number): [string, string] {
  const window = s.slice(0, max);
  let cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '));
  if (cut < max * 0.4) cut = window.lastIndexOf(' ');
  if (cut <= 0) cut = max;
  else cut += 1;
  return [s.slice(0, cut), s.slice(cut)];
}

/**
 * Sentence chunker. Every chunk ≤ maxLen chars; with `clauses` long sentences are also split at commas
 * so the engine can insert stylistic pauses.
 */
export function chunkText(text: string, maxLen = 220, clauses = false): Chunk[] {
  const out: Chunk[] = [];
  const push = (raw: string, start: number) => {
    const lead = raw.length - raw.trimStart().length;
    const s = raw.trim();
    if (!s || !/[\p{L}\p{N}]/u.test(s)) return;
    out.push({ text: s, start: start + lead, end: start + lead + s.length, terminal: terminalOf(s) });
  };

  const emitSentence = (sentence: string, start: number) => {
    let rest = sentence;
    let off = start;
    if (clauses && sentence.trim().length > 70) {
      // split at clause marks, merging tiny clauses so we never get "Sí," alone
      const re = /[,;:]\s+/g;
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sentence))) {
        const end = m.index + 1;
        if (end - last >= 28 && sentence.length - end >= 20) {
          emitSentence(sentence.slice(last, end), start + last); // recursion terminates: slice ≤ 70 or no further commas pass the guard
          last = end;
        }
      }
      if (last > 0) {
        rest = sentence.slice(last);
        off = start + last;
        if (rest.trim().length <= 70 || !/[,;:]\s/.test(rest)) {
          while (rest.length > maxLen) {
            const [a, b] = hardSplit(rest, maxLen);
            push(a, off);
            off += a.length;
            rest = b;
          }
          push(rest, off);
          return;
        }
      }
    }
    while (rest.length > maxLen) {
      const [a, b] = hardSplit(rest, maxLen);
      push(a, off);
      off += a.length;
      rest = b;
    }
    push(rest, off);
  };

  let s0 = 0;
  for (let i = 0; i < text.length; i++) {
    if (isSentenceEnd(text, i)) {
      // swallow closing quotes / repeated punctuation ("?!", "...")
      let j = i + 1;
      while (j < text.length && /[.!?…"'”»)\]]/.test(text[j])) j++;
      emitSentence(text.slice(s0, j), s0);
      s0 = j;
      i = j - 1;
    }
  }
  if (s0 < text.length) emitSentence(text.slice(s0), s0);
  return out;
}

/** Cheap string hash → seed */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Deterministic speech-like amplitude profile for `text` sampled into `n` bars (0..1).
 * Vowels peak, consonant clusters dip, spaces make micro-gaps and punctuation makes real pauses,
 * then a 3-tap blur gives the soft envelope of recorded speech.
 */
export function textPeaks(text: string, n: number, out = new Float32Array(n)): Float32Array {
  const len = Math.max(1, text.length);
  let seed = hash(text) || 1;
  const rand = () => ((seed = Math.imul(seed ^ (seed >>> 15), 2246822507) >>> 0), (seed & 0xffff) / 0xffff);
  const raw = new Float32Array(n);
  for (let b = 0; b < n; b++) {
    const a = Math.floor((b / n) * len);
    const z = Math.max(a + 1, Math.floor(((b + 1) / n) * len));
    let acc = 0;
    let cnt = 0;
    for (let i = a; i < z && i < len; i++) {
      const c = text[i].toLowerCase();
      let v: number;
      if ('aeiouáéíóúü'.includes(c)) v = 0.95;
      else if (c === ' ') v = 0.32;
      else if (',;:'.includes(c)) v = 0.08;
      else if ('.!?…'.includes(c)) v = 0.02;
      else if ('mnlrñy'.includes(c)) v = 0.7;
      else if (/[\p{L}\p{N}]/u.test(c)) v = 0.5;
      else v = 0.25;
      acc += v;
      cnt++;
    }
    raw[b] = cnt ? acc / cnt : 0.3;
  }
  for (let b = 0; b < n; b++) {
    const l = raw[Math.max(0, b - 1)];
    const r = raw[Math.min(n - 1, b + 1)];
    const v = (l + raw[b] * 2 + r) / 4;
    out[b] = Math.min(1, Math.max(0.04, v * (0.72 + rand() * 0.46)));
  }
  // gentle fade-in/out at clip edges
  for (let b = 0; b < Math.min(4, n); b++) {
    out[b] *= 0.45 + b * 0.14;
    out[n - 1 - b] *= 0.45 + b * 0.14;
  }
  return out;
}

export function excerpt(text: string, max = 90): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

export function fmtClock(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`;
}
