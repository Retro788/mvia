/**
 * System voice catalogue (speechSynthesis) + persona → voice resolution.
 * getVoices() is empty until 'voiceschanged' on Chrome/Edge, and Safari never fires it, so we also poll.
 */
import type { Gender, Persona } from '../settings';

const FEMALE = [
  'dalia', 'sabina', 'paulina', 'monica', 'mónica', 'elvira', 'helena', 'laura', 'paloma', 'ximena', 'renata', 'larissa', 'beatriz',
  'marina', 'nuria', 'candela', 'carlota', 'abril', 'irene', 'estrella', 'triana', 'elena', 'lucia', 'lucía', 'sofia', 'sofía',
  'valentina', 'camila', 'isabela', 'catalina', 'salome', 'google español',
];
const MALE = [
  'jorge', 'raul', 'raúl', 'juan', 'pablo', 'alvaro', 'álvaro', 'alonso', 'gerardo', 'cecilio', 'dario', 'darío', 'diego', 'tomas',
  'tomás', 'liberto', 'arnau', 'enrique', 'carlos', 'andres', 'andrés', 'luciano', 'yago', 'saul', 'saúl', 'teo', 'rodrigo', 'mateo',
  'pelayo', 'gonzalo', 'emilio', 'federico', 'jose', 'josé',
];

const MALE_SET = new Set(MALE);
const FEMALE_SET = new Set(FEMALE);

export function guessGender(v: SpeechSynthesisVoice): Gender | null {
  const n = v.name.toLowerCase();
  // "Google español de Estados Unidos" & "Google español" are female voices
  if (n.startsWith('google español')) return 'f';
  const words = n.split(/[^\p{L}]+/u);
  if (words.some((w) => MALE_SET.has(w))) return 'm';
  if (words.some((w) => FEMALE_SET.has(w))) return 'f';
  return null;
}

export function isNatural(v: SpeechSynthesisVoice): boolean {
  return /natural|neural|online|premium|enhanced|mejorad/i.test(v.name);
}

/** Generic quality ranking of a voice for Spanish speech (independent of persona). */
export function qualityScore(v: SpeechSynthesisVoice): number {
  const lang = v.lang.replace('_', '-').toLowerCase();
  let s = 0;
  if (isNatural(v)) s += 40;
  if (lang === 'es-mx') s += 30;
  else if (lang === 'es-us') s += 22;
  else if (lang === 'es-es') s += 16;
  else if (lang.startsWith('es')) s += 10;
  else s -= 1000;
  if (/google/i.test(v.name)) s += 6; // network voices beat old SAPI ones
  return s;
}

export function isSpanish(v: SpeechSynthesisVoice): boolean {
  return v.lang.toLowerCase().startsWith('es');
}

export class VoiceCatalog {
  private list: SpeechSynthesisVoice[] = [];
  private listeners = new Set<() => void>();
  readonly supported: boolean;

  constructor() {
    this.supported = typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
    if (!this.supported) return;
    const synth = window.speechSynthesis;
    const refresh = () => {
      const v = synth.getVoices();
      if (v.length && (v.length !== this.list.length || v.some((x, i) => x.voiceURI !== this.list[i]?.voiceURI))) {
        this.list = v.slice();
        for (const fn of [...this.listeners]) fn();
      }
    };
    synth.addEventListener?.('voiceschanged', refresh);
    refresh();
    // Safari / some Linux builds never fire voiceschanged: poll briefly
    let tries = 0;
    const poll = window.setInterval(() => {
      refresh();
      if (++tries > 20 || this.list.length) window.clearInterval(poll);
    }, 250);
  }

  all(): SpeechSynthesisVoice[] {
    return this.list;
  }

  spanish(): SpeechSynthesisVoice[] {
    return this.list.filter(isSpanish).sort((a, b) => qualityScore(b) - qualityScore(a) || a.name.localeCompare(b.name));
  }

  byURI(uri: string): SpeechSynthesisVoice | null {
    return this.list.find((v) => v.voiceURI === uri || v.name === uri) ?? null;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Closest system voice for a persona. `similarity` (0..1) weights persona identity (preferred names,
   * accent, gender) against generic voice quality: at high similarity the persona's own voice wins even
   * if a "better" one exists; at low similarity the best-sounding Spanish voice is used.
   */
  resolve(p: Persona, similarity: number): SpeechSynthesisVoice | null {
    let best: SpeechSynthesisVoice | null = null;
    let bestScore = -Infinity;
    const plang = p.lang.toLowerCase();
    for (const v of this.list) {
      if (!isSpanish(v)) continue;
      const name = v.name.toLowerCase();
      const idx = p.voiceNames.findIndex((n) => name.includes(n.toLowerCase()));
      const nameMatch = idx < 0 ? 0 : 1 - idx * 0.08;
      const vlang = v.lang.replace('_', '-').toLowerCase();
      const langMatch = vlang === plang ? 1 : vlang.slice(0, 2) === plang.slice(0, 2) ? 0.35 : 0;
      const g = guessGender(v);
      const genderMatch = g === null ? 0.4 : g === p.gender ? 1 : 0;
      const identity = nameMatch * 55 + langMatch * 30 + genderMatch * 28;
      const score = qualityScore(v) * (1.15 - similarity * 0.75) + identity * (0.35 + similarity);
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    return best;
  }
}
