/**
 * ElevenLabs-style mirrored bar waveform with playhead. Reads the controller's VoiceFrame each frame.
 *  - idle:       a gentle "breathing" line
 *  - generating: predicted bars with a shimmer sweep
 *  - speaking:   spoken part in ink (real peaks or measured envelope), the rest pale, live accent playhead
 */
import { WAVE_BARS, type VoiceFrame } from '../controller';

interface Palette {
  ink: string;
  pale: string;
  line: string;
  live: string;
  muted: string;
}

function cssVar(el: Element, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

export class Waveform {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private pal: Palette = { ink: '#111214', pale: '#c9cacf', line: 'rgba(17,18,20,0.1)', live: '#ff6a2b', muted: '#74767d' };
  private ro: ResizeObserver;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.refreshPalette();
  }

  refreshPalette(): void {
    const el = this.canvas;
    this.pal = {
      ink: cssVar(el, '--ink', '#111214'),
      pale: cssVar(el, '--ink-4', '#a9abb1'),
      line: cssVar(el, '--line-2', 'rgba(17,18,20,0.18)'),
      live: cssVar(el, '--live', '#ff6a2b'),
      muted: cssVar(el, '--ink-3', '#74767d'),
    };
  }

  resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(1, Math.round(r.width));
    this.h = Math.max(1, Math.round(r.height));
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  draw(f: VoiceFrame): void {
    if (!this.w || this.canvas.width === 0) this.resize();
    const { ctx, w, h, pal } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const mid = h / 2;

    if (f.status === 'idle' && f.level < 0.02) {
      this.breathing(f.t, mid);
      return;
    }

    const pitch = 4; // bar + gap in css px
    const barW = 2.4;
    const count = Math.max(8, Math.floor(w / pitch));
    const maxH = h * 0.84;
    const playX = f.progress * w;
    ctx.globalAlpha = 1;

    for (let i = 0; i < count; i++) {
      const u = (i + 0.5) / count;
      const k = Math.min(WAVE_BARS - 1, Math.floor(u * WAVE_BARS));
      const pred = f.peaks[k];
      const x = i * pitch + (pitch - barW) / 2;
      let amp: number;
      let color: string;
      let alpha = 1;
      if (f.status === 'generating') {
        // shimmer: a soft highlight sweeping left → right every 1.4 s
        const sweep = ((f.t / 1.4) % 1) * 1.3 - 0.15;
        const d = Math.abs(u - sweep);
        amp = pred * (0.35 + 0.25 * Math.max(0, 1 - d * 6));
        color = d < 0.08 ? pal.muted : pal.pale;
        alpha = 0.55 + 0.45 * Math.max(0, 1 - d * 8);
      } else if (x + barW <= playX || f.status === 'idle') {
        amp = f.realPeaks ? pred : 0.25 * pred + 0.75 * Math.min(1, f.recorded[k] * 1.15);
        color = pal.ink;
        alpha = f.status === 'idle' ? Math.min(1, f.level * 20) : 1;
      } else {
        amp = pred * 0.85;
        color = pal.pale;
        alpha = 0.55;
        // bars just ahead of the playhead breathe with the live level → reads as "the voice is here"
        const ahead = (x - playX) / w;
        if (ahead < 0.03) {
          amp = Math.max(amp, pred * (0.4 + f.level * 0.9));
          color = pal.muted;
          alpha = 0.9;
        }
      }
      const bh = Math.max(2, amp * maxH);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.fillRect(x, mid - bh / 2, barW, bh);
    }
    ctx.globalAlpha = 1;

    if (f.status === 'speaking') {
      // playhead hairline + head dot
      ctx.fillStyle = pal.live;
      ctx.fillRect(Math.round(playX) - 0.5, 4, 1, h - 8);
      ctx.beginPath();
      ctx.arc(playX, 5, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private breathing(t: number, mid: number): void {
    const { ctx, w, pal } = this;
    // slow inhale/exhale (≈ 0.25 Hz) modulating a travelling low-amplitude sine
    const breath = 0.5 + 0.5 * Math.sin(t * 1.6);
    const amp = 1.2 + breath * 3.2;
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.2, pal.muted);
    grad.addColorStop(0.8, pal.muted);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.25;
    ctx.globalAlpha = 0.55 + breath * 0.35;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 3) {
      const env = Math.sin((x / w) * Math.PI); // taper at the edges
      const y = mid + Math.sin(x * 0.045 - t * 2.2) * amp * env + Math.sin(x * 0.11 + t * 1.3) * amp * 0.35 * env;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = pal.line;
    ctx.fillRect(0, Math.round(mid), w, 1);
  }

  dispose(): void {
    this.ro.disconnect();
  }
}
