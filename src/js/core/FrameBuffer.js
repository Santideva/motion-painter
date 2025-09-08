// src/core/FrameBuffer.js
import { CONFIG, getSpiralBufferIndices } from '../utils/MathUtils.js';

export class FrameBuffer {
  constructor(gl, initialSize = CONFIG.DEFAULT_BUFFER_SIZE) {
    this.gl = gl;
    // Enforce 16 frame hardware limit
    this.bufferSize = Math.max(CONFIG.MIN_BUFFER_SIZE, Math.min(CONFIG.MAX_BUFFER_SIZE, initialSize));
    this.textures = [];
    this.framebuffers = [];
    this.writeIndex = 0;
    this.width = 0;
    this.height = 0;
    this.frameCount = 0; // Total frames processed
    this.readTextures = null; // Read-ordered view computed by rotateBuffers (do not mutate this.textures)
    this.onEvict = null; // callback(ImageBitmap or null, meta)


    // Spiral buffer configuration
    this.useSpiralRetention = true;
    this.spiralIndices = null; // Cached spiral indices for current buffer size

    // Eviction readback config (max side length for downsampled readback)
    this.evictReadMaxSide = 256; // tune this: lower => cheaper readback

    // Hardware validation
    this.validateHardwareLimits();
  }

  validateHardwareLimits() {
    const maxTextureUnits = this.gl.getParameter(this.gl.MAX_TEXTURE_IMAGE_UNITS);

    if (this.bufferSize > maxTextureUnits) {
      console.warn(`Buffer size ${this.bufferSize} exceeds hardware limit ${maxTextureUnits}. Clamping to ${Math.min(CONFIG.MAX_BUFFER_SIZE, maxTextureUnits)}.`);
      this.bufferSize = Math.min(CONFIG.MAX_BUFFER_SIZE, maxTextureUnits);
    }

    if (this.bufferSize > CONFIG.MAX_BUFFER_SIZE) {
      console.warn(`Buffer size ${this.bufferSize} exceeds application limit ${CONFIG.MAX_BUFFER_SIZE}. Clamping to ${CONFIG.MAX_BUFFER_SIZE}.`);
      this.bufferSize = CONFIG.MAX_BUFFER_SIZE;
    }
  }

  createTexture(width, height) {
    const gl = this.gl;
    const texture = gl.createTexture();

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    return texture;
  }

  setBufferSize(newSize) {
    // Enforce hardware limits
    const clampedSize = Math.max(CONFIG.MIN_BUFFER_SIZE, Math.min(CONFIG.MAX_BUFFER_SIZE, newSize));

    if (clampedSize === this.bufferSize) {
      return; // No change needed
    }

    // Warn if size was clamped
    if (clampedSize !== newSize) {
      console.warn(`Requested buffer size ${newSize} clamped to ${clampedSize} due to hardware/application limits.`);
    }

    const wasInitialized = this.width > 0 && this.height > 0;
    const oldTextures = [...this.textures];

    this.bufferSize = clampedSize;
    this.spiralIndices = null; // Reset cached indices

    if (wasInitialized) {
      // Preserve existing textures where possible and resize
      this.resize(this.width, this.height, oldTextures);
    }
  }

  setSpiralRetention(enabled) {
    this.useSpiralRetention = enabled;
    this.spiralIndices = null; // Reset cached indices
    // Reset read-ordered view so consumers recalc according to new retention policy
    this.readTextures = null;
  }

