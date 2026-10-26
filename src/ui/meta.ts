/** Static Spanish copy + colour metadata shared by several HUD components. */
import type { LayerId, MapStyle, ScenarioId } from '../core/types';

export const STYLES: Array<{ id: MapStyle; label: string }> = [
  { id: 'clay', label: 'Clay' },
  { id: 'satellite', label: 'Satélite' },
  { id: 'scan', label: 'Scan' },
  { id: 'night', label: 'Noche' },
];

export interface ScenarioMeta {
  id: ScenarioId;
  label: string;
  color: string;
  desc: string;
}

export const SCENARIOS: ScenarioMeta[] = [
  {
    id: 'descontrolado',
    label: 'Descontrolado',
    color: 'var(--risk)',
    desc: 'Expansión dispersa sin regulación: la mancha urbana sube por laderas, zonas de recarga y reservas ecológicas.',
  },
  {
    id: 'tendencial',
    label: 'Tendencial',
    color: 'var(--warn)',
    desc: 'Sigue la inercia 2010–2025: periferia que crece a ritmo moderado y densificación parcial del centro.',
  },
  {
    id: 'ordenado',
    label: 'Ordenado',
    color: 'var(--ok)',
    desc: 'Densificación, usos mixtos y protección de ANP: crecimiento compacto ligado a transporte público.',
  },
];

export const scenarioMeta = (id: ScenarioId): ScenarioMeta => SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];

export interface LayerMeta {
  id: LayerId;
  label: string;
  unit: string;
  /** css gradient stops for swatch + legend (best-effort match of the world overlay ramps) */
  ramp: string[];
  lo: string;
  mid: string;
  hi: string;
  note: string;
}

// ramps mirror mOverlay() in world/materials.ts so the legend matches what is painted on the map
const RAMP_VALUE = ['#f6f1d9', '#f2c879', '#ea8a3c', '#d04a2f', '#7d1d3f'];
const RAMP_RISK = ['#3ddc84', '#a9d65e', '#f5b83d', '#f0743a', '#e0303a'];
const RAMP_COMMERCE = ['#1d3f9e', '#2f7fe0', '#4fd1ff', '#a8ecff', '#ffffff'];
const RAMP_DENSITY = ['#e4e3de', '#b9b8b2', '#85858a', '#4a4b50', '#111214'];
const RAMP_GROWTH = ['rgba(255,106,31,0.12)', 'rgba(255,106,31,0.35)', 'rgba(255,106,31,0.6)', 'rgba(255,106,31,0.85)', '#ff6a1f'];

export const LAYERS: LayerMeta[] = [
  { id: 'none', label: 'Ninguna', unit: '—', ramp: ['var(--clay)', 'var(--paper-2)'], lo: '', mid: '', hi: '', note: 'Modelo de arcilla sin capa temática.' },
  { id: 'landValue', label: 'Valor de suelo', unit: 'MXN/m²', ramp: RAMP_VALUE, lo: 'Bajo', mid: 'Medio', hi: 'Alto', note: 'Precio de suelo por m² en el año activo (escala logarítmica).' },
  {
    id: 'growth',
    label: 'Crecimiento urbano',
    unit: 'expansión',
    ramp: RAMP_GROWTH,
    lo: 'Presión',
    mid: 'Urbano 2026',
    hi: 'Nuevo',
    note: 'Celdas urbanizadas desde 2026 y presión de urbanización en los próximos 6 años.',
  },
  { id: 'creditRisk', label: 'Riesgo crediticio', unit: 'P(impago)', ramp: RAMP_RISK, lo: 'Bajo', mid: 'Medio', hi: 'Alto', note: 'Probabilidad de impago estimada por MVIA.' },
  { id: 'mortgage', label: 'Tasa hipotecaria', unit: '% anual', ramp: RAMP_VALUE, lo: 'Baja', mid: 'Media', hi: 'Alta', note: 'Tasa típica según riesgo de celda y escenario.' },
  { id: 'commercial', label: 'Demanda comercial', unit: 'índice', ramp: RAMP_COMMERCE, lo: 'Baja', mid: 'Media', hi: 'Alta', note: 'Potencial de comercio: población, accesibilidad y competencia.' },
  { id: 'floodRisk', label: 'Riesgo de inundación', unit: 'índice', ramp: RAMP_RISK, lo: 'Bajo', mid: 'Medio', hi: 'Alto', note: 'Escurrimientos, cauces y pendiente (barrancas, Sedeño, Carneros).' },
  { id: 'density', label: 'Densidad', unit: 'construida', ramp: RAMP_DENSITY, lo: 'Baja', mid: 'Media', hi: 'Alta', note: 'Intensidad de construcción y población por celda.' },
];

export const layerMeta = (id: LayerId): LayerMeta => LAYERS.find((l) => l.id === id) ?? LAYERS[0];

export const rampCss = (ramp: string[], dir = '90deg'): string => `linear-gradient(${dir}, ${ramp.join(', ')})`;
