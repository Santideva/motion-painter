// depthTrianglePreprocessor.js
// --------------------------------
// Finalized depth-triangle preprocessor
// Combines GPU-based luminance/detail bake with a CPU triangle-style depth solver.
// Updated: normalization of GPU readback, depth-based gradient (tilt) pass,
// positions-aware derivative spacing, strict validation, worker-friendly outputs,
// and robust error handling.
//
// API & behavior preserved from prior spec:
//   export function createDepthTrianglePreprocessor({ renderer, bakeSize, gridSize, positions, normals, textures, kL, kD, baseDepth, depthScale })
//
// Returns an object with:
//   init(), updateTextures(), compute(), getRenderTargets(), getStats(), updateParams(), dispose()
//
// Notes:
// - compute() returns serializable typed arrays: depths (Float32Array), tilts (Float32Array), windingNumbers (Float32Array).
// - depthTex/detailTex are still returned when available for in-process debugging, but are not guaranteed to be transferable.
// - This module is designed to be usable in both main-thread and OffscreenCanvas-enabled worker environments
//   provided a compatible THREE renderer is supplied.

// depthTrianglePreprocessor.js
// --------------------------------
// FIXED: Remove bare THREE.js import, accept THREE as parameter instead
// This allows the worker to pass in its cached THREE module.
//
// API CHANGE: createDepthTrianglePreprocessor now requires THREE parameter
//   export function createDepthTrianglePreprocessor({ THREE, renderer, bakeSize, gridSize, ... })

// REMOVED: import * as THREE from 'three';
import { GPUComputationRenderer } from './gpuComputationRenderer.js';

/**
 * Inlined triangle solver: law of cosines for side c
 */
function solveTriangle(a, b, alpha) {
  const c2 = a * a + b * b - 2 * a * b * Math.cos(alpha);
  return Math.sqrt(Math.max(c2, 0));
}

/**
 * Wraps angle delta into [-PI,PI]
 */
