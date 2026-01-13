// src/js/core/MotionDetector.js

/**
 * CameraContainer - Per-camera policy enforcement
 * Embedded within MotionDetector for fairness and quota management
 */
class CameraContainer {
  constructor({
    cameraId,
    concurrency = 1,
    cooldownMs = 60000,
    weight = 1.0,
    penaltyDecayRate = 0.95,
    decayIntervalMs = 60000
  } = {}) {
    this.cameraId = cameraId;
    this.concurrency = concurrency;        // Max simultaneous reconstructions
    this.active = 0;                       // Current running count
    this.cooldownMs = cooldownMs;
    this.lastRequestAt = 0;
    this.weight = weight;                  // Priority multiplier
    this.penalty = 0;                      // Increases on usage, decays over time
    this.penaltyDecayRate = penaltyDecayRate;
    this.decayIntervalMs = decayIntervalMs;
    this.lastDecayAt = Date.now();

    this.counters = {
      requested: 0,
      completed: 0,
      failed: 0
    };
  }

  hasQuota() {
    return this.active < this.concurrency;
  }

  isInCooldown(now) {
    if (this.lastRequestAt === 0) return false;
    const elapsed = now - this.lastRequestAt;
    return elapsed < this.cooldownMs;
  }

  priorityMultiplier() {
    // weight adjusted by penalty (0-1 range)
    return this.weight * Math.max(0, 1 - this.penalty);
  }

  tickDecay() {
    const now = Date.now();
    const elapsed = now - this.lastDecayAt;

    if (elapsed >= this.decayIntervalMs) {
      this.penalty = Math.max(0, this.penalty * this.penaltyDecayRate);
      this.lastDecayAt = now;
    }
  }

  onRequestStart() {
    this.active++;
    this.lastRequestAt = Date.now();
    this.counters.requested++;

    // Increase penalty on usage (prevents single camera dominating)
    this.penalty = Math.min(1, this.penalty + 0.1);
  }

  onRequestFinish(success) {
    this.active = Math.max(0, this.active - 1);

    if (success) {
      this.counters.completed++;
    } else {
      this.counters.failed++;
      // Higher penalty for failures
      this.penalty = Math.min(1, this.penalty + 0.2);
    }
  }

  getStats() {
    return {
      cameraId: this.cameraId,
      active: this.active,
      hasQuota: this.hasQuota(),
      isInCooldown: this.isInCooldown(Date.now()),
      priorityMultiplier: this.priorityMultiplier(),
      penalty: this.penalty,
      counters: { ...this.counters }
    };
  }
}

/**
 * MotionDetector
 *
 * Responsibilities:
 *  - HFH annular-based motion analytics (PRIMARY) for reconstruction + calibration
 *  - CPU-based ImageData motion analytics (FALLBACK/CONFIRMATION) for calibration
 *  - Reconstruction scheduler with per-camera fairness
 *  - Calibration triggering with multiple detection methods
 *
 * Architecture:
 *  - Annular events are PRIMARY trigger source (fast, rich spatial info)
 *  - ImageData events are CONFIRMATION/FALLBACK (high-fidelity verification)
 *  - Per-camera normalization and adaptive thresholds
 *  - Multi-camera fairness via CameraContainer and per-camera cooldowns
 */
