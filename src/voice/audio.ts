/** Lazily-created shared AudioContext (browsers only allow it to run after a user gesture). */

type ACtor = typeof AudioContext;
let ctx: AudioContext | null = null;

export function audioSupported(): boolean {
  const w = window as unknown as { AudioContext?: ACtor; webkitAudioContext?: ACtor };
  return Boolean(w.AudioContext ?? w.webkitAudioContext);
}

export function getAudioContext(): AudioContext | null {
  if (ctx) return ctx;
  const w = window as unknown as { AudioContext?: ACtor; webkitAudioContext?: ACtor };
  const C = w.AudioContext ?? w.webkitAudioContext;
  if (!C) return null;
  try {
    ctx = new C({ latencyHint: 'interactive' });
  } catch {
    return null;
  }
  return ctx;
}

/** Resume the context; resolves even if the browser refuses (no gesture yet). */
export async function resumeAudio(): Promise<AudioContext | null> {
  const c = getAudioContext();
  if (c && c.state === 'suspended') {
    try {
      await c.resume();
    } catch {
      /* autoplay policy — will retry on next gesture */
    }
  }
  return c;
}

/** Unlock audio on the first user gesture anywhere on the page. */
export function installAudioUnlock(): void {
  const unlock = () => {
    void resumeAudio();
    window.removeEventListener('pointerdown', unlock, true);
    window.removeEventListener('keydown', unlock, true);
  };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
}
