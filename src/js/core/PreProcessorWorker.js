// src/js/core/PreprocessorWorker.js
// Enhanced version with backpressure, improved queue management, and calibration support

export class PreprocessorWorker {
  constructor(workerPath = null) {
    // Only log worker creation, not the verbose "Creating worker..." message

    // Initialize all properties first
    this.jobCounter = 0;
    this.pending = new Map();
    this.workerReady = false;
    this.queuedFrames = [];
    // Add ready-callback registry so external code can observe when worker truly becomes ready
    this._readyCallbacks = [];

    // Enhanced queue management
    this.maxQueueSize = 30; // Increased from 10
    this.processingRate = 0; // frames/second
    this.lastProcessedTime = Date.now();
    this.processedCount = 0;
    this.droppedCount = 0;
    this.backpressureActive = false;

    // Performance monitoring
    this.metrics = {
      avgProcessingTime: 0,
      queueUtilization: 0,
      dropRate: 0,
      throughput: 0,
      backpressureActive: false
    };

    // Calibration bookkeeping (added)
    this.calibrationMetaKey = null; // latest canonical calibration metaKey seen from worker
    this.calibrationMeta = null;    // associated meta object
    this.calibRefCounts = new Map(); // metaKey -> outstanding in-flight frames count
    this.pendingFetches = new Map(); // jobId/metaKey -> {resolve,reject,timeout} for fetchPersistedCalibration

    // --- Worker creation (robust, supports override via workerPath) ---
    try {
      // If caller supplied a workerPath, accept string or URL; otherwise fall back to default build path.
      let workerUrl;
      if (workerPath) {
        try {
          if (typeof workerPath === 'string') {
            // allow relative or absolute strings, resolve against origin
            workerUrl = new URL(workerPath, window.location.origin);
          } else if (workerPath instanceof URL) {
            workerUrl = workerPath;
          } else {
            // Fallback: stringify and attempt to resolve, but keep default if invalid
            workerUrl = new URL(String(workerPath), window.location.origin);
          }
        } catch (e) {
          console.warn('PreprocessorWorker: invalid workerPath provided, falling back to built-in path', e);
          workerUrl = new URL('./preprocessor.worker.js', window.location.origin);
        }
      } else {
        if (process.env.NODE_ENV === 'development') {
          workerUrl = new URL('/src/js/core/preprocessor.worker.js', window.location.origin);
        } else {
          workerUrl = new URL('./preprocessor.worker.js', import.meta.url);
        }
      }

      // Create module worker (so `import` / ES modules are allowed inside worker)
      this.worker = new Worker(workerUrl.href || workerUrl, { type: 'module' });

      // Better logging: show the exact URL fetched
      console.log('PreprocessorWorker: Worker created successfully (module worker) -', workerUrl.href || workerUrl);
      console.log (this.worker);
      // === Robust worker error handlers  ===
      this.worker.onerror = (ev) => {
        try {
          // Try to extract best possible information
          const info = {
            message: ev?.message ?? null,
            filename: ev?.filename ?? null,
            lineno: ev?.lineno ?? null,
            colno: ev?.colno ?? null,
            errorMessage: ev?.error ? (ev.error.message || String(ev.error)) : null,
            errorStack: ev?.error && ev.error.stack ? ev.error.stack : null,
            event: (() => {
              try { return JSON.parse(JSON.stringify(ev)); } catch (_) { return ev; }
            })()
          };
          console.error('PreprocessorWorker: worker.onerror:', info);

        } catch (logErr) {
          console.error('PreprocessorWorker: worker.onerror logging failed', logErr, ev);
        }

        // Ask the worker for an internal diagnostic dump (best-effort; worker must implement the op)
        // This helps when the event lacks filename/lineno info.
        try {
          this.worker.postMessage({ op: '__request_diagnostics', ts: Date.now() });
        } catch (e) {
          // ignore - couldn't request diagnostics
          console.warn('PreprocessorWorker: could not request worker diagnostics', e);
        }
      };

      this.worker.onmessageerror = (ev) => {
        try {
          console.error('PreprocessorWorker: worker.onmessageerror:', ev);
        } catch (err) {
          console.error('PreprocessorWorker: failed to log onmessageerror', err);
        }
      };

      // Also listen for structured worker-side error messages (worker posts {event: 'worker:error', ...})
      const _workerMessageHandler = this.worker.onmessage;
      this.worker.onmessage = (ev) => {
        try {
          const data = ev.data || {};
          if (data && data.event === 'worker:error') {
            // Surface worker-provided error payload clearly
            console.error('PreprocessorWorker: Worker reported error payload:', data);
          } else if (data && data.event === 'worker:diag') {
            console.info('PreprocessorWorker: Worker diagnostics:', data);
          }
        } catch (e) {
          console.warn('PreprocessorWorker: error while handling worker message for diagnostics', e);
        } finally {
          // Call through to existing handler so normal logic still runs
          try { if (typeof _workerMessageHandler === 'function') _workerMessageHandler(ev); } catch (e) { console.warn('PreprocessorWorker: original onmessage failed', e); }
        }
      };

      this.worker.onmessageerror = (ev) => {
        console.error('PreprocessorWorker: worker.onmessageerror:', ev);
      };

    } catch (err) {
      console.error('PreprocessorWorker: Failed to create module worker', err);
      throw err;
    }

    // Add timeout for worker readiness
    this.readyTimeout = setTimeout(() => {
      if (!this.workerReady) {
        console.error('PreprocessorWorker: Worker failed to become ready within 10 seconds');
        // Only show state info if there's actually an error
        console.log('PreprocessorWorker: Current state:', {
          workerReady: this.workerReady,
          queuedFrames: this.queuedFrames.length,
          pendingJobs: this.pending.size
        });
      }
    }, 10000);

    // Set up message handler
    this.worker.onmessage = (ev) => {
      const data = ev.data || {};
      // Silenced recurring debug: console.log('PreprocessorWorker: Received message:', data.event, data);
      if (data.event === 'worker:ready') {
        clearTimeout(this.readyTimeout);
        this.workerReady = true;

        // Only show detailed diagnostics if there are queued frames or issues
        const queuedCount = this.queuedFrames.length;
        if (queuedCount > 0) {
          console.log(`PreprocessorWorker: Processing ${queuedCount} queued frames`);
        }

        // Process any queued frames (staggered)
        try {
          this._processQueuedFrames();
        } catch (e) {
          console.warn('PreprocessorWorker: error processing queued frames on ready', e);
        }

        // Re-broadcast feature flags so the freshly-initialized worker and any worker-side listeners see them.
        // Use dynamic import to avoid potential circular imports with main.js
        (async () => {
          try {
            // Correct relative path from src/js/core/PreProcessorWorker.js -> src/config/featureFlags.js
            const mod = await import('../../config/featureFlags.js').catch(() => null);
            const ff = mod && (mod.default || mod);
            if (ff && typeof ff.broadcastCurrentFlags === 'function') {
              try { ff.broadcastCurrentFlags(); } catch (e) { console.warn('PreprocessorWorker: broadcastCurrentFlags failed', e); }
            }
          } catch (e) {
            // Best-effort; do not fail worker startup if import fails
            console.warn('PreprocessorWorker: dynamic import of featureFlags failed', e);
          }
        })();

        // Invoke any registered "ready" callbacks asynchronously and clear the registry
        try {
          const callbacks = this._readyCallbacks ? this._readyCallbacks.slice() : [];
          this._readyCallbacks = []; // clear registry to avoid duplicate calls

          // call asynchronously to avoid reentrancy into the message handler
          callbacks.forEach(cb => {
            try {
              setTimeout(() => {
                try { cb(); } catch (e) { console.warn('PreprocessorWorker: ready callback error', e); }
              }, 0);
            } catch (e) {
              console.warn('PreprocessorWorker: scheduling ready callback failed', e);
            }
          });
        } catch (e) {
          console.warn('PreprocessorWorker: error invoking ready callbacks', e);
        }
      }
      else if (data.event === 'worker:error') {
        console.error('PreprocessorWorker: worker initialization error', data.error);
        this.workerReady = false;
        clearTimeout(this.readyTimeout);

      } else if (data.event === 'artifact:ready') {
        // Silenced recurring info: console.info('PreprocessorWorker: artifact ready', data.jobId, data.keys || data.key);
        this._updateProcessingMetrics(data);

        // If this pending job used a calibration metaKey, decrement reference count
        const pendingEntry = this.pending.get(data.jobId);
        if (pendingEntry) {
          const usedMeta = pendingEntry.calibMetaKeyUsed;
          if (usedMeta) {
            const cur = this.calibRefCounts.get(usedMeta) || 0;
            const next = Math.max(0, cur - 1);
            if (next === 0) this.calibRefCounts.delete(usedMeta);
            else this.calibRefCounts.set(usedMeta, next);
          }
        }

        this.pending.delete(data.jobId);

      } else if (data.event === 'artifact:error') {
        console.warn('PreprocessorWorker: artifact error', data.jobId, data.error);

        // If the failed job used calibration metaKey, decrement refcount to avoid leak
        const pendingEntry = this.pending.get(data.jobId);
        if (pendingEntry) {
          const usedMeta = pendingEntry.calibMetaKeyUsed;
          if (usedMeta) {
            const cur = this.calibRefCounts.get(usedMeta) || 0;
            const next = Math.max(0, cur - 1);
            if (next === 0) this.calibRefCounts.delete(usedMeta);
            else this.calibRefCounts.set(usedMeta, next);
          }
        }

        this.pending.delete(data.jobId);

      // Calibration lifecycle messages from worker
      } else if (data.event === 'calibration:ready') {
        // Worker has computed calibration and persisted artifacts; capture metaKey
        // data.metaKey is the storage key pointing to the calibration manifest
        this.calibrationMetaKey = data.metaKey || null;
        this.calibrationMeta = data.meta || null;

        // Small log for observability
        console.log('PreprocessorWorker: calibration ready, metaKey=', this.calibrationMetaKey);

        // Resolve any pending fetchProms that were waiting for this exact metaKey
        if (this.pendingFetches.size > 0) {
          // resolve any fetch waiting on this metaKey
          const entry = this.pendingFetches.get(this.calibrationMetaKey);
          if (entry) {
            clearTimeout(entry.timeout);
            entry.resolve({
              jobId: data.jobId || null,
              metaKey: this.calibrationMetaKey,
              meta: this.calibrationMeta,
              darkFrame: data.darkFrame || null,
              flatFrame: data.flatFrame || null
            });
            this.pendingFetches.delete(this.calibrationMetaKey);
          }
        }

        // No further action required here.

      } else if (data.event === 'calibration:invalidated') {
        console.log('PreprocessorWorker: Calibration invalidated by worker');

      } else if (data.event === 'calibration:fetched') {
        // Worker responded to a direct fetch request (if worker implements op:'fetchCalibration')
        // data: { jobId, metaKey, meta, darkFrame?, flatFrame?, releaseToken? }
        const key = data.metaKey || data.jobId;
        const pending = this.pendingFetches.get(key) || this.pendingFetches.get(data.jobId);
        if (pending) {
          clearTimeout(pending.timeout);

          // Record metaKey/meta in wrapper when worker returns fetched calibration
          this.calibrationMetaKey = data.metaKey || this.calibrationMetaKey;
          this.calibrationMeta = data.meta || this.calibrationMeta;

          // If worker returned a releaseToken, attach to the pending entry and include in resolve
          const releaseToken = data.releaseToken || null;
          if (releaseToken) {
            pending.releaseToken = releaseToken;
          }

          pending.resolve({
            jobId: data.jobId || null,
            metaKey: data.metaKey || null,
            meta: data.meta || null,
            darkFrame: data.darkFrame || null,
            flatFrame: data.flatFrame || null,
            releaseToken
          });
          // clean up
          this.pendingFetches.delete(key);
          this.pendingFetches.delete(data.jobId);
        } else {
          console.info('PreprocessorWorker: calibration:fetched (no pending request)', data.metaKey);
        }

      } else if (data.event === 'calibration:fetch_error') {
        // Worker replied that the fetch failed
        const key = data.metaKey || data.jobId;
        const pending = this.pendingFetches.get(key) || this.pendingFetches.get(data.jobId);
        if (pending) {
          clearTimeout(pending.timeout);
          pending.reject(new Error(data.error || 'fetch_error'));
          this.pendingFetches.delete(key);
          this.pendingFetches.delete(data.jobId);
        } else {
          console.warn('PreprocessorWorker: calibration:fetch_error (no pending request)', data.error);
        }

      } else if (data.event === 'progress') {
        // Handle progress updates for calibration and other operations
        if (data.stage && (data.stage.includes('calibration') || data.stage === 'applying_calibration')) {
          console.log(`PreprocessorWorker: ${data.stage} progress for job ${data.jobId}`);
        }

      } else {
        // Silenced debug: console.debug('PreprocessorWorker:onmessage', data);
      }
    };

    // (Optional) Provide a second-layer onerror handler that gives richer diagnostics
    // This will replace the earlier lightweight handler if necessary.
    this.worker.onerror = (ev) => {
      try {
        console.error('PreprocessorWorker: worker error', ev.message || ev);
        console.error('PreprocessorWorker: worker error details:', {
          filename: ev.filename,
          lineno: ev.lineno,
          colno: ev.colno,
          error: ev.error
        });
      } catch (e) {
        console.error('PreprocessorWorker: error in onerror handler', e);
      }
      clearTimeout(this.readyTimeout);
    };

    this.worker.onmessageerror = (ev) => {
      try {
        console.error('PreprocessorWorker: worker message error', ev);
      } catch (e) {
        console.error('PreprocessorWorker: error logging onmessageerror', e);
      }
      clearTimeout(this.readyTimeout);
    };
  }

