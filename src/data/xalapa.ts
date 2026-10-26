/**
 * MVIA · Base de conocimiento geográfico de Xalapa, Veracruz.
 *
 * Coordenadas aproximadas (lon/lat WGS84) convertidas a unidades de mundo con lonLatToWorld
 * (1 u = 10 m, +x este, -z norte). Los valores de suelo son estimaciones 2026 en MXN/m²
 * calibradas por segmento (premium Ánimas, Centro, clase media, popular, periferia, rural).
 */
import type { Area, Landmark, Road, RoadClass, Vec2, Waterway, Zone } from '../core/types';
import { lonLatToWorld, rng } from '../core/geo';

type LonLat = [lon: number, lat: number];

const ll = (lon: number, lat: number): Vec2 => lonLatToWorld(lon, lat);
const path = (pts: LonLat[]): Vec2[] => pts.map(([lon, lat]) => lonLatToWorld(lon, lat));

/**
 * Organic closed polygon around `c`: an ellipse (rx, rz, rotated rotDeg clockwise from east in x/z)
 * whose radius is modulated by two low harmonics plus a little per-vertex noise, so shapes read as
 * natural boundaries instead of perfect ellipses. Deterministic for a given seed.
 */
export function blobPolygon(c: Vec2, rx: number, rz: number, rotDeg: number, n: number, seed: number, jitter = 0.14): Vec2[] {
  const r = rng(seed);
  const rot = (rotDeg * Math.PI) / 180;
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  const p2 = r() * Math.PI * 2;
  const p3 = r() * Math.PI * 2;
  const a2 = jitter * (0.5 + r() * 0.5);
  const a3 = jitter * (0.3 + r() * 0.5);
  const out: Vec2[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const f = 1 + a2 * Math.cos(2 * a + p2) + a3 * Math.cos(3 * a + p3) + (r() - 0.5) * jitter * 0.6;
    const lx = Math.cos(a) * rx * f;
    const lz = Math.sin(a) * rz * f;
    out.push({ x: c.x + lx * cr - lz * sr, z: c.z + lx * sr + lz * cr });
  }
  return out;
}

// ───────────────────────────── Colonias / sectores ─────────────────────────────
type ZoneSeed = Omit<Zone, 'center'> & { at: LonLat };

