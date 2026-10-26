/**
 * MVIA Voice — personas, models and persisted studio settings.
 * Settings live in localStorage ('mvia.voice.settings'); the optional ElevenLabs key in 'mvia.elevenKey'.
 */

export type PersonaId = 'core' | 'valeria' | 'mateo' | 'sofia' | 'diego';
export type ModelId =
  | 'mvia_multilingual_v2'
  | 'mvia_turbo_v2_5'
  | 'eleven_multilingual_v2'
  | 'eleven_turbo_v2_5'
  | 'eleven_flash_v2_5';
export type Gender = 'f' | 'm';

export interface Persona {
  id: PersonaId;
  name: string;
  /** short descriptor shown on the card */
  tagline: string;
  /** BCP-47 the persona "speaks" */
  lang: string;
  gender: Gender;
  /** system voice name fragments in order of preference (Edge natural first, then OS voices) */
  voiceNames: string[];
  /** base prosody applied on top of the studio sliders */
  pitch: number;
  rate: number;
  /** avatar gradient stops */
  colors: [string, string, string];
  /** branded synthetic persona → adds the WebAudio signature layer */
  synthetic?: boolean;
}

export const PERSONAS: Persona[] = [
  {
    id: 'core',
    name: 'MVIA Core',
    tagline: 'Sintética · voz de marca',
    lang: 'es-MX',
    gender: 'm',
    voiceNames: ['Jorge', 'Raul', 'Raúl', 'Juan', 'Alonso', 'Alvaro', 'Álvaro', 'Pablo'],
    pitch: 0.82,
    rate: 0.97,
    colors: ['#061a26', '#14627f', '#4fd1ff'],
    synthetic: true,
  },
  {
    id: 'valeria',
    name: 'Valeria',
    tagline: 'es-MX · narradora',
    lang: 'es-MX',
    gender: 'f',
    voiceNames: ['Dalia', 'Renata', 'Sabina', 'Paulina', 'Larissa', 'Marina', 'Paloma', 'Google español de Estados Unidos'],
    pitch: 1.04,
    rate: 0.98,
    colors: ['#ff6a2b', '#ff9a8b', '#ffd36e'],
  },
  {
    id: 'mateo',
    name: 'Mateo',
    tagline: 'es-MX · analista',
    lang: 'es-MX',
    gender: 'm',
    voiceNames: ['Jorge', 'Gerardo', 'Cecilio', 'Raul', 'Raúl', 'Juan', 'Liberto'],
    pitch: 0.97,
    rate: 1.04,
    colors: ['#3b5bfd', '#5ab0ff', '#b9f1ff'],
  },
  {
    id: 'sofia',
    name: 'Sofía',
    tagline: 'es-ES · peninsular',
    lang: 'es-ES',
    gender: 'f',
    voiceNames: ['Elvira', 'Ximena', 'Helena', 'Laura', 'Mónica', 'Monica', 'Abril', 'Google español'],
    pitch: 1.05,
    rate: 1.0,
    colors: ['#7d1d3f', '#d04a2f', '#f2c879'],
  },
  {
    id: 'diego',
    name: 'Diego',
    tagline: 'es-US · neutro',
    lang: 'es-US',
    gender: 'm',
    voiceNames: ['Alonso', 'Google español de Estados Unidos', 'Jorge', 'Juan', 'Pablo'],
    pitch: 0.93,
    rate: 1.0,
    colors: ['#0a3d22', '#3ddc84', '#d9ffe9'],
  },
];

export function persona(id: string | undefined): Persona {
  return PERSONAS.find((p) => p.id === id) ?? PERSONAS[1];
}

export interface ModelInfo {
  id: ModelId;
  label: string;
  engine: 'browser' | 'eleven';
  note: string;
}