  resize(width, height, preserveTextures = null) {
    if (this.width === width && this.height === height && !preserveTextures) {
      return; // No change needed
    }

    this.width = width;
    this.height = height;

    const gl = this.gl;
    const oldTextures = preserveTextures || this.textures;
    const oldFramebuffers = this.framebuffers;

    // Clean up excess resources if downsizing
    if (oldTextures.length > this.bufferSize) {
      for (let i = this.bufferSize; i < oldTextures.length; i++) {
        if (oldTextures[i]) gl.deleteTexture(oldTextures[i]);
        if (oldFramebuffers[i]) gl.deleteFramebuffer(oldFramebuffers[i]);
      }
    }

    // Initialize new arrays
    this.textures = [];
    this.framebuffers = [];

    // Create new textures and framebuffers - limited to bufferSize (max 16)
    for (let i = 0; i < this.bufferSize; i++) {
      let texture;

      if (i < oldTextures.length && oldTextures[i]) {
        // Reuse existing texture, update its data
        texture = oldTextures[i];
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      } else {
        // Create new texture
        texture = this.createTexture(width, height);
      }

      this.textures.push(texture);

      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      this.framebuffers.push(framebuffer);

      // Check framebuffer completeness
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        console.error('Framebuffer not complete for texture', i);
      }
    }

    // Clean up remaining old resources that weren't reused
    if (!preserveTextures) {
      oldFramebuffers.forEach(fb => {
        if (fb) gl.deleteFramebuffer(fb);
      });
    }

    // Restore default framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Reset spiral indices cache
    this.spiralIndices = null;
    // Reset read-ordered view cache so subsequent getTextures() recomputes it
    this.readTextures = null;
  }

    uploadVideoFrame(video) {
      const gl = this.gl;
      const targetTexture = this.textures[this.writeIndex];
      if (!targetTexture) return;

      if (video.readyState < 2) {
        console.warn("uploadVideoFrame: video not ready, skipping");
        return;
      }

      gl.bindTexture(gl.TEXTURE_2D, targetTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

      try {
        // Ensure correct allocation
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA,
                      video.videoWidth, video.videoHeight, 0,
                      gl.RGBA, gl.UNSIGNED_BYTE, null);

        // Upload pixels
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0,
                        gl.RGBA, gl.UNSIGNED_BYTE, video);

        console.log("uploadVideoFrame: uploaded", video.videoWidth, "x", video.videoHeight);

      } catch (err) {
        console.error("uploadVideoFrame: upload failed", err);
      } finally {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      }

      this.frameCount++;
      this.readTextures = null;
    }

  getSpiralIndices() {
    if (!this.spiralIndices) {
      this.spiralIndices = getSpiralBufferIndices(this.bufferSize);
    }
    return this.spiralIndices;
  }

  rotateBuffers() {
    // Build a read-ordered view (newest-first) and store in this.readTextures.
    // IMPORTANT: do NOT reorder this.textures array because writeIndex is the
    // canonical ring-buffer mapping. Consumers should call getTextures() to
    // receive the read-ordered textures after rotation.
    if (this.useSpiralRetention) {
      this._buildSpiralReadView();
    } else {
      this._buildLinearReadView();
    }
  }

  _buildLinearReadView() {
    // Newest-first: index 0 -> newest frame
    const ordered = [];
    if (!this.textures || this.textures.length === 0) {
      this.readTextures = ordered;
      return;
    }
    const newestIdx = (this.writeIndex - 1 + this.bufferSize) % this.bufferSize;
    for (let i = 0; i < this.bufferSize; i++) {
      const idx = (newestIdx - i + this.bufferSize) % this.bufferSize;
      ordered.push(this.textures[idx]);
    }
    this.readTextures = ordered;
  }

  _buildSpiralReadView() {
    // Build read-ordered list following spiral indices (lookback offsets).
    const spiralIndices = this.getSpiralIndices();
    const ordered = [];
    if (!this.textures || this.textures.length === 0) {
      this.readTextures = ordered;
      return;
    }
    // newest is writeIndex - 1
    const newestFrameNumber = this.frameCount - 1;
    for (let i = 0; i < this.bufferSize; i++) {
      // spiralIndices[i] is a look-back offset (0 = newest)
      const lookback = spiralIndices[i] !== undefined ? spiralIndices[i] : i;
      let bufferIndex;
      const targetFrame = newestFrameNumber - lookback;
      if (targetFrame >= 0) {
        bufferIndex = ((targetFrame % this.bufferSize) + this.bufferSize) % this.bufferSize;
      } else {
        // If we don't have that many historical frames, fallback to linear recent mapping
        bufferIndex = ((this.writeIndex - 1 - i) + this.bufferSize) % this.bufferSize;
      }
      ordered.push(this.textures[bufferIndex]);
    }
    this.readTextures = ordered;
  }

