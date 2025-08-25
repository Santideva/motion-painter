import { CONFIG, validateBufferSize } from '../utils/MathUtils.js';

export class CompositeRenderer {
  constructor(webglRenderer, frameBuffer, motionDetector) {
    this.webglRenderer = webglRenderer;
    this.frameBuffer = frameBuffer;
    this.motionDetector = motionDetector;
    
    // Default render parameters - validated against 16 frame limit
    this.params = {
      bufferSize: Math.min(this.frameBuffer.bufferSize, CONFIG.MAX_BUFFER_SIZE),
      spiralRetention: true,
      timeShift: 1,
      opacity: 0.6,
      invert: true,
      rOff: 1,
      gOff: 2,
      bOff: 3,
      motionThresh: 0.08,
      glow: 0.9
    };
    
    this.showMotionMask = false;
    
    // Validate initial parameters
    this.validateAndClampParameters();
  }
  
  /**
   * Validate and clamp all temporal parameters to current buffer size
   */
  validateAndClampParameters() {
    const bufferSize = this.frameBuffer.bufferSize;
    const maxOffset = Math.max(0, bufferSize - 1);
    
    // Clamp time-based parameters
    this.params.timeShift = Math.min(this.params.timeShift, maxOffset);
    this.params.rOff = Math.min(this.params.rOff, maxOffset);
    this.params.gOff = Math.min(this.params.gOff, maxOffset);
    this.params.bOff = Math.min(this.params.bOff, maxOffset);
    
    // Ensure buffer size doesn't exceed hardware limits
    this.params.bufferSize = Math.min(this.params.bufferSize, CONFIG.MAX_BUFFER_SIZE);
  }
  
  updateParams(newParams) {
    const oldBufferSize = this.params.bufferSize;
    this.params = { ...this.params, ...newParams };
    
    // Handle buffer size changes with validation
    if (newParams.bufferSize && newParams.bufferSize !== oldBufferSize) {
      const validation = validateBufferSize(newParams.bufferSize);
      const clampedSize = validation.clampedSize;
      
      // Warn if size was clamped
      if (validation.warning) {
        console.warn('Buffer size validation:', validation.warning);
      }
      
      this.params.bufferSize = clampedSize;
      this.frameBuffer.setBufferSize(clampedSize);
      this.webglRenderer.updateBufferSize(clampedSize);
    }
    
    // Handle spiral retention toggle
    if (newParams.spiralRetention !== undefined) {
      this.frameBuffer.setSpiralRetention(newParams.spiralRetention);
    }
    
    // Validate and clamp all temporal parameters after any update
    this.validateAndClampParameters();
  }
  
  setShowMotionMask(show) {
    this.showMotionMask = show;
  }
  
  render() {
    const frameTextures = this.frameBuffer.getTextures();
    
    // Ensure we don't exceed hardware limits
    const effectiveTextures = frameTextures.slice(0, CONFIG.MAX_BUFFER_SIZE);
    
    if (this.showMotionMask) {
      this.renderMotionDebug(effectiveTextures);
    } else {
      this.renderComposite(effectiveTextures);
    }
  }
  
  renderComposite(frameTextures) {
    // Ensure WebGL renderer is aware of current buffer size
    const effectiveSize = Math.min(frameTextures.length, CONFIG.MAX_BUFFER_SIZE);
    this.webglRenderer.updateBufferSize(effectiveSize);
    
    // Validate parameters one more time before rendering
    const validatedParams = this.getValidatedParams(effectiveSize);
    
    this.webglRenderer.renderComposite(frameTextures, validatedParams);
  }
  
  renderMotionDebug(frameTextures) {
    const currentTexture = frameTextures[0];
    const previousTexture = frameTextures[1] || currentTexture; // Fallback if only one frame
    
    this.webglRenderer.renderMotionMask(
      currentTexture, 
      previousTexture, 
      this.params.motionThresh
    );
  }
  
  /**
   * Get parameters validated against current effective buffer size
   */
  getValidatedParams(effectiveBufferSize) {
    const maxOffset = Math.max(0, effectiveBufferSize - 1);
    
    return {
      ...this.params,
      bufferSize: effectiveBufferSize,
      timeShift: Math.min(this.params.timeShift, maxOffset),
      rOff: Math.min(this.params.rOff, maxOffset),
      gOff: Math.min(this.params.gOff, maxOffset),
      bOff: Math.min(this.params.bOff, maxOffset)
    };
  }
  
  /**
   * Process a new video frame with enhanced error handling
   * @param {HTMLVideoElement} video - Video source
   */
  processFrame(video) {
    try {
      // Upload current frame to buffer
      this.frameBuffer.uploadVideoFrame(video);
      
      // Rotate buffers using current retention policy
      this.frameBuffer.rotateBuffers();
      
      // Advance write index for next frame
      this.frameBuffer.advanceWriteIndex();
      
      // Render the composite
      this.render();
      
    } catch (error) {
      console.error('Error processing frame:', error);
      throw error; // Re-throw to allow caller to handle
    }
  }
  
