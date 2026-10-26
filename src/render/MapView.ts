import * as THREE from 'three';
import type { CameraState, FlyToOptions, IBus, ICityWorld, IMapView, ISimulation, IStore, Vec2 } from '../core/types';
import { CameraRig } from './CameraRig';
import { Picker } from './Picker';
import { Pipeline, type FrameInput } from './Pipeline';
import { LensGrid } from './LensGrid';
import { SplitHandle } from './SplitHandle';
import { injectRenderStyles } from './styles';

const DEFAULT_VIEW = { zoom: 0.6, pitch: 60, bearing: -18 };
const HOVER_INTERVAL = 1 / 30;
const CLICK_SLOP = 4; // css px
/** zoomBy(+1) step in normalized zoom */
const ZOOM_STEP = 0.1;

type DragMode = 'none' | 'pan' | 'rotate' | 'pinch';

/**
 * Owns the WebGL renderer, the Mapbox-like camera rig, picking, the machine-sight lens and the
 * post-processing pipeline. Talks to the rest of the app only through the bus/store/world/sim contracts.
 */
export class MapView implements IMapView {
  readonly canvas: HTMLCanvasElement;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly pointer: { x: number; y: number; inside: boolean; world: Vec2 | null } = { x: 0, y: 0, inside: false, world: null };

  private readonly rig: CameraRig;
  private readonly picker: Picker;
  private readonly pipeline: Pipeline;
  private readonly lens = new LensGrid();
  private readonly split: SplitHandle;
  private readonly home: { x: number; z: number };

  // viewport (css px)
  private cssW = 1;
  private cssH = 1;
  private rectLeft = 0;
  private rectTop = 0;
  private dpr = 1;

  // loop
  private running = false;
  private raf = 0;
  private lastNow = 0;
  private time = 0;
  private contextLost = false;

  // gestures
  private readonly touches = new Map<number, { x: number; y: number }>();
  private drag: DragMode = 'none';
  private downX = 0;
  private downY = 0;
  private lastX = 0;
  private lastY = 0;
  private downButton = 0;
  private moved = false;

  // hover
  private hoverDirty = false;
  private lastHoverT = -1;
  private hoverEmittedInside = false;
  private readonly hit = new THREE.Vector3();
  private readonly pv = new THREE.Vector3();

  private readonly frameInput: FrameInput = {
    time: 0, year: 0, compare: false, compareYear: 0, split: 0.5, lensX: 0, lensY: 0, lensRadius: 0,
  };

  // adaptive resolution governor
  private fpsEma = 60;
  private slowFor = 0;
  private warmFor = 0;

