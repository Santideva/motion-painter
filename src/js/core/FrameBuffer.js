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

    // Spiral buffer configuration
    this.useSpiralRetention = true;
    this.spiralIndices = null; // Cached spiral indices for current buffer size

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

    if (!targetTexture) {
      // Defensive: if textures not yet allocated, no-op (resize should have been called)
      console.warn('uploadVideoFrame: texture slot not allocated yet (writeIndex =', this.writeIndex, ')');
      return;
    }

    gl.bindTexture(gl.TEXTURE_2D, targetTexture);

    // Ensure the uploaded video appears upright when sampled with vTexCoord
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    try {
      // Prefer texSubImage2D to avoid reallocating texture storage every frame
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
    } catch (e) {
      // Fallback to texImage2D if texSubImage2D fails (some platforms/browsers)
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      } catch (err) {
        console.error('uploadVideoFrame: texture upload failed', err);
      }
    } finally {
      // Reset global pixel store state to default
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    }

    this.frameCount++;
    // New frame written; invalidate readTextures because newest mapping changed
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

  advanceWriteIndex() {
    this.writeIndex = (this.writeIndex + 1) % this.bufferSize;
    // When writeIndex changes, the read order changes — invalidate cached readTextures
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
