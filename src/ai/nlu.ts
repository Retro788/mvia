/**
 * MVIA local NLU: normalisation, tokenisation and entity extraction (no network, no model files).
 * Everything works on an accent-free lowercase string so "Ánimas", "animas" and "ANIMAS" are equal.
 */
import type { EstablishmentType, ISimulation, LayerId, MapStyle, ScenarioId } from '../core/types';
import { YEAR_END, YEAR_START } from '../core/geo';
import type { Entities, ZoneAttr } from './types';

export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/²/g, '2')
    .replace(/[¿¡!?;:"“”'«»()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(norm: string): string[] {
  return norm
    .replace(/[^a-z0-9ñ$%.,\s-]/g, ' ')
    .split(/[\s,]+/)
    .map((t) => t.replace(/^[.\-]+|[.\-]+$/g, ''))
    .filter(Boolean);
}

/** words never treated as place names on their own */
const STOP = new Set(
  (
    'el la los las un una unos unas de del al a en y o u que cual cuales como cuanto cuanta donde hacia ' +
    'por para con sin sobre entre vs versus contra me te se lo le les mi tu su sus es son esta este esto ' +
    'zona zonas colonia colonias barrio sector fraccionamiento xalapa ciudad mapa precio valor vale m2 metro ' +
    'cuadrado riesgo credito hipoteca muestra muestrame llevame ver ir vamos mas menos mayor menor mejor peor ' +
    'norte sur este oeste oriente poniente zona aqui ahi alli punto plaza tienda super casa casas ' +
    'simula escenario capa modo vista anos ano millones mil pesos'
  ).split(' '),
);

/** Damerau-free Levenshtein ratio 0..1 (small strings only) */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  let prev = new Array<number>(n + 1);
  let cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const c = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
    }
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[n] / Math.max(m, n);
}

// ───────────────────────────── vocabularies ─────────────────────────────
const ESTABLISHMENTS: Array<[RegExp, EstablishmentType]> = [
  [/\b(centros? comercial(es)?|mall|plaza comercial grande|galerias)\b/, 'centroComercial'],
  [/\b(supermercados?|super|walmart|soriana|chedraui|bodega aurrera|autoservicio)\b/, 'supermercado'],
  [/\bplazoletas?\b/, 'plazoleta'],
  [/\b(plazas? comercial(es)?|plazas?|strip mall)\b/, 'plaza'],
  [/\b(tiendas?|oxxo|abarrotes|minisuper|tiendita|local(es)?|negocio|comercio de barrio|farmacia)\b/, 'tienda'],
  [/\b(oficinas?|corporativo|coworking)\b/, 'oficinas'],
  [/\b(vivienda|viviendas|casas?|fraccionamientos?|departamentos?|deptos?|residencial|condominios?)\b/, 'vivienda'],
];

const SCENARIOS: Array<[RegExp, ScenarioId]> = [
  [/\b(descontrolad[oa]|sin control|caotic[oa]|dispers[oa]|expansion libre|desordenad[oa]|irregular)\b/, 'descontrolado'],
  [/\b(ordenad[oa]|planead[oa]|planificad[oa]|compact[oa]|sostenible|sustentable|controlad[oa]|regulad[oa])\b/, 'ordenado'],
  [/\b(tendencial|inercial|base|actual|business as usual|tendencia)\b/, 'tendencial'],
];

const LAYERS: Array<[RegExp, LayerId]> = [
  [/\b(sin capas?|quita(r)? (la )?capa|apaga(r)? (la )?capa|ninguna capa|limpia(r)? (el )?mapa|oculta(r)? (la )?capa)\b/, 'none'],
  [/\b(riesgo crediticio|riesgo de credito|morosidad|cartera vencida|impago|default)\b/, 'creditRisk'],
  [/\b(inundac\w*|inundable\w*|anegac\w*|flood|riesgo hidrico|encharca\w*)\b/, 'floodRisk'],
  [/\b(hipotecas?|tasas? hipotecaria\w*|tasa de interes)\b/, 'mortgage'],
  [/\b(demanda comercial|comercial(es)?|comercio|negocios)\b/, 'commercial'],
  [/\b(densidad|poblacion|habitantes|poblada)\b/, 'density'],
  [/\b(crecimiento|expansion|mancha urbana|urbanizacion)\b/, 'growth'],
  [/\b(valor(es)? del suelo|valor de suelo|precios?|plusvalia|valor catastral|valor(es)?|m2)\b/, 'landValue'],
];

const STYLES: Array<[RegExp, MapStyle]> = [
  [/\b(satelit\w*|satelital|aere[oa]|ortofoto|foto real)\b/, 'satellite'],
  [/\b(noche|nocturn[oa]|oscur[oa]|dark)\b/, 'night'],
  [/\b(scan|escaner|escaneo|lidar|maquina|machine|profundidad|depth)\b/, 'scan'],
  [/\b(clay|arcilla|maqueta|blanc[oa]|claro|normal|estandar|por defecto)\b/, 'clay'],
];