// -------------------- NEW: eviction readback helper --------------------
// Read a texture slot into an ImageBitmap. Optionally downsamples to this.evictReadMaxSide
async _readTextureToImageBitmap(texture, srcWidth, srcHeight) {
  const gl = this.gl;

  if (!texture) return null;

  // --- SAVE STATE ---
  const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  const prevViewport = gl.getParameter(gl.VIEWPORT);

  // If the source is already small enough, read directly; otherwise downsample via an FBO
  const maxSide = this.evictReadMaxSide || 256;
  let readW = srcWidth;
  let readH = srcHeight;

  if (Math.max(srcWidth, srcHeight) > maxSide) {
    const scale = maxSide / Math.max(srcWidth, srcHeight);
    readW = Math.max(1, Math.floor(srcWidth * scale));
    readH = Math.max(1, Math.floor(srcHeight * scale));
  }

  // Create temporary readback texture & framebuffer
  const tmpTex = this.createTexture(readW, readH);
  const tmpFb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, tmpFb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tmpTex, 0);

  try {
    // If the texture has an associated framebuffer in this.framebuffers array, we can read from it directly.
    let srcFb = null;
    const idx = this.textures.indexOf(texture);
    if (idx >= 0 && this.framebuffers[idx]) srcFb = this.framebuffers[idx];

    if (srcFb && srcWidth === readW && srcHeight === readH) {
      // identical size => read straight from existing framebuffer
      gl.bindFramebuffer(gl.FRAMEBUFFER, srcFb);
    } else {
      // Fallback: render src texture into tmpFb (requires blit helper)
      gl.bindFramebuffer(gl.FRAMEBUFFER, tmpFb);
      gl.viewport(0, 0, readW, readH);
      // TODO: call your renderer.blitTexture(texture, targetFb=tmpFb, targetSize=[readW, readH]);
    }

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      console.warn('FrameBuffer.readback: framebuffer incomplete', status);
    }

    const pixels = new Uint8Array(readW * readH * 4);
    // readPixels reads bottom-left origin — callers should account for flip if needed
    gl.readPixels(0, 0, readW, readH, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    // --- RESTORE STATE ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);

    try { gl.deleteFramebuffer(tmpFb); } catch (e) {}
    try { gl.deleteTexture(tmpTex); } catch (e) {}

    // Convert bytes to ImageBitmap (transferable)
    const clamped = new Uint8ClampedArray(pixels.buffer);
    const imageData = new ImageData(clamped, readW, readH);
    return await createImageBitmap(imageData);
  } catch (err) {
    // --- RESTORE EVEN ON ERROR ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);

    try { gl.deleteFramebuffer(tmpFb); } catch (e) {}
    try { gl.deleteTexture(tmpTex); } catch (e) {}

    console.warn('FrameBuffer._readTextureToImageBitmap failed', err);
    throw err;
  }
}

  // -------------------- UPDATED: advanceWriteIndex triggers async eviction readback --------------------
  advanceWriteIndex() {
    const evictedIndex = this.writeIndex; // about to overwrite this slot

    // Trigger eviction hook: convert old GL texture -> ImageBitmap then call onEvict(imageBitmap, meta)
    if (this.onEvict && this.textures[evictedIndex]) {
      try {
        // console.debug('evict:readback-start', { index: evictedIndex, frameNumber: this.frameCount });
        // Capture reference sizes
        const srcWidth = this.width || CONFIG.DEFAULT_RESOLUTION.width;
        const srcHeight = this.height || CONFIG.DEFAULT_RESOLUTION.height;

        // initiate async readback (do not await here — we don't block main loop).
        this._readTextureToImageBitmap(this.textures[evictedIndex], srcWidth, srcHeight)
          .then(imageBitmap => {
            if (!imageBitmap) {
              console.warn('evict:readback produced no bitmap', evictedIndex);
              return;
            }
            const meta = { index: evictedIndex, frameNumber: this.frameCount, timestamp: Date.now(), readW: imageBitmap.width, readH: imageBitmap.height };
            try {
              // console.debug('evict:forwarding', meta);
              // Ownership of imageBitmap moves to the hook/consumer (transferable). Consumer must close when done.
              this.onEvict(imageBitmap, meta);
            } catch (err) {
              console.error('evict:handler threw', err);
              try { imageBitmap.close(); } catch (e) {}
            }
          })
          .catch(err => {
            console.warn('evict:readback failed', { index: evictedIndex, err });
          });
      } catch (err) {
        console.warn('Eviction callback scheduling error:', err);
      }
    }

    // Advance the write index — this invalidates readTextures cache
    this.writeIndex = (this.writeIndex + 1) % this.bufferSize;
    this.readTextures = null;
  }

  getTextures() {
    // Return read-ordered textures (newest-first). If rotateBuffers()
    // has been called it will populate this.readTextures. Otherwise compute on demand.
    if (Array.isArray(this.readTextures) && this.readTextures.length === this.bufferSize) {
      return this.readTextures;
    }
    // Compute newest-first view on demand without mutating this.textures
    const ordered = [];
    if (!this.textures || this.textures.length === 0) return ordered;
    const newestIdx = (this.writeIndex - 1 + this.bufferSize) % this.bufferSize;
    for (let i = 0; i < this.bufferSize; i++) {
      const idx = (newestIdx - i + this.bufferSize) % this.bufferSize;
      ordered.push(this.textures[idx]);
    }
    return ordered;
  }

  getCurrentTexture() {
    const t = this.getTextures();
    return t[0] || null;
  }

  getPreviousTexture(offset = 1) {
    const t = this.getTextures();
    const index = Math.min(offset, this.bufferSize - 1);
    return t[index] || null;
  }

  initializeWithFrame(video) {
    // Ensure textures allocated
    if (!this.textures || this.textures.length !== this.bufferSize) {
      // Allocate textures/framebuffers for current dimensions (if width/height known)
      this.resize(this.width || CONFIG.DEFAULT_RESOLUTION.width, this.height || CONFIG.DEFAULT_RESOLUTION.height);
    }

    for (let i = 0; i < this.bufferSize; i++) {
      const texture = this.textures[i];
      this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
      // Flip during initialization so textures are upright
      this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, true);
      try {
        // Prefer texSubImage2D if texture storage already allocated
        this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, video);
      } catch (e) {
        try {
          this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, video);
        } catch (err) {
          console.warn('Could not initialize frame buffer texture', i, err);
        }
      } finally {
        this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, false);
      }
    }

    // Set frameCount to at least bufferSize to represent initialized history
    this.frameCount = this.bufferSize;
    // Reset read view so callers will get newest-first view on next access
    this.readTextures = null;
  }

  getBufferInfo() {
    return {
      bufferSize: this.bufferSize,
      maxBufferSize: CONFIG.MAX_BUFFER_SIZE,
      frameCount: this.frameCount,
      useSpiralRetention: this.useSpiralRetention,
      spiralIndices: this.useSpiralRetention ? this.getSpiralIndices() : null,
      dimensions: { width: this.width, height: this.height },
      hardwareLimits: {
        maxTextureUnits: this.gl.getParameter(this.gl.MAX_TEXTURE_IMAGE_UNITS),
        isHardwareLimited: this.bufferSize === CONFIG.MAX_BUFFER_SIZE
      }
    };
  }

  destroy() {
    const gl = this.gl;

    // Clean up textures
    this.textures.forEach(texture => {
      if (texture) gl.deleteTexture(texture);
    });

    // Clean up framebuffers
    this.framebuffers.forEach(framebuffer => {
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
    });

    this.textures = [];
    this.framebuffers = [];
    this.spiralIndices = null;
    this.readTextures = null;
  }
}