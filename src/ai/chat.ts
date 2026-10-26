/** MVIA chat panel + launcher orb (DOM only; no framework). */
import type { AppContext } from '../core/types';
import { MviaEngine, SUGGESTIONS } from './engine';
import { askClaude, getApiKey, setApiKey, type Turn } from './llm';
import { stripMarkdown, toSpeech, int } from './format';
import { el, icon, mviaMark, renderAttachment, renderMarkdown } from './render';
import type { ChatAction, IntentId, Parsed, Reply } from './types';

const CHARS_PER_SECOND = 90;
/** intents the LLM may take over when the local score is weak (never map-command intents) */
const LLM_SOFT: ReadonlySet<IntentId> = new Set<IntentId>(['fallback', 'ayuda', 'about', 'zona', 'ranking', 'metricas']);

interface SpeechAlt { transcript: string }
interface SpeechResult { isFinal: boolean; 0: SpeechAlt; length: number }
interface SpeechEvent { resultIndex: number; results: ArrayLike<SpeechResult> }
interface SpeechRec {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechEvent) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechCtor = new () => SpeechRec;

interface Streaming {
  skip(): void;
  done: Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const hhmm = () => new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });

export class ChatUI {
  private engine: MviaEngine;
  private orb: HTMLButtonElement;
  private panel: HTMLElement;
  private log: HTMLElement;
  private suggest: HTMLElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private micBtn: HTMLButtonElement;
  private voiceBtn: HTMLButtonElement;
  private statusText: HTMLElement;
  private settings: HTMLElement;
  private keyInput: HTMLInputElement;
  private keyStatus: HTMLElement;

