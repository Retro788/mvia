/**
 * MVIA Voice — ElevenLabs-like voice synthesizer.
 *
 * Bus API:
 *   'voice:speak' {text, voiceId?} → speak with the current studio settings (cancels any previous speech).
 *                                    voiceId may be a persona id ('core' | 'valeria' | 'mateo' | 'sofia' | 'diego')
 *                                    or a system voice name / voiceURI.
 *   'voice:stop'                   → stop immediately.
 *   emits 'voice:state' {speaking, level} at ~30 Hz while speaking, and once {speaking:false} at the end.
 * Store: `voiceOpen` toggles the Voice Studio modal.
 */
import './voice.css';
import type { AppContext } from '../core/types';
import { installAudioUnlock } from './audio';
import { VoiceController } from './controller';
import { mountPill } from './ui/pill';
import { mountStudio } from './ui/studio';

let instance: VoiceController | null = null;

export function initVoice(ctx: AppContext, root: HTMLElement): void {
  if (instance) return;
  installAudioUnlock();
  const vc = new VoiceController(ctx);
  instance = vc;

  mountPill(root, vc, ctx.store);
  mountStudio(ctx, root, vc);

  ctx.bus.on('voice:speak', ({ text, voiceId }) => {
    void vc.speak(text, { voiceId, source: 'chat' });
  });
  ctx.bus.on('voice:stop', () => vc.stop());

  // never leave the OS speech queue talking after the tab closes / reloads
  window.addEventListener('pagehide', () => vc.stop());
}

export type { VoiceController } from './controller';
