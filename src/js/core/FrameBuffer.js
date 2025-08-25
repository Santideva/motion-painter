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
  }
  
  uploadVideoFrame(video) {
    const gl = this.gl;
    const targetTexture = this.textures[this.writeIndex];
    
    gl.bindTexture(gl.TEXTURE_2D, targetTexture);
    
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    } catch (e) {
      // Fallback for browsers that require texSubImage2D
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
    }
    
    this.frameCount++;
  }
  
  getSpiralIndices() {
    if (!this.spiralIndices) {
      this.spiralIndices = getSpiralBufferIndices(this.bufferSize);
    }
    return this.spiralIndices;
  }
  
  rotateBuffers() {
    if (this.useSpiralRetention) {
      this.rotateSpiralBuffers();
    } else {
      this.rotateLinearBuffers();
    }
  }
  
  rotateLinearBuffers() {
    // Original linear rotation logic
    const rotatedTextures = [];
    
    for (let i = 0; i < this.bufferSize; i++) {
      const index = (this.writeIndex + i) % this.bufferSize;
      rotatedTextures.push(this.textures[index]);
    }
    
    this.textures = rotatedTextures;
  }
  
  rotateSpiralBuffers() {
    // Logarithmic retention: recent frames get linear spacing, 
    // older frames get exponentially increasing intervals
    // Optimized for 16 frame limit
    const spiralIndices = this.getSpiralIndices();
    const rotatedTextures = [];
    
    // Start with the most recent frame (writeIndex)
    rotatedTextures.push(this.textures[this.writeIndex]);
    
    // Add remaining frames based on spiral pattern
    for (let i = 1; i < this.bufferSize; i++) {
      const lookbackFrames = spiralIndices[i];
      const targetFrame = this.frameCount - lookbackFrames;
      
      // Map to actual buffer index, handling wraparound
      let bufferIndex;
      if (targetFrame >= 0) {
        bufferIndex = targetFrame % this.bufferSize;
      } else {
        // For very early frames, just use linear fallback
        bufferIndex = (this.writeIndex - i + this.bufferSize) % this.bufferSize;
      }
      
      rotatedTextures.push(this.textures[bufferIndex]);
    }
    
    this.textures = rotatedTextures;
  }
  
  advanceWriteIndex() {
    this.writeIndex = (this.writeIndex + 1) % this.bufferSize;
  }
  
  getTextures() {
    return this.textures;
  }
  
  getCurrentTexture() {
    return this.textures[0]; // After rotation, 0 is always newest
  }
  
  getPreviousTexture(offset = 1) {
    const index = Math.min(offset, this.bufferSize - 1);
    return this.textures[index];
  }
  
  initializeWithFrame(video) {
    // Fill all buffer slots with the same initial frame
    for (let i = 0; i < this.bufferSize; i++) {
      const texture = this.textures[i];
      this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
      
      try {
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, video);
      } catch (e) {
        console.warn('Could not initialize frame buffer texture', i);
      }
    }
    
    this.frameCount = this.bufferSize; // Initialize frame count
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
  }
}