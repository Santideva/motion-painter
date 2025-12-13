// /src/js/core/MotionWorkerWrapper.js
// Wrapper for /src/js/core/motion.worker.js
// Provides a small job-oriented API for computeFlux jobs, lifecycle management,
// readiness callbacks, metrics, and graceful termination.
//
// NOTE: Updated so the wrapper actively posts an 'init' handshake to the Worker
// immediately after construction (with limited retries/backoff). This prevents
// the deadlock where the worker waits for 'init' but the wrapper never sends it.

import featureFlags from '../../config/featureFlags.js';

export class MotionWorkerWrapper {
  /**
   * @param {string} workerPath - absolute-ish path (e.g. '/src/js/core/motion.worker.js')
   * @param {Object} opts - optional settings
   *   opts.readyTimeoutMs - ms to wait for worker to signal ready (default 10000)
   *   opts.defaultJobTimeoutMs - default job timeout (default 120000)
   *   opts.debug - boolean to enable debug console logging from wrapper
   */
  constructor(workerPath = '/src/js/core/motion.worker.js', opts = {}) {
    this.workerPath = workerPath || '/src/js/core/motion.worker.js';
    this.readyTimeoutMs = typeof opts.readyTimeoutMs === 'number' ? opts.readyTimeoutMs : 10000;
    this.defaultJobTimeoutMs = typeof opts.defaultJobTimeoutMs === 'number' ? opts.defaultJobTimeoutMs : 120000;
    this.config = Object.assign({}, opts);
    this._debug = !!opts.debug;

    // runtime state
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
    this.pending = new Map(); // jobId -> { resolve, reject, timeout }
    this.metrics = {
      jobsRequested: 0,
      jobsSucceeded: 0,
      jobsFailed: 0,
      lastError: null,
      avgProcessingMs: 0,
      totalProcessingMs: 0
    };

    // create worker
    try {
      const url = new URL(this.workerPath, window.location.origin);
      this.worker = new Worker(url, { type: 'module' });

      // handlers
      this.worker.onmessage = (ev) => this._handleWorkerMessage(ev);
      this.worker.onerror = (ev) => this._handleWorkerError(ev);
      this.worker.onmessageerror = (ev) => this._handleWorkerMessageError(ev);

      // Active init handshake: try to post {op:'init', flags} immediately with a few retries/backoff.
      // This ensures the worker can reply with 'inited' and we avoid the wrapper/worker deadlock.
      (() => {
        const maxAttempts = 4;
        const baseDelay = 120; // ms
        let attempts = 0;

        const postInit = () => {
          attempts++;
          try {
            const flagsSnapshot =
              (typeof featureFlags !== 'undefined' && featureFlags && typeof featureFlags.getFlags === 'function')
                ? featureFlags.getFlags()
                : {};

            if (this.worker && typeof this.worker.postMessage === 'function') {
              this.worker.postMessage({ op: 'init', flags: flagsSnapshot });
              if (this._debug) {
                // Minimal debug - only if explicitly enabled
                // (Avoid spamming console in production)
                console.debug(`MotionWorkerWrapper: init posted to worker (attempt ${attempts})`);
              }
            } else {
              throw new Error('worker.postMessage unavailable');
            }
          } catch (err) {
            if (attempts < maxAttempts) {
              const delay = baseDelay * attempts;
              setTimeout(postInit, delay);
            } else {
              console.warn('MotionWorkerWrapper: failed to post init after retries', err);
              // don't reject here - let readyTimeout handle user-visible error path
            }
          }
        };

        // immediate attempt + schedule a short follow-up
        postInit();
        setTimeout(() => {
          if (!this.workerReady) postInit();
        }, 500);
      })();

    } catch (err) {
      console.error('MotionWorkerWrapper: failed to create worker', err);
      // Reject ready promise synchronously so callers don't hang indefinitely
      if (this._readyReject) this._readyReject(err);
      throw err;
    }

    // readiness guard: ensure callers eventually see failure if worker never becomes ready
    this.readyTimeout = setTimeout(() => {
      if (!this.workerReady) {
        const msg = `MotionWorkerWrapper: worker did not become ready within ${this.readyTimeoutMs} ms`;
        console.error(msg);
        if (this._readyReject) this._readyReject(new Error(msg));
        // leave worker running (other channels like BC may still function) but surface error via metrics/lastError
        this.metrics.lastError = msg;
      }
    }, this.readyTimeoutMs);
  }

  // ---------- internal handlers ----------