const ZONE_SEEDS: ZoneSeed[] = [
  // ── núcleo histórico y universitario
  { id: 'centro', name: 'Centro Histórico', kind: 'centro', at: [-96.9232, 19.5288], radius: 62, basePriceM2: 12500, density: 0.92, income: 'medio', floodRisk: 0.12, floors: [2, 5],
    description: 'Corazón colonial de Xalapa con calles empinadas, Catedral, Palacio de Gobierno y comercio tradicional de alta afluencia peatonal.' },
  { id: 'zona-uv', name: 'Zona Universitaria (UV)', kind: 'universitaria', at: [-96.9150, 19.5252], radius: 42, basePriceM2: 10800, density: 0.7, income: 'medio-alto', floodRisk: 0.22, floors: [2, 6],
    description: 'Campus histórico de la Universidad Veracruzana junto a Los Lagos y el Estadio, con fuerte demanda de renta estudiantil.' },
  { id: 'rebsamen', name: 'Rébsamen', kind: 'residencial', at: [-96.9170, 19.5335], radius: 34, basePriceM2: 8400, density: 0.85, income: 'medio', floodRisk: 0.08, floors: [2, 4],
    description: 'Colonia consolidada al noreste del Centro, sobre la Av. Rébsamen, con servicios médicos y comercio de barrio.' },
  { id: 'rafael-lucio', name: 'Rafael Lucio', kind: 'residencial', at: [-96.9265, 19.5375], radius: 42, basePriceM2: 7400, density: 0.82, income: 'medio', floodRisk: 0.08, floors: [1, 4],
    description: 'Barrio tradicional de clase media al norte del Centro, cruzado por la Av. Orizaba y bien conectado al transporte.' },
  { id: 'badillo', name: 'Badillo', kind: 'residencial', at: [-96.9335, 19.5340], radius: 34, basePriceM2: 6900, density: 0.8, income: 'medio', floodRisk: 0.1, floors: [1, 3],
    description: 'Colonia céntrica al poniente, entre Av. Ávila Camacho y Av. Xalapa, de vivienda unifamiliar y comercio local.' },
  { id: 'ferrer-guardia', name: 'Ferrer Guardia', kind: 'residencial', at: [-96.9330, 19.5272], radius: 34, basePriceM2: 7200, density: 0.82, income: 'medio', floodRisk: 0.18, floors: [1, 4],
    description: 'Zona habitacional junto a Los Berros y la salida a Coatepec, con plusvalía estable por cercanía al Centro.' },
  { id: 'carolino-anaya', name: 'Carolino Anaya', kind: 'residencial', at: [-96.9105, 19.5368], radius: 30, basePriceM2: 7000, density: 0.82, income: 'medio', floodRisk: 0.1, floors: [1, 3],
    description: 'Colonia compacta entre la 20 de Noviembre y Lázaro Cárdenas, con alta ocupación y servicios completos.' },
  { id: 'progreso-macuiltepetl', name: 'Progreso Macuiltépetl', kind: 'residencial', at: [-96.9118, 19.5428], radius: 40, basePriceM2: 6300, density: 0.78, income: 'medio', floodRisk: 0.06, floors: [1, 3],
    description: 'Ladera oriente del cerro Macuiltépetl, de vivienda media y vistas al ANP, con presión sobre el borde natural.' },
  { id: 'el-olmo', name: 'El Olmo', kind: 'residencial', at: [-96.9345, 19.5435], radius: 40, basePriceM2: 6000, density: 0.76, income: 'medio', floodRisk: 0.1, floors: [1, 3],
    description: 'Colonia sobre la Av. Xalapa cerca del Museo de Antropología, con mezcla de vivienda y oficinas pequeñas.' },
  { id: 'lomas-san-roque', name: 'Lomas de San Roque', kind: 'residencial', at: [-96.9410, 19.5420], radius: 34, basePriceM2: 5600, density: 0.7, income: 'medio', floodRisk: 0.16, floors: [1, 3],
    description: 'Lomerío arbolado junto al Molino de San Roque, de calles sinuosas y vivienda media sobre pendiente.' },

  // ── oriente y Ánimas (corredor de mayor plusvalía)
  { id: 'las-animas', name: 'Las Ánimas', kind: 'comercial', at: [-96.8872, 19.5205], radius: 50, basePriceM2: 15500, density: 0.68, income: 'alto', floodRisk: 0.12, floors: [2, 10],
    description: 'Corredor comercial y corporativo sobre Lázaro Cárdenas con Plaza Ánimas, torres de oficinas y servicios financieros.' },
  { id: 'animas-marqueza', name: 'Fraccionamiento Ánimas / Ánimas Marqueza', kind: 'premium', at: [-96.8930, 19.5130], radius: 55, basePriceM2: 19500, density: 0.55, income: 'alto', floodRisk: 0.08, floors: [2, 14],
    description: 'Fraccionamientos residenciales de mayor valor de la ciudad, con torres de departamentos y clubes privados.' },
  { id: 'monte-magno', name: 'Monte Magno / Lomas de las Ánimas', kind: 'premium', at: [-96.8760, 19.5170], radius: 45, basePriceM2: 16500, density: 0.45, income: 'alto', floodRisk: 0.1, floors: [2, 12],
    description: 'Desarrollos cerrados premium al oriente de Plaza Américas con vivienda residencial y verticalización reciente.' },
  { id: 'indeco-animas', name: 'Indeco Ánimas', kind: 'residencial', at: [-96.8835, 19.5270], radius: 40, basePriceM2: 7800, density: 0.84, income: 'medio', floodRisk: 0.14, floors: [1, 3],
    description: 'Unidad habitacional consolidada al norte de Ánimas, con fuerte comercio de barrio y buena conectividad.' },
  { id: 'lomas-verdes', name: 'Lomas Verdes', kind: 'residencial', at: [-96.8970, 19.5335], radius: 42, basePriceM2: 8800, density: 0.72, income: 'medio-alto', floodRisk: 0.08, floors: [1, 5],
    description: 'Colonia de clase media alta junto a la Torre Médica e IMSS, con demanda de consultorios y vivienda vertical.' },
  { id: 'murillo-vidal', name: 'Rafael Murillo Vidal', kind: 'residencial', at: [-96.9000, 19.5260], radius: 38, basePriceM2: 7700, density: 0.8, income: 'medio', floodRisk: 0.16, floors: [1, 4],
    description: 'Colonia sobre la Av. Murillo Vidal, eje que conecta Los Lagos con Ánimas y concentra comercio y servicios.' },
  { id: 'encinal', name: 'El Encinal', kind: 'residencial', at: [-96.9030, 19.5170], radius: 36, basePriceM2: 9200, density: 0.7, income: 'medio-alto', floodRisk: 0.12, floors: [1, 5],
    description: 'Zona residencial arbolada sobre Av. Américas, de clase media alta y con edificios de departamentos recientes.' },
  { id: 'pomona', name: 'Pomona', kind: 'residencial', at: [-96.9030, 19.5330], radius: 36, basePriceM2: 6600, density: 0.78, income: 'medio', floodRisk: 0.14, floors: [1, 3],
    description: 'Colonia de clase media entre la 20 de Noviembre y Ruiz Cortines, cercana a la CAXA y al panteón Palo Verde.' },
  { id: 'campo-viejo', name: 'Campo Viejo', kind: 'popular', at: [-96.9100, 19.5195], radius: 34, basePriceM2: 4400, density: 0.8, income: 'medio-bajo', floodRisk: 0.32, floors: [1, 2],
    description: 'Colonia popular en la hondonada al sur de Los Lagos, con escurrimientos y riesgo moderado de encharcamiento.' },
  { id: 'emiliano-zapata', name: 'Emiliano Zapata (Culturas Veracruzanas)', kind: 'residencial', at: [-96.9080, 19.5125], radius: 38, basePriceM2: 6400, density: 0.72, income: 'medio', floodRisk: 0.18, floors: [1, 4],
    description: 'Colonia del campus sur de la UV y la USBI, sobre el Bv. Culturas Veracruzanas, con renta estudiantil creciente.' },
  { id: 'xalapa-2000', name: 'Xalapa 2000', kind: 'residencial', at: [-96.9010, 19.5070], radius: 40, basePriceM2: 5600, density: 0.72, income: 'medio', floodRisk: 0.22, floors: [1, 3],
    description: 'Fraccionamiento de vivienda media al sur, conectado al Circuito Presidentes y al Arco Sur.' },
  { id: 'pastoresa', name: 'Pastoresa', kind: 'residencial', at: [-96.8780, 19.5048], radius: 40, basePriceM2: 6200, density: 0.7, income: 'medio', floodRisk: 0.22, floors: [1, 3],
    description: 'Fraccionamiento junto a la carretera a Veracruz y Plaza Américas, con vivienda media y comercio de paso.' },
  { id: 'sipeh-animas', name: 'Sipeh Ánimas', kind: 'popular', at: [-96.8880, 19.5045], radius: 40, basePriceM2: 4300, density: 0.82, income: 'medio-bajo', floodRisk: 0.28, floors: [1, 2],
    description: 'Colonia popular al sur de Ánimas, densa y en pendiente hacia el Río Carneros, sobre el Arco Vial Sur.' },
  { id: 'reserva-territorial', name: 'Reserva Territorial', kind: 'popular', at: [-96.8830, 19.5390], radius: 52, basePriceM2: 3600, density: 0.72, income: 'medio-bajo', floodRisk: 0.2, floors: [1, 3],
    description: 'Polígono de vivienda popular planificada al oriente, sobre la Av. Chedraui Caram, con déficit de equipamiento.' },
  { id: 'tatahuicapan', name: 'Tatahuicapan', kind: 'popular', at: [-96.8940, 19.5470], radius: 40, basePriceM2: 3200, density: 0.7, income: 'bajo', floodRisk: 0.22, floors: [1, 2],
    description: 'Colonia popular del nororiente junto al Cerro de la Galaxia, con autoconstrucción y calles sin pavimentar.' },

  // ── norte y poniente
  { id: 'revolucion', name: 'Revolución', kind: 'popular', at: [-96.9050, 19.5470], radius: 46, basePriceM2: 4200, density: 0.8, income: 'medio-bajo', floodRisk: 0.16, floors: [1, 3],
    description: 'Colonia popular extensa al norte de Lázaro Cárdenas, de vivienda progresiva y comercio familiar.' },
  { id: 'obrero-campesina', name: 'Obrero Campesina', kind: 'popular', at: [-96.9215, 19.5525], radius: 40, basePriceM2: 3900, density: 0.78, income: 'medio-bajo', floodRisk: 0.12, floors: [1, 3],
    description: 'Colonia obrera al norte del Macuiltépetl, densa, con mercados locales y transporte saturado.' },
  { id: 'casa-blanca', name: 'Casa Blanca', kind: 'popular', at: [-96.9310, 19.5535], radius: 38, basePriceM2: 3600, density: 0.7, income: 'medio-bajo', floodRisk: 0.14, floors: [1, 2],
    description: 'Colonia popular del norponiente, en lomerío, con lotes irregulares y crecimiento por autoconstrucción.' },
  { id: 'martires-chicago', name: 'Mártires de Chicago', kind: 'popular', at: [-96.9010, 19.5545], radius: 40, basePriceM2: 3300, density: 0.72, income: 'medio-bajo', floodRisk: 0.2, floors: [1, 2],
    description: 'Colonia popular del norte hacia el Río Sedeño, con servicios incompletos y alta densidad de lote.' },
  { id: 'higueras', name: 'Las Higueras', kind: 'popular', at: [-96.9410, 19.5345], radius: 34, basePriceM2: 3900, density: 0.74, income: 'medio-bajo', floodRisk: 0.2, floors: [1, 2],
    description: 'Colonia popular del poniente entre barrancas, con calles angostas y vivienda en ladera.' },
  { id: 'aguacatal', name: 'Aguacatal', kind: 'popular', at: [-96.9375, 19.5205], radius: 36, basePriceM2: 4400, density: 0.76, income: 'medio-bajo', floodRisk: 0.24, floors: [1, 2],
    description: 'Barrio popular sobre la antigua carretera a Coatepec, cercano al Jardín Botánico y a escurrimientos.' },
  { id: 'benito-juarez', name: 'Benito Juárez', kind: 'popular', at: [-96.9485, 19.5265], radius: 36, basePriceM2: 3700, density: 0.68, income: 'medio-bajo', floodRisk: 0.2, floors: [1, 2],
    description: 'Colonia popular del poniente entre la carretera a Coatepec y el camino a El Tronconal, con lotes en ladera.' },
  { id: 'el-moral', name: 'El Moral', kind: 'popular', at: [-96.9290, 19.5115], radius: 40, basePriceM2: 3400, density: 0.66, income: 'medio-bajo', floodRisk: 0.34, floors: [1, 2],
    description: 'Colonia popular del sur junto al Tejar Garnica y el Circuito Presidentes, con riesgo de escurrimientos.' },
  { id: 'jardines-de-xalapa', name: 'Jardines de Xalapa', kind: 'residencial', at: [-96.9190, 19.5130], radius: 40, basePriceM2: 5300, density: 0.7, income: 'medio', floodRisk: 0.36, floors: [1, 3],
    description: 'Fraccionamiento de vivienda media sobre el valle del Arroyo Papas, con riesgo de inundación en temporada de lluvias.' },
  { id: 'el-haya', name: 'El Haya', kind: 'residencial', at: [-96.9470, 19.5030], radius: 32, basePriceM2: 8200, density: 0.6, income: 'medio-alto', floodRisk: 0.12, floors: [1, 4],
    description: 'Zona residencial arbolada sobre la carretera a Coatepec, junto al bosque de niebla y desarrollos cerrados.' },
  { id: 'sumidero', name: 'El Sumidero', kind: 'popular', at: [-96.9455, 19.5570], radius: 45, basePriceM2: 3000, density: 0.58, income: 'bajo', floodRisk: 0.38, floors: [1, 2],
    description: 'Colonia popular del norponiente en la salida a Banderilla, con hundimientos y drenaje pluvial insuficiente.' },
  { id: '21-de-marzo', name: '21 de Marzo', kind: 'popular', at: [-96.9510, 19.5465], radius: 42, basePriceM2: 2800, density: 0.62, income: 'bajo', floodRisk: 0.18, floors: [1, 2],
    description: 'Asentamiento popular en ladera al poniente, de origen irregular y con regularización de lotes en curso.' },
  { id: 'nuevo-xalapa', name: 'Nuevo Xalapa', kind: 'popular', at: [-96.9590, 19.5360], radius: 45, basePriceM2: 2600, density: 0.55, income: 'bajo', floodRisk: 0.2, floors: [1, 2],
    description: 'Colonia popular del borde poniente hacia El Tronconal, con lotificación reciente y servicios parciales.' },

  // ── corredores industriales y de expansión (frentes de crecimiento)
  { id: 'industrial-veracruz', name: 'Corredor Industrial Carretera Veracruz', kind: 'industrial', at: [-96.8690, 19.5000], radius: 48, basePriceM2: 2900, density: 0.35, income: 'medio-bajo', floodRisk: 0.3, floors: [1, 2],
    description: 'Bodegas, talleres y logística sobre la carretera federal a Veracruz, junto al Río Carneros.' },
  { id: 'arco-sur', name: 'Corredor Arco Sur', kind: 'periferia', at: [-96.9000, 19.4975], radius: 120, basePriceM2: 2400, density: 0.22, income: 'medio', floodRisk: 0.18, floors: [1, 6], growthFront: true,
    description: 'Frente de expansión sobre el libramiento sur con plazas comerciales, fraccionamientos cerrados y vivienda en serie.' },
  { id: 'reserva-santa-barbara', name: 'Santa Bárbara', kind: 'periferia', at: [-96.8690, 19.5320], radius: 70, basePriceM2: 1700, density: 0.28, income: 'medio-bajo', floodRisk: 0.24, floors: [1, 2], growthFront: true,
    description: 'Periferia oriente que absorbe la saturación de la Reserva Territorial con lotes baratos y vivienda progresiva.' },
  { id: 'lucas-martin', name: 'Lucas Martín', kind: 'periferia', at: [-96.9090, 19.5610], radius: 55, basePriceM2: 2000, density: 0.3, income: 'bajo', floodRisk: 0.34, floors: [1, 2], growthFront: true,
    description: 'Borde norte junto al Río Sedeño donde la mancha urbana avanza sobre terrenos ejidales.' },
  { id: 'coapexpan', name: 'Coapexpan', kind: 'periferia', at: [-96.9580, 19.5060], radius: 60, basePriceM2: 2300, density: 0.32, income: 'medio-bajo', floodRisk: 0.45, floors: [1, 2], growthFront: true,
    description: 'Congregación del surponiente en el valle del Río Coapexpan, presionada por fraccionamientos de interés social.' },
  { id: 'banderilla', name: 'Banderilla', kind: 'periferia', at: [-96.9405, 19.5850], radius: 90, basePriceM2: 2300, density: 0.42, income: 'medio-bajo', floodRisk: 0.14, floors: [1, 3], growthFront: true,
    description: 'Municipio conurbado al norponiente sobre la carretera a Perote, con crecimiento lineal hacia Xalapa.' },
  { id: 'las-trancas', name: 'Las Trancas', kind: 'periferia', at: [-96.8560, 19.5110], radius: 75, basePriceM2: 2500, density: 0.3, income: 'medio', floodRisk: 0.26, floors: [1, 4], growthFront: true,
    description: 'Nodo de expansión en el entronque del Arco Sur con la carretera a Veracruz, con nuevas plazas y fraccionamientos.' },
  { id: 'rancho-viejo', name: 'Rancho Viejo', kind: 'periferia', at: [-96.9480, 19.4930], radius: 70, basePriceM2: 1900, density: 0.24, income: 'medio', floodRisk: 0.2, floors: [1, 3], growthFront: true,
    description: 'Corredor Xalapa–Coatepec con fraccionamientos campestres que sustituyen cafetales y bosque de niebla.' },
  { id: 'dos-rios', name: 'Dos Ríos (Emiliano Zapata)', kind: 'periferia', at: [-96.8460, 19.4870], radius: 85, basePriceM2: 1300, density: 0.2, income: 'medio-bajo', floodRisk: 0.52, floors: [1, 2], growthFront: true,
    description: 'Localidad conurbada al sureste en la confluencia de ríos, con vivienda en serie en zonas inundables.' },
  { id: 'el-castillo', name: 'El Castillo', kind: 'rural', at: [-96.8560, 19.5565], radius: 75, basePriceM2: 850, density: 0.14, income: 'bajo', floodRisk: 0.22, floors: [1, 2], growthFront: true,
    description: 'Congregación rural al oriente con parcelas agrícolas que se lotifican sin planeación ni servicios.' },
  { id: 'pacho-viejo', name: 'Pacho Viejo', kind: 'rural', at: [-96.9320, 19.4740], radius: 80, basePriceM2: 700, density: 0.12, income: 'bajo', floodRisk: 0.28, floors: [1, 2], growthFront: true,
    description: 'Localidad rural al sur rumbo a Coatepec, entre cafetales y el Río Sordo, con lotificación dispersa.' },
  { id: 'tronconal', name: 'El Tronconal', kind: 'rural', at: [-96.9700, 19.5300], radius: 80, basePriceM2: 600, density: 0.1, income: 'bajo', floodRisk: 0.2, floors: [1, 2], growthFront: true,
    description: 'Congregación rural del poniente con bosque y potreros, alcanzada por asentamientos irregulares.' },
  { id: 'chiltoyac', name: 'Chiltoyac', kind: 'rural', at: [-96.8700, 19.5800], radius: 80, basePriceM2: 450, density: 0.08, income: 'bajo', floodRisk: 0.3, floors: [1, 2], growthFront: true,
    description: 'Congregación rural al nororiente, de cañaverales y potreros, el frente más lejano de la expansión.' },
];

