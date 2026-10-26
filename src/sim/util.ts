/**
 * Small numeric / raster / text helpers shared by the MVIA simulation modules.
 * Everything works on row-major grids (index = j * cols + i).
 */

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
/** logistic sigmoid */
export const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

// ───────────────────────────── rasters ─────────────────────────────

/**
 * Two-pass chamfer distance transform (weights 1 / √2), result in world units.
 * Cells with mask≠0 are sources. `fallback` is written when there are no sources at all.
 */
export function distanceTransform(mask: Uint8Array, cols: number, rows: number, cellSize: number, out: Float32Array, fallback = 1e4): void {
  const INF = 1e9;
  const D = Math.SQRT2;
  const n = cols * rows;
  let any = false;
  for (let k = 0; k < n; k++) {
    if (mask[k]) {
      out[k] = 0;
      any = true;
    } else out[k] = INF;
  }
  if (!any) {
    out.fill(fallback);
    return;
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      let v = out[k];
      if (i > 0 && out[k - 1] + 1 < v) v = out[k - 1] + 1;
      if (j > 0) {
        const u = k - cols;
        if (out[u] + 1 < v) v = out[u] + 1;
        if (i > 0 && out[u - 1] + D < v) v = out[u - 1] + D;
        if (i < cols - 1 && out[u + 1] + D < v) v = out[u + 1] + D;
      }
      out[k] = v;
    }
  }
  for (let j = rows - 1; j >= 0; j--) {
    for (let i = cols - 1; i >= 0; i--) {
      const k = j * cols + i;
      let v = out[k];
      if (i < cols - 1 && out[k + 1] + 1 < v) v = out[k + 1] + 1;
      if (j < rows - 1) {
        const d = k + cols;
        if (out[d] + 1 < v) v = out[d] + 1;
        if (i < cols - 1 && out[d + 1] + D < v) v = out[d + 1] + D;
        if (i > 0 && out[d - 1] + D < v) v = out[d - 1] + D;
      }
      out[k] = v * cellSize;
    }
  }
}

/** Summed-area table with a zero border: sat has (cols+1)*(rows+1) entries. */
export function buildSAT(src: ArrayLike<number>, cols: number, rows: number, sat: Float64Array): void {
  const w = cols + 1;
  for (let i = 0; i <= cols; i++) sat[i] = 0;
  for (let j = 0; j < rows; j++) {
    let rowSum = 0;
    const o = (j + 1) * w;
    sat[o] = 0;
    for (let i = 0; i < cols; i++) {
      rowSum += src[j * cols + i];
      sat[o + i + 1] = sat[o - w + i + 1] + rowSum;
    }
  }
}

/** Sum of the (2R+1)² box centred on (i,j), clipped to the grid. O(1). */
export function boxSum(sat: Float64Array, cols: number, rows: number, i: number, j: number, R: number): number {
  const w = cols + 1;
  const i0 = i - R < 0 ? 0 : i - R;
  const j0 = j - R < 0 ? 0 : j - R;
  const i1 = i + R + 1 > cols ? cols : i + R + 1;
  const j1 = j + R + 1 > rows ? rows : j + R + 1;
  return sat[j1 * w + i1] - sat[j0 * w + i1] - sat[j1 * w + i0] + sat[j0 * w + i0];
}

/** Number of cells in the clipped box (for means). */
export function boxCount(cols: number, rows: number, i: number, j: number, R: number): number {
  const i0 = Math.max(0, i - R);
  const j0 = Math.max(0, j - R);
  const i1 = Math.min(cols, i + R + 1);
  const j1 = Math.min(rows, j + R + 1);
  return (i1 - i0) * (j1 - j0);
}

// ───────────────────────────── text ─────────────────────────────

/** lower-case, accent-free, punctuation-free */
export function normText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP = new Set([
  'la', 'las', 'el', 'los', 'de', 'del', 'y', 'en', 'col', 'colonia', 'fracc', 'fraccionamiento', 'zona', 'sector',
  'barrio', 'unidad', 'habitacional', 'a', 'al', 'que', 'cuanto', 'cuanta', 'donde', 'como', 'vale', 'valor', 'precio',
  'mi', 'me', 'por', 'para', 'con', 'lo', 'un', 'una', 'es', 'esta', 'hay', 'san', 'santa', 'xalapa', 'veracruz',
]);

export function tokens(s: string): string[] {
  return normText(s)
    .split(' ')
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

/** Levenshtein distance with an early-exit bound (returns bound+1 when exceeded). */
export function levenshtein(a: string, b: string, bound = 99): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > bound) return bound + 1;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > bound) return bound + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** Similarity 0..1 of a free-text query against a place name. */
export function matchScore(query: string, name: string): number {
  const q = normText(query);
  const nm = normText(name);
  if (!q || !nm) return 0;
  if (q === nm) return 1;
  // whole name inside the query ("cuanto vale el suelo en las animas") — word-bounded
  if (` ${q} `.includes(` ${nm} `)) return 0.95 + Math.min(0.04, nm.length / 1000);
  if (q.length >= 3 && nm.includes(q)) return 0.86;
  const nt = tokens(name);
  const qt = tokens(query);
  let best = 0;
  if (nt.length && qt.length) {
    let matched = 0;
    for (const t of nt) {
      const tol = t.length >= 7 ? 2 : t.length >= 4 ? 1 : 0;
      if (qt.some((u) => u === t || (tol > 0 && levenshtein(u, t, tol) <= tol))) matched++;
    }
    if (matched) best = 0.5 + 0.32 * (matched / nt.length);
  }
  // whole-string typo tolerance ("animaz", "coapexpam")
  const maxLen = Math.max(q.length, nm.length);
  if (maxLen <= 24) {
    const d = levenshtein(q, nm, 4);
    if (d <= 4) best = Math.max(best, (1 - d / maxLen) * 0.85);
  }
  return best;
}

// ───────────────────────────── formatting ─────────────────────────────
const MXN0 = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
/** "$14,250" */
export const money = (v: number): string => MXN0.format(Math.round(v));
export const km = (worldUnits: number): string => `${(worldUnits / 100).toFixed(1)} km`;
export const metres = (worldUnits: number): string =>
  worldUnits >= 100 ? km(worldUnits) : `${Math.round(worldUnits) * 10} m`;
