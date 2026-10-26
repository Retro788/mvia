/**
 * MVIA Voice Studio — ElevenLabs-like "Text to Speech" modal (store.voiceOpen).
 */
import type { AppContext } from '../../core/types';
import { MAX_CHARS, type Clip, type VoiceController } from '../controller';
import { creditScript, cityScript, zoneScript } from '../inserts';
import { ELEVEN_PREMADE, MODELS, modelInfo, PERSONAS, type ModelId, type PersonaId, type VoiceSettings } from '../settings';
import { excerpt, fmtClock } from '../text';
import { isSpanish, qualityScore } from '../engines/catalog';
import { ICONS } from './icons';
import { Waveform } from './waveform';

const SAMPLE =
  'Xalapa crecerá hacia el Arco Sur y la salida a Coatepec durante la próxima década. Si el crecimiento sigue descontrolado, la mancha urbana ocupará laderas con pendientes mayores al quince por ciento y zonas con riesgo de inundación. MVIA recomienda densificar el centro, proteger el Parque Ecológico Macuiltépetl y orientar el crédito hipotecario hacia colonias con infraestructura consolidada.';

type SliderKey = 'stability' | 'similarity' | 'style' | 'speed';
const SLIDERS: Array<{ key: SliderKey; label: string; lo: string; hi: string; min: number; max: number; step: number; fmt: (v: number) => string; hint: string }> = [
  { key: 'stability', label: 'Estabilidad', lo: 'Más variable', hi: 'Más estable', min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2), hint: 'Variación de tono y ritmo entre frases.' },
  { key: 'similarity', label: 'Similitud', lo: 'Baja', hi: 'Alta', min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2), hint: 'Qué tan fiel es la voz a la persona elegida.' },
  { key: 'style', label: 'Exageración de estilo', lo: 'Ninguna', hi: 'Exagerada', min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2), hint: 'Entonación en preguntas y pausas expresivas.' },
  { key: 'speed', label: 'Velocidad', lo: 'Más lento', hi: 'Más rápido', min: 0.7, max: 1.2, step: 0.01, fmt: (v) => `${v.toFixed(2)}×`, hint: '' },
];

const SOURCE_LABEL: Record<Clip['source'], string> = { estudio: 'ESTUDIO', chat: 'ASISTENTE', replay: 'ESTUDIO' };

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const shortVoice = (name: string) => name.replace(/^Microsoft\s+/, '').replace(/\s+-\s+.*$/, '');