export const ZONES: Zone[] = ZONE_SEEDS.map(({ at, ...z }) => ({ ...z, center: ll(at[0], at[1]) }));

// ───────────────────────────── Hitos urbanos ─────────────────────────────
type LandmarkSeed = Omit<Landmark, 'pos'> & { at: LonLat };

const LANDMARK_SEEDS: LandmarkSeed[] = [
  { id: 'parque-juarez', name: 'Parque Juárez', kind: 'plaza', at: [-96.9236, 19.5274], size: 8, height: 0.5,
    description: 'Plaza principal de Xalapa, balcón natural hacia el Pico de Orizaba y punto de reunión cívica.' },
  { id: 'agora', name: 'Ágora de la Ciudad', kind: 'teatro', at: [-96.9241, 19.5270], size: 5, height: 0.6,
    description: 'Centro cultural bajo el Parque Juárez con cine, galería y foro abierto.' },
  { id: 'catedral', name: 'Catedral Metropolitana', kind: 'catedral', at: [-96.9223, 19.5291], size: 5, height: 4.5,
    description: 'Catedral de la Inmaculada Concepción, templo de piso inclinado iniciado en el siglo XVII.' },
  { id: 'palacio-gobierno', name: 'Palacio de Gobierno', kind: 'gobierno', at: [-96.9219, 19.5280], size: 6, height: 2.2,
    description: 'Sede del Poder Ejecutivo de Veracruz sobre la calle Enríquez, con murales de Mario Orozco Rivera.' },
  { id: 'palacio-municipal', name: 'Palacio Municipal', kind: 'gobierno', at: [-96.9246, 19.5281], size: 5, height: 1.8,
    description: 'Ayuntamiento de Xalapa frente al Parque Juárez, sede del gobierno de la ciudad.' },
  { id: 'mercado-jauregui', name: 'Mercado Jáuregui', kind: 'mercado', at: [-96.9214, 19.5300], size: 5, height: 1.2,
    description: 'Mercado tradicional del Centro, referencia de abasto popular y comercio de barrio.' },
  { id: 'teatro-estado', name: 'Teatro del Estado', kind: 'teatro', at: [-96.9290, 19.5322], size: 7, height: 2.4,
    description: 'Teatro del Estado Ignacio de la Llave, sede de la Orquesta Sinfónica de Xalapa.' },
  { id: 'los-berros', name: 'Parque Los Berros', kind: 'parque', at: [-96.9285, 19.5248], size: 10, height: 0.3,
    description: 'Parque arbolado tradicional al poniente del Centro, con andadores y escurrimientos naturales.' },
  { id: 'hospital-civil', name: 'Hospital Civil Dr. Luis F. Nachón', kind: 'hospital', at: [-96.9205, 19.5330], size: 8, height: 2.4,
    description: 'Hospital público histórico de referencia regional, de alta demanda de servicios en su entorno.' },
  { id: 'lagos-dique', name: 'Paseo de los Lagos · Lago del Dique', kind: 'lago', at: [-96.9180, 19.5240], size: 16, height: 0.1,
    description: 'Cadena de lagos artificiales y andadores entre el Centro y la Zona Universitaria.' },
  { id: 'estadio', name: 'Estadio Xalapeño Heriberto Jara', kind: 'estadio', at: [-96.9140, 19.5300], size: 18, height: 2.4,
    description: 'Estadio construido en 1925 aprovechando una barranca natural, ícono deportivo de la ciudad.' },
  { id: 'rectoria-uv', name: 'Rectoría UV · Lomas del Estadio', kind: 'universidad', at: [-96.9142, 19.5262], size: 8, height: 3.2,
    description: 'Rectoría y facultades de la Universidad Veracruzana en la Zona Universitaria.' },
  { id: 'usbi', name: 'USBI Xalapa', kind: 'universidad', at: [-96.9070, 19.5135], size: 9, height: 2.6,
    description: 'Unidad de Servicios Bibliotecarios de la UV, eje del campus sur sobre Culturas Veracruzanas.' },
  { id: 'max', name: 'Museo de Antropología de Xalapa', kind: 'museo', at: [-96.9345, 19.5478], size: 14, height: 1.6,
    description: 'MAX: segundo museo arqueológico más importante de México, con las cabezas colosales olmecas.' },
  { id: 'plaza-museo', name: 'Plaza Museo', kind: 'centroComercial', at: [-96.9312, 19.5455], size: 9, height: 1.6,
    description: 'Centro comercial de escala media sobre la Av. Xalapa, cerca del Museo de Antropología.' },
  { id: 'macuiltepetl', name: 'Cerro de Macuiltépetl', kind: 'cerro', at: [-96.9178, 19.5465], size: 30, height: 1.2,
    description: 'Volcán extinto y Área Natural Protegida con mirador, el punto más alto dentro de la ciudad.' },
  { id: 'plaza-crystal', name: 'Plaza Crystal', kind: 'centroComercial', at: [-96.9218, 19.5395], size: 12, height: 2.4,
    description: 'Centro comercial sobre Lázaro Cárdenas, con tiendas ancla, cines y alta afluencia vehicular.' },
  { id: 'caxa', name: 'CAXA · Central de Autobuses', kind: 'terminal', at: [-96.9050, 19.5372], size: 12, height: 1.4,
    description: 'Central de Autobuses de Xalapa sobre la Av. 20 de Noviembre, puerta regional de la ciudad.' },
  { id: 'central-abastos', name: 'Central de Abastos', kind: 'mercado', at: [-96.8950, 19.5408], size: 14, height: 1.4,
    description: 'Principal centro de distribución mayorista de alimentos de la región capital.' },
  { id: 'torre-medica', name: 'Torre Médica · IMSS Lomas Verdes', kind: 'hospital', at: [-96.8945, 19.5318], size: 9, height: 6,
    description: 'Clúster hospitalario y de consultorios que impulsa la verticalización de Lomas Verdes.' },
  { id: 'parque-natura', name: 'Parque Natura', kind: 'parque', at: [-96.8960, 19.5205], size: 22, height: 0.3,
    description: 'Parque ecológico urbano con lago, senderos y bosque, pulmón del oriente de la ciudad.' },
  { id: 'plaza-animas', name: 'Plaza Ánimas', kind: 'centroComercial', at: [-96.8880, 19.5200], size: 12, height: 2.2,
    description: 'Centro comercial sobre Lázaro Cárdenas en el corazón del corredor Ánimas.' },
  { id: 'plaza-americas', name: 'Plaza Américas', kind: 'centroComercial', at: [-96.8800, 19.5120], size: 14, height: 2,
    description: 'Mayor centro comercial de Xalapa, con tiendas departamentales en el acceso desde Veracruz.' },
  { id: 'jardin-botanico', name: 'Jardín Botánico Clavijero', kind: 'parque', at: [-96.9435, 19.5120], size: 18, height: 0.3,
    description: 'Jardín botánico del INECOL con colecciones de bosque de niebla sobre la antigua carretera a Coatepec.' },
  { id: 'molino-san-roque', name: 'Molino de San Roque', kind: 'parque', at: [-96.9440, 19.5395], size: 10, height: 0.6,
    description: 'Antiguo molino y parque ecológico en una cañada arbolada del poniente.' },
  { id: 'cerro-colorado', name: 'Cerro Colorado', kind: 'cerro', at: [-96.9505, 19.5165], size: 40, height: 0,
    description: 'Elevación boscosa del surponiente que limita naturalmente la expansión hacia Coapexpan.' },
  { id: 'cerro-galaxia', name: 'Cerro de la Galaxia', kind: 'cerro', at: [-96.8870, 19.5435], size: 20, height: 0,
    description: 'Área Natural Protegida del oriente rodeada por colonias populares en crecimiento.' },
];