  // Enhanced frame enqueueing with backpressure
  enqueueFrame(imageBitmap, meta = {}, options = {}) {
    // Check if we should apply backpressure
    if (this._shouldApplyBackpressure()) {
      this._applyBackpressure(imageBitmap);
      return { ok: false, reason: 'BACKPRESSURE_ACTIVE', queued: false };
    }

    if (!this.workerReady) {
      return this._queueFrame(imageBitmap, meta, options);
    }

    return this._enqueueFrameImmediate(imageBitmap, meta, options);
  }

  _shouldApplyBackpressure() {
    // Apply backpressure if:
    // 1. Queue is more than 80% full
    // 2. Processing rate is significantly slower than incoming rate
    // 3. Drop rate is too high

    const queueUtilization = this.queuedFrames.length / this.maxQueueSize;
    const highQueuePressure = queueUtilization > 0.8;
    const highDropRate = this.metrics.dropRate > 0.3; // More than 30% drops

    return highQueuePressure || highDropRate;
  }

  _applyBackpressure(imageBitmap) {
    // Close the bitmap to prevent memory leaks
    try {
      imageBitmap.close();
    } catch (e) {}

    if (!this.backpressureActive) {
      this.backpressureActive = true;
      this.metrics.backpressureActive = true;
      console.warn('PreprocessorWorker: Backpressure activated - dropping frames to prevent overflow');
    }

    this.droppedCount++;
    this._updateDropRate();
  }

