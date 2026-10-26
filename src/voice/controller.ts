/**
 * VoiceController — owns the engines, the active playback, the clip history and the frame loop.
 * UI pieces (studio, pill) read a shared, allocation-free `VoiceFrame` every animation frame.
 */
import type { AppContext, BusEvents } from '../core/types';
import { resumeAudio } from './audio';
import { BrowserEngine } from './engines/browser';
import { VoiceCatalog } from './engines/catalog';
import { CoreSignature } from './engines/core';
import { BufferPlayback, ElevenError, synthesizeEleven, type ElevenClip } from './engines/eleven';
import type { EngineId, Playback, SpeakRequest } from './engines/types';
import {
  DEFAULT_SETTINGS,
  loadElevenKey,
  loadSettings,
  modelInfo,
  persona as personaOf,
  PERSONAS,
  saveElevenKey,
  saveSettings,
  type ModelId,
  type Persona,
  type PersonaId,
  type VoiceSettings,
} from './settings';
import { textPeaks, toSpeakable } from './text';

export const MAX_CHARS = 5000;
export const WAVE_BARS = 160;
export const PILL_BANDS = 9;
const HISTORY_MAX = 24;

export type VoiceStatus = 'idle' | 'generating' | 'speaking';
export type ClipSource = 'estudio' | 'chat' | 'replay';

export interface Clip {
  id: string;
  text: string;
  persona: Persona;
  engine: EngineId;
  model: ModelId;
  voiceLabel: string;
  settings: VoiceSettings;
  createdAt: Date;
  duration: number;
  source: ClipSource;
  eleven?: ElevenClip;
}

/** Live snapshot read by the UI each frame (mutated in place, never reallocated). */
export interface VoiceFrame {
  t: number;
  status: VoiceStatus;
  level: number;
  bands: Float32Array;
  progress: number;
  elapsed: number;
  duration: number;
  /** waveform for the current clip: predicted from text (browser) or real (API) */
  peaks: Float32Array;
  realPeaks: boolean;
  /** measured envelope per bar for the part already spoken (browser engine) */
  recorded: Float32Array;
  personaName: string;
  voiceLabel: string;
  engine: EngineId;
}

export interface SpeakOptions {
  /** persona id or a system voice name/voiceURI (bus 'voice:speak'.voiceId) */
  voiceId?: string;
  source?: ClipSource;
}

type Listener = () => void;

export class VoiceController {
  readonly catalog = new VoiceCatalog();
  readonly browser = new BrowserEngine(this.catalog);
  private core = new CoreSignature();
  private _settings: VoiceSettings = loadSettings();
  private _apiKey = loadElevenKey();
  private current: Playback | null = null;
  private currentPersona: Persona = personaOf(this._settings.personaId);
  private currentClipId: string | null = null;
  private abort: AbortController | null = null;
  private token = 0;
  private status: VoiceStatus = 'idle';
  private clips: Clip[] = [];
  private changeListeners = new Set<Listener>();
  private frameListeners = new Set<(f: VoiceFrame) => void>();
  private holds = 0;
  private raf = 0;
  private lastT = 0;
  private lastEmit = 0;
  private lastBar = -1;
  private warnedNoKey = false;
  private humOn = false;

  readonly frame: VoiceFrame = {
    t: 0,
    status: 'idle',
    level: 0,
    bands: new Float32Array(PILL_BANDS),
    progress: 0,
    elapsed: 0,
    duration: 0,
    peaks: new Float32Array(WAVE_BARS),
    realPeaks: false,
    recorded: new Float32Array(WAVE_BARS),
    personaName: '',
    voiceLabel: '',
    engine: 'browser',
  };

  constructor(private ctx: AppContext) {
    this.catalog.onChange(() => this.changed());
  }

  // ───────────── settings ─────────────
  get settings(): Readonly<VoiceSettings> {
    return this._settings;
  }

