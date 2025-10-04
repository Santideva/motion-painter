// src/core/FrameBuffer.js
import { CONFIG, getSpiralBufferIndices } from '../utils/MathUtils.js';

export class FrameBuffer {
  constructor(gl, initialSize = CONFIG.DEFAULT_BUFFER_SIZE) {
    this.gl = gl;
    // Enforce application hardware limit
    this.bufferSize = Math.max(CONFIG.MIN_BUFFER_SIZE, Math.min(CONFIG.MAX_BUFFER_SIZE, initialSize));

    // TEXTURE_2D_ARRAY approach
    this.frameArrayTexture = null;  // Single TEXTURE_2D_ARRAY for all frames
    this.framebuffers = [];         // Individual FBOs for each layer (for rendering)

    this.writeIndex = 0;
    this.width = 0;
    this.height = 0;
    this.frameCount = 0;
    this.readTextures = null; // Cached read-ordered array of layer indices
    this.onEvict = null; // callback(ImageBitmap or null, meta)

    // Spiral buffer configuration
    this.useSpiralRetention = true;
    this.spiralIndices = null;

    // Eviction readback config
    this.evictReadMaxSide = 256;

    // Hardware validation
    this.validateHardwareLimits();
  }

  validateHardwareLimits() {
    const gl = this.gl;
    let maxTextureUnits = 0;
    try {
      maxTextureUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
    } catch (e) {
      console.warn('FrameBuffer: unable to query MAX_TEXTURE_IMAGE_UNITS', e);
    }

    // With TEXTURE_2D_ARRAY we expect 1 unit for the array + extras for calibration
    const minimumRequired = 4;
    if (maxTextureUnits && maxTextureUnits < minimumRequired) {
      console.warn(`Hardware supports only ${maxTextureUnits} texture units, minimum recommended is ${minimumRequired}.`);
    }

    if (this.bufferSize > CONFIG.MAX_BUFFER_SIZE) {
      console.warn(`Buffer size ${this.bufferSize} exceeds application limit ${CONFIG.MAX_BUFFER_SIZE}. Clamping.`);
      this.bufferSize = CONFIG.MAX_BUFFER_SIZE;
    }
  }

  createArrayTexture(width, height, layers) {
    const gl = this.gl;

    if (!gl.TEXTURE_2D_ARRAY) {
      throw new Error('TEXTURE_2D_ARRAY not supported - WebGL2 required');
    }

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);

