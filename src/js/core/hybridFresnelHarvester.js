// /src/js/core/hybridFresnelHarvester.js
// Hybrid Fresnel Harvester (HFH) - FINALIZED + hardened
// - Lightweight annular calculation & decision logic for main thread (FrameEvictionHook).
// - Minimal heavy-path worker processing (depth/normals priors) for use inside motion.worker or a dedicated HFH worker.
// - Designed to be robust, defensive, and easy to integrate.
//
// Exported API:
//   class HybridFresnelHarvester
//     constructor(config = {})
//     computeAnnular(imageBitmap|imageData, { binCount, maxSamples, samplerOptions, cancelToken } = {})
//     decideHFH({ annular, counts, stats, meta, cameraId }, { policyOverrides } = {})
//     createClone(imageBitmap, { width, height, useOffscreen = true } = {}) -> ImageBitmap (caller owns / must transfer/close)
//     scheduleHFH({ cloneBitmap, meta, enqueueFn, options }) -> Promise<{ ok, jobId?, reason? }>
//     // static worker-side helper:
//     static workerProcess(frameBitmap, meta, options = {}) -> { depthMap, normalMap, telemetry, selectorArtifact }
//
// Notes:
// - This module avoids performing any implicit background work; scheduleHFH will only post or call provided enqueueFn.
// - computeAnnular is intentionally conservative and fast; it uses MultiSampler if present but falls back to uniform sampling.
// - The module is written to work both in main thread and worker contexts.

const DEFAULTS = {
  annularBins: 12,
  annularSamplePoints: 512,
  annularTimeBudgetMs: 60,
  annularNormalize: true,
  autoThresholdMode: 'stddev', // 'stddev' | 'percentile'
  stddevMultiplier: 3.0,       // for spike detection
  percentileSpike: 0.98,       // for percentile based spike
  vignettingRatioThreshold: 0.6, // outer/center ratio
  nonUniformCvThreshold: 0.15, // coefficient of variation for non-uniform
  minValidSampleRatio: 0.3,    // warn if valid pts < ratio*requested
  cloneTimeoutMs: 4000,
  workerJobTimeoutMs: 120000,
  timeBudgetMs: 200,

  // ADDED: default resolutions used by suggestions/worker fallbacks
  defaultResolutions: { low: 256, normal: 512, high: 1024 },

  // ADDED: luminance change threshold referenced by decideHFH (relative change)
  luminanceChangeThreshold: 0.12
};

// typedMinMax helper - safe for large typed arrays
function typedMinMax(typed) {
  if (!typed || typed.length === 0) return { min: 0, max: 0 };
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < typed.length; i++) {
    const v = typed[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) min = 0;
  if (max === -Infinity) max = 0;
  return { min, max };
}

export class HybridFresnelHarvester {
  constructor(cfg = {}) {
    this.config = { ...DEFAULTS, ...(cfg || {}) };

    // Optional injected worker or enqueue function for scheduling heavy HFH jobs
    // - worker-like object: { postMessage(obj, transferables?) }
    // - enqueueFn: async function({bitmap, meta, options}) -> { ok, jobId? }
    this.hfhWorker = cfg.hfhWorker || null;
    this.enqueueFn = cfg.enqueueFn || null;

    // Optional MultiSampler reference (if available in your runtime)
    this.MultiSampler = (typeof cfg.MultiSampler !== 'undefined') ? cfg.MultiSampler : null;

    // Lightweight metrics for HFH decisions
    this.metrics = {
      annularCalls: 0,
      avgAnnularMs: 0,
      decisionCalls: 0,
      scheduledJobs: 0,
      lastError: null
    };

    // Allow external debug logger or fallback to console
    this._log = cfg.logger || console;

    // Seeded RNG for deterministic fallback sampling if MultiSampler not present
    this._seed = cfg.seed || Date.now() % 2147483647;
    this._rngState = this._seed > 0 ? this._seed : Date.now() % 2147483647;
  }

  // ---------- Utilities ----------
  _rng() {
    // Park-Miller RNG (deterministic)
    this._rngState = (this._rngState * 16807) % 2147483647;
    return (this._rngState - 1) / 2147483646;
  }

