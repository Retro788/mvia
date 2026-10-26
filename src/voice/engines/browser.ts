/**
 * Engine (a): browser neural voices through window.speechSynthesis.
 * Text is chunked into ≤220-char sentences (Chrome silently stops long utterances after ~15 s) and
 * queued one utterance at a time so each chunk can carry its own prosody:
 *  - speed      → rate (0.7–1.2) × persona base rate
 *  - stability  → random pitch/rate drift between chunks, amplitude (1 − stability)·0.18
 *  - style      → pitch lift on questions/exclamations + longer pauses at commas/full stops
 *  - similarity → persona voice choice (catalog.resolve) + how strongly persona pitch is applied
 */
import { chunkText, type Chunk } from '../text';
import type { VoiceCatalog } from './catalog';
import { guessGender } from './catalog';
import { SpeechEnvelope, bandsFromLevel } from './envelope';
import type { Playback, SpeakRequest } from './types';

/** average Spanish speaking speed at rate 1 (characters / second) — used for progress extrapolation */
const CPS = 14.5;
/** time of the last speechSynthesis.cancel(): Chrome drops a speak() issued right after it */
let lastCancelAt = -1e9;

interface PlannedChunk extends Chunk {
  rate: number;
  pitch: number;
  /** silence after this chunk (ms) */
  gap: number;
}

export interface BrowserSpeakOptions {
  /** explicit voice (advanced dropdown / bus voiceId); otherwise persona resolution */
  voice: SpeechSynthesisVoice | null;
  /** larger chunks, no clause splitting, minimal gaps */
  turbo: boolean;
}

export class BrowserEngine {
  constructor(readonly catalog: VoiceCatalog) {}

  get supported(): boolean {
    return this.catalog.supported;
  }

  pickVoice(req: SpeakRequest): SpeechSynthesisVoice | null {
    const s = req.settings;
    if (s.systemVoice) {
      const v = this.catalog.byURI(s.systemVoice);
      if (v) return v;
    }
    return this.catalog.resolve(req.persona, s.similarity);
  }

  speak(req: SpeakRequest, opts: BrowserSpeakOptions): Playback {
    const voice = opts.voice ?? this.pickVoice(req);
    return new BrowserPlayback(req, voice, opts.turbo);
  }
}

class BrowserPlayback implements Playback {
  readonly engine = 'browser' as const;
  readonly voiceLabel: string;
  readonly done: Promise<boolean>;
  started = false;

  private resolveDone!: (ok: boolean) => void;
  private synth = window.speechSynthesis;
  private chunks: PlannedChunk[];
  private idx = -1;
  private total: number;
  private charPos = 0;
  private curRate = 1;
  private inUtterance = false;
  private finished = false;
  private t0 = performance.now();
  private tEnd = 0;
  private env = new SpeechEnvelope();
  /** keep strong refs: Chrome GCs pending utterances and never fires 'end' otherwise */
  private current: SpeechSynthesisUtterance | null = null;
  private timer = 0;
  private watchdog = 0;
  private keepAlive = 0;
  private estDuration: number;
  private volume: number;

  constructor(req: SpeakRequest, private voice: SpeechSynthesisVoice | null, turbo: boolean) {
    this.done = new Promise<boolean>((r) => (this.resolveDone = r));
    this.voiceLabel = voice ? voice.name.replace(/^Microsoft\s+/, '').replace(/\s+-\s+.*$/, '') : 'Voz del sistema (es-MX)';
    this.total = Math.max(1, req.text.length);
    this.chunks = this.plan(req, turbo);
    this.env.emphasis = req.settings.style;
    this.volume = req.settings.speakerBoost ? 1 : 0.82;
    this.estDuration = this.chunks.reduce((a, c) => a + (c.end - c.start) / (CPS * c.rate) + c.gap / 1000, 0);

    if (!this.chunks.length) {
      queueMicrotask(() => this.finish(true));
      return;
    }
    // Chrome drops an utterance queued in the same tick as cancel(): give the queue a moment to flush.
    const busy = this.synth.speaking || this.synth.pending;
    if (busy) {
      this.synth.cancel();
      lastCancelAt = performance.now();
    }
    const settle = performance.now() - lastCancelAt < 250 ? 90 : 0;
    this.timer = window.setTimeout(() => this.next(), settle);

    // Chrome's Google network voices stall after ~15 s of continuous speech; pause/resume resets the timer.
    if (voice && /^google/i.test(voice.name)) {
      this.keepAlive = window.setInterval(() => {
        if (this.synth.speaking && !this.synth.paused) {
          this.synth.pause();
          this.synth.resume();
        }
      }, 9000);
    }
  }

