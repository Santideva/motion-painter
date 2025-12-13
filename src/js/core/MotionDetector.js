// src/js/core/MotionDetector.js

export class MotionDetector {
  /**
   * MotionDetector
   *
   * Responsibilities:
   *  - provide CPU-based motion analytics (existing analyzeMotion)
   *  - maintain a short history of motion levels and luminance to decide when calibration is needed
   *  - expose multiple event registration patterns so main.js can hook into calibrationNeeded
   *
   * Options:
   *  - threshold: base luminance diff threshold for pixel-level detection (0-1)
   *  - smoothing: smoothing range used for shader param suggestion
   *  - sensitivity: multiplier for how fast we respond
   *  - motionWindowSize: number of samples to average when deciding stability
   *  - stableMotionThreshold: average motionLevel below which scene considered 'stable'
   *  - luminanceChangeThreshold: relative luminance change (fraction) to trigger recalibration
   *  - calibrationCooldownMs: minimum ms between emitted calibration requests
   *  - calibrationMaxAgeMs: emit periodic calibration if older than this (optional)
   */
  constructor(options = {}) {
    // motion detection params (defaults preserved from your prior class)
    this.threshold = typeof options.threshold === 'number' ? options.threshold : 0.08;
    this.sensitivity = typeof options.sensitivity === 'number' ? options.sensitivity : 1.0;
    this.smoothing = typeof options.smoothing === 'number' ? options.smoothing : 0.05;

    // decision / orchestration params
    this.motionWindowSize = Number.isInteger(options.motionWindowSize) ? options.motionWindowSize : 12;
    this.stableMotionThreshold = typeof options.stableMotionThreshold === 'number' ? options.stableMotionThreshold : 0.01;
    this.luminanceChangeThreshold = typeof options.luminanceChangeThreshold === 'number' ? options.luminanceChangeThreshold : 0.12; // 12%
    this.calibrationCooldownMs = typeof options.calibrationCooldownMs === 'number' ? options.calibrationCooldownMs : 2 * 60 * 1000; // 2 minutes
    this.calibrationMaxAgeMs = typeof options.calibrationMaxAgeMs === 'number' ? options.calibrationMaxAgeMs : 24 * 60 * 60 * 1000; // 24 hours (optional periodic)
    this.minFramesForCalibration = typeof options.minFramesForCalibration === 'number' ? options.minFramesForCalibration : 8;
    this.defaultCalibrationCount = typeof options.defaultCalibrationCount === 'number' ? options.defaultCalibrationCount : 16;

    // recent history buffers
    this._motionHistory = []; // array of recent motionLevel numbers
    this._lumaHistory = [];   // array of recent average luminance numbers
    this._lastCalibrationEmit = 0; // timestamp when we last emitted calibrationNeeded
    this._lastCalibrationRequestedAt = 0; // tracks when we last started a capture (avoid duplicates)
    this._forcedNextCalibration = false; // manual override

    // Event listeners (support multiple APIs)
    this._ee = new Map(); // simple event emitter: event -> Set(handlers)
    this._domListeners = new Map(); // event -> Set(handlers) (for addEventListener/removeEventListener)

    // backward compatibility: keep simple on/off style mapping
    this.on = this.on.bind(this);
    this.off = this.off.bind(this);
    this.addEventListener = this.addEventListener.bind(this);
    this.removeEventListener = this.removeEventListener.bind(this);
    this.requestCalibration = this.requestCalibration.bind(this);
  }

  // ------------------------------
  // Basic setters (kept)
  // ------------------------------
  setThreshold(threshold) {
    this.threshold = Math.max(0, Math.min(1, threshold));
  }

  setSensitivity(sensitivity) {
    this.sensitivity = Math.max(0, Math.min(2, sensitivity));
  }

  setSmoothing(smoothing) {
    this.smoothing = Math.max(0, Math.min(1, smoothing));
  }

  // ------------------------------
  // Event API (supports multiple integration patterns)
  // ------------------------------
  on(event, handler) {
    if (!this._ee.has(event)) this._ee.set(event, new Set());
    this._ee.get(event).add(handler);
    // return unsubscribe convenience
    return () => { this.off(event, handler); };
  }

  off(event, handler) {
    const s = this._ee.get(event);
    if (!s) return;
    s.delete(handler);
    if (s.size === 0) this._ee.delete(event);
  }

  addEventListener(event, handler) {
    if (!this._domListeners.has(event)) this._domListeners.set(event, new Set());
    this._domListeners.get(event).add(handler);
    return () => { this.removeEventListener(event, handler); };
  }

  removeEventListener(event, handler) {
    const s = this._domListeners.get(event);
    if (!s) return;
    s.delete(handler);
    if (s.size === 0) this._domListeners.delete(event);
  }

  // One-shot registration helper (used by main.js as fallback)
  // Accepts a handler and returns an unsubscribe function
  requestCalibration(handler) {
    if (typeof handler !== 'function') return () => {};
    // We attach as a one-time 'calibrationNeeded' listener
    const wrapper = (payload) => {
      try { handler(payload); } catch (e) { console.warn('requestCalibration handler threw', e); }
      // remove
      try { this.off('calibrationNeeded', wrapper); } catch (e) {}
    };
    this.on('calibrationNeeded', wrapper);
    return () => { try { this.off('calibrationNeeded', wrapper); } catch (e) {} };
  }