  initializeBuffer(video) {
    try {
      // Initialize all buffer slots with the first frame
      this.frameBuffer.initializeWithFrame(video);
    } catch (error) {
      console.error('Error initializing buffer:', error);
      throw error;
    }
  }
  
  /**
   * Get current render statistics with hardware limitation info
   * @returns {Object} Render stats
   */
  getStats() {
    const bufferInfo = this.frameBuffer.getBufferInfo();
    const rendererCaps = this.webglRenderer.getCapabilities();
    
    return {
      bufferInfo,
      rendererCaps,
      currentParams: { ...this.params },
      validatedParams: this.getValidatedParams(bufferInfo.bufferSize),
      showMotionMask: this.showMotionMask,
      dimensions: {
        width: this.frameBuffer.width,
        height: this.frameBuffer.height
      },
      hardwareLimitations: {
        maxBufferSize: CONFIG.MAX_BUFFER_SIZE,
        isLimited: bufferInfo.bufferSize === CONFIG.MAX_BUFFER_SIZE,
        actualTextureUnits: rendererCaps.maxTextureUnits
      }
    };
  }
  
  /**
   * Export current frame as image data (for screenshots, etc.)
   * @returns {ImageData} Current frame data
   */
  exportFrame() {
    const gl = this.webglRenderer.gl;
    const { width, height } = this.frameBuffer;
    
    if (width === 0 || height === 0) {
      throw new Error('Frame buffer not initialized');
    }
    
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    
    return new ImageData(new Uint8ClampedArray(pixels), width, height);
  }
  
  /**
   * Get buffer configuration details for debugging
   * @returns {Object} Detailed buffer information
   */
  getBufferConfiguration() {
    const bufferInfo = this.frameBuffer.getBufferInfo();
    const stats = this.getStats();
    const hardwareCaps = this.webglRenderer.getCapabilities();
    
    return {
      ...bufferInfo,
      hardwareConstraints: {
        maxTextureUnits: hardwareCaps.maxTextureUnits,
        applicationLimit: CONFIG.MAX_BUFFER_SIZE,
        effectiveLimit: Math.min(hardwareCaps.maxTextureUnits, CONFIG.MAX_BUFFER_SIZE)
      },
      retentionPattern: bufferInfo.spiralIndices || 'linear',
      memoryUsage: this.calculateMemoryUsage(),
      effectiveTemporalRange: this.calculateTemporalRange(bufferInfo),
      parameterConstraints: this.getParameterConstraints(bufferInfo.bufferSize)
    };
  }
  
  /**
   * Calculate memory usage for current configuration
   */
  calculateMemoryUsage() {
    const { width, height } = this.frameBuffer;
    const bufferSize = this.frameBuffer.bufferSize;
    
    if (width === 0 || height === 0) {
      return { error: 'Buffer not initialized' };
    }
    
    const bytesPerPixel = 4; // RGBA
    const bytesPerFrame = width * height * bytesPerPixel;
    const totalBytes = bytesPerFrame * bufferSize;
    
    return {
      dimensions: { width, height },
      bufferSize,
      bytesPerFrame,
      totalBytes,
      totalMB: Math.round(totalBytes / (1024 * 1024) * 100) / 100,
      efficiency: bufferSize / CONFIG.MAX_BUFFER_SIZE,
      category: totalBytes > 50 * 1024 * 1024 ? 'high' : 
               totalBytes > 25 * 1024 * 1024 ? 'medium' : 'low'
    };
  }
  
  /**
   * Get parameter constraints for current buffer size
   */
  getParameterConstraints(bufferSize) {
    const maxOffset = Math.max(0, bufferSize - 1);
    
    return {
      timeShift: { min: 0, max: maxOffset },
      rOff: { min: 0, max: maxOffset },
      gOff: { min: 0, max: maxOffset },
      bOff: { min: 0, max: maxOffset },
      bufferSize: { min: CONFIG.MIN_BUFFER_SIZE, max: CONFIG.MAX_BUFFER_SIZE }
    };
  }
  
  /**
   * Calculate the effective temporal range based on current buffer configuration
   * @private
   */
  calculateTemporalRange(bufferInfo) {
    if (!bufferInfo.spiralIndices) {
      return {
        type: 'linear',
        maxFramesBack: bufferInfo.bufferSize - 1,
        temporalResolution: 'uniform',
        hardwareLimited: bufferInfo.bufferSize === CONFIG.MAX_BUFFER_SIZE
      };
    }
    
    const indices = bufferInfo.spiralIndices;
    const maxFrameback = Math.max(...indices);
    const recentFrames = indices.filter(i => i <= 4).length;
    const olderFrames = indices.length - recentFrames;
    
    return {
      type: 'spiral',
      maxFramesBack: maxFrameback,
      recentFrames,
      olderFrames,
      temporalResolution: 'logarithmic',
      hardwareLimited: bufferInfo.bufferSize === CONFIG.MAX_BUFFER_SIZE,
      indices: indices.slice(0, CONFIG.MAX_BUFFER_SIZE) // Ensure we don't exceed limits
    };
  }
  