export class MotionDetector {
  constructor(options = {}) {
    // ===== MOTION DETECTION PARAMS (EXISTING) =====
    this.threshold = typeof options.threshold === 'number' ? options.threshold : 0.08;
    this.sensitivity = typeof options.sensitivity === 'number' ? options.sensitivity : 1.0;
    this.smoothing = typeof options.smoothing === 'number' ? options.smoothing : 0.05;

    // ===== CALIBRATION ORCHESTRATION PARAMS (EXISTING) =====
    this.motionWindowSize = Number.isInteger(options.motionWindowSize) ? options.motionWindowSize : 12;
    this.stableMotionThreshold = typeof options.stableMotionThreshold === 'number' ? options.stableMotionThreshold : 0.01;
    this.luminanceChangeThreshold = typeof options.luminanceChangeThreshold === 'number' ? options.luminanceChangeThreshold : 0.12; // 12%
    this.calibrationCooldownMs = typeof options.calibrationCooldownMs === 'number' ? options.calibrationCooldownMs : 2 * 60 * 1000; // 2 minutes
    this.calibrationMaxAgeMs = typeof options.calibrationMaxAgeMs === 'number' ? options.calibrationMaxAgeMs : 24 * 60 * 60 * 1000; // 24 hours
    this.minFramesForCalibration = typeof options.minFramesForCalibration === 'number' ? options.minFramesForCalibration : 8;
    this.defaultCalibrationCount = typeof options.defaultCalibrationCount === 'number' ? options.defaultCalibrationCount : 16;

    // ===== PHASE 2: CALIBRATION MODE CONTROL (NEW) =====
    this.calibrationMode = options.calibrationMode || 'annular_primary'; // 'annular_primary' | 'imagedata_only' | 'annular_only'
    this.requireImageDataConfirmation = typeof options.requireImageDataConfirmation === 'boolean'
      ? options.requireImageDataConfirmation
      : true; // Default: annular triggers require ImageData confirmation

    // ===== CALIBRATION CANDIDATE TIMEOUT (NEW) =====
    this.calibrationCandidateTimeoutMs = typeof options.calibrationCandidateTimeoutMs === 'number'
      ? options.calibrationCandidateTimeoutMs
      : 5000; // 5 seconds

    // ===== EXISTING CALIBRATION STATE =====
    this._motionHistory = [];               // ImageData motion history (for fallback)
    this._lumaHistory = [];                 // ImageData luma history (for fallback)
    this._lastCalibrationEmit = 0;          // Global last emission (backwards compat)
    this._lastCalibrationPerCamera = new Map(); // Per-camera last emission (NEW)
    this._lastCalibrationRequestedAt = 0;
    this._forcedNextCalibration = false;

    // ===== PHASE 2: ANNULAR CALIBRATION STATE (NEW) =====
    this._annularHistoryPerCamera = new Map();  // cameraId → Array<Float32Array> (for stable scene detection)
    this._calibrationCandidates = new Map();    // cameraId → { reason, timestamp, annularSnapshot, needsConfirmation, ... }
    this._confirmedCalibrations = new Set();    // cameraId set (prevents duplicate emissions)

    // ===== ANNULAR NORMALIZATION & ADAPTIVE THRESHOLDS (NEW) =====
    this._annularStatsPerCamera = new Map(); // cameraId → { emaMin, emaMax, emaMean, emaStd, lastUpdated, sampleCount }
    this._annularEmaAlpha = typeof options.annularEmaAlpha === 'number' ? options.annularEmaAlpha : 0.2;
    this._minEmaSamples = typeof options.minEmaSamples === 'number' ? options.minEmaSamples : 10; // NEW: EMA warm-up

    // Validate and set annular config with defaults
    this._annularConfig = Object.assign({
      // Initial normalized thresholds (used until stats stabilize)
      initialSpikeNormalized: 0.8,
      initialStableVarianceNormalized: 0.005,
      initialVignettingRatio: 0.6,
      uniformityThresholdNormalized: 0.15, // CV threshold for flat field degradation
      // Multipliers for dynamic thresholds
      spikeStdMultiplier: 3.0,
      stableVarianceFactor: 0.5,
      minSpikeNormalized: 0.2,
      // History window used by stable detection (frames)
      historyWindow: this.motionWindowSize
    }, options.annularConfig || {});

    // Validate annular config ranges
    if (this._annularConfig.initialSpikeNormalized < 0 || this._annularConfig.initialSpikeNormalized > 1) {
      console.warn('MotionDetector: initialSpikeNormalized out of range [0,1], clamping');
      this._annularConfig.initialSpikeNormalized = Math.max(0, Math.min(1, this._annularConfig.initialSpikeNormalized));
    }

    if (this._annularConfig.spikeStdMultiplier < 0) {
      console.warn('MotionDetector: spikeStdMultiplier must be positive, using default 3.0');
      this._annularConfig.spikeStdMultiplier = 3.0;
    }

    if (this._annularConfig.minSpikeNormalized < 0 || this._annularConfig.minSpikeNormalized > 1) {
      console.warn('MotionDetector: minSpikeNormalized out of range [0,1], clamping');
      this._annularConfig.minSpikeNormalized = Math.max(0, Math.min(1, this._annularConfig.minSpikeNormalized));
    }

    // ===== EVENT LISTENERS (EXISTING) =====
    this._ee = new Map();
    this._domListeners = new Map();

    this.on = this.on.bind(this);
    this.off = this.off.bind(this);
    this.addEventListener = this.addEventListener.bind(this);
    this.removeEventListener = this.removeEventListener.bind(this);
    this.requestCalibration = this.requestCalibration.bind(this);

    // ===== RECONSTRUCTION SCHEDULER STATE (NEW) =====

    // Intent storage (single source of truth)
    this._intents = new Map();              // intentId → intent object
    this._intentsByJobId = new Map();       // jobId → intentId
    this._intentsByMetaKey = new Map();     // metaKey → intentId

    // Priority scheduling (binary max-heap)
    this._globalHeap = [];                  // heap entries: { priority, timestamp, intentId }
    this._heapIndexMap = new Map();         // intentId → heap index

    // Per-camera queues (fairness)
    this._perCameraQueues = new Map();      // cameraId → Set<intentId>
    this._cameras = new Map();              // cameraId → CameraContainer instance

    // In-flight tracking
    this._inFlight = new Set();             // intentIds currently being processed

    // Cooldowns (global metaKey cooldown)
    this._cooldowns = new Map();            // metaKey → lastProcessedAt

    // Dispatcher (injected by main.js)
    this._dispatcher = null;                // MotionWorkerWrapper instance

    // Configuration
    this._schedulerConfig = Object.assign({
      maxInFlight: 2,                       // Global concurrent reconstruction limit
      cooldownMs: 60000,                    // Global metaKey cooldown (1 min)
      maxQueuePerCamera: 10,                // Max intents queued per camera
      intentExpiryMs: 60000,                // Intent expiry (1 min)
      priorities: {
        motion_spike: 100,                  // Highest priority - user-facing
        exposure_change: 75,                // High priority
        stable_scene: 50,                   // Medium priority
        periodic: 10                        // Low priority
      },
      defaultCameraConfig: {
        concurrency: 1,                     // Max simultaneous reconstructions per camera
        cooldownMs: 60000,                  // Per-camera cooldown
        weight: 1.0,                        // Priority multiplier
        penaltyDecayRate: 0.95,             // Penalty decay rate
        decayIntervalMs: 60000              // Decay interval
      },
      maxDispatchRetries: 2                 // Max retry attempts for failed dispatches
    }, options.schedulerConfig || {});

    // Tracking for exposure change detection (per-camera)
    this._recentLuma = new Map();           // cameraId → last avgLuma value

    // Periodic decay timer
    this._decayTimer = setInterval(() => this._tickDecay(), 10000); // Every 10 seconds

    console.log('MotionDetector: initialized with calibrationMode=' + this.calibrationMode);
  }

  // ===== BASIC SETTERS (EXISTING) =====

  setThreshold(threshold) {
    this.threshold = Math.max(0, Math.min(1, threshold));
  }

  setSensitivity(sensitivity) {
    this.sensitivity = Math.max(0, Math.min(2, sensitivity));
  }

  setSmoothing(smoothing) {
    this.smoothing = Math.max(0, Math.min(1, smoothing));
  }

  // ===== EVENT API (EXISTING) =====

