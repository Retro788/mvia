/**
 * MVIA HUD entry point. Builds every DOM component inside #hud, wires interaction + shortcuts and runs a
 * staggered entrance once store.ready flips. Components only talk to the rest of the app through ctx.
 */
import type { AppContext } from '../core/types';
import { createActions, createBrand } from './brand';
import { createAttribution, createControls } from './controls';
import { createCursor, createToolBanner } from './cursor';
import { createDock } from './dock';
import { h } from './dom';
import { createInspector } from './inspector';
import { initInteraction } from './interaction';
import { createLabels } from './labels';
import { createLayers } from './layers';
import { createHelp, initShortcuts } from './shortcuts';
import { createTelemetry } from './telemetry';
import { createTimeline } from './timeline';
import { createToasts } from './toasts';

export function initUI(ctx: AppContext, root: HTMLElement): void {
  const { store } = ctx;
  root.classList.add('ui-root');

  const left = h('div', 'ui-left ui-pass');
  left.append(createBrand(ctx), createLayers(ctx), createTelemetry(ctx));

  const help = createHelp();
  // DOM order = paint order: map tags at the bottom, then panels, then floating card / cursor / toasts
  root.append(
    createLabels(ctx),
    left,
    createTimeline(ctx),
    createToolBanner(ctx),
    createDock(ctx),
    createActions(ctx),
    createControls(ctx),
    createAttribution(),
    createInspector(ctx),
    createCursor(ctx),
    createToasts(ctx),
    help,
  );

  initInteraction(ctx);
  initShortcuts(ctx, help);

  // entrance stagger: each panel gets its index as --i (CSS uses it as animation-delay)
  root.querySelectorAll<HTMLElement>('.ui-panel').forEach((p, i) => p.style.setProperty('--i', String(i)));
  const syncReady = () => root.classList.toggle('is-ready', store.get().ready);
  store.subscribe(syncReady, ['ready']);
  syncReady();

  // small screens start with the secondary panels folded
  if (window.matchMedia('(max-width: 900px)').matches) {
    root.querySelector('.ui-layers')?.classList.add('collapsed');
    root.querySelector('.ui-dock')?.classList.add('collapsed');
  }
}
