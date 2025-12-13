// src/js/core/FrameEvictionHook.js
// Enhanced FrameEvictionHook with adaptive processing and calibration capture
// Maintains original APIs & behaviour; adds safe 1:1 clone capture for calibration.
// Calibration clones are created BEFORE the original is enqueued to preprocessor,
// and ownership of clones is passed to registered callbacks.
//
// CONTRACT (important):
// - preprocessor.enqueueFrame(imageBitmap, meta, options) is expected to *take ownership*
//   of the passed imageBitmap when it returns { ok: true } (i.e., it will close it or transfer it).
// - registerCalibrationCallback(cb): cb(frames[], info) must *take ownership* of frames
//   (by transferring them to a worker or explicitly closing them). cb should return/resolve
//   a truthy value to indicate ownership was taken; otherwise the hook will close the bitmaps.

const DEFAULT_CALIBRATION_TIMEOUT_MS = 30_000; // auto-clear if buffer not consumed
const MAX_CALIBRATION_BUFFER = 64;             // absolute hard limit for safety
const DEFENSIVE_WATCHDOG_MS = 5_000;           // after callback claims ownership, watchdog to reclaim if still present

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

    // Calibration capture state
    this.calibrationBuffer = []; // array of { bitmap: ImageBitmap, meta, createdAt }
    this.captureCalibration = false;
    this.calibrationTargetCount = 0; // how many frames to collect
    this.calibrationResolution = null; // optional {width, height} — if null use native (1:1)
    this.calibrationUseFullClone = true; // default: capture full 1:1 clones
    this._calibrationCallbacks = new Set();
    this._calibrationTimer = null; // auto-clear timer id
    this._calibrationTimeoutMs = DEFAULT_CALIBRATION_TIMEOUT_MS;
    this._calibrationHardLimit = MAX_CALIBRATION_BUFFER;
    this._defensiveCleanupTimer = null; // defensive reclaim timer

    // bound handler (so attach/detach can compare the same function)
    this._boundOnEvict = (imageBitmap, meta) => this._handler(imageBitmap, meta);
  }

  // -----------------------------
  // Attachment
  // -----------------------------
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
    // bind a stable handler so detach can remove it
    this.frameBuffer.onEvict = this._boundOnEvict;
    this.isAttached = true;

    // Start adaptive monitoring
    this._startAdaptiveMonitoring();
  }

  detach() {
    if (this.frameBuffer && this.frameBuffer.onEvict === this._boundOnEvict) {
      this.frameBuffer.onEvict = null;
    }
    
    this.frameBuffer = null;
    this.isAttached = false;
    this._stopAdaptiveMonitoring();
    
    // cleanup calibration timers and buffers on detach
    this.stopCalibrationCapture();
  }

  // -----------------------------
  // Core handler (eviction)
  // -----------------------------
  async _handler(imageBitmap, meta) {
    this.metrics.framesOffered++;
    
    // track bitmap closure to prevent double-close and ensure cleanup
    let bitmapClosed = false;
    const closeBitmap = () => {
      if (!bitmapClosed) {
        try { imageBitmap.close(); } catch (e) {}
        bitmapClosed = true;
      }
    };

    try {
      // Check if preprocessor exists and can accept frames
      if (!this.preprocessor) {
        closeBitmap();
        this.metrics.framesDropped++;
        return;
      }

      // Adaptive frame skipping based on system load
      if (this._shouldSkipFrame()) {
        closeBitmap();
        this.metrics.framesSkipped++;
        return;
      }

      // Throttle processing rate
      const now = Date.now();
      if (now - this.lastProcessTime < this.minProcessInterval) {
        closeBitmap();
        this.metrics.framesSkipped++;
        return;
      }

      // Update frame size metrics
      this._updateFrameSizeMetrics(imageBitmap, meta);

      // Prepare enhanced metadata
      const enhancedMeta = this._enhanceMetadata(meta);
      
      // Prepare adaptive options
      const options = this._getAdaptiveOptions();

      // ----- Calibration capture: clone BEFORE transferring original -----
      if (this.captureCalibration) {
        try {
          // Protect against runaway buffer/hard limit and only clone until target reached
          if (this.calibrationBuffer.length < this._calibrationHardLimit &&
              this.calibrationBuffer.length < this.calibrationTargetCount) {
            
            // create full-quality clone (or scaled if calibrationResolution supplied)
            const clone = await this.cloneBitmapFull(imageBitmap, this.calibrationResolution || {});
            
            this.calibrationBuffer.push({ bitmap: clone, meta: enhancedMeta, createdAt: Date.now() });

            // If reached target, notify callbacks (ownership transfers to callbacks)
            if (this.calibrationBuffer.length >= this.calibrationTargetCount) {
              // notify; try/catch inside to avoid blocking main pipeline
              try {
                await this._notifyCalibrationReady();
              } catch (err) {
                // swallow — we don't want cloning failures to break pipeline
                console.warn('FrameEvictionHook: _notifyCalibrationReady failed', err);
              }
            }
          } else {
            // buffer full/hard limit reached — skip cloning
            console.warn('FrameEvictionHook: calibration buffer hard limit reached; skipping clone');
          }
        } catch (err) {
          console.warn('FrameEvictionHook: failed creating calibration clone -', err);
          // fallback: continue without clone; do not block pipeline
        }
      }

      // Attempt to enqueue with the preprocessor (original behavior)
      const result = this.preprocessor.enqueueFrame(imageBitmap, enhancedMeta, options);
      
      if (result && result.ok) {
        this.metrics.framesProcessed++;
        this.lastProcessTime = now;
        // successful enqueue; preprocessor takes ownership of imageBitmap as before
        bitmapClosed = true;
      } else {
        this.metrics.framesDropped++;
        // If preprocessor returns failure, close bitmap
        closeBitmap();
      }
    } catch (err) {
      // ensure bitmap is always closed on any error
      console.error('FrameEvictionHook: handler error', err);
      closeBitmap();
      this.metrics.framesDropped++;
    }
  }

  // -----------------------------
  // Calibration helpers
  // -----------------------------
  /**
   * cloneBitmapFull(bitmap, { width, height })
   * Produces a 1:1 ImageBitmap clone (or scaled clone if width/height supplied).
   * Returns an ImageBitmap (caller is responsible for closing it or transferring it).
   */
  async cloneBitmapFull(bitmap, { width = null, height = null } = {}) {
    const w = width || bitmap.width;
    const h = height || bitmap.height;

    // Use OffscreenCanvas where available; fall back to createImageBitmap resize if necessary.
    let canvas;
    try {
      // OffscreenCanvas is available in workers and modern browsers
      canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('Failed to get 2D context');
      }
      
      try {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
      } catch (e) {
        // ignore per-engine
      }
      
      ctx.drawImage(bitmap, 0, 0, w, h);
      const cloned = await createImageBitmap(canvas);
      
      // Explicitly cleanup canvas to help GC
      try { canvas.width = 0; canvas.height = 0; } catch (e) {}
      canvas = null;
      
      return cloned;
    } catch (err) {
      // Fallback for environments where OffscreenCanvas not available or forbidden
      try {
        const cloned = await createImageBitmap(bitmap, {
          resizeWidth: w,
          resizeHeight: h,
          resizeQuality: 'high'
        });
        return cloned;
      } catch (err2) {
        // If cloning completely fails, rethrow so caller can handle gracefully.
        throw new Error('cloneBitmapFull failed: ' + (err2?.message || String(err2)));
      }
    }
  }

  /**
   * registerCalibrationCallback(cb)
   * cb receives (frames[], info) and must *take ownership* of frames (transfer to a worker or close).
   * cb should return/resolve `true` to indicate ownership was accepted. If cb returns falsy or throws,
   * the hook will close the bitmaps itself to avoid leaks.
   * Returns unsubscribe function.
   */
  registerCalibrationCallback(cb) {
    if (typeof cb !== 'function') throw new Error('registerCalibrationCallback: callback must be function');
    this._calibrationCallbacks.add(cb);
    return () => this._calibrationCallbacks.delete(cb);
  }

  /**
   * startCalibrationCapture({ count = 16, resolution = null, timeoutMs = DEFAULT, forceFull = true })
   *
   * Begins calibration capture: clones will be created on subsequent evictions until count reached.
   * resolution: optional {width,height} to scale clones deterministically. If null, clones are 1:1.
   * forceFull: boolean (true by default) — we capture full-quality clones for calibration.
   */
  startCalibrationCapture({ count = 16, resolution = null, timeoutMs = DEFAULT_CALIBRATION_TIMEOUT_MS, forceFull = true } = {}) {
    const n = Math.max(1, Math.min(count || 1, this._calibrationHardLimit));
    this.calibrationBuffer.length = 0;
    this.captureCalibration = true;
    this.calibrationTargetCount = n;
    this.calibrationResolution = resolution || null;
    this.calibrationUseFullClone = !!forceFull;
    this._calibrationTimeoutMs = timeoutMs || DEFAULT_CALIBRATION_TIMEOUT_MS;

    if (this._calibrationTimer) {
      clearTimeout(this._calibrationTimer);
      this._calibrationTimer = null;
    }

    // safety auto-clear if not consumed
    this._calibrationTimer = setTimeout(() => {
      // close any buffered bitmaps and clear
      while (this.calibrationBuffer.length) {
        const e = this.calibrationBuffer.shift();
        try { e.bitmap.close(); } catch (ex) {}
      }
      this.captureCalibration = false;
      this._calibrationTimer = null;
      console.warn('FrameEvictionHook: calibration capture auto-cleared due to timeout');
    }, this._calibrationTimeoutMs);
  }

  /**
   * stopCalibrationCapture()
   * Stop capturing and immediately close buffered clones.
   */
  stopCalibrationCapture() {
    this.captureCalibration = false;
    
    if (this._calibrationTimer) {
      clearTimeout(this._calibrationTimer);
      this._calibrationTimer = null;
    }
    
    if (this._defensiveCleanupTimer) {
      clearTimeout(this._defensiveCleanupTimer);
      this._defensiveCleanupTimer = null;
    }
    
    // close buffered bitmaps
    while (this.calibrationBuffer.length) {
      const e = this.calibrationBuffer.shift();
      try { e.bitmap.close(); } catch (err) {}
    }
  }

  /**
   * _notifyCalibrationReady()
   * Calls the first registered calibration callback with (frames[], { metas, reason }).
   * Ownership of the ImageBitmaps transfers to that callback if it returns/ resolves `true`.
   * If callback returns falsy or throws, the hook will close the bitmaps itself.
   */
  async _notifyCalibrationReady() {
    if (this._calibrationCallbacks.size === 0) {
      // No consumer: close clones and clear buffer
      for (const entry of this.calibrationBuffer) {
        try { entry.bitmap.close(); } catch (e) {}
      }
      this.calibrationBuffer = [];
      this.captureCalibration = false;
      if (this._calibrationTimer) { 
        clearTimeout(this._calibrationTimer); 
        this._calibrationTimer = null; 
      }
      return;
    }

    const frames = this.calibrationBuffer.map(e => e.bitmap);
    const metas = this.calibrationBuffer.map(e => e.meta);

    // If multiple callbacks are registered, only deliver to first to avoid ownership conflicts.
    const callbacks = Array.from(this._calibrationCallbacks);
    if (callbacks.length > 1) {
      console.warn('FrameEvictionHook: Multiple calibration callbacks registered. Delivering to first only to avoid ownership conflicts.');
    }

    const cb = callbacks[0];
    let callbackClaimedOwnership = false;
    try {
      // Call callback and await its return. It should return true to indicate ownership taken.
      const rv = await Promise.resolve().then(() => cb(frames, { metas, reason: 'calibration-buffer-ready' }));
      if (rv) {
        callbackClaimedOwnership = true;
      } else {
        // callback did not claim ownership; we will free frames below
        callbackClaimedOwnership = false;
      }
    } catch (err) {
      console.warn('FrameEvictionHook: calibration callback threw', err);
      callbackClaimedOwnership = false;
    }

    // Clear our buffer and cancel timer.
    this.calibrationBuffer = [];
    this.captureCalibration = false;
    if (this._calibrationTimer) { 
      clearTimeout(this._calibrationTimer); 
      this._calibrationTimer = null; 
    }

    // If callback did not claim ownership, close frames immediately (already closed in buffer cleanup).
    if (!callbackClaimedOwnership) {
      // Nothing left to do — frames were not transferred.
      // However keep a defensive small delay before final GC in case callback attempted transfer asynchronously.
      // (Most well-behaved callbacks will transfer immediately.)
      // No further action required.
      return;
    }

    // If callback claimed ownership, start a short watchdog to forcibly reclaim if callback failed to actually
    // transfer/close the bitmaps (defensive).
    if (this._defensiveCleanupTimer) {
      clearTimeout(this._defensiveCleanupTimer);
      this._defensiveCleanupTimer = null;
    }
    this._defensiveCleanupTimer = setTimeout(() => {
      // If any bitmaps somehow remained in our buffer (should not happen because we cleared it),
      // close them. This is extra defensive; most engines will GC transferred bitmaps if transferred.
      if (this.calibrationBuffer.length) {
        while (this.calibrationBuffer.length) {
          const entry = this.calibrationBuffer.shift();
          try { entry.bitmap.close(); } catch (e) {}
        }
      }
      this._defensiveCleanupTimer = null;
    }, DEFENSIVE_WATCHDOG_MS);
  }

  // Setters for calibration tuning
  setCalibrationTimeout(ms) {
    this._calibrationTimeoutMs = Math.max(1000, Number(ms) || DEFAULT_CALIBRATION_TIMEOUT_MS);
  }
  setCalibrationHardLimit(limit) {
    this._calibrationHardLimit = Math.max(1, Math.min(1024, Number(limit) || MAX_CALIBRATION_BUFFER));
  }

  // -----------------------------
  // Adaptive & utility methods (kept original)
  // -----------------------------
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
    const canAccept = this.preprocessor.canAcceptFrames();
    if (!canAccept) {
      return true;
    }

    return false;
  }

  _enhanceMetadata(meta) {
    return {
      ...meta,
      processingMode: this.processingMode,
      captureTime: Date.now(),
      downsampleScale: this.downsampleScale,
      priority: this._calculateFramePriority(meta),
      systemLoad: this._getSystemLoad()
    };
  }

  _calculateFramePriority(meta) {
    let priority = 0;
    switch (this.processingMode) {
      case 'final': priority += 10; break;
      case 'balanced': priority += 5; break;
      case 'preview': priority += 1; break;
    }
    if (meta.readW && meta.readH) {
      const frameSize = meta.readW * meta.readH;
      if (frameSize > this.metrics.avgFrameSize * 1.2) {
        priority += 3;
      }
    }
    return priority;
  }

  _getAdaptiveOptions() {
    return {
      mode: this.processingMode,
      downsampleScale: this.downsampleScale,
      thumbnailQuality: this._getThumbnailQuality(),
      skipMotionAnalysis: this._shouldSkipMotionAnalysis(),
      priority: this.processingMode === 'final' ? 10 : 1,
      batchable: this.processingMode === 'preview'
    };
  }

  _getThumbnailQuality() {
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
    this.adaptiveTimer = setInterval(() => {
      this._adaptProcessingParameters();
    }, 2000);
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
    
    const oldSkipRatio = this.frameSkipRatio;
    
    switch (capacity) {
      case 'low':
        this.frameSkipRatio = 1;
        this.downsampleScale = Math.min(1.0, this.downsampleScale + 0.1);
        this.minProcessInterval = 16;
        break;
      case 'medium':
        this.frameSkipRatio = 1;
        this.downsampleScale = Math.max(0.5, Math.min(1.0, this.downsampleScale));
        this.minProcessInterval = 33;
        break;
      case 'high':
        this.frameSkipRatio = 2;
        this.downsampleScale = Math.max(0.5, this.downsampleScale - 0.1);
        this.minProcessInterval = 66;
        break;
      case 'critical':
        this.frameSkipRatio = 4;
        this.downsampleScale = Math.max(this.minDownsampleScale, this.downsampleScale - 0.2);
        this.minProcessInterval = 100;
        break;
    }
    
    this.downsampleScale = Math.max(this.minDownsampleScale, Math.min(this.maxDownsampleScale, this.downsampleScale));
    if (this.frameSkipRatio !== oldSkipRatio) {
      // adaptation occurred; silent log by design
    }
  }

  // Public API methods
  setProcessingMode(mode) {
    if (!['preview', 'balanced', 'final'].includes(mode)) {
      console.warn('FrameEvictionHook: Invalid processing mode', mode);
      return;
    }
    this.processingMode = mode;
    this._adaptProcessingParameters();
  }

  setAdaptiveEnabled(enabled) {
    this.adaptiveEnabled = enabled;
    if (enabled) this._startAdaptiveMonitoring();
    else {
      this._stopAdaptiveMonitoring();
      this.frameSkipRatio = 1;
      this.downsampleScale = 1.0;
      this.minProcessInterval = 16;
    }
  }

  getMetrics() {
    const total = this.metrics.framesOffered;
    return {
      ...this.metrics,
      processRate: total > 0 ? (this.metrics.framesProcessed / total) : 0,
      skipRate: total > 0 ? (this.metrics.framesSkipped / total) : 0,
      dropRate: total > 0 ? (this.metrics.framesDropped / total) : 0,
      processingMode: this.processingMode,
      frameSkipRatio: this.frameSkipRatio,
      downsampleScale: this.downsampleScale,
      minProcessInterval: this.minProcessInterval,
      adaptiveEnabled: this.adaptiveEnabled,
      systemLoad: this.preprocessor ? this._getSystemLoad() : null,
      isAttached: this.isAttached
    };
  }

  forceAdaptation() {
    this._adaptProcessingParameters();
  }

  resetMetrics() {
    this.metrics = {
      framesOffered: 0,
      framesProcessed: 0,
      framesSkipped: 0,
      framesDropped: 0,
      avgFrameSize: 0
    };
  }
}

export default FrameEvictionHook;