  on(event, handler) {
    if (!this._ee.has(event)) this._ee.set(event, new Set());
    this._ee.get(event).add(handler);
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

  requestCalibration(handler) {
    if (typeof handler !== 'function') return () => {};
    const wrapper = (payload) => {
      try { handler(payload); } catch (e) { console.warn('requestCalibration handler threw', e); }
      try { this.off('calibrationNeeded', wrapper); } catch (e) {}
    };
    this.on('calibrationNeeded', wrapper);
    return () => { try { this.off('calibrationNeeded', wrapper); } catch (e) {} };
  }

  // ===== INTERNAL EMIT (EXISTING) =====

  _emit(event, payload) {
    const setA = this._ee.get(event);
    if (setA && setA.size > 0) {
      for (const h of Array.from(setA)) {
        try { h(payload); } catch (e) { console.warn('MotionDetector listener threw', e); }
      }
    }

    const setB = this._domListeners.get(event);
    if (setB && setB.size > 0) {
      for (const h of Array.from(setB)) {
        try { h(payload); } catch (e) { console.warn('MotionDetector DOM listener threw', e); }
      }
    }

    // Compatibility alias
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

  // ===== RECONSTRUCTION SCHEDULER PUBLIC API (NEW) =====

  /**
   * Set dispatcher (MotionWorkerWrapper) - called by main.js
   */
  setDispatcher(dispatcher) {
    this._dispatcher = dispatcher;
    console.log('MotionDetector: dispatcher set');
  }

  /**
   * PHASE 2: Handle annular event from FrameEvictionHook
   * PRIMARY trigger source for both reconstruction AND calibration
   */
  handleAnnularEvent({ annular, meta, avgLuma, timestamp }) {
    try {
      const cameraId = meta.cameraId || 'unknown';

      // Normalize annular to [0,1] using per-camera dynamic stats
      const norm = this._normalizeAnnular(cameraId, annular);

      // Skip if normalization failed (empty/invalid array)
      if (!norm || norm.length === 0) {
        console.warn('MotionDetector: normalization failed for', cameraId);
        return;
      }

      // ===== RECONSTRUCTION TRIGGERS =====

      // Trigger 1: Motion spike based on normalized annular
      const stats = this._annularStatsPerCamera.get(cameraId);
      const spike = this._detectAnnularSpikeAdaptive(norm, cameraId);

      // NEW: suppress spike intents until EMA warm-up completes
      if (spike && stats && stats.sampleCount >= this._minEmaSamples) {
        this._createIntent({
          jobId: meta.jobId,
          cameraId,
          reason: 'motion_spike',
          priority: this._schedulerConfig.priorities.motion_spike,
          meta,
          annular: norm,
          avgLuma
        });
      }

      // Trigger 2: Exposure change (per-camera tracking)
      const exposureChange = this._detectExposureChange(avgLuma, cameraId);
      if (exposureChange) {
        this._createIntent({
          jobId: meta.jobId,
          cameraId,
          reason: 'exposure_change',
          priority: this._schedulerConfig.priorities.exposure_change,
          meta,
          annular: norm,
          avgLuma
        });
      }

      // ===== PHASE 2: CALIBRATION TRIGGERS (ANNULAR PRIMARY) =====

      if (this.calibrationMode === 'imagedata_only') {
        // Skip annular calibration triggers if in imagedata_only mode
        return;
      }

      // Calibration Trigger 1: Stable annular scene
      const stableAnnular = this._detectStableAnnular(norm, cameraId);
      if (stableAnnular && this._canEmitCalibration(cameraId)) {
        this._handleAnnularCalibrationTrigger({
          reason: 'stable_annular_scene',
          cameraId,
          meta,
          annularSnapshot: Array.from(norm),
          avgLuma
        });
      }

      // Calibration Trigger 2: Flat field degradation (zone uniformity)
      const nonUniform = this._detectNonUniformAnnular(norm);
      if (nonUniform && this._canEmitCalibration(cameraId)) {
        this._handleAnnularCalibrationTrigger({
          reason: 'flat_field_degradation',
          cameraId,
          meta,
          annularSnapshot: Array.from(norm),
          avgLuma,
          nonUniformityScore: nonUniform.score
        });
      }

      // Calibration Trigger 3: Vignetting detected
      const vignetting = this._detectVignetting(norm);
      if (vignetting && this._canEmitCalibration(cameraId)) {
        this._handleAnnularCalibrationTrigger({
          reason: 'vignetting_detected',
          cameraId,
          meta,
          annularSnapshot: Array.from(norm),
          avgLuma,
          severity: vignetting.severity
        });
      }

      // Calibration Trigger 4: Rapid exposure change (annular-based)
      if (exposureChange && this._canEmitCalibration(cameraId)) {
        this._handleAnnularCalibrationTrigger({
          reason: 'annular_exposure_change',
          cameraId,
          meta,
          annularSnapshot: Array.from(norm),
          avgLuma
        });
      }

    } catch (err) {
      console.warn('MotionDetector.handleAnnularEvent error', err);
    }
  }

  /**
   * PHASE 2: Handle annular calibration trigger
   * Either emits immediately (annular_only mode) or marks for ImageData confirmation
   */
  _handleAnnularCalibrationTrigger({ reason, cameraId, meta, annularSnapshot, avgLuma, ...extraData }) {
    if (this.calibrationMode === 'annular_only' || !this.requireImageDataConfirmation) {
      // Emit immediately without confirmation
      this._emitCalibrationReason({
        reason,
        cameraId,
        count: this.defaultCalibrationCount,
        resolution: { width: meta.width, height: meta.height },
        source: 'annular',
        ...extraData
      });
    } else {
      // Mark as candidate, wait for ImageData confirmation
      this._calibrationCandidates.set(cameraId, {
        reason,
        timestamp: Date.now(),
        annularSnapshot,
        avgLuma,
        meta,
        needsConfirmation: true,
        extraData
      });

      console.log(`MotionDetector: calibration candidate marked (${reason}) for camera ${cameraId}, awaiting ImageData confirmation`);
    }
  }

  /**
   * Handle artifact:ready from preprocessor (via main.js BC listener)
   */
  onArtifactReady({ metaKey, jobId, meta }) {
    try {
      const intentId = this._intentsByJobId.get(jobId);

      if (!intentId) {
        return;
      }

      const intent = this._intents.get(intentId);
      if (!intent) {
        console.warn('MotionDetector: intent not found', intentId);
        return;
      }

      // NEW: provenance lock — do not overwrite once bound
      if (intent.metaKey && intent.metaKey !== metaKey) {
        console.warn(
          'MotionDetector: metaKey mismatch for intent, ignoring late artifact',
          { intentId, existing: intent.metaKey, incoming: metaKey }
        );
        return;
      }

      intent.metaKey = metaKey;
      intent.artifactReadyAt = Date.now();

      this._intentsByMetaKey.set(metaKey, intentId);
      this._intentsByJobId.delete(jobId);

      console.log(`MotionDetector: attached metaKey ${metaKey} to intent ${intentId}`);

      this._scheduleReconstruction(intentId);

    } catch (err) {
      console.error('MotionDetector.onArtifactReady error', err);
    }
  }

  /**
   * Notification when reconstruction finishes
   */
  notifyReconstructionFinished(metaKey, { success, derivedKeys }) {
    try {
      const intentId = this._intentsByMetaKey.get(metaKey);

      if (!intentId) {
        return;
      }

      const intent = this._intents.get(intentId);
      if (!intent) {
        return;
      }

      if (success) {
        this._cooldowns.set(metaKey, Date.now());
      }

      const camera = this._getOrCreateCamera(intent.cameraId);
      camera.onRequestFinish(success);

      this._inFlight.delete(intentId);
      this._removeIntent(intentId);

      console.log(`MotionDetector: reconstruction finished for ${metaKey}, success=${success}`);

      setTimeout(() => this._processQueue(), 100);

    } catch (err) {
      console.error('MotionDetector.notifyReconstructionFinished error', err);
    }
  }

  /**
   * Recover from worker death
   */
  recoverFromWorkerDeath() {
    console.warn('MotionDetector: recovering from worker death');

    try {
      for (const intentId of Array.from(this._inFlight)) {
        const intent = this._intents.get(intentId);
        if (!intent) continue;

        const reducedPriority = intent.priority * 0.5;

        // Re-push into heap safely
        this._heapPush({
          priority: reducedPriority,
          timestamp: Date.now(),
          intentId
        });

        const camera = this._getOrCreateCamera(intent.cameraId);
        camera.onRequestFinish(false);
      }

      this._inFlight.clear();

      console.log('MotionDetector: recovered from worker death, re-queued intents');
    } catch (err) {
      console.error('MotionDetector.recoverFromWorkerDeath error', err);
    }
  }

  // ===== IMAGEDATA MOTION ANALYSIS (EXISTING, NOW FALLBACK/CONFIRMATION) =====

  /**
   * PHASE 2: Analyze motion from ImageData frames
   * NOW SERVES AS: Fallback trigger + Confirmation for annular triggers
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

    const gridSize = 16;
    const stepX = Math.max(1, Math.floor(width / gridSize));
    const stepY = Math.max(1, Math.floor(height / gridSize));

    let totalLuma = 0;
    let lumaSamples = 0;

    for (let y = 0; y < height; y += stepY) {
      for (let x = 0; x < width; x += stepX) {
        const index = (y * width + x) * 4;

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

    if (motionAnalysis.coverage > 0.5) {
      return Math.min(1.0, baseThreshold * 1.5);
    }

    if (motionAnalysis.coverage < 0.1) {
      return Math.max(0.01, baseThreshold * 0.7);
    }

    return baseThreshold;
  }

  /**
   * PHASE 2: Handle ImageData frame
   * NOW SERVES AS: Fallback calibration trigger + Confirmation for annular candidates
   */
  handleFrame(currentFrame, previousFrame, opts = {}) {
    try {
      const cameraId = opts.cameraId || 'unknown';

      // Analyze motion
      const analysis = this.analyzeMotion(currentFrame, previousFrame);

      // ===== PHASE 2: CHECK FOR CALIBRATION CANDIDATES AWAITING CONFIRMATION =====

      if (this._calibrationCandidates.has(cameraId)) {
        const candidate = this._calibrationCandidates.get(cameraId);
        const candidateAge = Date.now() - candidate.timestamp;

        // Check for stale candidates (timeout)
        if (candidateAge > this.calibrationCandidateTimeoutMs) {
          console.warn(`MotionDetector: calibration candidate timed out for ${cameraId} (age: ${candidateAge}ms)`);
          this._calibrationCandidates.delete(cameraId);
          // Fall through to fallback triggers below
        } else {
          // Confirm if ImageData motion is also low (stable scene)
          if (analysis.motionLevel < this.stableMotionThreshold) {
            // CONFIRMED: Emit calibration
            this._emitCalibrationReason({
              reason: candidate.reason + '_confirmed',
              cameraId,
              count: this.defaultCalibrationCount,
              resolution: opts.resolution || { width: currentFrame.width, height: currentFrame.height },
              source: 'annular_confirmed_imagedata',
              imageDataMotion: analysis.motionLevel,
              ...candidate.extraData
            });

            this._calibrationCandidates.delete(cameraId);
            this._confirmedCalibrations.add(cameraId);

            console.log(`MotionDetector: calibration CONFIRMED via ImageData for camera ${cameraId}`);

            // Don't process further ImageData triggers (already confirmed)
            return { analysis, confirmed: true };
          } else {
            // REJECTED: ImageData shows too much motion, discard candidate
            console.log(`MotionDetector: calibration candidate REJECTED via ImageData for camera ${cameraId} (motion=${analysis.motionLevel.toFixed(4)})`);
            this._calibrationCandidates.delete(cameraId);
          }
        }
      }

      // ===== PHASE 2: FALLBACK IMAGEDATA CALIBRATION TRIGGERS =====
      // Only run if NOT in annular_only mode

      if (this.calibrationMode === 'annular_only') {
        return { analysis };
      }

      // Update motion/luma history (for fallback triggers)
      this._motionHistory.push(analysis.motionLevel);
      if (this._motionHistory.length > this.motionWindowSize) this._motionHistory.shift();

      this._lumaHistory.push(analysis.avgLuminance);
      if (this._lumaHistory.length > this.motionWindowSize) this._lumaHistory.shift();

      const avgMotion = this._motionHistory.reduce((s, v) => s + v, 0) / Math.max(1, this._motionHistory.length);
      const avgLuma = this._lumaHistory.reduce((s, v) => s + v, 0) / Math.max(1, this._lumaHistory.length);
      const recentLuma = analysis.avgLuminance;

      const stats = {
        analysis,
        avgMotion,
        avgLuma,
        lastCalibrationAt: this._lastCalibrationEmit
      };

      // Forced calibration
      if (this._forcedNextCalibration) {
        this._forcedNextCalibration = false;
        this._emitCalibrationReason({
          reason: 'manual-forced',
          cameraId,
          resolution: opts.resolution,
          source: 'imagedata_forced'
        });
        return stats;
      }

      // Global cooldown check (backwards compat - replaced by per-camera below)
      const now = Date.now();
      if (now - this._lastCalibrationEmit < this.calibrationCooldownMs) {
        return stats;
      }

      // Fallback Trigger 1: Stable scene (ImageData)
      if (this._motionHistory.length >= Math.min(this.motionWindowSize, this.minFramesForCalibration)) {
        if (avgMotion <= this.stableMotionThreshold) {
          if (this._canEmitCalibration(cameraId)) {
            this._emitCalibrationReason({
              reason: 'stable_scene_imagedata',
              cameraId,
              count: this.defaultCalibrationCount,
              resolution: opts.resolution || { width: currentFrame.width, height: currentFrame.height },
              source: 'imagedata_fallback'
            });
          }
          return stats;
        }
      }

      // Fallback Trigger 2: Exposure change (ImageData global luma)
      if (this._lumaHistory.length >= Math.min(this.motionWindowSize, this.minFramesForCalibration)) {
        const relChange = Math.abs(recentLuma - avgLuma) / (avgLuma + 1e-6);
        if (relChange >= this.luminanceChangeThreshold) {
          if (this._canEmitCalibration(cameraId)) {
            this._emitCalibrationReason({
              reason: 'exposure_change_imagedata',
              cameraId,
              count: this.defaultCalibrationCount,
              resolution: opts.resolution || { width: currentFrame.width, height: currentFrame.height },
              source: 'imagedata_fallback'
            });
          }
          return stats;
        }
      }

      // Fallback Trigger 3: Periodic max age
      if (this.calibrationMaxAgeMs && (now - this._lastCalibrationEmit) >= this.calibrationMaxAgeMs) {
        if (this._canEmitCalibration(cameraId)) {
          this._emitCalibrationReason({
            reason: 'max_age',
            cameraId,
            count: this.defaultCalibrationCount,
            resolution: opts.resolution || { width: currentFrame.width, height: currentFrame.height },
            source: 'imagedata_periodic'
          });
        }
        return stats;
      }

      return stats;

    } catch (err) {
      console.warn('MotionDetector.handleFrame error', err);
      return null;
    }
  }

  // ===== PHASE 2: ANNULAR CALIBRATION DETECTION METHODS (NEW) =====

  /**
   * Normalize annular array to [0,1] using per-camera EMA min/max and return normalized copy.
   * Also updates per-camera stats (EMA of min/max/mean/std) for adaptive thresholds.
   * REFINEMENT: Added explicit validation and sample count tracking.
   */
  _normalizeAnnular(cameraId, annular) {
    // Guard: validate input
    if (!annular || annular.length === 0) {
      console.warn('MotionDetector: received empty annular array for', cameraId);
      return new Float32Array(8); // Return zeros with default length
    }

    if (!Array.isArray(annular) && !(annular instanceof Float32Array) && !(annular instanceof Uint8Array)) {
      console.warn('MotionDetector: invalid annular type for', cameraId);
      return new Float32Array(annular.length || 8);
    }

    // Convert to array of numbers
    const arr = Array.from(annular).map(v => Number.isFinite(v) ? v : 0);

    // Compute min/max/mean/std
    let minV = Infinity, maxV = -Infinity, sum = 0;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
      sum += v;
    }
    if (!isFinite(minV) || !isFinite(maxV)) {
      minV = 0;
      maxV = 1;
    }

    const mean = arr.length ? (sum / arr.length) : 0;

    // Compute std
    let s2 = 0;
    for (let i = 0; i < arr.length; i++) {
      const d = arr[i] - mean;
      s2 += d * d;
    }
    const variance = arr.length ? (s2 / arr.length) : 0;
    const std = Math.sqrt(variance);

    // Update EMA stats for camera
    const prev = this._annularStatsPerCamera.get(cameraId) || null;
    if (!prev) {
      // Initialize EMA with these values
      this._annularStatsPerCamera.set(cameraId, {
        emaMin: minV,
        emaMax: maxV,
        emaMean: mean,
        emaStd: std,
        lastUpdated: Date.now(),
        sampleCount: 1 // REFINEMENT: Track sample count
      });
    } else {
      const alpha = this._annularEmaAlpha;
      const emaMin = (1 - alpha) * prev.emaMin + alpha * minV;
      const emaMax = (1 - alpha) * prev.emaMax + alpha * maxV;
      const emaMean = (1 - alpha) * prev.emaMean + alpha * mean;
      const emaStd = (1 - alpha) * prev.emaStd + alpha * std;
      this._annularStatsPerCamera.set(cameraId, {
        emaMin,
        emaMax,
        emaMean,
        emaStd,
        lastUpdated: Date.now(),
        sampleCount: prev.sampleCount + 1 // REFINEMENT: Increment count
      });
    }

    // Normalize using local min/max (avoid division by zero)
    const denom = (maxV - minV) || 1.0;
    const normalized = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      normalized[i] = (arr[i] - minV) / denom;
    }

    return normalized;
  }

