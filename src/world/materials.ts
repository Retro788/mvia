import * as THREE from 'three';
import { WORLD, WORLD_D, WORLD_W } from '../core/geo';

/**
 * Shared shader plumbing for the city.
 *
 * Every visible mesh owns two cached materials: a lit "beauty" material (MeshLambertMaterial patched with
 * onBeforeCompile; clay / satellite / night are branches on the uStyle uniform, so switching style never
 * recompiles) and an unlit "machine" ShaderMaterial (MVIA LiDAR scan). setPass just swaps mesh.material.
 * All uniforms below are shared *by reference* between every program.
 */

function blankTex(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}

export const U = {
  uTime: { value: 0 },
  uYear: { value: 2026 },
  /** 0 clay · 1 satellite · 2 night */
  uStyle: { value: 0 },
  /** xz = machine focus point, z component = strength 0..1 */
  uFocus: { value: new THREE.Vector3(0, 0, 0) },
  uWorld: { value: new THREE.Vector4(WORLD.minX, WORLD.minZ, WORLD_W, WORLD_D) },
  uOverlay: { value: blankTex() as THREE.Texture },
  uOverlayOn: { value: 0 },
  uOverlayKind: { value: 0 },
  uLanduse: { value: blankTex() as THREE.Texture },
  uSat: { value: blankTex() as THREE.Texture },
  /** 0 = procedural texture in world UV · 1 = Esri tiles in per-vertex mercator UV */
  uSatMode: { value: 0 },
};

const _c = new THREE.Color();
/** sRGB hex → linear GLSL vec3 literal (lighting happens in linear space) */
export function glc(hex: string | number): string {
  _c.set(hex);
  return `vec3(${_c.r.toFixed(4)},${_c.g.toFixed(4)},${_c.b.toFixed(4)})`;
}

/** Shared GLSL: uniforms, hashing, overlay ramps, machine-view helpers. Included once per stage. */
export const COMMON_GLSL = /* glsl */ `
uniform float uTime;
uniform float uYear;
uniform float uStyle;
uniform vec3 uFocus;
uniform vec4 uWorld;
uniform sampler2D uOverlay;
uniform float uOverlayOn;
uniform float uOverlayKind;
float mHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
vec2 mWorldUv(vec2 xz) { return (xz - uWorld.xy) / uWorld.zw; }
vec3 mRamp5(vec3 a, vec3 b, vec3 c, vec3 d, vec3 e, float t) {
  t = clamp(t, 0.0, 1.0) * 4.0;
  if (t < 1.0) return mix(a, b, t);
  if (t < 2.0) return mix(b, c, t - 1.0);
  if (t < 3.0) return mix(c, d, t - 2.0);
  return mix(d, e, t - 3.0);
}
/** rgb = ramp colour, a = suggested opacity (0 where the field is ~empty) */
vec4 mOverlay(vec2 xz) {
  if (uOverlayOn < 0.5) return vec4(0.0);
  vec2 uv = mWorldUv(xz);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  float v = texture2D(uOverlay, uv).r;
  float a = 0.6 * smoothstep(0.02, 0.07, v);
  vec3 c;
  if (uOverlayKind < 0.5) c = mRamp5(${glc('#f6f1d9')}, ${glc('#f2c879')}, ${glc('#ea8a3c')}, ${glc('#d04a2f')}, ${glc('#7d1d3f')}, v);
  else if (uOverlayKind < 1.5) c = mRamp5(${glc('#3ddc84')}, ${glc('#a9d65e')}, ${glc('#f5b83d')}, ${glc('#f0743a')}, ${glc('#e0303a')}, v);
  else if (uOverlayKind < 2.5) {
    c = ${glc('#ff6a1f')};
    a = smoothstep(0.02, 0.08, v) * (0.3 + 0.5 * v) * (0.78 + 0.22 * sin(uTime * 3.2 + v * 7.0));
  }
  else if (uOverlayKind < 3.5) c = mRamp5(${glc('#1d3f9e')}, ${glc('#2f7fe0')}, ${glc('#4fd1ff')}, ${glc('#a8ecff')}, ${glc('#ffffff')}, v);
  else c = mRamp5(${glc('#e4e3de')}, ${glc('#b9b8b2')}, ${glc('#85858a')}, ${glc('#4a4b50')}, ${glc('#111214')}, v);
  return vec4(c, a);
}
/** concentric pulsing range rings + rotating sweep around the machine focus */
float mRings(vec2 xz) {
  if (uFocus.z < 0.01) return 0.0;
  vec2 dv = xz - uFocus.xy;
  float d = length(dv);
  float fade = 1.0 - smoothstep(0.0, 160.0, d);
  if (fade <= 0.0) return 0.0;
  // distance (world units) to the nearest ring; rings travel outward
  float r = abs(fract(d / 12.0 - uTime * 0.35) - 0.5) * 12.0;
  float ring = 1.0 - smoothstep(0.0, 0.55, r);
  float ang = atan(dv.y, dv.x);
  float sweepA = mod(uTime * 1.1, 6.2831853);
  float delta = mod(sweepA - ang + 6.2831853, 6.2831853);
  float sweep = exp(-delta * 2.6) * 0.55;
  float core = 1.0 - smoothstep(0.0, 1.2, d);
  return (ring * 0.8 + sweep + core) * fade * uFocus.z;
}
`;

