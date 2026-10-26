/**
 * MVIA conversational engine: turns a parsed message into a data-driven Spanish reply
 * (text + rich attachments) and applies its side effects on the map (fly-to, layers, scenario...).
 */
import type {
  AppContext,
  EstablishmentType,
  LayerId,
  MapStyle,
  ScenarioId,
  SiteEvaluation,
  Verdict,
  ZoneStats,
} from '../core/types';
import { YEAR_END, YEAR_START, elevationAt } from '../core/geo';
import { extractEntities, normalize, tokenize } from './nlu';
import { scoreIntents } from './intents';
import type { Attachment, BarItem, ChatAction, IntentId, Parsed, Reply, ZoneAttr } from './types';
import { VERDICT_LABEL, VERDICT_TEXT, compass, dec, demandLabel, int, mxn, mxnBig, pct, riskLabel } from './format';

const LAYER_NAME: Record<LayerId, string> = {
  none: 'sin capa',
  landValue: 'valor del suelo',
  growth: 'crecimiento urbano',
  creditRisk: 'riesgo crediticio',
  mortgage: 'tasas hipotecarias',
  commercial: 'demanda comercial',
  floodRisk: 'riesgo de inundación',
  density: 'densidad de población',
};

const LAYER_LEGEND: Record<LayerId, string> = {
  none: 'Mapa limpio, solo la maqueta urbana.',
  landValue: 'Rampa crema → vino: de suelo accesible a suelo premium (MXN/m²).',
  growth: 'Celdas que se urbanizan entre 2026 y 2050; los tonos intensos son los frentes de expansión más próximos.',
  creditRisk: 'Índice tipo probabilidad de impago: claro = cartera sana, oscuro = morosidad esperada alta.',
  mortgage: 'Tasa hipotecaria típica por celda según riesgo, ingreso y escenario.',
  commercial: 'Demanda comercial insatisfecha: población, ingreso y accesibilidad vial frente a la oferta existente.',
  floodRisk: 'Susceptibilidad a inundación por cauces, pendiente y depresiones del terreno.',
  density: 'Densidad construida y poblacional de cada celda de 100 m.',
};

const STYLE_NAME: Record<MapStyle, string> = {
  clay: 'maqueta blanca (clay)',
  satellite: 'vista satelital',
  scan: 'visión de máquina MVIA (profundidad / LiDAR)',
  night: 'modo nocturno',
};

const SCENARIO_NAME: Record<ScenarioId, string> = {
  descontrolado: 'crecimiento descontrolado',
  tendencial: 'tendencial',
  ordenado: 'crecimiento ordenado',
};

const SCENARIO_VERDICT: Record<ScenarioId, Verdict> = { descontrolado: 'riesgo', tendencial: 'precaucion', ordenado: 'viable' };

const ATTR_LAYER: Record<ZoneAttr, LayerId> = {
  precio: 'landValue',
  riesgo: 'creditRisk',
  plusvalia: 'landValue',
  poblacion: 'density',
  comercio: 'commercial',
  inundacion: 'floodRisk',
  hipoteca: 'mortgage',
  densidad: 'density',
};

/** indefinite article per establishment type ("una plaza", "un supermercado") */
const ART: Record<EstablishmentType, string> = {
  plaza: 'una',
  plazoleta: 'una',
  tienda: 'una',
  supermercado: 'un',
  centroComercial: 'un',
  vivienda: 'un proyecto de',
  oficinas: 'un proyecto de',
};

export const SUGGESTIONS = [
  '¿Cuánto vale el m² en Las Ánimas?',
  '¿Hacia dónde crece Xalapa?',
  'Simula 2045 descontrolado',
  '¿Dónde abro un supermercado?',
  'Hipoteca de 2.5 M a 20 años',
  'Zonas con mayor riesgo crediticio',
];

interface Memory {
  zoneId: string | null;
  type: EstablishmentType | null;
  site: SiteEvaluation | null;
  lastIntent: IntentId | null;
  lastReplyText: string;
}

export class MviaEngine {
  readonly memory: Memory = { zoneId: null, type: null, site: null, lastIntent: null, lastReplyText: '' };
  private stopPlayback: (() => void) | null = null;

  constructor(private ctx: AppContext) {}

  get cellCount(): number {
    return this.ctx.sim.grid.cols * this.ctx.sim.grid.rows;
  }

  parse(raw: string): Parsed {
    const norm = normalize(raw);
    const tokens = tokenize(norm);
    const entities = extractEntities(raw, norm, tokens, this.ctx.sim);
    const { intent, score, scores } = scoreIntents(norm, entities, {
      hasMemoryZone: !!this.memory.zoneId,
      hasSelection: !!this.ctx.store.get().selection,
      wordCount: tokens.length,
    });
    return { raw, norm, tokens, entities, intent, score, scores };
  }

  /** how many grid cells the "analysis" touches — shown in the thinking line */
  cellsFor(p: Parsed): number {
    const n = this.cellCount;
    switch (p.intent) {
      case 'zona':
      case 'inspeccion':
      case 'ubicar':
        return Math.round(n * 0.04);
      case 'saludo':
      case 'gracias':
      case 'ayuda':
      case 'about':
      case 'voz':
        return 0;
      default:
        return n;
    }
  }

  respond(p: Parsed): Reply {
    let r: Reply;
    try {
      r = this.dispatch(p);
    } catch (err) {
      console.error('[MVIA chat] engine error', err);
      r = {
        intent: 'fallback',
        text: 'Tuve un problema leyendo el modelo urbano para esa consulta. Intenta de nuevo en unos segundos o reformula la pregunta.',
        attachments: [],
      };
    }
    this.memory.lastIntent = p.intent;
    if (!r.silent) this.memory.lastReplyText = r.text;
    return r;
  }

  answerText(text: string): Reply {
    return this.respond(this.parse(text));
  }

  private dispatch(p: Parsed): Reply {
    switch (p.intent) {
      case 'saludo':
        return this.saludo();
      case 'gracias':
        return { intent: 'gracias', text: 'Con gusto. Sigo monitoreando **Xalapa** en tiempo real; pregúntame por cualquier colonia, crédito o sitio comercial.', attachments: [] };
      case 'ayuda':
        return this.ayuda();
      case 'about':
        return this.about();
      case 'zona':
        return this.zona(p);
      case 'comparar':
        return this.comparar(p);
      case 'ranking':
        return this.ranking(p);
      case 'crecimiento':
        return this.crecimiento();
      case 'simular':
        return this.simular(p);
      case 'hipoteca':
        return this.hipoteca(p);
      case 'riesgo':
        return p.entities.zones.length === 1 ? this.zona(p, 'riesgo') : this.riesgo();
      case 'comercio':
        return this.comercio(p);
      case 'construir':
        return this.construir(p);
      case 'capas':
        return this.capas(p);
      case 'ubicar':
        return this.ubicar(p);
      case 'metricas':
        return this.metricas();
      case 'voz':
        return this.voz(p);
      case 'inspeccion':
        return this.inspeccion();
      default:
        return this.fallback();
    }
  }

  // ───────────────────────────── helpers ─────────────────────────────
  private get year(): number {
    return Math.round(this.ctx.store.get().year);
  }

  private fly(x: number, z: number, zoom = 0.62, pitch = 58): void {
    try {
      this.ctx.view.flyTo({ x, z, zoom, pitch, duration: 2.2 });
    } catch {
      this.ctx.bus.emit('view:flyTo', { x, z, zoom, pitch, duration: 2.2 });
    }
  }

  private setLayer(layer: LayerId): void {
    this.ctx.store.set({ layer });
  }