  constructor(
    private readonly container: HTMLElement,
    private readonly world: ICityWorld,
    private readonly bus: IBus,
    private readonly store: IStore,
    private readonly sim: ISimulation,
  ) {
    injectRenderStyles();

    const renderer = new THREE.WebGLRenderer({
      antialias: false, // MSAA lives on the render targets
      alpha: false,
      depth: false, // the canvas only receives the fullscreen composite
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(this.dpr);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false; // the pipeline flags updates per beauty render
    this.renderer = renderer;
    this.canvas = renderer.domElement;
    this.canvas.setAttribute('aria-label', 'Mapa 3D de Xalapa');
    this.canvas.setAttribute('role', 'application');
    this.canvas.style.touchAction = 'none';
    this.canvas.style.cursor = 'crosshair';
    container.appendChild(this.canvas);

    this.rig = new CameraRig(
      (x, z) => world.groundY(x, z),
      (nx, ny, out) => this.picker.pick(nx, ny, out, false),
    );
    this.camera = this.rig.camera;
    this.picker = new Picker(this.camera, world);
    this.pipeline = new Pipeline(renderer, world, this.camera);
    this.split = new SplitHandle(container);

    const lm = sim.mapData.landmarks.find((l) => l.id === 'parque-juarez');
    this.home = lm ? { x: lm.pos.x, z: lm.pos.z } : { x: -3, z: 0 };
    // start slightly wide; start() flies into the default view
    this.rig.setState({ x: this.home.x + 30, z: this.home.z + 80, zoom: 0.16, pitch: 36, bearing: -46 });

    const s = store.get();
    this.pipeline.setStyle(s.mapStyle);
    this.split.setVisible(s.compare);
    this.split.setYears(s.compareYear, s.year);
    this.lens.radius = s.lensRadius;

    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);
    this.pipeline.warmup();

    store.subscribe(
      (st, changed) => {
        if (changed.includes('mapStyle')) this.pipeline.setStyle(st.mapStyle);
        if (changed.includes('compare')) this.split.setVisible(st.compare);
        if (changed.includes('compare') || changed.includes('year') || changed.includes('compareYear')) {
          this.split.setYears(st.compareYear, st.year);
        }
      },
      ['lens', 'lensRadius', 'mapStyle', 'compare', 'compareYear', 'year'],
    );
    bus.on('view:flyTo', (o) => this.flyTo(o));

    this.bindInput();
  }

  // ───────────────────────── public API ─────────────────────────
  start(): void {
    if (this.running) return;
    this.running = true;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const target = { x: this.home.x, z: this.home.z, ...DEFAULT_VIEW };
    if (reduce) this.rig.setState(target);
    else this.rig.flyTo({ ...target, duration: 3.4 });
    this.lastNow = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  project(x: number, y: number, z: number): { x: number; y: number; visible: boolean } {
    const v = this.pv.set(x, y, z).applyMatrix4(this.camera.matrixWorldInverse);
    const inFront = v.z < -this.camera.near;
    v.applyMatrix4(this.camera.projectionMatrix);
    const visible = inFront && v.x >= -1 && v.x <= 1 && v.y >= -1 && v.y <= 1;
    return {
      x: this.rectLeft + (v.x * 0.5 + 0.5) * this.cssW,
      y: this.rectTop + (0.5 - v.y * 0.5) * this.cssH,
      visible,
    };
  }

  flyTo(o: FlyToOptions): void {
    if (!Number.isFinite(o.x) || !Number.isFinite(o.z)) return;
    this.rig.flyTo(o);
  }

  zoomBy(delta: number): void {
    this.rig.zoomBy(delta * ZOOM_STEP);
  }

  rotateBy(deg: number): void {
    this.rig.rotateBy(deg);
  }

  setPitch(deg: number): void {
    this.rig.setPitch(deg);
  }

  resetNorth(): void {
    this.rig.resetNorth();
  }

  getCameraState(): CameraState {
    return this.rig.getState();
  }

  // ───────────────────────── frame loop ─────────────────────────
  private readonly frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const raw = (now - this.lastNow) / 1000;
    this.lastNow = now;
    if (document.hidden || this.contextLost) return;
    const dt = Math.min(Math.max(raw, 0), 0.05);
    this.time += dt;

    this.rig.update(dt);
    if (this.rig.moved) this.hoverDirty = true;

    const st = this.store.get();
    const dragging = this.drag !== 'none' && this.moved;
    this.lens.update(dt, { visible: st.lens && this.pointer.inside, dragging, radius: st.lensRadius });
    this.updateHover();

    this.world.update(dt, this.time, this.camera);
    this.bus.emit('view:frame', { dt, t: this.time });

    // lens collapses with its own animation when toggled off (LensGrid.amount → 0)
    const f = this.frameInput;
    f.time = this.time;
    f.year = st.year;
    f.compare = st.compare;
    f.compareYear = st.compareYear;
    f.split = this.split.fraction;
    f.lensX = this.lens.x * this.dpr;
    f.lensY = (this.cssH - this.lens.y) * this.dpr;
    f.lensRadius = st.mapStyle === 'scan' ? 0 : this.lens.radiusCss * this.dpr;
    this.pipeline.render(f);

    this.governQuality(raw);
  };

  /** Lower the RT resolution if the frame rate stays poor (downscale only; reset on resize). */
  private governQuality(raw: number): void {
    if (raw <= 0 || raw > 0.25) return;
    this.warmFor += raw;
    if (this.warmFor < 4) return; // ignore shader compilation / first uploads
    this.fpsEma += (1 / raw - this.fpsEma) * 0.05;
    if (this.fpsEma < 42) this.slowFor += raw;
    else this.slowFor = 0;
    const s = this.pipeline.getRenderScale();
    if (this.slowFor > 2.5 && s > 0.6) {
      this.pipeline.setRenderScale(s - 0.1);
      this.slowFor = 0;
      this.fpsEma = 50;
    }
  }

  private updateHover(): void {
    if (!this.pointer.inside) {
      if (this.hoverEmittedInside) {
        this.hoverEmittedInside = false;
        this.pointer.world = null;
        this.bus.emit('view:hover', { point: null, cellIndex: -1, screen: { x: this.pointer.x, y: this.pointer.y } });
      }
      return;
    }
    if (!this.hoverDirty || this.time - this.lastHoverT < HOVER_INTERVAL) return;
    this.hoverDirty = false;
    this.lastHoverT = this.time;
    const [nx, ny] = this.ndc(this.pointer.x, this.pointer.y);
    const ok = this.picker.pick(nx, ny, this.hit, false);
    const point = ok ? { x: this.hit.x, z: this.hit.z } : null;
    this.pointer.world = point;
    this.hoverEmittedInside = true;
    this.bus.emit('view:hover', {
      point,
      cellIndex: point ? this.sim.cellIndexAt(point.x, point.z) : -1,
      screen: { x: this.pointer.x, y: this.pointer.y },
    });
  }

  private resize(): void {
    const r = this.container.getBoundingClientRect();
    this.cssW = Math.max(1, r.width);
    this.cssH = Math.max(1, r.height);
    this.rectLeft = r.left;
    this.rectTop = r.top;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(this.cssW, this.cssH, false);
    this.camera.aspect = this.cssW / this.cssH;
    this.camera.updateProjectionMatrix();
    this.pipeline.setSize(this.canvas.width, this.canvas.height, this.dpr);
    this.pipeline.setRenderScale(1);
    this.warmFor = 2; // give the new size a moment before judging fps
    this.split.layout(this.cssW);
    this.rig.apply();
  }

  // ───────────────────────── input ─────────────────────────
  /** client px → NDC */
  private ndc(clientX: number, clientY: number): [number, number] {
    return [((clientX - this.rectLeft) / this.cssW) * 2 - 1, -((clientY - this.rectTop) / this.cssH) * 2 + 1];
  }

  private setPointer(e: PointerEvent | MouseEvent): void {
    this.pointer.x = e.clientX;
    this.pointer.y = e.clientY;
    this.lens.setTarget(e.clientX - this.rectLeft, e.clientY - this.rectTop);
    this.hoverDirty = true;
  }

  private bindInput(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', this.onDown);
    c.addEventListener('pointermove', this.onMove);
    c.addEventListener('pointerup', this.onUp);
    c.addEventListener('pointercancel', this.onCancel);
    c.addEventListener('pointerenter', (e) => {
      this.setPointer(e);
      this.pointer.inside = true;
    });
    c.addEventListener('pointerleave', () => {
      if (this.drag === 'none') this.pointer.inside = false;
    });
    c.addEventListener('wheel', this.onWheel, { passive: false });
    c.addEventListener('dblclick', (e) => {
      e.preventDefault();
      const [nx, ny] = this.ndc(e.clientX, e.clientY);
      this.rig.zoomAt(nx, ny, e.shiftKey ? -0.14 : 0.14);
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      this.bus.emit('ui:toast', { text: 'Se perdió el contexto WebGL · reintentando…', kind: 'warn' });
    });
    c.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.resize();
    });
    window.addEventListener('keydown', this.onKey);
  }

  private readonly onDown = (e: PointerEvent): void => {
    this.canvas.setPointerCapture(e.pointerId);
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.setPointer(e);
    this.pointer.inside = true;

    if (this.touches.size === 1) {
      this.downX = this.lastX = e.clientX;
      this.downY = this.lastY = e.clientY;
      this.downButton = e.button;
      this.moved = false;
      const rotate = e.button === 1 || e.button === 2 || e.ctrlKey || e.shiftKey || e.metaKey || e.altKey;
      this.drag = rotate ? 'rotate' : 'pan';
      if (!rotate) {
        const [nx, ny] = this.ndc(e.clientX, e.clientY);
        this.rig.beginPan(nx, ny);
      }
    } else if (this.touches.size === 2) {
      this.rig.endPan();
      this.drag = 'pinch';
      this.moved = true; // never a click
      const g = this.pinchGeometry();
      this.rig.beginPinch(g.nx, g.ny, g.dist, g.angle);
    }
  };

  private readonly onMove = (e: PointerEvent): void => {
    this.setPointer(e);
    if (e.pointerType !== 'touch') this.pointer.inside = true;
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    t.x = e.clientX;
    t.y = e.clientY;

    if (this.drag === 'pinch') {
      if (this.touches.size >= 2) {
        const g = this.pinchGeometry();
        this.rig.movePinch(g.nx, g.ny, g.dist, g.angle);
      }
      return;
    }
    if (!this.moved && Math.hypot(e.clientX - this.downX, e.clientY - this.downY) < CLICK_SLOP) return;
    if (!this.moved) {
      this.moved = true;
      this.canvas.style.cursor = 'grabbing';
    }
    if (this.drag === 'pan') {
      const [nx, ny] = this.ndc(e.clientX, e.clientY);
      this.rig.movePan(nx, ny);
    } else if (this.drag === 'rotate') {
      this.rig.rotateDrag(e.clientX - this.lastX, e.clientY - this.lastY);
    }
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (!this.touches.has(e.pointerId)) return;
    this.touches.delete(e.pointerId);
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);

    if (this.drag === 'pinch') {
      if (this.touches.size === 1) {
        // continue as a one-finger pan with the remaining touch
        const [rest] = this.touches.values();
        this.drag = 'pan';
        this.lastX = rest.x;
        this.lastY = rest.y;
        const [nx, ny] = this.ndc(rest.x, rest.y);
        this.rig.beginPan(nx, ny);
      } else if (this.touches.size === 0) this.endDrag();
      return;
    }
    if (this.touches.size > 0) return;

    const wasClick = !this.moved && e.button === this.downButton;
    this.endDrag();
    if (wasClick) this.emitClick(e);
    if (e.pointerType === 'touch') this.pointer.inside = false;
  };

  private readonly onCancel = (e: PointerEvent): void => {
    this.touches.delete(e.pointerId);
    if (this.touches.size === 0) this.endDrag();
    if (e.pointerType === 'touch') this.pointer.inside = false;
  };

  private endDrag(): void {
    this.rig.endPan();
    this.drag = 'none';
    this.moved = false;
    this.canvas.style.cursor = 'crosshair';
  }

  private pinchGeometry(): { nx: number; ny: number; dist: number; angle: number } {
    const it = this.touches.values();
    const a = it.next().value as { x: number; y: number };
    const b = it.next().value as { x: number; y: number };
    const [nx, ny] = this.ndc((a.x + b.x) / 2, (a.y + b.y) / 2);
    return { nx, ny, dist: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x) };
  }

  private emitClick(e: PointerEvent): void {
    const [nx, ny] = this.ndc(e.clientX, e.clientY);
    if (!this.picker.pick(nx, ny, this.hit, true)) return;
    const point = { x: this.hit.x, z: this.hit.z };
    this.bus.emit('view:click', {
      point,
      cellIndex: this.sim.cellIndexAt(point.x, point.z),
      screen: { x: e.clientX, y: e.clientY },
      button: e.button,
    });
  }

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= this.cssH;
    // trackpad pinch arrives as ctrl+wheel with small deltas
    const k = e.ctrlKey ? 0.006 : 0.0009;
    const dz = Math.max(-0.25, Math.min(0.25, -dy * k));
    const [nx, ny] = this.ndc(e.clientX, e.clientY);
    this.rig.zoomAt(nx, ny, dz);
  };

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    switch (e.key) {
      case 'ArrowUp':
        this.rig.panImpulse(0, 1);
        break;
      case 'ArrowDown':
        this.rig.panImpulse(0, -1);
        break;
      case 'ArrowLeft':
        this.rig.panImpulse(-1, 0);
        break;
      case 'ArrowRight':
        this.rig.panImpulse(1, 0);
        break;
      case '+':
      case '=':
        this.rig.zoomBy(0.08);
        break;
      case '-':
      case '_':
        this.rig.zoomBy(-0.08);
        break;
      case 'q':
      case 'Q':
        this.rig.rotateBy(-15);
        break;
      case 'e':
      case 'E':
        this.rig.rotateBy(15);
        break;
      default:
        return;
    }
    e.preventDefault();
  };
}
