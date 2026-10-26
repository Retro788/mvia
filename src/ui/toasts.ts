/** Top-centre toast stack (below the voice pill), auto-dismiss after 3.5 s, max 4 visible. */
import type { AppContext, BusEvents } from '../core/types';
import { h } from './dom';

const TTL = 3500;
const MAX = 4;

export function createToasts(ctx: AppContext): HTMLElement {
  const el = h('div', 'ui-toasts ui-pass', { role: 'status', 'aria-live': 'polite' });

  const dismiss = (t: HTMLElement) => {
    if (t.classList.contains('out')) return;
    t.classList.add('out');
    window.setTimeout(() => t.remove(), 220);
  };

  ctx.bus.on('ui:toast', ({ text, kind = 'info' }: BusEvents['ui:toast']) => {
    // collapse identical consecutive messages instead of stacking duplicates
    const lastEl = el.lastElementChild as HTMLElement | null;
    if (lastEl && lastEl.dataset.text === text && !lastEl.classList.contains('out')) {
      lastEl.classList.remove('bump');
      void lastEl.offsetWidth; // restart the bump animation
      lastEl.classList.add('bump');
      return;
    }
    const t = h('div', `toast toast-${kind}`, { 'data-text': text });
    const dot = h('i', 'toast-dot');
    const span = h('span', 'toast-t');
    span.textContent = text;
    t.append(dot, span);
    t.addEventListener('click', () => dismiss(t));
    el.appendChild(t);
    while (el.children.length > MAX) (el.firstElementChild as HTMLElement).remove();
    window.setTimeout(() => dismiss(t), TTL);
  });
  return el;
}