  private zoneOf(p: Parsed, allowMemory = true): ZoneStats | null {
    const id = p.entities.zones[0] ?? (allowMemory ? this.memory.zoneId : null);
    if (!id) return null;
    const zs = this.ctx.sim.zoneStats(id);
    if (zs) this.memory.zoneId = zs.zone.id;
    return zs;
  }

  private selectZone(zs: ZoneStats): void {
    const { x, z } = zs.zone.center;
    this.ctx.store.set({ selection: { kind: 'zone', id: zs.zone.id, point: { x, z }, cellIndex: this.ctx.sim.cellIndexAt(x, z) } });
  }

  private flyZone(zs: ZoneStats, zoom = 0.6): void {
    this.fly(zs.zone.center.x, zs.zone.center.z, zoom);
  }

  private actFly(label: string, x: number, z: number, zoom = 0.66): ChatAction {
    return { label, icon: 'map', run: () => this.fly(x, z, zoom) };
  }

  private actLayer(layer: LayerId, label = 'Mostrar capa'): ChatAction {
    return { label: `${label}: ${LAYER_NAME[layer]}`, icon: 'layer', run: () => this.setLayer(layer) };
  }

  private actAsk(label: string, question: string, icon: ChatAction['icon'] = 'info'): ChatAction {
    return { label, icon, run: () => this.answerText(question) };
  }

  private zoneKpis(zs: ZoneStats): Attachment {
    return {
      kind: 'kpis',
      title: `${zs.zone.name.toUpperCase()} · ${this.year}`,
      rows: [
        ['Valor del suelo', `${mxn(zs.landValue)}/m²`],
        ['Plusvalía anual', pct(zs.appreciation)],
        ['Riesgo crediticio', `${dec(zs.creditRisk, 2)} · ${riskLabel(zs.creditRisk)}`],
        ['Tasa hipotecaria', pct(zs.mortgageRate, 2)],
        ['Demanda comercial', `${dec(zs.commercialDemand, 2)} · ${demandLabel(zs.commercialDemand)}`],
        ['Población', int(zs.population)],
        ['Urbanizado', pct(zs.urbanShare * 100, 0)],
        ['Nivel de ingreso', zs.zone.income],
      ],
    };
  }

  private cityAvg(): number {
    return this.ctx.sim.metrics().avgLandValue;
  }

  // ───────────────────────────── intents ─────────────────────────────
  private saludo(): Reply {
    const m = this.ctx.sim.metrics();
    return {
      intent: 'saludo',
      text:
        `¡Hola! Soy **MVIA**, tu analista urbano para Xalapa. Ahora mismo modelo **${int(m.population)} habitantes** en ` +
        `${dec(m.urbanAreaKm2)} km² urbanizados (${this.year}, escenario ${SCENARIO_NAME[this.ctx.store.get().scenario]}).\n` +
        'Puedo valuar suelo, cotizar hipotecas, encontrar sitios comerciales y simular el crecimiento hasta 2050.',
      attachments: [{ kind: 'actions', items: SUGGESTIONS.slice(0, 3).map((q) => this.actAsk(q, q)) }],
    };
  }

  private ayuda(): Reply {
    return {
      intent: 'ayuda',
      text:
        'Esto es lo que puedo hacer por ti:\n' +
        '- **Valor de suelo**: "¿cuánto vale el m² en Las Ánimas?", "compara Ánimas vs Centro"\n' +
        '- **Rankings**: zona más cara, más barata, mayor plusvalía, mayor riesgo\n' +
        '- **Crecimiento**: "¿hacia dónde crece Xalapa?", "simula 2045 descontrolado", "pausa"\n' +
        '- **Crédito**: "hipoteca de 2 millones a 20 años con 10% de enganche", Infonavit, riesgo crediticio\n' +
        '- **Comercio**: "¿dónde abro un supermercado?", "construye una plazoleta en El Olmo"\n' +
        '- **Mapa**: "vista satelital", "modo noche", "muestra inundación", "llévame a Macuiltépetl"\n' +
        '- **Selección**: haz clic en el mapa y pregunta "analiza esta zona"',
      attachments: [],
    };
  }

  private about(): Reply {
    return {
      intent: 'about',
      text:
        '**MVIA** significa **Master Validation of Infrastructure Artificial Algorithm**. Es un gemelo digital de Xalapa que ' +
        `divide la ciudad en ${int(this.cellCount)} celdas de 100 m y proyecta, año por año hasta ${YEAR_END}, la urbanización, ` +
        'el valor del suelo, el riesgo crediticio, las tasas hipotecarias y la demanda comercial.\n' +
        'Valido cada ubicación con un veredicto (**viable**, **observar**, **precaución** o **riesgo**) para que decidas con datos.',
      attachments: [
        {
          kind: 'verdicts',
          items: [
            { verdict: 'viable', label: 'Viable' },
            { verdict: 'observar', label: 'Observar' },
            { verdict: 'precaucion', label: 'Precaución' },
            { verdict: 'riesgo', label: 'Riesgo' },
          ],
        },
      ],
    };
  }

  private zona(p: Parsed, forced?: ZoneAttr): Reply {
    const zs = this.zoneOf(p);
    const attr: ZoneAttr = forced ?? p.entities.attrs.find((a) => a !== 'densidad') ?? p.entities.attrs[0] ?? 'precio';
    if (!zs) {
      if (attr === 'precio' || attr === 'plusvalia') return this.cityPrices();
      return {
        intent: 'zona',
        text: '¿De qué colonia hablamos? Menciónala por nombre (por ejemplo **Las Ánimas**, **Centro** o **Coapexpan**) o haz clic en el mapa.',
        attachments: [{ kind: 'actions', items: [this.actAsk('Ranking de valor', '¿Cuáles son las zonas más caras?')] }],
      };
    }
    const z = zs.zone;
    const avg = this.cityAvg();
    const diff = ((zs.landValue - avg) / Math.max(1, avg)) * 100;
    const cmp = Math.abs(diff) < 4 ? 'en línea con el promedio' : diff > 0 ? `${dec(diff, 0)}% por encima del promedio` : `${dec(-diff, 0)}% por debajo del promedio`;
    const yearsLeft = YEAR_END - this.year;
    const v2050 = zs.landValue * Math.pow(1 + zs.appreciation / 100, Math.max(0, yearsLeft));
    const layer = ATTR_LAYER[attr];
    let text: string;

    switch (attr) {
      case 'riesgo':
        text =
          `El riesgo crediticio en **${z.name}** es **${riskLabel(zs.creditRisk)}** (índice ${dec(zs.creditRisk, 2)}), con tasa hipotecaria típica de **${pct(zs.mortgageRate, 2)}**. ` +
          (zs.creditRisk > 0.45
            ? 'Recomiendo enganches ≥ 20% y validar ingresos formales antes de originar crédito aquí.'
            : 'La cartera es sana: buena zona para originar crédito hipotecario con aforos estándar.');
        break;
      case 'plusvalia':
        text =
          `**${z.name}** se aprecia **${pct(zs.appreciation)} anual**. De sostenerse, el m² pasaría de ${mxn(zs.landValue)} hoy a **${mxn(v2050)}** en ${YEAR_END}. ` +
          `Veredicto de inversión: **${VERDICT_TEXT[zs.verdict]}**.`;
        break;
      case 'poblacion':
      case 'densidad':
        text =
          `**${z.name}** concentra **${int(zs.population)} habitantes** con ${pct(zs.urbanShare * 100, 0)} de su superficie urbanizada en ${this.year}. ` +
          `Edificación típica de ${z.floors[0]}–${z.floors[1]} niveles; nivel de ingreso ${z.income}.`;
        break;
      case 'comercio':
        text =
          `La demanda comercial en **${z.name}** es **${demandLabel(zs.commercialDemand)}** (${dec(zs.commercialDemand, 2)}). ` +
          (zs.commercialDemand > 0.55
            ? 'Hay mercado insatisfecho: un supermercado o una plaza de barrio tendría buena afluencia.'
            : 'La oferta está cerca de saturar; una tienda de proximidad es la apuesta más segura.');
        break;
      case 'inundacion':
        text =
          `El riesgo de inundación en **${z.name}** es **${riskLabel(z.floodRisk)}** (${dec(z.floodRisk, 2)}). ` +
          (z.floodRisk > 0.45
            ? 'Evita plantas bajas habitables y exige estudio hidrológico antes de construir.'
            : 'No es una zona crítica, aunque conviene revisar drenaje pluvial en temporada de lluvias.');
        break;
      case 'hipoteca': {
        const price = Math.round(zs.landValue * 120 + 95 * 13_500);
        const q = this.ctx.sim.mortgageQuote({ price, downPayment: price * 0.1, years: 20, cellIndex: this.ctx.sim.cellIndexAt(z.center.x, z.center.z) });
        text =
          `Una vivienda típica en **${z.name}** (≈${mxnBig(price)}) con 10% de enganche a 20 años paga **${mxn(q.monthlyPayment)} al mes** ` +
          `a una tasa de ${pct(q.rate, 2)} (CAT ${pct(q.cat, 1)}). Ingreso requerido ≈ **${mxn(q.requiredIncome)}** mensuales.`;
        break;
      }
      default:
        text =
          `**${z.name}** cotiza en **${mxn(zs.landValue)}/m²** en ${this.year}, ${cmp} de la ciudad (${mxn(avg)}/m²). ` +
          `Plusvalía estimada de **${pct(zs.appreciation)} anual**; un lote típico de 160 m² ronda **${mxnBig(zs.landValue * 160)}**. ` +
          `Veredicto MVIA: **${VERDICT_TEXT[zs.verdict]}**.`;
    }
    if (z.description && attr === 'precio') text += `\n${z.description}`;

    this.flyZone(zs);
    this.selectZone(zs);
    this.setLayer(layer);
    return {
      intent: 'zona',
      text,
      attachments: [
        this.zoneKpis(zs),
        { kind: 'verdicts', items: [{ verdict: zs.verdict, label: `${VERDICT_LABEL[zs.verdict]} · ${z.name}` }] },
        {
          kind: 'actions',
          items: [
            this.actFly('Ver en mapa', z.center.x, z.center.z),
            this.actLayer(layer),
            this.actAsk('¿Y su riesgo?', `¿Cuál es el riesgo crediticio en ${z.name}?`),
          ],
        },
      ],
    };
  }