  /**
   * Optimize buffer size based on current usage patterns and hardware
   * @returns {Object} Optimization suggestions
   */
  getOptimizationSuggestions() {
    const stats = this.getStats();
    const currentSize = stats.bufferInfo.bufferSize;
    const maxTextureUnits = stats.rendererCaps.maxTextureUnits;
    const memoryUsage = this.calculateMemoryUsage();
    
    const suggestions = [];
    
    // Check if buffer size is limited by hardware
    if (currentSize >= maxTextureUnits) {
      suggestions.push({
        type: 'warning',
        message: `Buffer size limited by hardware (${maxTextureUnits} texture units available)`
      });
    }
    
    // Check if we're hitting the application limit
    if (currentSize >= CONFIG.MAX_BUFFER_SIZE) {
      suggestions.push({
        type: 'info',
        message: `Using maximum supported buffer size (${CONFIG.MAX_BUFFER_SIZE} frames)`
      });
    }
    
    // Check memory usage
    if (memoryUsage.totalMB > 50) {
      suggestions.push({
        type: 'performance',
        message: `High memory usage (${memoryUsage.totalMB}MB). Consider reducing buffer size for better performance.`
      });
    }
    
    // Check if spiral retention would be beneficial
    if (!stats.bufferInfo.useSpiralRetention && currentSize > 8) {
      suggestions.push({
        type: 'optimization',
        message: 'Consider enabling spiral retention for better temporal distribution with large buffers'
      });
    }
    
    // Check parameter efficiency
    const maxUsedOffset = Math.max(
      this.params.rOff, 
      this.params.gOff, 
      this.params.bOff, 
      this.params.timeShift
    );
    
    if (maxUsedOffset < currentSize / 2) {
      suggestions.push({
        type: 'optimization',
        message: `Buffer size (${currentSize}) may be larger than needed. Consider reducing to ${Math.max(CONFIG.MIN_BUFFER_SIZE, maxUsedOffset + 2)}.`
      });
    }
    
    // Hardware-specific suggestions
    if (maxTextureUnits > CONFIG.MAX_BUFFER_SIZE) {
      suggestions.push({
        type: 'info',
        message: `Hardware supports ${maxTextureUnits} texture units. Buffer limited to ${CONFIG.MAX_BUFFER_SIZE} by application design.`
      });
    }
    
    return suggestions;
  }
  
  /**
   * Reset to optimal configuration for current hardware
   */
  resetToOptimal() {
    const optimalSize = Math.min(
      this.webglRenderer.getOptimalBufferSize(),
      CONFIG.MAX_BUFFER_SIZE
    );
    
    const optimalParams = {
      bufferSize: optimalSize,
      spiralRetention: optimalSize > 8,
      timeShift: 1,
      opacity: CONFIG.DEFAULT_OPACITY,
      invert: true,
      rOff: Math.min(1, optimalSize - 1),
      gOff: Math.min(2, optimalSize - 1),
      bOff: Math.min(3, optimalSize - 1),
      motionThresh: CONFIG.MOTION_THRESHOLD,
      glow: CONFIG.GLOW_INTENSITY
    };
    
    this.updateParams(optimalParams);
    return optimalParams;
  }
  
  /**
   * Validate if current configuration is supported by hardware
   */
  validateConfiguration() {
    const caps = this.webglRenderer.getCapabilities();
    const validation = {
      isSupported: true,
      errors: [],
      warnings: []
    };
    
    // Check basic hardware support
    if (!caps.hardwareValidation.isSupported) {
      validation.isSupported = false;
      validation.errors.push('Hardware does not meet minimum requirements');
    }
    
    // Check buffer size against hardware limits
    if (this.params.bufferSize > caps.maxTextureUnits) {
      validation.isSupported = false;
      validation.errors.push(`Buffer size (${this.params.bufferSize}) exceeds hardware limit (${caps.maxTextureUnits})`);
    }
    
    // Check WebGL renderer support
    if (!this.webglRenderer.isBufferSizeSupported(this.params.bufferSize)) {
      validation.isSupported = false;
      validation.errors.push(`Buffer size not supported by WebGL renderer`);
    }
    
    // Add performance warnings
    const memoryUsage = this.calculateMemoryUsage();
    if (memoryUsage.totalMB > 100) {
      validation.warnings.push(`High memory usage: ${memoryUsage.totalMB}MB`);
    }
    
    return validation;
  }
}