  /**
   * Detect stable annular scene (low variance across zones over time).
   * Uses normalized annular inputs and a history window. Thresholds adapt from EMA stats.
   * REFINEMENT: Only use EMA-derived threshold after warm-up period.
   */
  _detectStableAnnular(annular, cameraId) {
    if (!this._annularHistoryPerCamera.has(cameraId)) {
      this._annularHistoryPerCamera.set(cameraId, []);
    }

    const history = this._annularHistoryPerCamera.get(cameraId);
    history.push(Array.from(annular));

    const histWindow = Math.max(1, Math.min(this._annularConfig.historyWindow, this.motionWindowSize));
    if (history.length > histWindow) history.shift();

    if (history.length < this.minFramesForCalibration) {
      return false;
    }

    // Compute variance across time for each annular zone (normalized)
    const K = annular.length;
    let totalVariance = 0;

    for (let k = 0; k < K; k++) {
      const samples = history.map(h => h[k]);
      const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
      const variance = samples.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / samples.length;
      totalVariance += variance;
    }

    const avgVariance = totalVariance / K;

    // Determine dynamic threshold from EMA stats if available
    const stats = this._annularStatsPerCamera.get(cameraId);
    let stableThreshold = this._annularConfig.initialStableVarianceNormalized;

    // REFINEMENT: Only use EMA-derived threshold after minimum samples
    if (stats && history.length >= this._minEmaSamples && typeof stats.emaStd === 'number') {
      const estVar = Math.pow(stats.emaStd, 2);
      stableThreshold = Math.max(
        this._annularConfig.initialStableVarianceNormalized,
        estVar * this._annularConfig.stableVarianceFactor
      );
    }

    return avgVariance < stableThreshold;
  }