  private cityPrices(): Reply {
    const sim = this.ctx.sim;
    const top = sim.topZones('landValue', 3);
    const low = sim.topZones('landValue', 3, true);
    this.setLayer('landValue');
    return {
      intent: 'zona',
      text:
        `El valor promedio del suelo en Xalapa es **${mxn(this.cityAvg())}/m²** (${this.year}). ` +
        `Lo más caro está en ${top.map((z) => `**${z.zone.name}**`).join(', ')}; lo más accesible en ${low.map((z) => `**${z.zone.name}**`).join(', ')}. ` +
        'Activé la capa de valor del suelo; pregúntame por cualquier colonia.',
      attachments: [this.bars('Valor del suelo (MXN/m²)', [...top, ...low.reverse()], (z) => z.landValue, (v) => mxn(v))],
    };
  }

  private bars(title: string, list: ZoneStats[], val: (z: ZoneStats) => number, fmt: (v: number) => string, accentFirst = true): Attachment {
    const items: BarItem[] = list.map((z, i) => ({ label: z.zone.name, value: val(z), display: fmt(val(z)), accent: accentFirst && i === 0, verdict: z.verdict }));
    return { kind: 'bars', title, items };
  }

  private comparar(p: Parsed): Reply {
    const sim = this.ctx.sim;
    let ids = [...p.entities.zones];
    if (ids.length === 1 && this.memory.zoneId && this.memory.zoneId !== ids[0]) ids.unshift(this.memory.zoneId);

    // "compara 2026 con 2050" → split-view comparison of two years
    if (ids.length < 2 && p.entities.years.length >= 2) {
      const [a, b] = [Math.min(...p.entities.years), Math.max(...p.entities.years)];
      this.ctx.store.set({ compare: true, compareYear: a, year: b, playing: false });
      const h = sim.history();
      const ma = h.find((m) => m.year === a) ?? h[0];
      const mb = h.find((m) => m.year === b) ?? h[h.length - 1];
      return {
        intent: 'comparar',
        text:
          `Activé la **vista dividida**: izquierda ${a}, derecha ${b}. La mancha urbana pasa de **${dec(ma.urbanAreaKm2)} km²** a **${dec(mb.urbanAreaKm2)} km²** ` +
          `y la población de ${int(ma.population)} a **${int(mb.population)}**. Arrastra el divisor para comparar.`,
        attachments: [
          {
            kind: 'table',
            head: ['Indicador', String(a), String(b)],
            rows: [
              ['Población', int(ma.population), int(mb.population)],
              ['Área urbana', `${dec(ma.urbanAreaKm2)} km²`, `${dec(mb.urbanAreaKm2)} km²`],
              ['Valor medio', mxn(ma.avgLandValue), mxn(mb.avgLandValue)],
              ['Dispersión', dec(ma.sprawlIndex, 2), dec(mb.sprawlIndex, 2)],
              ['Pérdida verde', `${int(ma.greenLossHa)} ha`, `${int(mb.greenLossHa)} ha`],
            ],
          },
          { kind: 'actions', items: [{ label: 'Cerrar vista dividida', icon: 'layer', run: () => this.ctx.store.set({ compare: false }) }] },
        ],
      };
    }

    ids = ids.filter((id, i) => ids.indexOf(id) === i).slice(0, 3);
    if (ids.length < 2) {
      return {
        intent: 'comparar',
        text: 'Necesito al menos dos colonias para comparar, por ejemplo: **"compara Las Ánimas vs Centro"**.',
        attachments: [{ kind: 'actions', items: [this.actAsk('Ánimas vs Centro', 'Compara Las Ánimas vs Centro')] }],
      };
    }
    const zs = ids.map((id) => sim.zoneStats(id)).filter((z): z is ZoneStats => !!z);
    if (zs.length < 2) return this.fallback();
    const [a, b] = zs;
    this.memory.zoneId = a.zone.id;
    const priceGap = ((a.landValue - b.landValue) / Math.max(1, b.landValue)) * 100;
    const pricier = priceGap >= 0 ? a : b;
    const cheaper = priceGap >= 0 ? b : a;
    const best = [...zs].sort((x, y) => y.appreciation - y.creditRisk * 8 - (x.appreciation - x.creditRisk * 8))[0];
    const fastest = [...zs].sort((x, y) => y.appreciation - x.appreciation)[0];

    this.setLayer('landValue');
    const cx = zs.reduce((s, z) => s + z.zone.center.x, 0) / zs.length;
    const cz = zs.reduce((s, z) => s + z.zone.center.z, 0) / zs.length;
    this.fly(cx, cz, 0.38, 50);

    return {
      intent: 'comparar',
      text:
        `**${pricier.zone.name}** es ${dec(Math.abs(priceGap), 0)}% más cara que **${cheaper.zone.name}** ` +
        `(${mxn(pricier.landValue)} vs ${mxn(cheaper.landValue)} por m²). ` +
        `La mayor plusvalía la tiene **${fastest.zone.name}** (${pct(fastest.appreciation)} anual). ` +
        `Ponderando plusvalía contra riesgo crediticio, MVIA prefiere **${best.zone.name}** para inversión patrimonial.`,
      attachments: [
        {
          kind: 'table',
          head: ['', ...zs.map((z) => z.zone.name)],
          rows: [
            ['Valor m²', ...zs.map((z) => mxn(z.landValue))],
            ['Plusvalía', ...zs.map((z) => pct(z.appreciation))],
            ['Riesgo créd.', ...zs.map((z) => dec(z.creditRisk, 2))],
            ['Tasa hip.', ...zs.map((z) => pct(z.mortgageRate, 2))],
            ['Demanda com.', ...zs.map((z) => dec(z.commercialDemand, 2))],
            ['Población', ...zs.map((z) => int(z.population))],
            ['Veredicto', ...zs.map((z) => VERDICT_LABEL[z.verdict])],
          ],
        },
        this.bars('Valor del suelo (MXN/m²)', zs, (z) => z.landValue, (v) => mxn(v), false),
        { kind: 'actions', items: zs.map((z) => this.actFly(`Ver ${z.zone.name}`, z.zone.center.x, z.zone.center.z)) },
      ],
    };
  }

