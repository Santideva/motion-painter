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
    
    // Calibration meta stored at renderer-level (main may call setCalibration)
    this.calibrationMeta = null;        // manifest data
    this.calibrationMetaKey = null;     // canonical persisted key (string)
    this.calibrationBiasArray = null;   // Float32Array if fetched to main and passed here (optional)
    // webglRenderer holds the actual GL textures

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

  /**
   * Set calibration for rendering.
   * - main can call this with either:
   *     { darkFrame: ImageBitmap, flatFrame: ImageBitmap, biasArray: Float32Array, resolution: {width,height}, meta, metaKey }
   *   or call with only meta/metaKey and then use loadPersistedCalibrationImages + getCalibrationBias to fetch images/bias from storage
   *
   * This method uploads textures into the WebGLRenderer (best-effort) and stores meta references.
   */
  setCalibration({ darkFrame = null, flatFrame = null, biasArray = null, resolution = null, meta = null, metaKey = null } = {}) {
    try {
      // Preserve meta info for later (useful for UI)
      if (meta) this.calibrationMeta = meta;
      if (metaKey) this.calibrationMetaKey = metaKey;
      if (biasArray) this.calibrationBiasArray = biasArray;

      // Ask webglRenderer to create GL textures for the dark/flat/bias
      this.webglRenderer.setCalibrationTextures({
        darkBitmap: darkFrame,
        flatBitmap: flatFrame,
        biasArray,
        resolution,
        metaKey
      });

      console.log('CompositeRenderer: calibration set (metaKey=', this.calibrationMetaKey, ')');
    } catch (err) {
      console.error('CompositeRenderer.setCalibration failed', err);
      throw err;
    }
  }

  /**
   * Clear calibration (delete GL textures and clear stored meta).
   */
  clearCalibration() {
    try {
      // Clear GL textures
      this.webglRenderer.clearCalibrationTextures();

      // Clear stored meta/bias references (main may hold its own copies separately)
      this.calibrationMeta = null;
      this.calibrationMetaKey = null;
      this.calibrationBiasArray = null;

      console.log('CompositeRenderer: calibration cleared');
    } catch (err) {
      console.warn('CompositeRenderer.clearCalibration failed', err);
    }
  }
  
  render() {
    const frameTextures = this.frameBuffer.getTextures();
    console.log('[CR] render(): got frameTextures (top-level). length=', frameTextures.length);
    
    // Ensure we don't exceed hardware limits
    const effectiveTextures = frameTextures.slice(0, CONFIG.MAX_BUFFER_SIZE);
    
    if (this.showMotionMask) {
      this.renderMotionDebug(effectiveTextures, {});
    } else {
      // Provide time/flipY/delta uniforms if you have that data (main may pass in opts)
      this.renderComposite(effectiveTextures);
    }
  }
  
  /**
   * New rendering entry: accept textures and uniforms
   */

/**
 * CompositeRenderer.js
 * Updated renderComposite with descriptor normalization
 */