  // ------------------------------
  // Internal emit
  // ------------------------------
  _emit(event, payload) {
    // EventEmitter-style handlers
    const setA = this._ee.get(event);
    if (setA && setA.size > 0) {
      for (const h of Array.from(setA)) {
        try { h(payload); } catch (e) { console.warn('MotionDetector listener threw', e); }
      }
    }

    // DOM-style handlers
    const setB = this._domListeners.get(event);
    if (setB && setB.size > 0) {
      for (const h of Array.from(setB)) {
        try { h(payload); } catch (e) { console.warn('MotionDetector DOM listener threw', e); }
      }
    }

    // Compatibility alias: emit 'needCalibration' too
    if (event === 'calibrationNeeded') {
      const setC = this._ee.get('needCalibration');
      if (setC && setC.size > 0) {
        for (const h of Array.from(setC)) {
          try { h(payload); } catch (e) { console.warn('MotionDetector needCalibration listener threw', e); }
        }
      }
      const setD = this._domListeners.get('needCalibration');
      if (setD && setD.size > 0) {
        for (const h of Array.from(setD)) {
          try { h(payload); } catch (e) { console.warn('MotionDetector needCalibration DOM listener threw', e); }
        }
      }
    }
  }

  // ------------------------------
  // Motion analysis (existing)
  // ------------------------------
  /**
   * Analyze motion between two frames (CPU-based analysis if needed)
   * currentFrame and previousFrame are ImageData-like objects with .width, .height, .data (Uint8ClampedArray)
   */
  analyzeMotion(currentFrame, previousFrame) {
    if (!currentFrame || !previousFrame) {
      return { motionLevel: 0, motionPixels: 0, motionAreas: [], coverage: 0, avgLuminance: 0 };
    }

    const width = currentFrame.width;
    const height = currentFrame.height;
    const currentData = currentFrame.data;
    const previousData = previousFrame.data;

    let totalMotion = 0;
    let motionPixels = 0;
    const motionAreas = [];

    // Grid-based motion analysis (downsample for performance)
    const gridSize = 16;
    const stepX = Math.max(1, Math.floor(width / gridSize));
    const stepY = Math.max(1, Math.floor(height / gridSize));

    let totalLuma = 0;
    let lumaSamples = 0;

    for (let y = 0; y < height; y += stepY) {
      for (let x = 0; x < width; x += stepX) {
        const index = (y * width + x) * 4;

        // Calculate luminance for both frames
        const currLum = this.calculateLuminance(
          currentData[index],
          currentData[index + 1],
          currentData[index + 2]
        );

        const prevLum = this.calculateLuminance(
          previousData[index],
          previousData[index + 1],
          previousData[index + 2]
        );

        // collect luma statistics
        totalLuma += currLum;
        lumaSamples++;

        const diff = Math.abs(currLum - prevLum);

        if (diff > this.threshold) {
          totalMotion += diff;
          motionPixels++;

          motionAreas.push({
            x: x / width,
            y: y / height,
            intensity: diff
          });
        }
      }
    }

    const avgMotion = motionPixels > 0 ? totalMotion / motionPixels : 0;
    const avgLuminance = lumaSamples > 0 ? (totalLuma / lumaSamples) : 0;

    return {
      motionLevel: avgMotion,
      motionPixels,
      motionAreas,
      coverage: motionPixels / (gridSize * gridSize),
      avgLuminance
    };
  }

