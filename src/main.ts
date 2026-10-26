import './styles/tokens.css';
import './styles/ui.css';
import { Bus } from './core/bus';
import { Store } from './core/store';
import { YEAR_START } from './core/geo';
import type { AppContext } from './core/types';
import { loadMapData } from './data/loadMapData';
import { Simulation } from './sim/Simulation';
import { CityWorld } from './world/CityWorld';
import { MapView } from './render/MapView';
import { initUI } from './ui';
import { initChat } from './ai';
import { initVoice } from './voice';

async function boot() {
  const bus = new Bus();
  const store = new Store(bus);
  const progress = (p: number, label: string) => store.set({ loadingProgress: p, loadingLabel: label });

  // static loader in index.html is driven straight from the store while the city is generated
  const loader = document.getElementById('loader')!;
  const loaderBar = loader.querySelector<HTMLElement>('.loader-bar i')!;
  const loaderLabel = loader.querySelector<HTMLElement>('.loader-label')!;
  const loaderPct = loader.querySelector<HTMLElement>('.loader-pct')!;
  store.subscribe(
    (s) => {
      loaderBar.style.width = `${Math.round(s.loadingProgress * 100)}%`;
      loaderPct.textContent = `${Math.round(s.loadingProgress * 100).toString().padStart(3, '0')}`;
      loaderLabel.textContent = s.loadingLabel;
      if (s.ready) {
        loader.classList.add('done');
        setTimeout(() => loader.remove(), 1200);
      }
    },
    ['loadingProgress', 'loadingLabel', 'ready'],
  );

  const hud = document.getElementById('hud')!;
  const ctxPartial = { bus, store } as Partial<AppContext>;

  const mapData = await loadMapData(progress);

  progress(0.16, 'MVIA · proyectando crecimiento urbano');
  await frame();
  const sim = new Simulation(bus, store, mapData);
  sim.init();

  const world = new CityWorld(bus, store, mapData);
  await world.build((p, label) => progress(0.2 + p * 0.7, label));
  world.setUrbanizationYears(sim.urbanizationYears());
  world.setYear(YEAR_START);
  world.setEstablishments(sim.establishments());

  progress(0.92, 'Compilando shaders de visión MVIA');
  await frame();
  const view = new MapView(document.getElementById('app')!, world, bus, store, sim);

  const ctx: AppContext = { ...(ctxPartial as AppContext), sim, world, view };
  wire(ctx);
  initUI(ctx, hud);
  initChat(ctx, document.getElementById('chat-root')!);
  initVoice(ctx, document.getElementById('voice-root')!);

  view.start();
  progress(1, 'Listo');
  store.set({ ready: true });
  (window as unknown as { mvia: AppContext }).mvia = ctx; // debugging handle
}

/** Glue between store / sim / world. Each module stays unaware of the others. */
function wire({ bus, store, sim, world }: AppContext) {
  const refreshOverlay = () => {
    const { layer } = store.get();
    world.setOverlay(layer, layer === 'none' ? null : sim.layerField(layer));
  };

  let lastOverlayYear = -1;
  store.subscribe((s, changed) => {
    if (changed.includes('year')) {
      sim.setYear(s.year);
      world.setYear(s.year);
      if (s.layer !== 'none' && Math.abs(s.year - lastOverlayYear) >= 0.25) {
        lastOverlayYear = s.year;
        refreshOverlay();
      }
    }
    if (changed.includes('scenario')) sim.setScenario(s.scenario);
    if (changed.includes('mapStyle')) world.setStyle(s.mapStyle);
    if (changed.includes('layer')) refreshOverlay();
    if (changed.includes('selection')) world.setSelection(s.selection);
    if (changed.includes('showBuildings') || changed.includes('showTraffic')) {
      world.setVisibility({ buildings: s.showBuildings, traffic: s.showTraffic });
    }
  });

  bus.on('sim:projection', () => {
    world.setUrbanizationYears(sim.urbanizationYears());
    refreshOverlay();
  });
  bus.on('sim:establishments', ({ list }) => {
    world.setEstablishments(list);
    refreshOverlay();
  });
  bus.on('view:frame', ({ dt }) => sim.update(dt));
  bus.on('view:hover', ({ point }) => world.setFocus(point));
}

/** yield one frame; falls back to a timeout because rAF is paused in background tabs */
function frame() {
  return new Promise<void>((r) => {
    const t = setTimeout(r, 60);
    requestAnimationFrame(() => {
      clearTimeout(t);
      r();
    });
  });
}

boot().catch((err) => {
  console.error(err);
  const el = document.getElementById('boot-error');
  if (el) {
    el.textContent = `MVIA no pudo iniciar: ${err instanceof Error ? err.message : String(err)}`;
    el.style.display = 'block';
  }
});