export const LANDMARKS: Landmark[] = LANDMARK_SEEDS.map(({ at, ...l }) => ({ ...l, pos: ll(at[0], at[1]) }));

// ───────────────────────────── Áreas naturales protegidas ─────────────────────────────
export const PROTECTED_AREAS: Area[] = [
  { id: 'anp-macuiltepetl', name: 'ANP Cerro de Macuiltépetl', kind: 'protected', polygon: blobPolygon(ll(-96.9178, 19.5465), 30, 27, 20, 13, 101) },
  { id: 'anp-natura', name: 'Parque Natura', kind: 'protected', polygon: blobPolygon(ll(-96.8960, 19.5205), 23, 15, -15, 12, 102) },
  { id: 'anp-galaxia', name: 'ANP Cerro de la Galaxia', kind: 'protected', polygon: blobPolygon(ll(-96.8870, 19.5435), 21, 17, 35, 11, 103) },
  { id: 'anp-san-roque', name: 'Molino de San Roque', kind: 'protected', polygon: blobPolygon(ll(-96.9440, 19.5395), 13, 9, 60, 10, 104) },
  { id: 'anp-tejar', name: 'ANP El Tejar Garnica', kind: 'protected', polygon: blobPolygon(ll(-96.9325, 19.5050), 36, 26, 10, 14, 105) },
  { id: 'santuario-niebla', name: 'Jardín Botánico · Santuario del Bosque de Niebla', kind: 'forest', polygon: blobPolygon(ll(-96.9465, 19.5115), 18, 22, 0, 12, 106) },
  { id: 'anp-lagos', name: 'Paseo de los Lagos', kind: 'protected', polygon: blobPolygon(ll(-96.9182, 19.5242), 36, 11, 42, 12, 107, 0.08) },
  { id: 'pacho-nuevo', name: 'Cinturón forestal Pacho Nuevo', kind: 'forest', polygon: blobPolygon(ll(-96.9300, 19.4865), 90, 30, -8, 14, 108) },
  { id: 'cerro-colorado', name: 'Bosque del Cerro Colorado', kind: 'forest', polygon: blobPolygon(ll(-96.9505, 19.5165), 36, 30, 25, 12, 109) },
];

