/** Top-centre floating "MVIA hablando" pill: live mini waveform + stop. Visible whenever MVIA speaks. */
import type { IStore } from '../../core/types';
import { PILL_BANDS, type VoiceController } from '../controller';
import { fmtClock } from '../text';
import { ICONS } from './icons';

export function mountPill(root: HTMLElement, vc: VoiceController, store: IStore): void {
  const el = document.createElement('div');
  el.className = 'vx-pill';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = `
    <button class="vx-pill-main" type="button" title="Abrir MVIA Voice Studio">
      <span class="vx-pill-bars" aria-hidden="true">${'<i></i>'.repeat(PILL_BANDS)}</span>
      <span class="vx-pill-label">MVIA hablando</span>
      <span class="vx-pill-meta mono"></span>
    </button>
    <button class="vx-pill-stop" type="button" aria-label="Detener voz" title="Detener">${ICONS.stop}</button>`;
  root.appendChild(el);

  const bars = Array.from(el.querySelectorAll<HTMLElement>('.vx-pill-bars i'));
  const label = el.querySelector<HTMLElement>('.vx-pill-label')!;
  const meta = el.querySelector<HTMLElement>('.vx-pill-meta')!;
  el.querySelector('.vx-pill-stop')!.addEventListener('click', () => vc.stop());
  el.querySelector('.vx-pill-main')!.addEventListener('click', () => store.set({ voiceOpen: true }));

  let visible = false;
  let lastMeta = '';
  const sync = () => {
    const st = vc.getStatus();
    const show = st !== 'idle';
    if (show !== visible) {
      visible = show;
      el.classList.toggle('show', show);
    }
    el.classList.toggle('generating', st === 'generating');
    label.textContent = st === 'generating' ? 'MVIA generando' : 'MVIA hablando';
  };
  vc.onChange(sync);
  sync();

  vc.onFrame((f) => {
    if (!visible) return;
    for (let i = 0; i < bars.length; i++) {
      const b = f.status === 'generating' ? 0.25 + 0.2 * Math.sin(f.t * 6 + i * 0.7) : f.bands[i];
      bars[i].style.transform = `scaleY(${(0.12 + Math.min(1, b) * 0.88).toFixed(3)})`;
    }
    const m = `${f.personaName.toUpperCase()} · ${fmtClock(f.elapsed).slice(0, 5)}`;
    if (m !== lastMeta) {
      lastMeta = m;
      meta.textContent = m;
    }
  });
}