    // Allocate storage for the whole array texture
    gl.texImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      gl.RGBA,
      width,
      height,
      layers,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null
    );

    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Unbind
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);

    console.log(`[FB] createArrayTexture: created TEXTURE_2D_ARRAY ${width}x${height} layers=${layers}`);
    return texture;
  }

  setBufferSize(newSize) {
    const clampedSize = Math.max(CONFIG.MIN_BUFFER_SIZE, Math.min(CONFIG.MAX_BUFFER_SIZE, newSize));

    if (clampedSize === this.bufferSize) return;

    if (clampedSize !== newSize) {
      console.warn(`Requested buffer size ${newSize} clamped to ${clampedSize} due to application limits.`);
    }

    const wasInitialized = this.width > 0 && this.height > 0;
    this.bufferSize = clampedSize;
    this.spiralIndices = null;
    this.readTextures = null;

    if (wasInitialized) {
      // Recreate array texture with new layer count
      this.resize(this.width, this.height);
    }
  }

  setSpiralRetention(enabled) {
    this.useSpiralRetention = enabled;
    this.spiralIndices = null;
    this.readTextures = null;
  }

  resize(width, height, preserveTextures = null) {
    // If no change and not requested to preserve, skip
    if (this.width === width && this.height === height && !preserveTextures) {
      return;
    }

    this.width = width;
    this.height = height;

    const gl = this.gl;

    // Clean up old resources
    if (this.frameArrayTexture) {
      try { gl.deleteTexture(this.frameArrayTexture); } catch (e) {}
      this.frameArrayTexture = null;
    }

    this.framebuffers.forEach(fb => {
      if (fb) {
        try { gl.deleteFramebuffer(fb); } catch (e) {}
      }
    });
    this.framebuffers = [];

    // Create new array texture
    try {
      this.frameArrayTexture = this.createArrayTexture(width, height, this.bufferSize);
    } catch (err) {
      console.error('FrameBuffer.resize: failed to create array texture', err);
      this.frameArrayTexture = null;
      return;
    }

    // Create framebuffer per layer
    for (let i = 0; i < this.bufferSize; i++) {
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);

      gl.framebufferTextureLayer(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        this.frameArrayTexture,
        0,
        i
      );

      // Optional: check status
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        console.error('Framebuffer not complete for layer', i, 'status:', status);
      }

      this.framebuffers.push(framebuffer);
    }

    // Restore default framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.spiralIndices = null;
    this.readTextures = null;

    console.log(`[FB] resize: created ${this.bufferSize} framebuffers for array texture`);
  }

    // FrameBuffer.js Upload the current video frame into the array texture at `this.writeIndex`.
    //  Returns true on success, false on failure.
    //  Callers must `await` it and only advance
    // writeIndex / rotate buffers after it resolves successfully.
    async uploadVideoFrame(video, opts = {}) {
    const gl = this.gl;
    const allowBitmapFallback = opts.allowBitmapFallback !== false; // default true

    if (!video) return false;
    if (video.readyState < 2) {
      console.warn('[FB] uploadVideoFrame: video not ready, skipping');
      return false;
    }

    // Source dimensions (video native)
    const srcW = video.videoWidth || CONFIG.DEFAULT_RESOLUTION.width;
    const srcH = video.videoHeight || CONFIG.DEFAULT_RESOLUTION.height;

    // If we don't have an array texture or size changed, recreate it at video native size.
    // NOTE: recreating will lose prior frames in the buffer.
    if (!this.frameArrayTexture || this.width !== srcW || this.height !== srcH) {
      console.log(`[FB] uploadVideoFrame: creating/resizing array texture to ${srcW}x${srcH} (was ${this.width}x${this.height})`);
      try {
        // This will allocate a new texture and FBOs for each layer.
        this.resize(srcW, srcH);
      } catch (err) {
        console.error('[FB] uploadVideoFrame: resize failed', err);
        return false;
      }
    }

    // Update remembered dims
    this.width = srcW;
    this.height = srcH;

    // Bind and set pixel store state
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.frameArrayTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    let success = false;

    try {
      // Try direct upload from the HTMLVideoElement — simplest & fastest when supported.
      gl.texSubImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        0,
        0,
        this.writeIndex,
        srcW,
        srcH,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        video
      );

      const err = gl.getError();
      if (err === gl.NO_ERROR) {
        success = true;
        console.log(`[FB] uploadVideoFrame: texSubImage3D(video) ok -> layer ${this.writeIndex} ${srcW}x${srcH}`);
      } else {
        console.warn('[FB] uploadVideoFrame: texSubImage3D(video) reported gl.getError() =', err);
        success = false;
      }
    } catch (ex) {
      // Some browsers will throw when passing HTMLVideoElement into texSubImage3D for TEXTURE_2D_ARRAY.
      console.warn('[FB] uploadVideoFrame: direct texSubImage3D(video) threw, will try bitmap fallback. err=', ex);
      success = false;
    }

    // Fallback: createImageBitmap then upload (slower but widely compatible)
    if (!success && allowBitmapFallback) {
      try {
        // createImageBitmap can accept a video and is usually supported; this is async.
        // Optionally we could use {imageOrientation: 'none'|'flipY'} — keep default and we already used UNPACK_FLIP_Y_WEBGL.
        const bmp = await createImageBitmap(video);
        try {
          gl.texSubImage3D(
            gl.TEXTURE_2D_ARRAY,
            0,
            0,
            0,
            this.writeIndex,
            srcW,
            srcH,
            1,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            bmp
          );
          const err2 = gl.getError();
          if (err2 === gl.NO_ERROR) {
            success = true;
            console.log(`[FB] uploadVideoFrame: texSubImage3D(bitmap) ok -> layer ${this.writeIndex} ${srcW}x${srcH}`);
          } else {
            console.error('[FB] uploadVideoFrame: texSubImage3D(bitmap) gl.getError() =', err2);
            success = false;
          }
        } finally {
          // close ImageBitmap if supported to free resources
          try { bmp.close && bmp.close(); } catch (e) {}
        }
      } catch (bmpErr) {
        console.error('[FB] uploadVideoFrame: createImageBitmap fallback failed', bmpErr);
        success = false;
      }
    }

    // Restore pixel store and unbind
    try {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    } catch (e) {}
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);

    if (success) {
      // Update bookkeeping but do NOT advance writeIndex here.
      // Caller should advance write index atomically after upload returns.
      this.frameCount = Math.max(this.frameCount + 1, 1);
      this.readTextures = null;
      console.log('[FB] uploadVideoFrame: uploaded to layer', this.writeIndex, 'frameCount=', this.frameCount);
      return true;
    } else {
      console.warn('[FB] uploadVideoFrame: failed to upload frame to layer', this.writeIndex);
      return false;
    }
  }

  getSpiralIndices() {
    if (!this.spiralIndices) {
      this.spiralIndices = getSpiralBufferIndices(this.bufferSize);
      console.log('[FB] getSpiralIndices:', this.spiralIndices);
    }
    return this.spiralIndices;
  }

  rotateBuffers() {
    if (this.useSpiralRetention) {
      this._buildSpiralReadView();
    } else {
      this._buildLinearReadView();
    }
  }

  _buildLinearReadView() {
    const ordered = [];
    if (this.bufferSize === 0) {
      this.readTextures = ordered;
      console.log('[FB] rotateBuffers (linear): readTextures =', this.readTextures);
      return;
    }

    const newestIdx = (this.writeIndex - 1 + this.bufferSize) % this.bufferSize;
    for (let i = 0; i < this.bufferSize; i++) {
      const idx = (newestIdx - i + this.bufferSize) % this.bufferSize;
      ordered.push(idx);
    }
    this.readTextures = ordered;

    console.log('[FB] rotateBuffers (linear): readTextures =', this.readTextures);
  }

  // FrameBuffer.js — replace your spiral builder with this robust version
