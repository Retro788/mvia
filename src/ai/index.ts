/**
 * MVIA chatbot entry point. Mounts the launcher orb + chat panel into #chat-root and wires it to
 * the store (chatOpen / voiceAuto / voiceOpen) and bus ('chat:ask', 'voice:*').
 */
import './chat.css';
import type { AppContext } from '../core/types';
import { ChatUI } from './chat';

export { MviaEngine, SUGGESTIONS } from './engine';
export { toSpeech } from './format';

let instance: ChatUI | null = null;

export function initChat(ctx: AppContext, root: HTMLElement): void {
  if (instance) return;
  instance = new ChatUI(ctx, root);
}