const ATTRS: Array<[RegExp, ZoneAttr]> = [
  [/\b(precio|valor|vale|cuesta|costo|m2|metro)\w*/, 'precio'],
  [/\b(riesgo crediticio|riesgo|morosidad|impago)\b/, 'riesgo'],
  [/\b(plusvalia|apreciacion|revaloriza\w*|rentabilidad|inversion|invertir)\b/, 'plusvalia'],
  [/\b(poblacion|habitantes|gente|personas)\b/, 'poblacion'],
  [/\b(comercio|comercial|demanda|negocio)\w*/, 'comercio'],
  [/\b(inundac\w*|inundable|lluvia|agua)\b/, 'inundacion'],
  [/\b(hipoteca|tasa|credito)\w*/, 'hipoteca'],
  [/\b(densidad|construido|urbanizad\w*)\b/, 'densidad'],
];

const PRODUCTS: Array<[RegExp, Entities['product'] & string]> = [
  [/\binfonavit\b/, 'infonavit'],
  [/\bfovissste\b/, 'fovissste'],
  [/\bcofinavit\b/, 'cofinavit'],
  [/\b(bancari[oa]|banco)\b/, 'bancario'],
];

function firstMatch<T>(norm: string, table: Array<[RegExp, T]>): T | null {
  for (const [re, v] of table) if (re.test(norm)) return v;
  return null;
}

// ───────────────────────────── numbers & money ─────────────────────────────
/** "2.5" | "2,5" (decimal) | "2,500,000" | "2.500.000" (thousands) → number */
export function parseNumber(s: string): number {
  const t = s.replace(/\s/g, '');
  if (/^\d{1,3}([.,]\d{3})+$/.test(t)) return Number(t.replace(/[.,]/g, ''));
  return Number(t.replace(',', '.'));
}

const NUM = String.raw`(\d+(?:[.,]\d+)*)`;
const MONEY_RES: Array<{ re: RegExp; mult: number }> = [
  { re: new RegExp(String.raw`\$?\s*${NUM}\s*(?:millones|millon|mdp|mm|m)(?![a-z0-9])`, 'g'), mult: 1e6 },
  { re: new RegExp(String.raw`\$?\s*${NUM}\s*(?:mil|k)(?![a-z0-9])`, 'g'), mult: 1e3 },
  { re: new RegExp(String.raw`\$\s*${NUM}`, 'g'), mult: 1 },
  { re: /(?<![\d.,])(\d{1,3}(?:,\d{3})+)(?![\d%])/g, mult: 1 },
];

function extractMoney(norm: string): number[] {
  const hits: Array<{ at: number; end: number; v: number }> = [];
  for (const { re, mult } of MONEY_RES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(norm))) {
      const at = m.index;
      const end = at + m[0].length;
      if (hits.some((h) => at < h.end && end > h.at)) continue; // overlaps a stronger match
      const v = parseNumber(m[1]) * mult;
      if (Number.isFinite(v) && v >= 1000) hits.push({ at, end, v });
    }
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.v);
}

function extractPercents(norm: string): number[] {
  const out: number[] = [];
  const re = /(\d+(?:[.,]\d+)?)\s*(?:%|por ciento|porciento)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm))) out.push(parseNumber(m[1]));
  return out;
}

function extractYears(norm: string): number[] {
  const out: number[] = [];
  const re = /(?<![\d$.,])(20\d\d)(?![\d.,]*\s*(?:mil|millones|k|%))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm))) {
    const y = Number(m[1]);
    if (y >= 2020 && y <= 2060) out.push(Math.min(YEAR_END, Math.max(YEAR_START, y)));
  }
  return out;
}

function extractPlazo(norm: string): number | null {
  const m = /(?:a|plazo de|en|por)?\s*(\d{1,2})\s*anos?\b/.exec(norm);
  if (!m) return null;
  const y = Number(m[1]);
  return y >= 1 && y <= 40 ? y : null;
}

// ───────────────────────────── places ─────────────────────────────
interface PlaceIndex {
  zones: Array<{ id: string; norm: string; keys: string[] }>;
  landmarks: Array<{ id: string; norm: string; keys: string[]; kind: string }>;
}

let cachedIndex: PlaceIndex | null = null;

/** significant tokens of a name: drop articles/generic words, keep ≥4 chars */
function keysOf(norm: string): string[] {
  const toks = norm.split(/[\s\-/.]+/).filter((t) => t.length >= 4 && !STOP.has(t));
  return toks;
}

function placeIndex(sim: ISimulation): PlaceIndex {
  if (cachedIndex) return cachedIndex;
  const zones = sim.mapData.zones.map((z) => {
    const n = normalize(z.name);
    return { id: z.id, norm: n, keys: keysOf(n) };
  });
  const landmarks = sim.mapData.landmarks.map((l) => {
    const n = normalize(l.name);
    return { id: l.id, norm: n, keys: keysOf(n), kind: l.kind };
  });
  cachedIndex = { zones, landmarks };
  return cachedIndex;
}