function wrapDelta(a, b) {
  let d = b - a;
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/**
 * Helper: normalize readback buffers into Float32Array with values in [0,1]
 */
function normalizeReadback(buf) {
  if (!buf) return new Float32Array(0);
  if (buf instanceof Float32Array) return new Float32Array(buf);
  if (buf instanceof Float64Array) {
    const out = new Float32Array(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = Number(buf[i]) || 0.0;
    return out;
  }
  if (buf instanceof Uint8Array || buf instanceof Uint8ClampedArray) {
    const out = new Float32Array(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] / 255.0;
    return out;
  }
  try {
    const out = new Float32Array(buf.length || 0);
    for (let i = 0; i < out.length; i++) out[i] = Number(buf[i]) || 0.0;
    return out;
  } catch (e) {
    return new Float32Array(0);
  }
}

/**
 * Safe bilinear sampling from Float32Array
 */
function sampleTextureFloat(buffer, width, height, u, v, channel = 0) {
  if (!buffer || buffer.length < width * height * 4) return 0.0;

  u = Math.max(0, Math.min(1, u));
  v = Math.max(0, Math.min(1, v));

  const x = u * (width - 1);
  const y = v * (height - 1);

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);

  const fx = x - x0;
  const fy = y - y0;
  const stride = 4;

  const idx00 = (y0 * width + x0) * stride + channel;
  const idx10 = (y0 * width + x1) * stride + channel;
  const idx01 = (y1 * width + x0) * stride + channel;
  const idx11 = (y1 * width + x1) * stride + channel;

  if (idx11 >= buffer.length) return 0.0;

  const v00 = buffer[idx00];
  const v10 = buffer[idx10];
  const v01 = buffer[idx01];
  const v11 = buffer[idx11];

  const safe = (z) => (Number.isFinite(z) ? z : 0.0);

  const s00 = safe(v00);
  const s10 = safe(v10);
  const s01 = safe(v01);
  const s11 = safe(v11);

  const v0 = s00 * (1 - fx) + s10 * fx;
  const v1 = s01 * (1 - fx) + s11 * fx;
  return v0 * (1 - fy) + v1 * fy;
}

/**
 * Creates depth-triangle preprocessor
 * 
 * @param {Object} options
 * @param {Object} options.THREE - THREE.js module (REQUIRED - pass from worker)
 * @param {THREE.WebGLRenderer} options.renderer
 * @param {number} options.bakeSize
 * @param {number} options.gridSize
 * @param {Float32Array} options.positions
 * @param {Float32Array} options.normals
 * @param {Object} options.textures
 * @param {number} options.kL
 * @param {number} options.kD
 * @param {number} options.baseDepth
 * @param {number} options.depthScale
 */
export function createDepthTrianglePreprocessor({
  THREE,  // ← NEW: Accept THREE as parameter
  renderer,
  bakeSize,
  gridSize,
  positions,
  normals,
  textures,
  kL = 1.0,
  kD = 1.0,
  baseDepth = 0.1,
  depthScale = 2.0
}) {
  // Validate THREE module
  if (!THREE) {
    throw new Error('[depthTriangle] THREE.js module is required (pass as parameter)');
  }
  if (!THREE.Texture || !THREE.ShaderMaterial || !THREE.WebGLRenderTarget) {
    throw new Error('[depthTriangle] Invalid THREE.js module - missing required constructors');
  }

  // Basic validations
  if (!renderer) throw new Error('[depthTriangle] renderer is required');
  if (!Number.isInteger(bakeSize) || bakeSize < 4) throw new Error('[depthTriangle] bakeSize must be integer >= 4');
  if (!Number.isInteger(gridSize) || gridSize < 2) throw new Error('[depthTriangle] gridSize must be integer >= 2');
  if (!positions || !(positions.length % 2 === 0)) throw new Error('[depthTriangle] positions must be Float32Array of UVs');
  if (!textures || !textures.diffuse) throw new Error('[depthTriangle] textures.diffuse required');

  const count = positions.length / 2;
  const G = gridSize;
  const N = bakeSize;

  if (count !== G * G) {
    throw new Error(`[depthTriangle] positions length (${count}) does not match gridSize^2 (${G * G})`);
  }

  // GPU computation helper
  const gpu = new GPUComputationRenderer(N, N, renderer, THREE);

  // Helper to build a pass
  function makePass(name, fragmentShader) {
    const tex = gpu.createTexture();
    const variable = gpu.addVariable(name, fragmentShader, tex);
    gpu.setVariableDependencies(variable, [variable]);
    return variable;
  }

  // Fragment shader: luminance H0
  const lumShader = `
    precision highp float;
    uniform sampler2D diffuse;
    float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
    void main() {
      vec4 texel = texture2D(diffuse, vUv);
      float H0 = lum(texel.rgb);
      gl_FragColor = vec4(H0, 0.0, 0.0, 1.0);
    }
  `;

  // Fragment shader: detail
  const detailShader = `
    precision highp float;
    uniform sampler2D bumpMap;
    uniform sampler2D normalMap;
    uniform sampler2D albedoMap;
    uniform float bumpScale;
    uniform float normalScale;
    uniform float albedoScale;
    void main() {
      float legB = (texture2D(bumpMap, vUv).r - 0.5) * bumpScale;
      vec3 n = texture2D(normalMap, vUv).xyz * 2.0 - 1.0;
      float legN = length(n.xy) * normalScale;
      float legA = (1.0 - texture2D(albedoMap, vUv).r) * albedoScale;
      float D = sqrt(legB * legB + legN * legN + legA * legA);
      gl_FragColor = vec4(D, 0.0, 0.0, 1.0);
    }
  `;

  const lumVar = makePass('lum', lumShader);
  const detailVar = makePass('detail', detailShader);

  // Bind uniforms
  Object.assign(lumVar.material.uniforms, {
    diffuse: { value: textures.diffuse }
  });

  Object.assign(detailVar.material.uniforms, {
    bumpMap: { value: textures.bump || textures.diffuse },
    normalMap: { value: textures.normal || textures.diffuse },
    albedoMap: { value: textures.albedo || textures.diffuse },
    bumpScale: { value: textures.bumpScale || 1.0 },
    normalScale: { value: textures.normalScale || 1.0 },
    albedoScale: { value: textures.albedoScale || 1.0 }
  });

  // CPU buffers
  const depths = new Float32Array(count);
  const tilts = new Float32Array(count);
  const windingNumbers = new Float32Array(count);

  let rawBufL = null;
  let rawBufD = null;

  // Stats
  let stats = {
    bakeSize: N,
    gridSize: G,
    sampleCount: count,
    kL,
    kD,
    baseDepth,
    depthScale,
    lastComputeMs: 0
  };

  function _validateTexture(texture, name) {
    if (!texture) {
      console.warn(`[depthTriangle] ${name} texture is null`);
      return false;
    }
    if (!texture.image) {
      console.warn(`[depthTriangle] ${name} texture has no image`);
      return false;
    }
    if (texture.image.width <= 0 || texture.image.height <= 0) {
      console.warn(`[depthTriangle] ${name} texture has invalid dimensions`);
      return false;
    }
    return true;
  }

  function _validateBuffer(buf, name) {
    if (!buf || buf.length === 0) {
      console.error(`[depthTriangle] ${name} buffer is empty`);
      return false;
    }
    const sampleSize = Math.min(128, Math.max(1, Math.floor(buf.length / 4)));
    let validCount = 0;
    for (let i = 0; i < sampleSize; i++) {
      const idx = Math.floor(Math.random() * buf.length);
      if (Number.isFinite(buf[idx])) validCount++;
    }
    const validRatio = validCount / sampleSize;
    if (validRatio < 0.5) {
      console.error(`[depthTriangle] ${name} buffer appears mostly invalid`);
      return false;
    }
    return true;
  }

  return {
    detailVar,
    lumVar,

    init() {
      try {
        const err = gpu.init();
        if (err) throw new Error(`GPU init failed: ${err}`);

        rawBufL = new Float32Array(N * N * 4);
        rawBufD = new Float32Array(N * N * 4);

        console.log(`[depthTriangle] Initialized: GPU=${N}x${N}, CPU grid=${G}x${G}, samples=${count}`);
        return null;
      } catch (error) {
        console.error('[depthTriangle] Init error:', error);
        throw error;
      }
    },

    updateTextures(newTextures) {
      if (!newTextures) return;

      if (newTextures.diffuse && _validateTexture(newTextures.diffuse, 'diffuse')) {
        lumVar.material.uniforms.diffuse.value = newTextures.diffuse;
        lumVar.material.needsUpdate = true;
      }

      if (newTextures.bump && _validateTexture(newTextures.bump, 'bump')) {
        detailVar.material.uniforms.bumpMap.value = newTextures.bump;
        detailVar.material.needsUpdate = true;
      }

      if (newTextures.normal && _validateTexture(newTextures.normal, 'normal')) {
        detailVar.material.uniforms.normalMap.value = newTextures.normal;
        detailVar.material.needsUpdate = true;
      }

      if (newTextures.albedo && _validateTexture(newTextures.albedo, 'albedo')) {
        detailVar.material.uniforms.albedoMap.value = newTextures.albedo;
        detailVar.material.needsUpdate = true;
      }

      if (newTextures.bumpScale !== undefined) {
        detailVar.material.uniforms.bumpScale.value = newTextures.bumpScale;
        detailVar.material.needsUpdate = true;
      }
      if (newTextures.normalScale !== undefined) {
        detailVar.material.uniforms.normalScale.value = newTextures.normalScale;
        detailVar.material.needsUpdate = true;
      }
      if (newTextures.albedoScale !== undefined) {
        detailVar.material.uniforms.albedoScale.value = newTextures.albedoScale;
        detailVar.material.needsUpdate = true;
      }
    },

    compute() {
      const tStart = performance.now();

      try {
        // GPU passes
        gpu.compute();
        const rtL = gpu.getCurrentRenderTarget(lumVar);
        const rtD = gpu.getCurrentRenderTarget(detailVar);

        // Read back
        try {
          renderer.readRenderTargetPixels(rtL, 0, 0, N, N, rawBufL);
          renderer.readRenderTargetPixels(rtD, 0, 0, N, N, rawBufD);
        } catch (readErr) {
          console.error('[depthTriangle] GPU readback failed:', readErr);
          throw new Error('GPU readback error: ' + String(readErr));
        }

        // Normalize
        let bufL = normalizeReadback(rawBufL);
        let bufD = normalizeReadback(rawBufD);

        if (!_validateBuffer(bufL, 'luminance')) {
          console.warn('[depthTriangle] Luminance buffer validation failed');
          bufL = new Float32Array(N * N * 4);
          for (let i = 0; i < bufL.length; i += 4) bufL[i] = 0.5;
        }
        if (!_validateBuffer(bufD, 'detail')) {
          console.warn('[depthTriangle] Detail buffer validation failed');
          bufD = new Float32Array(N * N * 4);
        }

        // Compute depths
        for (let i = 0; i < count; i++) {
          const u = positions[2 * i];
          const v = positions[2 * i + 1];

          const H0 = sampleTextureFloat(bufL, N, N, u, v, 0);
          const D = sampleTextureFloat(bufD, N, N, u, v, 0);

          const normalizedU = u * 2 - 1;
          const normalizedV = v * 2 - 1;
          const r = Math.sqrt(normalizedU * normalizedU + normalizedV * normalizedV);
          const r_clamped = Math.min(r, 1.0);

          const luminanceDepth = (1.0 - H0) * depthScale * kL;
          const detailDepth = D * kD;
          const radialFalloff = (1.0 - r_clamped * r_clamped);

          let d = baseDepth + luminanceDepth * radialFalloff + detailDepth;
          d = Math.max(0.01, Math.min(10.0, d));
          depths[i] = d;
        }

        // Compute tilts
        for (let i = 0; i < count; i++) {
          const xi = i % G;
          const yi = Math.floor(i / G);

          const left = (xi > 0) ? i - 1 : i;
          const right = (xi < G - 1) ? i + 1 : i;
          const down = (yi > 0) ? i - G : i;
          const up = (yi < G - 1) ? i + G : i;

          const depthL = depths[left];
          const depthR = depths[right];
          const depthD = depths[down];
          const depthU = depths[up];

          let dxDen = 1.0, dyDen = 1.0;
          try {
            const xL = positions[2 * left];
            const xR = positions[2 * right];
            dxDen = Math.abs(xR - xL) || 1.0;
            const yD = positions[2 * down + 1];
            const yU = positions[2 * up + 1];
            dyDen = Math.abs(yU - yD) || 1.0;
          } catch (e) {
            dxDen = 1.0;
            dyDen = 1.0;
          }

          const dx = (depthR - depthL) / Math.max(1e-6, dxDen);
          const dy = (depthU - depthD) / Math.max(1e-6, dyDen);

          tilts[i] = Math.atan2(dy, dx);
        }

        // Winding numbers
        for (let i = 0; i < count; i++) {
          const xi = i % G;
          const yi = Math.floor(i / G);

          const hasRight = (xi < G - 1);
          const hasUp = (yi < G - 1);

          if (!hasRight || !hasUp) {
            windingNumbers[i] = 0.0;
            continue;
          }

          const iR = i + 1;
          const iU = i + G;
          const iUR = i + G + 1;

          const phi00 = tilts[i];
          const phi10 = tilts[iR];
          const phi11 = tilts[iUR];
          const phi01 = tilts[iU];

          let w = 0.0;
          w += wrapDelta(phi00, phi10);
          w += wrapDelta(phi10, phi11);
          w += wrapDelta(phi11, phi01);
          w += wrapDelta(phi01, phi00);

          windingNumbers[i] = w / (2 * Math.PI);
          windingNumbers[i] = Math.max(-2.0, Math.min(2.0, windingNumbers[i]));
        }

        const tEnd = performance.now();
        stats.lastComputeMs = tEnd - tStart;

        return {
          depths: new Float32Array(depths),
          tilts: new Float32Array(tilts),
          windingNumbers: new Float32Array(windingNumbers),
          depthTex: rtL ? (rtL.texture || null) : null,
          detailTex: rtD ? (rtD.texture || null) : null,
          stats: { ...stats }
        };
      } catch (error) {
        console.error('[depthTriangle] Compute error:', error);

        depths.fill(1.0);
        tilts.fill(0.0);
        windingNumbers.fill(0.0);

        return {
          depths: new Float32Array(depths),
          tilts: new Float32Array(tilts),
          windingNumbers: new Float32Array(windingNumbers),
          depthTex: null,
          detailTex: null,
          stats: { ...stats, lastError: String(error) }
        };
      }
    },

    getRenderTargets() {
      try {
        return {
          luminance: gpu.getCurrentRenderTarget(lumVar),
          detail: gpu.getCurrentRenderTarget(detailVar)
        };
      } catch (e) {
        return { luminance: null, detail: null };
      }
    },

    getStats() {
      return { ...stats };
    },

    updateParams(params = {}) {
      if (params.kL !== undefined) kL = params.kL;
      if (params.kD !== undefined) kD = params.kD;
      if (params.baseDepth !== undefined) baseDepth = params.baseDepth;
      if (params.depthScale !== undefined) depthScale = params.depthScale;

      stats.kL = kL;
      stats.kD = kD;
      stats.baseDepth = baseDepth;
      stats.depthScale = depthScale;
    },

    dispose() {
      try {
        if (gpu && typeof gpu.dispose === 'function') {
          gpu.dispose();
        }
        rawBufL = null;
        rawBufD = null;
        console.log('[depthTriangle] Resources disposed');
      } catch (error) {
        console.error('[depthTriangle] Dispose error:', error);
      }
    }
  };
}