  private ranking(p: Parsed): Reply {
    const n = p.norm;
    const sim = this.ctx.sim;
    let by: 'landValue' | 'appreciation' | 'creditRisk' | 'commercialDemand' | 'growth' = 'landValue';
    let asc = false;
    let invest = false;
    if (/barat|economic|accesible/.test(n)) asc = true;
    else if (/plusvalia|rentab|aprecia/.test(n)) by = 'appreciation';
    else if (/invertir|inversion/.test(n)) {
      by = 'appreciation';
      invest = true;
    } else if (/riesgo|morosidad/.test(n)) {
      by = 'creditRisk';
      asc = /menor|segur|bajo/.test(n);
    } else if (/demanda|comerci|negocio/.test(n)) by = 'commercialDemand';
    else if (/crecimiento|crece|expansion/.test(n)) by = 'growth';

    let list: ZoneStats[];
    if (invest) {
      // investment score: appreciation rewarded, credit risk penalised (≈8 pp of appreciation per unit of risk)
      list = [...sim.zones()].sort((a, b) => b.appreciation - b.creditRisk * 8 - (a.appreciation - a.creditRisk * 8)).slice(0, 5);
    } else {
      list = sim.topZones(by, 5, asc);
    }
    if (!list.length) return this.fallback();

    const meta: Record<typeof by, { label: string; layer: LayerId; val: (z: ZoneStats) => number; fmt: (v: number) => string }> = {
      landValue: { label: 'valor del suelo', layer: 'landValue', val: (z) => z.landValue, fmt: (v) => `${mxn(v)}/m²` },
      appreciation: { label: invest ? 'potencial de inversión' : 'plusvalía anual', layer: 'landValue', val: (z) => z.appreciation, fmt: (v) => pct(v) },
      creditRisk: { label: 'riesgo crediticio', layer: 'creditRisk', val: (z) => z.creditRisk, fmt: (v) => dec(v, 2) },
      commercialDemand: { label: 'demanda comercial', layer: 'commercial', val: (z) => z.commercialDemand, fmt: (v) => dec(v, 2) },
      growth: { label: 'crecimiento proyectado', layer: 'growth', val: (z) => z.urbanShare * 100, fmt: (v) => `${dec(v, 0)}% urb.` },
    };
    const m = meta[by];
    const head = list[0];
    this.memory.zoneId = head.zone.id;
    this.setLayer(m.layer);
    this.flyZone(head, 0.5);

    const qual = asc ? 'menor' : 'mayor';
    const lines = list.map((z, i) => `${i + 1}. **${z.zone.name}** — ${m.fmt(m.val(z))}`).join('\n');
    return {
      intent: 'ranking',
      text: `Top ${list.length} por ${qual} ${m.label} en ${this.year}:\n${lines}\nActivé la capa de ${LAYER_NAME[m.layer]} y centré el mapa en **${head.zone.name}**.`,
      attachments: [
        this.bars(`${m.label.toUpperCase()} · ${this.year}`, list, m.val, m.fmt),
        { kind: 'actions', items: [this.actFly(`Ver ${head.zone.name}`, head.zone.center.x, head.zone.center.z), this.actAsk(`Detalle de ${head.zone.name}`, `Háblame de ${head.zone.name}`)] },
      ],
    };
  }

  private crecimiento(): Reply {
    const sim = this.ctx.sim;
    const scenario = this.ctx.store.get().scenario;
    const hist = sim.history();
    const h0 = hist[0];
    const hN = hist[hist.length - 1];
    const top = sim.topZones('growth', 5);
    const areaGrowth = ((hN.urbanAreaKm2 - h0.urbanAreaKm2) / Math.max(0.01, h0.urbanAreaKm2)) * 100;

    // weighted centroid of the growth fronts relative to the historic centre (0,0) → compass direction
    let wx = 0;
    let wz = 0;
    let wsum = 0;
    top.forEach((z, i) => {
      const w = top.length - i;
      wx += z.zone.center.x * w;
      wz += z.zone.center.z * w;
      wsum += w;
    });
    if (wsum > 0) {
      wx /= wsum;
      wz /= wsum;
    }
    const dir = compass(wx, wz);
    const front = top[0];
    this.setLayer('growth');
    if (front) {
      this.memory.zoneId = front.zone.id;
      this.fly(wx * 0.6, wz * 0.6, 0.22, 48);
    }

    return {
      intent: 'crecimiento',
      text:
        `En el escenario **${SCENARIO_NAME[scenario]}**, Xalapa crece sobre todo hacia el **${dir}**. ` +
        `La mancha urbana pasa de **${dec(h0.urbanAreaKm2)} km²** en ${YEAR_START} a **${dec(hN.urbanAreaKm2)} km²** en ${YEAR_END} (+${dec(areaGrowth, 0)}%), ` +
        `con una pérdida de **${int(hN.greenLossHa)} ha** de cobertura verde y un índice de dispersión de ${dec(hN.sprawlIndex, 2)}.\n` +
        `Frentes principales: ${top.slice(0, 3).map((z) => `**${z.zone.name}**`).join(', ')}.`,
      attachments: [
        { kind: 'line', title: `ÁREA URBANA (km²) · ${YEAR_START}→${YEAR_END}`, values: hist.map((m) => m.urbanAreaKm2), from: String(YEAR_START), to: String(YEAR_END), fmt: (v) => `${dec(v)} km²` },
        this.bars(`FRENTES DE EXPANSIÓN · % URBANIZADO ${this.year}`, top, (z) => z.urbanShare * 100, (v) => `${dec(v, 0)}%`),
        { kind: 'verdicts', items: [{ verdict: SCENARIO_VERDICT[scenario], label: `${VERDICT_LABEL[SCENARIO_VERDICT[scenario]]} · ${SCENARIO_NAME[scenario]}` }] },
        {
          kind: 'actions',
          items: [
            { label: `Reproducir ${YEAR_START}→${YEAR_END}`, icon: 'play', run: () => this.ctx.store.set({ year: YEAR_START, playing: true }) },
            ...(front ? [this.actFly(`Ver ${front.zone.name}`, front.zone.center.x, front.zone.center.z)] : []),
            this.actAsk('Escenario ordenado', 'Simula 2050 ordenado'),
          ],
        },
      ],
    };
  }

