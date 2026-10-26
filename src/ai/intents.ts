/**
 * Intent scoring: weighted regex cues over the normalised message + entity bonuses.
 * Scores are additive; the best intent wins if it clears MIN_SCORE, otherwise 'fallback'.
 */
import type { Entities, IntentId } from './types';

type Cue = [RegExp, number];

interface IntentRule {
  id: IntentId;
  cues: Cue[];
  bonus?: (e: Entities, ctx: ScoreContext) => number;
}

export interface ScoreContext {
  hasMemoryZone: boolean;
  hasSelection: boolean;
  wordCount: number;
}

export const MIN_SCORE = 1.4;

const RULES: IntentRule[] = [
  {
    id: 'saludo',
    cues: [[/^(hola|buen[oa]s?( dias| tardes| noches)?|hey|que tal|saludos|holi|ola)\b/, 2]],
    bonus: (_e, c) => (c.wordCount <= 4 ? 0.5 : -1.5),
  },
  { id: 'gracias', cues: [[/^(gracias|muchas gracias|perfecto|excelente|genial|ok|vale|listo)\b/, 1.8]], bonus: (_e, c) => (c.wordCount <= 4 ? 0.3 : -2) },
  {
    id: 'ayuda',
    cues: [
      [/\b(ayuda|ayudame|help)\b/, 2],
      [/\bque (puedes|sabes) hacer\b/, 2.5],
      [/\b(como (te )?(uso|funciona|funcionas)|comandos|instrucciones|que te puedo preguntar|ejemplos)\b/, 2.2],
    ],
  },
  {
    id: 'about',
    cues: [
      [/\bque (es|significa) (mvia|m via)\b/, 3],
      [/\b(quien eres|que eres|presentate|mvia significa|acronimo|siglas)\b/, 2.6],
      [/\bmvia\b/, 0.4],
    ],
  },
  {
    id: 'zona',
    cues: [
      [/\b(cuanto (vale|cuesta)|precio|valor|costo|cotiza)\w*/, 1.6],
      [/\b(m2|metro cuadrado|metros cuadrados|terreno|suelo|lote)\b/, 0.8],
      [/\b(perfil|ficha|dime de|hablame de|informacion de|info de|como esta)\b/, 1.2],
      [/^y (su|sus|el|la|los|las|en)\b/, 1.2],
    ],
    bonus: (e, c) => (e.zones.length === 1 ? 1.5 : 0) + (e.attrs.length && (e.zones.length || c.hasMemoryZone) ? 0.6 : 0),
  },
  {
    id: 'comparar',
    cues: [
      [/\b(compara\w*|comparativ\w*|diferencia entre|versus|vs|contra|frente a)\b/, 2.4],
      [/\b(cual es mejor|que conviene mas|mejor opcion entre)\b/, 1.4],
    ],
    bonus: (e) => (e.zones.length >= 2 ? 1.5 : e.years.length >= 2 ? 1 : 0),
  },
  {
    id: 'ranking',
    cues: [
      [/\b(mas (car[oa]s?|barat[oa]s?|costos[oa]s?|economic[oa]s?|accesibles?|exclusiv[oa]s?|segur[oa]s?|rentables?))\b/, 2.4],
      [/\b(mayor|menor|mejor(es)?|peor(es)?) (plusvalia|valor|precio|riesgo|demanda|crecimiento|rentabilidad|para invertir)\b/, 2.4],
      [/\b(top|ranking|clasificacion|las mejores|las peores|cuales son las)\b/, 1.6],
      [/\b(donde (conviene )?invertir|mejor para invertir|mejores zonas)\b/, 2],
      [/\b(invertir|inversion|inversionista)\b/, 1.6],
    ],
  },
  {
    id: 'crecimiento',
    cues: [
      [/\b(crece|crecera|crecimiento|expansion|expande|mancha urbana|se extiende|dispersion|urbaniza\w*|periferia|sprawl)\b/, 2.2],
      [/\bhacia donde\b/, 1],
    ],
  },
  {
    id: 'simular',
    cues: [
      [/\b(simula\w*|proyecta\w*|reproduc\w*|play|anima(cion)?|avanza|adelanta|corre la|ejecuta)\b/, 2],
      [/\b(pausa|pausar|deten\w*|para la|stop|alto)\b/, 2],
      [/\b(escenario|en el ano|ve al ano|ir al ano|reinicia|reset|vuelve a 2026)\b/, 1.2],
    ],
    bonus: (e) => (e.years.length ? 0.9 : 0) + (e.scenario ? 1.1 : 0),
  },
  {
    id: 'hipoteca',
    cues: [
      [/\b(hipoteca\w*|mensualidad\w*|enganche|infonavit|fovissste|cofinavit|credito hipotecario|prestamo|financiamiento)\b/, 2.6],
      [/\b(credito|pagar|pago mensual|cuanto pagaria|tasa)\b/, 0.9],
    ],
    bonus: (e) => (e.money.length ? 0.8 : 0) + (e.plazoYears ? 0.6 : 0),
  },
  {
    id: 'riesgo',
    cues: [
      [/\b(riesgo crediticio|riesgo de credito|morosidad|cartera vencida|impago|incumplimiento|default)\b/, 3],
      [/\briesgo\b/, 1.1],
    ],
  },
  {
    id: 'comercio',
    cues: [
      [/\b(donde (abro|abrir|pongo|poner|instalo|ubico|construyo|conviene)|abrir un|poner un|montar un|emprender)\b/, 2.6],
      [/\b(evalua\w*|analiza\w* (una|un)|viabilidad|conviene (una|un)|vale la pena)\b/, 1.6],
      [/\b(negocio|establecimiento|sucursal|franquicia|local comercial)\b/, 1.1],
    ],
    bonus: (e) => (e.establishment && e.establishment !== 'vivienda' ? 1 : e.establishment === 'vivienda' ? 0.3 : 0),
  },
  {
    id: 'construir',
    cues: [[/\b(construye|construir|construyamos|edifica|levanta|coloca|pon una|pon un|agrega|anade|crea una|crea un)\b/, 2.4]],
    bonus: (e) => (e.establishment ? 1 : -0.8),
  },
  {
    id: 'capas',
    cues: [
      [/\b(capa|capas|layer|overlay|vista|modo|estilo|tema|activa|desactiva|enciende|apaga|quita|oculta|cambia a|pon el|pon la)\b/, 0.9],
      [/\b(lente|lens|vision de maquina|vision mvia)\b/, 1.6],
      [/\bmuestra\b/, 0.6],
      [/\b(mapa de calor|heatmap|muestra (el|la|los|las)? ?(mapa|capa))\b/, 1],
      [/\b(vista dividida|pantalla dividida|split|edificios|trafico|etiquetas)\b/, 1.4],
    ],
    bonus: (e) => (e.mapStyle ? 1.8 : 0) + (e.layer ? 1.2 : 0),
  },
  {
    id: 'ubicar',
    cues: [
      [/\b(llevame|lleva(me)? a|muestrame|ensename|ve a|vamos a|ir a|vuela a|donde (esta|queda)|ubica\w*|enfoca|centra|acercate|zoom)\b/, 1.8],
    ],
    bonus: (e) => (e.landmarkIds.length ? 1.6 : 0) + (e.zones.length ? 0.8 : 0),
  },
  {
    id: 'metricas',
    cues: [
      [/\b(resumen|metricas|indicadores|kpis?|panorama|estado general|diagnostico|dashboard|estadisticas)\b/, 2.4],
      [/\b(como (esta|va) (la ciudad|xalapa)|datos de (la ciudad|xalapa)|cuanta gente|poblacion total|cifras)\b/, 2.2],
    ],
  },
  {
    id: 'voz',
    cues: [
      [/\b(lee(lo|me)? (esto|eso|en voz alta)?|leelo|repite|en voz alta|dimelo|habla(me)?|narra)\b/, 2],
      [/\b(silencio|callate|calla|deja de hablar|para de hablar|sin voz|mute|silencia)\b/, 2.6],
      [/\b(voz|estudio de voz|voice|sintetizador|locutor)\b/, 1.2],
    ],
  },
  {
    id: 'inspeccion',
    cues: [
      [/\b(analiza (esta|este|esto|el punto|la seleccion|aqui)|que es esto|que hay aqui|este (punto|lugar|predio|lote)|esta (zona|celda|seleccion|ubicacion)|lo seleccionado|aqui)\b/, 2.2],
      [/\b(inspecciona|lectura|escanea)\b/, 1.4],
    ],
    bonus: (_e, c) => (c.hasSelection ? 0.6 : -0.4),
  },
];

