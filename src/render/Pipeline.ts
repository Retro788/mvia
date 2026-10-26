import * as THREE from 'three';
import type { ICityWorld, MapStyle } from '../core/types';
import { createFullscreenTriangle, FULLSCREEN_VERT } from './shaders/fullscreen';
import { COMPOSITE_FRAG } from './shaders/composite';
import { BLOOM_FRAG } from './shaders/bloom';
import { preToneMapped } from './tonemap';

/** Per-frame inputs the view hands to the pipeline. */
export interface FrameInput {
  time: number;
  year: number;
  compare: boolean;
  compareYear: number;
  /** compare divider position, fraction of the viewport width */
  split: number;
  /** lens centre in drawing-buffer px, origin bottom-left */
  lensX: number;
  lensY: number;
  /** lens radius in drawing-buffer px (0 = closed) */
  lensRadius: number;
}

interface Look {
  clear: number;
  exposure: number;
  tilt: number;
  vignette: number;
  grain: number;
  nightBloom: number;
}

const LOOKS: Record<MapStyle, Look> = {
  clay: { clear: 0xf1f0ec, exposure: 1, tilt: 1, vignette: 0.1, grain: 0.016, nightBloom: 0 },
  satellite: { clear: 0x1b2620, exposure: 1, tilt: 0.85, vignette: 0.22, grain: 0.02, nightBloom: 0 },
  night: { clear: 0x070b12, exposure: 1.1, tilt: 0, vignette: 0.34, grain: 0.028, nightBloom: 1.1 },
  scan: { clear: 0x04131c, exposure: 1, tilt: 0, vignette: 0.42, grain: 0.032, nightBloom: 0 },
};
const MACHINE_CLEAR = 0x04131c;
const MACHINE_BLOOM = 0.9;
/** lens tile size in css px */
export const TILE_CSS = 18;

type Side = 'full' | 'left' | 'right';

const hexVec3 = (hex: number) => new THREE.Vector3(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);

/**
 * Render-target pipeline:
 *   machine pass → RT_B (+RT_B2 for the compare base year), only when the lens is open or style = scan
 *   beauty pass  → RT_A (+RT_A2), MSAA, skipped in scan
 *   bloom        → 1/4-res prefilter of machine (lens-masked) + night lights
 *   composite    → canvas: lens tiles, debris, tilt-shift, chroma glow, tone mapping, vignette, grain
 * Compare halves use separate targets (three invalidates the MSAA buffer after each resolve, so a
 * single target cannot be filled in two scissored renders).
 */
export class Pipeline {
  private readonly hdrType: THREE.TextureDataType;
  private readonly samples: number;
  private readonly rtA: THREE.WebGLRenderTarget;
  private readonly rtB: THREE.WebGLRenderTarget;
  private rtA2: THREE.WebGLRenderTarget | null = null;
  private rtB2: THREE.WebGLRenderTarget | null = null;
  private readonly rtBloom: THREE.WebGLRenderTarget;

  private readonly quad: THREE.Mesh;
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly composite: THREE.ShaderMaterial;
  private readonly bloom: THREE.ShaderMaterial;

  private readonly beautyClear = new THREE.Color();
  private readonly machineClear = new THREE.Color(MACHINE_CLEAR);
  private style: MapStyle = 'clay';
  private look: Look = LOOKS.clay;