  private simular(p: Parsed): Reply {
    const { store, sim } = this.ctx;
    const n = p.norm;
    const e = p.entities;
    const s = store.get();

    if (/\b(pausa|pausar|deten\w*|para la|stop|alto)\b/.test(n) && !e.years.length) {
      this.cancelPlayback();
      store.set({ playing: false });
      return { intent: 'simular', text: `Simulación en pausa en **${this.year}**. Di "reproduce" para continuar.`, attachments: [] };
    }
    if (/\b(reinicia|reset|vuelve a 2026|desde el inicio)\b/.test(n)) {
      this.cancelPlayback();
      store.set({ year: YEAR_START, playing: false, compare: false });
      return { intent: 'simular', text: `Regresé el modelo a **${YEAR_START}**, el estado actual de Xalapa.`, attachments: [] };
    }

    if (e.scenario && e.scenario !== s.scenario) store.set({ scenario: e.scenario });
    const scenario = e.scenario ?? s.scenario;
    const target = e.years.length ? e.years[e.years.length - 1] : YEAR_END;
    const wantsPlay = /\b(simula\w*|reproduc\w*|play|anima\w*|avanza|corre|ejecuta|proyecta\w*)\b/.test(n);
    const from = store.get().year;

    let how: string;
    if (wantsPlay && target > from + 0.5) {
      this.playUntil(target);
      how = `Reproduciendo de ${Math.round(from)} a **${target}**`;
    } else if (wantsPlay && target <= from + 0.5 && !e.years.length) {
      store.set({ year: YEAR_START });
      this.playUntil(YEAR_END);
      how = `Reiniciando y reproduciendo ${YEAR_START}→${YEAR_END}`;
    } else {
      this.cancelPlayback();
      store.set({ year: target, playing: false });
      how = `Salté a **${target}**`;
    }
    this.setLayer('growth');

    const hist = sim.history();
    const h0 = hist[0];
    const ht = hist.find((m) => m.year === Math.round(target)) ?? hist[hist.length - 1];
    const dPop = ((ht.population - h0.population) / Math.max(1, h0.population)) * 100;
    const dArea = ((ht.urbanAreaKm2 - h0.urbanAreaKm2) / Math.max(0.01, h0.urbanAreaKm2)) * 100;
    const v = SCENARIO_VERDICT[scenario];
    const tail =
      scenario === 'descontrolado'
        ? 'La expansión dispersa encarece servicios, alarga traslados y presiona zonas de recarga y riesgo de inundación.'
        : scenario === 'ordenado'
          ? 'La densificación de corredores contiene la mancha urbana y protege suelo de conservación.'
          : 'Si nada cambia, la ciudad sigue extendiéndose por sus bordes con densidades bajas.';

    return {
      intent: 'simular',
      text:
        `${how} en escenario **${SCENARIO_NAME[scenario]}**. Para ${ht.year} MVIA proyecta **${int(ht.population)} habitantes** (+${dec(dPop, 0)}%) ` +
        `y **${dec(ht.urbanAreaKm2)} km²** urbanizados (+${dec(dArea, 0)}%), con ${int(ht.greenLossHa)} ha de área verde perdida.\n${tail}`,
      attachments: [
        {
          kind: 'kpis',
          title: `PROYECCIÓN ${ht.year} · ${scenario.toUpperCase()}`,
          rows: [
            ['Población', int(ht.population)],
            ['Área urbana', `${dec(ht.urbanAreaKm2)} km²`],
            ['Valor medio del suelo', `${mxn(ht.avgLandValue)}/m²`],
            ['Índice de dispersión', dec(ht.sprawlIndex, 2)],
            ['Pérdida verde acumulada', `${int(ht.greenLossHa)} ha`],
            ['Déficit de vivienda', int(ht.housingDeficit)],
            ['Riesgo de impago', dec(ht.creditDefaultRisk, 2)],
          ],
        },
        { kind: 'verdicts', items: [{ verdict: v, label: `${VERDICT_LABEL[v]} · ${SCENARIO_NAME[scenario]}` }] },
        {
          kind: 'actions',
          items: [
            { label: `Vista dividida ${YEAR_START} | ${ht.year}`, icon: 'layer', run: () => this.ctx.store.set({ compare: true, compareYear: YEAR_START }) },
            this.actAsk('¿Hacia dónde crece?', '¿Hacia dónde crece Xalapa?'),
          ],
        },
      ],
    };
  }

  private playUntil(target: number): void {
    const { store } = this.ctx;
    this.cancelPlayback();
    store.set({ playing: true, compare: false });
    const unsub = store.subscribe(
      (s, changed) => {
        if (changed.includes('playing') && !s.playing) {
          this.cancelPlayback();
          return;
        }
        if (s.year >= target - 1e-3) {
          this.cancelPlayback();
          store.set({ playing: false, year: target });
        }
      },
      ['year', 'playing'],
    );
    this.stopPlayback = unsub;
  }

  private cancelPlayback(): void {
    const f = this.stopPlayback;
    this.stopPlayback = null;
    f?.();
  }

  private hipoteca(p: Parsed): Reply {
    const { sim, store } = this.ctx;
    const e = p.entities;
    const zs = this.zoneOf(p, e.zones.length > 0);
    const sel = store.get().selection;
    const rawCell = sel ? sel.cellIndex : zs ? sim.cellIndexAt(zs.zone.center.x, zs.zone.center.z) : -1;
    const cellIndex = rawCell >= 0 ? rawCell : undefined;

    const money = [...e.money].sort((a, b) => b - a);
    const price = money[0] ?? (zs ? Math.round(zs.landValue * 120 + 95 * 13_500) : 2_000_000);
    let down = price * 0.1;
    const pctDown = e.percents.find((v) => v > 0 && v <= 90);
    if (pctDown !== undefined) down = (price * pctDown) / 100;
    else if (money.length >= 2) down = money[money.length - 1];
    const years = Math.min(30, Math.max(5, e.plazoYears ?? 20));
    const product = e.product ?? undefined;

    const q = sim.mortgageQuote({ price, downPayment: down, years, cellIndex, product });
    const where = sel ? ' en el punto seleccionado' : zs ? ` en **${zs.zone.name}**` : '';
    const verdict: Verdict = q.risk === 'bajo' ? 'viable' : q.risk === 'medio' ? 'observar' : 'riesgo';
    const plazos = [10, 15, 20, 25, 30].map((y) => ({ y, q: sim.mortgageQuote({ price, downPayment: down, years: y, cellIndex, product }) }));
    if (cellIndex !== undefined) this.setLayer('mortgage');

    return {
      intent: 'hipoteca',
      text:
        `Para una vivienda de **${mxnBig(price)}**${where} con enganche de **${mxnBig(down)}** (${pct((down / price) * 100, 0)}) a **${years} años**: ` +
        `mensualidad estimada de **${mxn(q.monthlyPayment)}** a una tasa de **${pct(q.rate, 2)}** (CAT ${pct(q.cat, 1)}).\n` +
        `Necesitas un ingreso mensual comprobable de ≈ **${mxn(q.requiredIncome)}**. Pagarías ${mxnBig(q.totalPaid)} en total ` +
        `(${dec(q.totalPaid / Math.max(1, q.principal), 2)}× lo financiado); riesgo **${q.risk}** con producto ${q.product}.`,
      attachments: [
        {
          kind: 'kpis',
          title: `COTIZACIÓN · ${q.product.toUpperCase()}`,
          rows: [
            ['Monto financiado', mxn(q.principal)],
            ['Tasa anual', pct(q.rate, 2)],
            ['CAT', pct(q.cat, 1)],
            ['Plazo', `${q.years} años`],
            ['Mensualidad', mxn(q.monthlyPayment)],
            ['Pago total', mxn(q.totalPaid)],
            ['Ingreso requerido', `${mxn(q.requiredIncome)}/mes`],
            ['Aforo (LTV)', pct(q.ltv * 100, 0)],
          ],
        },
        {
          kind: 'bars',
          title: 'MENSUALIDAD POR PLAZO',
          items: plazos.map(({ y, q: qq }) => ({ label: `${y} años`, value: qq.monthlyPayment, display: mxn(qq.monthlyPayment), accent: y === years })),
        },
        { kind: 'verdicts', items: [{ verdict, label: `RIESGO ${q.risk.toUpperCase()}` }] },
        {
          kind: 'actions',
          items: [
            this.actLayer('mortgage', 'Ver tasas'),
            this.actAsk('Cotizar con Infonavit', `Hipoteca Infonavit de ${Math.round(price)} pesos a ${years} años con ${Math.round((down / price) * 100)}% de enganche`),
          ],
        },
      ],
    };
  }