_buildSpiralReadView() {
  const spiralIndices = this.getSpiralIndices() || [];
  const ordered = [];
  const used = new Set();

  const bufSize = this.bufferSize;
  const newestFrameNumber = Math.max(0, this.frameCount - 1);

  // Helper to push an index if valid and not used
  const tryPush = (idx) => {
    if (!Number.isFinite(idx)) return false;
    const clamped = Math.max(0, Math.min(Math.floor(idx), bufSize - 1));
    if (!used.has(clamped)) {
      used.add(clamped);
      ordered.push(clamped);
      return true;
    }
    return false;
  };

  // 1) Try to satisfy spiralIndices entries (prefer them)
  for (let i = 0; i < bufSize; i++) {
    const lookback = (i < spiralIndices.length && Number.isFinite(spiralIndices[i])) ? spiralIndices[i] : null;
    if (lookback !== null) {
      const targetFrame = newestFrameNumber - lookback;
      if (targetFrame >= 0) {
        const bufferIndex = ((targetFrame % bufSize) + bufSize) % bufSize;
        tryPush(bufferIndex);
      }
    }
  }

  // 2) Fill remaining slots with newest-first monotonic fallback
  for (let k = 0; ordered.length < bufSize && k < bufSize; k++) {
    const lookback = k; // 0 = newest, 1 = previous, ...
    const targetFrame = newestFrameNumber - lookback;
    if (targetFrame >= 0) {
      const bufferIndex = ((targetFrame % bufSize) + bufSize) % bufSize;
      tryPush(bufferIndex);
    }
  }

  // 3) As a last resort, fill any still-empty slots with safe sequential indices
  for (let i = 0; ordered.length < bufSize; i++) {
    const candidate = i % bufSize;
    tryPush(candidate);
  }

  this.readTextures = ordered;
  console.log('[FB] rotateBuffers (spiral): readTextures =', this.readTextures);
}