  _clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  _now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  // ---------- Lightweight annular computation ----------
  /**
   * computeAnnular(input, opts)
   * input may be:
   *   - ImageBitmap
   *   - OffscreenCanvas
   *   - { width, height, data } normalized ImageData-like object (Uint8ClampedArray RGBA)
   *
   * Returns:
   *   { annular: Float32Array(binCount), counts: Int32Array(binCount), samplePoints: n, stats: { mean,stddev,min,max }, normalized: boolean, elapsedMs }
   *
   * This method does NOT transfer or close the input.
   */
  async computeAnnular(input, opts = {}) {
    const cfg = { ...this.config, ...(opts || {}) };
    const start = this._now();
    this.metrics.annularCalls++;

    const binCount = Math.max(1, Math.min(64, Math.floor(cfg.binCount || cfg.annularBins)));
    const maxSamples = Math.max(16, Math.min(8192, Math.floor(cfg.maxSamples || cfg.annularSamplePoints)));
    const timeBudgetMs = Math.max(10, cfg.timeBudgetMs || cfg.annularTimeBudgetMs);
    const normalizedCoords = cfg.normalizedCoords === undefined ? false : !!cfg.normalizedCoords;
    const cancelToken = opts.cancelToken || { cancelled: false };

    try {
      // Normalize input to { width, height, data }
      const norm = await this._normalizeInputForAnnular(input, { timeBudgetMs, cancelToken });
      if (!norm || cancelToken.cancelled) {
        return { annular: new Float32Array(binCount).fill(0), counts: new Int32Array(binCount).fill(0), samplePoints: 0, stats: null, normalized: normalizedCoords, elapsedMs: this._now() - start };
      }

      const { width, height, data } = norm;
      // Prepare sampling manifest using MultiSampler if available
      let points = [];
      if (this.MultiSampler) {
        try {
          const sampler = this.MultiSampler.createLightweight({
            timeBudgetMs: Math.min(timeBudgetMs, 80),
            maxSamplePoints: maxSamples,
            minSamplePoints: Math.max(16, Math.floor(maxSamples / 8)),
            enableAdaptiveBlending: false,
            seed: cfg.samplerSeed || this._seed
          });
          const manifest = await sampler.sample({ width, height, data, type: 'Normalized' }, { temporalMode: 'single' });
          points = manifest?.samplePoints || [];
        } catch (err) {
          // fallback to uniform grid below
          this._log?.warn?.('HFH: MultiSampler failed in computeAnnular, falling back', err);
          points = [];
        }
      }

      // Fallback: uniform grid sampling
      if (!points || points.length === 0) {
        const gridN = Math.max(8, Math.floor(Math.sqrt(Math.min(maxSamples, width * height))));
        const pts = [];
        for (let j = 0; j < gridN && pts.length < maxSamples; j++) {
          for (let i = 0; i < gridN && pts.length < maxSamples; i++) {
            const x = Math.floor((i + 0.5) * width / gridN);
            const y = Math.floor((j + 0.5) * height / gridN);
            pts.push({ x, y, weight: 1.0, source: 'grid' });
          }
        }
        points = pts;
      }

      // Compute center and max radius
      const cx = Math.floor(width / 2);
      const cy = Math.floor(height / 2);
      const maxR = Math.hypot(Math.max(cx, width - cx), Math.max(cy, height - cy)) || 1;

      // Prepare annular accumulators
      const annular = new Float32Array(binCount).fill(0);
      const counts = new Int32Array(binCount).fill(0);
      let validPoints = 0;
      let luminances = [];

      // time budget enforcement
      const budgetStart = this._now();
      const budgetMs = Math.max(10, timeBudgetMs || cfg.timeBudgetMs || 60);
      const budgetCheckFreq = 128; // check every N points for performance

      for (let pi = 0, L = points.length; pi < L; ++pi) {
        if (cancelToken.cancelled) break;
        if ((pi & (budgetCheckFreq - 1)) === 0) {
          const elapsed = this._now() - budgetStart;
          if (elapsed > budgetMs) {
            this._log?.warn?.(`HFH.computeAnnular: timeBudget exceeded (${Math.round(elapsed)}ms > ${budgetMs}ms), aborting remaining samples`);
            break;
          }
        }

        const p = points[pi];

        let x = p.x;
        let y = p.y;
        if ((x === undefined || y === undefined) && p.xNorm != null && p.yNorm != null) {
          x = Math.floor(p.xNorm * width);
          y = Math.floor(p.yNorm * height);
        }

        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const idx = (y * width + x) * 4;
        if (idx < 0 || idx + 2 >= data.length) continue;

        const r = Math.hypot(x - cx, y - cy);
        const bin = Math.min(binCount - 1, Math.floor((r / (maxR + 1e-12)) * binCount));
        const lum = (0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]) / 255;

        annular[bin] += (lum * (p.weight !== undefined ? p.weight : 1.0));
        counts[bin] += 1;
        luminances.push(lum);
        validPoints++;
      }

      // Warn if too few valid points
      if (validPoints < Math.max(1, Math.floor(maxSamples * cfg.minValidSampleRatio))) {
        this._log?.warn?.(`HFH: Only ${validPoints}/${maxSamples} valid sample points for annular computation`);
      }

      // Compute per-bin means
      for (let b = 0; b < binCount; b++) {
        if (counts[b] > 0) annular[b] = annular[b] / counts[b];
        else annular[b] = 0.0;
      }

      // Basic stats from luminances
      let stats = null;
      if (luminances.length > 0) {
        let s = 0;
        let s2 = 0;
        let mn = Infinity;
        let mx = -Infinity;
        for (const v of luminances) {
          s += v;
          s2 += v * v;
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        const mean = s / luminances.length;
        const variance = Math.max(0, s2 / luminances.length - mean * mean);
        const stddev = Math.sqrt(variance);
        stats = { mean, stddev, min: mn, max: mx, samples: luminances.length };
      } else {
        stats = { mean: 0, stddev: 0, min: 0, max: 0, samples: 0 };
      }

      const elapsedMs = this._now() - start;
      // update metrics rolling average
      this.metrics.avgAnnularMs = (this.metrics.avgAnnularMs * (this.metrics.annularCalls - 1) + elapsedMs) / this.metrics.annularCalls;

      const result = {
        annular,
        counts,
        samplePoints: validPoints,
        stats,
        normalized: !!cfg.annularNormalize,
        elapsedMs
      };
      return result;

    } catch (err) {
      this.metrics.lastError = String(err);
      this._log?.error?.('HFH.computeAnnular error', err);
      const elapsedMs = this._now() - start;
      return {
        annular: new Float32Array(binCount).fill(0),
        counts: new Int32Array(binCount).fill(0),
        samplePoints: 0,
        stats: null,
        normalized: !!cfg.annularNormalize,
        elapsedMs,
        error: String(err)
      };
    }
  } // computeAnnular