  calculateLuminance(r, g, b) {
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  getMotionParams(threshold = this.threshold) {
    return {
      threshold: threshold,
      smoothingRange: this.smoothing,
      sensitivity: this.sensitivity
    };
  }

  getAdaptiveThreshold(motionAnalysis) {
    const baseThreshold = this.threshold;

    // Increase threshold if too much motion detected (reduce noise)
    if (motionAnalysis.coverage > 0.5) {
      return Math.min(1.0, baseThreshold * 1.5);
    }

    // Decrease threshold if very little motion (increase sensitivity)
    if (motionAnalysis.coverage < 0.1) {
      return Math.max(0.01, baseThreshold * 0.7);
    }

    return baseThreshold;
  }

  // ------------------------------
  // Decision logic: decide if calibration is required
  // ------------------------------
  /**
   * Call on every frame (or periodically) with ImageData-like objects.
   * main or compositeRenderer should call this with current + previous ImageData.
   *
   * If this decides calibration is required it will emit 'calibrationNeeded' with payload:
   *   { count, resolution: {width,height} (optional), reason }
   *
   * It is conservative: it requires a short stable window OR a large luminance change OR periodic age.
   */
  handleFrame(currentFrame, previousFrame, opts = {}) {
    try {
      // Analyze motion/luma
      const analysis = this.analyzeMotion(currentFrame, previousFrame);

      // Update moving windows
      this._motionHistory.push(analysis.motionLevel);
      if (this._motionHistory.length > this.motionWindowSize) this._motionHistory.shift();

      this._lumaHistory.push(analysis.avgLuminance);
      if (this._lumaHistory.length > this.motionWindowSize) this._lumaHistory.shift();

      // Evaluate aggregated stats
      const avgMotion = this._motionHistory.reduce((s, v) => s + v, 0) / Math.max(1, this._motionHistory.length);
      const avgLuma = this._lumaHistory.reduce((s, v) => s + v, 0) / Math.max(1, this._lumaHistory.length);
      const recentLuma = analysis.avgLuminance;

      // Expose some stats to callers if they want them
      const stats = {
        analysis,
        avgMotion,
        avgLuma,
        lastCalibrationAt: this._lastCalibrationEmit
      };

      // If a forced calibration was set, trigger immediately (clears flag)
      if (this._forcedNextCalibration) {
        this._forcedNextCalibration = false;
        this._emitCalibrationReason({ reason: 'manual-forced', resolution: opts.resolution });
        return stats;
      }

      // If we are currently in cooldown, skip triggering
      const now = Date.now();
      if (now - this._lastCalibrationEmit < this.calibrationCooldownMs) {
        return stats;
      }

      // 1) Stable scene -> good candidate for dark/flat capture
      // Require the average motion across the window to be below stableMotionThreshold
      // and ensure we have accumulated enough history
      if (this._motionHistory.length >= Math.min(this.motionWindowSize, this.minFramesForCalibration)) {
        if (avgMotion <= this.stableMotionThreshold) {
          // Additionally ensure recent frames count is sufficient (avoid false positive on startup)
          this._emitCalibrationReason({
            reason: 'stable_scene',
            count: this.defaultCalibrationCount,
            resolution: opts.resolution || { width: currentFrame.width, height: currentFrame.height }
          });
          return stats;
        }
      }

      // 2) Significant luminance / exposure change -> re-calibrate
      if (this._lumaHistory.length >= Math.min(this.motionWindowSize, this.minFramesForCalibration)) {
        // compute relative change between recent average and latest sample
        const relChange = Math.abs(recentLuma - avgLuma) / (avgLuma + 1e-6);
        if (relChange >= this.luminanceChangeThreshold) {
          this._emitCalibrationReason({
            reason: 'exposure_change',
            count: this.defaultCalibrationCount,
            resolution: opts.resolution || { width: currentFrame.width, height: currentFrame.height }
          });
          return stats;
        }
      }

      // 3) Periodic re-calibration if old (optional)
      if (this.calibrationMaxAgeMs && (now - this._lastCalibrationEmit) >= this.calibrationMaxAgeMs) {
        this._emitCalibrationReason({
          reason: 'max_age',
          count: this.defaultCalibrationCount,
          resolution: opts.resolution || { width: currentFrame.width, height: currentFrame.height }
        });
        return stats;
      }

      // else: no calibration required now
      return stats;

    } catch (err) {
      console.warn('MotionDetector.handleFrame error', err);
      return null;
    }
  }

  // Internal helper to emit calibration event and mark cooldown
  _emitCalibrationReason({ reason = 'unspecified', count = null, resolution = null } = {}) {
    const now = Date.now();
    this._lastCalibrationEmit = now;

    const payload = {
      count: typeof count === 'number' ? count : this.defaultCalibrationCount,
      resolution: resolution || null,
      reason
    };

    // Emit calibrationNeeded
    try {
      this._emit('calibrationNeeded', payload);
      // also provide synonyms
      this._emit('needCalibration', payload);
      // small console trace
      console.log('MotionDetector: emitted calibrationNeeded', payload);
    } catch (e) {
      console.warn('MotionDetector: failed to emit calibrationNeeded', e);
    }
  }

  /**
   * Force the next handleFrame() to trigger calibration immediately.
   * Useful for UI-driven manual calibration requests.
   */
  triggerCalibration({ count = null, resolution = null, reason = 'manual' } = {}) {
    this._forcedNextCalibration = true;
    // Set lastCalibrationRequestedAt so cooldown logic won't block
    this._lastCalibrationEmit = 0;
    // Immediately emit if you want synchronous behavior:
    // but prefer forcing via handleFrame for consistent capture pipeline.
    // We'll emit immediately here if caller explicitly asked:
    this._emitCalibrationReason({ reason, count, resolution });
  }

  /**
   * Reset history & cooldown (useful in tests or when camera/source changes)
   */
  reset() {
    this._motionHistory.length = 0;
    this._lumaHistory.length = 0;
    this._lastCalibrationEmit = 0;
    this._forcedNextCalibration = false;
  }

  /**
   * Expose some introspection (recent stats)
   */
  getRecentStats() {
    const avgMotion = this._motionHistory.length ? (this._motionHistory.reduce((s, v) => s + v, 0) / this._motionHistory.length) : 0;
    const avgLuma = this._lumaHistory.length ? (this._lumaHistory.reduce((s, v) => s + v, 0) / this._lumaHistory.length) : 0;
    return {
      avgMotion,
      avgLuma,
      motionWindowSize: this._motionHistory.length,
      lastCalibrationAt: this._lastCalibrationEmit
    };
  }
}