  /**
   * Detect non-uniform illumination (flat field degradation)
   * Operates on normalized annular input [0,1]
   */
  _detectNonUniformAnnular(annular) {
    const K = annular.length;
    if (K === 0) return null;

    let sum = 0;
    for (let i = 0; i < K; i++) sum += annular[i];
    const mean = sum / K;

    let s2 = 0;
    for (let i = 0; i < K; i++) {
      const d = annular[i] - mean;
      s2 += d * d;
    }
    const variance = s2 / K;
    const stdDev = Math.sqrt(variance);
    const cv = stdDev / (mean + 1e-6); // Coefficient of variation

    const uniformityThreshold = this._annularConfig.uniformityThresholdNormalized || 0.15;

    if (cv > uniformityThreshold) {
      return { score: cv };
    }

    return null;
  }

  /**
   * Detect vignetting (outer zones significantly darker than center)
   * Operates on normalized annular input [0,1]
   */
  _detectVignetting(annular) {
    const K = annular.length;
    if (K === 0) return null;

    const centerZone = annular[0]; // Innermost zone
    const outerZone = annular[K - 1]; // Outermost zone

    // Vignetting: outer significantly darker than center
    const ratio = outerZone / (centerZone + 1e-6);

    const vignettingThreshold = this._annularConfig.initialVignettingRatio || 0.6;

    if (ratio < vignettingThreshold) {
      return { ratio, severity: 1 - ratio };
    }

    return null;
  }