// ───────────────────────────── Vialidades primarias ─────────────────────────────
const road = (id: string, name: string, cls: RoadClass, pts: LonLat[]): Road => ({ id, name, cls, points: path(pts) });

export const MAIN_ROADS: Road[] = [
  road('m-avila-camacho', 'Av. Manuel Ávila Camacho', 'primary', [
    [-96.9238, 19.5282], [-96.9258, 19.5292], [-96.9280, 19.5304], [-96.9300, 19.5313], [-96.9325, 19.5326], [-96.9350, 19.5342],
    [-96.9372, 19.5362], [-96.9392, 19.5385], [-96.9410, 19.5410], [-96.9428, 19.5440], [-96.9445, 19.5476], [-96.9462, 19.5520],
  ]),
  road('m-banderilla', 'Carretera Xalapa–Banderilla–Perote', 'trunk', [
    [-96.9462, 19.5520], [-96.9465, 19.5570], [-96.9455, 19.5625], [-96.9440, 19.5680], [-96.9425, 19.5735], [-96.9415, 19.5790],
    [-96.9425, 19.5840], [-96.9465, 19.5872], [-96.9540, 19.5888], [-96.9650, 19.5895], [-96.9800, 19.5897], [-96.9980, 19.5898],
  ]),
  road('m-lazaro-cardenas', 'Av. Lázaro Cárdenas', 'trunk', [
    [-96.9462, 19.5520], [-96.9420, 19.5528], [-96.9380, 19.5524], [-96.9340, 19.5515], [-96.9300, 19.5495], [-96.9262, 19.5465],
    [-96.9230, 19.5430], [-96.9205, 19.5405], [-96.9160, 19.5392], [-96.9110, 19.5390], [-96.9060, 19.5394], [-96.9010, 19.5397],
    [-96.8965, 19.5385], [-96.8930, 19.5350], [-96.8905, 19.5300], [-96.8885, 19.5250], [-96.8868, 19.5200], [-96.8845, 19.5155],
    [-96.8815, 19.5120], [-96.8790, 19.5095],
  ]),
  road('m-xalapa', 'Av. Xalapa', 'primary', [
    [-96.9300, 19.5313], [-96.9303, 19.5340], [-96.9308, 19.5370], [-96.9315, 19.5400], [-96.9320, 19.5430], [-96.9326, 19.5456],
    [-96.9333, 19.5480], [-96.9338, 19.5500], [-96.9340, 19.5515],
  ]),
  road('m-20-noviembre', 'Av. 20 de Noviembre', 'primary', [
    [-96.9205, 19.5292], [-96.9170, 19.5305], [-96.9140, 19.5322], [-96.9105, 19.5340], [-96.9075, 19.5352], [-96.9045, 19.5364],
    [-96.9015, 19.5378], [-96.8985, 19.5390],
  ]),
  road('m-ruiz-cortines', 'Av. Adolfo Ruiz Cortines', 'primary', [
    [-96.9168, 19.5300], [-96.9125, 19.5292], [-96.9080, 19.5300], [-96.9040, 19.5305], [-96.9000, 19.5306], [-96.8960, 19.5303],
    [-96.8930, 19.5301], [-96.8905, 19.5300],
  ]),
  road('m-murillo-vidal', 'Av. Rafael Murillo Vidal', 'secondary', [
    [-96.9110, 19.5262], [-96.9070, 19.5258], [-96.9030, 19.5254], [-96.8990, 19.5248], [-96.8950, 19.5240], [-96.8910, 19.5232],
    [-96.8880, 19.5226],
  ]),
  road('m-americas', 'Av. de las Américas', 'primary', [
    [-96.9150, 19.5235], [-96.9110, 19.5215], [-96.9070, 19.5195], [-96.9030, 19.5180], [-96.8990, 19.5168], [-96.8945, 19.5155],
    [-96.8900, 19.5148], [-96.8848, 19.5150],
  ]),
  road('m-miguel-aleman', 'Av. Miguel Alemán', 'secondary', [
    [-96.9090, 19.5345], [-96.9088, 19.5315], [-96.9085, 19.5290], [-96.9083, 19.5262], [-96.9080, 19.5232], [-96.9075, 19.5200],
  ]),
  road('m-rebsamen', 'Av. Enrique C. Rébsamen', 'secondary', [
    [-96.9180, 19.5290], [-96.9172, 19.5310], [-96.9168, 19.5335], [-96.9170, 19.5360], [-96.9180, 19.5383], [-96.9198, 19.5402],
  ]),
  road('m-orizaba', 'Av. Orizaba', 'secondary', [
    [-96.9255, 19.5300], [-96.9258, 19.5330], [-96.9262, 19.5360], [-96.9260, 19.5390], [-96.9250, 19.5418], [-96.9238, 19.5440],
  ]),
  road('m-maestros', 'Av. Maestros Veracruzanos', 'secondary', [
    [-96.9105, 19.5340], [-96.9108, 19.5365], [-96.9112, 19.5390], [-96.9105, 19.5420], [-96.9090, 19.5450], [-96.9070, 19.5480],
    [-96.9045, 19.5510],
  ]),
  road('m-culturas', 'Bv. Culturas Veracruzanas', 'secondary', [
    [-96.9110, 19.5215], [-96.9098, 19.5190], [-96.9092, 19.5160], [-96.9085, 19.5135], [-96.9075, 19.5105], [-96.9060, 19.5075],
    [-96.9048, 19.5050],
  ]),
  road('m-enriquez-zamora', 'Enríquez · Zamora', 'secondary', [
    [-96.9285, 19.5277], [-96.9255, 19.5280], [-96.9235, 19.5282], [-96.9215, 19.5279], [-96.9195, 19.5275], [-96.9175, 19.5270],
    [-96.9155, 19.5265],
  ]),
  road('m-chedraui-caram', 'Av. Chedraui Caram', 'secondary', [
    [-96.8935, 19.5355], [-96.8900, 19.5370], [-96.8860, 19.5385], [-96.8820, 19.5395], [-96.8780, 19.5400], [-96.8740, 19.5398],
  ]),
  road('m-circuito-presidentes', 'Circuito Presidentes', 'primary', [
    [-96.9420, 19.5100], [-96.9360, 19.5110], [-96.9310, 19.5112], [-96.9260, 19.5105], [-96.9215, 19.5090], [-96.9165, 19.5075],
    [-96.9110, 19.5062], [-96.9048, 19.5050], [-96.8990, 19.5052], [-96.8930, 19.5068], [-96.8880, 19.5088], [-96.8830, 19.5105],
  ]),
  road('m-arco-sur', 'Libramiento Arco Sur', 'motorway', [
    [-96.9490, 19.4930], [-96.9420, 19.4925], [-96.9350, 19.4935], [-96.9280, 19.4950], [-96.9200, 19.4955], [-96.9120, 19.4950],
    [-96.9040, 19.4955], [-96.8960, 19.4970], [-96.8880, 19.4985], [-96.8800, 19.4995], [-96.8720, 19.5005], [-96.8650, 19.5025],
    [-96.8590, 19.5048],
  ]),
  road('m-arco-vial-sur', 'Av. Arco Vial Sur', 'primary', [
    [-96.8890, 19.5145], [-96.8893, 19.5120], [-96.8898, 19.5090], [-96.8905, 19.5060], [-96.8915, 19.5025], [-96.8925, 19.4995],
    [-96.8932, 19.4975],
  ]),
  road('m-veracruz', 'Carretera Federal Xalapa–Veracruz', 'trunk', [
    [-96.8790, 19.5095], [-96.8740, 19.5085], [-96.8690, 19.5075], [-96.8640, 19.5065], [-96.8590, 19.5048], [-96.8550, 19.5020],
    [-96.8520, 19.4980], [-96.8490, 19.4935], [-96.8460, 19.4890], [-96.8430, 19.4850], [-96.8406, 19.4815],
  ]),
  road('m-coatepec', 'Carretera Xalapa–Coatepec', 'trunk', [
    [-96.9280, 19.5250], [-96.9310, 19.5225], [-96.9345, 19.5200], [-96.9380, 19.5170], [-96.9405, 19.5140], [-96.9418, 19.5105],
    [-96.9430, 19.5060], [-96.9450, 19.5010], [-96.9470, 19.4960], [-96.9485, 19.4910], [-96.9500, 19.4850], [-96.9520, 19.4790],
    [-96.9545, 19.4730], [-96.9570, 19.4670],
  ]),
  road('m-chiltoyac', 'Carretera a Chiltoyac', 'secondary', [
    [-96.9045, 19.5510], [-96.9000, 19.5560], [-96.8950, 19.5610], [-96.8880, 19.5660], [-96.8800, 19.5720], [-96.8720, 19.5780],
    [-96.8680, 19.5830],
  ]),
  road('m-el-castillo', 'Carretera Xalapa–El Castillo', 'secondary', [
    [-96.8740, 19.5398], [-96.8680, 19.5440], [-96.8620, 19.5500], [-96.8570, 19.5550], [-96.8520, 19.5600], [-96.8470, 19.5650],
  ]),
  road('m-tronconal', 'Camino a El Tronconal', 'tertiary', [
    [-96.9392, 19.5385], [-96.9450, 19.5370], [-96.9520, 19.5350], [-96.9600, 19.5320], [-96.9680, 19.5300], [-96.9760, 19.5290],
    [-96.9850, 19.5285],
  ]),
];

