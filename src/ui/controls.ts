/** Right-edge map controls (zoom ±, compass, 2D/3D, centre, fullscreen) + attribution line. */
import type { AppContext, Vec2 } from '../core/types';
import { lonLatToWorld } from '../core/geo';
import { h, setStyle, setText } from './dom';
import { ICON } from './icons';

/** Parque Juárez, heart of Xalapa (from the landmark list when present). */
export function cityCentre(ctx: AppContext): Vec2 {
  const l = ctx.sim.mapData.landmarks.find((x) => /ju[aá]rez/i.test(x.name)) ?? ctx.sim.mapData.landmarks.find((x) => x.kind === 'plaza' || x.kind === 'catedral');
  return l ? l.pos : lonLatToWorld(-96.9226, 19.5273);
}

export function createControls(ctx: AppContext): HTMLElement {
  const { view, bus, store } = ctx;
  const el = h('div', 'ui-panel ui-controls', { 'aria-label': 'Controles del mapa' });
  el.innerHTML = `
    <div class="ctl-group">
      <button class="ctl" data-act="in" title="Acercar (+)" aria-label="Acercar">${ICON.plus}</button>
      <button class="ctl" data-act="out" title="Alejar (−)" aria-label="Alejar">${ICON.minus}</button>
    </div>
    <div class="ctl-group">
      <button class="ctl ctl-compass" data-act="north" title="Orientar al norte" aria-label="Orientar al norte"><span class="needle">${ICON.compass}</span></button>
    </div>
    <div class="ctl-group">
      <button class="ctl ctl-txt mono" data-act="pitch" title="Vista 2D / 3D">3D</button>
      <button class="ctl" data-act="centre" title="Centro · Parque Juárez" aria-label="Centrar en Parque Juárez">${ICON.locate}</button>
      <button class="ctl" data-act="fs" title="Pantalla completa" aria-label="Pantalla completa">${ICON.fullscreen}</button>
    </div>`;
  const needle = el.querySelector<HTMLElement>('.needle')!;
  const pitchBtn = el.querySelector<HTMLElement>('[data-act="pitch"]')!;

  el.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('button');
    if (!b) return;
    switch (b.dataset.act) {
      case 'in':
        view.zoomBy(1);
        break;
      case 'out':
        view.zoomBy(-1);
        break;
      case 'north':
        view.resetNorth();
        break;
      case 'pitch':
        view.setPitch(view.getCameraState().pitch > 8 ? 0 : 58);
        break;
      case 'centre': {
        const c = cityCentre(ctx);
        bus.emit('view:flyTo', { x: c.x, z: c.z, zoom: 0.66, pitch: 58, bearing: 0, duration: 1.6 });
        break;
      }
      case 'fs':
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen?.().catch(() => bus.emit('ui:toast', { text: 'Pantalla completa no disponible', kind: 'warn' }));
        break;
    }
  });

  // compass + 2D/3D label follow the camera; only touch the DOM when the value changes
  bus.on('view:frame', () => {
    if (!store.get().ready) return;
    const cam = view.getCameraState();
    setStyle(needle, 'transform', `rotate(${(-cam.bearing).toFixed(1)}deg)`);
    setText(pitchBtn, cam.pitch > 8 ? '2D' : '3D');
  });
  return el;
}

export function createAttribution(): HTMLElement {
  return h('div', 'ui-attrib mono', null, '© OpenStreetMap · Imagery © Esri · MVIA sim');
}
