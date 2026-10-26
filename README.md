# MVIA · Xalapa Urban Sight

**MVIA — Master Validation of Infrastructure Artificial Algorithm.** Plataforma 3D (Three.js + WebGL + TypeScript) que simula el crecimiento urbano descontrolado de Xalapa, Ver., y analiza valores de suelo, crédito, hipotecas y viabilidad de establecimientos comerciales.

## Ejecutar

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + build estático en dist/
```

## Qué incluye

- **Mapa 3D de Xalapa real**: 12,771 vialidades, ríos y áreas de OpenStreetMap horneadas en `public/data/xalapa-osm.json`; relieve (Macuiltépetl, Cerro Colorado…), ~65k edificios, 32k árboles, 1,280 vehículos, 27 hitos modelados.
- **Estilos**: Clay (tipo Mapbox claro), Satélite (Esri World Imagery en vivo, con respaldo procedural), Scan MVIA y Noche.
- **Lente MVIA** estilo *machine-sight*: revela la vista de profundidad azul pixelada alrededor del cursor.
- **Simulación 2026→2050** en 3 escenarios (descontrolado / tendencial / ordenado): crecimiento de la mancha urbana, pérdida de áreas verdes, población, déficit de vivienda.
- **Capas de análisis**: valor de suelo, crecimiento, riesgo crediticio, tasa hipotecaria, demanda comercial, inundación, densidad.
- **Finanzas**: cotizador hipotecario (bancario, Infonavit, Fovissste, Cofinavit), CAT, ingreso requerido, riesgo.
- **Comercio**: plazas, plazoletas, tiendas, supermercados, centros comerciales, vivienda y oficinas con score MVIA, ROI, payback y cap rate; sugerencias de ubicación.
- **Comparador** lado a lado (año base vs. escenario).
- **Chatbot MVIA** local en español (NLU por intenciones, acciones sobre el mapa); modo Claude opcional con API key propia.
- **MVIA Voice**: estudio de voz tipo ElevenLabs (voces neuronales del navegador; API real de ElevenLabs opcional).

## Atajos

`1–4` estilos · `L` lente · `Espacio` reproducir · `C` chat · `V` voz · `B` edificios · `,` `.` año · `Esc` limpiar · `?` ayuda

## Estructura

`src/core` contrato y utilidades · `src/data` cartografía · `src/sim` modelo urbano y financiero · `src/world` escena 3D · `src/render` cámara, lente y post-proceso · `src/ui` HUD · `src/ai` chatbot · `src/voice` síntesis de voz.

> Las cifras de mercado y crédito son estimaciones simuladas con fines de análisis, no datos oficiales.