// ───────────────────────────── Ríos y arroyos ─────────────────────────────
const river = (id: string, name: string, width: number, pts: LonLat[]): Waterway => ({ id, name, width, points: path(pts) });

export const RIVERS: Waterway[] = [
  river('w-sedeno', 'Río Sedeño', 2.6, [
    [-96.9900, 19.5760], [-96.9750, 19.5740], [-96.9620, 19.5715], [-96.9500, 19.5690], [-96.9380, 19.5672], [-96.9260, 19.5660],
    [-96.9150, 19.5665], [-96.9040, 19.5680], [-96.8940, 19.5700], [-96.8830, 19.5720], [-96.8720, 19.5735], [-96.8600, 19.5745],
    [-96.8480, 19.5760], [-96.8405, 19.5775],
  ]),
  river('w-chiltoyac', 'Arroyo Chiltoyac', 1.3, [
    [-96.8780, 19.5890], [-96.8740, 19.5840], [-96.8700, 19.5800], [-96.8660, 19.5770], [-96.8620, 19.5750],
  ]),
  river('w-carneros', 'Río Carneros', 1.8, [
    [-96.9060, 19.5290], [-96.9020, 19.5268], [-96.8985, 19.5228], [-96.8950, 19.5185], [-96.8910, 19.5115], [-96.8860, 19.5062],
    [-96.8800, 19.5028], [-96.8730, 19.4985], [-96.8650, 19.4935], [-96.8570, 19.4890], [-96.8490, 19.4860], [-96.8405, 19.4840],
  ]),
  river('w-papas', 'Arroyo Papas', 1.2, [
    [-96.9290, 19.5262], [-96.9245, 19.5240], [-96.9212, 19.5212], [-96.9188, 19.5180], [-96.9170, 19.5140], [-96.9150, 19.5095],
    [-96.9130, 19.5040], [-96.9110, 19.4990], [-96.9090, 19.4930], [-96.9060, 19.4870],
  ]),
  river('w-sordo', 'Río Sordo', 2.0, [
    [-96.9900, 19.5000], [-96.9760, 19.4950], [-96.9620, 19.4890], [-96.9500, 19.4840], [-96.9380, 19.4790], [-96.9260, 19.4740],
    [-96.9140, 19.4700], [-96.9020, 19.4670], [-96.8900, 19.4655],
  ]),
  river('w-coapexpan', 'Río Coapexpan', 1.5, [
    [-96.9850, 19.5280], [-96.9760, 19.5220], [-96.9680, 19.5150], [-96.9610, 19.5080], [-96.9560, 19.5010], [-96.9520, 19.4940],
    [-96.9500, 19.4860], [-96.9505, 19.4842],
  ]),
];