  _handleWorkerMessage(ev) {
    const data = ev.data || {};

    // Standard "inited" / ready ack
    if (data.op === 'inited' || data.op === 'worker:ready' || data.event === 'inited') {
      try {
        if (this.readyTimeout) {
          clearTimeout(this.readyTimeout);
          this.readyTimeout = null;
        }
        this.workerReady = true;

        // Broadcast current featureFlags snapshot so worker hears initial snapshot via BC.
        try {
          featureFlags.broadcastCurrentFlags();
        } catch (e) {
          // best-effort, not fatal
          console.warn('MotionWorkerWrapper: featureFlags.broadcastCurrentFlags failed', e);
        }

        // resolve ready promise (once)
        try {
          if (this._readyResolve) {
            this._readyResolve();
            this._readyResolve = null;
            this._readyReject = null;
          }
        } catch (e) {
          // ignore promise resolution errors
        }

        // schedule ready callbacks asynchronously to avoid reentrancy
        const callbacks = this._readyCallbacks ? this._readyCallbacks.slice() : [];
        this._readyCallbacks = [];
        callbacks.forEach(cb => {
          try { setTimeout(() => cb(), 0); } catch (e) { /* ignore individual callback errors */ }
        });
      } catch (e) {
        console.warn('MotionWorkerWrapper: error handling inited message', e);
      }

      return;
    }

    // computeFlux result
    if (data.op === 'computeFlux:done' && data.jobId) {
      const entry = this.pending.get(data.jobId);
      if (entry) {
        clearTimeout(entry.timeout);
        this.pending.delete(data.jobId);
        this.metrics.jobsSucceeded++;
        // worker returns result; update metrics if present
        if (data.result && data.result.telemetry && typeof data.result.telemetry.processingMs === 'number') {
          const ms = data.result.telemetry.processingMs;
          this.metrics.totalProcessingMs += ms;
          this.metrics.avgProcessingMs = this.metrics.totalProcessingMs / this.metrics.jobsSucceeded;
        }
        try { entry.resolve(data.result); } catch (e) { console.warn('MotionWorkerWrapper: resolve callback failed', e); }
      }
      return;
    }

    if (data.op === 'computeFlux:error' && data.jobId) {
      const entry = this.pending.get(data.jobId);
      if (entry) {
        clearTimeout(entry.timeout);
        this.pending.delete(data.jobId);
        this.metrics.jobsFailed++;
        this.metrics.lastError = data.error || null;
        try { entry.reject(new Error(data.error || 'computeFlux_error')); } catch (e) { /* ignore */ }
      }
      return;
    }

    // metrics reply
    if (data.op === 'metrics') {
      // if there's a waiting promise by convention we won't create dedicated correlation; expose raw
      // but also mirror into this.metrics if helpful
      try {
        if (data.metrics && typeof data.metrics === 'object') {
          // merge some values (best-effort)
          Object.assign(this.metrics, data.metrics);
        }
      } catch (e) {}
      // post raw message on 'metrics' for consumers
      return;
    }

    // generic messages: re-broadcast to any listeners (optional)
    // For now we don't implement a general subscriber API; main may add it if needed.

    // fallback: ignore unknown messages
  }

  _handleWorkerError(ev) {
    try {
      console.error('MotionWorkerWrapper: worker error', ev && (ev.message || ev));
    } catch (e) {
      // ignore
    }
    // mark lastError
    this.metrics.lastError = ev && (ev.message || String(ev)) || 'worker_error';
    // also reject ready promise if not ready yet
    if (!this.workerReady && this._readyReject) {
      try { this._readyReject(new Error(String(this.metrics.lastError))); } catch (_) {}
      this._readyReject = null;
      this._readyResolve = null;
    }
  }

  _handleWorkerMessageError(ev) {
    try {
      console.error('MotionWorkerWrapper: worker onmessageerror', ev);
    } catch (e) {}
    this.metrics.lastError = 'onmessageerror';
    if (!this.workerReady && this._readyReject) {
      try { this._readyReject(new Error('onmessageerror')); } catch (_) {}
      this._readyReject = null;
      this._readyResolve = null;
    }
  }

  // ---------- public API ----------

  /**
   * Convenience: returns a Promise that resolves when worker is ready (or rejects on timeout/creation failure)
   */
  ready() {
    return this._readyPromise;
  }

  /**
   * Register a ready callback. If worker is already ready the callback is scheduled asynchronously.
   * Returns an unsubscribe function (if the callback wasn't executed yet).
   */
  onReady(cb) {
    if (typeof cb !== 'function') return () => {};
    if (this.workerReady) {
      try { setTimeout(() => cb(), 0); } catch (e) {}
      return () => {};
    }
    this._readyCallbacks.push(cb);
    return () => {
      const idx = this._readyCallbacks.indexOf(cb);
      if (idx >= 0) this._readyCallbacks.splice(idx, 1);
    };
  }