  /**
   * Adaptive spike detection on annular (normalized [0,1])
   * Uses EMA stats when available for dynamic threshold.
   * REFINEMENT: Only use EMA-derived threshold after warm-up period.
   */
  _detectAnnularSpikeAdaptive(annular, cameraId) {
    if (!Array.isArray(annular) && !(annular instanceof Float32Array)) return false;
    if (annular.length === 0) return false;

    const stats = this._annularStatsPerCamera.get(cameraId);
    const history = this._annularHistoryPerCamera.get(cameraId);

    // Global peak value in normalized annular
    let peak = -Infinity;
    let sum = 0;
    for (let i = 0; i < annular.length; i++) {
      const v = annular[i];
      if (v > peak) peak = v;
      sum += v;
    }
    const mean = sum / annular.length;

    // Compute frame-local std
    let s2 = 0;
    for (let i = 0; i < annular.length; i++) {
      const d = annular[i] - mean;
      s2 += d * d;
    }
    const std = Math.sqrt((annular.length > 0) ? (s2 / annular.length) : 0);

    // Baseline spike threshold (in normalized domain)
    let spikeThreshold = this._annularConfig.initialSpikeNormalized;

    // REFINEMENT: Dynamic threshold only after EMA warm-up
    if (stats && history && history.length >= this._minEmaSamples) {
      // Use frame-local mean + multiplier * frame-local std
      spikeThreshold = Math.max(
        this._annularConfig.minSpikeNormalized,
        mean + this._annularConfig.spikeStdMultiplier * std
      );
    }

    // Clamp threshold
    spikeThreshold = Math.min(1.0, Math.max(0.0, spikeThreshold));

    return peak > spikeThreshold;
  }

  /**
   * Check if we can emit calibration (respects per-camera cooldown)
   * REFINEMENT: Uses per-camera cooldown instead of global.
   */
  _canEmitCalibration(cameraId) {
    const now = Date.now();

    // Check per-camera cooldown
    const lastEmit = this._lastCalibrationPerCamera.get(cameraId) || 0;
    if (now - lastEmit < this.calibrationCooldownMs) {
      return false;
    }

    // Check if already confirmed recently
    if (this._confirmedCalibrations.has(cameraId)) {
      const candidate = this._calibrationCandidates.get(cameraId);
      if (candidate && now - candidate.timestamp < this.calibrationCooldownMs) {
        return false;
      }
      this._confirmedCalibrations.delete(cameraId);
    }

    return true;
  }

  // ===== CALIBRATION EMISSION (EXISTING, ENHANCED) =====

  /**
   * Emit calibration event with per-camera cooldown tracking
   * REFINEMENT: Tracks both global and per-camera timestamps.
   */
  _emitCalibrationReason({ reason = 'unspecified', count = null, resolution = null, cameraId = 'unknown', source = 'unknown', ...extraData } = {}) {
    const now = Date.now();
    this._lastCalibrationEmit = now; // Global (backwards compat)
    this._lastCalibrationPerCamera.set(cameraId, now); // Per-camera

    const payload = {
      count: typeof count === 'number' ? count : this.defaultCalibrationCount,
      resolution: resolution || null,
      reason,
      cameraId,
      source, // 'annular', 'annular_confirmed_imagedata', 'imagedata_fallback', etc.
      timestamp: now,
      ...extraData
    };

    try {
      this._emit('calibrationNeeded', payload);
      this._emit('needCalibration', payload);
      console.log('MotionDetector: emitted calibrationNeeded', payload);
    } catch (e) {
      console.warn('MotionDetector: failed to emit calibrationNeeded', e);
    }
  }

  triggerCalibration({ count = null, resolution = null, reason = 'manual', cameraId = 'unknown' } = {}) {
    this._forcedNextCalibration = true;
    this._lastCalibrationEmit = 0;
    this._emitCalibrationReason({ reason, count, resolution, cameraId, source: 'manual' });
  }

  /**
   * Reset detector state
   * REFINEMENT: Clears all new annular-specific state.
   */
  reset() {
    this._motionHistory.length = 0;
    this._lumaHistory.length = 0;
    this._lastCalibrationEmit = 0;
    this._lastCalibrationPerCamera.clear(); // REFINEMENT
    this._forcedNextCalibration = false;
    this._annularHistoryPerCamera.clear();
    this._calibrationCandidates.clear();
    this._confirmedCalibrations.clear();
    this._annularStatsPerCamera.clear(); // REFINEMENT
    this._recentLuma.clear();

    console.log('MotionDetector: reset complete');
  }

  getRecentStats() {
    const avgMotion = this._motionHistory.length ? (this._motionHistory.reduce((s, v) => s + v, 0) / this._motionHistory.length) : 0;
    const avgLuma = this._lumaHistory.length ? (this._lumaHistory.reduce((s, v) => s + v, 0) / this._lumaHistory.length) : 0;
    return {
      avgMotion,
      avgLuma,
      motionWindowSize: this._motionHistory.length,
      lastCalibrationAt: this._lastCalibrationEmit,
      pendingCandidates: this._calibrationCandidates.size,
      calibrationMode: this.calibrationMode,
      annularStatsCameras: this._annularStatsPerCamera.size,
      trackedCameras: this._cameras.size
    };
  }

  // ===== RECONSTRUCTION SCHEDULER INTERNAL METHODS (NEW) =====