/** fragment-only helpers (derivatives are unavailable in vertex shaders) */
export const FRAG_GLSL = /* glsl */ `
/** anti-aliased line every \`spacing\` units along coordinate c */
#ifndef MVIA_VERTEX
float mLine(float c, float spacing, float width) {
  float x = c / spacing;
  float d = abs(fract(x - 0.5) - 0.5) / max(fwidth(x), 1e-5);
  return 1.0 - min(d / width, 1.0);
}
#endif
`;

export const MACHINE_COLORS = {
  scan0: glc('#061a26'),
  scan1: glc('#0b3a52'),
  scan2: glc('#14627f'),
  scan3: glc('#4fd1ff'),
  scan4: glc('#b9f1ff'),
  orange: glc('#ff8a2b'),
};

/** depth tint used by every machine fragment shader: near = bright cyan, far = deep blue */
export const MACHINE_DEPTH_GLSL = /* glsl */ `
vec3 mDepthTint(vec3 col, vec3 wpos) {
  float dist = length(cameraPosition - wpos);
  float nearF = 1.0 - smoothstep(40.0, 1100.0, dist);
  // far: dimmer + deep-blue haze; near: slightly boosted toward cyan
  return mix(col * 0.5 + ${glc('#0b2f6b')} * 0.18, col * 1.12 + ${glc('#4fd1ff')} * 0.03, nearF);
}
`;

// ───────────────────────────── Lambert patching ─────────────────────────────
export interface PatchOptions {
  /** GLSL placed after #include <common> in the vertex shader (attributes / varyings) */
  vertHead?: string;
  /** GLSL placed after #include <begin_vertex> (may modify \`transformed\`) */
  vertBegin?: string;
  /** GLSL placed after #include <project_vertex> (\`transformed\` still valid) */
  vertEnd?: string;
  fragHead?: string;
  /** GLSL placed after #include <color_fragment>: set diffuseColor */
  fragColor?: string;
  /** GLSL placed after #include <emissivemap_fragment>: add to totalEmissiveRadiance */
  fragEmissive?: string;
  uniforms?: Record<string, THREE.IUniform>;
}

/** standard world-position varying for patched materials (handles instancing) */
export const WPOS_VERT = /* glsl */ `
{
  vec4 mwp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  mwp = instanceMatrix * mwp;
  #endif
  vWPos = (modelMatrix * mwp).xyz;
}
`;

export function patchMaterial<M extends THREE.Material>(mat: M, key: string, o: PatchOptions): M {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U, o.uniforms ?? {});
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n#define MVIA_VERTEX\n${COMMON_GLSL}\n${o.vertHead ?? ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${o.vertBegin ?? ''}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${o.vertEnd ?? ''}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${COMMON_GLSL}\n${FRAG_GLSL}\n${o.fragHead ?? ''}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${o.fragColor ?? ''}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${o.fragEmissive ?? ''}`);
  };
  // closures with identical source text must not share programs
  mat.customProgramCacheKey = () => `mvia-${key}`;
  return mat;
}

export function machineMaterial(
  key: string,
  vertex: string,
  fragment: string,
  extra: Record<string, THREE.IUniform> = {},
  params: THREE.ShaderMaterialParameters = {},
): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    uniforms: { ...U, ...extra },
    vertexShader: `#define MVIA_VERTEX\n${COMMON_GLSL}\n${vertex}`,
    fragmentShader: `${COMMON_GLSL}\n${FRAG_GLSL}\n${MACHINE_DEPTH_GLSL}\n${fragment}`,
    toneMapped: false,
    fog: false,
    lights: false,
    ...params,
  });
  m.name = `machine-${key}`;
  return m;
}

