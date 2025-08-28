// src/js/core/FrameEvictionHook.js
// Enhanced version that integrates with backpressure system

export class FrameEvictionHook {
  constructor(preprocessorWorker) {
    this.preprocessor = preprocessorWorker;
    this.frameBuffer = null;
    this.isAttached = false;
    
    // Adaptive processing configuration
    this.processingMode = 'preview'; // 'preview', 'balanced', 'final'
    this.adaptiveEnabled = true;
    this.frameSkipRatio = 1; // Process every Nth frame
    this.frameCounter = 0;
    
    // Performance monitoring
    this.metrics = {
      framesOffered: 0,
      framesProcessed: 0,
      framesSkipped: 0,
      framesDropped: 0,
      avgFrameSize: 0
    };
    
    // Quality adaptation
    this.downsampleScale = 1.0;
    this.minDownsampleScale = 0.25;
    this.maxDownsampleScale = 1.0;
    
    // Throttling state
    this.lastProcessTime = 0;
    this.minProcessInterval = 16; // ~60fps max processing rate
  }

  attach(frameBuffer) {
    if (this.isAttached && this.frameBuffer) {
      console.warn('FrameEvictionHook: Already attached to a FrameBuffer');
      return;
    }

    if (!frameBuffer) {
      console.warn('FrameEvictionHook: Cannot attach to null FrameBuffer');
      return;
    }

    this.frameBuffer = frameBuffer;
    this.frameBuffer.onEvict = (imageBitmap, meta) => this._handler(imageBitmap, meta);
    this.isAttached = true;

    console.log('FrameEvictionHook attached to FrameBuffer');
    
    // Start adaptive monitoring
    this._startAdaptiveMonitoring();
  }

  detach() {
    if (this.frameBuffer && this.frameBuffer.onEvict === this._handler) {
      this.frameBuffer.onEvict = null;
    }
    
    this.frameBuffer = null;
    this.isAttached = false;
    this._stopAdaptiveMonitoring();
    
    console.log('FrameEvictionHook detached from FrameBuffer');
  }

  _handler(imageBitmap, meta) {
    this.metrics.framesOffered++;
    
    // Check if preprocessor exists and can accept frames
    if (!this.preprocessor) {
      console.debug('FrameEvictionHook: No preprocessor available, closing ImageBitmap');
      try { imageBitmap.close(); } catch (e) {}
      this.metrics.framesDropped++;
      return;
    }

    // Adaptive frame skipping based on system load
    if (this._shouldSkipFrame()) {
      console.debug('FrameEvictionHook: Skipping frame due to adaptive processing');
      try { imageBitmap.close(); } catch (e) {}
      this.metrics.framesSkipped++;
      return;
    }

    // Throttle processing rate
    const now = Date.now();
    if (now - this.lastProcessTime < this.minProcessInterval) {
      console.debug('FrameEvictionHook: Throttling frame processing');
      try { imageBitmap.close(); } catch (e) {}
      this.metrics.framesSkipped++;
      return;
    }

    // Update frame size metrics
    this._updateFrameSizeMetrics(imageBitmap, meta);

    // Prepare enhanced metadata
    const enhancedMeta = this._enhanceMetadata(meta);
    
    // Prepare adaptive options
    const options = this._getAdaptiveOptions();

    // Attempt to enqueue with the preprocessor
    const result = this.preprocessor.enqueueFrame(imageBitmap, enhancedMeta, options);
    
    if (result.ok) {
      this.metrics.framesProcessed++;
      this.lastProcessTime = now;
      console.debug('FrameEvictionHook: Frame enqueued successfully', result.jobId);
    } else {
      this.metrics.framesDropped++;
      console.debug('FrameEvictionHook: Frame rejected by preprocessor', result.reason);
      // ImageBitmap already closed by preprocessor on failure
    }
  }

  _shouldSkipFrame() {
    if (!this.adaptiveEnabled) {
      return false;
    }

    // Skip frames based on current frame skip ratio
    this.frameCounter++;
    if (this.frameCounter % this.frameSkipRatio !== 0) {
      return true;
    }

    // Check preprocessor capacity
    if (!this.preprocessor.canAcceptFrames()) {
      return true;
    }

    return false;
  }

  _enhanceMetadata(meta) {
    return {
      ...meta,
      // Add processing context
      processingMode: this.processingMode,
      captureTime: Date.now(),
      
      // Add quality/performance hints
      downsampleScale: this.downsampleScale,
      priority: this._calculateFramePriority(meta),
      
      // Add system metrics
      systemLoad: this._getSystemLoad()
    };
  }

  _calculateFramePriority(meta) {
    let priority = 0;
    
    // Base priority on processing mode
    switch (this.processingMode) {
      case 'final': priority += 10; break;
      case 'balanced': priority += 5; break;
      case 'preview': priority += 1; break;
    }
    
    // Increase priority for frames with significant changes
    if (meta.readW && meta.readH) {
      const frameSize = meta.readW * meta.readH;
      if (frameSize > this.metrics.avgFrameSize * 1.2) {
        priority += 3; // Likely more interesting content
      }
    }
    
    return priority;
  }

  _getAdaptiveOptions() {
    return {
      mode: this.processingMode,
      downsampleScale: this.downsampleScale,
      
      // Quality settings based on system performance
      thumbnailQuality: this._getThumbnailQuality(),
      skipMotionAnalysis: this._shouldSkipMotionAnalysis(),
      
      // Processing hints
      priority: this.processingMode === 'final' ? 10 : 1,
      batchable: this.processingMode === 'preview'
    };
  }

