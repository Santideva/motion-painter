// src/core/diagnostics.js
// Enhanced WebGL diagnostics utilities (dev-only).
// Usage:
//   import { addFrameBufferDiagnostics, addWebGLRendererDiagnostics, WebGLDiagnostics } from './core/diagnostics.js';
//   addFrameBufferDiagnostics(frameBuffer);
//   addWebGLRendererDiagnostics(webglRenderer);

export class WebGLDiagnostics {
  constructor(gl, opts = {}) {
    this.gl = gl;
    this.devMode = !!opts.devMode;
    this.errorNames = {
      [gl.NO_ERROR]: 'NO_ERROR',
      [gl.INVALID_ENUM]: 'INVALID_ENUM',
      [gl.INVALID_VALUE]: 'INVALID_VALUE',         // 1281
      [gl.INVALID_OPERATION]: 'INVALID_OPERATION', // 1282
      [gl.OUT_OF_MEMORY]: 'OUT_OF_MEMORY',
      [gl.INVALID_FRAMEBUFFER_OPERATION]: 'INVALID_FRAMEBUFFER_OPERATION'
    };
  }

  // Check immediate GL error and print contextual diagnostics
  checkError(operation, context = '') {
    const gl = this.gl;
    const err = gl.getError();
    if (err !== gl.NO_ERROR) {
      const name = this.errorNames[err] || `UNKNOWN_GL_ERROR_${err}`;
      const ctx = context ? ` — ${context}` : '';
      console.error(`[GL_ERROR] ${name} (${err}) in ${operation}${ctx}`);

      // Extra diagnostics per error
      if (err === gl.INVALID_VALUE) this._diagnoseInvalidValue(operation);
      if (err === gl.INVALID_OPERATION) this._diagnoseInvalidOperation(operation);

      // Return the error object for programmatic use
      return { code: err, name };
    }
    return null;
  }

  // Lightweight diagnostics for INVALID_VALUE (1281)
  _diagnoseInvalidValue(operation) {
    const gl = this.gl;
    console.error(`[GL_DIAG] INVALID_VALUE during ${operation}`);
    try {
      const vao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
      const program = gl.getParameter(gl.CURRENT_PROGRAM);
      console.error('  - VAO bound:', !!vao, vao);
      console.error('  - Program bound:', !!program, program);
      if (program) {
        const natts = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES);
        console.error('  - Active attributes:', natts);
        for (let i = 0; i < natts; i++) {
          const ai = gl.getActiveAttrib(program, i);
          const loc = gl.getAttribLocation(program, ai.name);
          const enabled = gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_ENABLED);
          console.error(`    - ${ai.name} (loc ${loc}) enabled=${enabled}`);
        }
      }
    } catch (e) {
      console.error('  - Failed to query draw state:', e && e.message);
    }
  }

  // Lightweight diagnostics for INVALID_OPERATION (1282)
  _diagnoseInvalidOperation(operation) {
    const gl = this.gl;
    console.error(`[GL_DIAG] INVALID_OPERATION during ${operation}`);
    try {
      console.error('  - UNPACK_ALIGNMENT:', gl.getParameter(gl.UNPACK_ALIGNMENT));
      console.error('  - UNPACK_FLIP_Y_WEBGL:', gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL));
      console.error('  - ARRAY_BUFFER_BINDING:', gl.getParameter(gl.ARRAY_BUFFER_BINDING));
      console.error('  - ELEMENT_ARRAY_BUFFER_BINDING:', gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING));
      console.error('  - VERTEX_ARRAY_BINDING:', gl.getParameter(gl.VERTEX_ARRAY_BINDING));
    } catch (e) {
      console.error('  - Failed to read some GL state:', e && e.message);
    }
  }

  // Validate expected params for texSubImage3D -> we do not rely on non-standard queries.
  validateTextureArrayOperation({ width, height, layer, expectedWidth, expectedHeight, layersCount }) {
    const gl = this.gl;
    console.log(`[GL_VALIDATE] texSubImage3D params: ${width}x${height}, layer=${layer} (expected array ${expectedWidth}x${expectedHeight}, layers=${layersCount})`);

    if (typeof layer !== 'number' || layer < 0) {
      console.error('[GL_VALIDATE] Invalid layer index:', layer);
      return { ok: false, reason: 'invalid-layer' };
    }
    if (typeof width !== 'number' || typeof height !== 'number') {
      console.error('[GL_VALIDATE] Invalid width/height:', width, height);
      return { ok: false, reason: 'invalid-size' };
    }
    if (expectedWidth && expectedHeight) {
      if (width > expectedWidth || height > expectedHeight) {
        console.error(`[GL_VALIDATE] Upload (${width}x${height}) > texture (${expectedWidth}x${expectedHeight})`);
        return { ok: false, reason: 'upload-bigger-than-texture' };
      }
    }
    if (typeof layersCount === 'number' && layer >= layersCount) {
      console.error(`[GL_VALIDATE] Layer ${layer} out of range (layers=${layersCount})`);
      return { ok: false, reason: 'layer-out-of-range' };
    }
    return { ok: true };
  }

  validateDrawArraysOperation(mode, first, count) {
    const gl = this.gl;
    console.log(`[GL_VALIDATE] drawArrays: mode=${mode}, first=${first}, count=${count}`);
    if (count < 0 || first < 0) {
      return { ok: false, reason: 'negative-first-or-count' };
    }
    try {
      const vao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
      const program = gl.getParameter(gl.CURRENT_PROGRAM);
      if (!vao) {
        return { ok: false, reason: 'no-vao' };
      }
      if (!program) {
        return { ok: false, reason: 'no-program' };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: 'exception-querying-state', error: e };
    }
  }
}


