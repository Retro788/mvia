import type { EstablishmentType, LayerId, MapStyle, ScenarioId, Verdict } from '../core/types';

/** Rich blocks rendered under an MVIA message. */
export type Attachment =
  | { kind: 'kpis'; title?: string; rows: Array<[string, string]> }
  | { kind: 'bars'; title?: string; items: BarItem[] }
  | { kind: 'line'; title?: string; values: number[]; from: string; to: string; fmt: (v: number) => string }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'verdicts'; items: Array<{ verdict: Verdict; label: string }> }
  | { kind: 'actions'; items: ChatAction[] };

export interface BarItem {
  label: string;
  value: number;
  display: string;
  accent?: boolean;
  verdict?: Verdict;
}

export type ActionIcon = 'map' | 'layer' | 'build' | 'play' | 'voice' | 'info';

export interface ChatAction {
  label: string;
  icon: ActionIcon;
  /** may return a follow-up reply that is appended as a new MVIA message */
  run: () => Reply | void;
}

export interface Reply {
  text: string;
  attachments: Attachment[];
  intent: string;
  /** optional explicit speakable version; otherwise derived from `text` */
  speak?: string;
  /** never auto-speak this reply (e.g. voice commands) */
  silent?: boolean;
}

export type IntentId =
  | 'saludo'
  | 'ayuda'
  | 'about'
  | 'zona'
  | 'comparar'
  | 'ranking'
  | 'crecimiento'
  | 'simular'
  | 'hipoteca'
  | 'riesgo'
  | 'comercio'
  | 'construir'
  | 'capas'
  | 'ubicar'
  | 'metricas'
  | 'voz'
  | 'inspeccion'
  | 'gracias'
  | 'fallback';

export type ZoneAttr = 'precio' | 'riesgo' | 'plusvalia' | 'poblacion' | 'comercio' | 'inundacion' | 'hipoteca' | 'densidad';

/** Everything the NLU pulls out of a message. */
export interface Entities {
  zones: string[]; // zone ids in order of appearance
  landmarkIds: string[];
  /** landmark named in full or by its kind word (vs. a partial key shared with a colonia) */
  landmarkExplicit: boolean;
  years: number[];
  money: number[]; // MXN, in order of appearance
  percents: number[];
  plazoYears: number | null;
  establishment: EstablishmentType | null;
  scenario: ScenarioId | null;
  layer: LayerId | null;
  mapStyle: MapStyle | null;
  attrs: ZoneAttr[];
  product: 'bancario' | 'infonavit' | 'fovissste' | 'cofinavit' | null;
}

export interface Parsed {
  raw: string;
  norm: string;
  tokens: string[];
  entities: Entities;
  intent: IntentId;
  score: number;
  /** runner-up scores, for debugging / LLM routing */
  scores: Partial<Record<IntentId, number>>;
}
