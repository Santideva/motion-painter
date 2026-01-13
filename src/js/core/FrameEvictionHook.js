// src/js/core/FrameEvictionHook.js
// Enhanced FrameEvictionHook with adaptive processing, calibration capture, and HFH integration
// Maintains original APIs & behaviour; adds HFH annular computation for metadata enrichment.
//
// CONTRACT (important):
// - preprocessor.enqueueFrame(imageBitmap, meta, options) is expected to *take ownership*
//   of the passed imageBitmap when it returns { ok: true } (i.e., it will close it or transfer it).
// - registerCalibrationCallback(cb): cb(frames[], info) must *take ownership* of frames
//   (by transferring them to a worker or explicitly closing them). cb should return/resolve
//   a truthy value to indicate ownership was taken; otherwise the hook will close the bitmaps.
//
// HFH Integration:
// - HybridFresnelHarvester (HFH) can be injected via constructor cfg.hfh
// - If HFH is present, FrameEvictionHook will compute annular data and attach it to the
//   persisted manifest metadata prior to offering the original bitmap to the preprocessor.
// - The preprocessor persists the manifest with HFH metadata to storage.
// - motion.worker picks up reconstruction jobs via the canonical storage-based flow
//   (BroadcastChannel artifact:ready or explicit RECONSTRUCT_META messages).
//
// CANONICAL DATA FLOW (no fallback cloning):
// 1. FrameEvictionHook runs HFH.computeAnnular() + decideHFH() (fast, main thread)
// 2. FrameEvictionHook attaches HFH metadata to frame manifest
// 3. FrameEvictionHook passes original bitmap to preprocessor.enqueueFrame()
// 4. Preprocessor persists manifest + thumbnail to storage
// 5. Preprocessor (or storage.js) broadcasts artifact:ready on BroadcastChannel
// 6. motion.worker listens to BroadcastChannel, sees HFH decision, runs RECONSTRUCT_META if needed
//
// This maintains single ownership chain and avoids clone complexity.

const DEFAULT_CALIBRATION_TIMEOUT_MS = 30_000;
const MAX_CALIBRATION_BUFFER = 64;
const DEFENSIVE_WATCHDOG_MS = 5_000;

export class FrameEvictionHook {
  /**
   * constructor(preprocessorWorker, cfg = {})
   * preprocessorWorker: instance of PreprocessorWorker wrapper
   * cfg: optional object
   *   - hfh: instance of HybridFresnelHarvester (optional)
   *   - enableHFH: boolean to enable HFH computeAnnular (default true if hfh provided)
   */
  constructor(preprocessorWorker, cfg = {}) {
    this.preprocessor = preprocessorWorker;
    this.frameBuffer = null;
    this.isAttached = false;

    // Adaptive processing configuration
    this.processingMode = 'preview';
    this.adaptiveEnabled = true;
    this.frameSkipRatio = 1;
    this.frameCounter = 0;

    // Performance monitoring
    this.metrics = {
      framesOffered: 0,
      framesProcessed: 0,
      framesSkipped: 0,
      framesDropped: 0,
      avgFrameSize: 0,
      hfhCalls: 0,
      hfhDecisions: 0,
      hfhTriggers: 0,
      lastHFHError: null
    };

    // Quality adaptation
    this.downsampleScale = 1.0;
    this.minDownsampleScale = 0.25;
    this.maxDownsampleScale = 1.0;

    // Throttling state
    this.lastProcessTime = 0;
    this.minProcessInterval = 16;

    // Calibration capture state
    this.calibrationBuffer = [];
    this.captureCalibration = false;
    this.calibrationTargetCount = 0;
    this.calibrationResolution = null;
    this.calibrationUseFullClone = true;
    this._calibrationCallbacks = new Set();
    this._calibrationTimer = null;
    this._calibrationTimeoutMs = DEFAULT_CALIBRATION_TIMEOUT_MS;
    this._calibrationHardLimit = MAX_CALIBRATION_BUFFER;
    this._defensiveCleanupTimer = null;

    // HFH integration (lightweight detection only)
    this.hfh = cfg.hfh || null;
    this.enableHFH = cfg.enableHFH !== undefined ? !!cfg.enableHFH : !!this.hfh;

// bound handler
    this._boundOnEvict = (imageBitmap, meta) => this._handler(imageBitmap, meta);

    // internal state
    this.adaptiveTimer = null;
    
    // Camera container (will be set by main.js)
    this.cameraContainer = null;
  }

