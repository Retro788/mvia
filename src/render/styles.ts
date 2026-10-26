/** Styles for the DOM the render module owns (compare divider). Injected once. */
const CSS = /* css */ `
.mvia-split {
  position: absolute; top: 0; bottom: 0; left: 0; width: 0; z-index: 2;
  pointer-events: none; transition: opacity .35s ease;
}
.mvia-split.is-hidden { opacity: 0; }
.mvia-split.is-hidden * { pointer-events: none !important; }
.mvia-split__hit {
  position: absolute; top: 0; bottom: 0; left: -9px; width: 18px;
  cursor: ew-resize; pointer-events: auto; touch-action: none;
}
.mvia-split__line {
  position: absolute; top: 0; bottom: 0; left: -1px; width: 2px;
  background: var(--clay);
  box-shadow: 0 0 0 1px var(--line-2), 0 0 22px rgba(0, 0, 0, 0.22);
}
.mvia-split__grip {
  position: absolute; top: 50%; left: 0; transform: translate(-50%, -50%);
  width: 44px; height: 44px; border-radius: 50%; padding: 0;
  display: flex; align-items: center; justify-content: center; gap: 6px;
  background: var(--panel-solid); color: var(--ink);
  border: 1px solid var(--line-2); box-shadow: var(--shadow-2);
  font: 600 15px/1 var(--font-mono);
  cursor: ew-resize; pointer-events: auto; touch-action: none;
  transition: transform .18s ease, box-shadow .18s ease;
}
.mvia-split__grip:hover, .mvia-split.is-dragging .mvia-split__grip { transform: translate(-50%, -50%) scale(1.08); }
.mvia-split__grip:focus-visible { outline: 2px solid var(--live); outline-offset: 3px; }
.mvia-split__chip {
  position: absolute; top: calc(50% - 56px); white-space: nowrap;
  display: inline-flex; align-items: center; gap: 7px;
  padding: 6px 9px; border-radius: 4px;
  font: 500 10.5px/1 var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase;
  box-shadow: var(--shadow-1); pointer-events: none;
}
.mvia-split__chip--l { right: 14px; background: var(--panel-solid); color: var(--ink-2); border: 1px solid var(--line-2); }
.mvia-split__chip--r { left: 14px; background: var(--ink); color: var(--clay); border: 1px solid var(--ink); }
.mvia-split__chip i { width: 6px; height: 6px; border-radius: 50%; background: var(--ink-4); }
.mvia-split__chip--r i { background: var(--live); box-shadow: 0 0 8px var(--live); }
@media (max-width: 640px) {
  .mvia-split__chip { top: calc(50% - 50px); font-size: 9.5px; padding: 5px 7px; }
  .mvia-split__grip { width: 38px; height: 38px; font-size: 13px; }
}
`;

export function injectRenderStyles(): void {
  if (document.getElementById('mvia-render-css')) return;
  const el = document.createElement('style');
  el.id = 'mvia-render-css';
  el.textContent = CSS;
  document.head.appendChild(el);
}