// ───────────────────────────── Frentes de expansión ─────────────────────────────
/** Sprawl attractors for the uncontrolled-growth scenario (strength 0..1). */
export const GROWTH_FRONTS: Array<{ id: string; name: string; pos: Vec2; strength: number }> = [
  { id: 'gf-arco-sur', name: 'Arco Sur · Las Trancas', pos: ll(-96.8650, 19.5030), strength: 1 },
  { id: 'gf-santa-barbara', name: 'Reserva Territorial · Santa Bárbara', pos: ll(-96.8720, 19.5330), strength: 0.9 },
  { id: 'gf-coatepec', name: 'Corredor Coatepec · Rancho Viejo', pos: ll(-96.9460, 19.4900), strength: 0.85 },
  { id: 'gf-dos-rios', name: 'Emiliano Zapata · Dos Ríos', pos: ll(-96.8460, 19.4870), strength: 0.8 },
  { id: 'gf-banderilla', name: 'Banderilla', pos: ll(-96.9400, 19.5800), strength: 0.75 },
  { id: 'gf-el-castillo', name: 'El Castillo', pos: ll(-96.8570, 19.5550), strength: 0.6 },
  { id: 'gf-coapexpan', name: 'Coapexpan', pos: ll(-96.9580, 19.5070), strength: 0.55 },
  { id: 'gf-tronconal', name: 'El Tronconal', pos: ll(-96.9690, 19.5300), strength: 0.5 },
  { id: 'gf-chiltoyac', name: 'Chiltoyac', pos: ll(-96.8700, 19.5790), strength: 0.45 },
];