  _queueFrame(imageBitmap, meta, options) {
    // Silenced debug: console.debug('PreprocessorWorker: worker not ready, queuing frame');

    // Enhanced queue management with priority
    const frameData = {
      imageBitmap,
      meta,
      options,
      timestamp: Date.now(),
      priority: this._calculateFramePriority(meta, options)
    };

    if (this.queuedFrames.length >= this.maxQueueSize) {
      // Remove lowest priority frame or oldest frame
      const victimIndex = this._findVictimFrame();
      const victim = this.queuedFrames.splice(victimIndex, 1)[0];

      try {
        victim.imageBitmap.close();
      } catch (e) {}

      this.droppedCount++;
      console.warn('PreprocessorWorker: dropped queued frame due to queue overflow');
    }

    this.queuedFrames.push(frameData);
    this._updateQueueMetrics();

    return { ok: true, jobId: null, queued: true };
  }

  _calculateFramePriority(meta, options) {
    // Higher number = higher priority
    let priority = 0;

    // Prioritize final processing over preview
    if (options.mode === 'final') priority += 10;

    // Prioritize frames with motion detection
    if (meta.hasMotion) priority += 5;

    // Prioritize keyframes or significant frames
    if (meta.isKeyframe) priority += 3;

    return priority;
  }

  _findVictimFrame() {
    // Find the frame with lowest priority, or oldest if priorities are equal
    let victimIndex = 0;
    let lowestPriority = this.queuedFrames[0]?.priority || 0;
    let oldestTime = this.queuedFrames[0]?.timestamp || Date.now();

    for (let i = 1; i < this.queuedFrames.length; i++) {
      const frame = this.queuedFrames[i];
      if (frame.priority < lowestPriority ||
        (frame.priority === lowestPriority && frame.timestamp < oldestTime)) {
        victimIndex = i;
        lowestPriority = frame.priority;
        oldestTime = frame.timestamp;
      }
    }

    return victimIndex;
  }