  _getThumbnailQuality() {
    // Adjust thumbnail quality based on system load
    const capacity = this.preprocessor.getCapacityStatus();
    
    switch (capacity) {
      case 'low': return 'high';
      case 'medium': return 'medium';
      case 'high': return 'low';
      case 'critical': return 'minimal';
      default: return 'medium';
    }
  }

  _shouldSkipMotionAnalysis() {
    // Skip expensive motion analysis under high load
    const metrics = this.preprocessor.getMetrics();
    return metrics.queueUtilization > 0.8 && this.processingMode !== 'final';
  }

  _getSystemLoad() {
    const preprocessorMetrics = this.preprocessor.getMetrics();
    
    return {
      queueUtilization: preprocessorMetrics.queueUtilization,
      processingRate: preprocessorMetrics.throughput,
      dropRate: preprocessorMetrics.dropRate,
      backpressureActive: preprocessorMetrics.backpressureActive
    };
  }

  _updateFrameSizeMetrics(imageBitmap, meta) {
    if (meta.readW && meta.readH) {
      const frameSize = meta.readW * meta.readH;
      this.metrics.avgFrameSize = (this.metrics.avgFrameSize * 0.9) + (frameSize * 0.1);
    }
  }

  _startAdaptiveMonitoring() {
    // Monitor system performance and adapt processing parameters
    this.adaptiveTimer = setInterval(() => {
      this._adaptProcessingParameters();
    }, 2000); // Check every 2 seconds
  }

  _stopAdaptiveMonitoring() {
    if (this.adaptiveTimer) {
      clearInterval(this.adaptiveTimer);
      this.adaptiveTimer = null;
    }
  }

  _adaptProcessingParameters() {
    if (!this.adaptiveEnabled || !this.preprocessor) {
      return;
    }

    const metrics = this.preprocessor.getMetrics();
    const capacity = this.preprocessor.getCapacityStatus();
    
    // Adapt frame skip ratio based on system performance
    const oldSkipRatio = this.frameSkipRatio;
    
    switch (capacity) {
      case 'low':
        this.frameSkipRatio = 1; // Process all frames
        this.downsampleScale = Math.min(1.0, this.downsampleScale + 0.1);
        this.minProcessInterval = 16; // 60fps max
        break;
        
      case 'medium':
        this.frameSkipRatio = 1;
        this.downsampleScale = Math.max(0.5, Math.min(1.0, this.downsampleScale));
        this.minProcessInterval = 33; // 30fps max
        break;
        
      case 'high':
        this.frameSkipRatio = 2; // Process every 2nd frame
        this.downsampleScale = Math.max(0.5, this.downsampleScale - 0.1);
        this.minProcessInterval = 66; // 15fps max
        break;
        
      case 'critical':
        this.frameSkipRatio = 4; // Process every 4th frame
        this.downsampleScale = Math.max(this.minDownsampleScale, this.downsampleScale - 0.2);
        this.minProcessInterval = 100; // 10fps max
        break;
    }
    
    // Clamp downsample scale
    this.downsampleScale = Math.max(this.minDownsampleScale, 
                                   Math.min(this.maxDownsampleScale, this.downsampleScale));
    
    // Log adaptation changes
    if (this.frameSkipRatio !== oldSkipRatio) {
      console.log(`FrameEvictionHook: Adapted processing - skip ratio: ${oldSkipRatio} → ${this.frameSkipRatio}, downsample: ${this.downsampleScale.toFixed(2)}, capacity: ${capacity}`);
    }
  }

  // Public API methods

  setProcessingMode(mode) {
    if (!['preview', 'balanced', 'final'].includes(mode)) {
      console.warn('FrameEvictionHook: Invalid processing mode', mode);
      return;
    }
    
    this.processingMode = mode;
    console.log(`FrameEvictionHook: Processing mode set to ${mode}`);
    
    // Immediate adaptation based on new mode
    this._adaptProcessingParameters();
  }

  setAdaptiveEnabled(enabled) {
    this.adaptiveEnabled = enabled;
    
    if (enabled) {
      this._startAdaptiveMonitoring();
    } else {
      this._stopAdaptiveMonitoring();
      // Reset to default parameters
      this.frameSkipRatio = 1;
      this.downsampleScale = 1.0;
      this.minProcessInterval = 16;
    }
    
    console.log(`FrameEvictionHook: Adaptive processing ${enabled ? 'enabled' : 'disabled'}`);
  }

  getMetrics() {
    const total = this.metrics.framesOffered;
    
    return {
      ...this.metrics,
      processRate: total > 0 ? (this.metrics.framesProcessed / total) : 0,
      skipRate: total > 0 ? (this.metrics.framesSkipped / total) : 0,
      dropRate: total > 0 ? (this.metrics.framesDropped / total) : 0,
      
      // Current configuration
      processingMode: this.processingMode,
      frameSkipRatio: this.frameSkipRatio,
      downsampleScale: this.downsampleScale,
      minProcessInterval: this.minProcessInterval,
      adaptiveEnabled: this.adaptiveEnabled,
      
      // System status
      systemLoad: this.preprocessor ? this._getSystemLoad() : null,
      isAttached: this.isAttached
    };
  }

  // Force immediate adaptation (useful for debugging/testing)
  forceAdaptation() {
    this._adaptProcessingParameters();
    console.log('FrameEvictionHook: Forced adaptation completed', this.getMetrics());
  }

  // Reset metrics
  resetMetrics() {
    this.metrics = {
      framesOffered: 0,
      framesProcessed: 0,
      framesSkipped: 0,
      framesDropped: 0,
      avgFrameSize: 0
    };
    console.log('FrameEvictionHook: Metrics reset');
  }
}