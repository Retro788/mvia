import type { AppState, IBus, IStore } from './types';
import { YEAR_START } from './geo';

export const initialState: AppState = {
  ready: false,
  loadingProgress: 0,
  loadingLabel: 'Inicializando MVIA',
  year: YEAR_START,
  playing: false,
  speed: 1.2,
  scenario: 'descontrolado',
  mapStyle: 'clay',
  layer: 'none',
  lens: true,
  lensRadius: 260,
  compare: false,
  compareYear: YEAR_START,
  showBuildings: true,
  showTraffic: true,
  showLabels: true,
  tool: 'inspect',
  selection: null,
  panel: 'mercado',
  chatOpen: false,
  voiceOpen: false,
  voiceAuto: true,
};

type Listener = { fn: (s: AppState, changed: Array<keyof AppState>) => void; keys?: Array<keyof AppState> };

export class Store implements IStore {
  private state: AppState;
  private listeners = new Set<Listener>();

  constructor(private bus: IBus, init: Partial<AppState> = {}) {
    this.state = { ...initialState, ...init };
  }

  get(): Readonly<AppState> {
    return this.state;
  }

  set(patch: Partial<AppState>): void {
    const changed: Array<keyof AppState> = [];
    for (const k of Object.keys(patch) as Array<keyof AppState>) {
      if (this.state[k] !== patch[k]) changed.push(k);
    }
    if (!changed.length) return;
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) {
      if (l.keys && !l.keys.some((k) => changed.includes(k))) continue;
      try {
        l.fn(this.state, changed);
      } catch (err) {
        console.error('[store] listener failed', err);
      }
    }
    this.bus.emit('state', { state: this.state, changed });
  }

  subscribe(fn: Listener['fn'], keys?: Array<keyof AppState>): () => void {
    const l: Listener = { fn, keys };
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