  // -----------------------------
  // Camera Container Management
  // -----------------------------
  /**
   * setCameraContainer - receives and validates camera container from main
   * @param {Object} container - frozen camera container object with cameraId, kind, etc.
   */
  setCameraContainer(container) {
    if (!container) {
      console.warn('[cameraContainer] FrameEvictionHook: received null container');
      this.cameraContainer = null;
      return;
    }

    if (!container.cameraId) {
      console.warn('[cameraContainer] FrameEvictionHook: container missing cameraId', container);
      this.cameraContainer = null;
      return;
    }

    // Store the frozen container reference
    this.cameraContainer = container;
    
    console.log('[cameraContainer] FrameEvictionHook: camera container set', {
      cameraId: this.cameraContainer.cameraId,
      kind: this.cameraContainer.kind,
      status: this.cameraContainer.status,
      isFrozen: Object.isFrozen(this.cameraContainer)
    });

    // If HFH is present, inform it of the camera change
    if (this.hfh && typeof this.hfh.setCameraContainer === 'function') {
      try {
        this.hfh.setCameraContainer(this.cameraContainer);
        console.log('[cameraContainer] FrameEvictionHook: propagated to HFH');
      } catch (e) {
        console.warn('[cameraContainer] FrameEvictionHook: failed to propagate to HFH', e);
      }
    }
  }

  /**
   * getCameraContainer - returns current camera container
   */
  getCameraContainer() {
    return this.cameraContainer;
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
    this.frameBuffer.onEvict = this._boundOnEvict;
    this.isAttached = true;

    this._startAdaptiveMonitoring();
  }

  detach() {
    if (this.frameBuffer && this.frameBuffer.onEvict === this._boundOnEvict) {
      this.frameBuffer.onEvict = null;
    }

    this.frameBuffer = null;
    this.isAttached = false;
    this._stopAdaptiveMonitoring();

    this.stopCalibrationCapture();
  }