  /**
   * Request flux computation for a given calibration metaKey (or calibratedFrameKey).
   * Returns a Promise resolving to worker result object (see worker implementation).
   * Options are passed through to the worker.
   *
   * Example:
   *   await wrapper.requestFlux('mp:calib:abc123', { seed: 42, maxSamplePoints: 1024 });
   */
  requestFlux(metaKey, options = {}, timeoutMs = null) {
    if (!this.worker) {
      return Promise.reject(new Error('Worker not initialized'));
    }
    if (!metaKey) {
      return Promise.reject(new Error('metaKey required for requestFlux'));
    }

    // NOTE: we intentionally allow requests to be queued even if workerReady === false.
    // Caller may await wrapper.ready() before calling requestFlux to guarantee immediate processing.

    const jobId = `flux-${Date.now()}-${(this.jobCounter++).toString(36)}`;
    const jobTimeout = typeof timeoutMs === 'number' ? timeoutMs : this.defaultJobTimeoutMs;

    this.metrics.jobsRequested++;

    return new Promise((resolve, reject) => {
      // install timeout guard
      const t = setTimeout(() => {
        this.pending.delete(jobId);
        this.metrics.jobsFailed++;
        const err = new Error('MotionWorkerWrapper: requestFlux timeout');
        try { reject(err); } catch (_) {}
      }, jobTimeout);

      this.pending.set(jobId, { resolve, reject, timeout: t });

      // try-post message
      try {
        this.worker.postMessage({
          op: 'computeFlux',
          jobId,
          metaKey,
          options: options || {}
        });
      } catch (err) {
        clearTimeout(t);
        this.pending.delete(jobId);
        this.metrics.jobsFailed++;
        try { reject(err); } catch (_) {}
      }
    });
  }

  /**
   * Request metrics from the worker (best-effort).
   * Returns a Promise that resolves after the worker posts back 'metrics' message.
   * Implementation: posts 'getMetrics' and waits for a matching 'metrics' response for a short timeout.
   * (Because the worker currently replies with a generic 'metrics' op, we correlate via a temporary listener.)
   */
  requestMetrics(timeoutMs = 2000) {
    if (!this.worker) return Promise.resolve({ error: 'no-worker' });

    return new Promise((resolve) => {
      let handled = false;
      const onMsg = (ev) => {
        const d = ev.data || {};
        if (d && d.op === 'metrics') {
          handled = true;
          try { this.worker.removeEventListener('message', onMsg); } catch (e) {}
          resolve(d.metrics || this.metrics);
        }
      };

      // install listener
      try {
        this.worker.addEventListener('message', onMsg);
      } catch (e) {
        // fallback: resolve with local metrics
        return resolve(this.metrics);
      }

      // ask worker to post metrics
      try {
        this.worker.postMessage({ op: 'getMetrics' });
      } catch (e) {
        try { this.worker.removeEventListener('message', onMsg); } catch (_) {}
        return resolve(this.metrics);
      }

      setTimeout(() => {
        if (!handled) {
          try { this.worker.removeEventListener('message', onMsg); } catch (e) {}
          resolve(this.metrics);
        }
      }, timeoutMs);
    });
  }

  /**
   * Terminate the worker and clear pending jobs.
   * Returns a Promise that resolves when termination steps are complete.
   */
  async terminate() {
    try {
      if (this.worker && typeof this.worker.postMessage === 'function') {
        try {
          this.worker.postMessage({ op: 'shutdown' });
        } catch (e) {
          // ignore
        }
      }
    } catch (e) {
      // ignore
    }

    // Clear pending jobs (reject them)
    for (const [jobId, entry] of this.pending.entries()) {
      try {
        clearTimeout(entry.timeout);
        entry.reject(new Error('Worker terminated before completion'));
      } catch (e) {}
    }
    this.pending.clear();

    try {
      if (this.worker) {
        try { this.worker.terminate(); } catch (e) {}
      }
    } catch (e) {}

    this.worker = null;
    this.workerReady = false;
    this._readyCallbacks = [];
    // If ready promise is still pending, reject it so callers do not hang
    if (this._readyReject) {
      try { this._readyReject(new Error('Worker terminated')); } catch (_) {}
      this._readyReject = null;
      this._readyResolve = null;
    }
  }
}

export default MotionWorkerWrapper;
