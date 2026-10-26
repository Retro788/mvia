/**
 * Engine (b): real ElevenLabs text-to-speech over HTTPS. The MP3 is decoded into an AudioBuffer and
 * played through an AnalyserNode, so the visualiser shows the true waveform and live spectrum.
 */
import { getAudioContext, resumeAudio } from '../audio';
import type { ModelId } from '../settings';
import type { Playback, SpeakRequest } from './types';

export interface ElevenClip {
  blob: Blob;
  buffer: AudioBuffer;
  peaks: Float32Array;
}

export class ElevenError extends Error {}

const PEAK_BARS = 160;

/** max |sample| per bucket, normalised so the loudest bucket = 1 */
export function computePeaks(buffer: AudioBuffer, n = PEAK_BARS): Float32Array {
  const out = new Float32Array(n);
  const ch = buffer.getChannelData(0);
  const step = ch.length / n;
  let max = 1e-4;
  for (let b = 0; b < n; b++) {
    const a = Math.floor(b * step);
    const z = Math.min(ch.length, Math.floor((b + 1) * step));
    // RMS of the bucket reads closer to perceived loudness than the raw peak
    let acc = 0;
    const stride = Math.max(1, Math.floor((z - a) / 256));
    let cnt = 0;
    for (let i = a; i < z; i += stride) {
      acc += ch[i] * ch[i];
      cnt++;
    }
    const v = Math.sqrt(acc / Math.max(1, cnt));
    out[b] = v;
    if (v > max) max = v;
  }
  for (let b = 0; b < n; b++) out[b] = Math.min(1, Math.pow(out[b] / max, 0.8));
  return out;
}

export async function synthesizeEleven(
  req: SpeakRequest,
  apiKey: string,
  voiceId: string,
  signal: AbortSignal,
): Promise<ElevenClip> {
  const s = req.settings;
  const model: ModelId = s.model.startsWith('eleven_') ? s.model : 'eleven_multilingual_v2';
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({
        text: req.text,
        model_id: model,
        voice_settings: {
          stability: s.stability,
          similarity_boost: s.similarity,
          style: s.style,
          use_speaker_boost: s.speakerBoost,
          speed: s.speed,
        },
      }),
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new ElevenError('sin conexión con api.elevenlabs.io');
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { detail?: { message?: string; status?: string } | string };
      if (typeof j.detail === 'string') detail = j.detail;
      else if (j.detail?.message) detail = j.detail.message;
      else if (j.detail?.status) detail = j.detail.status;
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 401) detail = 'clave API inválida o sin permisos';
    if (res.status === 429) detail = 'límite de uso alcanzado';
    throw new ElevenError(detail);
  }
  const blob = await res.blob();
  const ctx = await resumeAudio();
  if (!ctx) throw new ElevenError('Web Audio no disponible en este navegador');
  if (ctx.state !== 'running') throw new ElevenError('el navegador bloqueó el audio (haz clic en la página)');
  const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
  return { blob, buffer, peaks: computePeaks(buffer) };
}

/** Plays a decoded clip through an AnalyserNode. Used for fresh API audio and history replays. */
export class BufferPlayback implements Playback {
  readonly engine = 'eleven' as const;
  readonly done: Promise<boolean>;
  started = false;
  private resolveDone!: (ok: boolean) => void;
  private src: AudioBufferSourceNode;
  private analyser: AnalyserNode;
  private gain: GainNode;
  private time: Float32Array;
  private freq: Uint8Array;
  private ctxStart: number;
  private lvl = 0;
  private finished = false;
  private endElapsed = 0;

  constructor(private clip: ElevenClip, readonly voiceLabel: string) {
    const ctx = getAudioContext()!;
    this.done = new Promise<boolean>((r) => (this.resolveDone = r));
    this.src = ctx.createBufferSource();
    this.src.buffer = clip.buffer;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.6;
    this.gain = ctx.createGain();
    this.gain.gain.value = 1;
    this.src.connect(this.analyser).connect(this.gain).connect(ctx.destination);
    this.time = new Float32Array(this.analyser.fftSize);
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.src.onended = () => this.finish(true);
    this.ctxStart = ctx.currentTime + 0.03;
    this.src.start(this.ctxStart);
    this.started = true;
  }

  private finish(ok: boolean): void {
    if (this.finished) return;
    this.endElapsed = this.elapsed();
    this.finished = true;
    try {
      this.src.disconnect();
      this.analyser.disconnect();
      this.gain.disconnect();
    } catch {
      /* already disconnected */
    }
    this.resolveDone(ok);
  }

  tick(dt: number): void {
    if (this.finished) {
      this.lvl *= Math.exp(-dt * 10);
      return;
    }
    this.analyser.getFloatTimeDomainData(this.time);
    let acc = 0;
    for (let i = 0; i < this.time.length; i++) acc += this.time[i] * this.time[i];
    const rms = Math.sqrt(acc / this.time.length);
    // perceptual-ish mapping: speech RMS ~0.03–0.3 → 0.25–0.9
    const target = Math.min(1, Math.sqrt(rms) * 1.65);
    const k = target > this.lvl ? 25 : 10;
    this.lvl += (target - this.lvl) * (1 - Math.exp(-dt * k));
  }

  level(): number {
    return this.lvl;
  }

  bands(out: Float32Array, _t: number): void {
    if (this.finished) {
      out.fill(0);
      return;
    }
    this.analyser.getByteFrequencyData(this.freq);
    // log-spaced bands over ~80 Hz – 6 kHz (bins are sampleRate/fftSize ≈ 43 Hz wide)
    const n = out.length;
    const bins = this.freq.length;
    const lo = 2;
    const hi = Math.min(bins - 1, 140);
    for (let i = 0; i < n; i++) {
      const a = Math.floor(lo * Math.pow(hi / lo, i / n));
      const z = Math.max(a + 1, Math.floor(lo * Math.pow(hi / lo, (i + 1) / n)));
      let m = 0;
      for (let k = a; k < z; k++) if (this.freq[k] > m) m = this.freq[k];
      out[i] = Math.pow(m / 255, 1.4);
    }
  }

  progress(): number {
    return Math.min(1, this.elapsed() / this.clip.buffer.duration);
  }

  elapsed(): number {
    if (this.finished) return this.endElapsed;
    const ctx = getAudioContext();
    return ctx ? Math.max(0, Math.min(this.clip.buffer.duration, ctx.currentTime - this.ctxStart)) : 0;
  }

  duration(): number {
    return this.clip.buffer.duration;
  }

  peaks(): Float32Array {
    return this.clip.peaks;
  }

  stop(): void {
    if (this.finished) return;
    try {
      this.src.onended = null;
      this.src.stop();
    } catch {
      /* not started */
    }
    this.finish(false);
  }
}