// Read a layer to ImageBitmap (downsample if necessary)
async _readTextureToImageBitmap(layerIndex, srcWidth, srcHeight) {
  const gl = this.gl;

  if (!this.frameArrayTexture || layerIndex < 0 || layerIndex >= this.bufferSize) {
    return null;
  }

  // Save state
  const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  const prevViewport = gl.getParameter(gl.VIEWPORT); // returns Int32Array in many browsers

  const maxSide = this.evictReadMaxSide || 256;
  let readW = srcWidth;
  let readH = srcHeight;

  if (Math.max(srcWidth, srcHeight) > maxSide) {
    const scale = maxSide / Math.max(srcWidth, srcHeight);
    readW = Math.max(1, Math.floor(srcWidth * scale));
    readH = Math.max(1, Math.floor(srcHeight * scale));
  }

  try {
    const targetFb = this.framebuffers[layerIndex];
    if (!targetFb) {
      console.warn(`No framebuffer available for layer ${layerIndex}`);
      return null;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFb);

    // Read at the requested (possibly downsampled) resolution
    gl.viewport(0, 0, readW, readH);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      console.warn('FrameBuffer._readTextureToImageBitmap: framebuffer incomplete', status);
      // restore framebuffer & viewport
      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
        if (prevViewport && prevViewport.length === 4) {
          gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
        }
      } catch (e) { /* best-effort restore; ignore */ }
      return null;
    }

    const pixels = new Uint8Array(readW * readH * 4);
    gl.readPixels(0, 0, readW, readH, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    // Restore framebuffer and viewport
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
      if (prevViewport && prevViewport.length === 4) {
        gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
      }
    } catch (e) { /* best-effort restore; ignore */ }

    // Convert to ImageBitmap
    const clamped = new Uint8ClampedArray(pixels.buffer);
    const imageData = new ImageData(clamped, readW, readH);
    return await createImageBitmap(imageData);

  } catch (err) {
    // Attempt to restore state on error, then rethrow
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
      if (prevViewport && prevViewport.length === 4) {
        gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
      }
    } catch (e) { /* swallow restore errors */ }
    console.warn('FrameBuffer._readTextureToImageBitmap failed', err);
    throw err;
  }
}

  advanceWriteIndex() {
    const evictedIndex = this.writeIndex;

    console.log(`[FB] advanceWriteIndex: evicting layer = ${evictedIndex}`);

    // Eviction: read back the layer being overwritten
    if (this.onEvict && this.frameArrayTexture) {
      try {
        const srcWidth = this.width || CONFIG.DEFAULT_RESOLUTION.width;
        const srcHeight = this.height || CONFIG.DEFAULT_RESOLUTION.height;

        console.log(`[FB] advanceWriteIndex: scheduling eviction readback for layer ${evictedIndex}`);
        this._readTextureToImageBitmap(evictedIndex, srcWidth, srcHeight)
          .then(imageBitmap => {
            if (!imageBitmap) {
              console.warn('evict: readback produced no bitmap', evictedIndex);
              return;
            }
            const meta = {
              index: evictedIndex,
              frameNumber: this.frameCount,
              timestamp: Date.now(),
              readW: imageBitmap.width,
              readH: imageBitmap.height
            };
            try {
              this.onEvict(imageBitmap, meta);
            } catch (err) {
              console.error('evict: handler threw', err);
              try { imageBitmap.close(); } catch (e) {}
            }
          })
          .catch(err => {
            console.warn('evict: readback failed', { index: evictedIndex, err });
          });
      } catch (err) {
        console.warn('Eviction callback scheduling error:', err);
      }
    }

    this.writeIndex = (this.writeIndex + 1) % this.bufferSize;
    this.readTextures = null;

    console.log(`[FB] advanceWriteIndex: new writeIndex = ${this.writeIndex}`);
  }

  /**
   * getTextures()
   * Returns an **array** (newest-first) of descriptors:
   *   [{ arrayTexture, layerIndex }, ...]
   *
   * Internally uses this.readTextures (indices only).
   */
  getTextures() {
    const arrayTexture = this.frameArrayTexture;

    let layerIndices = Array.isArray(this.readTextures) ? this.readTextures : null;
    if (!layerIndices || layerIndices.length !== this.bufferSize) {
      this.rotateBuffers(); // rebuilds indices into this.readTextures
      layerIndices = this.readTextures || [];
      console.log('[FB] getTextures: rebuilt readTextures =', layerIndices);
    }

    const descriptors = layerIndices.map(idx => ({ arrayTexture, layerIndex: idx }));
    // Lightweight trace: only print first few indices to avoid spamming
    console.log('[FB] getTextures: descriptors (first 8) =', descriptors.slice(0, 8));
    return descriptors;
  }

  getCurrentTexture() {
    const textures = this.getTextures();
    return textures[0] || { arrayTexture: this.frameArrayTexture, layerIndex: 0 };
  }

  getPreviousTexture(offset = 1) {
    const textures = this.getTextures();
    const index = Math.min(Math.max(0, offset), Math.max(0, textures.length - 1));
    return textures[index] || { arrayTexture: this.frameArrayTexture, layerIndex: 0 };
  }

  initializeWithFrame(video) {
    const srcW = video.videoWidth || CONFIG.DEFAULT_RESOLUTION.width;
    const srcH = video.videoHeight || CONFIG.DEFAULT_RESOLUTION.height;

    console.log(`[FB] initializeWithFrame: filling layers 0..${this.bufferSize - 1} with first frame (${srcW}x${srcH})`);

    this.width = srcW;
    this.height = srcH;

    if (!this.frameArrayTexture) {
      this.resize(srcW, srcH);
    }

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.frameArrayTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    try {
      for (let i = 0; i < this.bufferSize; i++) {
        gl.texSubImage3D(
          gl.TEXTURE_2D_ARRAY,
          0,
          0,
          0,
          i,
          srcW,
          srcH,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          video
        );
      }
    } catch (err) {
      console.warn('Could not initialize frame buffer array texture', err);
    } finally {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    }

    this.frameCount = this.bufferSize;
    this.readTextures = null;
  }

  getBufferInfo() {
    let maxTextureUnits = 0;
    try {
      maxTextureUnits = this.gl.getParameter(this.gl.MAX_TEXTURE_IMAGE_UNITS);
    } catch (e) {}

    return {
      bufferSize: this.bufferSize,
      maxBufferSize: CONFIG.MAX_BUFFER_SIZE,
      frameCount: this.frameCount,
      useSpiralRetention: this.useSpiralRetention,
      spiralIndices: this.useSpiralRetention ? this.getSpiralIndices() : null,
      dimensions: { width: this.width, height: this.height },
      arrayTextureApproach: true,
      hardwareLimits: {
        maxTextureUnits,
        textureUnitsRequired: 4 // 1 for frame array + 3 for calibration
      }
    };
  }

  destroy() {
    const gl = this.gl;

    if (this.frameArrayTexture) {
      try { gl.deleteTexture(this.frameArrayTexture); } catch (e) {}
      this.frameArrayTexture = null;
    }

    this.framebuffers.forEach(framebuffer => {
      if (framebuffer) {
        try { gl.deleteFramebuffer(framebuffer); } catch (e) {}
      }
    });

    this.framebuffers = [];
    this.spiralIndices = null;
    this.readTextures = null;

    console.log('[FB] destroy: cleaned up frame buffer resources');
  }
}
