import type { Persona, VoiceSettings } from '../settings';

export type EngineId = 'browser' | 'eleven';

/** One in-flight utterance (any engine). Polled once per animation frame by the controller. */
export interface Playback {
  readonly engine: EngineId;
  /** human label of the actual voice used, e.g. "Microsoft Dalia Online (Natural)" */
  readonly voiceLabel: string;
  /** resolves when playback ends: true = finished naturally, false = stopped / failed */
  readonly done: Promise<boolean>;
  /** true once audio actually started (first utterance started / buffer playing) */
  readonly started: boolean;
  /** advance internal envelopes; dt in seconds */
  tick(dt: number): void;
  /** current loudness 0..1 */
  level(): number;
  /** fill `out` with per-band energies 0..1 (small live spectrum for the pill) */
  bands(out: Float32Array, t: number): void;
  /** 0..1 */
  progress(): number;
  /** seconds since start */
  elapsed(): number;
  /** seconds (estimated for the browser engine, exact for API audio) */
  duration(): number;
  /** full-clip waveform peaks if known (API audio), else null */
  peaks(): Float32Array | null;
  stop(): void;
}

export interface SpeakRequest {
  /** already normalised (toSpeakable) text */
  text: string;
  settings: VoiceSettings;
  persona: Persona;
}