export function mountStudio(ctx: AppContext, root: HTMLElement, vc: VoiceController): void {
  const overlay = h('div', 'vx-overlay');
  overlay.innerHTML = `
  <section class="vx-studio" role="dialog" aria-modal="true" aria-labelledby="vx-title">
    <header class="vx-head">
      <div class="vx-head-l">
        <span class="vx-logo">${ICONS.wave}</span>
        <div>
          <div class="vx-kicker mono">MVIA VOICE · ESTUDIO DE SÍNTESIS</div>
          <h2 id="vx-title" class="vx-title">Texto a voz</h2>
        </div>
      </div>
      <div class="vx-head-r">
        <span class="vx-engine mono" data-engine></span>
        <button class="vx-icon-btn" type="button" data-close aria-label="Cerrar estudio" title="Cerrar (Esc)">${ICONS.close}</button>
      </div>
    </header>
    <div class="vx-body">
      <div class="vx-main">
        <div class="vx-editor">
          <textarea class="vx-text" spellcheck="true" maxlength="${MAX_CHARS}" aria-label="Texto a sintetizar" placeholder="${SAMPLE}"></textarea>
          <div class="vx-editor-foot">
            <div class="vx-chips">
              <button type="button" class="vx-chip" data-insert="city">${ICONS.sparkle}<span>Resumen de la ciudad</span></button>
              <button type="button" class="vx-chip" data-insert="zone">${ICONS.sparkle}<span>Zona seleccionada</span></button>
              <button type="button" class="vx-chip" data-insert="credit">${ICONS.sparkle}<span>Reporte de crédito</span></button>
            </div>
            <span class="vx-count mono" data-count></span>
          </div>
        </div>
        <div class="vx-player">
          <canvas class="vx-wave" aria-hidden="true"></canvas>
          <div class="vx-player-row">
            <div class="vx-actions">
              <button type="button" class="vx-btn-primary" data-generate>
                <span data-gen-label>Generar voz</span><kbd class="mono">Ctrl ↵</kbd>
              </button>
              <button type="button" class="vx-btn" data-stop disabled>${ICONS.stop}<span>Detener</span></button>
            </div>
            <div class="vx-time mono"><span data-state>LISTO</span><span data-clock>00:00.0 / 00:00.0</span></div>
          </div>
        </div>
        <div class="vx-history">
          <div class="vx-sec-head"><span class="mono">HISTORIAL</span><span class="mono vx-dim" data-hist-count></span></div>
          <ol class="vx-hist-list" data-hist></ol>
        </div>
      </div>
      <aside class="vx-side">
        <div class="vx-field">
          <div class="vx-label mono">VOZ</div>
          <div class="vx-personas" data-personas role="radiogroup" aria-label="Persona de voz"></div>
        </div>
        <div class="vx-field">
          <label class="vx-label mono" for="vx-sysvoice">VOZ DEL SISTEMA · AVANZADO</label>
          <select id="vx-sysvoice" class="vx-select" data-sysvoice></select>
        </div>
        <div class="vx-field">
          <label class="vx-label mono" for="vx-model">MODELO</label>
          <select id="vx-model" class="vx-select" data-model>
            ${MODELS.map((m) => `<option value="${m.id}">${m.label}</option>`).join('')}
          </select>
          <p class="vx-note" data-model-note></p>
        </div>
        <div class="vx-field vx-sliders" data-sliders>
          ${SLIDERS.map(
            (s) => `
            <div class="vx-slider" data-key="${s.key}">
              <div class="vx-slider-top"><span>${s.label}</span><output class="mono"></output></div>
              <input type="range" min="${s.min}" max="${s.max}" step="${s.step}" aria-label="${s.label}" />
              <div class="vx-slider-ends mono"><span>${s.lo}</span><span>${s.hi}</span></div>
            </div>`,
          ).join('')}
        </div>
        <div class="vx-field vx-toggles">
          <label class="vx-toggle"><input type="checkbox" data-toggle="speakerBoost" /><span class="vx-switch"></span><span>Refuerzo de locutor <em class="mono">speaker boost</em></span></label>
          <label class="vx-toggle"><input type="checkbox" data-toggle="coreSignature" /><span class="vx-switch"></span><span>Firma sonora MVIA Core <em class="mono">chime + hum</em></span></label>
        </div>
        <button type="button" class="vx-reset" data-reset>${ICONS.reset}<span>Restablecer valores</span></button>
        <details class="vx-api" data-api>
          <summary><span class="vx-api-title">${ICONS.key}<span>Conectar ElevenLabs (opcional)</span></span><span class="vx-api-state mono" data-api-state></span></summary>
          <div class="vx-api-body">
            <label class="vx-label mono" for="vx-key">CLAVE API</label>
            <input id="vx-key" class="vx-input mono" type="password" autocomplete="off" spellcheck="false" placeholder="sk_…" data-api-key />
            <label class="vx-label mono" for="vx-vid">VOICE ID</label>
            <input id="vx-vid" class="vx-input mono" type="text" autocomplete="off" spellcheck="false" list="vx-eleven-voices" data-api-voice />
            <datalist id="vx-eleven-voices">${ELEVEN_PREMADE.map((v) => `<option value="${v.id}">${v.name}</option>`).join('')}</datalist>
            <div class="vx-api-actions">
              <button type="button" class="vx-btn small" data-api-save>Guardar</button>
              <button type="button" class="vx-btn small ghost" data-api-forget>Olvidar clave</button>
            </div>
            <p class="vx-note">La clave se guarda solo en este navegador (localStorage) y se envía únicamente a api.elevenlabs.io. El audio generado puede descargarse en MP3.</p>
          </div>
        </details>
      </aside>
    </div>
  </section>`;
  root.appendChild(overlay);

  const $ = <T extends Element>(sel: string) => overlay.querySelector<T>(sel)!;
  const studio = $<HTMLElement>('.vx-studio');
  const textarea = $<HTMLTextAreaElement>('.vx-text');
  const count = $<HTMLElement>('[data-count]');
  const engineEl = $<HTMLElement>('[data-engine]');
  const genBtn = $<HTMLButtonElement>('[data-generate]');
  const genLabel = $<HTMLElement>('[data-gen-label]');
  const stopBtn = $<HTMLButtonElement>('[data-stop]');
  const stateEl = $<HTMLElement>('[data-state]');
  const clockEl = $<HTMLElement>('[data-clock]');
  const histEl = $<HTMLOListElement>('[data-hist]');
  const histCount = $<HTMLElement>('[data-hist-count]');
  const personasEl = $<HTMLElement>('[data-personas]');
  const sysSelect = $<HTMLSelectElement>('[data-sysvoice]');
  const modelSelect = $<HTMLSelectElement>('[data-model]');
  const modelNote = $<HTMLElement>('[data-model-note]');
  const apiState = $<HTMLElement>('[data-api-state]');
  const apiKey = $<HTMLInputElement>('[data-api-key]');
  const apiVoice = $<HTMLInputElement>('[data-api-voice]');
  const wave = new Waveform($<HTMLCanvasElement>('.vx-wave'));

  // ───────────── text editor ─────────────
  const updateCount = () => {
    count.textContent = `${textarea.value.length.toLocaleString('es-MX')} / ${MAX_CHARS.toLocaleString('es-MX')}`;
    count.classList.toggle('warn', textarea.value.length > MAX_CHARS * 0.9);
  };
  textarea.addEventListener('input', updateCount);
  updateCount();

  const insert = (text: string) => {
    const cur = textarea.value.trim();
    textarea.value = (cur ? `${cur}\n\n${text}` : text).slice(0, MAX_CHARS);
    updateCount();
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.scrollTop = textarea.scrollHeight;
  };

  overlay.querySelectorAll<HTMLButtonElement>('[data-insert]').forEach((b) =>
    b.addEventListener('click', () => {
      try {
        const kind = b.dataset.insert;
        if (kind === 'city') insert(cityScript(ctx));
        else if (kind === 'credit') insert(creditScript(ctx));
        else {
          const z = zoneScript(ctx);
          if (z) insert(z);
          else ctx.bus.emit('ui:toast', { text: 'Selecciona un punto en el mapa para leer su zona.', kind: 'info' });
        }
      } catch (err) {
        console.error('[voice] insert failed', err);
        ctx.bus.emit('ui:toast', { text: 'La simulación aún no tiene datos para este reporte.', kind: 'warn' });
      }
    }),
  );

  const generate = () => {
    const text = textarea.value.trim() || SAMPLE;
    void vc.speak(text, { source: 'estudio' });
  };
  genBtn.addEventListener('click', generate);
  stopBtn.addEventListener('click', () => vc.stop());

  // ───────────── personas ─────────────
  const personaCards = new Map<PersonaId, { btn: HTMLButtonElement; voice: HTMLElement }>();
  for (const p of PERSONAS) {
    const btn = h('button', 'vx-persona');
    btn.type = 'button';
    btn.setAttribute('role', 'radio');
    btn.dataset.id = p.id;
    const av = h('span', 'vx-avatar');
    av.style.setProperty('--a', p.colors[0]);
    av.style.setProperty('--b', p.colors[1]);
    av.style.setProperty('--c', p.colors[2]);
    if (p.synthetic) av.classList.add('synthetic');
    const txt = h('span', 'vx-persona-txt');
    const name = h('span', 'vx-persona-name', p.name);
    const tag = h('span', 'vx-persona-tag', p.tagline);
    const voice = h('span', 'vx-persona-voice mono');
    txt.append(name, tag, voice);
    const check = h('span', 'vx-persona-check');
    check.innerHTML = ICONS.check;
    btn.append(av, txt, check);
    btn.addEventListener('click', () => vc.update({ personaId: p.id, systemVoice: '' }));
    personasEl.appendChild(btn);
    personaCards.set(p.id, { btn, voice });
  }

  // ───────────── system voices ─────────────
  let voicesSig = '';
  const fillSystemVoices = () => {
    const all = vc.catalog.all();
    const sig = all.map((v) => v.voiceURI).join('|');
    if (sig !== voicesSig) {
      voicesSig = sig;
      sysSelect.textContent = '';
      sysSelect.appendChild(new Option(all.length ? 'Automática · según persona y similitud' : 'Cargando voces del sistema…', ''));
      const es = vc.catalog.spanish();
      const other = all.filter((v) => !isSpanish(v)).sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
      const group = (label: string, list: SpeechSynthesisVoice[]) => {
        if (!list.length) return;
        const g = document.createElement('optgroup');
        g.label = label;
        for (const v of list) g.appendChild(new Option(`${shortVoice(v.name)} — ${v.lang}${qualityScore(v) >= 50 ? ' · neural' : ''}`, v.voiceURI));
        sysSelect.appendChild(g);
      };
      group(`Español (${es.length})`, es);
      group(`Otros idiomas (${other.length})`, other);
    }
    sysSelect.value = vc.settings.systemVoice;
    if (sysSelect.value !== vc.settings.systemVoice) sysSelect.value = '';
  };
  sysSelect.addEventListener('change', () => vc.update({ systemVoice: sysSelect.value }));
  modelSelect.addEventListener('change', () => vc.update({ model: modelSelect.value as ModelId }));

  // ───────────── sliders & toggles ─────────────
  const sliderEls = new Map<SliderKey, { input: HTMLInputElement; out: HTMLOutputElement; fmt: (v: number) => string; min: number; max: number }>();
  for (const s of SLIDERS) {
    const wrap = $<HTMLElement>(`.vx-slider[data-key="${s.key}"]`);
    const input = wrap.querySelector('input')!;
    const out = wrap.querySelector('output')!;
    if (s.hint) wrap.title = s.hint;
    input.addEventListener('input', () => {
      const v = Number(input.value);
      paintSlider(input, out, v, s.fmt, s.min, s.max);
      vc.update({ [s.key]: v } as Partial<VoiceSettings>);
    });
    sliderEls.set(s.key, { input, out, fmt: s.fmt, min: s.min, max: s.max });
  }
  overlay.querySelectorAll<HTMLInputElement>('[data-toggle]').forEach((cb) =>
    cb.addEventListener('change', () => vc.update({ [cb.dataset.toggle as 'speakerBoost' | 'coreSignature']: cb.checked })),
  );
  $<HTMLButtonElement>('[data-reset]').addEventListener('click', () => {
    vc.resetSettings();
    ctx.bus.emit('ui:toast', { text: 'Valores de voz restablecidos.', kind: 'ok' });
  });

  // ───────────── ElevenLabs ─────────────
  apiKey.value = vc.apiKey;
  const saveApi = () => {
    const key = apiKey.value.trim();
    const vid = apiVoice.value.trim();
    if (vid) vc.update({ elevenVoiceId: vid });
    const had = Boolean(vc.apiKey);
    vc.setApiKey(key);
    if (key && !had && modelInfo(vc.settings.model).engine === 'browser') vc.update({ model: 'eleven_multilingual_v2' });
    ctx.bus.emit('ui:toast', { text: key ? 'ElevenLabs conectado. La clave quedó guardada solo en este navegador.' : 'Clave de ElevenLabs eliminada.', kind: key ? 'ok' : 'info' });
  };
  $<HTMLButtonElement>('[data-api-save]').addEventListener('click', saveApi);
  $<HTMLButtonElement>('[data-api-forget]').addEventListener('click', () => {
    apiKey.value = '';
    saveApi();
  });
  apiVoice.addEventListener('change', () => {
    const vid = apiVoice.value.trim();
    if (vid) vc.update({ elevenVoiceId: vid });
  });

  // ───────────── history ─────────────
  let histSig = '';
  const renderHistory = () => {
    const clips = vc.history();
    const playing = vc.playingClipId();
    const sig = `${clips.map((c) => `${c.id}:${c.duration.toFixed(1)}`).join(',')}|${playing}`;
    if (sig === histSig) return;
    histSig = sig;
    histCount.textContent = clips.length ? `${clips.length} CLIP${clips.length === 1 ? '' : 'S'} · ESTA SESIÓN` : 'ESTA SESIÓN';
    histEl.textContent = '';
    if (!clips.length) {
      const li = h('li', 'vx-hist-empty', 'Aún no hay clips. Escribe un texto y presiona Generar voz.');
      histEl.appendChild(li);
      return;
    }
    for (const c of clips) {
      const li = h('li', 'vx-hist-item');
      li.dataset.id = c.id;
      const isPlaying = c.id === playing;
      li.classList.toggle('playing', isPlaying);
      const play = h('button', 'vx-hist-play');
      play.type = 'button';
      play.dataset.act = isPlaying ? 'stop' : 'play';
      play.setAttribute('aria-label', isPlaying ? 'Detener' : 'Reproducir');
      play.innerHTML = isPlaying ? ICONS.stop : ICONS.play;
      const body = h('div', 'vx-hist-body');
      const ex = h('div', 'vx-hist-text', excerpt(c.text, 110));
      ex.title = c.text;
      const time = c.createdAt.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
      const engine = c.engine === 'eleven' ? 'ELEVENLABS' : 'NAVEGADOR';
      const meta = h('div', 'vx-hist-meta mono', `${c.persona.name.toUpperCase()} · ${fmtClock(c.duration).slice(0, 5)} · ${time} · ${engine} · ${SOURCE_LABEL[c.source]}`);
      body.append(ex, meta);
      li.append(play, body);
      if (c.eleven) {
        const dl = h('button', 'vx-icon-btn');
        dl.type = 'button';
        dl.dataset.act = 'download';
        dl.title = 'Descargar MP3';
        dl.setAttribute('aria-label', 'Descargar MP3');
        dl.innerHTML = ICONS.download;
        li.appendChild(dl);
      }
      const del = h('button', 'vx-icon-btn');
      del.type = 'button';
      del.dataset.act = 'delete';
      del.title = 'Eliminar';
      del.setAttribute('aria-label', 'Eliminar clip');
      del.innerHTML = ICONS.trash;
      li.appendChild(del);
      histEl.appendChild(li);
    }
  };
  histEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
    const li = btn?.closest<HTMLElement>('.vx-hist-item');
    if (!btn || !li?.dataset.id) return;
    const id = li.dataset.id;
    if (btn.dataset.act === 'play') void vc.replay(id);
    else if (btn.dataset.act === 'stop') vc.stop();
    else if (btn.dataset.act === 'download') vc.download(id);
    else if (btn.dataset.act === 'delete') vc.removeClip(id);
  });

  // ───────────── sync from controller ─────────────
  const sync = () => {
    const s = vc.settings;
    for (const [id, card] of personaCards) {
      const sel = id === s.personaId;
      card.btn.classList.toggle('selected', sel);
      card.btn.setAttribute('aria-checked', String(sel));
      const p = PERSONAS.find((x) => x.id === id)!;
      const v = vc.voiceFor(p);
      card.voice.textContent = v ? shortVoice(v.name) : vc.catalog.supported ? 'buscando voz…' : 'sin síntesis local';
    }
    fillSystemVoices();
    modelSelect.value = s.model;
    const mi = modelInfo(s.model);
    const needsKey = mi.engine === 'eleven' && !vc.apiKey;
    modelNote.textContent = needsKey ? 'Requiere clave de ElevenLabs · mientras tanto se usa la voz del navegador.' : mi.note;
    modelNote.classList.toggle('warn', needsKey);
    for (const [key, el] of sliderEls) {
      const v = s[key];
      if (document.activeElement !== el.input) el.input.value = String(v);
      paintSlider(el.input, el.out, v, el.fmt, el.min, el.max);
    }
    overlay.querySelectorAll<HTMLInputElement>('[data-toggle]').forEach((cb) => {
      cb.checked = Boolean(s[cb.dataset.toggle as 'speakerBoost' | 'coreSignature']);
    });
    if (document.activeElement !== apiVoice) apiVoice.value = s.elevenVoiceId;
    apiState.textContent = vc.apiKey ? 'CONECTADO' : 'SIN CLAVE';
    apiState.classList.toggle('on', Boolean(vc.apiKey));

    const st = vc.getStatus();
    genBtn.disabled = st === 'generating';
    genBtn.classList.toggle('busy', st === 'generating');
    genLabel.textContent = st === 'generating' ? 'Generando…' : st === 'speaking' ? 'Regenerar' : 'Generar voz';
    stopBtn.disabled = st === 'idle';
    stateEl.textContent = st === 'generating' ? 'GENERANDO' : st === 'speaking' ? 'REPRODUCIENDO' : 'LISTO';
    stateEl.dataset.state = st;
    engineEl.textContent = st === 'speaking' ? `${vc.frame.engine === 'eleven' ? 'ElevenLabs API' : 'Navegador neural'} · ${vc.frame.voiceLabel}` : vc.engineLabel();
    renderHistory();
  };
  vc.onChange(sync);

  let open = false;
  let release: (() => void) | null = null;
  let returnFocus: HTMLElement | null = null;
  let lastClock = '';
  vc.onFrame((f) => {
    if (!open) return;
    wave.draw(f);
    const clock = `${fmtClock(f.elapsed)} / ${fmtClock(f.duration)}`;
    if (clock !== lastClock) {
      lastClock = clock;
      clockEl.textContent = clock;
    }
  });

  // ───────────── open / close ─────────────
  const setOpen = (v: boolean) => {
    if (v === open) return;
    open = v;
    overlay.classList.toggle('open', v);
    overlay.setAttribute('aria-hidden', String(!v));
    if (v) {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      wave.refreshPalette();
      wave.resize();
      sync();
      release = vc.hold();
      window.setTimeout(() => textarea.focus({ preventScroll: true }), 60);
    } else {
      release?.();
      release = null;
      returnFocus?.focus?.({ preventScroll: true });
    }
  };
  overlay.setAttribute('aria-hidden', 'true');
  ctx.store.subscribe((s) => setOpen(s.voiceOpen), ['voiceOpen']);
  setOpen(ctx.store.get().voiceOpen);

  const close = () => ctx.store.set({ voiceOpen: false });
  $<HTMLButtonElement>('[data-close]').addEventListener('click', close);
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) close();
  });
  // capture phase: runs before the studio's own stopPropagation and before other modules' Esc handlers
  window.addEventListener(
    'keydown',
    (e) => {
      if (!open) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        generate();
      } else if (e.key === 'Tab') {
        // keep focus inside the dialog
        const f = Array.from(studio.querySelectorAll<HTMLElement>('button:not([disabled]), textarea, select, input, summary')).filter((x) => x.offsetParent !== null);
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    true,
  );
  // keystrokes typed into the studio must not reach global map shortcuts
  studio.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' && e.key !== 'Tab') e.stopPropagation();
  });
  sync();
}

function paintSlider(input: HTMLInputElement, out: HTMLOutputElement, v: number, fmt: (v: number) => string, min: number, max: number): void {
  out.textContent = fmt(v);
  input.style.setProperty('--p', `${(((v - min) / (max - min)) * 100).toFixed(1)}%`);
}
