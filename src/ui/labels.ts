/**
 * DOM tags over the map (machine-sight "■ PED 95 waiting" style): landmarks, priciest zones, establishments
 * and growth fronts. Positioned each frame via view.project + translate3d, faded by camera zoom and
 * decluttered greedily in priority order (a tag is skipped when it overlaps one already placed).
 */
import type { AppContext } from '../core/types';
import { fmtMXN } from '../core/geo';
import { clamp, esc, h, n1, setStyle, shortName, throttle } from './dom';
import { selectEstablishment, selectLandmark, selectZone } from './interaction';

type TagKind = 'est' | 'landmark' | 'front' | 'zone';

interface Tag {
  key: string;
  kind: TagKind;
  el: HTMLElement;
  x: number;
  y: number;
  z: number;
  pri: number;
  minZoom: number;
  maxZoom: number;
  w: number;
  h: number;
  html: string;
  on: boolean;
  /** id of the target for click → select */
  ref: string;
}

const MAX_TAGS = 160;
const STEM = 12; // px between the anchor point and the tag box

export function createLabels(ctx: AppContext): HTMLElement {
  const { store, sim, view, world, bus } = ctx;
  const layer = h('div', 'ui-labels ui-pass');
  const tags = new Map<string, Tag>();
  let order: Tag[] = [];
  // flat rect buffer for declutter (x0,y0,x1,y1) — preallocated, no per-frame garbage
  const rects = new Float32Array(MAX_TAGS * 4);

  const upsert = (key: string, kind: TagKind, ref: string, x: number, z: number, lift: number, html: string, pri: number, minZoom: number, maxZoom: number) => {
    let t = tags.get(key);
    if (!t) {
      const el = h('div', `map-tag tag-${kind}`, { 'data-key': key });
      layer.appendChild(el);
      t = { key, kind, el, x, y: 0, z, pri, minZoom, maxZoom, w: 0, h: 0, html: '', on: false, ref };
      tags.set(key, t);
    }
    t.x = x;
    t.z = z;
    t.y = world.groundY(x, z) + lift;
    t.pri = pri;
    t.minZoom = minZoom;
    t.maxZoom = maxZoom;
    t.ref = ref;
    if (t.html !== html) {
      t.html = html;
      t.el.innerHTML = html;
      t.w = 0; // re-measure
    }
    return t;
  };

  const rebuild = () => {
    const seen = new Set<string>();
    const year = store.get().year;
    const mark = (t: Tag) => seen.add(t.key);

    // establishments (highest priority: user content)
    for (const e of sim.establishments()) {
      const spec = sim.spec(e.type);
      const num = e.id.replace(/\D/g, '').slice(-2).padStart(2, '0');
      mark(
        upsert(
          `e:${e.id}`,
          'est',
          e.id,
          e.pos.x,
          e.pos.z,
          spec.height + 2,
          `<i class="sq" style="background:${spec.color}"></i>${esc(spec.short)} ${num} · ROI ${n1(e.roi)}%`,
          0,
          0.18,
          1.01,
        ),
      );
    }
    // landmarks: big ones get priority 1, the rest 4
    for (const l of sim.mapData.landmarks) {
      const big = (l.size ?? 0) >= 12 || l.kind === 'catedral' || l.kind === 'estadio' || l.kind === 'cerro' || l.kind === 'lago';
      const name = l.name.length > 26 ? `${l.name.slice(0, 25)}…` : l.name;
      mark(upsert(`l:${l.id}`, 'landmark', l.id, l.pos.x, l.pos.z, (l.height ?? 3) + 1.5, `<i class="dia">◆</i>${esc(name.toUpperCase())}`, big ? 1 : 4, big ? 0 : 0.35, 1.01));
    }
    // growth fronts (only once the projection actually moves)
    if (year > 2030) {
      for (const zs of sim.topZones('growth', 6)) {
        if (zs.urbanShare < 0.04) continue;
        const z = zs.zone;
        mark(
          upsert(
            `f:${z.id}`,
            'front',
            z.id,
            z.center.x,
            z.center.z,
            4,
            `<i class="sq" style="background:var(--risk)"></i>FRENTE · ${esc(shortName(z.name).toUpperCase())} <b>+${Math.round(zs.urbanShare * 100)}%</b>`,
            2,
            0,
            0.78,
          ),
        );
      }
    }
    // priciest zones
    for (const zs of sim.topZones('landValue', 8)) {
      const z = zs.zone;
      if (seen.has(`f:${z.id}`)) continue;
      mark(
        upsert(
          `z:${z.id}`,
          'zone',
          z.id,
          z.center.x,
          z.center.z,
          5,
          `<i class="sq" style="background:var(--ramp-3)"></i>ZONA · ${esc(shortName(z.name).toUpperCase())} <b>${fmtMXN(zs.landValue)}/m²</b>`,
          3,
          0,
          0.72,
        ),
      );
    }
    for (const [k, t] of tags) {
      if (!seen.has(k)) {
        t.el.remove();
        tags.delete(k);
      }
    }
    order = [...tags.values()].sort((a, b) => a.pri - b.pri);
    if (order.length > MAX_TAGS) order.length = MAX_TAGS;
  };
  const rebuildSoon = throttle(rebuild, 400);

  const hideAll = () => {
    for (const t of order) {
      if (t.on) {
        t.on = false;
        t.el.classList.remove('on');
      }
    }
  };

  bus.on('view:frame', () => {
    const s = store.get();
    if (!s.ready || !s.showLabels) return;
    const zoom = view.getCameraState().zoom;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let placed = 0;
    const selKey = s.selection ? s.selection.id : '';
    for (let k = 0; k < order.length; k++) {
      const t = order[k];
      let show = zoom >= t.minZoom && zoom <= t.maxZoom && t.ref !== selKey;
      let x0 = 0;
      let y0 = 0;
      if (show) {
        if (!t.w) {
          // measured lazily (once per text change) so the layer can be built before it is attached
          t.w = t.el.offsetWidth;
          t.h = t.el.offsetHeight;
          if (!t.w) continue;
        }
        const p = view.project(t.x, t.y, t.z);
        x0 = p.x - t.w * 0.5;
        y0 = p.y - t.h - STEM;
        show = p.visible && x0 > -t.w && x0 < vw && y0 > -t.h && y0 < vh;
        if (show) {
          // greedy declutter against already placed rects (4px breathing room)
          for (let r = 0; r < placed; r++) {
            const o = r * 4;
            if (x0 - 4 < rects[o + 2] && x0 + t.w + 4 > rects[o] && y0 - 3 < rects[o + 3] && y0 + t.h + 3 > rects[o + 1]) {
              show = false;
              break;
            }
          }
        }
      }
      if (show && placed < MAX_TAGS) {
        const o = placed * 4;
        rects[o] = x0;
        rects[o + 1] = y0;
        rects[o + 2] = x0 + t.w;
        rects[o + 3] = y0 + t.h + STEM;
        placed++;
        t.el.style.transform = `translate3d(${x0.toFixed(1)}px, ${y0.toFixed(1)}px, 0)`;
        // fade in over the first 0.08 of zoom inside the tag's range, and out near its max
        const fadeIn = t.minZoom === 0 ? 1 : (zoom - t.minZoom) / 0.08;
        const a = clamp(Math.min(fadeIn, (t.maxZoom - zoom) / 0.08), 0.15, 1);
        setStyle(t.el, 'opacity', (Math.round(a * 10) / 10).toString());
        if (!t.on) {
          t.on = true;
          t.el.classList.add('on');
        }
      } else if (t.on) {
        t.on = false;
        t.el.classList.remove('on');
      }
    }
  });

  layer.addEventListener('click', (ev) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('.map-tag');
    const t = el && tags.get(el.dataset.key ?? '');
    if (!t) return;
    if (t.kind === 'est') {
      const e = sim.establishments().find((x) => x.id === t.ref);
      if (e) selectEstablishment(ctx, e);
    } else if (t.kind === 'landmark') {
      const l = sim.mapData.landmarks.find((x) => x.id === t.ref);
      if (l) selectLandmark(ctx, l);
    } else {
      const zs = sim.zoneStats(t.ref);
      if (zs) selectZone(ctx, zs.zone);
    }
  });

  const syncVisible = () => {
    const s = store.get();
    layer.classList.toggle('off', !s.showLabels);
    if (!s.showLabels) hideAll();
  };
  store.subscribe(syncVisible, ['showLabels']);
  store.subscribe(rebuildSoon, ['ready', 'scenario']);
  let lastYear = store.get().year;
  store.subscribe((s) => {
    if (Math.abs(s.year - lastYear) >= 1 || (lastYear <= 2030) !== (s.year <= 2030)) {
      lastYear = s.year;
      rebuildSoon();
    }
  }, ['year']);
  bus.on('sim:projection', rebuildSoon);
  bus.on('sim:establishments', rebuildSoon);
  syncVisible();
  rebuild();
  return layer;
}
