// /src/js/core/motion.worker.js
// ES module worker: computes flux artifacts using MultiSampler and persists to storage.
// Listens on BroadcastChannel 'motion-painter-store' for flags and calibration events.
// Accepts postMessage commands for targeted jobs.
//
// NOTE: uses absolute imports so it resolves regardless of where the worker is instantiated.

import MultiSampler from '/src/js/sampler/MultiSampler.js';

const BC_CHANNEL = 'motion-painter-store';
const bc = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel(BC_CHANNEL) : null;

// Internal state
let _flags = {};
let _running = true;
let _jobs = new Map(); // jobId -> {resolve,reject,meta}
let _metrics = {
  jobsHandled: 0,
  lastError: null,
  avgProcessingMs: 0,
  totalProcessingMs: 0
};

// ---------------------------------------------------------------------------
// Storage adapter + retry utilities
// ---------------------------------------------------------------------------

/**
 * _wrapStorage(raw)
 * Given a storage module (various export shapes), create a wrapper with
 * canonical helpers used by this worker: getArtifact, putArtifact, removeArtifact.
 *
 * This is defensive: it tolerates a range of names used by different storage implementations.
 */
function _wrapStorage(raw) {
  if (!raw) throw new Error('No storage module provided to _wrapStorage');

  const tryFn = (names) => {
    for (const n of names) {
      if (typeof raw[n] === 'function') {
        return raw[n].bind(raw);
      }
    }
    return null;
  };

  const getArtifact = tryFn(['getArtifact', 'get', 'getItem', 'readArtifact', 'fetchArtifact']);
  const putArtifact = tryFn(['putArtifact', 'saveArtifact', 'storeArtifact', 'put', 'set', 'putInboundArtifact', 'saveInboundArtifact']);
  const removeArtifact = tryFn(['removeArtifact', 'deleteArtifact', 'remove', 'del']);

  return {
    raw,
    getArtifact,
    putArtifact,
    removeArtifact
  };
}

/**
 * _retryable(fn, attempts, baseDelay)
 * Lightweight retry wrapper that retries the provided async function for a few attempts
 * when encountering transient IndexedDB / storage errors (InvalidStateError, locked, timeout, etc).
 */