  /** drawing-buffer size of the canvas */
  private width = 1;
  private height = 1;
  private dpr = 1;
  /** RT resolution multiplier (adaptive quality) */
  private renderScale = 1;
  private machineScale = 0.5;
  /** whether the world currently holds the compare (base) year during this frame */
  private worldAtCompareYear = false;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly world: ICityWorld,
    private readonly camera: THREE.Camera,
  ) {
    const ext = renderer.extensions;
    this.hdrType = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float') ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.samples = Math.max(0, Math.min(4, renderer.capabilities.maxSamples || 0));
    this.rtA = this.makeTarget(true, this.samples);
    this.rtB = this.makeTarget(true, this.samples);
    this.rtBloom = this.makeTarget(false, 0);

    // fresh uniform objects per material (UniformsUtils.clone would copy the RT textures)
    const sources = () => ({
      tA: { value: this.rtA.texture },
      tA2: { value: this.rtA.texture },
      tB: { value: this.rtB.texture },
      tB2: { value: this.rtB.texture },
      uRes: { value: new THREE.Vector2(1, 1) },
      uSplit: { value: -1 },
    });
    this.composite = new THREE.ShaderMaterial({
      name: 'MVIA.Composite',
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        ...sources(),
        tBloom: { value: this.rtBloom.texture },
        uBloomTexel: { value: new THREE.Vector2(1, 1) },
        uDpr: { value: 1 },
        uTile: { value: TILE_CSS },
        uCursor: { value: new THREE.Vector2() },
        uRadius: { value: 0 },
        uLens: { value: 0 },
        uScan: { value: 0 },
        uTime: { value: 0 },
        uTilt: { value: 1 },
        uVignette: { value: 0.1 },
        uGrain: { value: 0.016 },
        uBloomOn: { value: 0 },
        uCyan: { value: hexVec3(0x4fd1ff) },
        uDeep: { value: hexVec3(0x061a26) },
      },
    });
    this.bloom = new THREE.ShaderMaterial({
      name: 'MVIA.Bloom',
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: BLOOM_FRAG,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      uniforms: {
        ...sources(),
        uTexel: { value: new THREE.Vector2(1, 1) },
        uNight: { value: 0 },
        uMachine: { value: 0 },
        uScan: { value: 0 },
        uCursor: { value: new THREE.Vector2() },
        uRadius: { value: 0 },
      },
    });
    this.quad = new THREE.Mesh(createFullscreenTriangle(), this.composite);
    this.quad.frustumCulled = false;
    this.setStyle('clay');
  }

  private makeTarget(depth: boolean, samples: number): THREE.WebGLRenderTarget {
    return new THREE.WebGLRenderTarget(1, 1, {
      type: this.hdrType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: depth,
      stencilBuffer: false,
      resolveDepthBuffer: false,
      samples,
    });
  }

  private bindSources(m: THREE.ShaderMaterial): void {
    const u = m.uniforms;
    u.tA.value = this.rtA.texture;
    u.tA2.value = (this.rtA2 ?? this.rtA).texture;
    u.tB.value = this.rtB.texture;
    u.tB2.value = (this.rtB2 ?? this.rtB).texture;
    if (u.tBloom) u.tBloom.value = this.rtBloom.texture;
  }

  /** Precompile the world's beauty + machine programs for render-target output (no first-hover hitch). */
  warmup(): void {
    const r = this.renderer;
    try {
      r.setRenderTarget(this.rtA);
      this.world.setPass('machine');
      r.compile(this.world.scene, this.camera);
      this.world.setPass('beauty');
      r.compile(this.world.scene, this.camera);
    } catch (err) {
      console.warn('[MVIA render] shader warmup failed', err);
    } finally {
      r.setRenderTarget(null);
    }
  }

  setSize(width: number, height: number, dpr: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = dpr;
    this.resizeTargets();
  }

  /** 0.5–1: RT resolution relative to the canvas (adaptive quality governor). */
  setRenderScale(s: number): void {
    const v = Math.min(1, Math.max(0.5, s));
    if (Math.abs(v - this.renderScale) < 1e-3) return;
    this.renderScale = v;
    this.resizeTargets();
  }

  getRenderScale(): number {
    return this.renderScale;
  }

  private resizeTargets(): void {
    const aw = Math.max(1, Math.round(this.width * this.renderScale));
    const ah = Math.max(1, Math.round(this.height * this.renderScale));
    this.rtA.setSize(aw, ah);
    this.rtA2?.setSize(aw, ah);
    const mw = Math.max(1, Math.round(aw * this.machineScale));
    const mh = Math.max(1, Math.round(ah * this.machineScale));
    this.rtB.setSize(mw, mh);
    this.rtB2?.setSize(mw, mh);
    const bw = Math.max(1, Math.round(this.width / 4));
    const bh = Math.max(1, Math.round(this.height / 4));
    this.rtBloom.setSize(bw, bh);

    const cu = this.composite.uniforms;
    cu.uRes.value.set(this.width, this.height);
    cu.uBloomTexel.value.set(1 / bw, 1 / bh);
    cu.uDpr.value = this.dpr;
    cu.uTile.value = Math.max(4, Math.round(TILE_CSS * this.dpr));
    const bu = this.bloom.uniforms;
    bu.uRes.value.set(this.width, this.height);
    bu.uTexel.value.set(1 / bw, 1 / bh);
  }

  setStyle(style: MapStyle): void {
    this.style = style;
    this.look = LOOKS[style];
    this.renderer.toneMappingExposure = this.look.exposure;
    preToneMapped(this.look.clear, this.look.exposure, this.beautyClear);
    const cu = this.composite.uniforms;
    cu.uTilt.value = this.look.tilt;
    cu.uVignette.value = this.look.vignette;
    cu.uGrain.value = this.look.grain;
    cu.uScan.value = style === 'scan' ? 1 : 0;
    this.bloom.uniforms.uScan.value = cu.uScan.value;
  }

  private setCompareTargets(on: boolean): void {
    if (on && !this.rtA2) {
      this.rtA2 = this.makeTarget(true, this.samples);
      this.rtB2 = this.makeTarget(true, this.samples);
      this.resizeTargets();
    } else if (!on && this.rtA2) {
      this.rtA2.dispose();
      this.rtB2?.dispose();
      this.rtA2 = null;
      this.rtB2 = null;
    } else return;
    this.bindSources(this.composite);
    this.bindSources(this.bloom);
  }

  private useYear(compareYear: boolean, f: FrameInput): void {
    if (compareYear === this.worldAtCompareYear) return;
    this.world.setYear(compareYear ? f.compareYear : f.year);
    this.worldAtCompareYear = compareYear;
  }

  private renderScene(rt: THREE.WebGLRenderTarget, side: Side, split: number): void {
    if (side === 'full') {
      rt.scissorTest = false;
    } else {
      // scissor to one half plus a margin so blur/chroma taps near the divider read valid pixels
      const sx = Math.round(split * rt.width);
      const m = Math.ceil(rt.width * 0.02) + 8;
      rt.scissorTest = true;
      if (side === 'left') rt.scissor.set(0, 0, Math.min(rt.width, sx + m), rt.height);
      else {
        const x0 = Math.max(0, Math.min(rt.width - 1, sx - m));
        rt.scissor.set(x0, 0, rt.width - x0, rt.height);
      }
    }
    this.renderer.setRenderTarget(rt);
    this.renderer.render(this.world.scene, this.camera);
  }

  render(f: FrameInput): void {
    const r = this.renderer;
    const scan = this.style === 'scan';
    const lensOn = !scan && f.lensRadius > 0.5;
    const needMachine = scan || lensOn;
    const needBeauty = !scan;
    const split = f.compare ? Math.min(1, Math.max(0, f.split)) : -1;
    const splitPx = split * this.width;

    this.setCompareTargets(f.compare);

    // machine pass resolution: full in scan, cheaper while the lens covers a small area
    const ms = scan ? 1 : f.lensRadius > 300 * this.dpr ? 0.75 : 0.5;
    if (ms !== this.machineScale) {
      this.machineScale = ms;
      this.resizeTargets();
    }

    this.worldAtCompareYear = false;

    if (needMachine) {
      this.world.setPass('machine');
      r.setClearColor(this.machineClear, 1);
      r.shadowMap.needsUpdate = false; // machine materials don't sample shadows
      if (split >= 0 && this.rtB2) {
        const reach = f.lensRadius * 1.5;
        if (scan || f.lensX - reach < splitPx) {
          this.useYear(true, f);
          this.renderScene(this.rtB2, 'left', split);
        }
        if (scan || f.lensX + reach > splitPx) {
          this.useYear(false, f);
          this.renderScene(this.rtB, 'right', split);
        }
      } else {
        this.renderScene(this.rtB, 'full', 0);
      }
    }

    if (needBeauty) {
      this.world.setPass('beauty');
      r.setClearColor(this.beautyClear, 1);
      if (split >= 0 && this.rtA2) {
        // shadows are refreshed per half: buildings differ between the two years
        this.useYear(false, f);
        r.shadowMap.needsUpdate = true;
        this.renderScene(this.rtA, 'right', split);
        this.useYear(true, f);
        r.shadowMap.needsUpdate = true;
        this.renderScene(this.rtA2, 'left', split);
      } else {
        r.shadowMap.needsUpdate = true;
        this.renderScene(this.rtA, 'full', 0);
      }
    }
    this.useYear(false, f); // always hand the world back at the scenario year

    // bloom prefilter
    const nightBloom = needBeauty ? this.look.nightBloom : 0;
    const bloomOn = needMachine || nightBloom > 0;
    if (bloomOn) {
      const bu = this.bloom.uniforms;
      bu.uSplit.value = split >= 0 ? splitPx : -1;
      bu.uNight.value = nightBloom;
      bu.uMachine.value = needMachine ? MACHINE_BLOOM : 0;
      bu.uCursor.value.set(f.lensX, f.lensY);
      bu.uRadius.value = f.lensRadius;
      this.quad.material = this.bloom;
      r.setRenderTarget(this.rtBloom);
      r.render(this.quad, this.quadCam);
    }

    // composite to the canvas
    const cu = this.composite.uniforms;
    cu.uSplit.value = split >= 0 ? splitPx : -1;
    cu.uCursor.value.set(f.lensX, f.lensY);
    cu.uRadius.value = f.lensRadius;
    cu.uLens.value = lensOn ? 1 : 0;
    cu.uTime.value = f.time;
    cu.uBloomOn.value = bloomOn ? 1 : 0;
    this.quad.material = this.composite;
    r.setRenderTarget(null);
    r.render(this.quad, this.quadCam);
  }

  dispose(): void {
    this.rtA.dispose();
    this.rtB.dispose();
    this.rtA2?.dispose();
    this.rtB2?.dispose();
    this.rtBloom.dispose();
    this.composite.dispose();
    this.bloom.dispose();
    this.quad.geometry.dispose();
  }
}