  private riesgo(): Reply {
    const sim = this.ctx.sim;
    const top = sim.topZones('creditRisk', 5);
    const safe = sim.topZones('creditRisk', 3, true);
    const m = sim.metrics();
    if (!top.length) return this.fallback();
    this.setLayer('creditRisk');
    this.flyZone(top[0], 0.48);
    this.memory.zoneId = top[0].zone.id;
    return {
      intent: 'riesgo',
      text:
        `El riesgo de impago promedio de la ciudad es **${dec(m.creditDefaultRisk, 2)}** (${riskLabel(m.creditDefaultRisk)}) y la tasa hipotecaria mediana **${pct(m.medianMortgageRate, 2)}**. ` +
        `Las zonas más expuestas son ${top.slice(0, 3).map((z) => `**${z.zone.name}** (${dec(z.creditRisk, 2)})`).join(', ')}: periferia con ingreso informal y servicios incompletos.\n` +
        `Cartera más sana: ${safe.map((z) => `**${z.zone.name}**`).join(', ')}.`,
      attachments: [
        this.bars('RIESGO CREDITICIO (0–1)', top, (z) => z.creditRisk, (v) => dec(v, 2)),
        { kind: 'verdicts', items: top.slice(0, 3).map((z) => ({ verdict: z.verdict, label: `${VERDICT_LABEL[z.verdict]} · ${z.zone.name}` })) },
        { kind: 'actions', items: [this.actFly(`Ver ${top[0].zone.name}`, top[0].zone.center.x, top[0].zone.center.z), this.actLayer('creditRisk')] },
      ],
    };
  }

  private siteKpis(ev: SiteEvaluation, title: string): Attachment {
    return {
      kind: 'kpis',
      title,
      rows: [
        ['Score MVIA', `${Math.round(ev.score)}/100`],
        ['Inversión', mxnBig(ev.investment)],
        ['Superficie', `${int(ev.areaM2)} m²`],
        ['Afluencia', `${int(ev.footfall)}/día`],
        ['Ingresos anuales', mxnBig(ev.annualRevenue)],
        ['ROI', pct(ev.roi)],
        ['Recuperación', `${dec(ev.paybackYears)} años`],
        ['Cap rate', pct(ev.capRate)],
      ],
    };
  }

  private comercio(p: Parsed): Reply {
    const sim = this.ctx.sim;
    const type: EstablishmentType = p.entities.establishment ?? this.memory.type ?? 'tienda';
    this.memory.type = type;
    const spec = sim.spec(type);
    const zs = p.entities.zones.length ? this.zoneOf(p) : null;

    if (zs) {
      const ev = sim.evaluateSite(type, zs.zone.center.x, zs.zone.center.z);
      this.memory.site = ev;
      this.fly(ev.pos.x, ev.pos.z, 0.7);
      this.setLayer('commercial');
      if (!ev.allowed) {
        return {
          intent: 'comercio',
          text: `No es posible ubicar ${ART[type]} **${spec.label.toLowerCase()}** en el centro de **${zs.zone.name}**: ${ev.reason ?? 'restricción de uso de suelo'}. Te sugiero buscar la mejor alternativa cercana.`,
          attachments: [{ kind: 'actions', items: [this.actAsk('Buscar mejores sitios', `¿Dónde abro ${ART[type]} ${spec.label.toLowerCase()}?`)] }],
        };
      }
      return {
        intent: 'comercio',
        text:
          `Evalué ${ART[type]} **${spec.label.toLowerCase()}** en **${zs.zone.name}**: score **${Math.round(ev.score)}/100**, veredicto **${VERDICT_TEXT[ev.verdict]}**. ` +
          `Inversión de ${mxnBig(ev.investment)}, afluencia ≈ ${int(ev.footfall)} visitantes/día, ROI **${pct(ev.roi)}** y recuperación en **${dec(ev.paybackYears)} años**.` +
          (ev.notes.length ? `\n${ev.notes.slice(0, 2).map((t) => `- ${t}`).join('\n')}` : ''),
        attachments: [
          this.siteKpis(ev, `${spec.short} · ${zs.zone.name.toUpperCase()}`),
          { kind: 'verdicts', items: [{ verdict: ev.verdict, label: `${VERDICT_LABEL[ev.verdict]} · score ${Math.round(ev.score)}` }] },
          { kind: 'actions', items: [this.actFly('Ver en mapa', ev.pos.x, ev.pos.z, 0.75), this.actBuild(type, ev.pos.x, ev.pos.z), this.actLayer('commercial')] },
        ],
      };
    }

    const sites = sim.suggestSites(type, 3).filter((s) => s.allowed);
    if (!sites.length) {
      return { intent: 'comercio', text: `No encontré sitios viables para ${ART[type]} **${spec.label.toLowerCase()}** en el año ${this.year}. Prueba con otro tipo de establecimiento o avanza la simulación.`, attachments: [] };
    }
    const best = sites[0];
    this.memory.site = best;
    const bestZone = sim.cell(best.cellIndex).zoneName;
    this.fly(best.pos.x, best.pos.z, 0.7);
    this.setLayer('commercial');
    const c = sim.cell(best.cellIndex);
    if (c.zoneId) this.memory.zoneId = c.zoneId;
    this.ctx.store.set({ selection: { kind: 'cell', id: String(best.cellIndex), point: { ...best.pos }, cellIndex: best.cellIndex } });

    return {
      intent: 'comercio',
      text:
        `Para ${ART[type]} **${spec.label.toLowerCase()}** la mejor ubicación está en **${bestZone}** con score **${Math.round(best.score)}/100** (${VERDICT_TEXT[best.verdict]}). ` +
        `Requiere ${mxnBig(best.investment)} para ${int(best.areaM2)} m²; afluencia ≈ ${int(best.footfall)}/día, ingresos de ${mxnBig(best.annualRevenue)} al año, ` +
        `ROI **${pct(best.roi)}** y recuperación en **${dec(best.paybackYears)} años**.` +
        (best.notes.length ? `\n${best.notes.slice(0, 2).map((t) => `- ${t}`).join('\n')}` : ''),
      attachments: [
        this.siteKpis(best, `${spec.short} · ${bestZone.toUpperCase()}`),
        {
          kind: 'bars',
          title: 'SITIOS CANDIDATOS · SCORE',
          items: sites.map((s, i) => ({ label: sim.cell(s.cellIndex).zoneName || `Sitio ${i + 1}`, value: s.score, display: `${Math.round(s.score)}`, accent: i === 0, verdict: s.verdict })),
        },
        { kind: 'verdicts', items: sites.map((s, i) => ({ verdict: s.verdict, label: `#${i + 1} ${VERDICT_LABEL[s.verdict]}` })) },
        { kind: 'actions', items: [this.actFly('Ver en mapa', best.pos.x, best.pos.z, 0.75), this.actBuild(type, best.pos.x, best.pos.z), this.actLayer('commercial')] },
      ],
    };
  }

  private actBuild(type: EstablishmentType, x: number, z: number): ChatAction {
    return { label: 'Construir aquí', icon: 'build', run: () => this.buildAt(type, x, z) };
  }

