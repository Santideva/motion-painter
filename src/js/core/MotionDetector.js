// src/js/core/MotionDetector.js
import { persist, TTL, PIN } from '/src/js/core/PersistenceHelper.js';

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
 *  - Calibration triggering with invalidation-driven architecture
 *
 * Architecture:
 *  - Annular events are PRIMARY trigger source (fast, rich spatial info)
 *  - ImageData events are CONFIRMATION/FALLBACK (high-fidelity verification)
 *  - Per-camera normalization and adaptive thresholds
 *  - Multi-camera fairness via CameraContainer and per-camera cooldowns
 *
 * Calibration model (invalidation-driven):
 *  - Invalidation events (spike, exposure change, vignetting, flat field)
 *    mark calibration as stale — they do NOT emit calibrationNeeded directly.
 *  - Stable-scene detection is the CAPTURE GATE — it only emits calibrationNeeded
 *    when calibration is already stale, ensuring frames are clean enough to use.
 *  - notifyCalibrationComplete() must be called by main.js after the calibration
 *    worker finishes to clear the stale/pending flags.
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

    // ===== PHASE 2: CALIBRATION MODE CONTROL (EXISTING) =====
    this.calibrationMode = options.calibrationMode || 'annular_primary'; // 'annular_primary' | 'imagedata_only' | 'annular_only'
    this.requireImageDataConfirmation = typeof options.requireImageDataConfirmation === 'boolean'
      ? options.requireImageDataConfirmation
      : true;

    // ===== CALIBRATION CANDIDATE TIMEOUT (EXISTING) =====
    this.calibrationCandidateTimeoutMs = typeof options.calibrationCandidateTimeoutMs === 'number'
      ? options.calibrationCandidateTimeoutMs
      : 5000;

    // ===== INVALIDATION-DRIVEN CALIBRATION CONFIG (NEW) =====
    // Max time (ms) calibration may remain stale without stable frames appearing.
    // When exceeded, calibration is forced regardless of scene stability.
    // Prevents the system from permanently stalling if the scene never settles.
    this.calibrationMaxStaleAgeMs = typeof options.calibrationMaxStaleAgeMs === 'number'
      ? options.calibrationMaxStaleAgeMs
      : 30_000;

    // Whether to treat a motion_spike reconstruction intent as an invalidation
    // event in addition to the exposure/vignetting/flat-field triggers.
    // Default: true — any significant motion may have changed the scene.
    this.spikeInvalidatesCalibration = typeof options.spikeInvalidatesCalibration === 'boolean'
      ? options.spikeInvalidatesCalibration
      : true;

    // ===== EXISTING CALIBRATION STATE =====
    this._motionHistory = [];
    this._lumaHistory = [];
    this._lastCalibrationEmit = 0;
    this._lastCalibrationPerCamera = new Map();
    this._lastCalibrationRequestedAt = 0;
    this._forcedNextCalibration = false;

    // ===== PHASE 2: ANNULAR CALIBRATION STATE (EXISTING) =====
    this._annularHistoryPerCamera = new Map();
    this._calibrationCandidates = new Map();
    this._confirmedCalibrations = new Set();

    // ===== ANNULAR NORMALIZATION & ADAPTIVE THRESHOLDS (EXISTING) =====
    this._annularStatsPerCamera = new Map();
    this._annularEmaAlpha = typeof options.annularEmaAlpha === 'number' ? options.annularEmaAlpha : 0.2;
    this._minEmaSamples = typeof options.minEmaSamples === 'number' ? options.minEmaSamples : 10;

    // ===== INVALIDATION-DRIVEN CALIBRATION STATE (NEW) =====
    // _calibrationStale:       cameraId → true if an invalidation event has fired
    //                          and a new calibration has not yet completed.
    //                          This is the gate that allows stable-scene detection
    //                          to actually emit calibrationNeeded.
    //
    // _calibrationStaleReason: cameraId → string (the invalidation reason,
    //                          preserved for the calibrationNeeded payload so
    //                          consumers know why recalibration was requested)
    //
    // _calibrationStaleAt:     cameraId → timestamp when stale was set.
    //                          Used by _tickDecay() to enforce a max stale age
    //                          (graceful degradation if stable frames never arrive)
    //
    // _calibrationPending:     cameraId → true once calibrationNeeded has been
    //                          emitted and capture has started. Prevents duplicate
    //                          emissions while waiting for the calibration worker
    //                          to finish. Cleared by notifyCalibrationComplete().
    // ===== INVALIDATION-DRIVEN CALIBRATION STATE =====
    this._calibrationStale        = new Map();
    this._calibrationStaleReason  = new Map();
    this._calibrationStaleAt      = new Map();
    this._calibrationPending      = new Map();

    // ===== INTENT GATING STATE =====
    // True once the FIRST calibration cycle has ever completed for this
    // detector instance. _createIntent is suppressed until this is true.
    //
    // Rationale: a manifest created before any calibration has run carries
    // calibrationKey: undefined in IDB regardless of what its annular data
    // shows. Dispatching it to motion.worker causes getArtifact(undefined)
    // → calibData=null → CPU fallback → PackingSDF crash → camera quota
    // consumed for the duration of the failed reconstruction, blocking every
    // subsequent intent for 30s.
    //
    // EMA warmup, spike/exposure detection, and calibration invalidation
    // triggers are NOT gated by this flag — they must run from frame one so
    // the system can recognize when to fire the very first calibration cycle.
    //
    // Once true, stays true for the lifetime of the detector instance.
    // A later calibration becoming stale does NOT reset this — the prior
    // calibrated artifact remains valid in IDB and reconstruction can keep
    // using it while a fresh calibration computes in the background.
    // Cleared only by reset() and destroy().
    this._calibrationConfirmed = false;

    // Validate and set annular config with defaults
    this._annularConfig = Object.assign({
      initialSpikeNormalized: 0.8,
      initialStableVarianceNormalized: 0.005,
      initialVignettingRatio: 0.6,
      uniformityThresholdNormalized: 0.15,
      spikeStdMultiplier: 3.0,
      stableVarianceFactor: 0.5,
      minSpikeNormalized: 0.2,
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

    // ============================================================================
    // STORAGE API BINDING & PERSISTENCE FLAGS
    // ============================================================================
    this._storageAPI            = null;
    this._store                 = null;   // PersistenceHelper-compatible adapter
    this._persistDebugArtifacts = false;
    this._persistedArtifacts    = new Map();

    // ===== EVENT LISTENERS (EXISTING) =====
    this._ee = new Map();
    this._domListeners = new Map();

    this.on = this.on.bind(this);
    this.off = this.off.bind(this);
    this.addEventListener = this.addEventListener.bind(this);
    this.removeEventListener = this.removeEventListener.bind(this);
    this.requestCalibration = this.requestCalibration.bind(this);

    // ===== RECONSTRUCTION SCHEDULER STATE =====

    this._intents = new Map();
    this._intentsByJobId = new Map();
    this._intentsByMetaKey = new Map();

    this._globalHeap = [];
    this._heapIndexMap = new Map();

    this._perCameraQueues = new Map();
    this._cameras = new Map();

    this._inFlight = new Set();
    this._cooldowns = new Map();
    this._dispatcher = null;

    this._schedulerConfig = Object.assign({
      maxInFlight: 2,
      // Lowered from 60000 — allows a new reconstruction every ~10s.
      // The pipeline itself takes 10–30s so the practical rate is
      // one run per completion cycle, not one every 10s wall-clock.
      cooldownMs: 10000,
      maxQueuePerCamera: 10,
      intentExpiryMs: 60000,
      priorities: {
        motion_spike: 100,
        exposure_change: 75,
        stable_scene: 50,
        periodic: 10
      },
      defaultCameraConfig: {
        concurrency: 1,
        cooldownMs: 10000,
        weight: 1.0,
        penaltyDecayRate: 0.95,
        decayIntervalMs: 60000
      },
      maxDispatchRetries: 2
    }, options.schedulerConfig || {});

    this._recentLuma = new Map();

    this._decayTimer = setInterval(() => this._tickDecay(), 10000);

    this._startTime = Date.now();

    console.log('MotionDetector: initialized with calibrationMode=' + this.calibrationMode);
  }

  // ===== BASIC SETTERS =====

  setThreshold(threshold) {
    this.threshold = Math.max(0, Math.min(1, threshold));
  }

  setSensitivity(sensitivity) {
    this.sensitivity = Math.max(0, Math.min(2, sensitivity));
  }

  setSmoothing(smoothing) {
    this.smoothing = Math.max(0, Math.min(1, smoothing));
  }

  // ===== EVENT API =====

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

  // ============================================================================
  // STORAGE API BINDING
  // ============================================================================

  setStorageAPI(storageAPI) {
    if (!storageAPI) {
      console.warn('MotionDetector.setStorageAPI: null storage API provided');
      return;
    }

    const requiredMethods = ['putInboundArtifact', 'pinArtifact', 'unpinArtifact'];
    const missingMethods = requiredMethods.filter(method => typeof storageAPI[method] !== 'function');

    if (missingMethods.length > 0) {
      console.error('MotionDetector.setStorageAPI: missing required methods:', missingMethods);
      return;
    }

    this._storageAPI = storageAPI;

    // PersistenceHelper-compatible adapter wrapping the storageAPI contract.
    // Translates persist(store, descriptor) calls into putInboundArtifact + pinArtifact.
    this._store = {
      persistAndPin: async (type, data, meta, ttlMs, pinType) => {
        const artifact = { type, data, meta };   // createdAt injected by PersistenceHelper into meta

        let putResult;
        try {
          putResult = await this._storageAPI.putInboundArtifact(artifact);
        } catch (putErr) {
          throw new Error(`putInboundArtifact failed: ${putErr.message}`);
        }

        if (!putResult?.ok || !putResult.metaKey) {
          throw new Error('putInboundArtifact returned no metaKey');
        }

        try {
          await this._storageAPI.pinArtifact(putResult.metaKey, {
            owner:  'motion_detector',
            type:   pinType,
            ttlMs:  ttlMs > 0 ? ttlMs : null
          });
        } catch (pinErr) {
          // Non-fatal — artifact is persisted even if pin fails.
          console.error(
            `[PERSIST] ✗ MotionDetector pin failed for ${putResult.metaKey.slice(0, 20)}...:`,
            pinErr
          );
        }

        return putResult;
      }
    };

    console.log('MotionDetector: storage API bound successfully');
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

  // ===== INTERNAL EMIT =====

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

  // ===== RECONSTRUCTION SCHEDULER PUBLIC API =====

  setDispatcher(dispatcher) {
    this._dispatcher = dispatcher;
    console.log('MotionDetector: dispatcher set');
  }

  /**
   * setCalibrationConfirmed
   *
   * Called by main.js from the calibration:ready BC handler, immediately
   * after notifyCalibrationComplete(cameraId). Once set true, reconstruction
   * intent creation in handleAnnularEvent is unblocked for the lifetime of
   * this detector instance (cleared only by reset()/destroy()).
   *
   * Kept separate from notifyCalibrationComplete intentionally: that method
   * clears per-camera stale/pending flags on every cycle; this flag is set
   * exactly once (on the first ever completion) and never cleared mid-session.
   *
   * @param {boolean} value
   */
  setCalibrationConfirmed(value) {
    const next = !!value;
    if (next && !this._calibrationConfirmed) {
      console.log('MotionDetector: intent creation enabled — calibration confirmed');
    }
    this._calibrationConfirmed = next;
  }

  /**
   * handleAnnularEvent
   * PRIMARY trigger source for both reconstruction AND calibration.
   *
   * Reconstruction intents are created when detection thresholds fire.
   * Calibration is invalidation-driven:
   *   - Invalidation events (spike, exposure, vignetting, flat field) mark
   *     calibration stale.
   *   - Stable-scene detection is the CAPTURE GATE — only emits
   *     calibrationNeeded when calibration is already stale.
   */
  handleAnnularEvent({ annular, meta, avgLuma, timestamp }) {
    try {
      const cameraId = meta.cameraId || 'unknown';

      const norm = this._normalizeAnnular(cameraId, annular);

      if (!norm || norm.length === 0) {
        console.warn('MotionDetector: normalization failed for', cameraId);
        return;
      }

      // Persist annular analysis (always — critical analytics)
      this._persistAnnularAnalysis({
        cameraId,
        annular: norm,
        annularRaw: Array.from(annular),
        avgLuma,
        timestamp: timestamp || Date.now(),
        meta
      }).catch(err => {
        console.warn('MotionDetector: annular persistence failed (non-fatal)', err);
      });

      // ===== RECONSTRUCTION TRIGGERS =====

      const stats = this._annularStatsPerCamera.get(cameraId);
      const spike = this._detectAnnularSpikeAdaptive(norm, cameraId);

      // Intent creation requires calibration to have completed at least once.
      // Pre-calibration manifests carry calibrationKey: undefined in IDB —
      // dispatching them to motion.worker always produces calibData=null.
      // spike and exposureChange detection still run unconditionally below
      // so they can feed the calibration invalidation path, which is how
      // the very first calibration cycle gets triggered.
      if (this._calibrationConfirmed && spike && stats && stats.sampleCount >= this._minEmaSamples) {
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

      const exposureChange = this._detectExposureChange(avgLuma, cameraId);
      if (this._calibrationConfirmed && exposureChange) {
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

      // ===== CALIBRATION: INVALIDATION TRIGGERS =====
      // These events mean the existing calibratedFrameKey may be stale.
      // They do NOT emit calibrationNeeded directly — they set the stale flag
      // which allows the stable-scene capture gate (below) to fire.

      if (this.calibrationMode !== 'imagedata_only') {

        // Invalidation 1: Motion spike (scene content may have changed)
        if (spike && this.spikeInvalidatesCalibration) {
          this._markCalibrationStale(cameraId, 'motion_spike');
        }

        // Invalidation 2: Exposure change (lighting has shifted)
        if (exposureChange) {
          this._markCalibrationStale(cameraId, 'exposure_change');
        }

        // Invalidation 3: Flat field degradation (lens/sensor state changed)
        const nonUniform = this._detectNonUniformAnnular(norm);
        if (nonUniform) {
          this._markCalibrationStale(cameraId, 'flat_field_degradation');
        }

        // Invalidation 4: Vignetting onset (optics/focus has shifted)
        const vignetting = this._detectVignetting(norm);
        if (vignetting) {
          this._markCalibrationStale(cameraId, 'vignetting_detected');
        }

        // ===== CALIBRATION: STABLE-SCENE CAPTURE GATE =====
        // Stable scene is NOT a trigger. It is the quality gate that says
        // "frames are clean enough to capture for calibration right now."
        // We only act on it if calibration is currently stale.

        if (this._isCalibrationStale(cameraId) && !this._calibrationPending.get(cameraId)) {
          const stableAnnular = this._detectStableAnnular(norm, cameraId);

          if (stableAnnular && this._canEmitCalibration(cameraId)) {
            this._emitCalibrationInvalidation(cameraId, 'annular');
          }
        }
      }

    } catch (err) {
      console.warn('MotionDetector.handleAnnularEvent error', err);
    }
  }

  /**
   * _handleAnnularCalibrationTrigger
   * Retained for backward compatibility with any external callers.
   * In the new model this path is unused internally — invalidation goes
   * through _markCalibrationStale → stable gate → _emitCalibrationInvalidation.
   */
  _handleAnnularCalibrationTrigger({ reason, cameraId, meta, annularSnapshot, avgLuma, ...extraData }) {
    if (this.calibrationMode === 'annular_only' || !this.requireImageDataConfirmation) {
      this._emitCalibrationReason({
        reason,
        cameraId,
        count: this.defaultCalibrationCount,
        resolution: { width: meta.width, height: meta.height },
        source: 'annular',
        ...extraData
      });
    } else {
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
   * onArtifactReady
   * Handle artifact:ready from preprocessor (via main.js BC listener).
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
   * notifyReconstructionFinished
   * Notification when reconstruction finishes.
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
   * notifyCalibrationComplete
   *
   * Called by main.js when the calibration worker has finished processing
   * the captured frames and a new calibratedFrameKey has been persisted to
   * storage. Clears the stale and pending flags for the camera so that
   * stable-scene detection will no longer gate a new calibrationNeeded emit.
   *
   * MUST be called after every successful calibration. Without it the system
   * will re-emit calibrationNeeded on the next stable scene even though the
   * calibration is now fresh.
   *
   * @param {string} cameraId
   */
  notifyCalibrationComplete(cameraId) {
    if (!cameraId) {
      console.warn('MotionDetector.notifyCalibrationComplete: cameraId required');
      return;
    }

    const wasStale   = this._calibrationStale.get(cameraId);
    const wasPending = this._calibrationPending.get(cameraId);

    this._calibrationStale.delete(cameraId);
    this._calibrationStaleReason.delete(cameraId);
    this._calibrationStaleAt.delete(cameraId);
    this._calibrationPending.delete(cameraId);

    // Also clear the confirmed-calibrations set so the cooldown guard resets
    this._confirmedCalibrations.delete(cameraId);

    console.log(
      `MotionDetector: calibration complete for ${cameraId}` +
      ` (wasStale=${wasStale}, wasPending=${wasPending})`
    );
  }

  /**
   * recoverFromWorkerDeath
   * Recover from worker death.
   */
  recoverFromWorkerDeath() {
    console.warn('MotionDetector: recovering from worker death');

    try {
      for (const intentId of Array.from(this._inFlight)) {
        const intent = this._intents.get(intentId);
        if (!intent) continue;

        const reducedPriority = intent.priority * 0.5;

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

  // ===== IMAGEDATA MOTION ANALYSIS (FALLBACK/CONFIRMATION) =====

  /**
   * analyzeMotion
   * Analyze motion from ImageData frames.
   * Serves as fallback trigger and confirmation for annular triggers.
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
   * handleFrame
   * Handle ImageData frame.
   * Serves as fallback calibration trigger and confirmation for annular candidates.
   */
  handleFrame(currentFrame, previousFrame, opts = {}) {
    try {
      const cameraId = opts.cameraId || 'unknown';

      const analysis = this.analyzeMotion(currentFrame, previousFrame);

      // Persist motion analysis (debug only)
      if (this._persistDebugArtifacts) {
        this._persistMotionAnalysis(
          analysis,
          cameraId,
          opts.frameNumber || null
        ).catch(err => {
          console.warn('MotionDetector: motion analysis persistence failed (non-fatal)', err);
        });
      }

      // ===== CHECK FOR CALIBRATION CANDIDATES AWAITING CONFIRMATION =====

      if (this._calibrationCandidates.has(cameraId)) {
        const candidate = this._calibrationCandidates.get(cameraId);
        const candidateAge = Date.now() - candidate.timestamp;

        if (candidateAge > this.calibrationCandidateTimeoutMs) {
          console.warn(`MotionDetector: calibration candidate timed out for ${cameraId} (age: ${candidateAge}ms)`);
          this._calibrationCandidates.delete(cameraId);
        } else {
          if (analysis.motionLevel < this.stableMotionThreshold) {
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

            return { analysis, confirmed: true };
          } else {
            console.log(`MotionDetector: calibration candidate REJECTED via ImageData for camera ${cameraId} (motion=${analysis.motionLevel.toFixed(4)})`);
            this._calibrationCandidates.delete(cameraId);
          }
        }
      }

      // ===== FALLBACK IMAGEDATA CALIBRATION LOGIC =====

      if (this.calibrationMode === 'annular_only') {
        return { analysis };
      }

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

      // Global cooldown check (backwards compat)
      const now = Date.now();
      if (now - this._lastCalibrationEmit < this.calibrationCooldownMs) {
        return stats;
      }

      // Fallback Invalidation: Exposure change (ImageData global luma)
      // Luma shift in ImageData confirms what annular may have missed.
      if (this._lumaHistory.length >= Math.min(this.motionWindowSize, this.minFramesForCalibration)) {
        const relChange = Math.abs(recentLuma - avgLuma) / (avgLuma + 1e-6);
        if (relChange >= this.luminanceChangeThreshold) {
          this._markCalibrationStale(cameraId, 'exposure_change_imagedata');
        }
      }

      // Fallback Capture Gate: Stable scene (ImageData)
      // Only fires if calibration is currently stale — same gate logic as
      // the annular path. avgMotion <= stableMotionThreshold means frames
      // are clean enough to use for calibration capture.
      if (this._motionHistory.length >= Math.min(this.motionWindowSize, this.minFramesForCalibration)) {
        if (avgMotion <= this.stableMotionThreshold) {
          if (this._isCalibrationStale(cameraId) &&
              !this._calibrationPending.get(cameraId) &&
              this._canEmitCalibration(cameraId)) {
            this._emitCalibrationInvalidation(cameraId, 'imagedata_fallback');
          }
          return stats;
        }
      }

      // Fallback: Periodic max age
      // If calibration has been stale for calibrationMaxAgeMs without stable
      // frames ever appearing, force capture regardless of scene stability.
      // Better a noisy calibration than no calibration update at all.
      if (this.calibrationMaxAgeMs && (now - this._lastCalibrationEmit) >= this.calibrationMaxAgeMs) {
        if (this._isCalibrationStale(cameraId) &&
            !this._calibrationPending.get(cameraId) &&
            this._canEmitCalibration(cameraId)) {
          this._emitCalibrationInvalidation(cameraId, 'imagedata_max_age_forced');
        }
        return stats;
      }

      return stats;

    } catch (err) {
      console.warn('MotionDetector.handleFrame error', err);
      return null;
    }
  }

  // ===== ANNULAR CALIBRATION DETECTION METHODS =====

  /**
   * _normalizeAnnular
   * Normalize annular array to [0,1] using per-camera EMA min/max.
   * Also updates per-camera stats for adaptive thresholds.
   */
  _normalizeAnnular(cameraId, annular) {
    if (!annular || annular.length === 0) {
      console.warn('MotionDetector: received empty annular array for', cameraId);
      return new Float32Array(8);
    }

    if (!Array.isArray(annular) && !(annular instanceof Float32Array) && !(annular instanceof Uint8Array)) {
      console.warn('MotionDetector: invalid annular type for', cameraId);
      return new Float32Array(annular.length || 8);
    }

    const arr = Array.from(annular).map(v => Number.isFinite(v) ? v : 0);

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

    let s2 = 0;
    for (let i = 0; i < arr.length; i++) {
      const d = arr[i] - mean;
      s2 += d * d;
    }
    const variance = arr.length ? (s2 / arr.length) : 0;
    const std = Math.sqrt(variance);

    const prev = this._annularStatsPerCamera.get(cameraId) || null;
    if (!prev) {
      this._annularStatsPerCamera.set(cameraId, {
        emaMin: minV,
        emaMax: maxV,
        emaMean: mean,
        emaStd: std,
        lastUpdated: Date.now(),
        sampleCount: 1
      });
    } else {
      const alpha = this._annularEmaAlpha;
      const emaMin  = (1 - alpha) * prev.emaMin  + alpha * minV;
      const emaMax  = (1 - alpha) * prev.emaMax  + alpha * maxV;
      const emaMean = (1 - alpha) * prev.emaMean + alpha * mean;
      const emaStd  = (1 - alpha) * prev.emaStd  + alpha * std;
      this._annularStatsPerCamera.set(cameraId, {
        emaMin,
        emaMax,
        emaMean,
        emaStd,
        lastUpdated: Date.now(),
        sampleCount: prev.sampleCount + 1
      });
    }

    const denom = (maxV - minV) || 1.0;
    const normalized = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      normalized[i] = (arr[i] - minV) / denom;
    }

    return normalized;
  }

  /**
   * _detectStableAnnular
   * Detect stable annular scene (low variance across zones over time).
   * This is the CAPTURE GATE, not a calibration trigger.
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

    const K = annular.length;
    let totalVariance = 0;

    for (let k = 0; k < K; k++) {
      const samples = history.map(h => h[k]);
      const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
      const variance = samples.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / samples.length;
      totalVariance += variance;
    }

    const avgVariance = totalVariance / K;

    const stats = this._annularStatsPerCamera.get(cameraId);
    let stableThreshold = this._annularConfig.initialStableVarianceNormalized;

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
   * _detectNonUniformAnnular
   * Detect non-uniform illumination (flat field degradation).
   * This is an INVALIDATION trigger.
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
    const cv = stdDev / (mean + 1e-6);

    const uniformityThreshold = this._annularConfig.uniformityThresholdNormalized || 0.15;

    if (cv > uniformityThreshold) {
      return { score: cv };
    }

    return null;
  }

  /**
   * _detectVignetting
   * Detect vignetting (outer zones significantly darker than center).
   * This is an INVALIDATION trigger.
   */
  _detectVignetting(annular) {
    const K = annular.length;
    if (K === 0) return null;

    const centerZone = annular[0];
    const outerZone = annular[K - 1];

    const ratio = outerZone / (centerZone + 1e-6);
    const vignettingThreshold = this._annularConfig.initialVignettingRatio || 0.6;

    if (ratio < vignettingThreshold) {
      return { ratio, severity: 1 - ratio };
    }

    return null;
  }

  // ===== INVALIDATION-DRIVEN CALIBRATION HELPERS =====

  /**
   * _markCalibrationStale
   *
   * Marks the camera's calibration as invalidated by an external event.
   * Idempotent — if already stale, preserves the original reason and timestamp
   * so we know what first invalidated it.
   *
   * @param {string} cameraId
   * @param {string} reason
   */
  _markCalibrationStale(cameraId, reason) {
    if (this._calibrationStale.get(cameraId)) {
      // Already stale — don't overwrite the original invalidation reason
      return;
    }

    this._calibrationStale.set(cameraId, true);
    this._calibrationStaleReason.set(cameraId, reason);
    this._calibrationStaleAt.set(cameraId, Date.now());

    console.log(`MotionDetector: calibration marked stale for ${cameraId} (reason=${reason})`);
  }

  /**
   * _isCalibrationStale
   *
   * Returns true if the camera's calibration has been invalidated and
   * notifyCalibrationComplete() has not yet been called for this camera.
   *
   * @param {string} cameraId
   * @returns {boolean}
   */
  _isCalibrationStale(cameraId) {
    return !!this._calibrationStale.get(cameraId);
  }

  /**
   * _canEmitCalibration
   * Check if we can emit calibration (respects per-camera cooldown).
   */
  _canEmitCalibration(cameraId) {
    const now = Date.now();

    const lastEmit = this._lastCalibrationPerCamera.get(cameraId) || 0;
    if (now - lastEmit < this.calibrationCooldownMs) {
      return false;
    }

    if (this._confirmedCalibrations.has(cameraId)) {
      const candidate = this._calibrationCandidates.get(cameraId);
      if (candidate && now - candidate.timestamp < this.calibrationCooldownMs) {
        return false;
      }
      this._confirmedCalibrations.delete(cameraId);
    }

    return true;
  }

  // ===== CALIBRATION EMISSION =====

  /**
   * _emitCalibrationInvalidation
   *
   * Internal helper called when both conditions are met:
   *   1. Calibration is stale (invalidation event has fired)
   *   2. Scene is stable (frames are clean enough to capture)
   *
   * Sets _calibrationPending to prevent duplicate emissions while the
   * calibration worker is running. Cleared by notifyCalibrationComplete().
   *
   * @param {string} cameraId
   * @param {string} source  - 'annular' | 'imagedata_fallback' | 'imagedata_max_age_forced'
   */
  _emitCalibrationInvalidation(cameraId, source) {
    const staleReason = this._calibrationStaleReason.get(cameraId) || 'unknown';

    // Mark pending immediately to prevent races between annular and imagedata paths
    this._calibrationPending.set(cameraId, true);

    this._emitCalibrationReason({
      reason:   staleReason,
      source,
      cameraId,
      count:    this.defaultCalibrationCount,
      staleAt:  this._calibrationStaleAt.get(cameraId) || null,
      staleDurationMs: this._calibrationStaleAt.get(cameraId)
        ? Date.now() - this._calibrationStaleAt.get(cameraId)
        : null
    });
  }

  /**
   * _emitCalibrationReason
   * Emit calibration event with per-camera cooldown tracking.
   */
  _emitCalibrationReason({ reason = 'unspecified', count = null, resolution = null, cameraId = 'unknown', source = 'unknown', ...extraData } = {}) {
    const now = Date.now();
    this._lastCalibrationEmit = now;
    this._lastCalibrationPerCamera.set(cameraId, now);

    const payload = {
      count: typeof count === 'number' ? count : this.defaultCalibrationCount,
      resolution: resolution || null,
      reason,
      cameraId,
      source,
      timestamp: now,
      ...extraData
    };

    this._persistCalibrationDecision(payload).catch(err => {
      console.warn('MotionDetector: calibration decision persistence failed (non-fatal)', err);
    });

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

  // ARTIFACT PERSISTENCE
  /**
   * _persistAnnularAnalysis
   * Persist annular analysis artifact (always — critical analytics).
   */
  async _persistAnnularAnalysis(data) {
    if (!this._storageAPI) {
      return;
    }

    try {
      const stats = this._annularStatsPerCamera.get(data.cameraId);

      let spike = false;
      let stableScene = false;
      let nonUniform = null;
      let vignetting = null;

      try {
        spike      = this._detectAnnularSpikeAdaptive(data.annular, data.cameraId);
        stableScene = this._detectStableAnnular(data.annular, data.cameraId);
        nonUniform = this._detectNonUniformAnnular(data.annular);
        vignetting = this._detectVignetting(data.annular);
      } catch (detectionErr) {
        console.warn('MotionDetector: detection failed during persistence', detectionErr);
      }

      const artifact = {
        type: 'annular_analysis',
        data: {
          cameraId: data.cameraId,
          annular:    Array.from(data.annular),
          annularRaw: data.annularRaw ? Array.from(data.annularRaw) : null,
          avgLuma:    data.avgLuma,
          stats: stats ? {
            emaMin:      stats.emaMin,
            emaMax:      stats.emaMax,
            emaMean:     stats.emaMean,
            emaStd:      stats.emaStd,
            sampleCount: stats.sampleCount,
            lastUpdated: stats.lastUpdated
          } : null,
          detections: {
            spike,
            stableScene,
            nonUniform: nonUniform ? { score: nonUniform.score } : null,
            vignetting: vignetting ? { ratio: vignetting.ratio, severity: vignetting.severity } : null
          },
          metrics: {
            cv:       this._computeCV(data.annular),
            variance: this._computeAnnularVariance(data.annular)
          },
          // Invalidation state snapshot for diagnostics
          calibrationStale:  this._calibrationStale.get(data.cameraId)  || false,
          calibrationPending: this._calibrationPending.get(data.cameraId) || false,
          timestamp: data.timestamp
        },
        meta: {
          cameraId:   data.cameraId,
          resolution: data.meta?.resolution || null,
          width:      data.meta?.width      || null,
          height:     data.meta?.height     || null,
          jobId:      data.meta?.jobId      || null,
          computedAt: Date.now()
        },
        createdAt: new Date().toISOString()
      };

      const result = await persist(this._store, {
        type:    artifact.type,
        data:    artifact.data,
        meta:    artifact.meta,
        ttl:     TTL.DEBUG,    // 30 s
        pinType: PIN.SOFT,
      });

      if (result?.ok) {
        if (!this._persistedArtifacts.has('annular_analysis')) {
          this._persistedArtifacts.set('annular_analysis', new Set());
        }
        this._persistedArtifacts.get('annular_analysis').add(data.cameraId);
      }

    } catch (err) {
      console.warn('MotionDetector: failed to persist annular analysis', err);
    }
  }

  /**
   * _persistCalibrationDecision
   * Persist calibration decision artifact (always — critical audit trail).
   */
  async _persistCalibrationDecision(payload) {
    if (!this._storageAPI) {
      return;
    }

    try {
      let decision = 'trigger';
      let needsConfirmation = false;
      let confirmed = false;

      if (payload.reason.includes('_confirmed')) {
        decision = 'trigger';
        confirmed = true;
        needsConfirmation = false;
      } else if (this.requireImageDataConfirmation && payload.source === 'annular') {
        decision = 'pending_confirmation';
        needsConfirmation = true;
        confirmed = false;
      }

      let confidence = 0.5;

      if (confirmed) {
        confidence = 0.9;
      } else if (payload.source === 'annular' && !needsConfirmation) {
        confidence = 0.7;
      } else if (payload.source === 'imagedata_fallback') {
        confidence = 0.6;
      } else if (payload.source === 'manual') {
        confidence = 1.0;
      }

      const artifact = {
        type: 'calibration_decision',
        data: {
          decision,
          reason:    payload.reason,
          source:    payload.source,
          confidence,
          triggerConditions: {
            stableScene:        payload.reason.includes('stable'),
            exposureChange:     payload.reason.includes('exposure'),
            vignetting:         payload.reason.includes('vignetting'),
            flatFieldDegradation: payload.reason.includes('flat_field'),
            manualForce:        payload.reason.includes('manual')
          },
          annularSnapshot:  payload.annularSnapshot ? new Float32Array(payload.annularSnapshot) : null,
          imageDataMotion:  typeof payload.imageDataMotion === 'number' ? payload.imageDataMotion : null,
          // Invalidation metadata
          staleAt:          payload.staleAt         || null,
          staleDurationMs:  payload.staleDurationMs  || null,
          needsConfirmation,
          confirmed,
          timestamp: payload.timestamp || Date.now()
        },
        meta: {
          cameraId:   payload.cameraId || 'unknown',
          count:      payload.count || this.defaultCalibrationCount,
          resolution: payload.resolution || null,
          computedAt: Date.now()
        },
        createdAt: new Date().toISOString()
      };

      const result = await persist(this._store, {
        type:    artifact.type,
        data:    artifact.data,
        meta:    artifact.meta,
        ttl:     TTL.PINNED,   // 5 min — calibration audit trail
        pinType: PIN.SOFT,
      });

      if (result?.ok) {
        console.log(`[PERSIST] ✓ Calibration decision persisted: ${payload.reason} (confidence=${confidence.toFixed(2)})`);
      }

    } catch (err) {
      console.warn('MotionDetector: failed to persist calibration decision', err);
    }
  }

  /**
   * _persistReconstructionIntent
   * Persist reconstruction intent artifact (always — fairness audit).
   */
  async _persistReconstructionIntent(intent) {
    if (!this._storageAPI) {
      return;
    }

    try {
      const artifact = {
        type: 'reconstruction_intent',
        data: {
          intentId:  intent.intentId,
          jobId:     intent.jobId,
          metaKey:   intent.metaKey || null,
          cameraId:  intent.cameraId,
          reason:    intent.reason,
          priority:  intent.priority,
          createdAt: intent.createdAt,
          artifactReadyAt: intent.artifactReadyAt || null,
          dispatchedAt:    null,
          completedAt:     null,
          status:  'pending',
          retries: intent._retries || 0,
          annularSnapshot: intent.annular ? new Float32Array(intent.annular) : null,
          avgLuma: intent.avgLuma || null
        },
        meta: {
          cameraId:   intent.cameraId,
          reason:     intent.reason,
          computedAt: Date.now()
        },
        createdAt: new Date().toISOString()
      };

      const result = await persist(this._store, {
        type:    artifact.type,
        data:    artifact.data,
        meta:    artifact.meta,
        ttl:     180_000,      // 3 min — raw number, longer than TTL.INTERMEDIATE
        pinType: PIN.SOFT,
      });

      if (result?.ok) {
        if (!this._persistedArtifacts.has('reconstruction_intent')) {
          this._persistedArtifacts.set('reconstruction_intent', new Map());
        }
        this._persistedArtifacts.get('reconstruction_intent').set(intent.intentId, result.metaKey);

        console.log(`[PERSIST] ✓ Reconstruction intent persisted: ${intent.intentId} (reason=${intent.reason})`);
      }

    } catch (err) {
      console.warn('MotionDetector: failed to persist reconstruction intent', err);
    }
  }

  /**
   * _persistMotionAnalysis
   * Persist motion analysis artifact (debug only).
   */
  async _persistMotionAnalysis(analysis, cameraId, frameNumber = null) {
    if (!this._storageAPI || !this._persistDebugArtifacts) {
      return;
    }

    try {
      const artifact = {
        type: 'motion_analysis',
        data: {
          motionLevel:  analysis.motionLevel,
          motionPixels: analysis.motionPixels,
          motionAreas:  analysis.motionAreas.slice(0, 100).map(area => ({
            x:         area.x,
            y:         area.y,
            intensity: area.intensity
          })),
          coverage:      analysis.coverage,
          avgLuminance:  analysis.avgLuminance,
          timestamp:     Date.now(),
          frameNumber
        },
        meta: {
          cameraId,
          sampleSize: analysis.motionAreas.length,
          computedAt: Date.now()
        },
        createdAt: new Date().toISOString()
      };

      await persist(this._store, {
        type:    artifact.type,
        data:    artifact.data,
        meta:    artifact.meta,
        ttl:     TTL.DEBUG,    // 30 s — debug artifact
        pinType: PIN.SOFT,
      });

    } catch (err) {
      console.warn('MotionDetector: failed to persist motion analysis (debug)', err);
    }
  }

  /**
   * persistMetrics
   * Persist detector metrics snapshot (debug only — called periodically by main.js).
   */
  async persistMetrics() {
    if (!this._storageAPI || !this._persistDebugArtifacts) {
      return;
    }

    try {
      const stats = this.getRecentStats();

      const perCameraStats = {};
      for (const [cameraId, camera] of this._cameras.entries()) {
        const intentCount = this._perCameraQueues.get(cameraId)?.size || 0;
        perCameraStats[cameraId] = {
          ...camera.getStats(),
          queueSize:             intentCount,
          annularStatsAvailable: this._annularStatsPerCamera.has(cameraId),
          calibrationStale:      this._calibrationStale.get(cameraId)  || false,
          calibrationPending:    this._calibrationPending.get(cameraId) || false,
          calibrationStaleReason: this._calibrationStaleReason.get(cameraId) || null
        };
      }

      const artifact = {
        type: 'motion_detector_metrics',
        data: {
          calibrationMode:       this.calibrationMode,
          trackedCameras:        this._cameras.size,
          pendingCandidates:     this._calibrationCandidates.size,
          annularStatsCameras:   this._annularStatsPerCamera.size,
          staleCameras:          this._calibrationStale.size,
          pendingCalibrations:   this._calibrationPending.size,
          avgMotion:             stats.avgMotion,
          avgLuma:               stats.avgLuma,
          motionWindowSize:      stats.motionWindowSize,
          lastCalibrationAt:     stats.lastCalibrationAt,
          totalIntents:          this._intents.size,
          inFlightIntents:       this._inFlight.size,
          heapSize:              this._globalHeap.length,
          perCamera:             perCameraStats,
          timestamp:             Date.now(),
          uptime:                Date.now() - (this._startTime || Date.now())
        },
        meta: {
          computedAt: Date.now()
        },
        createdAt: new Date().toISOString()
      };

      // Intentional direct call — metrics are ephemeral audit snapshots.
      // No pin or TTL needed: if evicted before consumption nothing breaks.
      // persist() is not used here because this._store wraps putInboundArtifact
      // + pinArtifact together, and pinning a high-frequency metrics record
      // would accumulate pin refcount noise without consumer benefit.
      await this._storageAPI.putInboundArtifact(artifact);

    } catch (err) {
      console.warn('MotionDetector: failed to persist metrics (debug)', err);
    }
  }

  // ===== HELPER METHODS =====

  _computeCV(annular) {
    if (!annular || annular.length === 0) return 0;

    let sum = 0;
    for (let i = 0; i < annular.length; i++) sum += annular[i];
    const mean = sum / annular.length;

    let s2 = 0;
    for (let i = 0; i < annular.length; i++) {
      const d = annular[i] - mean;
      s2 += d * d;
    }
    const std = Math.sqrt(s2 / annular.length);

    return std / (mean + 1e-6);
  }

  _computeAnnularVariance(annular) {
    const cameraId = 'unknown';
    if (!this._annularHistoryPerCamera.has(cameraId)) {
      return 0;
    }

    const history = this._annularHistoryPerCamera.get(cameraId);
    if (history.length < 2) return 0;

    const K = annular.length;
    let totalVariance = 0;

    for (let k = 0; k < K; k++) {
      const samples = history.map(h => h[k]);
      const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
      const variance = samples.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / samples.length;
      totalVariance += variance;
    }

    return totalVariance / K;
  }

  /**
   * _detectAnnularSpikeAdaptive
   * Adaptive spike detection on normalized annular [0,1].
   * This is an INVALIDATION trigger signal.
   */
  _detectAnnularSpikeAdaptive(annular, cameraId) {
    if (!Array.isArray(annular) && !(annular instanceof Float32Array)) return false;
    if (annular.length === 0) return false;

    const stats   = this._annularStatsPerCamera.get(cameraId);
    const history = this._annularHistoryPerCamera.get(cameraId);

    let peak = -Infinity;
    let sum  = 0;
    for (let i = 0; i < annular.length; i++) {
      const v = annular[i];
      if (v > peak) peak = v;
      sum += v;
    }
    const mean = sum / annular.length;

    let s2 = 0;
    for (let i = 0; i < annular.length; i++) {
      const d = annular[i] - mean;
      s2 += d * d;
    }
    const std = Math.sqrt((annular.length > 0) ? (s2 / annular.length) : 0);

    let spikeThreshold = this._annularConfig.initialSpikeNormalized;

    if (stats && history && history.length >= this._minEmaSamples) {
      spikeThreshold = Math.max(
        this._annularConfig.minSpikeNormalized,
        mean + this._annularConfig.spikeStdMultiplier * std
      );
    }

    spikeThreshold = Math.min(1.0, Math.max(0.0, spikeThreshold));

    return peak > spikeThreshold;
  }

  // ===== RECONSTRUCTION SCHEDULER INTERNAL METHODS =====

  _createIntent({ jobId, cameraId, reason, priority, meta, annular, avgLuma }) {
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

    this._persistReconstructionIntent(intent).catch(err => {
      console.warn('MotionDetector: intent persistence failed (non-fatal)', err);
    });

    console.log(`MotionDetector: created intent ${intentId} for jobId=${jobId}, reason=${reason}`);
  }

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
      priority:  effectivePriority,
      timestamp: intent.createdAt,
      intentId
    });

    console.log(`MotionDetector: scheduled intent ${intentId}, priority=${effectivePriority.toFixed(2)}`);

    this._processQueue();
  }

  async _processQueue() {
    try {
      if (!this._dispatcher) {
        console.error('MotionDetector: no dispatcher configured');
        return;
      }

      while (this._inFlight.size < this._schedulerConfig.maxInFlight) {
        const entry = this._heapPop();
        if (!entry) break;

        const { intentId } = entry;
        const intent = this._intents.get(intentId);

        if (!intent || !intent.metaKey) {
          if (intent) {
            this._heapPush({
              priority:  intent.priority * 0.9,
              timestamp: Date.now(),
              intentId
            });
          }
          continue;
        }

        const camera = this._getOrCreateCamera(intent.cameraId);
        if (!camera.hasQuota() || camera.isInCooldown(Date.now())) {
          this._heapPush(entry);
          break;
        }

        this._inFlight.add(intentId);
        camera.onRequestStart();
        this._dispatchIntent(intentId);
      }
    } catch (err) {
      console.error('MotionDetector._processQueue error', err);
    }
  }

  _dispatchIntent(intentId) {
    const intent = this._intents.get(intentId);
    if (!intent) {
      this._inFlight.delete(intentId);
      return;
    }

    const camera = this._getOrCreateCamera(intent.cameraId);
    const sendOptions = {
      reason:          intent.reason,
      priority:        intent.priority,
      reqId:           intentId,
      cameraId:        intent.cameraId,
      cameraContainer: camera.getStats()
    };

    this._dispatcher.requestReconstructionByMeta(intent.metaKey, sendOptions)
      .then((res) => {
        try {
          camera.onRequestFinish(true);
          this._inFlight.delete(intentId);
          this._removeIntent(intentId);
        } catch (e) {
          console.warn('MotionDetector._dispatchIntent success handler error', e);
        } finally {
          setTimeout(() => this._processQueue(), 0);
        }
      })
      .catch((err) => {
        try {
          console.error('MotionDetector: reconstruction dispatch failed', intent.metaKey, err);
          camera.onRequestFinish(false);
          this._inFlight.delete(intentId);

          intent._retries = (intent._retries || 0) + 1;
          const maxRetries = Number(this._schedulerConfig.maxDispatchRetries) || 2;
          if (intent._retries <= maxRetries) {
            const backoffPriority = Math.max(1, intent.priority * Math.pow(0.9, intent._retries));
            this._heapPush({ priority: backoffPriority, timestamp: Date.now(), intentId });
            console.log(`MotionDetector: requeued intent ${intentId} (retry ${intent._retries}/${maxRetries})`);
          } else {
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

  _removeIntent(intentId) {
    const intent = this._intents.get(intentId);
    if (!intent) return;

    if (intent.jobId)    this._intentsByJobId.delete(intent.jobId);
    if (intent.metaKey)  this._intentsByMetaKey.delete(intent.metaKey);

    const queue = this._perCameraQueues.get(intent.cameraId);
    if (queue) queue.delete(intentId);

    this._heapRemove(intentId);
    this._intents.delete(intentId);
  }

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

  _getOrCreateCamera(cameraId) {
    if (!this._cameras.has(cameraId)) {
      this._cameras.set(cameraId, new CameraContainer({
        cameraId,
        ...this._schedulerConfig.defaultCameraConfig
      }));
    }
    return this._cameras.get(cameraId);
  }

  _isInCooldown(metaKey) {
    const lastProcessed = this._cooldowns.get(metaKey);
    if (!lastProcessed) return false;
    return (Date.now() - lastProcessed) < this._schedulerConfig.cooldownMs;
  }

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
   * _tickDecay
   * Periodic decay tick — camera penalties, stale intent expiry,
   * stale calibration candidate cleanup, and max stale age enforcement.
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

    // Cleanup expired calibration candidates
    for (const [cameraId, candidate] of this._calibrationCandidates.entries()) {
      if (now - candidate.timestamp > this.calibrationCooldownMs) {
        console.warn('MotionDetector: expiring unconfirmed calibration candidate', cameraId);
        this._calibrationCandidates.delete(cameraId);
      }
    }

    // Enforce max stale age.
    // If calibration has been stale for longer than calibrationMaxStaleAgeMs
    // without stable frames ever arriving, force a calibration emit regardless
    // of scene stability. Prevents permanent stalling in a noisy environment.
    if (this.calibrationMaxStaleAgeMs) {
      for (const [cameraId, staleAt] of this._calibrationStaleAt.entries()) {
        const staleAge  = now - staleAt;
        const isPending = this._calibrationPending.get(cameraId);

        if (!isPending && staleAge >= this.calibrationMaxStaleAgeMs) {
          if (this._canEmitCalibration(cameraId)) {
            console.warn(
              `MotionDetector: calibration forced for ${cameraId}` +
              ` — stale for ${staleAge}ms without stable frames`
            );
            this._emitCalibrationInvalidation(cameraId, 'max_stale_age_forced');
          }
        }
      }
    }
  }

  // ===== BINARY MAX-HEAP OPERATIONS =====

  _heapPush(entry) {
    if (this._heapIndexMap.has(entry.intentId)) {
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
    const top  = this._globalHeap[0];
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
      const leftIdx  = 2 * idx + 1;
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
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    if (a.timestamp === b.timestamp) return 0;
    return (a.timestamp < b.timestamp) ? 1 : -1;
  }

  // ===== PUBLIC API =====

  reset() {
    this._motionHistory.length = 0;
    this._lumaHistory.length   = 0;
    this._lastCalibrationEmit  = 0;
    this._lastCalibrationPerCamera.clear();
    this._forcedNextCalibration = false;
    this._annularHistoryPerCamera.clear();
    this._calibrationCandidates.clear();
    this._confirmedCalibrations.clear();
    this._annularStatsPerCamera.clear();
    this._recentLuma.clear();

    // Invalidation-driven state
    this._calibrationStale.clear();
    this._calibrationStaleReason.clear();
    this._calibrationStaleAt.clear();
    this._calibrationPending.clear();

    // Intent gating — reset means "start over from scratch"; the next camera
    // session must complete a fresh calibration before intents can be created.
    this._calibrationConfirmed = false;

    console.log('MotionDetector: reset complete');
  }

  getRecentStats() {
    const avgMotion = this._motionHistory.length
      ? (this._motionHistory.reduce((s, v) => s + v, 0) / this._motionHistory.length)
      : 0;
    const avgLuma = this._lumaHistory.length
      ? (this._lumaHistory.reduce((s, v) => s + v, 0) / this._lumaHistory.length)
      : 0;

    return {
      avgMotion,
      avgLuma,
      motionWindowSize:     this._motionHistory.length,
      lastCalibrationAt:    this._lastCalibrationEmit,
      pendingCandidates:    this._calibrationCandidates.size,
      calibrationMode:      this.calibrationMode,
      calibrationConfirmed: this._calibrationConfirmed,
      annularStatsCameras:  this._annularStatsPerCamera.size,
      trackedCameras:       this._cameras.size,
      staleCameras:         this._calibrationStale.size,
      pendingCalibrations:  this._calibrationPending.size
    };
  }

  destroy() {
    if (this._decayTimer) {
      clearInterval(this._decayTimer);
      this._decayTimer = null;
    }

    // Reconstruction scheduler state
    this._intents.clear();
    this._intentsByJobId.clear();
    this._intentsByMetaKey.clear();
    this._globalHeap = [];
    this._heapIndexMap.clear();
    this._perCameraQueues.clear();
    this._cameras.clear();
    this._inFlight.clear();
    this._cooldowns.clear();
    this._recentLuma.clear();

    // Annular-specific state
    this._annularHistoryPerCamera.clear();
    this._calibrationCandidates.clear();
    this._confirmedCalibrations.clear();
    this._annularStatsPerCamera.clear();
    this._lastCalibrationPerCamera.clear();

    // Invalidation-driven state
    this._calibrationStale.clear();
    this._calibrationStaleReason.clear();
    this._calibrationStaleAt.clear();
    this._calibrationPending.clear();

    // Intent gating state
    this._calibrationConfirmed = false;

    // Persistence tracking
    if (this._persistedArtifacts) {
      this._persistedArtifacts.clear();
    }

    this._storageAPI = null;

    this.reset();

    console.log('MotionDetector: destroyed');
  }
}

export default MotionDetector;