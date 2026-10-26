/** GLSL helpers shared by the post-processing passes. */
export const GLSL_COMMON = /* glsl */ `
// Dave Hoskins' hash without sine: stable across GPUs, no precision banding.
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Compare mode: everything left of uSplit (drawing-buffer px) comes from the "*2" targets (base year).
bool leftOfSplit(vec2 uv) { return uSplit >= 0.0 && uv.x * uRes.x < uSplit; }
vec3 texA(vec2 uv) { return leftOfSplit(uv) ? texture2D(tA2, uv).rgb : texture2D(tA, uv).rgb; }
vec3 texB(vec2 uv) { return leftOfSplit(uv) ? texture2D(tB2, uv).rgb : texture2D(tB, uv).rgb; }
`;

/** Uniform block both passes declare before GLSL_COMMON. */
export const GLSL_SOURCES = /* glsl */ `
uniform sampler2D tA;
uniform sampler2D tA2;
uniform sampler2D tB;
uniform sampler2D tB2;
uniform vec2 uRes;
uniform float uSplit;
`;