export function scoreIntents(norm: string, e: Entities, ctx: ScoreContext): { intent: IntentId; score: number; scores: Partial<Record<IntentId, number>> } {
  const scores: Partial<Record<IntentId, number>> = {};
  let best: IntentId = 'fallback';
  let bestScore = 0;
  for (const r of RULES) {
    let s = 0;
    for (const [re, w] of r.cues) if (re.test(norm)) s += w;
    if (s <= 0 && !r.bonus) continue;
    // entity bonuses only count when at least one lexical cue fired; pure-entity messages are routed below
    const b = r.bonus ? r.bonus(e, ctx) : 0;
    s = s > 0 ? s + b : 0;
    if (s <= 0) continue;
    scores[r.id] = Math.round(s * 100) / 100;
    if (s > bestScore) {
      bestScore = s;
      best = r.id;
    }
  }
  // a bare place name ("Las Ánimas") → zone profile; a bare landmark → fly there
  if (bestScore < MIN_SCORE) {
    if (e.zones.length === 1) return { intent: 'zona', score: MIN_SCORE, scores };
    if (e.landmarkIds.length) return { intent: 'ubicar', score: MIN_SCORE, scores };
    if (e.mapStyle || e.layer) return { intent: 'capas', score: MIN_SCORE, scores };
    if (e.years.length || e.scenario) return { intent: 'simular', score: MIN_SCORE, scores };
    return { intent: 'fallback', score: bestScore, scores };
  }
  return { intent: best, score: bestScore, scores };
}