  private history: Turn[] = [];
  private busy = false;
  private queue: string[] = [];
  private current: Streaming | null = null;
  private welcomed = false;
  private hasUserMessage = false;
  private recognition: SpeechRec | null = null;
  private listening = false;
  private readonly reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  constructor(private ctx: AppContext, root: HTMLElement) {
    this.engine = new MviaEngine(ctx);

    // ── launcher orb ──
    this.orb = el('button', 'mv-orb');
    this.orb.type = 'button';
    this.orb.setAttribute('aria-label', 'Abrir el chat de MVIA');
    this.orb.setAttribute('aria-expanded', 'false');
    this.orb.appendChild(el('span', 'mv-orb-halo'));
    this.orb.appendChild(mviaMark(30, 'mv-mark mv-orb-mark'));
    this.orb.appendChild(el('span', 'mv-orb-label mono', 'MVIA'));
    this.orb.addEventListener('click', () => this.ctx.store.set({ chatOpen: !this.ctx.store.get().chatOpen }));

    // ── panel ──
    this.panel = el('section', 'mv-chat');
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', 'MVIA, analista conversacional');

    const head = el('header', 'mv-head');
    const brand = el('div', 'mv-brand');
    brand.appendChild(mviaMark(34, 'mv-mark mv-head-mark'));
    const titles = el('div', 'mv-titles');
    const titleRow = el('div', 'mv-title-row');
    titleRow.appendChild(el('strong', 'mv-title', 'MVIA'));
    const status = el('span', 'mv-status mono');
    status.appendChild(el('i', 'mv-status-dot'));
    this.statusText = el('span', undefined, 'en línea · modelo v2.6');
    status.appendChild(this.statusText);
    titleRow.appendChild(status);
    titles.appendChild(titleRow);
    titles.appendChild(el('div', 'mv-kicker mono', 'Master Validation of Infrastructure Artificial Algorithm'));
    brand.appendChild(titles);
    head.appendChild(brand);

    const tools = el('div', 'mv-tools');
    this.voiceBtn = this.toolButton('speaker', 'Voz automática', () => this.ctx.store.set({ voiceAuto: !this.ctx.store.get().voiceAuto }));
    tools.appendChild(this.voiceBtn);
    tools.appendChild(this.toolButton('wave', 'Abrir Voice Studio', () => this.ctx.store.set({ voiceOpen: true })));
    tools.appendChild(this.toolButton('gear', 'Ajustes del modelo', () => this.toggleSettings()));
    tools.appendChild(this.toolButton('trash', 'Limpiar conversación', () => this.clear()));
    tools.appendChild(this.toolButton('close', 'Cerrar', () => this.ctx.store.set({ chatOpen: false })));
    head.appendChild(tools);
    this.panel.appendChild(head);

    // settings popover (optional Claude key)
    this.settings = el('div', 'mv-settings');
    this.settings.hidden = true;
    this.settings.appendChild(el('div', 'mv-att-title', 'MODO EXTENDIDO · CLAUDE'));
    this.settings.appendChild(
      el('p', 'mv-settings-copy', 'Opcional. Con una API key de Anthropic, las preguntas abiertas que el motor local no reconoce se responden con Claude usando los datos del simulador. La clave se guarda solo en este navegador.'),
    );
    this.keyInput = el('input', 'mv-key mono');
    this.keyInput.type = 'password';
    this.keyInput.placeholder = 'sk-ant-…';
    this.keyInput.autocomplete = 'off';
    this.keyInput.spellcheck = false;
    this.settings.appendChild(this.keyInput);
    const srow = el('div', 'mv-settings-row');
    const save = el('button', 'mv-btn primary', 'Guardar');
    save.type = 'button';
    save.addEventListener('click', () => {
      setApiKey(this.keyInput.value);
      this.keyInput.value = '';
      this.refreshKeyStatus();
    });
    const del = el('button', 'mv-btn', 'Borrar clave');
    del.type = 'button';
    del.addEventListener('click', () => {
      setApiKey(null);
      this.refreshKeyStatus();
    });
    this.keyStatus = el('span', 'mv-key-status mono');
    srow.append(save, del, this.keyStatus);
    this.settings.appendChild(srow);
    this.panel.appendChild(this.settings);

    this.log = el('div', 'mv-log');
    this.log.setAttribute('aria-live', 'polite');
    this.panel.appendChild(this.log);

    this.suggest = el('div', 'mv-suggest');
    for (const q of SUGGESTIONS) {
      const chip = el('button', 'mv-chip', q);
      chip.type = 'button';
      chip.addEventListener('click', () => this.send(q));
      this.suggest.appendChild(chip);
    }
    this.panel.appendChild(this.suggest);

    const form = el('form', 'mv-input');
    this.input = el('textarea', 'mv-textarea');
    this.input.rows = 1;
    this.input.placeholder = 'Pregunta a MVIA sobre Xalapa…';
    this.input.setAttribute('aria-label', 'Mensaje para MVIA');
    this.micBtn = el('button', 'mv-icon-btn mv-mic');
    this.micBtn.type = 'button';
    this.micBtn.appendChild(icon('mic', 18));
    this.sendBtn = el('button', 'mv-icon-btn mv-send');
    this.sendBtn.type = 'submit';
    this.sendBtn.setAttribute('aria-label', 'Enviar');
    this.sendBtn.appendChild(icon('send', 16));
    form.append(this.input, this.micBtn, this.sendBtn);
    this.panel.appendChild(form);
    this.panel.appendChild(el('div', 'mv-foot mono', 'Enter envía · Shift+Enter nueva línea · Esc salta la escritura'));

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submitInput();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submitInput();
      } else if (e.key === 'Escape') {
        if (this.current) this.current.skip();
        else this.ctx.store.set({ chatOpen: false });
      }
    });
    this.input.addEventListener('input', () => this.autosize());
    this.panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && e.target !== this.input) {
        if (this.current) this.current.skip();
        else this.ctx.store.set({ chatOpen: false });
      }
    });
    // keep map shortcuts from firing while typing
    this.panel.addEventListener('keydown', (e) => e.stopPropagation());
    this.panel.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

    this.setupMic();
    root.append(this.panel, this.orb);

    // ── state wiring ──
    this.ctx.store.subscribe((s) => this.applyOpen(s.chatOpen), ['chatOpen']);
    this.ctx.store.subscribe((s) => this.applyVoiceAuto(s.voiceAuto), ['voiceAuto']);
    this.ctx.bus.on('chat:ask', ({ text }) => {
      this.ctx.store.set({ chatOpen: true });
      this.send(text);
    });
    this.ctx.bus.on('voice:state', ({ speaking, level }) => {
      const lvl = speaking ? Math.max(0, Math.min(1, level)) : 0;
      this.orb.style.setProperty('--lvl', lvl.toFixed(3));
      this.panel.style.setProperty('--lvl', lvl.toFixed(3));
      this.orb.classList.toggle('is-speaking', speaking);
      this.panel.classList.toggle('is-speaking', speaking);
    });

    this.applyVoiceAuto(this.ctx.store.get().voiceAuto);
    this.applyOpen(this.ctx.store.get().chatOpen);
    this.refreshKeyStatus();
  }

  // ───────────────────────────── chrome ─────────────────────────────
  private toolButton(name: Parameters<typeof icon>[0], label: string, fn: () => void): HTMLButtonElement {
    const b = el('button', 'mv-tool');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.appendChild(icon(name, 16));
    b.addEventListener('click', fn);
    return b;
  }

  private applyOpen(open: boolean): void {
    this.panel.classList.toggle('is-open', open);
    this.orb.classList.toggle('is-open', open);
    this.orb.setAttribute('aria-expanded', String(open));
    this.orb.setAttribute('aria-label', open ? 'Cerrar el chat de MVIA' : 'Abrir el chat de MVIA');
    if (open) {
      if (!this.welcomed) this.welcome();
      window.setTimeout(() => this.input.focus({ preventScroll: true }), 180);
    } else {
      this.settings.hidden = true;
      this.stopMic();
    }
  }

  private applyVoiceAuto(on: boolean): void {
    this.voiceBtn.replaceChildren(icon(on ? 'speaker' : 'speakerOff', 16));
    this.voiceBtn.classList.toggle('is-on', on);
    this.voiceBtn.setAttribute('aria-pressed', String(on));
    this.voiceBtn.title = on ? 'Voz automática: activada' : 'Voz automática: desactivada';
  }

  private toggleSettings(): void {
    this.settings.hidden = !this.settings.hidden;
    if (!this.settings.hidden) {
      this.refreshKeyStatus();
      this.keyInput.focus();
    }
  }

  private refreshKeyStatus(): void {
    const has = !!getApiKey();
    this.keyStatus.textContent = has ? '● clave activa' : '○ sin clave · motor local';
    this.keyStatus.classList.toggle('on', has);
    this.statusText.textContent = has ? 'en línea · modelo v2.6 + Claude' : 'en línea · modelo v2.6';
  }

  private autosize(): void {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(120, this.input.scrollHeight)}px`;
  }

  private scrollToEnd(force = false): void {
    const nearBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 120;
    if (force || nearBottom) this.log.scrollTop = this.log.scrollHeight;
  }

  private welcome(): void {
    this.welcomed = true;
    const m = this.ctx.sim.metrics();
    const reply: Reply = {
      intent: 'saludo',
      silent: true,
      text:
        `Hola, soy **MVIA**. Tengo cargado el gemelo digital de Xalapa: **${int(this.engine.cellCount)} celdas**, ${int(m.population)} habitantes ` +
        `y proyecciones hasta 2050. Pregúntame por valores de suelo, crédito, comercio o crecimiento urbano.`,
      attachments: [],
    };
    void this.presentReply(reply, false);
    this.suggest.hidden = false;
  }

  private clear(): void {
    this.current?.skip();
    this.queue.length = 0;
    this.log.replaceChildren();
    this.history = [];
    this.hasUserMessage = false;
    this.engine.memory.lastReplyText = '';
    this.ctx.bus.emit('voice:stop', {});
    this.welcomed = false;
    this.welcome();
  }

  // ───────────────────────────── conversation ─────────────────────────────
  private submitInput(): void {
    const text = this.input.value.trim();
    if (!text) return;
    this.input.value = '';
    this.autosize();
    this.send(text);
  }

  send(text: string): void {
    const t = text.trim();
    if (!t) return;
    if (!this.welcomed) this.welcome();
    this.current?.skip();
    if (this.busy) {
      this.queue.push(t);
      return;
    }
    void this.process(t);
  }

  private async process(text: string): Promise<void> {
    this.busy = true;
    this.ctx.bus.emit('voice:stop', {});
    this.addUser(text);
    this.history.push({ role: 'user', content: text });

    const parsed = this.engine.parse(text);
    const thinking = this.addThinking(parsed);
    this.orb.classList.add('is-busy');
    this.panel.classList.add('is-busy');
    const delay = parsed.intent === 'saludo' || parsed.intent === 'gracias' ? 320 : 380 + Math.random() * 320;

    let reply: Reply | null = null;
    try {
      if (this.shouldUseLLM(parsed)) {
        thinking.querySelector('.mv-think-line')!.textContent = `MVIA analizando ${int(this.engine.cellCount)} celdas · razonamiento extendido`;
        const [txt] = await Promise.all([askClaude(this.ctx, this.history), wait(delay)]);
        if (txt) reply = { intent: 'llm', text: txt, attachments: [] };
      } else {
        await wait(delay);
      }
      if (!reply) reply = this.engine.respond(parsed);
    } catch (err) {
      console.error('[MVIA chat]', err);
      reply = this.engine.fallback();
    }
    thinking.remove();
    this.orb.classList.remove('is-busy');
    this.panel.classList.remove('is-busy');

    await this.presentReply(reply, true);
    this.busy = false;
    const next = this.queue.shift();
    if (next) void this.process(next);
  }

  private shouldUseLLM(p: Parsed): boolean {
    if (!getApiKey()) return false;
    if (p.intent === 'fallback') return true;
    const hasEntities = p.entities.zones.length > 0 || p.entities.landmarkIds.length > 0 || p.entities.money.length > 0;
    return LLM_SOFT.has(p.intent) && p.score < 1.8 && !hasEntities && p.tokens.length > 4;
  }

  private addUser(text: string): void {
    if (!this.hasUserMessage) {
      this.hasUserMessage = true;
      this.suggest.hidden = true;
    }
    const row = el('div', 'mv-msg user');
    const bubble = el('div', 'mv-bubble');
    bubble.textContent = text;
    row.appendChild(bubble);
    row.appendChild(el('div', 'mv-meta mono', `TÚ · ${hhmm()}`));
    this.log.appendChild(row);
    this.scrollToEnd(true);
  }

  private addEcho(label: string): void {
    const row = el('div', 'mv-echo mono', `▸ ${label}`);
    this.log.appendChild(row);
    this.scrollToEnd(true);
  }

  private addThinking(p: Parsed): HTMLElement {
    const row = el('div', 'mv-msg mvia thinking');
    row.appendChild(this.avatar());
    const body = el('div', 'mv-content');
    const t = el('div', 'mv-think');
    t.appendChild(el('span', undefined, 'pensando'));
    const dots = el('span', 'mv-dots');
    dots.append(el('i'), el('i'), el('i'));
    t.appendChild(dots);
    body.appendChild(t);
    const cells = this.engine.cellsFor(p);
    body.appendChild(el('div', 'mv-think-line mono', cells > 0 ? `MVIA analizando ${int(cells)} celdas · ${p.intent}` : `MVIA · interpretando lenguaje natural`));
    row.appendChild(body);
    this.log.appendChild(row);
    this.scrollToEnd(true);
    return row;
  }

  private avatar(): HTMLElement {
    const a = el('div', 'mv-avatar');
    a.appendChild(mviaMark(22, 'mv-mark'));
    return a;
  }

  /** renders an MVIA reply with the typing effect, then its attachments; speaks it when appropriate */
  private presentReply(reply: Reply, allowVoice: boolean): Promise<void> {
    const row = el('div', 'mv-msg mvia');
    row.appendChild(this.avatar());
    const content = el('div', 'mv-content');
    const body = el('div', 'mv-body');
    content.appendChild(body);
    content.appendChild(el('div', 'mv-meta mono', `MVIA · ${hhmm()}${reply.intent === 'llm' ? ' · claude' : ''}`));
    row.appendChild(content);
    this.log.appendChild(row);

    if (allowVoice) {
      if (reply.speak) this.ctx.bus.emit('voice:speak', { text: toSpeech(reply.speak) });
      else if (!reply.silent && this.ctx.store.get().voiceAuto) this.ctx.bus.emit('voice:speak', { text: toSpeech(reply.text) });
    }
    if (allowVoice) this.history.push({ role: 'assistant', content: stripMarkdown(reply.text) });

    const stream = this.typeInto(body, renderMarkdown(reply.text), row);
    this.current = stream;
    return stream.done.then(() => {
      if (this.current === stream) this.current = null;
      reply.attachments.forEach((a, i) => {
        const node = renderAttachment(a, (act, btn) => this.runAction(act, btn));
        node.style.animationDelay = `${i * 70}ms`;
        content.insertBefore(node, content.lastChild);
      });
      this.scrollToEnd();
    });
  }

  /** progressive reveal of the text nodes of `frag` (markup stays intact) */
  private typeInto(body: HTMLElement, frag: DocumentFragment, row: HTMLElement): Streaming {
    body.appendChild(frag);
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    const full: string[] = [];
    while (walker.nextNode()) {
      const t = walker.currentNode as Text;
      nodes.push(t);
      full.push(t.data);
      t.data = '';
    }
    const caret = el('span', 'mv-caret');
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    let finished = false;
    let ni = 0;
    let shownInNode = 0;
    let budget = 0;
    let last = performance.now();
    row.classList.add('is-streaming');

    const finish = () => {
      if (finished) return;
      finished = true;
      for (let i = 0; i < nodes.length; i++) nodes[i].data = full[i];
      caret.remove();
      row.classList.remove('is-streaming');
      row.removeEventListener('click', finish);
      this.scrollToEnd();
      resolve();
    };

    const tick = (now: number) => {
      if (finished) return;
      budget += ((now - last) / 1000) * CHARS_PER_SECOND;
      last = now;
      let n = Math.floor(budget);
      budget -= n;
      while (n > 0 && ni < nodes.length) {
        const remain = full[ni].length - shownInNode;
        const take = Math.min(remain, n);
        shownInNode += take;
        n -= take;
        nodes[ni].data = full[ni].slice(0, shownInNode);
        if (shownInNode >= full[ni].length) {
          ni++;
          shownInNode = 0;
        }
      }
      if (ni >= nodes.length) {
        finish();
        return;
      }
      nodes[ni].after(caret);
      this.scrollToEnd();
      requestAnimationFrame(tick);
    };

    if (this.reducedMotion || !nodes.length) {
      queueMicrotask(finish);
    } else {
      row.addEventListener('click', finish);
      requestAnimationFrame(tick);
    }
    return { skip: finish, done };
  }

  private runAction(act: ChatAction, btn: HTMLButtonElement): void {
    btn.classList.add('is-done');
    window.setTimeout(() => btn.classList.remove('is-done'), 900);
    let reply: Reply | void;
    try {
      reply = act.run();
    } catch (err) {
      console.error('[MVIA chat] action failed', err);
      return;
    }
    if (!reply) return;
    this.current?.skip();
    this.addEcho(act.label);
    const r = reply;
    if (this.busy) {
      void this.presentReply(r, true);
      return;
    }
    this.busy = true;
    void wait(260)
      .then(() => this.presentReply(r, true))
      .then(() => {
        this.busy = false;
        const next = this.queue.shift();
        if (next) void this.process(next);
      });
  }

  // ───────────────────────────── voice input ─────────────────────────────
  private setupMic(): void {
    const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) {
      this.micBtn.disabled = true;
      this.micBtn.title = 'Dictado por voz no disponible en este navegador';
      this.micBtn.setAttribute('aria-label', this.micBtn.title);
      return;
    }
    this.micBtn.title = 'Dictar pregunta (es-MX)';
    this.micBtn.setAttribute('aria-label', this.micBtn.title);
    this.micBtn.addEventListener('click', () => (this.listening ? this.stopMic() : this.startMic(Ctor)));
  }

  private startMic(Ctor: SpeechCtor): void {
    try {
      const rec = new Ctor();
      rec.lang = 'es-MX';
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 1;
      let finalText = '';
      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalText += r[0].transcript;
          else interim += r[0].transcript;
        }
        this.input.value = (finalText + interim).trim();
        this.autosize();
      };
      rec.onerror = (ev) => {
        if (ev.error && ev.error !== 'no-speech' && ev.error !== 'aborted') {
          this.ctx.bus.emit('ui:toast', { text: 'No pude acceder al micrófono', kind: 'warn' });
        }
      };
      rec.onend = () => {
        this.setListening(false);
        this.recognition = null;
        const t = finalText.trim();
        if (t) {
          this.input.value = '';
          this.autosize();
          this.send(t);
        }
      };
      this.ctx.bus.emit('voice:stop', {});
      this.recognition = rec;
      rec.start();
      this.setListening(true);
    } catch (err) {
      console.warn('[MVIA chat] speech recognition failed', err);
      this.setListening(false);
    }
  }

  private stopMic(): void {
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {
        /* already stopped */
      }
    }
    this.setListening(false);
  }

  private setListening(on: boolean): void {
    this.listening = on;
    this.micBtn.classList.toggle('is-listening', on);
    this.panel.classList.toggle('is-listening', on);
    this.input.placeholder = on ? 'Escuchando… habla ahora' : 'Pregunta a MVIA sobre Xalapa…';
  }
}