renderComposite(frameTextures, uniforms = {}) {
  console.log('[CR] renderComposite: called. frameTextures type=', typeof frameTextures, 'isArrayLike=', (!!frameTextures && typeof frameTextures.length === 'number'));
  // Defensive: ensure we can accept both shapes:
  //  - array-like: [{ arrayTexture, layerIndex }, ...]
  //  - normalized object: { arrayTexture, layerIndices: [...] }
  const isArrayLike = frameTextures && (typeof frameTextures.length === 'number');

  // Normalize into { arrayTexture, layerIndices: [] }
  let arrayTexture = null;
  let layerIndices = null;

  if (!frameTextures) {
    // nothing to do — inform renderer and bail out safely
    if (!this._warnedInvalidFrameTextures) {
      console.error('CompositeRenderer.renderComposite: no frameTextures provided (null/undefined).');
      this._warnedInvalidFrameTextures = true;
    }
    try { this.webglRenderer && typeof this.webglRenderer.updateBufferSize === 'function' && this.webglRenderer.updateBufferSize(0); } catch(e) {}
    return;
  }

  // Case A: already normalized object { arrayTexture, layerIndices }
  if (!isArrayLike && typeof frameTextures === 'object') {
    arrayTexture = frameTextures.arrayTexture || null;
    layerIndices = Array.isArray(frameTextures.layerIndices) ? frameTextures.layerIndices.slice() : null;
  }
  // Case B: array-like (likely FrameBuffer.getTextures())
  else if (isArrayLike) {
    // frameTextures is an array. Each entry hopefully is { arrayTexture, layerIndex }.
    const arr = Array.from(frameTextures);
    layerIndices = [];

    for (let i = 0; i < arr.length; i++) {
      const e = arr[i];
      if (e && typeof e === 'object') {
        // descriptor object
        if (!arrayTexture && e.arrayTexture) arrayTexture = e.arrayTexture;
        if (typeof e.layerIndex === 'number') {
          // ensure integer
          layerIndices.push(Math.max(0, Math.floor(e.layerIndex)));
        } else {
          // fallback: if descriptor doesn't hold layerIndex, attempt to treat the index order as layer index
          layerIndices.push(i);
        }
      } else if (typeof e === 'number') {
        // array of numeric indices
        layerIndices.push(Math.max(0, Math.floor(e)));
      } else {
        // unknown entry, skip
      }
    }
  } else {
    // Unexpected shape
    if (!this._warnedInvalidFrameTextures) {
      console.error('CompositeRenderer.renderComposite: invalid frameTextures (unexpected type). Received:', frameTextures);
      this._warnedInvalidFrameTextures = true;
    }
    try { this.webglRenderer && typeof this.webglRenderer.updateBufferSize === 'function' && this.webglRenderer.updateBufferSize(0); } catch(e) {}
    return;
  }

  // Clear one-time warning if we got a usable value now
  this._warnedInvalidFrameTextures = false;
  console.log('[CR] renderComposite: normalized -> arrayTexture=', !!arrayTexture, ', layerIndices.length=', Array.isArray(layerIndices) ? layerIndices.length : 0, ', layerIndices(first8)=', Array.isArray(layerIndices) ? layerIndices.slice(0,8) : null);

  // Validate we have an arrayTexture and layerIndices
  if (!arrayTexture) {
    // Missing arrayTexture is fatal for sampler2DArray path; warn and bail
    console.warn('CompositeRenderer.renderComposite: no arrayTexture (nothing to bind).');
    try { this.webglRenderer && typeof this.webglRenderer.updateBufferSize === 'function' && this.webglRenderer.updateBufferSize(0); } catch(e) {}
    return;
  }
  if (!Array.isArray(layerIndices) || layerIndices.length === 0) {
    // Nothing to render (no layers). Inform renderer and bail
    try { this.webglRenderer && typeof this.webglRenderer.updateBufferSize === 'function' && this.webglRenderer.updateBufferSize(0); } catch(e) {}
    return;
  }

  // Compute effective size (clamped to application max)
  let effectiveSize = Math.min(layerIndices.length, CONFIG.MAX_BUFFER_SIZE);
  effectiveSize = Number.isFinite(effectiveSize) ? Math.max(0, Math.floor(effectiveSize)) : 0;
  console.log('[CR] renderComposite: effectiveSize=', effectiveSize);

  if (!Number.isFinite(effectiveSize) || Number.isNaN(effectiveSize)) {
    console.error('CompositeRenderer.renderComposite: computed invalid effectiveSize:', effectiveSize, 'layerIndices.length=', layerIndices.length);
    try { this.webglRenderer && typeof this.webglRenderer.updateBufferSize === 'function' && this.webglRenderer.updateBufferSize(0); } catch(e) {}
    return;
  }

  // Notify WebGLRenderer of buffer size (guarded call)
  try {
    if (this.webglRenderer && typeof this.webglRenderer.updateBufferSize === 'function') {
      this.webglRenderer.updateBufferSize(effectiveSize);
      console.log('[CR] renderComposite: webglRenderer.updateBufferSize called with', effectiveSize);
    }
  } catch (err) {
    console.error('CompositeRenderer.renderComposite: webglRenderer.updateBufferSize failed', err);
    return;
  }

  // If there are no frames to render after clamping, return early
  if (effectiveSize === 0) {
    return;
  }

  // Use validated params for uniforms
  const validatedParams = this.getValidatedParams(effectiveSize);

  // Merge runtime uniforms supplied by caller
  const renderUniforms = {
    ...validatedParams,
    ...uniforms
  };

  // Ensure useCalibration flag reflects renderer state
  renderUniforms.useCalibration = !!(this.webglRenderer && typeof this.webglRenderer.hasCalibration === 'function' && this.webglRenderer.hasCalibration());

  // Build normalized frameBufferData expected by WebGLRenderer
  const normalizedFrameBufferData = {
    arrayTexture,
    layerIndices: layerIndices.slice(0, effectiveSize)
  };
  console.log('[CR] renderComposite: normalizedFrameBufferData.layerIndices(first8)=', normalizedFrameBufferData.layerIndices.slice(0,8));

  // Call into WebGLRenderer with normalized data
  try {
    if (this.webglRenderer && typeof this.webglRenderer.renderComposite === 'function') {
      console.log('[CR] renderComposite: invoking webglRenderer.renderComposite (arrayTexture bound?), layerIndices.length=', normalizedFrameBufferData.layerIndices.length);
      this.webglRenderer.renderComposite(normalizedFrameBufferData, renderUniforms);
      console.log('[CR] renderComposite: webglRenderer.renderComposite returned (no exception)');
    } else {
      console.warn('CompositeRenderer.renderComposite: webglRenderer.renderComposite is not available');
    }
  } catch (renderErr) {
    console.error('CompositeRenderer.renderComposite: webglRenderer.renderComposite threw an error', renderErr);
  }
}

  renderMotionDebug(frameTextures, uniforms = {}) {
    // Defensive normalization: frameTextures is array of descriptors
    const currentDesc = frameTextures[0];
    const previousDesc = frameTextures[1] || currentDesc;

    // Build the { arrayTexture, layerIndices } shape expected by WebGLRenderer
    const motionFrameBufferData = {
      arrayTexture: currentDesc && currentDesc.arrayTexture ? currentDesc.arrayTexture : null,
      layerIndices: [
        (currentDesc && typeof currentDesc.layerIndex === 'number') ? currentDesc.layerIndex : 0,
        (previousDesc && typeof previousDesc.layerIndex === 'number') ? previousDesc.layerIndex : 0
      ]
    };

    const flipY = !!(uniforms.flipY ?? this.params.flipY);
    // Call webglRenderer with the normalized frameBufferData
    this.webglRenderer.renderMotionMask(motionFrameBufferData, this.params.motionThresh, flipY);
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
   * Process a new video frame with enhanced ordering and time info
   * @param {HTMLVideoElement} video - Video source
   * @param {Object} opts - { time: seconds, delta: seconds, flipY: boolean }
   */
  async processFrame(video, opts = {}) {
  // Prevent re-entrancy / overlapping frames
  if (this._processingFrame) {
    // Skip this frame if a previous frame is still being processed.
    // This avoids races with writeIndex/texture uploads.
    console.warn('[CR] processFrame: previous frame still processing — skipping this tick');
    return;
  }
  this._processingFrame = true;

  try {
    console.log('[CR] processFrame: start — writeIndex(before upload)=', this.frameBuffer.writeIndex, 'frameCount=', this.frameBuffer.frameCount);

    // Upload current frame to buffer at writeIndex and await completion.
    const ok = await this.frameBuffer.uploadVideoFrame(video, { allowBitmapFallback: true });
    if (!ok) {
      console.warn('[CR] processFrame: uploadVideoFrame failed — skipping advance/render for this frame');
      return;
    }
    console.log('[CR] processFrame: uploaded frame to layer (post-upload writeIndex still)=', this.frameBuffer.writeIndex, 'frameCount=', this.frameBuffer.frameCount);

    // Advance write index so newest frame becomes index 0 in read view
    this.frameBuffer.advanceWriteIndex();
    console.log('[CR] processFrame: advanceWriteIndex done — new writeIndex=', this.frameBuffer.writeIndex);

    // Build read-ordered view according to retention policy (spiral/linear)
    this.frameBuffer.rotateBuffers();
    console.log('[CR] processFrame: rotateBuffers done — readTextures=', this.frameBuffer.readTextures ? this.frameBuffer.readTextures.slice(0,8) : null);

    // Get read-ordered textures (newest first)
    const frameTextures = this.frameBuffer.getTextures();
    console.log('[CR] processFrame: frameTextures descriptors (first 8)=', frameTextures.slice(0,8));

    // Render using validated params and pass time/flipY
    const validatedParams = this.getValidatedParams(Math.min(frameTextures.length, CONFIG.MAX_BUFFER_SIZE));
    const renderUniforms = {
      ...validatedParams,
      time: opts.time ?? 0.0,
      delta: opts.delta ?? 0.0,
      flipY: !!opts.flipY
    };
    this.renderComposite(frameTextures, renderUniforms);

  } catch (error) {
    console.error('Error processing frame:', error);
    throw error; // Re-throw so callers can observe failures if they want
  } finally {
    this._processingFrame = false;
  }
}
  
  initializeBuffer(video) {
    try {
      // Initialize all buffer slots with the first frame
      this.frameBuffer.initializeWithFrame(video);
      // Ensure read-ordered view is built
      this.frameBuffer.rotateBuffers();
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
      },
      calibration: {
        metaKey: this.calibrationMetaKey,
        meta: this.calibrationMeta,
        hasGLCalibration: this.webglRenderer.hasCalibration()
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
    
    // Flip rows to upright ImageData
    const rowSize = width * 4;
    const flipped = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      const srcStart = y * rowSize;
      const dstStart = (height - y - 1) * rowSize;
      flipped.set(pixels.subarray(srcStart, srcStart + rowSize), dstStart);
    }
    
    return new ImageData(flipped, width, height);
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
   * (keeps original logic)
   */
  resetToOptimal() {
    const optimalSize = Math.min(
      this.webglRenderer.getOptimalBufferSize ? this.webglRenderer.getOptimalBufferSize() : CONFIG.MAX_BUFFER_SIZE,
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
    if (!caps.validation.isValid) {
      validation.isSupported = false;
      validation.errors.push('Hardware does not meet minimum requirements');
    }
    
    // Check buffer size against hardware limits
    if (this.params.bufferSize > caps.maxTextureUnits) {
      validation.isSupported = false;
      validation.errors.push(`Buffer size (${this.params.bufferSize}) exceeds hardware limit (${caps.maxTextureUnits})`);
    }
    
    // Check WebGL renderer support - gracefully handle if method missing
    if (typeof this.webglRenderer.isBufferSizeSupported === 'function' && !this.webglRenderer.isBufferSizeSupported(this.params.bufferSize)) {
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