  update(patch: Partial<VoiceSettings>): void {
    this._settings = { ...this._settings, ...patch };
    saveSettings(this._settings);
    this.changed();
  }

  resetSettings(): void {
    // keep identity choices (persona, model, API voice) — reset only the sound-shaping parameters, like ElevenLabs
    const { personaId, model, elevenVoiceId, systemVoice } = this._settings;
    this._settings = { ...DEFAULT_SETTINGS, personaId, model, elevenVoiceId, systemVoice };
    saveSettings(this._settings);
    this.changed();
  }

  get apiKey(): string {
    return this._apiKey;
  }

  setApiKey(key: string): void {
    this._apiKey = key.trim();
    saveElevenKey(this._apiKey);
    this.changed();
  }

  /** the system voice the browser engine would use right now for a persona */
  voiceFor(p: Persona): SpeechSynthesisVoice | null {
    return this.browser.pickVoice({ text: '', persona: p, settings: { ...this._settings, systemVoice: p.id === this._settings.personaId ? this._settings.systemVoice : '' } });
  }

  /** what will actually be used on the next "Generar voz" */
  engineLabel(): string {
    const m = modelInfo(this._settings.model);
    if (m.engine === 'eleven' && this._apiKey) return `ElevenLabs API · ${m.id}`;
    const v = this.voiceFor(personaOf(this._settings.personaId));
    return `Navegador neural · ${v ? v.name.replace(/^Microsoft\s+/, '').replace(/\s+-\s+.*$/, '') : 'sin voces'}`;
  }

  // ───────────── state ─────────────
  getStatus(): VoiceStatus {
    return this.status;
  }

  history(): readonly Clip[] {
    return this.clips;
  }

  playingClipId(): string | null {
    return this.status === 'idle' ? null : this.currentClipId;
  }

  onChange(fn: Listener): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  onFrame(fn: (f: VoiceFrame) => void): () => void {
    this.frameListeners.add(fn);
    this.ensureLoop();
    return () => this.frameListeners.delete(fn);
  }