// Decorators: attach enhanced logging to FrameBuffer and WebGLRenderer

export function addFrameBufferDiagnostics(frameBuffer, opts = {}) {
  const diag = new WebGLDiagnostics(frameBuffer.gl, opts);

  // Wrap uploadVideoFrame to validate before and check after
  const origUpload = frameBuffer.uploadVideoFrame && frameBuffer.uploadVideoFrame.bind(frameBuffer);
  if (!origUpload) return;

  frameBuffer.uploadVideoFrame = async function(video, uploadOpts = {}) {
    console.log('[FB_DIAG] uploadVideoFrame START', { writeIndex: this.writeIndex, bufferSize: this.bufferSize, frameCount: this.frameCount });

    const srcW = (video && video.videoWidth) || this.width || uploadOpts.width || 0;
    const srcH = (video && video.videoHeight) || this.height || uploadOpts.height || 0;
    const layers = this.bufferSize;

    // Validate with known FrameBuffer state (prefer stored sizes)
    const expectedW = this.width || srcW;
    const expectedH = this.height || srcH;

    const pre = diag.validateTextureArrayOperation({
      width: srcW,
      height: srcH,
      layer: this.writeIndex,
      expectedWidth: expectedW,
      expectedHeight: expectedH,
      layersCount: layers
    });

    if (!pre.ok) {
      console.error('[FB_DIAG] validation failed before upload:', pre.reason, { srcW, srcH, expectedW, expectedH, layer: this.writeIndex, layers });
      // still call original in case it succeeds (changeable policy) — but we recommend skipping
      // return false;
    }

    let result = null;
    try {
      result = await origUpload(video, uploadOpts);
    } catch (err) {
      console.error('[FB_DIAG] underlying uploadVideoFrame threw:', err);
      diag.checkError('uploadVideoFrame/texSubImage3D', `layer=${this.writeIndex}, size=${srcW}x${srcH}`);
      throw err;
    }

    // Check GL error after upload
    const errObj = diag.checkError('uploadVideoFrame/texSubImage3D', `layer=${this.writeIndex}, size=${srcW}x${srcH}`);
    if (errObj) {
      console.error('[FB_DIAG] upload produced GL error:', errObj);
    } else {
      console.log('[FB_DIAG] upload completed OK for layer', this.writeIndex);
    }

    return result;
  };
}


// Decorate WebGLRenderer.renderComposite and gl.drawArrays to get richer diagnostics
export function addWebGLRendererDiagnostics(renderer, opts = {}) {
  const diag = new WebGLDiagnostics(renderer.gl, opts);

  // Wrap renderComposite
  if (renderer.renderComposite) {
    const orig = renderer.renderComposite.bind(renderer);
    renderer.renderComposite = function(frameBufferData = {}, uniforms = {}) {
      try {
        const { arrayTexture, layerIndices } = frameBufferData || {};
        console.log('[GL_DIAG] renderComposite START', {
          hasArrayTexture: !!arrayTexture,
          layerIndicesPreview: Array.isArray(layerIndices) ? layerIndices.slice(0,8) : layerIndices,
          layerIndicesLen: Array.isArray(layerIndices) ? layerIndices.length : 0,
          currentBufferSize: renderer.currentBufferSize
        });

        // Basic quick checks
        if (!arrayTexture) {
          console.warn('[GL_DIAG] renderComposite: no arrayTexture provided');
        }
        if (!Array.isArray(layerIndices)) {
          console.warn('[GL_DIAG] renderComposite: layerIndices is not an array');
        } else {
          const bad = layerIndices.filter(i => typeof i !== 'number' || !Number.isFinite(i) || i < 0 || i >= renderer.currentBufferSize);
          if (bad.length) {
            console.warn('[GL_DIAG] renderComposite: layerIndices include out-of-range/invalid values', bad.slice(0,8));
          }
        }
      } catch (e) {
        console.error('[GL_DIAG] pre-renderComposite diagnostics failed:', e && e.message);
      }

      // Call original
      const res = orig(frameBufferData, uniforms);

      // Post-check
      diag.checkError('renderComposite/drawArrays', `layerCount=${Array.isArray(frameBufferData?.layerIndices) ? frameBufferData.layerIndices.length : 'unknown'}`);

      return res;
    };
  }

  // Wrap drawArrays to validate draw state
  const gl = renderer.gl;
  if (gl && gl.drawArrays) {
    const origDrawArrays = gl.drawArrays.bind(gl);
    gl.drawArrays = function(mode, first, count) {
      const check = diag.validateDrawArraysOperation(mode, first, count);
      if (!check.ok) {
        console.error('[GL_DIAG] drawArrays validation failed:', check.reason);
        // Do not call original or call anyway depending on policy.
        // Return undefined so caller will likely get no-op (safer).
        return;
      }
      const r = origDrawArrays(mode, first, count);
      diag.checkError('drawArrays', `mode=${mode}, first=${first}, count=${count}`);
      return r;
    };
  }
}