  /**
   * Create intent with unique intentId
   * REFINEMENT: Generate jobId if not provided.
   */
  _createIntent({ jobId, cameraId, reason, priority, meta, annular, avgLuma }) {
    // Ensure jobId exists
    if (!jobId) {
      jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      console.warn('MotionDetector: generated jobId for intent (should be provided by caller)', jobId);
    }

    if (this._intentsByJobId.has(jobId)) {
      return;
    }

    const intentId = `intent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const intent = {
      intentId,
      jobId,
      metaKey: null,
      cameraId,
      reason,
      priority,
      createdAt: Date.now(),
      artifactReadyAt: null,
      meta,
      annular,
      avgLuma,
      _retries: 0
    };

    this._intents.set(intentId, intent);
    this._intentsByJobId.set(jobId, intentId);

    console.log(`MotionDetector: created intent ${intentId} for jobId=${jobId}, reason=${reason}`);
  }

  /**
   * Schedule reconstruction for intent (after metaKey attached)
   */
  _scheduleReconstruction(intentId) {
    const intent = this._intents.get(intentId);
    if (!intent || !intent.metaKey) {
      return;
    }

    const { metaKey, cameraId } = intent;
    if (this._inFlight.has(intentId)) {
      console.log('MotionDetector: reconstruction already in flight', intentId);
      return;
    }

    if (this._isInCooldown(metaKey)) {
      console.log('MotionDetector: metaKey in cooldown', metaKey);
      this._removeIntent(intentId);
      return;
    }

    const camera = this._getOrCreateCamera(cameraId);

    if (!camera.hasQuota()) {
      console.log('MotionDetector: camera out of quota', cameraId);
      return;
    }

    if (camera.isInCooldown(Date.now())) {
      console.log('MotionDetector: camera in cooldown', cameraId);
      return;
    }

    if (!this._perCameraQueues.has(cameraId)) {
      this._perCameraQueues.set(cameraId, new Set());
    }
    const queue = this._perCameraQueues.get(cameraId);

    if (queue.size >= this._schedulerConfig.maxQueuePerCamera) {
      this._evictLowestPriority(cameraId);
    }

    queue.add(intentId);

    const effectivePriority = intent.priority * camera.priorityMultiplier();

    this._heapPush({
      priority: effectivePriority,
      timestamp: intent.createdAt,
      intentId
    });

    console.log(`MotionDetector: scheduled intent ${intentId}, priority=${effectivePriority.toFixed(2)}`);

    this._processQueue();
  }

  /**
   * Non-blocking processing loop that attempts to dispatch as many jobs as allowed.
   * Dispatches are performed asynchronously by _dispatchIntent so this function never awaits long tasks.
   */
  async _processQueue() {
    try {
      // Fast path: if no dispatcher, do nothing
      if (!this._dispatcher) {
        console.error('MotionDetector: no dispatcher configured');
        return;
      }
      // Attempt to dispatch until we reach max in-flight or heap is empty
      while (this._inFlight.size < this._schedulerConfig.maxInFlight) {
        const entry = this._heapPop();
        if (!entry) break;
        const { intentId } = entry;
        const intent = this._intents.get(intentId);
        // Skip invalid or not-ready intents (requeue later)
        if (!intent || !intent.metaKey) {
          // If not ready yet, requeue with small priority decay
          if (intent) {
            this._heapPush({
              priority: intent.priority * 0.9,
              timestamp: Date.now(),
              intentId
            });
          }
          continue;
        }
        // If camera has no quota, requeue and stop trying for now
        const camera = this._getOrCreateCamera(intent.cameraId);
        if (!camera.hasQuota() || camera.isInCooldown(Date.now())) {
          // Push back and stop; later a timer or finish will re-attempt
          this._heapPush(entry);
          break;
        }
        // Start dispatch (non-blocking)
        this._inFlight.add(intentId);
        camera.onRequestStart();
        // Dispatch without awaiting here — let _dispatchIntent manage completion
        this._dispatchIntent(intentId);
        // Continue loop to fill other slots
      }
    } catch (err) {
      console.error('MotionDetector._processQueue error', err);
    }
  }

  /**
   * _dispatchIntent(intentId) - send to dispatcher and handle completion/failure
   * Runs asynchronously; updates in-flight/camera state and removes intent on finalization.
   */
  _dispatchIntent(intentId) {
    const intent = this._intents.get(intentId);
    if (!intent) {
      this._inFlight.delete(intentId);
      return;
    }

    const camera = this._getOrCreateCamera(intent.cameraId);
    const sendOptions = {
      reason: intent.reason,
      priority: intent.priority,
      reqId: intentId,
      cameraId: intent.cameraId,

      // NEW: pass camera policy context through (opaque to wrapper/worker if unused)
      cameraContainer: camera.getStats()
    };

    // Use promise chain; handle success/failure and cleanup
    this._dispatcher.requestReconstructionByMeta(intent.metaKey, sendOptions)
      .then((res) => {
        try {
          camera.onRequestFinish(true);
          this._inFlight.delete(intentId);
          this._removeIntent(intentId);
        } catch (e) {
          console.warn('MotionDetector._dispatchIntent success handler error', e);
        } finally {
          // Try to schedule more
          setTimeout(() => this._processQueue(), 0);
        }
      })
      .catch((err) => {
        try {
          console.error('MotionDetector: reconstruction dispatch failed', intent.metaKey, err);
          camera.onRequestFinish(false);
          this._inFlight.delete(intentId);

          // Simple retry policy: requeue intent up to N tries
          intent._retries = (intent._retries || 0) + 1;
          const maxRetries = Number(this._schedulerConfig.maxDispatchRetries) || 2;
          if (intent._retries <= maxRetries) {
            // Backoff a bit and requeue with slightly reduced priority
            const backoffPriority = Math.max(1, intent.priority * Math.pow(0.9, intent._retries));
            this._heapPush({ priority: backoffPriority, timestamp: Date.now(), intentId });
            console.log(`MotionDetector: requeued intent ${intentId} (retry ${intent._retries}/${maxRetries})`);
          } else {
            // Give up and remove intent
            console.warn('MotionDetector: giving up on intent after retries', intentId);
            this._removeIntent(intentId);
          }
        } catch (e) {
          console.warn('MotionDetector._dispatchIntent error handler threw', e);
        } finally {
          setTimeout(() => this._processQueue(), 200);
        }
      });
  }

  /**
   * Remove intent and cleanup all indices
   */
  _removeIntent(intentId) {
    const intent = this._intents.get(intentId);
    if (!intent) return;

    if (intent.jobId) {
      this._intentsByJobId.delete(intent.jobId);
    }
    if (intent.metaKey) {
      this._intentsByMetaKey.delete(intent.metaKey);
    }

    const queue = this._perCameraQueues.get(intent.cameraId);
    if (queue) {
      queue.delete(intentId);
    }

    this._heapRemove(intentId);

    this._intents.delete(intentId);
  }

  /**
   * Evict lowest priority intent from camera's queue
   */
  _evictLowestPriority(cameraId) {
    const queue = this._perCameraQueues.get(cameraId);
    if (!queue || queue.size === 0) return;

    let lowestPriority = Infinity;
    let victimId = null;

    for (const intentId of queue) {
      const intent = this._intents.get(intentId);
      if (intent && intent.priority < lowestPriority) {
        lowestPriority = intent.priority;
        victimId = intentId;
      }
    }

    if (victimId) {
      console.log('MotionDetector: evicting intent', victimId);
      this._removeIntent(victimId);
    }
  }

  /**
   * Get or create camera container
   */
  _getOrCreateCamera(cameraId) {
    if (!this._cameras.has(cameraId)) {
      this._cameras.set(cameraId, new CameraContainer({
        cameraId,
        ...this._schedulerConfig.defaultCameraConfig
      }));
    }
    return this._cameras.get(cameraId);
  }

  /**
   * Check if metaKey is in cooldown
   */
  _isInCooldown(metaKey) {
    const lastProcessed = this._cooldowns.get(metaKey);
    if (!lastProcessed) return false;

    const elapsed = Date.now() - lastProcessed;
    return elapsed < this._schedulerConfig.cooldownMs;
  }

  /**
   * Detect exposure change from avgLuma (per-camera tracking)
   */
  _detectExposureChange(avgLuma, cameraId) {
    const recent = this._recentLuma.get(cameraId);
    if (recent === undefined) {
      this._recentLuma.set(cameraId, avgLuma);
      return false;
    }

    const relChange = Math.abs(avgLuma - recent) / (recent + 1e-6);
    this._recentLuma.set(cameraId, avgLuma);

    return relChange > this.luminanceChangeThreshold;
  }

  /**
   * Periodic decay tick
   * REFINEMENT: Added cleanup for stale calibration candidates and expired intents.
   */
  _tickDecay() {
    const now = Date.now();

    // Decay camera penalties
    for (const camera of this._cameras.values()) {
      camera.tickDecay();
    }

    // Expire stale intents (no metaKey after intentExpiryMs)
    for (const [intentId, intent] of this._intents.entries()) {
      if (!intent.metaKey && (now - intent.createdAt > this._schedulerConfig.intentExpiryMs)) {
        console.warn('MotionDetector: expiring stale intent', intentId);
        this._removeIntent(intentId);
      }
    }

    // REFINEMENT: Cleanup expired calibration candidates
    for (const [cameraId, candidate] of this._calibrationCandidates.entries()) {
      if (now - candidate.timestamp > this.calibrationCooldownMs) {
        console.warn('MotionDetector: expiring unconfirmed calibration candidate', cameraId);
        this._calibrationCandidates.delete(cameraId);
      }
    }
  }

  // ===== BINARY MAX-HEAP OPERATIONS (NEW) =====

  /**
   * Push entry into heap
   * REFINEMENT: Avoids duplicate entries (updates existing if intentId already in heap).
   */
  _heapPush(entry) {
    // Avoid duplicate pushes
    if (this._heapIndexMap.has(entry.intentId)) {
      // Already in heap — update priority/timestamp if needed
      const idx = this._heapIndexMap.get(entry.intentId);
      this._globalHeap[idx] = entry;
      this._heapBubbleUp(idx);
      this._heapBubbleDown(idx);
      return;
    }

    this._globalHeap.push(entry);
    this._heapIndexMap.set(entry.intentId, this._globalHeap.length - 1);
    this._heapBubbleUp(this._globalHeap.length - 1);
  }

  _heapPop() {
    if (this._globalHeap.length === 0) return null;
    const top = this._globalHeap[0];
    const last = this._globalHeap.pop();

    if (this._globalHeap.length > 0) {
      this._globalHeap[0] = last;
      this._heapIndexMap.set(last.intentId, 0);
      this._heapBubbleDown(0);
    }

    this._heapIndexMap.delete(top.intentId);
    return top;
  }

  _heapRemove(intentId) {
    const idx = this._heapIndexMap.get(intentId);
    if (idx === undefined) return;
    const last = this._globalHeap.pop();
    if (idx < this._globalHeap.length) {
      this._globalHeap[idx] = last;
      this._heapIndexMap.set(last.intentId, idx);
      this._heapBubbleDown(idx);
      this._heapBubbleUp(idx);
    }

    this._heapIndexMap.delete(intentId);
  }

  _heapBubbleUp(idx) {
    while (idx > 0) {
      const parentIdx = Math.floor((idx - 1) / 2);
      if (this._heapCompare(this._globalHeap[idx], this._globalHeap[parentIdx]) <= 0) {
        break;
      }
      this._heapSwap(idx, parentIdx);
      idx = parentIdx;
    }
  }

  _heapBubbleDown(idx) {
    while (true) {
      const leftIdx = 2 * idx + 1;
      const rightIdx = 2 * idx + 2;
      let largestIdx = idx;
      if (leftIdx < this._globalHeap.length &&
        this._heapCompare(this._globalHeap[leftIdx], this._globalHeap[largestIdx]) > 0) {
        largestIdx = leftIdx;
      }

      if (rightIdx < this._globalHeap.length &&
        this._heapCompare(this._globalHeap[rightIdx], this._globalHeap[largestIdx]) > 0) {
        largestIdx = rightIdx;
      }

      if (largestIdx === idx) break;

      this._heapSwap(idx, largestIdx);
      idx = largestIdx;
    }
  }

  _heapSwap(i, j) {
    const temp = this._globalHeap[i];
    this._globalHeap[i] = this._globalHeap[j];
    this._globalHeap[j] = temp;
    this._heapIndexMap.set(this._globalHeap[i].intentId, i);
    this._heapIndexMap.set(this._globalHeap[j].intentId, j);
  }

  _heapCompare(a, b) {
    // Return positive if 'a' should come before 'b' (higher priority)
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    // Tie-breaker: earlier timestamp (smaller) should win
    if (a.timestamp === b.timestamp) return 0;
    return (a.timestamp < b.timestamp) ? 1 : -1;
  }

  // ===== CLEANUP =====

  /**
   * Destroy detector and cleanup all state
   * REFINEMENT: Comprehensive cleanup of all new state.
   */
  destroy() {
    // Stop decay timer
    if (this._decayTimer) {
      clearInterval(this._decayTimer);
      this._decayTimer = null;
    }

    // Clear reconstruction scheduler state
    this._intents.clear();
    this._intentsByJobId.clear();
    this._intentsByMetaKey.clear();
    this._globalHeap = [];
    this._heapIndexMap.clear();
    this._perCameraQueues.clear();
    this._cameras.clear();
    this._inFlight.clear();
    this._cooldowns.clear();

    // Clear exposure tracking
    this._recentLuma.clear();

    // Clear annular-specific state
    this._annularHistoryPerCamera.clear();
    this._calibrationCandidates.clear();
    this._confirmedCalibrations.clear();
    this._annularStatsPerCamera.clear();
    this._lastCalibrationPerCamera.clear();

    // Reset calibration state
    this.reset();

    console.log('MotionDetector: destroyed');
  }
}

export default MotionDetector;