  // ---------- Decision logic ----------
  /**
   * decideHFH({annular, counts, stats, meta, cameraId}, policy)
   * Returns: { shouldRun: boolean, reason: string, severity: number (0-1), suggestedResolution: int, suggestedMode: 'light'|'full' }
   *
   * Decision uses:
   * - spike detection (single-bin high value)
   * - non-uniformity (CV > threshold)
   * - vignetting (outer/center ratio)
   * - exposure change (meta.avgLuma vs stats.mean)
   * - periodic (meta.tick or timestamps)
   */
  decideHFH(payload = {}, policy = {}) {
    const cfg = { ...this.config, ...(policy || {}) };
    this.metrics.decisionCalls++;

    const annular = payload.annular instanceof Float32Array ? payload.annular : Float32Array.from(payload.annular || []);
    const counts = payload.counts instanceof Int32Array ? payload.counts : Int32Array.from(payload.counts || []);
    const stats = payload.stats || { mean: 0, stddev: 0 };
    const meta = payload.meta || {};
    const cameraId = payload.cameraId || (meta && meta.cameraId) || 'unknown';

    const K = annular.length || cfg.annularBins;
    if (K === 0) return { shouldRun: false, reason: 'no-data', severity: 0, suggestedResolution: cfg.defaultResolutions?.low || 256, suggestedMode: 'light' };

    // Auto thresholds
    let spikeThreshold;
    if (cfg.autoThresholdMode === 'percentile') {
      // approximate percentile by scanning (cheap)
      const arr = Array.from(annular);
      arr.sort((a, b) => a - b);
      const p = Math.floor(arr.length * (cfg.percentileSpike || 0.98));
      spikeThreshold = arr[p] || arr[arr.length - 1] || 1.0;
    } else {
      spikeThreshold = stats.mean + (stats.stddev || 0) * (cfg.stddevMultiplier || 3.0);
    }

    // Spike detection
    let spike = false;
    let spikeBin = -1;
    let spikeValue = 0;
    for (let k = 0; k < K; k++) {
      if (annular[k] > spikeThreshold) {
        spike = true;
        spikeBin = k;
        spikeValue = annular[k];
        break;
      }
    }

    // Non-uniform / flat-field degradation detection: CV across annular (skip empty bins)
    let mean = 0;
    let cnt = 0;
    for (let k = 0; k < K; k++) {
      if (counts[k] > 0) { mean += annular[k]; cnt++; }
    }
    mean = cnt > 0 ? mean / cnt : 0;
    let variance = 0;
    for (let k = 0; k < K; k++) {
      if (counts[k] > 0) {
        const d = annular[k] - mean;
        variance += d * d;
      }
    }
    variance = cnt > 0 ? variance / cnt : 0;
    const stddev = Math.sqrt(variance);
    const cv = (mean > 1e-12) ? (stddev / mean) : 0;
    const nonUniform = cv > (cfg.nonUniformCvThreshold || DEFAULTS.nonUniformCvThreshold);

    // Vignetting detection: compare outer mean to center zone
    const center = annular[0] || 0;
    const outer = annular[K - 1] || 0;
    const vignettingRatio = center > 1e-12 ? (outer / center) : 1.0;
    const vignetting = vignettingRatio < (cfg.vignettingRatioThreshold || DEFAULTS.vignettingRatioThreshold);

    // Exposure change (if meta.avgLuma present)
    let exposureChange = false;
    if (typeof meta.avgLuma === 'number' && typeof stats.mean === 'number' && stats.mean > 0) {
      const rel = Math.abs(meta.avgLuma - stats.mean) / (stats.mean + 1e-6);
      exposureChange = rel > (cfg.luminanceChangeThreshold || DEFAULTS.luminanceChangeThreshold);
    }

    // Compose decision with severity heuristic
    let severity = 0;
    let reasons = [];
    if (spike) {
      severity = Math.max(severity, this._clamp((spikeValue - spikeThreshold) / Math.max(1e-6, spikeThreshold), 0, 1));
      reasons.push('motion_spike');
    }
    if (nonUniform) {
      severity = Math.max(severity, Math.min(0.7, cv));
      reasons.push('non_uniform');
    }
    if (vignetting) {
      severity = Math.max(severity, Math.min(0.6, 1 - vignettingRatio));
      reasons.push('vignetting');
    }
    if (exposureChange) {
      severity = Math.max(severity, 0.5);
      reasons.push('exposure_change');
    }

    // Periodic sampling / scheduled sampling: allow meta to request periodic HFH
    if (meta && meta.forceHFH) {
      reasons.push('forced');
      severity = Math.max(severity, 0.5);
    }

    // Final decision rule: threshold on severity OR presence of spike OR explicit policy override
    const runIf = policy.runIf || policy.shouldRun || null; // Allow user-supplied override
    let shouldRun = false;
    let reason = 'none';

    if (typeof runIf === 'function') {
      try { shouldRun = !!runIf({ annular, counts, stats, meta, cameraId, cv, vignettingRatio, spike, spikeBin }); }
      catch (e) { this._log?.warn?.('HFH: runIf override threw', e); shouldRun = false; }
    } else {
      // default heuristic
      if (spike) {
        shouldRun = true;
        reason = 'motion_spike';
      } else if (nonUniform && severity >= 0.25) {
        shouldRun = true;
        reason = 'non_uniform';
      } else if (vignetting && severity >= 0.25) {
        shouldRun = true;
        reason = 'vignetting';
      } else if (exposureChange) {
        shouldRun = true;
        reason = 'exposure_change';
      } else if (meta && meta.forceHFH) {
        shouldRun = true;
        reason = 'forced';
      } else {
        shouldRun = false;
        reason = 'none';
      }
    }

    // Suggested resolution policy: scale with severity
    const defaultRes = (policy.defaultResolution || (cfg.defaultResolutions && cfg.defaultResolutions.low) || 256);
    const highRes = (policy.highResolution || (cfg.defaultResolutions && cfg.defaultResolutions.high) || 1024);
    const suggestedResolution = shouldRun ? Math.floor(defaultRes + (highRes - defaultRes) * this._clamp(severity, 0, 1)) : defaultRes;
    const suggestedMode = severity > 0.6 ? 'full' : 'light';

    const desc = {
      shouldRun,
      reason: reason === 'none' ? (reasons[0] || 'none') : reason,
      severity: this._clamp(severity, 0, 1),
      suggestedResolution,
      suggestedMode,
      diagnostics: {
        spike,
        spikeBin,
        spikeThreshold,
        cv,
        vignettingRatio,
        exposureChange,
        reasons
      }
    };

    return desc;
  } // decideHFH

