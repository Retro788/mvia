/**
 * Map picking → selection / build / bulldoze, plus selection helpers shared by every HUD component.
 */
import type { AppContext, Establishment, EstablishmentType, Landmark, Selection, ToolId, Vec2, Zone } from '../core/types';
import { dist2 } from './dom';

export const isBuildTool = (t: ToolId): t is EstablishmentType => t !== 'inspect' && t !== 'bulldoze';

export function cellSelection(ctx: AppContext, p: Vec2, cellIndex?: number): Selection | null {
  const idx = cellIndex ?? ctx.sim.cellIndexAt(p.x, p.z);
  if (idx < 0) return null;
  return { kind: 'cell', id: String(idx), point: { x: p.x, z: p.z }, cellIndex: idx };
}

export function selectZone(ctx: AppContext, zone: Zone, fly = true): void {
  const { sim, store, bus } = ctx;
  const sel: Selection = { kind: 'zone', id: zone.id, point: { ...zone.center }, cellIndex: sim.cellIndexAt(zone.center.x, zone.center.z) };
  store.set({ selection: sel });
  if (fly) bus.emit('view:flyTo', { x: zone.center.x, z: zone.center.z, zoom: 0.62 });
}

export function selectEstablishment(ctx: AppContext, e: Establishment, fly = true): void {
  ctx.store.set({ selection: { kind: 'establishment', id: e.id, point: { ...e.pos }, cellIndex: e.cellIndex } });
  if (fly) ctx.bus.emit('view:flyTo', { x: e.pos.x, z: e.pos.z, zoom: 0.72 });
}

export function selectLandmark(ctx: AppContext, l: Landmark, fly = true): void {
  ctx.store.set({ selection: { kind: 'landmark', id: l.id, point: { ...l.pos }, cellIndex: ctx.sim.cellIndexAt(l.pos.x, l.pos.z) } });
  if (fly) ctx.bus.emit('view:flyTo', { x: l.pos.x, z: l.pos.z, zoom: 0.72 });
}

export function selectPoint(ctx: AppContext, p: Vec2, fly = true, zoom = 0.66): void {
  const sel = cellSelection(ctx, p);
  ctx.store.set({ selection: sel });
  if (fly && sel) ctx.bus.emit('view:flyTo', { x: p.x, z: p.z, zoom });
}

export function nearestEstablishment(ctx: AppContext, x: number, z: number, maxDist: number): Establishment | null {
  let best: Establishment | null = null;
  let bd = maxDist * maxDist;
  for (const e of ctx.sim.establishments()) {
    const d = dist2(e.pos, x, z);
    if (d <= bd) {
      bd = d;
      best = e;
    }
  }
  return best;
}

export function nearestLandmark(ctx: AppContext, x: number, z: number): Landmark | null {
  let best: Landmark | null = null;
  let bd = Infinity;
  for (const l of ctx.sim.mapData.landmarks) {
    const r = l.size || 8;
    const d = dist2(l.pos, x, z);
    if (d <= r * r && d < bd) {
      bd = d;
      best = l;
    }
  }
  return best;
}

export function initInteraction(ctx: AppContext): void {
  const { bus, store, sim } = ctx;

  bus.on('view:click', ({ point, cellIndex, button }) => {
    if (!store.get().ready) return;
    if (button === 2) {
      // secondary click: drop tool, then selection
      if (store.get().tool !== 'inspect') store.set({ tool: 'inspect' });
      else store.set({ selection: null });
      return;
    }
    if (button !== 0) return;
    const tool = store.get().tool;

    if (tool === 'inspect') {
      const e = nearestEstablishment(ctx, point.x, point.z, 6);
      if (e) return selectEstablishment(ctx, e, false);
      const l = nearestLandmark(ctx, point.x, point.z);
      if (l) return selectLandmark(ctx, l, false);
      store.set({ selection: cellSelection(ctx, point, cellIndex) });
      return;
    }

    if (tool === 'bulldoze') {
      const e = nearestEstablishment(ctx, point.x, point.z, 10);
      if (!e) {
        bus.emit('ui:toast', { text: 'No hay establecimientos aquí para demoler', kind: 'warn' });
        return;
      }
      sim.removeEstablishment(e.id); // sim announces the removal with its own toast
      const sel = store.get().selection;
      if (sel?.kind === 'establishment' && sel.id === e.id) store.set({ selection: null });
      return;
    }

    // build tool: place, select, keep tool active (Esc exits).
    // The sim itself toasts success (investment / ROI / payback) or the reason a site is rejected.
    const placed = sim.placeEstablishment(tool, point.x, point.z, 'user');
    if (placed) selectEstablishment(ctx, placed, false);
  });

  // other modules (chatbot) can ask the HUD to select something
  bus.on('ui:select', (sel) => store.set({ selection: sel }));

  // reflect the active tool on <body> so ui.css can switch the map cursor
  const syncTool = () => {
    document.body.dataset.tool = store.get().tool;
  };
  store.subscribe(syncTool, ['tool']);
  syncTool();
}
