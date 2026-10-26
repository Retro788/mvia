/**
 * Synthetic loudness envelope for engines whose audio cannot be analysed (speechSynthesis).
 * Word 'boundary' events kick an exponentially-decaying pulse; a syllable-rate oscillator (~4.5 Hz,
 * scaled by speaking rate, slightly jittered) carves it into syllables. When a voice fires no
 * boundary events (many network voices) a slower word-rate oscillator stands in for the pulses.
 */
export class SpeechEnvelope {
  private pulse = 0;
  private phase = 0;
  private wordPhase = 0;
  private out = 0;
  private time = 0;
  private lastBoundary = -99;
  private seed = 1;
  private jitter = 0.5;
  private jitterTarget = 0.5;
  private jitterClock = 0;
  /** inside an utterance (false during inter-chunk gaps) */
  active = false;
  /** speaking-rate multiplier (1 = normal) */
  rate = 1;
  /** emphasis 0..1 (style exaggeration) — deepens the modulation */
  emphasis = 0;

  /** word boundary: longer words give a slightly stronger pulse */
  kick(wordLen: number): void {
    this.pulse = Math.min(1, 0.62 + Math.min(10, wordLen) * 0.04 + this.rand() * 0.12);
    this.lastBoundary = this.time;
    this.wordPhase = 0;
  }

  reset(): void {
    this.pulse = 0;
    this.out = 0;
    this.active = false;
    this.lastBoundary = -99;
  }

  private rand(): number {
    // xorshift32 — no allocations, deterministic
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x >>> 0 || 1;
    return (this.seed & 0xffff) / 0xffff;
  }

  tick(dt: number): number {
    this.time += dt;
    const TAU = Math.PI * 2;
    // random walk of the syllable rate (±15 %) so it never reads as a metronome
    this.jitterClock -= dt;
    if (this.jitterClock <= 0) {
      this.jitterClock = 0.12 + this.rand() * 0.2;
      this.jitterTarget = this.rand();
    }
    this.jitter += (this.jitterTarget - this.jitter) * Math.min(1, dt * 6);
    const sylHz = 4.4 * this.rate * (0.85 + this.jitter * 0.3);
    this.phase = (this.phase + dt * sylHz * TAU) % TAU;
    this.wordPhase += dt * 2.3 * this.rate;

    // |sin| raised to <1 → rounded syllable humps with short dips between them
    const syl = Math.pow(Math.abs(Math.sin(this.phase * 0.5)), 0.7);
    this.pulse *= Math.exp(-dt * (2.6 + this.rate));

    let target = 0;
    if (this.active) {
      const hasBoundaries = this.time - this.lastBoundary < 1.4;
      // without boundary events emulate word groups: dips every ~0.43 s
      const word = hasBoundaries
        ? 0.3 + 0.7 * this.pulse
        : 0.42 + 0.58 * Math.pow(Math.abs(Math.sin(this.wordPhase * Math.PI)), 0.45);
      const depth = 0.55 + this.emphasis * 0.3;
      target = word * (1 - depth + depth * syl) * (0.82 + this.jitter * 0.3);
    }
    // asymmetric smoothing: fast attack, slower release (like a VU meter)
    const k = target > this.out ? 22 : 9;
    this.out += (target - this.out) * (1 - Math.exp(-dt * k));
    return this.out;
  }

  level(): number {
    return Math.min(1, Math.max(0, this.out));
  }
}

/** Fill `out` with a plausible small spectrum from a scalar level (used by the pill when no analyser exists). */
export function bandsFromLevel(level: number, t: number, out: Float32Array): void {
  const n = out.length;
  for (let i = 0; i < n; i++) {
    const centre = 1 - Math.abs(i - (n - 1) / 2) / ((n + 1) / 2); // taller in the middle
    const wobble = 0.55 + 0.45 * Math.sin(t * (7.1 + i * 2.3) + i * 1.7) * Math.sin(t * (3.3 + i * 0.9));
    out[i] = Math.min(1, level * (0.45 + 0.55 * centre) * (0.6 + 0.6 * wobble));
  }
}
