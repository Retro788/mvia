import { GLSL_COMMON, GLSL_SOURCES } from './common';

/**
 * Bloom prefilter + downsample into a 1/4-resolution target.
 * Sources: bright parts of the machine pass (masked to the lens, or full screen in 'scan')
 * and, in 'night' style, the city lights of the beauty pass. A 3×3 tent over bilinear taps
 * covers the 4×4 footprint of each output texel; the composite adds one more blur when sampling.
 */
export const BLOOM_FRAG = /* glsl */ `
${GLSL_SOURCES}
uniform vec2 uTexel;     // one bloom texel in uv
uniform float uNight;    // beauty bloom gain (night style)
uniform float uMachine;  // machine bloom gain
uniform float uScan;
uniform vec2 uCursor;    // drawing-buffer px
uniform float uRadius;   // drawing-buffer px
varying vec2 vUv;
${GLSL_COMMON}

vec3 bright(vec3 c, float thr) {
  float l = max(max(c.r, c.g), c.b);
  return c * (max(l - thr, 0.0) / max(l, 1e-4));
}

void main() {
  vec3 a = vec3(0.0);
  vec3 b = vec3(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 uv = vUv + vec2(float(i), float(j)) * uTexel * 0.75;
      float w = (i == 0 ? 2.0 : 1.0) * (j == 0 ? 2.0 : 1.0);
      if (uNight > 0.0) a += bright(texA(uv), 0.62) * w;
      if (uMachine > 0.0) b += bright(texB(uv), 0.28) * w;
    }
  }
  float mask = 1.0;
  if (uScan < 0.5) {
    float d = length(vUv * uRes - uCursor);
    mask = 1.0 - smoothstep(uRadius * 0.8, uRadius * 1.15, d);
  }
  gl_FragColor = vec4((a * uNight + b * (uMachine * mask)) / 16.0, 1.0);
}
`;