async function _retryable(fn, attempts = 4, baseDelay = 120) {
  let lastErr = null;
  for (let i = 0; i < attempts; ++i) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Recognize a set of likely transient messages and retry those only.
      const msg = (err && ((err.name || '') + ' ' + (err.message || ''))).toString().toLowerCase();
      const isTransient = /invalidstateerror|database connection is closing|locked|quotaexceeded|timeout|networkerror|not allowed/i.test(msg);
      if (!isTransient) throw err;
      const delay = baseDelay * (i + 1);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * _loadStorageAPI()
 * Robust dynamic storage loader. Returns the wrapped storage adapter.
 */
async function _loadStorageAPI() {
  try {
    const mod = await import('/src/js/core/storage.js').catch(() => null);
    if (!mod) throw new Error('storage module not available');
    const raw = mod.default || mod.storageAPI || mod;
    return _wrapStorage(raw);
  } catch (err) {
    console.error('motion.worker: failed to import storage.js', err);
    throw err;
  }
}

/**
 * _persistArtifact(storageWrapper, key, blobOrBody, meta)
 * Persist an artifact using the storage adapter. 
 * FIXED: Always include the key in the payload
 */
async function _persistArtifact(storageWrapper, key, blobOrBody, meta = {}) {
  if (!storageWrapper) throw new Error('Storage wrapper required');
  if (!key || typeof key !== 'string') throw new Error('Valid artifact key required');
  
  // Build the complete artifact payload that storage.js expects
  const payload = {
    key,              // CRITICAL: Always include key
    type: meta.type || 'artifact',
    blob: null,
    data: null,
    meta: { ...meta },
    createdAt: new Date().toISOString()
  };

  try {
    // Determine if blobOrBody should go in blob or data field
    if (blobOrBody instanceof Blob) {
      payload.blob = blobOrBody;
    } else if (blobOrBody && blobOrBody.buffer instanceof ArrayBuffer) {
      // TypedArray - convert to blob
      payload.blob = new Blob([blobOrBody.buffer]);
    } else if (blobOrBody && typeof blobOrBody === 'object') {
      // Plain object or structured data - goes in data field
      payload.data = blobOrBody;
    } else {
      // Fallback: treat as data
      payload.data = blobOrBody;
    }

    // Use putInboundArtifact if available (canonical storage.js function)
    if (typeof storageWrapper.putArtifact === 'function') {
      return await _retryable(() => storageWrapper.putArtifact(payload));
    } else if (storageWrapper && storageWrapper.raw && typeof storageWrapper.raw.putInboundArtifact === 'function') {
      // Try raw storage API
      return await _retryable(() => storageWrapper.raw.putInboundArtifact(payload));
    } else if (storageWrapper && storageWrapper.raw && typeof storageWrapper.raw.set === 'function') {
      // Last resort: generic set
      return await _retryable(() => storageWrapper.raw.set(key, payload));
    }

    throw new Error('No known persistence method on storageAPI');
  } catch (err) {
    console.error('motion.worker: persistArtifact failed', err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Flags application helper
// ---------------------------------------------------------------------------

/**
 * _applyFlagsSnapshot(flagsPayload)
 * Apply flags broadcast payloads (featureFlags snapshots) - tolerant handling.
 */
function _applyFlagsSnapshot(flagsPayload = {}) {
  try {
    if (flagsPayload && flagsPayload.flags) {
      _flags = Object.assign({}, _flags, flagsPayload.flags);
      // You may derive local config from flags now (ex: sampler params)
    } else if (typeof flagsPayload === 'object' && Object.keys(flagsPayload).length > 0 && !flagsPayload.flags) {
      // some broadcasts may directly post flags
      _flags = Object.assign({}, _flags, flagsPayload);
    }
  } catch (e) {
    console.warn('motion.worker: failed to apply flags snapshot', e);
  }
}

// ---------------------------------------------------------------------------
// BroadcastChannel handling
// ---------------------------------------------------------------------------

if (bc) {
  bc.onmessage = (ev) => {
    const data = ev.data || {};
    // standard featureFlags broadcast contains event === 'flagsChanged'
    if (data.event === 'flagsChanged') {
      _applyFlagsSnapshot(data);
      return;
    }

    // calibration notifications from PreprocessorWorker / preprocessor.worker
    if (data.event === 'calibration:ready' || data.type === 'calibration:ready') {
      // Expect: { event:'calibration:ready', metaKey, meta, telemetry?, releaseToken? }
      // Kick off flux computation for this calibration manifest
      const metaKey = data.metaKey || (data.key || null);
      if (metaKey) {
        // start an autonomous job (no jobId required)
        _computeFluxFromCalibration(metaKey).catch(err => {
          console.error('motion.worker: background computeFlux error', err);
          _metrics.lastError = String(err);
        });
      }
      return;
    }

    // if other messages you want to handle via BC, add here
    if (data.event === 'calibration:release_request') {
      // other workers might ask to release tokens — ignore or forward to main if needed
      // (main handles release via PreprocessorWorker wrapper)
      return;
    }
  };
}

/**
 * _bcPost(obj)
 * Post to BC (best-effort)
 */
function _bcPost(obj = {}) {
  try {
    if (bc) bc.postMessage(obj);
  } catch (e) {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Message handling from main (postMessage)
// ---------------------------------------------------------------------------

/**
 * self.onmessage handler
 * Accepts:
 *  - { op: 'init', flags } -> worker should apply flags and reply { op: 'inited', ok: true }
 *  - { op: 'computeFlux', jobId, metaKey, calibratedFrameKey, options } -> compute & reply
 *  - { op: 'shutdown' | 'terminate' } -> ack and close
 *  - { op: 'getMetrics' } -> reply with metrics
 *
 * Note: worker does NOT auto-init; it expects explicit init from wrapper/main.
 */
self.onmessage = async (ev) => {
  const data = ev.data || {};
  const op = data.op || data.type || null;

  try {
    if (op === 'init') {
      // optional init payload with flags snapshot
      if (data.flags) _applyFlagsSnapshot({ flags: data.flags });
      self.postMessage({ op: 'inited', ok: true });
      return;
    }

    if (op === 'computeFlux') {
      // expected payload: { jobId, calibratedFrameKey, metaKey, options }
      const { jobId, calibratedFrameKey, metaKey, options = {} } = data;
      try {
        const res = await _computeFluxFromCalibration(metaKey || calibratedFrameKey, options);
        // respond to main thread with job result
        self.postMessage({ op: 'computeFlux:done', jobId: jobId || null, result: res });
      } catch (err) {
        self.postMessage({ op: 'computeFlux:error', jobId: jobId || null, error: String(err) });
      }
      return;
    }

    if (op === 'getMetrics') {
      // Reply with current metrics
      self.postMessage({ op: 'metrics', metrics: _metrics });
      return;
    }

    if (op === 'shutdown' || op === 'terminate') {
      _running = false;
      try { if (bc) bc.close(); } catch (e) {}
      self.postMessage({ op: 'shutdown:ack' });
      self.close(); // worker termination
      return;
    }

    // unknown command: reply
    self.postMessage({ op: 'unknown', received: data });
  } catch (err) {
    console.error('motion.worker: onmessage handler error', err);
    self.postMessage({ op: 'internalError', error: String(err) });
  }
};

// ---------------------------------------------------------------------------
// Core flux computation pipeline
// ---------------------------------------------------------------------------

/**
 * _computeFluxFromCalibration(metaKey, options)
 * - Loads calibration manifest from storage
 * - Fetches calibrated frame blob (requires calibratedFrameKey present in manifest)
 * - Creates ImageBitmap and runs MultiSampler
 * - Persists flux artifact manifest + thumbnail using _persistArtifact
 * - Broadcasts flux:ready when done
 */
async function _computeFluxFromCalibration(metaKey, options = {}) {
  const t0 = performance.now();
  if (!metaKey) throw new Error('metaKey required for computeFlux');

  const storageWrapper = await _loadStorageAPI();

  // Fetch manifest
  const manifest = await storageWrapper.getArtifact(metaKey).catch(err => {
    throw new Error(`Failed to load calibration manifest ${metaKey}: ${err && err.message ? err.message : err}`);
  });

  if (!manifest || !manifest.data) {
    throw new Error(`Calibration manifest missing or invalid for key ${metaKey}`);
  }

  // Expected manifest.data contains darkKey/flatKey/calibVersion/other metadata
  const meta = manifest.data || {};
  const darkKey = meta.darkKey || null;
  const flatKey = meta.flatKey || null;

  // Load calibrated frame blob (prefer a dedicated calibrated frame key in meta)
  // If manifest contains a calibratedFrameKey, use that; otherwise use dark/flat to compute.
  const calibratedFrameKey = meta.calibratedFrameKey || meta.calibratedKey || null;

  let calibratedBlob = null;
  if (calibratedFrameKey) {
    const calArt = await storageWrapper.getArtifact(calibratedFrameKey).catch(() => null);
    calibratedBlob = calArt && calArt.blob ? calArt.blob : null;
  }

  // If no calibratedFrame available, attempt to reconstruct from provided dark/flat if present
  if (!calibratedBlob) {
    // Try reading dark/flat blobs and combine if worker has algorithm (best-effort fallback)
    // For now prefer to throw: flux requires calibrated frame to be meaningful
    throw new Error('No calibrated frame artifact found in manifest; flux requires calibratedFrameKey');
  }

  // Create ImageBitmap for sampling
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(calibratedBlob);
  } catch (err) {
    throw new Error('createImageBitmap failed for calibrated blob: ' + String(err));
  }

  // Configure sampler from flags and options
  const samplerConfig = {
    seed: options.seed || _flags && _flags.fluxSeed || Date.now(),
    timeBudgetMs: options.timeBudgetMs || (_flags && (_flags.fluxTimeBudgetMs || 200)) || 200,
    maxSamplePoints: options.maxSamplePoints || (_flags && _flags.fluxMaxSamplePoints) || 2048,
    minSamplePoints: options.minSamplePoints || 128,
    enableDebugOutput: !!(_flags && _flags.fluxDiagnosticsEnabled),
    varianceStride: options.varianceStride || (_flags && _flags.fluxVarianceStride) || 1,
    enableAdaptiveBlending: true
  };

  const sampler = MultiSampler.createHighPerformance(samplerConfig);

  // perform sampling -> derive flux proxies from sample manifest (this is an example pipeline)
  // In practice you'd compute optical-flow / flux from multiple frames; here we sample the calibrated frame
  let sampleResult = null;
  try {
    sampleResult = await sampler.sample(bitmap, { temporalMode: 'single' });
  } catch (err) {
    bitmap.close();
    throw new Error('MultiSampler.sample failed: ' + String(err));
  }

  // Optionally compute flux field from sample points here
  // For this example we store the sample manifest as the 'flux' artifact — replace with real flux computation
  const fluxKey = `mp:artifact:flux:${(new Date()).toISOString()}:v1`;
  const fluxMeta = {
    type: 'flux-manifest',
    derivedFrom: metaKey,
    samplerConfig,
    sampleManifestSummary: {
      totalPoints: sampleResult.samplePoints?.length || 0,
      processingTime: sampleResult.metadata?.processingTime || null
    },
    timestamp: Date.now()
  };

  // Persist the sample manifest as JSON and a thumbnail for quick access
  try {
    // Save sample manifest JSON
    await _persistArtifact(
      storageWrapper, 
      fluxKey, 
      { 
        manifest: sampleResult, 
        config: samplerConfig,
        summary: fluxMeta.sampleManifestSummary
      },
      fluxMeta
    );

    // Save a small thumbnail blob (for UI preview) if possible
    try {
      const thumbCanvas = new OffscreenCanvas(Math.min(256, bitmap.width), Math.min(256, bitmap.height));
      const ctx = thumbCanvas.getContext('2d');
      const scale = Math.min(thumbCanvas.width / bitmap.width, thumbCanvas.height / bitmap.height);
      const dw = Math.floor(bitmap.width * scale);
      const dh = Math.floor(bitmap.height * scale);
      ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, dw, dh);
      const thumbBlob = await thumbCanvas.convertToBlob({ type: 'image/webp', quality: 0.6 });
      const thumbKey = `${fluxKey}:thumb`;
      await _persistArtifact(
        storageWrapper, 
        thumbKey, 
        thumbBlob, 
        { 
          type: 'flux-thumbnail',
          parent: fluxKey,
          dimensions: { width: dw, height: dh }
        }
      );
      fluxMeta.thumbKey = thumbKey;
    } catch (thumbErr) {
      // non-critical
      console.warn('motion.worker: thumbnail creation failed', thumbErr);
    }
  } catch (persistErr) {
    bitmap.close();
    throw new Error('Failed to persist flux artifact: ' + String(persistErr));
  }

  // done with bitmap
  try { bitmap.close(); } catch (_) {}

  // Telemetry & metrics update
  const t1 = performance.now();
  const elapsed = t1 - t0;
  _metrics.jobsHandled++;
  _metrics.totalProcessingMs += elapsed;
  _metrics.avgProcessingMs = _metrics.totalProcessingMs / _metrics.jobsHandled;

  // Broadcast flux availability so other modules can pick it up
  const bcPayload = {
    event: 'flux:ready',
    fluxKey,
    derivedFrom: metaKey,
    telemetry: {
      processingMs: elapsed,
      points: sampleResult.samplePoints ? sampleResult.samplePoints.length : 0
    }
  };
  _bcPost(bcPayload);

  // If a release token was part of the manifest (meta.releaseToken), request release when appropriate
  // Emit calibration:release_request so main can call preprocessor.releaseCalibrationToken(token)
  if (meta && meta.releaseToken) {
    _bcPost({
      event: 'calibration:release_request',
      releaseToken: meta.releaseToken,
      reason: 'flux-complete'
    });
  }

  // Return summary result for caller
  return {
    fluxKey,
    meta: fluxMeta,
    telemetry: { processingMs: elapsed },
    sampleSummary: sampleResult && { points: sampleResult.samplePoints?.length || 0 }
  };
}

// expose health endpoint via message query (already handled in onmessage above via 'getMetrics')
// keep worker alive unless terminated
// (closing will be handled via 'shutdown' op)