  // -----------------------------
  // Core handler (eviction)
  // -----------------------------
  async _handler(imageBitmap, meta = {}) {
    this.metrics.framesOffered++;

    let bitmapClosed = false;

    try {
      // Check if preprocessor exists and can accept frames
      if (!this.preprocessor) {
        try { imageBitmap.close(); } catch (_) {}
        this.metrics.framesDropped++;
        return;
      }

      // Adaptive frame skipping based on system load
      if (this._shouldSkipFrame()) {
        try { imageBitmap.close(); } catch (_) {}
        this.metrics.framesSkipped++;
        return;
      }

      // Throttle processing rate
      const now = Date.now();
      if (now - this.lastProcessTime < this.minProcessInterval) {
        try { imageBitmap.close(); } catch (_) {}
        this.metrics.framesSkipped++;
        return;
      }

      // Update frame size metrics
      this._updateFrameSizeMetrics(imageBitmap, meta);

      // Prepare enhanced metadata
      const enhancedMeta = this._enhanceMetadata(meta);

      // Prepare adaptive options
      const options = this._getAdaptiveOptions();

      // ========================================
      // CALIBRATION CAPTURE
      // ========================================
      if (this.captureCalibration) {
        try {
          if (this.calibrationBuffer.length < this._calibrationHardLimit &&
              this.calibrationBuffer.length < this.calibrationTargetCount) {

            const clone = await this.cloneBitmapFull(imageBitmap, this.calibrationResolution || {});
            this.calibrationBuffer.push({ bitmap: clone, meta: enhancedMeta, createdAt: Date.now() });

            if (this.calibrationBuffer.length >= this.calibrationTargetCount) {
              try {
                await this._notifyCalibrationReady();
              } catch (err) {
                console.warn('FrameEvictionHook: _notifyCalibrationReady failed', err);
              }
            }
          } else {
            console.warn('FrameEvictionHook: calibration buffer hard limit reached; skipping clone');
          }
        } catch (err) {
          console.warn('FrameEvictionHook: failed creating calibration clone', err);
        }
      }

      // ========================================
      // HFH INTEGRATION: Lightweight Detection
      // ========================================
      if (this.enableHFH && this.hfh) {
        try {
          this.metrics.hfhCalls++;

          // Fast annular analysis (~60ms)
          const hfhResult = await this._safeComputeAnnular(imageBitmap, enhancedMeta);

          if (hfhResult) {
            // Attach annular data to metadata (will be persisted with manifest)
            enhancedMeta.annular = Array.from(hfhResult.annular);
            enhancedMeta.annularCounts = Array.from(hfhResult.counts);
            enhancedMeta.annularStats = hfhResult.stats;

            // Make HFH decision (~1ms)
            const hfhDecision = this.hfh.decideHFH({
              annular: hfhResult.annular,
              counts: hfhResult.counts,
              stats: hfhResult.stats,
              meta: enhancedMeta,
              cameraId: enhancedMeta.cameraId || null
            });

            // Attach decision to metadata (serializable)
            enhancedMeta.hfhDecision = {
              shouldRun: !!hfhDecision.shouldRun,
              reason: hfhDecision.reason,
              severity: Number(hfhDecision.severity || 0),
              suggestedResolution: Number(hfhDecision.suggestedResolution || 256),
              suggestedMode: hfhDecision.suggestedMode || 'light',
              diagnostics: hfhDecision.diagnostics || {}
            };

            this.metrics.hfhDecisions++;
            
            if (hfhDecision.shouldRun) {
              this.metrics.hfhTriggers++;
            }
          }
        } catch (err) {
          // Non-fatal: HFH failure should not block frame processing
          this.metrics.lastHFHError = String(err);
          console.warn('FrameEvictionHook: HFH processing failed (non-fatal)', err);
        }
      }

      // ========================================
      // PRIMARY PATH: Offer to Preprocessor
      // ========================================
      // Preprocessor will:
      // 1. Persist manifest (including HFH metadata) to storage
      // 2. Persist thumbnail/frame data to storage
      // 3. Broadcast artifact:ready on BroadcastChannel
      // 4. motion.worker listens and triggers RECONSTRUCT_META if HFH decision indicates shouldRun
      
      const result = this.preprocessor.enqueueFrame(imageBitmap, enhancedMeta, options);

      if (result && result.ok) {
        // SUCCESS: Preprocessor took ownership of bitmap
        bitmapClosed = true;
        this.metrics.framesProcessed++;
        this.lastProcessTime = now;
      } else {
        // FAILURE: Preprocessor rejected or failed
        this.metrics.framesDropped++;
        // Bitmap will be closed in finally block
      }

    } catch (err) {
      console.error('FrameEvictionHook: handler error', err);
      this.metrics.framesDropped++;
    } finally {
      // Ensure bitmap is always closed if we still own it
      if (!bitmapClosed) {
        try { imageBitmap.close(); } catch (_) {}
      }
    }
  }

  // -----------------------------
  // HFH helper
  // -----------------------------
  async _safeComputeAnnular(bitmap, enhancedMeta = {}) {
    if (!this.hfh || typeof this.hfh.computeAnnular !== 'function') {
      return null;
    }

    try {
      const result = await this.hfh.computeAnnular(bitmap, {
        cancelToken: { cancelled: false }
      });
      return result;
    } catch (err) {
      this.metrics.lastHFHError = String(err);
      console.warn('FrameEvictionHook: computeAnnular error', err);
      return null;
    }
  }