export const MODELS: ModelInfo[] = [
  { id: 'mvia_multilingual_v2', label: 'MVIA Multilingual v2', engine: 'browser', note: 'Voz neural del navegador · prosodia completa' },
  { id: 'mvia_turbo_v2_5', label: 'MVIA Turbo v2.5', engine: 'browser', note: 'Baja latencia · fragmentos largos, sin pausas extra' },
  { id: 'eleven_multilingual_v2', label: 'Eleven Multilingual v2 (API)', engine: 'eleven', note: 'ElevenLabs · máxima calidad, requiere clave' },
  { id: 'eleven_turbo_v2_5', label: 'Eleven Turbo v2.5 (API)', engine: 'eleven', note: 'ElevenLabs · rápido y multilingüe, requiere clave' },
  { id: 'eleven_flash_v2_5', label: 'Eleven Flash v2.5 (API)', engine: 'eleven', note: 'ElevenLabs · ultra baja latencia, requiere clave' },
];

export function modelInfo(id: string): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

/** A few ElevenLabs premade voices that handle Spanish well with the multilingual models. */
export const ELEVEN_PREMADE: Array<{ id: string; name: string }> = [
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George · narrador' },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah · cálida' },
  { id: 'FGY2WhTYpPnrIDTdsKH5', name: 'Laura · enérgica' },
  { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel · noticiero' },
  { id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda · amable' },
  { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian · profundo' },
];
export const DEFAULT_ELEVEN_VOICE = ELEVEN_PREMADE[0].id;

export interface VoiceSettings {
  personaId: PersonaId;
  /** voiceURI of a system voice that overrides the persona mapping ('' = automatic) */
  systemVoice: string;
  model: ModelId;
  /** 0..1 */
  stability: number;
  /** 0..1 */
  similarity: number;
  /** 0..1 style exaggeration */
  style: number;
  /** 0.7..1.2 */
  speed: number;
  speakerBoost: boolean;
  /** MVIA Core chime + ring-mod hum */
  coreSignature: boolean;
  elevenVoiceId: string;
}

export const DEFAULT_SETTINGS: VoiceSettings = {
  personaId: 'valeria',
  systemVoice: '',
  model: 'mvia_multilingual_v2',
  stability: 0.5,
  similarity: 0.75,
  style: 0,
  speed: 1,
  speakerBoost: true,
  coreSignature: true,
  elevenVoiceId: DEFAULT_ELEVEN_VOICE,
};

const SETTINGS_KEY = 'mvia.voice.settings';
const KEY_KEY = 'mvia.elevenKey';

const clamp = (v: unknown, lo: number, hi: number, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;

export function loadSettings(): VoiceSettings {
  const d = DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...d };
    const p = JSON.parse(raw) as Partial<Record<keyof VoiceSettings, unknown>>;
    return {
      personaId: PERSONAS.some((x) => x.id === p.personaId) ? (p.personaId as PersonaId) : d.personaId,
      systemVoice: typeof p.systemVoice === 'string' ? p.systemVoice : d.systemVoice,
      model: MODELS.some((m) => m.id === p.model) ? (p.model as ModelId) : d.model,
      stability: clamp(p.stability, 0, 1, d.stability),
      similarity: clamp(p.similarity, 0, 1, d.similarity),
      style: clamp(p.style, 0, 1, d.style),
      speed: clamp(p.speed, 0.7, 1.2, d.speed),
      speakerBoost: typeof p.speakerBoost === 'boolean' ? p.speakerBoost : d.speakerBoost,
      coreSignature: typeof p.coreSignature === 'boolean' ? p.coreSignature : d.coreSignature,
      elevenVoiceId: typeof p.elevenVoiceId === 'string' && p.elevenVoiceId.trim() ? p.elevenVoiceId.trim() : d.elevenVoiceId,
    };
  } catch {
    return { ...d };
  }
}

export function saveSettings(s: VoiceSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable (private mode / quota) — settings stay in memory */
  }
}

export function loadElevenKey(): string {
  try {
    return localStorage.getItem(KEY_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveElevenKey(key: string): void {
  try {
    if (key) localStorage.setItem(KEY_KEY, key);
    else localStorage.removeItem(KEY_KEY);
  } catch {
    /* ignore */
  }
}