// ───────────────────────────── growth / shrink vertex snippets ─────────────────────────────
/** instanced box that rises 0→1 over 0.8 years once uYear passes aYear; collapsed before */
export const GROW_VERT_HEAD = /* glsl */ `
attribute float aYear;
attribute float aSeed;
varying vec3 vLocal;
varying vec3 vScale;
varying vec3 vObjN;
varying vec3 vWPos;
varying float vSeed;
`;
export const GROW_VERT_BEGIN = /* glsl */ `
float mg = clamp((uYear - aYear) / 0.8, 0.0, 1.0);
mg = 1.0 - (1.0 - mg) * (1.0 - mg) * (1.0 - mg);
vLocal = position;
vObjN = normal;
vSeed = aSeed;
#ifdef USE_INSTANCING
vScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz) * mg, length(instanceMatrix[2].xyz));
#else
vScale = vec3(1.0, mg, 1.0);
#endif
transformed.y *= mg;
if (mg <= 0.0) transformed = vec3(0.0);
`;
/** trees: visible until uYear passes aYear (deforestation), then shrink out over 0.6 years */
export const SHRINK_VERT_HEAD = /* glsl */ `
attribute float aYear;
attribute float aSeed;
varying vec3 vWPos;
varying float vSeed;
varying vec3 vObjN;
`;
export const SHRINK_VERT_BEGIN = /* glsl */ `
float mk = 1.0 - clamp((uYear - aYear) / 0.6, 0.0, 1.0);
vSeed = aSeed;
vObjN = normal;
transformed *= mk;
if (mk <= 0.0) transformed = vec3(0.0);
`;

/** depth material for shadow casting that follows the same vertex deformation */
export function depthMaterial(key: string, head: string, begin: string): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n#define MVIA_VERTEX\n${COMMON_GLSL}\n${head}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${begin}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${WPOS_VERT}`);
  };
  m.customProgramCacheKey = () => `mvia-depth-${key}`;
  return m;
}

/** machine vertex shader shared by instanced boxes (growth) — outputs local/scale/normal/world */
export const MACHINE_BOX_VERT = /* glsl */ `
attribute float aYear;
attribute float aSeed;
varying vec3 vLocal;
varying vec3 vScale;
varying vec3 vObjN;
varying vec3 vWPos;
varying float vSeed;
void main() {
  vec3 transformed = position;
  ${GROW_VERT_BEGIN}
  vec4 wp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  wp = instanceMatrix * wp;
  #endif
  wp = modelMatrix * wp;
  vWPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/** edge factor (1 on box edges) from local unit-box coords — box spans x,z∈[-.5,.5], y∈[0,1] */
export const BOX_EDGE_GLSL = /* glsl */ `
float mBoxEdge(vec3 local, vec3 scale, vec3 objN, float width) {
  vec3 ed = (0.5 - abs(local - vec3(0.0, 0.5, 0.0))) * scale + abs(objN) * 1e3;
  float e = min(ed.x, min(ed.y, ed.z));
  return 1.0 - smoothstep(0.0, width, e);
}
`;

/** Machine fragment for building-like volumes */
export const MACHINE_BOX_FRAG = /* glsl */ `
${BOX_EDGE_GLSL}
uniform vec3 uTint;
uniform float uAlpha;
varying vec3 vLocal;
varying vec3 vScale;
varying vec3 vObjN;
varying vec3 vWPos;
varying float vSeed;
void main() {
  float edge = mBoxEdge(vLocal, vScale, vObjN, 0.09);
  float h = vLocal.y * vScale.y;
  float scan = 0.5 + 0.5 * sin(vWPos.y * 9.0 - uTime * 2.4);
  vec3 body = ${MACHINE_COLORS.scan1} * (0.55 + 0.25 * scan) * uTint;
  body += ${MACHINE_COLORS.scan2} * 0.35 * (vObjN.y > 0.5 ? 1.0 : 0.0);
  body *= mix(0.6, 1.0, smoothstep(0.0, 2.5, h));
  vec3 col = mix(body, ${MACHINE_COLORS.scan3} * uTint * 1.35, edge);
  col += ${MACHINE_COLORS.scan3} * mRings(vWPos.xz) * 0.55;
  vec4 ov = mOverlay(vWPos.xz);
  col = mix(col, ov.rgb, ov.a * 0.45);
  col = mDepthTint(col, vWPos);
  gl_FragColor = vec4(col, mix(uAlpha, 1.0, edge));
  #include <colorspace_fragment>
}
`;

/** generic machine shader for arbitrary merged meshes (landmarks / establishments): rim + scanline */
export const MACHINE_SOLID_VERT = /* glsl */ `
varying vec3 vWPos;
varying vec3 vN;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
export const MACHINE_SOLID_FRAG = /* glsl */ `
uniform vec3 uTint;
uniform float uAlpha;
varying vec3 vWPos;
varying vec3 vN;
void main() {
  vec3 V = normalize(cameraPosition - vWPos);
  float rim = pow(1.0 - abs(dot(normalize(vN), V)), 2.0);
  float bands = mLine(vWPos.y, 1.2, 1.0) * 0.6;
  vec3 col = uTint * (0.28 + 0.2 * max(vN.y, 0.0)) + uTint * (rim * 1.1 + bands);
  col += ${MACHINE_COLORS.scan3} * mRings(vWPos.xz) * 0.4;
  col = mDepthTint(col, vWPos);
  gl_FragColor = vec4(col, uAlpha + rim * (1.0 - uAlpha));
  #include <colorspace_fragment>
}
`;