  /** places an establishment and reports the evaluation */
  buildAt(type: EstablishmentType, x: number, z: number): Reply {
    const { sim, store, bus } = this.ctx;
    const spec = sim.spec(type);
    const est = sim.placeEstablishment(type, x, z, 'mvia');
    if (!est) {
      const ev = sim.evaluateSite(type, x, z);
      return {
        intent: 'construir',
        text: `No pude construir ${ART[type]} **${spec.label.toLowerCase()}** ahí: ${ev.reason ?? 'el sitio no cumple las restricciones de uso de suelo'}. Busco una alternativa si me lo pides.`,
        attachments: [{ kind: 'verdicts', items: [{ verdict: 'riesgo', label: 'NO PERMITIDO' }] }, { kind: 'actions', items: [this.actAsk('Buscar alternativa', `¿Dónde abro ${ART[type]} ${spec.label.toLowerCase()}?`)] }],
      };
    }
    const zoneName = sim.cell(est.cellIndex).zoneName;
    store.set({ selection: { kind: 'establishment', id: est.id, point: { ...est.pos }, cellIndex: est.cellIndex } });
    this.fly(est.pos.x, est.pos.z, 0.78);
    bus.emit('ui:toast', { text: `${est.name} · ${zoneName}`, kind: est.verdict === 'riesgo' ? 'risk' : est.verdict === 'precaucion' ? 'warn' : 'ok' });
    this.memory.site = est;
    const total = sim.metrics().investmentPipeline;
    return {
      intent: 'construir',
      text:
        `Listo: coloqué **${est.name}** en **${zoneName}** (${est.year}). Score **${Math.round(est.score)}/100**, veredicto **${VERDICT_TEXT[est.verdict]}**. ` +
        `Inversión de ${mxnBig(est.investment)} con ROI de ${pct(est.roi)} y recuperación en ${dec(est.paybackYears)} años. ` +
        `La cartera de inversión simulada suma ${mxnBig(total)}.`,
      attachments: [
        this.siteKpis(est, `${spec.short} · ${zoneName.toUpperCase()}`),
        { kind: 'verdicts', items: [{ verdict: est.verdict, label: `${VERDICT_LABEL[est.verdict]} · ${spec.label}` }] },
        { kind: 'actions', items: [this.actFly('Ver en mapa', est.pos.x, est.pos.z, 0.8), { label: 'Deshacer', icon: 'build', run: () => this.undoBuild(est.id, est.name) }] },
      ],
    };
  }

  private undoBuild(id: string, name: string): Reply {
    this.ctx.sim.removeEstablishment(id);
    const sel = this.ctx.store.get().selection;
    if (sel && sel.kind === 'establishment' && sel.id === id) this.ctx.store.set({ selection: null });
    return { intent: 'construir', text: `Retiré **${name}** del modelo.`, attachments: [] };
  }

  private construir(p: Parsed): Reply {
    const { sim, store } = this.ctx;
    const type = p.entities.establishment ?? this.memory.type;
    if (!type) {
      return {
        intent: 'construir',
        text: '¿Qué quieres construir? Puedo colocar una **plaza**, **plazoleta**, **tienda**, **supermercado**, **centro comercial**, **vivienda** u **oficinas**.',
        attachments: [{ kind: 'actions', items: [this.actAsk('Plazoleta en El Olmo', 'Construye una plazoleta en El Olmo', 'build')] }],
      };
    }
    this.memory.type = type;
    const sel = store.get().selection;
    let x: number;
    let z: number;
    const zs = p.entities.zones.length ? this.zoneOf(p) : null;
    if (zs) {
      x = zs.zone.center.x;
      z = zs.zone.center.z;
    } else if (sel && /\b(aqui|ahi|alli|este|esta|seleccion)\b/.test(p.norm)) {
      x = sel.point.x;
      z = sel.point.z;
    } else if (this.memory.site) {
      x = this.memory.site.pos.x;
      z = this.memory.site.pos.z;
    } else if (sel) {
      x = sel.point.x;
      z = sel.point.z;
    } else {
      const best = sim.suggestSites(type, 1)[0];
      if (!best) return { intent: 'construir', text: 'No encontré un sitio permitido para ese establecimiento.', attachments: [] };
      x = best.pos.x;
      z = best.pos.z;
    }
    return this.buildAt(type, x, z);
  }

  private capas(p: Parsed): Reply {
    const { store } = this.ctx;
    const n = p.norm;
    const e = p.entities;
    const off = /\b(desactiva|apaga|quita|oculta|sin|cierra|deshabilita)\b/.test(n);
    const done: string[] = [];
    const patch: Parameters<typeof store.set>[0] = {};

    if (/\b(lente|lens|vision de maquina|vision mvia)\b/.test(n)) {
      patch.lens = !off;
      done.push(off ? 'desactivé el **lente de visión MVIA**' : 'activé el **lente de visión MVIA**: mueve el cursor para revelar la lectura de profundidad');
    }
    if (/\b(vista dividida|pantalla dividida|split)\b/.test(n)) {
      patch.compare = !off;
      if (!off) patch.compareYear = YEAR_START;
      done.push(off ? 'cerré la vista dividida' : `abrí la **vista dividida** (${YEAR_START} | año actual)`);
    }
    if (/\bedificios\b/.test(n)) {
      patch.showBuildings = !off;
      done.push(off ? 'oculté los edificios' : 'mostré los edificios');
    }
    if (/\btrafico\b/.test(n)) {
      patch.showTraffic = !off;
      done.push(off ? 'oculté el tráfico' : 'activé el tráfico');
    }
    if (/\betiquetas\b/.test(n)) {
      patch.showLabels = !off;
      done.push(off ? 'oculté las etiquetas' : 'mostré las etiquetas');
    }
    if (e.mapStyle) {
      patch.mapStyle = e.mapStyle;
      done.push(`cambié el mapa a **${STYLE_NAME[e.mapStyle]}**`);
    }
    if (e.layer && !(e.layer === 'landValue' && e.mapStyle && !/\b(valor|precio|plusvalia)\b/.test(n))) {
      const layer = off && e.layer !== 'none' ? 'none' : e.layer;
      patch.layer = layer;
      done.push(layer === 'none' ? 'quité la capa analítica' : `activé la capa de **${LAYER_NAME[layer]}**. ${LAYER_LEGEND[layer].replace(/\.$/, '')}`);
    }
    if (!done.length) {
      return {
        intent: 'capas',
        text:
          'Puedo cambiar el estilo del mapa (**clay**, **satelital**, **scan**, **noche**) o activar capas: ' +
          Object.entries(LAYER_NAME)
            .filter(([k]) => k !== 'none')
            .map(([, v]) => `**${v}**`)
            .join(', ') +
          '. ¿Cuál quieres ver?',
        attachments: [
          {
            kind: 'actions',
            items: [this.actLayer('floodRisk', 'Capa'), this.actLayer('landValue', 'Capa'), { label: 'Vista satelital', icon: 'layer', run: () => this.ctx.store.set({ mapStyle: 'satellite' }) }],
          },
        ],
      };
    }
    store.set(patch);
    const text = done.map((d, i) => (i === 0 ? d.charAt(0).toUpperCase() + d.slice(1) : d)).join('; ') + '.';
    return { intent: 'capas', text, attachments: [] };
  }

