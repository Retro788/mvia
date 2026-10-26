/**
 * Optional LLM mode: when the user stores an Anthropic API key (localStorage, this browser only),
 * free-form questions the local NLU cannot route are answered by Claude with a compact snapshot
 * of the simulation as grounding. Any failure returns null so the caller falls back to the local engine.
 */
import type { AppContext } from '../core/types';

const STORAGE_KEY = 'mvia.anthropicKey';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-5-5';
const TIMEOUT_MS = 25_000;

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

export function getApiKey(): string | null {
  try {
    const k = localStorage.getItem(STORAGE_KEY);
    return k && k.trim() ? k.trim() : null;
  } catch {
    return null;
  }
}

export function setApiKey(key: string | null): void {
  try {
    if (key && key.trim()) localStorage.setItem(STORAGE_KEY, key.trim());
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage blocked: LLM mode simply stays off */
  }
}

const r0 = (v: number) => Math.round(v);
const r2 = (v: number) => Math.round(v * 100) / 100;

function snapshot(ctx: AppContext): string {
  const { sim, store } = ctx;
  const s = store.get();
  const m = sim.metrics();
  const hist = sim.history();
  const last = hist[hist.length - 1];
  const zoneRow = (z: ReturnType<typeof sim.zones>[number]) => ({
    zona: z.zone.name,
    tipo: z.zone.kind,
    m2: r0(z.landValue),
    plusvalia: r2(z.appreciation),
    riesgo: r2(z.creditRisk),
    tasa: r2(z.mortgageRate),
    demanda: r2(z.commercialDemand),
    pob: r0(z.population),
    veredicto: z.verdict,
  });
  let seleccion: unknown = null;
  if (s.selection && s.selection.cellIndex >= 0) {
    try {
      const rd = sim.readCell(s.selection.cellIndex);
      seleccion = { titulo: rd.title, veredicto: rd.verdict, resumen: rd.summary, datos: Object.fromEntries(rd.rows) };
    } catch {
      seleccion = null;
    }
  }
  const data = {
    año: Math.round(s.year),
    escenario: s.scenario,
    capa: s.layer,
    metricas: {
      poblacion: r0(m.population),
      areaUrbanaKm2: r2(m.urbanAreaKm2),
      valorSueloPromedio: r0(m.avgLandValue),
      tasaHipotecariaMediana: r2(m.medianMortgageRate),
      riesgoImpago: r2(m.creditDefaultRisk),
      dispersion: r2(m.sprawlIndex),
      perdidaVerdeHa: r0(m.greenLossHa),
      deficitVivienda: r0(m.housingDeficit),
      establecimientos: m.commercialCount,
    },
    proyeccion2050: { poblacion: r0(last.population), areaUrbanaKm2: r2(last.urbanAreaKm2), perdidaVerdeHa: r0(last.greenLossHa) },
    zonas: sim.zones().slice(0, 40).map(zoneRow),
    frentesCrecimiento: sim.topZones('growth', 5).map((z) => z.zone.name),
    seleccion,
  };
  return JSON.stringify(data);
}

function systemPrompt(ctx: AppContext): string {
  return [
    'Eres MVIA (Master Validation of Infrastructure Artificial Algorithm), analista urbano-financiero de un gemelo digital 3D de Xalapa, Veracruz, México.',
    'Respondes SIEMPRE en español de México, con tono experto, claro y conciso: 2 a 5 oraciones, cifras concretas, montos en MXN con formato $12,400.',
    'Puedes usar **negritas** y listas cortas con "- ". No uses tablas ni encabezados.',
    'Basa tus cifras en el siguiente estado del simulador (JSON). Si un dato no está, dilo y da una estimación razonada marcada como aproximada.',
    'Cuando sea útil, sugiere al usuario comandos que MVIA ejecuta localmente: "¿cuánto vale el m² en <colonia>?", "simula 2040 ordenado", "¿dónde abro un supermercado?", "hipoteca de 2 millones a 20 años", "vista satelital".',
    `ESTADO: ${snapshot(ctx)}`,
  ].join('\n');
}

/** Ensures the turns alternate user/assistant and start with a user message. */
function sanitize(turns: Turn[]): Turn[] {
  const out: Turn[] = [];
  for (const t of turns) {
    if (!t.content.trim()) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === t.role) prev.content += `\n\n${t.content}`;
    else out.push({ ...t });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

interface ApiResponse {
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
}

export async function askClaude(ctx: AppContext, turns: Turn[]): Promise<string | null> {
  const key = getApiKey();
  if (!key) return null;
  const messages = sanitize(turns.slice(-8));
  if (!messages.length || messages[messages.length - 1].role !== 'user') return null;

  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        // short conversational answers: keep reasoning light so the 600-token budget goes to the reply
        output_config: { effort: 'low' },
        system: systemPrompt(ctx),
        messages,
      }),
    });
    if (!res.ok) {
      console.warn('[MVIA chat] LLM HTTP', res.status);
      return null;
    }
    const data = (await res.json()) as ApiResponse;
    if (data.stop_reason === 'refusal') return null;
    const text = (data.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('')
      .trim();
    return text || null;
  } catch (err) {
    console.warn('[MVIA chat] LLM unavailable, using local engine', err);
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}