  // -----------------------------
  // Calibration helpers
  // -----------------------------
  async cloneBitmapFull(bitmap, { width = null, height = null } = {}) {
    const w = width || bitmap.width;
    const h = height || bitmap.height;

    let canvas;
    try {
      canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('Failed to get 2D context');
      }

      try {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
      } catch (e) {}

      ctx.drawImage(bitmap, 0, 0, w, h);
      const cloned = await createImageBitmap(canvas);

      try { canvas.width = 0; canvas.height = 0; } catch (e) {}
      canvas = null;

      return cloned;
    } catch (err) {
      try {
        const cloned = await createImageBitmap(bitmap, {
          resizeWidth: w,
          resizeHeight: h,
          resizeQuality: 'high'
        });
        return cloned;
      } catch (err2) {
        throw new Error('cloneBitmapFull failed: ' + (err2?.message || String(err2)));
      }
    }
  }

  registerCalibrationCallback(cb) {
    if (typeof cb !== 'function') {
      throw new Error('registerCalibrationCallback: callback must be function');
    }
    this._calibrationCallbacks.add(cb);
    return () => this._calibrationCallbacks.delete(cb);
  }

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

    this._calibrationTimer = setTimeout(() => {
      while (this.calibrationBuffer.length) {
        const e = this.calibrationBuffer.shift();
        try { e.bitmap.close(); } catch (ex) {}
      }
      this.captureCalibration = false;
      this._calibrationTimer = null;
      console.warn('FrameEvictionHook: calibration capture auto-cleared due to timeout');
    }, this._calibrationTimeoutMs);
  }

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

    while (this.calibrationBuffer.length) {
      const e = this.calibrationBuffer.shift();
      try { e.bitmap.close(); } catch (err) {}
    }
  }

  async _notifyCalibrationReady() {
    if (this._calibrationCallbacks.size === 0) {
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

    const callbacks = Array.from(this._calibrationCallbacks);
    if (callbacks.length > 1) {
      console.warn('FrameEvictionHook: Multiple calibration callbacks registered. Delivering to first only.');
    }

    const cb = callbacks[0];
    let callbackClaimedOwnership = false;
    try {
      const rv = await Promise.resolve().then(() => cb(frames, { metas, reason: 'calibration-buffer-ready' }));
      if (rv) {
        callbackClaimedOwnership = true;
      }
    } catch (err) {
      console.warn('FrameEvictionHook: calibration callback threw', err);
      callbackClaimedOwnership = false;
    }

    this.calibrationBuffer = [];
    this.captureCalibration = false;
    if (this._calibrationTimer) {
      clearTimeout(this._calibrationTimer);
      this._calibrationTimer = null;
    }

    if (!callbackClaimedOwnership) {
      return;
    }

    if (this._defensiveCleanupTimer) {
      clearTimeout(this._defensiveCleanupTimer);
      this._defensiveCleanupTimer = null;
    }
    this._defensiveCleanupTimer = setTimeout(() => {
      if (this.calibrationBuffer.length) {
        while (this.calibrationBuffer.length) {
          const entry = this.calibrationBuffer.shift();
          try { entry.bitmap.close(); } catch (e) {}
        }
      }
      this._defensiveCleanupTimer = null;
    }, DEFENSIVE_WATCHDOG_MS);
  }

  setCalibrationTimeout(ms) {
    this._calibrationTimeoutMs = Math.max(1000, Number(ms) || DEFAULT_CALIBRATION_TIMEOUT_MS);
  }

  setCalibrationHardLimit(limit) {
    this._calibrationHardLimit = Math.max(1, Math.min(1024, Number(limit) || MAX_CALIBRATION_BUFFER));
  }

  // -----------------------------
  // Adaptive methods
  // -----------------------------
  _shouldSkipFrame() {
    if (!this.adaptiveEnabled) {
      return false;
    }

    this.frameCounter++;
    if (this.frameCounter % this.frameSkipRatio !== 0) {
      return true;
    }

    const canAccept = this.preprocessor.canAcceptFrames();
    if (!canAccept) {
      return true;
    }

    return false;
  }

    _enhanceMetadata(meta) {
    // Prefer stored camera container, fallback to meta
    const cameraContainer = this.cameraContainer || 
                           (meta && meta.cameraContainer ? meta.cameraContainer : null) ||
                           (meta && meta.cameraId ? { cameraId: meta.cameraId } : null);

    return {
      ...meta,
      cameraContainer: cameraContainer || null,
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
    if (typeof meta.priority === 'number') {
      priority += meta.priority;
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
    } else if (imageBitmap && imageBitmap.width && imageBitmap.height) {
      const frameSize = imageBitmap.width * imageBitmap.height;
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

    const capacity = this.preprocessor.getCapacityStatus();

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

    this.downsampleScale = Math.max(
      this.minDownsampleScale,
      Math.min(this.maxDownsampleScale, this.downsampleScale)
    );
  }

  // -----------------------------
  // Public API
  // -----------------------------
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
    if (enabled) {
      this._startAdaptiveMonitoring();
    } else {
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
      hfhTriggerRate: this.metrics.hfhDecisions > 0 ? 
        (this.metrics.hfhTriggers / this.metrics.hfhDecisions) : 0,
      processingMode: this.processingMode,
      frameSkipRatio: this.frameSkipRatio,
      downsampleScale: this.downsampleScale,
      minProcessInterval: this.minProcessInterval,
      adaptiveEnabled: this.adaptiveEnabled,
      enableHFH: this.enableHFH,
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
      avgFrameSize: 0,
      hfhCalls: 0,
      hfhDecisions: 0,
      hfhTriggers: 0,
      lastHFHError: null
    };
  }
}

export default FrameEvictionHook;