  private ubicar(p: Parsed): Reply {
    const { sim, store } = this.ctx;
    const lmId = p.entities.landmarkIds[0];
    const preferLandmark = !!lmId && (p.entities.landmarkExplicit || !p.entities.zones.length);
    const lm = preferLandmark ? sim.mapData.landmarks.find((l) => l.id === lmId) : undefined;
    if (lm) {
      const idx = sim.cellIndexAt(lm.pos.x, lm.pos.z);
      const zoneName = idx >= 0 ? sim.cell(idx).zoneName : '';
      const zoom = lm.kind === 'cerro' ? 0.55 : 0.78;
      this.fly(lm.pos.x, lm.pos.z, zoom, 60);
      store.set({ selection: { kind: 'landmark', id: lm.id, point: { ...lm.pos }, cellIndex: idx } });
      return {
        intent: 'ubicar',
        text: `Volando a **${lm.name}**${zoneName ? ` (${zoneName})` : ''}. ${lm.description} Elevación ≈ ${int(elevationAt(lm.pos.x, lm.pos.z))} msnm.`,
        attachments: [{ kind: 'actions', items: [this.actFly('Centrar de nuevo', lm.pos.x, lm.pos.z, zoom), this.actAsk('Analizar este punto', 'Analiza esta zona')] }],
      };
    }
    const zs = this.zoneOf(p, false);
    if (zs) {
      this.flyZone(zs, 0.62);
      this.selectZone(zs);
      return {
        intent: 'ubicar',
        text: `Volando a **${zs.zone.name}**. ${zs.zone.description} Suelo en ${mxn(zs.landValue)}/m², veredicto **${VERDICT_TEXT[zs.verdict]}**.`,
        attachments: [this.zoneKpis(zs), { kind: 'actions', items: [this.actAsk('¿Cuánto vale?', `¿Cuánto vale el m² en ${zs.zone.name}?`), this.actAsk('¿Su riesgo?', `Riesgo crediticio en ${zs.zone.name}`)] }],
      };
    }
    const examples = sim.mapData.landmarks.slice(0, 4).map((l) => `**${l.name}**`);
    return {
      intent: 'ubicar',
      text: `No ubiqué ese lugar en el modelo. Prueba con una colonia o un hito${examples.length ? `, por ejemplo ${examples.join(', ')}` : ''}.`,
      attachments: [],
    };
  }

  private metricas(): Reply {
    const { sim, store } = this.ctx;
    const m = sim.metrics();
    const hist = sim.history();
    const last = hist[hist.length - 1];
    const s = store.get();
    return {
      intent: 'metricas',
      text:
        `Resumen de Xalapa en **${m.year}** (escenario ${SCENARIO_NAME[s.scenario]}): **${int(m.population)} habitantes** en **${dec(m.urbanAreaKm2)} km²** urbanizados, ` +
        `suelo promedio de **${mxn(m.avgLandValue)}/m²** y tasa hipotecaria mediana de ${pct(m.medianMortgageRate, 2)}. ` +
        `Hacia ${YEAR_END} el modelo anticipa ${int(last.population)} habitantes y un déficit de ${int(last.housingDeficit)} viviendas.`,
      attachments: [
        {
          kind: 'kpis',
          title: `XALAPA · ${m.year}`,
          rows: [
            ['Población', int(m.population)],
            ['Área urbana', `${dec(m.urbanAreaKm2)} km²`],
            ['Valor medio del suelo', `${mxn(m.avgLandValue)}/m²`],
            ['Tasa hipotecaria mediana', pct(m.medianMortgageRate, 2)],
            ['Riesgo de impago', `${dec(m.creditDefaultRisk, 2)} · ${riskLabel(m.creditDefaultRisk)}`],
            ['Índice de dispersión', dec(m.sprawlIndex, 2)],
            ['Pérdida verde', `${int(m.greenLossHa)} ha`],
            ['Déficit de vivienda', int(m.housingDeficit)],
            ['Establecimientos', int(m.commercialCount)],
            ['Inversión simulada', mxnBig(m.investmentPipeline)],
          ],
        },
        { kind: 'line', title: `POBLACIÓN · ${YEAR_START}→${YEAR_END}`, values: hist.map((h) => h.population), from: String(YEAR_START), to: String(YEAR_END), fmt: (v) => int(v) },
      ],
    };
  }

  private voz(p: Parsed): Reply {
    const { store, bus } = this.ctx;
    const n = p.norm;
    if (/\b(silencio|callate|calla|deja de hablar|para de hablar|mute|silencia)\b/.test(n)) {
      bus.emit('voice:stop', {});
      if (/\b(siempre|desactiva|ya no|modo silencio|sin voz)\b/.test(n)) store.set({ voiceAuto: false });
      return { intent: 'voz', text: store.get().voiceAuto ? 'Silencio. Sigo respondiendo con voz en los próximos mensajes.' : 'Voz desactivada; responderé solo por texto.', attachments: [], silent: true };
    }
    if (/\b(estudio|voice studio|cambia (la|de) voz|configura (la )?voz|sintetizador|otra voz)\b/.test(n)) {
      store.set({ voiceOpen: true });
      return { intent: 'voz', text: 'Abrí el **Voice Studio**: ahí puedes elegir voz, velocidad y tono de MVIA.', attachments: [], silent: true };
    }
    if (/\b(desactiva|apaga|sin) (la )?voz\b/.test(n)) {
      bus.emit('voice:stop', {});
      store.set({ voiceAuto: false });
      return { intent: 'voz', text: 'Voz automática desactivada.', attachments: [], silent: true };
    }
    if (/\b(activa|enciende|con) (la )?voz\b/.test(n)) {
      store.set({ voiceAuto: true });
      return { intent: 'voz', text: 'Voz automática activada: leeré en voz alta cada respuesta.', attachments: [] };
    }
    const last = this.memory.lastReplyText;
    if (!last) return { intent: 'voz', text: 'Aún no tengo una respuesta que leer. Pregúntame algo primero.', attachments: [], silent: true };
    return { intent: 'voz', text: 'Leyendo la última respuesta…', attachments: [], silent: true, speak: last };
  }

  private inspeccion(): Reply {
    const { sim, store } = this.ctx;
    const sel = store.get().selection;
    if (!sel || sel.cellIndex < 0) {
      return {
        intent: 'inspeccion',
        text: 'No hay nada seleccionado. Haz **clic en el mapa** sobre cualquier punto y vuelve a pedirme "analiza esta zona".',
        attachments: [],
      };
    }
    const reading = sim.readCell(sel.cellIndex);
    const cell = sim.cell(sel.cellIndex);
    if (cell.zoneId) this.memory.zoneId = cell.zoneId;
    const { x, z } = cell.center;
    // best establishment type for this exact point
    const evals = sim
      .specs()
      .map((s) => sim.evaluateSite(s.type, x, z))
      .filter((ev) => ev.allowed)
      .sort((a, b) => b.score - a.score);
    const best = evals[0];
    const bestSpec = best ? sim.spec(best.type) : null;
    return {
      intent: 'inspeccion',
      text:
        `**${reading.title}** — ${reading.summary}` +
        (bestSpec && best ? `\nMejor uso comercial del punto: **${bestSpec.label.toLowerCase()}** (score ${Math.round(best.score)}/100, ROI ${pct(best.roi)}).` : '') +
        (reading.footer ? `\n${reading.footer}` : ''),
      attachments: [
        { kind: 'kpis', title: `CELDA ${cell.i}·${cell.j} · ${cell.zoneName.toUpperCase()}`, rows: reading.rows },
        { kind: 'verdicts', items: [{ verdict: reading.verdict, label: `${VERDICT_LABEL[reading.verdict]} · ${reading.title}` }] },
        {
          kind: 'actions',
          items: [this.actFly('Ver en mapa', x, z, 0.8), ...(best ? [this.actBuild(best.type, x, z)] : [])],
        },
      ],
    };
  }

  fallback(): Reply {
    return {
      intent: 'fallback',
      text:
        'No estoy seguro de haber entendido. Puedo analizar **valor de suelo**, **crecimiento urbano**, **hipotecas**, **riesgo crediticio** y **sitios comerciales** de Xalapa. ' +
        'Prueba con alguna de estas preguntas:',
      attachments: [{ kind: 'actions', items: SUGGESTIONS.slice(0, 4).map((q) => this.actAsk(q, q)) }],
    };
  }
}