  _processQueuedFrames() {
    // Sort by priority (highest first) then by timestamp (newest first)
    this.queuedFrames.sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      return b.timestamp - a.timestamp;
    });

    const queued = [...this.queuedFrames];
    this.queuedFrames = [];

    // Process frames with slight delay to prevent overwhelming worker
    queued.forEach((frameData, index) => {
      setTimeout(() => {
        this._enqueueFrameImmediate(frameData.imageBitmap, frameData.meta, frameData.options);
      }, index * 10); // 10ms stagger
    });
  }

  _enqueueFrameImmediate(imageBitmap, meta = {}, options = {}) {
    const jobId = `pre-${Date.now()}-${(this.jobCounter++).toString(36)}`;
    // Silenced recurring debug: console.debug('PreprocessorWorker.enqueueFrame', jobId, meta, options);

    // Determine calibration metaKey used (if we currently have one and applyCalibration requested)
    const calibMetaKey = (options.applyCalibration && this.calibrationMetaKey) ? this.calibrationMetaKey : null;

    // If this frame will reference calibration, increment refcount so main wrapper tracks retention
    if (calibMetaKey) {
      const cur = this.calibRefCounts.get(calibMetaKey) || 0;
      this.calibRefCounts.set(calibMetaKey, cur + 1);
    }

    this.pending.set(jobId, {
      meta,
      ts: Date.now(),
      options,
      startTime: Date.now(),
      calibMetaKeyUsed: calibMetaKey // attach for later decrement
    });

    try {
      this.worker.postMessage({
        op: 'preprocess',
        jobId,
        meta,
        options,
        imageBitmap
      }, [imageBitmap]);

      return { ok: true, jobId };

    } catch (err) {
      console.error('PreprocessorWorker: failed to postImageBitmap to worker', err);
      try {
        imageBitmap.close();
      } catch (e) {}
      // If we incremented refcount above, roll it back
      if (calibMetaKey) {
        const cur = this.calibRefCounts.get(calibMetaKey) || 1;
        const next = Math.max(0, cur - 1);
        if (next === 0) this.calibRefCounts.delete(calibMetaKey);
        else this.calibRefCounts.set(calibMetaKey, next);
      }
      this.pending.delete(jobId);
      return { ok: false, reason: 'POST_FAILED', error: String(err) };
    }
  }

  _updateProcessingMetrics(data) {
    this.processedCount++;

    const job = this.pending.get(data.jobId);
    if (job) {
      const processingTime = Date.now() - job.startTime;
      this.metrics.avgProcessingTime = (this.metrics.avgProcessingTime * 0.9) + (processingTime * 0.1);
    }

    // Update throughput
    const now = Date.now();
    const timeDelta = now - this.lastProcessedTime;
    if (timeDelta > 1000) { // Update every second
      this.metrics.throughput = (this.processedCount * 1000) / timeDelta;
      this.lastProcessedTime = now;
      this.processedCount = 0;
    }

    this._updateDropRate();
    this._checkBackpressureRelease();
  }

  _updateQueueMetrics() {
    this.metrics.queueUtilization = this.queuedFrames.length / this.maxQueueSize;
  }

  _updateDropRate() {
    const total = this.processedCount + this.droppedCount;
    this.metrics.dropRate = total > 0 ? this.droppedCount / total : 0;
  }

  _checkBackpressureRelease() {
    if (this.backpressureActive) {
      const queueUtilization = this.queuedFrames.length / this.maxQueueSize;

      // Release backpressure when conditions improve
      if (queueUtilization < 0.5 && this.metrics.dropRate < 0.1) {
        this.backpressureActive = false;
        this.metrics.backpressureActive = false;
        console.log('PreprocessorWorker: Backpressure released - normal processing resumed');
      }
    }
  }

  // Enhanced metrics including backpressure status
  getMetrics() {
    // Defensive check to prevent undefined errors
    if (!this.pending) {
      console.warn('PreprocessorWorker.getMetrics: pending Map not initialized');
      return {
        workerReady: this.workerReady || false,
        pending: 0,
        queuedFrames: this.queuedFrames ? this.queuedFrames.length : 0,
        maxQueueSize: this.maxQueueSize || 30,
        totalJobs: this.jobCounter || 0,
        droppedCount: this.droppedCount || 0,
        backpressureActive: this.backpressureActive || false,
        calibrationSupported: true,
        ...this.metrics
      };
    }

    return {
      workerReady: this.workerReady,
      pending: this.pending.size,
      queuedFrames: this.queuedFrames.length,
      maxQueueSize: this.maxQueueSize,
      totalJobs: this.jobCounter,
      droppedCount: this.droppedCount,
      backpressureActive: this.backpressureActive,
      calibrationSupported: true,
      ...this.metrics
    };
  }

  // Method to check if worker can accept more frames
  canAcceptFrames() {
    return this.workerReady && !this._shouldApplyBackpressure();
  }

  // Method to get processing capacity status
  getCapacityStatus() {
    const utilization = this.metrics.queueUtilization;

    if (utilization < 0.3) return 'low';
    if (utilization < 0.7) return 'medium';
    if (utilization < 0.9) return 'high';
    return 'critical';
  }

  /**
   * onReady(cb)
   * Register a callback to be invoked once the underlying worker becomes ready.
   * If the worker is already ready, the callback will be scheduled asynchronously.
   * Returns an unsubscribe function.
   */
  onReady(cb) {
    if (typeof cb === 'function') {
      if (this.workerReady) {
        try { setTimeout(() => { try { cb(); } catch (e) { console.warn('PreprocessorWorker.onReady callback error', e); } }, 0); } catch (e) { try { cb(); } catch (_) {} }
        return () => {};
      }
      this._readyCallbacks.push(cb);
      return () => {
        const idx = this._readyCallbacks.indexOf(cb);
        if (idx >= 0) this._readyCallbacks.splice(idx, 1);
      };
    }

    // If no callback provided, return a Promise that resolves when ready
    return new Promise((resolve, reject) => {
      if (this.workerReady) return resolve();
      const wrapper = () => resolve();
      this._readyCallbacks.push(wrapper);
      // Provide a cancellation token via return property (not used often)
      // but consumer can ignore; otherwise they'd have to hang onto wrapper to remove
    });
  }

  // ==================== CALIBRATION METHODS ====================

  // Request calibration computation from worker
  requestCalibration(frames, framesNeeded = 10, resolution) {
    if (!this.workerReady) {
      return Promise.reject(new Error('Worker not ready'));
    }

    if (!Array.isArray(frames) || frames.length === 0) {
      return Promise.reject(new Error('Invalid frames array'));
    }

    if (!resolution || typeof resolution.width !== 'number' || typeof resolution.height !== 'number') {
      return Promise.reject(new Error('Invalid resolution object'));
    }

    const jobId = `cal-${Date.now()}-${(this.jobCounter++).toString(36)}`;

    return new Promise((resolve, reject) => {
      // response handler
      const handleResponse = (ev) => {
        const data = ev.data || {};
          // FIXED: Only process messages with matching jobId
            if (!data.jobId || data.jobId !== jobId) {
            return; // Silently ignore, don't throw
          }

        // Worker replied for our jobId — remove listener
        this.worker.removeEventListener('message', handleResponse);

        if (data.event === 'calibration:ready') {
          // Worker computed calibration and (ideally) persisted artifacts.
          // Accept metaKey, meta, darkFrame, flatFrame, and optional releaseToken
          this.calibrationMetaKey = data.metaKey || this.calibrationMetaKey;
          this.calibrationMeta = data.meta || this.calibrationMeta;

          // Resolve with extra releaseToken if worker provided it
          resolve({
            darkFrame: data.darkFrame || null,
            flatFrame: data.flatFrame || null,
            meta: data.meta || null,
            metaKey: data.metaKey || null,
            releaseToken: data.releaseToken || null
          });

        } else if (data.event === 'calibration:error') {
          reject(new Error(data.error || 'calibration_failed'));
        } else {
          // Only reject for truly unexpected responses with matching jobId
          reject(new Error(`unexpected_calibration_response: ${data.event}`));
        }
      };

      this.worker.addEventListener('message', handleResponse);

      // Timeout guard
      const timeout = setTimeout(() => {
        this.worker.removeEventListener('message', handleResponse);
        reject(new Error('Calibration computation timeout'));
      }, 60000); // 60s - keep same as before

      // Attempt to post frames (transfer)
      try {
        this.worker.postMessage({
          op: 'computeCalibration',
          jobId,
          frames,
          framesNeeded,
          resolution
        }, frames); // transfer ImageBitmaps

        console.log(`PreprocessorWorker: Requested calibration computation with ${frames.length} frames (jobId=${jobId})`);
      } catch (err) {
        clearTimeout(timeout);
        this.worker.removeEventListener('message', handleResponse);
        console.error('PreprocessorWorker: Failed to request calibration computation:', err);
        reject(err);
      }
    });
  }

  // Invalidate current calibration in worker
  invalidateCalibration() {
    if (!this.workerReady) {
      console.warn('PreprocessorWorker: Cannot invalidate calibration - worker not ready');
      return;
    }

    try {
      this.worker.postMessage({ op: 'invalidateCalibration' });
      console.log('PreprocessorWorker: Requested calibration invalidation');
    } catch (err) {
      console.error('PreprocessorWorker: Failed to invalidate calibration:', err);
    }
  }

  // Get current calibration metadata from worker
  getCalibrationMeta() {
    if (!this.workerReady) {
      return Promise.reject(new Error('Worker not ready'));
    }

    return new Promise((resolve) => {
      const handleResponse = (ev) => {
        const data = ev.data || {};

        if (data.event === 'calibration:meta') {
          this.worker.removeEventListener('message', handleResponse);
          resolve(data.meta);
        }
      };

      this.worker.addEventListener('message', handleResponse);

      // Set timeout
      const timeout = setTimeout(() => {
        this.worker.removeEventListener('message', handleResponse);
        resolve({
          isCalibrated: false,
          frameCount: 0,
          resolution: null,
          createdAt: null,
          age: null
        }); // Return default meta on timeout
      }, 5000);

      try {
        this.worker.postMessage({ op: 'getCalibrationMeta' });
      } catch (err) {
        clearTimeout(timeout);
        this.worker.removeEventListener('message', handleResponse);
        console.error('PreprocessorWorker: Failed to get calibration meta:', err);
        resolve({
          isCalibrated: false,
          frameCount: 0,
          resolution: null,
          createdAt: null,
          age: null
        });
      }
    });
  }

  // Enhanced frame enqueueing with calibration option
  enqueueFrameWithCalibration(imageBitmap, meta = {}, options = {}) {
    // Set default calibration option based on mode
    const enhancedOptions = {
      applyCalibration: options.mode === 'final', // Apply calibration for final processing by default
      ...options
    };

    return this.enqueueFrame(imageBitmap, meta, enhancedOptions);
  }

  // ---------------------------
  // NEW: fetchPersistedCalibration
  // Try asking the worker for persisted calibration bitmaps & meta first.
  // If worker doesn't respond in `timeoutMs`, fall back to reading from storage
  // in main (dynamic import of storage.js), returning meta + bitmaps.
  // the worker will NOT transfer the bias array; call
  // getBiasArrayFromStorage(metaKey) to fetch bias if needed in main.
  // ---------------------------
  fetchPersistedCalibration(metaKey = null, timeoutMs = 5000) {
    if (!this.workerReady) {
      return Promise.reject(new Error('Worker not ready'));
    }
    if (!metaKey && !this.calibrationMetaKey) {
      return Promise.reject(new Error('metaKey required or worker must have computed calibration first'));
    }
    const key = metaKey || this.calibrationMetaKey;
    const jobId = `fetchcal-${Date.now()}-${(this.jobCounter++).toString(36)}`;

    // First, try asking the worker to fetch (if worker implements op:'fetchCalibration').
    // Still, we install a fallback to pull from storage directly in main.
    return new Promise((resolve, reject) => {
      // If someone else is already waiting on this exact key, piggyback on it
      if (this.pendingFetches.has(key)) {
        const entry = this.pendingFetches.get(key);
        // wrap to resolve when that entry resolves
        entry.promise.then(resolve).catch(reject);
        return;
      }

      const timeout = setTimeout(async () => {
        // worker didn't reply in time -> fallback to reading storage directly
        this.pendingFetches.delete(key);
        try {
          const fallback = await this._fetchCalibrationFromStorageDirect(key);
          resolve(fallback);
        } catch (err) {
          reject(err);
        }
      }, timeoutMs);

      // store a pending entry
      let resolveFn, rejectFn;
      const prom = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
      this.pendingFetches.set(key, { resolve: resolveFn, reject: rejectFn, timeout, promise: prom, jobId });

      // send request to worker
      try {
        this.worker.postMessage({ op: 'fetchCalibration', jobId, metaKey: key });
      } catch (err) {
        clearTimeout(timeout);
        this.pendingFetches.delete(key);
        // fallback to direct storage fetch
        this._fetchCalibrationFromStorageDirect(key).then(resolve).catch(reject);
      }

      // tie the internal promise into our outer one
      prom.then(resolve).catch(reject);
    });
  }

  // Helper: dynamic storage import + fetch meta + bitmaps (used as fallback)
  async _fetchCalibrationFromStorageDirect(metaKey) {
    try {
      // Robust dynamic loader for storage API in main context
      let storage = null;
      if (typeof window !== 'undefined' && window.storageAPI) {
        storage = window.storageAPI;
      } else if (typeof self !== 'undefined' && self.storageAPI) {
        storage = self.storageAPI;
      } else {
        // attempt dynamic import robustly - storage.js may expose default or named exports
        const mod = await import('/src/js/core/storage.js').catch(() => null);
        if (!mod) throw new Error('Failed to import storage module for fallback fetch');
        storage = mod.default || mod.storageAPI || mod;
      }

      if (!storage || typeof storage.getArtifact !== 'function') {
        throw new Error('Storage API not available in main thread for fallback fetch');
      }

      const metaArtifact = await storage.getArtifact(metaKey);
      if (!metaArtifact || !metaArtifact.data) {
        throw new Error(`Calibration meta not found in storage for key ${metaKey}`);
      }

      const { darkKey, flatKey, biasKey } = metaArtifact.data;

      const darkArt = darkKey ? await storage.getArtifact(darkKey) : null;
      const flatArt = flatKey ? await storage.getArtifact(flatKey) : null;
      // We do NOT automatically fetch bias here (per preference B); use getBiasArrayFromStorage if needed.

      const darkBitmap = (darkArt && darkArt.blob) ? await createImageBitmap(darkArt.blob) : null;
      const flatBitmap = (flatArt && flatArt.blob) ? await createImageBitmap(flatArt.blob) : null;

      // update local pointers
      this.calibrationMetaKey = metaKey;
      this.calibrationMeta = metaArtifact.data;

      return {
        jobId: null,
        metaKey,
        meta: metaArtifact.data,
        darkFrame: darkBitmap,
        flatFrame: flatBitmap
      };

    } catch (err) {
      console.error('PreprocessorWorker._fetchCalibrationFromStorageDirect failed', err);
      throw err;
    }
  }

  // Helper: fetch bias Float32Array from storage (separate API per preference B)
  async getBiasArrayFromStorage(metaKey) {
    try {
      if (!metaKey && !this.calibrationMetaKey) throw new Error('metaKey required to fetch bias');
      const key = metaKey || this.calibrationMetaKey;

      // dynamic load of storage API
      let storage = null;
      if (typeof window !== 'undefined' && window.storageAPI) {
        storage = window.storageAPI;
      } else if (typeof self !== 'undefined' && self.storageAPI) {
        storage = self.storageAPI;
      } else {
        const mod = await import('/src/js/core/storage.js').catch(() => null);
        if (!mod) throw new Error('Failed to import storage module for bias fetch');
        storage = mod.default || mod.storageAPI || mod;
      }

      if (!storage || typeof storage.getArtifact !== 'function') {
        throw new Error('Storage API not available in main thread to fetch bias');
      }

      const metaArtifact = await storage.getArtifact(key);
      if (!metaArtifact || !metaArtifact.data) {
        throw new Error(`Calibration meta not found for key ${key}`);
      }

      const biasKey = metaArtifact.data && metaArtifact.data.biasKey;
      if (!biasKey) {
        return null; // no bias present
      }

      const biasArtifact = await storage.getArtifact(biasKey);
      if (!biasArtifact || !biasArtifact.blob) {
        return null;
      }

      const ab = await biasArtifact.blob.arrayBuffer();
      return new Float32Array(ab);

    } catch (err) {
      console.error('PreprocessorWorker.getBiasArrayFromStorage failed', err);
      throw err;
    }
  }

  terminate() {
    try {
      if (this.readyTimeout) {
        clearTimeout(this.readyTimeout);
      }

      // Clean up any queued frames
      this.queuedFrames.forEach(({ imageBitmap }) => {
        try {
          imageBitmap.close();
        } catch (e) {}
      });
      this.queuedFrames = [];

      if (this.worker) {
        try {
          this.worker.postMessage({ op: 'shutdown' });
        } catch (e) {
          // ignore post shutdown errors
        }
        try { this.worker.terminate(); } catch (e) {}
      }
    } catch (e) {
      console.warn('PreprocessorWorker.terminate failed', e);
    } finally {
      // Clear any pending ready callbacks to avoid leaks
      try {
        if (Array.isArray(this._readyCallbacks) && this._readyCallbacks.length > 0) {
          // Optionally call them with an error or just drop them. We'll drop them to avoid cross-calls.
          this._readyCallbacks.length = 0;
        }
      } catch (e) {
        // ignore
      }
      this.worker = null;
      this.pending.clear();
      this.workerReady = false;
      this.backpressureActive = false;
    }
  }

  // Wrapper helper: tell worker to release a calibration token when we're done with bitmaps.
  // token: the releaseToken returned by calibration:fetched
  releaseCalibrationToken(token) {
    if (!token || !this.workerReady) return;
    try {
      this.worker.postMessage({ op: 'releaseCalibration', token });
    } catch (err) {
      console.warn('PreprocessorWorker.releaseCalibrationToken failed', err);
    }
  }
}