  private plan(req: SpeakRequest, turbo: boolean): PlannedChunk[] {
    const s = req.settings;
    const p = req.persona;
    const raw = chunkText(req.text, turbo ? 220 : 200, !turbo && s.style >= 0.3);
    // persona prosody is applied in proportion to similarity (low similarity → closer to the raw voice)
    const simW = 0.35 + 0.65 * s.similarity;
    let basePitch = 1 + (p.pitch - 1) * simW;
    // gender mismatch between persona and the only available voice: nudge pitch towards the persona
    const g = this.voice ? guessGender(this.voice) : null;
    if (g && g !== p.gender) basePitch += (p.gender === 'f' ? 0.16 : -0.14) * s.similarity;
    const baseRate = s.speed * (1 + (p.rate - 1) * simW);
    const drift = (1 - s.stability) * 0.18;
    // deterministic per text, so a replay sounds identical
    let seed = 0x9e3779b9 ^ req.text.length;
    const rnd = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return ((seed >>> 0) & 0xffff) / 0xffff;
    };
    return raw.map((c, i) => {
      let pitch = basePitch * (1 + (rnd() * 2 - 1) * drift);
      let rate = baseRate * (1 + (rnd() * 2 - 1) * drift * 0.5);
      if (c.terminal === '?') pitch += 0.08 + s.style * 0.26;
      else if (c.terminal === '!') {
        pitch += 0.05 + s.style * 0.18;
        rate *= 1 + s.style * 0.06;
      }
      // pauses: commas get a short breath, sentences a longer one, scaled by style; turbo keeps them minimal
      const last = i === raw.length - 1;
      let gap = 0;
      if (!last) {
        if (turbo) gap = 20;
        else if (c.terminal === ',') gap = 40 + s.style * 200;
        else gap = 90 + s.style * 260;
      }
      return {
        ...c,
        pitch: Math.min(2, Math.max(0.1, pitch)),
        rate: Math.min(2, Math.max(0.5, rate)),
        gap,
      };
    });
  }

  private next(): void {
    if (this.finished) return;
    this.idx++;
    if (this.idx >= this.chunks.length) {
      this.finish(true);
      return;
    }
    const c = this.chunks[this.idx];
    const u = new SpeechSynthesisUtterance(c.text);
    if (this.voice) {
      u.voice = this.voice;
      u.lang = this.voice.lang;
    } else u.lang = 'es-MX';
    u.rate = c.rate;
    u.pitch = c.pitch;
    u.volume = this.volume;
    this.curRate = c.rate;
    this.env.rate = c.rate;
    this.charPos = Math.max(this.charPos, c.start);

    u.onstart = () => {
      if (this.current !== u) return;
      this.started = true;
      this.inUtterance = true;
      this.env.active = true;
    };
    u.onboundary = (e: SpeechSynthesisEvent) => {
      if (this.current !== u || (e.name && e.name !== 'word')) return;
      const wl = e.charLength || /^\S*/.exec(c.text.slice(e.charIndex))?.[0].length || 4;
      this.env.kick(wl);
      this.charPos = Math.max(this.charPos, c.start + e.charIndex);
    };
    const advance = () => {
      if (this.current !== u) return;
      this.current = null;
      this.inUtterance = false;
      this.env.active = false;
      this.charPos = c.end;
      window.clearTimeout(this.watchdog);
      this.timer = window.setTimeout(() => this.next(), c.gap);
    };
    u.onend = advance;
    u.onerror = (e: SpeechSynthesisErrorEvent) => {
      if (this.current !== u) return;
      if (e.error === 'not-allowed') {
        // autoplay policy: no user gesture yet → abort the whole clip
        this.current = null;
        this.finish(false);
        return;
      }
      if (e.error === 'interrupted' || e.error === 'canceled') return; // our own cancel()
      advance(); // synthesis-failed / network: skip the chunk, keep going
    };

    this.current = u;
    this.synth.speak(u);
    // watchdog: if 'end' never arrives (Chrome GC bug, dead network voice) move on anyway
    const expected = ((c.end - c.start) / (CPS * c.rate)) * 1000;
    const arm = (ms: number) => {
      this.watchdog = window.setTimeout(() => {
        if (this.current !== u) return;
        if (this.synth.speaking && performance.now() - this.t0 < 600_000 && ms < expected * 6) {
          arm(ms * 1.5); // still talking (slow voice) — re-arm
          return;
        }
        advance();
      }, ms);
    };
    arm(expected * 2.2 + 5000);
  }

  private finish(ok: boolean): void {
    if (this.finished) return;
    this.finished = true;
    this.tEnd = performance.now();
    window.clearTimeout(this.timer);
    window.clearTimeout(this.watchdog);
    window.clearInterval(this.keepAlive);
    this.env.active = false;
    if (ok) this.charPos = this.total;
    this.resolveDone(ok);
  }

  tick(dt: number): void {
    this.env.tick(dt);
    // extrapolate progress between boundary events, never past the end of the current chunk
    if (this.inUtterance && this.idx >= 0 && this.idx < this.chunks.length) {
      const c = this.chunks[this.idx];
      this.charPos = Math.min(c.end - 1, this.charPos + dt * CPS * this.curRate);
    }
  }

  level(): number {
    return this.env.level();
  }

  bands(out: Float32Array, t: number): void {
    bandsFromLevel(this.env.level(), t, out);
  }

  progress(): number {
    return Math.min(1, this.charPos / this.total);
  }

  elapsed(): number {
    return ((this.finished ? this.tEnd : performance.now()) - this.t0) / 1000;
  }

  duration(): number {
    if (this.finished) return this.elapsed();
    const p = this.progress();
    const el = this.elapsed();
    // blend the a-priori estimate with the observed pace as progress accumulates
    if (p > 0.05) {
      const observed = el / p;
      const w = Math.min(1, (p - 0.05) / 0.3);
      return Math.max(el, this.estDuration * (1 - w) + observed * w);
    }
    return Math.max(el, this.estDuration);
  }

  peaks(): Float32Array | null {
    return null;
  }

  stop(): void {
    if (this.finished) return;
    this.current = null;
    try {
      this.synth.cancel();
      lastCancelAt = performance.now();
    } catch {
      /* ignore */
    }
    this.finish(false);
  }
}