  /** keep the frame loop alive while idle (studio open → breathing animation) */
  hold(): () => void {
    this.holds++;
    this.ensureLoop();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds = Math.max(0, this.holds - 1);
    };
  }

  private changed(): void {
    for (const fn of [...this.changeListeners]) {
      try {
        fn();
      } catch (err) {
        console.error('[voice] listener failed', err);
      }
    }
  }

  private toast(text: string, kind: BusEvents['ui:toast']['kind'] = 'info'): void {
    this.ctx.bus.emit('ui:toast', { text, kind });
  }

  // ───────────── speaking ─────────────
  async speak(raw: string, opts: SpeakOptions = {}): Promise<void> {
    const text = toSpeakable(raw).slice(0, MAX_CHARS);
    if (!text) return;
    this.stop();
    const token = ++this.token;
    void resumeAudio();

    const settings: VoiceSettings = { ...this._settings };
    let persona = personaOf(settings.personaId);
    let forcedVoice: SpeechSynthesisVoice | null = null;
    if (opts.voiceId) {
      const p = PERSONAS.find((x) => x.id === opts.voiceId);
      if (p) persona = p;
      else forcedVoice = this.catalog.byURI(opts.voiceId);
    }
    const req: SpeakRequest = { text, settings, persona };
    const source = opts.source ?? 'estudio';

    if (modelInfo(settings.model).engine === 'eleven') {
      if (!this._apiKey) {
        if (!this.warnedNoKey) {
          this.warnedNoKey = true;
          this.toast('Modelo ElevenLabs sin clave API: usando la voz neural del navegador.', 'warn');
        }
      } else {
        this.setStatus('generating', persona);
        this.prepareFrame(text, persona, null, 'eleven', 'Generando…');
        const abort = new AbortController();
        this.abort = abort;
        try {
          const clip = await synthesizeEleven(req, this._apiKey, settings.elevenVoiceId, abort.signal);
          if (token !== this.token) return;
          this.abort = null;
          const label = `ElevenLabs · ${settings.elevenVoiceId.slice(0, 8)}…`;
          const pb = new BufferPlayback(clip, label);
          const entry = this.addClip({ text, persona, engine: 'eleven', model: settings.model, voiceLabel: label, settings, duration: clip.buffer.duration, source, eleven: clip });
          this.begin(pb, persona, text, entry.id, clip.peaks);
          return;
        } catch (err) {
          if (token !== this.token || abort.signal.aborted) return;
          this.abort = null;
          const msg = err instanceof ElevenError ? err.message : err instanceof Error ? err.message : String(err);
          this.toast(`ElevenLabs: ${msg}. Usando la voz neural del navegador.`, 'warn');
          this.setStatus('idle', persona);
        }
      }
    }

    if (!this.browser.supported) {
      this.toast('Este navegador no soporta síntesis de voz. Conecta ElevenLabs en el Voice Studio.', 'risk');
      return;
    }
    const turbo = settings.model === 'mvia_turbo_v2_5';
    const pb = this.browser.speak(req, { voice: forcedVoice, turbo });
    const entry = this.addClip({ text, persona, engine: 'browser', model: settings.model, voiceLabel: pb.voiceLabel, settings, duration: pb.duration(), source });
    this.begin(pb, persona, text, entry.id, null);
  }

  /** replay a history clip with the settings it was generated with */
  async replay(id: string): Promise<void> {
    const clip = this.clips.find((c) => c.id === id);
    if (!clip) return;
    this.stop();
    const token = ++this.token;
    if (clip.eleven) {
      const ctx = await resumeAudio();
      if (token !== this.token) return;
      if (!ctx || ctx.state !== 'running') {
        this.toast('El navegador bloqueó el audio: haz clic en la página e intenta de nuevo.', 'warn');
        return;
      }
      this.begin(new BufferPlayback(clip.eleven, clip.voiceLabel), clip.persona, clip.text, clip.id, clip.eleven.peaks);
    } else {
      if (!this.browser.supported) return;
      const pb = this.browser.speak({ text: clip.text, persona: clip.persona, settings: clip.settings }, { voice: null, turbo: clip.model === 'mvia_turbo_v2_5' });
      this.begin(pb, clip.persona, clip.text, clip.id, null);
    }
  }

  stop(): void {
    this.token++;
    if (this.abort) {
      this.abort.abort();
      this.abort = null;
    }
    const pb = this.current;
    if (pb) {
      this.current = null;
      pb.stop();
      this.end(pb, false);
    } else if (this.status !== 'idle') {
      this.setStatus('idle', this.currentPersona);
    }
  }

  removeClip(id: string): void {
    if (this.currentClipId === id && this.status !== 'idle') this.stop();
    this.clips = this.clips.filter((c) => c.id !== id);
    this.changed();
  }

  download(id: string): void {
    const clip = this.clips.find((c) => c.id === id);
    if (!clip?.eleven) return;
    const url = URL.createObjectURL(clip.eleven.blob);
    const a = document.createElement('a');
    const d = clip.createdAt;
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
    a.href = url;
    a.download = `mvia-voz-${clip.persona.id}-${stamp}.mp3`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  private addClip(c: Omit<Clip, 'id' | 'createdAt'>): Clip {
    const clip: Clip = { ...c, id: `clip-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`, createdAt: new Date() };
    this.clips.unshift(clip);
    if (this.clips.length > HISTORY_MAX) this.clips.length = HISTORY_MAX;
    return clip;
  }

  private prepareFrame(text: string, persona: Persona, peaks: Float32Array | null, engine: EngineId, voiceLabel: string): void {
    const f = this.frame;
    if (peaks) {
      // resample real peaks into the shared buffer
      for (let i = 0; i < WAVE_BARS; i++) f.peaks[i] = peaks[Math.min(peaks.length - 1, Math.floor((i / WAVE_BARS) * peaks.length))];
    } else textPeaks(text, WAVE_BARS, f.peaks);
    f.realPeaks = Boolean(peaks);
    f.recorded.fill(0);
    f.progress = 0;
    f.elapsed = 0;
    f.duration = 0;
    f.personaName = persona.name;
    f.voiceLabel = voiceLabel;
    f.engine = engine;
    this.lastBar = -1;
  }

  private begin(pb: Playback, persona: Persona, text: string, clipId: string, peaks: Float32Array | null): void {
    this.current = pb;
    this.currentClipId = clipId;
    this.prepareFrame(text, persona, peaks, pb.engine, pb.voiceLabel);
    this.setStatus('speaking', persona);
    if (persona.synthetic && this._settings.coreSignature) this.core.chime('up');
    pb.done.then((ok) => {
      if (this.current !== pb) return; // already handled by stop()
      this.current = null;
      if (!ok && !pb.started) this.toast('El navegador bloqueó el audio: haz clic en la página e intenta de nuevo.', 'warn');
      this.end(pb, ok);
    });
  }

  private end(pb: Playback, ok: boolean): void {
    const clip = this.clips.find((c) => c.id === this.currentClipId);
    if (clip && clip.engine === 'browser' && ok) clip.duration = pb.elapsed();
    if (this.humOn) {
      this.core.stopHum();
      this.humOn = false;
    }
    if (this.currentPersona.synthetic && this._settings.coreSignature && pb.started) this.core.chime('down');
    this.frame.progress = ok ? 1 : this.frame.progress;
    this.setStatus('idle', this.currentPersona);
  }

  private setStatus(s: VoiceStatus, persona: Persona): void {
    const wasSpeaking = this.status === 'speaking';
    this.status = s;
    this.currentPersona = persona;
    this.frame.status = s;
    if (wasSpeaking && s !== 'speaking') {
      this.frame.level = 0;
      this.ctx.bus.emit('voice:state', { speaking: false, level: 0 });
    }
    this.ensureLoop();
    this.changed();
  }

  // ───────────── frame loop ─────────────
  private ensureLoop(): void {
    if (this.raf) return;
    this.lastT = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  private loop = (now: number): void => {
    const dt = Math.min(0.1, Math.max(0, (now - this.lastT) / 1000));
    this.lastT = now;
    const f = this.frame;
    f.t = now / 1000;
    const pb = this.current;
    if (pb) {
      pb.tick(dt);
      f.level = pb.level();
      pb.bands(f.bands, f.t);
      f.progress = pb.progress();
      f.elapsed = pb.elapsed();
      f.duration = pb.duration();
      // record the measured envelope into the bars the playhead sweeps over
      const bar = Math.min(WAVE_BARS - 1, Math.floor(f.progress * WAVE_BARS));
      for (let b = Math.max(0, this.lastBar + 1); b <= bar; b++) f.recorded[b] = Math.max(f.recorded[b], f.level);
      if (bar >= 0) f.recorded[bar] = Math.max(f.recorded[bar], f.level);
      this.lastBar = bar;

      const sig = this.currentPersona.synthetic && this._settings.coreSignature;
      if (sig && pb.started && !this.humOn) {
        this.core.startHum();
        this.humOn = true;
      } else if (!sig && this.humOn) {
        this.core.stopHum();
        this.humOn = false;
      }
      if (this.humOn) this.core.follow(f.level);

      if (now - this.lastEmit >= 33) {
        this.lastEmit = now;
        this.ctx.bus.emit('voice:state', { speaking: true, level: f.level });
      }
    } else {
      f.level *= Math.exp(-dt * 8);
      for (let i = 0; i < f.bands.length; i++) f.bands[i] *= Math.exp(-dt * 8);
    }
    for (const fn of this.frameListeners) fn(f);

    if (this.current || this.status !== 'idle' || this.holds > 0 || f.level > 0.01) {
      this.raf = requestAnimationFrame(this.loop);
    } else {
      this.raf = 0;
    }
  };
}

export type { PersonaId };
