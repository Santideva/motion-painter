// /src/js/core/MotionWorkerWrapper.js
// Wrapper for /src/js/core/motion.worker.js
// Provides job-oriented API for computeFlux and reconstruction jobs,
// lifecycle management, readiness callbacks, metrics, and graceful termination.
// Updated with camera info preservation and production-ready error handling.

import featureFlags from '../../config/featureFlags.js';

export class MotionWorkerWrapper {
  /**
   * @param {string} workerPath - Path to motion.worker.js
   * @param {Object} opts - Configuration options
   * @param {number} [opts.readyTimeoutMs=10000] - Worker ready timeout
   * @param {number} [opts.defaultJobTimeoutMs=120000] - Default job timeout
   * @param {boolean} [opts.debug=false] - Enable debug logging
   */
  constructor(workerPath = '/src/js/core/motion.worker.js', opts = {}) {
    this.workerPath = workerPath || '/src/js/core/motion.worker.js';
    this.readyTimeoutMs = typeof opts.readyTimeoutMs === 'number' ? opts.readyTimeoutMs : 10000;

    // Default job timeout remains reasonable for smaller jobs like computeFlux
    this.defaultJobTimeoutMs = typeof opts.defaultJobTimeoutMs === 'number' ? opts.defaultJobTimeoutMs : 120000;

    // RECONSTRUCT_META is much heavier: GPU compute + large persistence + visibility waits.
    // Under the single-flight queue in motion.worker, a job may also wait a
    // significant time before it even starts running. reconstructJobTimeoutMs
    // is now used as a WATCHDOG timeout — it resets on any RECON_QUEUED
    // heartbeat or 'progress' message for the job, rather than firing once at
    // a fixed offset from submission. reconstructJobMaxTotalMs is a separate,
    // non-resettable hard ceiling that still guards against a worker that
    // keeps sending heartbeats forever without ever actually finishing.
    this.reconstructJobTimeoutMs = typeof opts.reconstructJobTimeoutMs === 'number'
      ? opts.reconstructJobTimeoutMs
      : 300000; // 5 minutes of silence tolerated before considering the job stuck

    this.reconstructJobMaxTotalMs = typeof opts.reconstructJobMaxTotalMs === 'number'
      ? opts.reconstructJobMaxTotalMs
      : 1200000; // 20 minutes absolute cap, regardless of heartbeats

    this.config = Object.assign({}, opts);
    this._debug = !!opts.debug;

    // Runtime state
    this.worker = null;
    this.workerReady = false;
    this._readyCallbacks = [];
    this._readyResolve = null;
    this._readyReject = null;
    this._readyPromise = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });

    this.jobCounter = 0;
    this.pending = new Map(); // jobId -> { resolve, reject, timeout, kind, startedAt }

    this.metrics = {
      jobsRequested: 0,
      jobsSucceeded: 0,
      jobsFailed: 0,
      lastError: null,
      avgProcessingMs: 0,
      totalProcessingMs: 0
    };

    // Worker death callback (injected by main.js)
    // Called when worker crashes/dies to allow cleanup
    this.onWorkerDeath = null;

    // Feature flag subscription cleanup
    this._flagUnsub = null;

    // Create worker.
    // Webpack 5 detects `new Worker(new URL('./...', import.meta.url))` and
    // bundles the worker plus all its transitive imports (THREE.js, storage,
    // pipeline modules) into a self-contained hashed chunk at build time.
    // This eliminates the bare-specifier and COEP failures that occur when
    // the worker is loaded as a raw source file via a string URL.
    //
    // workerPath is retained in the constructor signature for call-site
    // compatibility but is no longer used to create the Worker instance.
    try {
      this.worker = new Worker(
        new URL('./motion.worker.js', import.meta.url),
        { type: 'module' }
      );

      // Attach message handlers
      this.worker.onmessage = (ev) => this._handleWorkerMessage(ev);
      this.worker.onerror = (ev) => this._handleWorkerError(ev);
      this.worker.onmessageerror = (ev) => this._handleWorkerMessageError(ev);

      // Active init handshake with retry logic
      this._sendInitHandshake();

      // Subscribe to feature flag changes for hot updates
      this._subscribeToFeatureFlags();

    } catch (err) {
      console.error('MotionWorkerWrapper: failed to create worker', err);
      if (this._readyReject) this._readyReject(err);
      throw err;
    }

    // Readiness guard timeout
    this.readyTimeout = setTimeout(() => {
      if (!this.workerReady) {
        const msg = `MotionWorkerWrapper: worker not ready within ${this.readyTimeoutMs}ms`;
        console.error(msg);
        this.metrics.lastError = msg;
        if (this._readyReject) {
          this._readyReject(new Error(msg));
          this._readyReject = null;
          this._readyResolve = null;
        }
      }
    }, this.readyTimeoutMs);
  }

  // =====================================================================
  // INITIALIZATION & FEATURE FLAGS
  // =====================================================================

  /**
   * Send init handshake to worker with retry logic
   * @private
   */
  _sendInitHandshake() {
    const maxAttempts = 4;
    const baseDelay = 120; // ms
    let attempts = 0;

    const postInit = () => {
      attempts++;
      try {
        const flagsSnapshot = featureFlags && typeof featureFlags.getFlags === 'function'
          ? featureFlags.getFlags()
          : {};

        if (this.worker && typeof this.worker.postMessage === 'function') {
          this.worker.postMessage({ op: 'init', flags: flagsSnapshot });

          if (this._debug) {
            console.debug(`MotionWorkerWrapper: init posted (attempt ${attempts})`);
          }
        } else {
          throw new Error('worker.postMessage unavailable');
        }
      } catch (err) {
        if (attempts < maxAttempts) {
          const delay = baseDelay * attempts;
          setTimeout(postInit, delay);
        } else {
          console.warn('MotionWorkerWrapper: init post failed after retries', err);
        }
      }
    };

    // Initial attempt
    postInit();

    // Follow-up attempt after 500ms if not ready
    setTimeout(() => {
      if (!this.workerReady) postInit();
    }, 500);
  }

  /**
   * Subscribe to feature flag changes for hot updates to worker
   * @private
   */
  _subscribeToFeatureFlags() {
    if (!featureFlags || typeof featureFlags.subscribe !== 'function') {
      return;
    }

    try {
      this._flagUnsub = featureFlags.subscribe(() => {
        if (!this.worker || !this.workerReady) return;

        try {
          const flagsSnapshot = featureFlags && typeof featureFlags.getFlags === 'function'
            ? featureFlags.getFlags()
            : {};

          this.worker.postMessage({ op: 'updateFlags', flags: flagsSnapshot });

          if (this._debug) {
            console.debug('MotionWorkerWrapper: feature flags updated in worker');
          }
        } catch (err) {
          console.warn('MotionWorkerWrapper: failed to update flags in worker', err);
        }
      });
    } catch (err) {
      console.warn('MotionWorkerWrapper: feature flag subscription failed', err);
    }
  }

  // =====================================================================
  // MESSAGE HANDLERS
  // =====================================================================

  /**
   * Handle incoming messages from worker
   * @private
   */
  _handleWorkerMessage(ev) {
    const data = ev.data || {};

    // Worker ready acknowledgment
    if (data.op === 'inited' || data.op === 'worker:ready' || data.event === 'inited') {
      this._handleWorkerReady();
      return;
    }

    // computeFlux responses
    if (data.op === 'computeFlux:done' && data.jobId) {
      this._resolveJob(data.jobId, data.result);
      return;
    }

    if (data.op === 'computeFlux:error' && data.jobId) {
      this._rejectJob(data.jobId, data.error || 'computeFlux_error');
      return;
    }

    // Reconstruction done
    if (data.event === 'RECON_DONE') {
      if (!data.jobId) {
        console.warn('MotionWorkerWrapper: RECON_DONE missing jobId', data);
        return;
      }
      this._resolveJob(data.jobId, data);
      return;
    }

    // Reconstruction failed
    if (data.event === 'RECON_FAIL') {
      if (!data.jobId) {
        console.warn('MotionWorkerWrapper: RECON_FAIL missing jobId', data);
        return;
      }
      this._rejectJob(data.jobId, data.error || 'reconstruction_failed');
      return;
    }

    // Reconstruction in progress (informational)
    if (data.event === 'RECON_IN_PROGRESS') {
      if (!data.jobId) {
        console.warn('MotionWorkerWrapper: RECON_IN_PROGRESS missing jobId', data);
        return;
      }

      if (this._debug) {
        console.log('MotionWorkerWrapper: reconstruction in progress', {
          jobId: data.jobId,
          metaKey: data.metaKey,
          startedAt: data.startedAt,
          existingReqId: data.existingReqId
        });
      }
      return;
    }

    // Reconstruction queued behind another job in motion.worker's single-flight
    // queue — proves the worker is alive and still tracking this job even
    // though it hasn't started running yet. Resets the watchdog so queue wait
    // time doesn't get mistaken for a stuck job.
    if (data.event === 'RECON_QUEUED') {
      if (!data.jobId) return;
      this._armWatchdog(data.jobId);
      if (this._debug) {
        console.log('MotionWorkerWrapper: reconstruction queued', {
          jobId: data.jobId,
          metaKey: data.metaKey,
          queuePosition: data.queuePosition,
          heartbeat: !!data.heartbeat
        });
      }
      return;
    }

    // Progress update from an actively-running job — also resets the
    // watchdog. Long reconstructions legitimately take 60-100s+ per stage;
    // without this a fixed timeout can't distinguish "still working" from
    // "stuck".
    if (data.event === 'progress' && data.jobId) {
      this._armWatchdog(data.jobId);
      return;
    }

    // Metrics update
    if (data.op === 'metrics' && data.metrics) {
      try {
        Object.assign(this.metrics, data.metrics);
      } catch (e) {
        // Ignore merge errors
      }
      return;
    }

    // Unknown message type (silently ignore or extend as needed)
  }

  /**
   * Handle worker ready state
   * @private
   */
  _handleWorkerReady() {
    if (this.readyTimeout) {
      clearTimeout(this.readyTimeout);
      this.readyTimeout = null;
    }

    this.workerReady = true;

    // Broadcast current feature flags state
    try {
      if (featureFlags && typeof featureFlags.broadcastCurrentFlags === 'function') {
        featureFlags.broadcastCurrentFlags();
      }
    } catch (err) {
      console.warn('MotionWorkerWrapper: failed to broadcast flags on ready', err);
    }

    // Resolve ready promise
    if (this._readyResolve) {
      this._readyResolve();
      this._readyResolve = null;
      this._readyReject = null;
    }

    // Execute ready callbacks
    const callbacks = this._readyCallbacks.slice();
    this._readyCallbacks.length = 0;
    callbacks.forEach(cb => {
      try {
        setTimeout(cb, 0);
      } catch (err) {
        console.warn('MotionWorkerWrapper: ready callback threw', err);
      }
    });
  }

  /**
   * Handle worker error event (critical failure)
   * @private
   */
  _handleWorkerError(ev) {
      // Extract detailed error information
  const errorMsg = ev && (ev.message || ev.error?.message || String(ev));
  const filename = ev && ev.filename;
  const lineno = ev && ev.lineno;
  const colno = ev && ev.colno;
  const errorStack = ev && ev.error?.stack;

  console.error('MotionWorkerWrapper: worker error', {
    message: errorMsg,
    filename,
    lineno,
    colno,
    stack: errorStack
  });
    const msg = ev && (ev.message || String(ev)) || 'worker_error';
    console.error('MotionWorkerWrapper: worker error', msg);
    this.metrics.lastError = msg;

    // Reject all pending jobs
    this._rejectAllPending(new Error(`Worker died: ${msg}`));

    // Notify main.js via callback if provided
    if (typeof this.onWorkerDeath === 'function') {
      try {
        this.onWorkerDeath(new Error(msg));
      } catch (err) {
        console.warn('MotionWorkerWrapper: onWorkerDeath callback threw', err);
      }
    }

    // Reject ready promise if not yet ready
    if (!this.workerReady && this._readyReject) {
      this._readyReject(new Error(msg));
      this._readyReject = null;
      this._readyResolve = null;
    }
  }

  /**
   * Handle worker message error (deserialization failure)
   * @private
   */
  _handleWorkerMessageError(ev) {
    const msg = 'onmessageerror';
    console.error('MotionWorkerWrapper:', msg, ev);
    this.metrics.lastError = msg;

    // Reject all pending jobs
    this._rejectAllPending(new Error(msg));

    // Notify main.js
    if (typeof this.onWorkerDeath === 'function') {
      try {
        this.onWorkerDeath(new Error(msg));
      } catch (err) {
        console.warn('MotionWorkerWrapper: onWorkerDeath callback threw', err);
      }
    }

    // Reject ready promise if not yet ready
    if (!this.workerReady && this._readyReject) {
      this._readyReject(new Error(msg));
      this._readyReject = null;
      this._readyResolve = null;
    }
  }

  /**
   * Reset (or initially arm) the per-job watchdog timeout. Called whenever
   * motion.worker signals it's still alive and tracking this job — via a
   * queued-status heartbeat or a progress update — so a fixed fire-once
   * timeout doesn't misfire on a legitimately long-queued or long-running
   * reconstruction. The separate, non-resettable maxTimeout (see _submitJob)
   * still guards against a truly stuck/dead worker that never stops sending
   * heartbeats.
   * @private
   */
  _armWatchdog(jobId) {
    const entry = this.pending.get(jobId);
    if (!entry) return;
    if (entry.timeout) clearTimeout(entry.timeout);
    entry.timeout = setTimeout(() => this._onWatchdogFired(jobId), entry.heartbeatMs);
  }

  /**
   * Watchdog fired — no queued-heartbeat or progress message arrived within
   * heartbeatMs. Reject as stuck.
   * @private
   */
  _onWatchdogFired(jobId) {
    const entry = this.pending.get(jobId);
    if (!entry) return;
    this.pending.delete(jobId);
    if (entry.maxTimeout) clearTimeout(entry.maxTimeout);
    this.metrics.jobsFailed++;
    const msg = `${entry.kind} watchdog timeout — no activity for ${entry.heartbeatMs}ms`;
    this.metrics.lastError = msg;
    try {
      entry.reject(new Error(msg));
    } catch (err) {
      console.warn('MotionWorkerWrapper: reject callback threw', err);
    }
  }

  /**
   * Hard deadline fired — the job has been outstanding for maxTotalMs total,
   * regardless of how many heartbeats reset the watchdog along the way.
   * Reject unconditionally; this is the backstop against a worker that keeps
   * sending heartbeats forever without ever actually finishing.
   * @private
   */
  _onMaxDeadlineFired(jobId) {
    const entry = this.pending.get(jobId);
    if (!entry) return;
    this.pending.delete(jobId);
    if (entry.timeout) clearTimeout(entry.timeout);
    this.metrics.jobsFailed++;
    const msg = `${entry.kind} exceeded max total wait (${entry.maxTotalMs}ms)`;
    this.metrics.lastError = msg;
    try {
      entry.reject(new Error(msg));
    } catch (err) {
      console.warn('MotionWorkerWrapper: reject callback threw', err);
    }
  }

  /**
   * Reject all pending jobs (called on worker death)
   * @private
   */
  _rejectAllPending(error) {
    for (const [jobId, entry] of this.pending.entries()) {
      if (entry.timeout) clearTimeout(entry.timeout);
      if (entry.maxTimeout) clearTimeout(entry.maxTimeout);
      try {
        entry.reject(error);
      } catch (err) {
        // Ignore rejection handler errors
      }
    }
    this.pending.clear();
  }

  // =====================================================================
  // JOB RESOLUTION
  // =====================================================================

  /**
   * Resolve a pending job
   * @private
   */
  _resolveJob(jobId, result) {
    const entry = this.pending.get(jobId);
    if (!entry) {
      if (this._debug) {
        console.warn('MotionWorkerWrapper: received result for unknown jobId', jobId);
      }
      return;
    }

    clearTimeout(entry.timeout);
    if (entry.maxTimeout) clearTimeout(entry.maxTimeout);
    this.pending.delete(jobId);
    this.metrics.jobsSucceeded++;

    // Calculate processing time
    const elapsed = performance.now() - entry.startedAt;
    this.metrics.totalProcessingMs += elapsed;
    this.metrics.avgProcessingMs = this.metrics.totalProcessingMs / this.metrics.jobsSucceeded;

    try {
      entry.resolve(result);
    } catch (err) {
      console.warn('MotionWorkerWrapper: resolve callback threw', err);
    }
  }

  /**
   * Reject a pending job
   * @private
   */
  _rejectJob(jobId, error) {
    const entry = this.pending.get(jobId);
    if (!entry) {
      if (this._debug) {
        console.warn('MotionWorkerWrapper: received error for unknown jobId', jobId);
      }
      return;
    }

    clearTimeout(entry.timeout);
    if (entry.maxTimeout) clearTimeout(entry.maxTimeout);
    const kind = entry.kind;
    this.pending.delete(jobId);
    this.metrics.jobsFailed++;
    this.metrics.lastError = error;

    try {
      entry.reject(new Error(`[${kind}] ${error}`));
    } catch (err) {
      console.warn('MotionWorkerWrapper: reject callback threw', err);
    }
  }

  // =====================================================================
  // PUBLIC API
  // =====================================================================

  /**
   * Returns a promise that resolves when worker is ready
   * @returns {Promise<void>}
   */
  ready() {
    return this._readyPromise;
  }

  /**
   * Register a callback to be invoked when worker becomes ready
   * @param {Function} cb - Callback function
   * @returns {Function} Unsubscribe function
   */
  onReady(cb) {
    if (typeof cb !== 'function') return () => {};

    if (this.workerReady) {
      try {
        setTimeout(cb, 0);
      } catch (err) {
        console.warn('MotionWorkerWrapper: onReady callback threw', err);
      }
      return () => {};
    }

    this._readyCallbacks.push(cb);
    return () => {
      const idx = this._readyCallbacks.indexOf(cb);
      if (idx >= 0) this._readyCallbacks.splice(idx, 1);
    };
  }

  /**
   * Request optical flux computation for a calibrated frame
   * @param {string} metaKey - Calibration or frame metaKey
   * @param {Object} [options={}] - Flux computation options
   * @param {number} [options.seed] - Random seed
   * @param {number} [options.maxSamplePoints] - Max sample points
   * @param {number} [timeoutMs] - Override default timeout
   * @returns {Promise<Object>} Flux computation result
   */
  requestFlux(metaKey, options = {}, timeoutMs = null) {
    return this._submitJob('computeFlux', { metaKey, options }, timeoutMs);
  }

    /**
     * Request reconstruction for a canonical artifact metaKey
     * @param {string} metaKey - Artifact key to reconstruct
     * @param {Object} [options={}] - Reconstruction options
     * @param {string} options.reqId - Request ID (intent ID from MotionDetector) - REQUIRED
     * @param {string} options.reason - Reconstruction reason ('motion_spike', 'exposure_change', etc.) - REQUIRED
     * @param {number} options.priority - Priority value (0-100) - REQUIRED
     * @param {string} [options.cameraId] - Camera ID (for logging/telemetry) - STRONGLY RECOMMENDED
     * @param {Object} [options.cameraContainer] - Canonical camera container metadata (optional, passed through)
     * @param {Object} [options.resolution] - Target resolution override
     * @param {number} [timeoutMs] - Override default timeout (default: 120000ms)
     * @returns {Promise<Object>} Resolves with { metaKey, derivedKeys, cached, telemetry }
     * @throws {Error} If worker not initialized or metaKey missing
     */
    requestReconstructionByMeta(metaKey, options = {}, timeoutMs = null) {

    // Validate required fields in debug mode
    if (this._debug) {
      if (!options.reqId) {
        console.warn('MotionWorkerWrapper: RECONSTRUCT_META missing reqId', { metaKey, options });
      }
      if (!options.reason) {
        console.warn('MotionWorkerWrapper: RECONSTRUCT_META missing reason', { metaKey, options });
      }
      if (options.priority === undefined) {
        console.warn('MotionWorkerWrapper: RECONSTRUCT_META missing priority', { metaKey, options });
      }
      if (!options.cameraId) {
        console.warn('MotionWorkerWrapper: RECONSTRUCT_META missing cameraId (telemetry will be incomplete)', { metaKey, options });
      }
    }

      if (this._debug && options.cameraContainer && typeof options.cameraContainer !== 'object') {
        console.warn(
        'MotionWorkerWrapper: cameraContainer present but not an object',
        { metaKey, cameraContainer: options.cameraContainer }
      );
    }
    
    return this._submitJob(
    'RECONSTRUCT_META',
    { metaKey, options },
    typeof timeoutMs === 'number' ? timeoutMs : this.reconstructJobTimeoutMs
  );
  }

  /**
   * Request worker metrics (best-effort)
   * @param {number} [timeoutMs=2000] - Timeout in ms
   * @returns {Promise<Object>} Worker metrics
   */
  async requestMetrics(timeoutMs = 2000) {
    if (!this.worker) {
      return Promise.resolve({ error: 'no-worker' });
    }

    return new Promise((resolve) => {
      let handled = false;

      const onMsg = (ev) => {
        const d = ev.data || {};
        if (d && d.op === 'metrics') {
          handled = true;
          try {
            this.worker.removeEventListener('message', onMsg);
          } catch (e) {
            // Ignore
          }
          resolve(d.metrics || this.metrics);
        }
      };

      try {
        this.worker.addEventListener('message', onMsg);
      } catch (e) {
        return resolve(this.metrics);
      }

      try {
        this.worker.postMessage({ op: 'getMetrics' });
      } catch (e) {
        try {
          this.worker.removeEventListener('message', onMsg);
        } catch (err) {
          // Ignore
        }
        return resolve(this.metrics);
      }

      setTimeout(() => {
        if (!handled) {
          try {
            this.worker.removeEventListener('message', onMsg);
          } catch (e) {
            // Ignore
          }
          resolve(this.metrics);
        }
      }, timeoutMs);
    });
  }

  /**
   * Get current metrics (local copy)
   * @returns {Object} Metrics object
   */
  getMetrics() {
    return {
      ...this.metrics,
      workerReady: this.workerReady,
      pendingJobs: this.pending.size
    };
  }

  /**
   * Terminate worker and cleanup resources
   * @returns {Promise<void>}
   */
  async terminate() {
    // Unsubscribe from feature flags
    if (this._flagUnsub) {
      try {
        this._flagUnsub();
      } catch (err) {
        console.warn('MotionWorkerWrapper: flag unsubscribe failed', err);
      }
      this._flagUnsub = null;
    }

    // Clear ready timeout
    if (this.readyTimeout) {
      clearTimeout(this.readyTimeout);
      this.readyTimeout = null;
    }

    // Reject all pending jobs
    this._rejectAllPending(new Error('Worker terminated'));

    // Send shutdown message (best-effort)
    try {
      if (this.worker) {
        this.worker.postMessage({ op: 'shutdown' });
      }
    } catch (err) {
      // Ignore post-message errors during shutdown
    }

    // Terminate worker
    try {
      if (this.worker) {
        this.worker.terminate();
      }
    } catch (err) {
      console.warn('MotionWorkerWrapper: worker.terminate() failed', err);
    }

    // Clear references
    this.worker = null;
    this.workerReady = false;
    this._readyCallbacks.length = 0;

    // Reject ready promise if still pending
    if (this._readyReject) {
      try {
        this._readyReject(new Error('Worker terminated'));
      } catch (err) {
        // Ignore rejection handler errors
      }
      this._readyReject = null;
      this._readyResolve = null;
    }
  }

  // =====================================================================
  // INTERNAL JOB SUBMISSION
  // =====================================================================

  /**
   * Submit a job to the worker
   * @private
   * @param {string} op - Operation type ('computeFlux' or 'RECONSTRUCT_META')
   * @param {Object} payload - Job payload { metaKey, options }
   * @param {number|null} timeoutMs - Timeout override
   * @returns {Promise<Object>} Job result
   */
  _submitJob(op, payload, timeoutMs) {
    if (!this.worker) {
      return Promise.reject(new Error('Worker not initialized'));
    }

    if (!payload || !payload.metaKey) {
      return Promise.reject(new Error('metaKey required'));
    }

    // Generate unique jobId
    const jobId = `${op}-${Date.now()}-${(this.jobCounter++).toString(36)}`;

    // heartbeatMs: resettable watchdog — fires only after this long WITHOUT
    // any RECON_QUEUED or 'progress' message for this job. For RECONSTRUCT_META
    // this absorbs arbitrary queue-wait time as long as the worker keeps
    // signaling it's alive. For other ops (computeFlux, etc.) nothing currently
    // resets it, so it behaves exactly like the old fixed timeout.
    const heartbeatMs = typeof timeoutMs === 'number'
      ? timeoutMs
      : this.defaultJobTimeoutMs;

    // maxTotalMs: hard, non-resettable ceiling. Only meaningfully different
    // from heartbeatMs for RECONSTRUCT_META, where queueing can legitimately
    // extend total wait well past a single heartbeat window.
    const maxTotalMs = op === 'RECONSTRUCT_META'
      ? this.reconstructJobMaxTotalMs
      : heartbeatMs;

    this.metrics.jobsRequested++;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => this._onWatchdogFired(jobId), heartbeatMs);
      const maxTimeout = setTimeout(() => this._onMaxDeadlineFired(jobId), maxTotalMs);

      // Store pending job entry
      this.pending.set(jobId, {
        resolve,
        reject,
        timeout,
        maxTimeout,
        heartbeatMs,
        maxTotalMs,
        kind: op,
        startedAt: performance.now()
      });

      // Send message to worker
      try {
        this.worker.postMessage({
          op,
          jobId,
          ...payload
        });
      } catch (err) {
        clearTimeout(timeout);
        clearTimeout(maxTimeout);
        this.pending.delete(jobId);
        this.metrics.jobsFailed++;
        this.metrics.lastError = `${op} postMessage failed`;
        reject(err);
      }
    });
  }
}

export default MotionWorkerWrapper;