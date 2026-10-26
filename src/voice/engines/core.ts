/**
 * Engine (c) layer: "MVIA Core" branded signature on top of any voice.
 *  - a soft two-note digital chime at start (rising) and end (falling)
 *  - a ring-modulated carrier hum (carrier × modulator → sidebands at f_c ± f_m, a metallic timbre)
 *    whose gain follows the speech envelope, kept very quiet under the voice.
 */
import { getAudioContext } from '../audio';

const HUM_MAX = 0.022;

export class CoreSignature {
  private nodes: { carrier: OscillatorNode; buzz: OscillatorNode; mod: OscillatorNode; out: GainNode; ring: GainNode; filter: BiquadFilterNode } | null = null;

  chime(direction: 'up' | 'down'): void {
    const ctx = getAudioContext();
    if (!ctx || ctx.state !== 'running') return;
    const notes = direction === 'up' ? [1318.5, 1975.5] : [1975.5, 1174.7]; // E6→B6 / B6→D6
    const t0 = ctx.currentTime + 0.01;
    notes.forEach((f, i) => {
      const t = t0 + i * 0.085;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.05, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
      g.connect(ctx.destination);
      // fundamental + slightly inharmonic partial → glassy "digital bell"
      for (const [mul, amp] of [[1, 1], [2.76, 0.28]] as const) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = f * mul;
        const pg = ctx.createGain();
        pg.gain.value = amp;
        o.connect(pg).connect(g);
        o.start(t);
        o.stop(t + 0.6);
        o.onended = () => {
          o.disconnect();
          pg.disconnect();
          if (mul === 1) g.disconnect();
        };
      }
    });
  }

  startHum(): void {
    const ctx = getAudioContext();
    if (!ctx || ctx.state !== 'running' || this.nodes) return;
    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = 155.6; // ≈ D#3
    const buzz = ctx.createOscillator();
    buzz.type = 'triangle';
    buzz.frequency.value = 311.1;
    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = 61;
    // ring modulation: the modulator drives the gain param of a zero-gain node
    const ring = ctx.createGain();
    ring.gain.value = 0;
    mod.connect(ring.gain);
    const buzzGain = ctx.createGain();
    buzzGain.gain.value = 0.25;
    carrier.connect(ring);
    buzz.connect(buzzGain).connect(ring);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1100;
    filter.Q.value = 0.7;
    const out = ctx.createGain();
    out.gain.value = 0;
    ring.connect(filter).connect(out).connect(ctx.destination);
    const t = ctx.currentTime;
    carrier.start(t);
    buzz.start(t);
    mod.start(t);
    this.nodes = { carrier, buzz, mod, out, ring, filter };
  }

  /** follow the speech envelope (0..1); call per frame */
  follow(level: number): void {
    const n = this.nodes;
    const ctx = getAudioContext();
    if (!n || !ctx) return;
    n.out.gain.setTargetAtTime(HUM_MAX * Math.min(1, level * 1.1), ctx.currentTime, 0.04);
    // the filter opens slightly with loudness, like a vocoder sidechain
    n.filter.frequency.setTargetAtTime(700 + level * 1400, ctx.currentTime, 0.06);
  }

  stopHum(): void {
    const n = this.nodes;
    const ctx = getAudioContext();
    if (!n || !ctx) return;
    this.nodes = null;
    const t = ctx.currentTime;
    n.out.gain.cancelScheduledValues(t);
    n.out.gain.setTargetAtTime(0, t, 0.05);
    for (const o of [n.carrier, n.buzz, n.mod]) {
      o.stop(t + 0.4);
    }
    n.carrier.onended = () => {
      for (const node of [n.carrier, n.buzz, n.mod, n.ring, n.filter, n.out]) {
        try {
          node.disconnect();
        } catch {
          /* ignore */
        }
      }
    };
  }
}