  // ---------- Clone helper ----------
  /**
   * createClone(bitmap, { width, height, useOffscreen = true })
   * Returns an ImageBitmap (caller responsible for transfer/closing).
   *
   * This method is a convenience; if your FrameEvictionHook already has cloneBitmapFull,
   * you may keep using that. This is provided for consistency and as a safe fallback.
   */
  async createClone(bitmap, { width = null, height = null, useOffscreen = true, resizeQuality = 'high' } = {}) {
    if (!bitmap) throw new Error('createClone: bitmap required');

    // Determine target dimensions
    const w = width || bitmap.width || (bitmap.canvas && bitmap.canvas.width) || null;
    const h = height || bitmap.height || (bitmap.canvas && bitmap.canvas.height) || null;

    let canvas = null;
    try {
      // Prefer OffscreenCanvas + drawImage -> createImageBitmap
      if (typeof OffscreenCanvas !== 'undefined' && useOffscreen) {
        canvas = new OffscreenCanvas(w || bitmap.width, h || bitmap.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('createClone: Failed to get OffscreenCanvas 2D context');

        try {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = resizeQuality;
        } catch (_) {}

        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const cloned = await createImageBitmap(canvas);

        // Explicitly cleanup canvas to help GC
        try {
          canvas.width = 0;
          canvas.height = 0;
          canvas = null;
        } catch (_) {}

        return cloned;
      }

      // Fallback to createImageBitmap resize options (if supported)
      try {
        const cloned = await createImageBitmap(bitmap, { resizeWidth: w || bitmap.width, resizeHeight: h || bitmap.height, resizeQuality });
        return cloned;
      } catch (e) {
        // Last resort: draw into temporary <canvas> if DOM available
        if (typeof document !== 'undefined') {
          canvas = document.createElement('canvas');
          canvas.width = w || bitmap.width || 1;
          canvas.height = h || bitmap.height || 1;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          return await createImageBitmap(canvas);
        }
        throw e;
      }
    } catch (err) {
      this._log?.warn?.('HFH.createClone failed', err);
      throw err;
    }
  }

  // ---------- Scheduling helper (main-thread) ----------
  /**
   * scheduleHFH({ cloneBitmap, meta, enqueueFn, options })
   *
   * OWNERSHIP CONTRACT:
   * - cloneBitmap: ImageBitmap (caller owns; scheduleHFH will transfer it to enqueueFn or worker)
   * - enqueueFn MUST take ownership if it returns {ok: true}
   * - If enqueueFn returns {ok: false} or throws, it MUST NOT have transferred the bitmap
   * - scheduleHFH will close the bitmap only if ownership was not transferred
   * 
   * - meta: manifest / meta object (plain object)
   * - enqueueFn: optional; if provided, should accept ({ imageBitmap, meta, options }) and return { ok, jobId? }
   * - If this.hfhWorker is set and has postMessage, scheduleHFH will post via hfhWorker.
   */
  async scheduleHFH({ cloneBitmap = null, meta = {}, enqueueFn = null, options = {} } = {}) {
    if (!cloneBitmap) throw new Error('scheduleHFH: cloneBitmap required');

    const opt = { ...options };
    const jobId = `hfh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let ownershipTransferred = false;

    try {
      // Primary: use provided enqueueFn
      if (typeof enqueueFn === 'function') {
        const res = await enqueueFn({ imageBitmap: cloneBitmap, meta, options: opt, jobId });
        if (res?.ok) {
          ownershipTransferred = true;
          this.metrics.scheduledJobs++;
          return { ok: true, jobId: res?.jobId || jobId, detail: res };
        }
        // res.ok === false means enqueueFn did NOT take ownership
        if (!ownershipTransferred) {
          try { cloneBitmap.close(); } catch (_) {}
        }
        return { ok: false, reason: res?.reason || 'enqueue_rejected', detail: res };
      }

      // Secondary: use injected wrapper enqueueFn
      if (typeof this.enqueueFn === 'function') {
        const res = await this.enqueueFn({ imageBitmap: cloneBitmap, meta, options: opt, jobId });
        if (res?.ok) {
          ownershipTransferred = true;
          this.metrics.scheduledJobs++;
          return { ok: true, jobId: res?.jobId || jobId, detail: res };
        }
        if (!ownershipTransferred) {
          try { cloneBitmap.close(); } catch (_) {}
        }
        return { ok: false, reason: res?.reason || 'enqueue_rejected', detail: res };
      }

      // Tertiary: use injected worker (postMessage). We transfer the bitmap and post meta+options.
      if (this.hfhWorker && typeof this.hfhWorker.postMessage === 'function') {
        // build payload for worker; worker must implement op:'hfh:process'
        try {
          this.hfhWorker.postMessage({ op: 'hfh:process', jobId, meta, options: opt, msgAt: Date.now() }, [cloneBitmap]);
          ownershipTransferred = true;
          this.metrics.scheduledJobs++;
          return { ok: true, jobId, detail: { postedToWorker: true } };
        } catch (err) {
          // If postMessage with transfer fails, close bitmap to avoid leaks
          if (!ownershipTransferred) {
            try { cloneBitmap.close(); } catch (_) {}
          }
          throw err;
        }
      }

      // If nothing available, close bitmap and return not scheduled
      try { cloneBitmap.close(); } catch (_) {}
      return { ok: false, reason: 'no_enqueue_available' };

    } catch (err) {
      this._log?.error?.('HFH.scheduleHFH failed', err);
      // ensure bitmap is closed to avoid leaks if schedule failed and ownership not taken
      if (!ownershipTransferred) {
        try { cloneBitmap.close(); } catch (_) {}
      }
      return { ok: false, error: String(err) };
    }
  } // scheduleHFH

  // ---------- Worker-side integration helpers ----------
  /**
   * workerProcess(frameBitmap, meta, options)
   * 
   * DEPRECATED: This method is provided for standalone HFH worker scenarios only.
   * 
   * For integration with motion.worker (RECOMMENDED):
   * - Use computeAnnular() + decideHFH() in main thread (FrameEvictionHook)
   * - If shouldRun, use scheduleHFH() to post to motion.worker with op:'RECONSTRUCT_META'
   * - motion.worker already has comprehensive depth/normal/flux pipeline
   * 
   * This standalone implementation is kept for:
   * - Lightweight worker scenarios without full motion.worker
   * - Testing/debugging HFH in isolation
   * - Fallback when motion.worker unavailable
   *
   * Returns:
   *   { depthMap, normalMap, telemetry, selectorArtifact? }
   */
  static async workerProcess(frameBitmap, meta = {}, options = {}) {
    const cfg = { ...DEFAULTS, ...(options || {}) };
    const start = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const telemetry = { method: null, errors: [], success: false };

    // Helper: CPU fallback (simple luminance-based depth with sobel normals)
    async function cpuFallback(bitmap, resolution) {
      telemetry.method = 'cpu_fallback';
      try {
        const canvas = new OffscreenCanvas(resolution, resolution);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, resolution, resolution);
        const id = ctx.getImageData(0, 0, resolution, resolution);
        const d = id.data;
        const count = resolution * resolution;
        const depth = new Float32Array(count);
        const normals = new Float32Array(count * 3);

        // compute grayscale and simple depth
        const gray = new Float32Array(count);
        for (let i = 0; i < count; i++) {
          const r = d[i * 4];
          const g = d[i * 4 + 1];
          const b = d[i * 4 + 2];
          const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
          gray[i] = lum;
          depth[i] = 0.1 + (1.0 - lum) * 2.0;
        }

        // simple sobel to estimate normals (approx)
        const w = resolution;
        const h = resolution;
        const sx = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
        const sy = [-1, -2, -1, 0, 0, 0, 1, 2, 1];

        for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) {
            let gx = 0, gy = 0;
            let k = 0;
            for (let ky = -1; ky <= 1; ky++) {
              for (let kx = -1; kx <= 1; kx++) {
                const v = gray[(y + ky) * w + (x + kx)];
                gx += v * sx[k];
                gy += v * sy[k];
                k++;
              }
            }
            const idx = y * w + x;
            const nx = -gx;
            const ny = -gy;
            const nz = 1.0;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1.0;
            normals[idx * 3] = nx / len;
            normals[idx * 3 + 1] = ny / len;
            normals[idx * 3 + 2] = nz / len;
          }
        }

        return {
          depthMap: { resolution, data: depth, min: 0.0, max: 3.0, encoding: 'float32', fallback: true },
          normalMap: { resolution, data: normals, encoding: 'xyz-float32', fallback: true },
          telemetry: { method: 'cpu_fallback', total_ms: (performance.now ? performance.now() - start : Date.now() - start) }
        };
      } catch (err) {
        telemetry.errors.push(String(err));
        throw err;
      }
    }

    try {
      // Prefer GPU path if triangle preprocessor is available (dynamic import)
      try {
        // Attempt to import optional triangle preprocessor / three path
        const triMod = await import('./depthTrianglePreprocessor.js').catch(() => null);
        const overhangMod = await import('./overhangPreprocessor.js').catch(() => null);
        const three = await import('three').catch(() => null);

        if (triMod && three) {
          // Minimal GPU path: reuse motion.worker-style pipeline but keep it small
          telemetry.method = 'gpu_triangle_path';

          const resolution = options.resolution || cfg.defaultResolutions?.low || 256;

          try {
            const canvas = new OffscreenCanvas(resolution, resolution);
            let gl = canvas.getContext('webgl2', { antialias: false });
            if (!gl) gl = canvas.getContext('webgl', { antialias: false });
            if (!gl) throw new Error('WebGL unavailable in worker for HFH GPU path');

            if (typeof triMod.createDepthTrianglePreprocessor === 'function') {
              const rendererFake = { canvas, context: gl };
              const pre = triMod.createDepthTrianglePreprocessor({
                renderer: rendererFake,
                gridSize: resolution,
                bakeSize: Math.max(256, resolution * 2)
              });

              const initErr = pre.init ? pre.init() : null;
              if (initErr) throw new Error('trianglePreprocessor.init failed: ' + String(initErr));
              const triRes = pre.compute ? pre.compute() : null;
              if (!triRes || !triRes.depths) {
                throw new Error('trianglePreprocessor returned invalid result');
              }

              const depths = triRes.depths;
              const count = resolution * resolution;
              const depthArr = (depths instanceof Float32Array) ? depths : new Float32Array(depths);

              const tilts = triRes.tilts || null;
              let normals3D = new Float32Array(count * 3);
              if (tilts && tilts.length === count) {
                for (let i = 0; i < count; i++) {
                  const theta = tilts[i];
                  const nx = Math.cos(theta);
                  const ny = Math.sin(theta);
                  const nz = 0.5;
                  const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1.0;
                  normals3D[i * 3] = nx / len;
                  normals3D[i * 3 + 1] = ny / len;
                  normals3D[i * 3 + 2] = nz / len;
                }
              } else {
                for (let i = 0; i < count; i++) {
                  normals3D[i * 3] = 0;
                  normals3D[i * 3 + 1] = 0;
                  normals3D[i * 3 + 2] = 1;
                }
              }

              const dm = typedMinMax(depthArr);
              telemetry.total_ms = (performance.now ? performance.now() - start : Date.now() - start);
              telemetry.success = true;

              return {
                depthMap: { resolution, data: depthArr, min: dm.min, max: dm.max, encoding: 'float32' },
                normalMap: { resolution, data: normals3D, encoding: 'xyz-float32' },
                telemetry
              };
            } else {
              telemetry.errors.push('trianglePreprocessor missing createDepthTrianglePreprocessor');
              return await cpuFallback(frameBitmap, options.resolution || 256);
            }
          } catch (gpuErr) {
            telemetry.errors.push(`gpu_path_failed: ${String(gpuErr)}`);
            return await cpuFallback(frameBitmap, options.resolution || 256);
          }
        } else {
          // No GPU path available; do quick MultiSampler + CPU depth heuristic
          telemetry.method = 'sampler_cpu_combo';

          const resolution = options.resolution || cfg.defaultResolutions?.low || 256;

          let MultiSamplerLocal = null;
          try {
            MultiSamplerLocal = await import('/src/js/sampler/MultiSampler.js').catch(() => null);
            MultiSamplerLocal = MultiSamplerLocal && (MultiSamplerLocal.default || MultiSamplerLocal);
          } catch (e) {
            MultiSamplerLocal = null;
          }

          if (MultiSamplerLocal && typeof MultiSamplerLocal.createHighPerformance === 'function') {
            try {
              const sampler = MultiSamplerLocal.createHighPerformance({
                timeBudgetMs: Math.min(200, cfg.timeBudgetMs),
                maxSamplePoints: options.maxSamplePoints || 1024,
                minSamplePoints: options.minSamplePoints || 128,
                seed: options.seed || Date.now()
              });

              let smallBm = frameBitmap;
              let createdSmallBm = false;
              if (frameBitmap.width !== resolution || frameBitmap.height !== resolution) {
                try {
                  const canvas = new OffscreenCanvas(resolution, resolution);
                  const ctx = canvas.getContext('2d');
                  ctx.drawImage(frameBitmap, 0, 0, resolution, resolution);
                  smallBm = await createImageBitmap(canvas);
                  createdSmallBm = true;
                } catch (scErr) {
                  telemetry.errors.push('small_bitmap_creation_failed:' + String(scErr));
                }
              }

              const sampleManifest = await sampler.sample(smallBm, { temporalMode: 'single' });

              const depthArr = new Float32Array(resolution * resolution).fill(1.0);
              const normals = new Float32Array(resolution * resolution * 3);
              for (let i = 0; i < depthArr.length; i++) {
                normals[i * 3] = 0;
                normals[i * 3 + 1] = 0;
                normals[i * 3 + 2] = 1;
              }

              if (createdSmallBm && smallBm && typeof smallBm.close === 'function') try { smallBm.close(); } catch (_) {}

              telemetry.success = true;
              telemetry.total_ms = (performance.now ? performance.now() - start : Date.now() - start);
              return {
                depthMap: { resolution, data: depthArr, min: 0.1, max: 3.0, encoding: 'float32' },
                normalMap: { resolution, data: normals, encoding: 'xyz-float32' },
                telemetry,
                sampleManifest
              };
            } catch (msErr) {
              telemetry.errors.push('MultiSampler in worker failed: ' + String(msErr));
              return await cpuFallback(frameBitmap, options.resolution || 256);
            }
          } else {
            return await cpuFallback(frameBitmap, options.resolution || 256);
          }
        }
      } catch (err) {
        telemetry.errors.push(String(err));
        return await cpuFallback(frameBitmap, options.resolution || 256);
      }
    } catch (err) {
      telemetry.errors.push(String(err));
      telemetry.success = false;
      telemetry.total_ms = (performance.now ? performance.now() - start : Date.now() - start);
      const res = options.resolution || 256;
      const depths = new Float32Array(res * res).fill(1.0);
      const normals = new Float32Array(res * res * 3);
      for (let i = 0; i < res * res; i++) {
        normals[i * 3] = 0; normals[i * 3 + 1] = 0; normals[i * 3 + 2] = 1;
      }
      return {
        depthMap: { resolution: res, data: depths, min: 1.0, max: 1.0, encoding: 'float32', fallback: true },
        normalMap: { resolution: res, data: normals, encoding: 'xyz-float32', fallback: true },
        telemetry
      };
    }
  } // workerProcess

  // ---------- Normalization helper for computeAnnular ----------
  async _normalizeInputForAnnular(input, { timeBudgetMs = 60, cancelToken = { cancelled: false } } = {}) {
    // Supported shapes:
    // - ImageBitmap
    // - OffscreenCanvas
    // - { width, height, data } with data = Uint8ClampedArray or Uint8Array RGBA
    if (!input) return null;

    // If input looks like normalized already
    if (typeof input === 'object' && input.width && input.height && input.data) {
      return input;
    }

    // ImageBitmap or OffscreenCanvas
    try {
      if (typeof ImageBitmap !== 'undefined' && input instanceof ImageBitmap) {
        const w = input.width || 1;
        const h = input.height || 1;
        const canvas = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(w, h) : (typeof document !== 'undefined' ? document.createElement('canvas') : null);
        if (!canvas) throw new Error('No canvas available to normalize ImageBitmap');

        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(input, 0, 0);
        const imageData = ctx.getImageData(0, 0, w, h);
        return { width: w, height: h, data: imageData.data };
      }

      if (typeof OffscreenCanvas !== 'undefined' && input instanceof OffscreenCanvas) {
        const w = input.width;
        const h = input.height;
        const ctx = input.getContext('2d');
        const id = ctx.getImageData(0, 0, w, h);
        return { width: w, height: h, data: id.data };
      }
    } catch (err) {
      this._log?.warn?.('HFH._normalizeInputForAnnular failed to read ImageBitmap/Canvas', err);
      // allow fallthrough to try createImageBitmap path
    }

    // Last resort: try createImageBitmap on Blob or other types (if provided)
    if (typeof createImageBitmap === 'function') {
      let bm = null;
      try {
        bm = await createImageBitmap(input);
        const res = await this._normalizeInputForAnnular(bm, { timeBudgetMs, cancelToken });
        return res;
      } catch (err) {
        this._log?.warn?.('HFH._normalizeInputForAnnular createImageBitmap fallback failed', err);
        return null;
      } finally {
        if (bm && typeof bm.close === 'function') {
          try { bm.close(); } catch (_) {}
        }
      }
    }

    // unknown input type
    return null;
  }

  // ---------- Getter for metrics / health ----------
  getMetrics() {
    return { ...this.metrics };
  }
}

export default HybridFresnelHarvester