import * as THREE from 'three';

/** Pass-through vertex shader for a clip-space fullscreen triangle. */
export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * One oversized triangle covering the viewport (cheaper than a quad: no diagonal seam,
 * no helper-pixel overdraw along the shared edge).
 */
export function createFullscreenTriangle(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  return g;
}
