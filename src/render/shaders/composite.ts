import { GLSL_COMMON, GLSL_SOURCES } from './common';

/**
 * Final composite (rendered straight to the canvas, so three injects toneMapping() and
 * linearToOutputTexel() for the renderer's ACES + sRGB settings).
 *
 * Inputs are linear HDR: tA/tA2 = beauty (clay/satellite/night), tB/tB2 = machine scan.
 * Screen is cut in a tile grid (≈18 css px). Each tile resolves to one state:
 *   0 beauty · 1 machine · 2 hollow "debris" tile (1px cyan outline + ×)
 * The lens is a jagged pixel blob: the radius is modulated by angular noise that drifts in time,
 * and the boundary band rerolls tile states a few times per second.
 * Overlays (debris lines, glow, grid, vignette, grain) are applied in display space so their
 * colours are exactly the design tokens.
 */
export const COMPOSITE_FRAG = /* glsl */ `
${GLSL_SOURCES}
uniform sampler2D tBloom;
uniform vec2 uBloomTexel;
uniform float uDpr;
uniform float uTile;     // tile size, drawing-buffer px (integer)
uniform vec2 uCursor;    // spring-smoothed lens centre, drawing-buffer px (origin bottom-left)
uniform float uRadius;   // lens radius, drawing-buffer px (already scaled by open/close)
uniform float uLens;
uniform float uScan;
uniform float uTime;
uniform float uTilt;
uniform float uVignette;
uniform float uGrain;
uniform float uBloomOn;
uniform vec3 uCyan;      // display-space overlay colour (--scan-3)
uniform vec3 uDeep;      // display-space fill for hollow tiles (--scan-0)
varying vec2 vUv;
${GLSL_COMMON}

// 8-tap Vogel disk (golden-angle spiral), unit radius
const vec2 DISK[8] = vec2[8](
  vec2(0.25, 0.0), vec2(-0.319, 0.2925), vec2(0.0489, -0.5569), vec2(0.4022, 0.5247),
  vec2(-0.7384, -0.131), vec2(0.6996, -0.4448), vec2(-0.2341, 0.8701), vec2(-0.448, -0.8581)
);

vec3 beauty(vec2 uv) {
  vec3 c = texA(uv);
  if (uTilt <= 0.0) return c;
  // tilt-shift: focus band slightly below centre; far (top) edge blurs most, near edge a little
  float b = (smoothstep(0.6, 1.0, uv.y) + 0.5 * smoothstep(0.28, 0.0, uv.y)) * uTilt;
  if (b < 0.03) return c;
  vec2 r = vec2(b * 3.4 * uDpr) / uRes;
  vec3 acc = c;
  for (int i = 0; i < 8; i++) acc += texA(uv + DISK[i] * r);
  return acc / 9.0;
}

vec3 bloom(vec2 uv) {
  if (uBloomOn < 0.5) return vec3(0.0);
  vec2 o = uBloomTexel * 1.5;
  return 0.25 * (
    texture2D(tBloom, uv + o).rgb + texture2D(tBloom, uv + vec2(-o.x, o.y)).rgb +
    texture2D(tBloom, uv + vec2(o.x, -o.y)).rgb + texture2D(tBloom, uv - o).rgb);
}

// organic lens outline: r(θ, t) = R · (1 + 0.28·(noise − 0.5)), noise sampled on a circle so it wraps
float lensRadiusAt(vec2 p) {
  vec2 d = p - uCursor;
  if (dot(d, d) < 1e-4) return uRadius;
  float a = atan(d.y, d.x);
  vec2 q = vec2(cos(a), sin(a)) * 1.7 + vec2(uTime * 0.21, -uTime * 0.13);
  float n = vnoise(q + 7.3) * 0.62 + vnoise(q * 2.6 + 19.1) * 0.38;
  return uRadius * (1.0 + 0.28 * (n - 0.5));
}

// machine colours are authored: keep them exact below 0.78 and roll off highlights smoothly
vec3 softClip(vec3 c) {
  vec3 over = max(c - 0.78, 0.0);
  return min(c, vec3(0.78)) + 0.22 * (1.0 - exp(-over / 0.22));
}

vec3 toDisplay(vec3 lin, bool machine) {
  vec3 m;
  if (machine) {
    m = softClip(max(lin, 0.0));
  } else {
    #ifdef TONE_MAPPING
      m = toneMapping(max(lin, 0.0));
    #else
      m = clamp(lin, 0.0, 1.0);
    #endif
  }
  return linearToOutputTexel(vec4(m, 1.0)).rgb;
}

// hollow debris tile: inset 1px square outline with an × through it
float debris(vec2 lp) {
  float w = max(1.0, floor(uDpr + 0.5));
  vec2 q = lp - w;
  float s = uTile - 2.0 * w;
  if (q.x < 0.0 || q.y < 0.0 || q.x > s || q.y > s) return 0.0;
  float edge = step(q.x, w) + step(s - w, q.x) + step(q.y, w) + step(s - w, q.y);
  float diag = step(abs(q.x - q.y), w * 0.7) + step(abs(q.x + q.y - s), w * 0.7);
  return min(edge + diag, 1.0);
}

void main() {
  vec2 uv = vUv;
  vec2 fp = gl_FragCoord.xy;
  vec2 tile = floor(fp / uTile);
  vec2 lp = fp - tile * uTile;
  float state = 0.0;
  float edge = 0.0;
  vec2 radial = vec2(0.0);

  if (uScan > 0.5) {
    state = 1.0;
    // full-screen scan: tiles near the screen border flicker into hollow debris
    vec2 n = ceil(uRes / uTile);
    float e = min(min(tile.x, n.x - 1.0 - tile.x), min(tile.y, n.y - 1.0 - tile.y));
    if (e < 3.0) {
      float s = 1.0 - e / 3.0;
      float fl = floor(uTime * (1.1 + 2.2 * hash12(tile + 3.7)) + hash12(tile) * 9.0);
      if (hash12(tile + fl * 13.7) < s * 0.5) state = 2.0;
    }
  } else if (uLens > 0.5) {
    vec2 tc = (tile + 0.5) * uTile;
    float rT = lensRadiusAt(tc);
    float dT = length(tc - uCursor);
    float grow = clamp(uRadius / (uTile * 4.0), 0.0, 1.0); // band shrinks with a tiny lens
    float band = 1.5 * uTile * grow;
    float inner = rT - band * 0.5;
    if (dT < inner) {
      state = 1.0;
    } else if (dT < rT + band) {
      float s = clamp((dT - inner) / max(band * 1.5, 1e-3), 0.0, 1.0); // 0 inner … 1 outer
      // per-tile state, re-rolled 1.4–4 times per second at a per-tile phase (slow flicker)
      float fl = floor(uTime * (1.4 + 2.6 * hash12(tile + 7.1)) + hash12(tile) * 10.0);
      float h = hash12(tile + fl * 17.13);
      float h2 = hash12(tile * 1.37 + fl * 3.1 + 5.0);
      if (h < pow(1.0 - s, 1.4) * 0.92) state = 1.0;
      else if (h2 < 0.46 * (1.0 - 0.5 * s)) state = 2.0;
    }
    vec2 dv = fp - uCursor;
    float dP = length(dv);
    edge = exp(-abs(dP - lensRadiusAt(fp)) / (uTile * 0.85)) * grow;
    radial = dv / max(dP, 1.0);
  }

  bool machine = state > 0.5 && (state < 1.5 || uScan > 0.5);
  vec3 lin;
  if (machine) {
    lin = texB(uv);
    if (state > 1.5) lin *= 0.45;
    lin += bloom(uv);
  } else {
    lin = beauty(uv);
    if (edge > 0.03) {
      // chromatic fringe hugging the lens boundary
      vec2 o = radial * (edge * 2.5 * uDpr) / uRes;
      lin.r = texA(uv + o).r;
      lin.b = texA(uv - o).b;
    }
    lin += bloom(uv);
  }
  vec3 col = toDisplay(lin, machine);

  if (state > 1.5) {
    col = mix(col, uDeep, 0.3);
    col = mix(col, uCyan, debris(lp) * 0.9);
  } else if (machine) {
    float w = max(1.0, floor(uDpr + 0.5));
    col = mix(col, uCyan, max(step(lp.x, w), step(lp.y, w)) * 0.07); // faint scan grid
  }
  col += uCyan * (edge * edge * 0.3);

  vec2 vq = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  col *= 1.0 - uVignette * smoothstep(0.3, 1.1, length(vq));
  col += (hash12(fp + fract(uTime * 7.31) * 811.0) - 0.5) * uGrain;
  gl_FragColor = vec4(col, 1.0);
}
`;