function findPlaces(
  norm: string,
  tokens: string[],
  list: Array<{ id: string; norm: string; keys: string[] }>,
): Array<{ id: string; at: number }> {
  const padded = ` ${norm} `;
  const hits: Array<{ id: string; at: number; score: number; claims: string[] }> = [];
  for (const p of list) {
    // 1) full name phrase — strongest evidence; longer names win ties
    const at = padded.indexOf(` ${p.norm} `);
    if (at >= 0) {
      hits.push({ id: p.id, at, score: 2 + p.norm.length / 100, claims: p.norm.split(' ').filter((t) => !STOP.has(t)) });
      continue;
    }
    // 2) significant keys matched exactly or fuzzily; score = share of the name's keys present
    const claims: string[] = [];
    let first = Infinity;
    for (const k of p.keys) {
      const tok = tokens.find((t) => t.length >= 4 && !STOP.has(t) && (t === k || (k.length >= 6 && similarity(t, k) >= 0.8)));
      if (tok) {
        claims.push(tok);
        const pos = norm.indexOf(tok);
        if (pos >= 0 && pos < first) first = pos;
      }
    }
    if (claims.length) hits.push({ id: p.id, at: first === Infinity ? 999 : first, score: claims.length / p.keys.length, claims });
  }
  // greedy resolution: best evidence first, each message word can name only one place
  hits.sort((a, b) => b.score - a.score);
  const used = new Set<string>();
  const out: Array<{ id: string; at: number }> = [];
  for (const h of hits) {
    if (h.claims.some((c) => used.has(c))) continue;
    h.claims.forEach((c) => used.add(c));
    out.push({ id: h.id, at: h.at });
  }
  return out.sort((a, b) => a.at - b.at);
}

const LANDMARK_KIND_WORDS: Array<[RegExp, string]> = [
  [/\bcatedral\b/, 'catedral'],
  [/\b(estadio|xalapeno)\b/, 'estadio'],
  [/\bmuseo\b/, 'museo'],
  [/\b(universidad|uv|campus)\b/, 'universidad'],
  [/\bhospital\b/, 'hospital'],
  [/\bmercado\b/, 'mercado'],
  [/\b(lago|lagos|dique)\b/, 'lago'],
  [/\b(cerro|macuiltepetl|volcan)\b/, 'cerro'],
  [/\b(terminal|caxa|autobuses)\b/, 'terminal'],
  [/\bteatro\b/, 'teatro'],
  [/\b(palacio de gobierno|gobierno)\b/, 'gobierno'],
  [/\bparque\b/, 'parque'],
];

export function extractEntities(raw: string, norm: string, tokens: string[], sim: ISimulation): Entities {
  const idx = placeIndex(sim);
  // "centro comercial" must not resolve to the zone "Centro"
  const placeNorm = norm.replace(/\bcentros? comercial(es)?\b/g, ' ').replace(/\s+/g, ' ');
  const placeTokens = tokenize(placeNorm);
  let zones = findPlaces(placeNorm, placeTokens, idx.zones).map((p) => p.id);
  const landmarkHits = findPlaces(placeNorm, placeTokens, idx.landmarks).map((p) => p.id);
  const kind = firstMatch(norm, LANDMARK_KIND_WORDS);
  // a landmark is "explicit" when named in full or by its kind ("catedral", "estadio", "cerro"...)
  const landmarkExplicit =
    !!kind || landmarkHits.some((id) => {
      const lm = idx.landmarks.find((l) => l.id === id);
      return !!lm && ` ${placeNorm} `.includes(` ${lm.norm} `);
    });
  if (!landmarkHits.length) {
    if (kind) {
      const lm = idx.landmarks.find((l) => l.kind === kind);
      if (lm) landmarkHits.push(lm.id);
    }
  }

  // last resort: the simulation's own fuzzy search over n-grams (longest first), verified by similarity
  if (!zones.length) {
    const content = placeTokens.filter((t) => !STOP.has(t) && t.length >= 4 && !/^\d/.test(t));
    outer: for (let n = Math.min(3, content.length); n >= 1; n--) {
      for (let i = 0; i + n <= content.length; i++) {
        const gram = content.slice(i, i + n).join(' ');
        const zs = sim.findZone(gram);
        if (!zs) continue;
        const zn = normalize(zs.zone.name);
        const ok = zn.includes(gram) || keysOf(zn).some((k) => similarity(k, content[i]) >= 0.75);
        if (ok) {
          zones = [zs.zone.id];
          break outer;
        }
      }
    }
  }

  const attrs: ZoneAttr[] = [];
  for (const [re, a] of ATTRS) if (re.test(norm) && !attrs.includes(a)) attrs.push(a);

  return {
    zones,
    landmarkIds: landmarkHits,
    landmarkExplicit,
    years: extractYears(norm),
    money: extractMoney(norm),
    percents: extractPercents(norm),
    plazoYears: extractPlazo(norm),
    establishment: firstMatch(norm, ESTABLISHMENTS),
    scenario: firstMatch(norm, SCENARIOS),
    layer: firstMatch(norm, LAYERS),
    mapStyle: firstMatch(norm, STYLES),
    attrs,
    product: firstMatch(norm, PRODUCTS),
  };
}
