// /src/js/modules/DirectionalLifting.js
// Temporal aggregation module using rolling buffer for spatial-temporal consistency
// Implements directional lifting for enhanced field coherence
//
// Updated: robust buffer ordering, GPU coherence path (dynamic import + cleanup),
// coherence subsample support, defensive timestamp handling, telemetry fixes,
// corrected getBufferState/getStats, and minimal API additions (setTHREE / setRenderer)
//
// Notes:
// - GPU path requires passing THREE and a WebGL renderer instance via constructor
//   options or via setTHREE / setRenderer before calling process({ useGPU: true }).
// - Default coherenceSubsample = 1 (no subsampling). Use >1 (e.g. 2 or 4) during dev
//   to avoid heavy CPU work. GPU path will perform subsampled coherence on GPU.
// - Default bufferSize = 8
//
// API unchanged except for optional: setTHREE(THREE), setRenderer(renderer)
// and options.coherenceSubsample support.

export class DirectionalLifting {
  /**
   * @param {Object} options - Configuration options
   * @param {number} [options.bufferSize=8] - Rolling buffer size (N samples)
   * @param {string} [options.weightingMode='exponential'] - Weighting mode ('exponential', 'triangular', 'uniform')
   * @param {number} [options.decayFactor=0.8] - Exponential decay factor for temporal weighting
   * @param {number} [options.epsilonThreshold=0.01] - Epsilon threshold for thickening
   * @param {boolean} [options.enableDerivatives=true] - Enable temporal derivative computation
   * @param {boolean} [options.debug=false] - Enable debug logging
   * @param {number} [options.coherenceSubsample=1] - Coherence subsample factor (>=1)
   * @param {Object} [options.THREE=null] - THREE.js module (required for GPU path)
   * @param {THREE.WebGLRenderer} [options.renderer=null] - THREE WebGL renderer (required for GPU path)
   */
  constructor(options = {}) {
    this.bufferSize = Number.isInteger(options.bufferSize) && options.bufferSize > 0 ? options.bufferSize : 8;
    this.weightingMode = options.weightingMode || 'exponential';
    this.decayFactor = typeof options.decayFactor === 'number' ? options.decayFactor : 0.8;
    this.epsilonThreshold = typeof options.epsilonThreshold === 'number' ? options.epsilonThreshold : 0.01;
    this.enableDerivatives = options.enableDerivatives !== false;
    this.debug = !!options.debug;

    // coherenceSubsample: clamp to integer >= 1
    const rawSub = options.coherenceSubsample || 1;
    this.coherenceSubsample = Math.max(1, Math.floor(rawSub));
    if (rawSub !== this.coherenceSubsample && this.debug) {
      console.warn(`DirectionalLifting: coherenceSubsample invalid (${rawSub}), clamped to ${this.coherenceSubsample}`);
    }

    // Optional THREE/renderer for GPU path
    this._THREE = options.THREE || null;
    this._renderer = options.renderer || null;

    // Rolling buffer storage (circular)
    this._buffer = []; // stores entries in insertion order until full; ordering accessor will handle wrap
    this._bufferIndex = 0; // next write position when full
    this._bufferFull = false;

    // Stats
    this.stats = {
      framesProcessed: 0,
      bufferUtilization: 0,
      avgProcessingMs: 0,
      totalProcessingMs: 0,
      lastError: null
    };
  }

  /**
   * Set THREE module for GPU path at runtime (optional)
   */
  setTHREE(THREE) {
    this._THREE = THREE;
  }

  /**
   * Set renderer for GPU path at runtime (optional)
   */
  setRenderer(renderer) {
    this._renderer = renderer;
  }

  /**
   * Process field with temporal aggregation
   * 
   * @param {Float32Array} field - Input field (tetrachromatic or calibrated) length res*res*4
   * @param {number} resolution - Field resolution (square)
   * @param {number} timestamp - Frame acquisition timestamp (ms)
   * @param {Object} options - Per-call options
   *    options.metadata - optional metadata
   *    options.coherenceSubsample - override subsample factor
   *    options.useGPU - boolean: attempt GPU coherence path (requires THREE + renderer)
   * @returns {Promise<Object>} { directionalField, derivatives?, coherence?, telemetry }
   */
  async process(field, resolution, timestamp, options = {}) {
    const startTime = performance.now();
    const telemetry = { stages: {}, warnings: [], success: false };

    try {
      const count = resolution * resolution;

      // Input validation
      if (!field || field.length !== count * 4) {
        throw new Error(`Invalid field: expected ${count * 4} elements, got ${field?.length || 0}`);
      }

      // STAGE 1: Add to rolling buffer
      telemetry.stages.buffer_start = performance.now();
      this._addToBuffer({
        field,
        timestamp,
        resolution,
        metadata: options.metadata || {}
      });
      telemetry.stages.buffer_end = performance.now();
      telemetry.stages.buffer_ms = telemetry.stages.buffer_end - telemetry.stages.buffer_start;

      telemetry.bufferCount = this._buffer.length;
      telemetry.bufferCapacity = this.bufferSize;
      telemetry.bufferUtilization = telemetry.bufferCount / telemetry.bufferCapacity;

      // STAGE 2: Compute temporal derivatives (optional)
      let derivatives = null;
      if (this.enableDerivatives && this._buffer.length >= 2) {
        telemetry.stages.derivatives_start = performance.now();
        derivatives = this._computeTemporalDerivatives(count);
        telemetry.stages.derivatives_end = performance.now();
        telemetry.stages.derivatives_ms = telemetry.stages.derivatives_end - telemetry.stages.derivatives_start;
      }

      // STAGE 3: Compute directional coherence (CPU or GPU)
      telemetry.stages.coherence_start = performance.now();
      const subsample = Math.max(1, Math.floor(options.coherenceSubsample || this.coherenceSubsample || 1));
      const useGPU = !!options.useGPU;
      let coherence = null;

      try {
        coherence = await this._computeDirectionalCoherence(count, resolution, { subsample, useGPU });
      } catch (cohErr) {
        // Surface GPU/import errors or heavy failures; fallback to CPU path but log warning
        telemetry.warnings.push(`coherence_error: ${cohErr && cohErr.message ? cohErr.message : String(cohErr)}; falling back to CPU`);
        if (this.debug) console.warn('DirectionalLifting: coherence GPU error, falling back to CPU', cohErr);
        coherence = this._computeDirectionalCoherenceCPU(count, resolution, subsample);
      }

      telemetry.stages.coherence_end = performance.now();
      telemetry.stages.coherence_ms = telemetry.stages.coherence_end - telemetry.stages.coherence_start;

      // STAGE 4: Weighted temporal averaging
      telemetry.stages.averaging_start = performance.now();
      const directionalField = this._computeWeightedAverage(count, timestamp);
      telemetry.stages.averaging_end = performance.now();
      telemetry.stages.averaging_ms = telemetry.stages.averaging_end - telemetry.stages.averaging_start;

      // STAGE 5: Epsilon-thickening (if needed)
      telemetry.stages.thickening_start = performance.now();
      const thickenedField = this._applyEpsilonThickening(directionalField, coherence, count);
      telemetry.stages.thickening_end = performance.now();
      telemetry.stages.thickening_ms = telemetry.stages.thickening_end - telemetry.stages.thickening_start;

      // Prepare output
      const result = {
        directionalField: thickenedField,
        resolution,
        channels: 4,
        encoding: 'float32',
        derivatives,
        coherence,
        bufferUtilization: this._buffer.length / this.bufferSize,
        telemetry
      };

      const processingMs = performance.now() - startTime;
      this.stats.framesProcessed++;
      this.stats.totalProcessingMs += processingMs;
      this.stats.avgProcessingMs = this.stats.totalProcessingMs / this.stats.framesProcessed;
      this.stats.bufferUtilization = this._buffer.length / this.bufferSize;

      telemetry.success = true;
      telemetry.total_ms = processingMs;

      if (this.debug) {
        console.log('DirectionalLifting: Processing complete', {
          processingMs: processingMs.toFixed(2),
          resolution,
          bufferCount: this._buffer.length,
          coherenceMean: (coherence && typeof coherence.mean === 'number') ? coherence.mean.toFixed(3) : null
        });
      }

      return result;
    } catch (err) {
      this.stats.lastError = err && err.message ? err.message : String(err);
      const telemetryErr = { success: false, error: err && err.message ? err.message : String(err), stack: err && err.stack ? err.stack : null };
      if (this.debug) console.error('DirectionalLifting: Processing failed', err);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Return array of buffer entries in chronological order (oldest -> newest)
   */
  _orderedBuffer() {
    const size = this._buffer.length;
    if (!this._bufferFull) {
      // Not wrapped yet — already ordered oldest -> newest
      return this._buffer.slice();
    }
    // Wrapped: _bufferIndex points to the next write position; oldest entry is at _bufferIndex
    const out = new Array(this.bufferSize);
    for (let i = 0; i < this.bufferSize; i++) {
      out[i] = this._buffer[(this._bufferIndex + i) % this.bufferSize];
    }
    return out;
  }

  /**
   * Add field to rolling buffer (circular)
   * @private
   */
  _addToBuffer(entry) {
    if (this._buffer.length < this.bufferSize) {
      this._buffer.push(entry);
    } else {
      this._buffer[this._bufferIndex] = entry;
      this._bufferIndex = (this._bufferIndex + 1) % this.bufferSize;
      this._bufferFull = true;
    }
  }

  /**
   * Compute temporal derivatives between two most recent frames
   * Preserves sign of dt and defensively handles invalid timestamps.
   * @private
   */
  _computeTemporalDerivatives(count) {
    const ordered = this._orderedBuffer();
    if (ordered.length < 2) return null;

    const newerFrame = ordered[ordered.length - 1];
    const olderFrame = ordered[ordered.length - 2];

    let dt = newerFrame.timestamp - olderFrame.timestamp; // preserve sign
    if (!Number.isFinite(dt) || dt <= 0) {
      console.warn(`DirectionalLifting: Invalid timestamp order or dt=${dt}ms; using dt=1ms`);
      dt = 1;
    }

    const derivative = new Float32Array(count * 4);
    const f1 = newerFrame.field;
    const f0 = olderFrame.field;
    for (let i = 0; i < count * 4; i++) {
      derivative[i] = (f1[i] - f0[i]) / dt;
    }

    let sumAbs = 0;
    for (let i = 0; i < count * 4; i++) sumAbs += Math.abs(derivative[i]);

    return { field: derivative, meanAbsDerivative: sumAbs / (count * 4), dt };
  }

  /**
   * Compute directional coherence (driver: try GPU if requested + available; otherwise CPU)
   * @private
   */
  async _computeDirectionalCoherence(count, resolution, opts = {}) {
    const subsample = Math.max(1, Math.floor(opts.subsample || 1));
    const useGPU = !!opts.useGPU;

    // If GPU requested and we have THREE & renderer, attempt GPU implementation
    if (useGPU && this._THREE && this._renderer) {
      // Delegate to GPU implementation (may throw)
      return await this._computeDirectionalCoherenceGPU(resolution, subsample);
    }

    // Otherwise CPU fallback
    return this._computeDirectionalCoherenceCPU(count, resolution, subsample);
  }

  /**
   * CPU coherence implementation (per-pixel variance across buffer samples)
   * Returns { perPixel: Float32Array[count], mean, min, max }
   * @private
   */
  _computeDirectionalCoherenceCPU(count, resolution, subsample = 1) {
    // If subsample > 1, compute coherence on coarse grid and upscale nearest
    const ordered = this._orderedBuffer();
    const numSamples = ordered.length;
    if (numSamples < 2) {
      return {
        perPixel: new Float32Array(count).fill(1.0),
        mean: 1.0,
        min: 1.0,
        max: 1.0,
        gpuUsed: false
      };
    }

    // If subsample > 1, compute on small grid sx x sx
    const s = Math.max(1, Math.floor(resolution / subsample));
    const calcCount = s * s;
    const meanR = new Float32Array(calcCount);
    const meanG = new Float32Array(calcCount);
    const meanB = new Float32Array(calcCount);
    const meanA = new Float32Array(calcCount);

    // Compute means (accumulate)
    for (const entry of ordered) {
      const field = entry.field;
      // sample nearest neighbor for subsampled grid
      for (let y = 0; y < s; y++) {
        const srcY = Math.min(resolution - 1, Math.round((y + 0.5) * subsample - 0.5));
        for (let x = 0; x < s; x++) {
          const srcX = Math.min(resolution - 1, Math.round((x + 0.5) * subsample - 0.5));
          const srcIdx = (srcY * resolution + srcX) * 4;
          const dst = y * s + x;
          meanR[dst] += field[srcIdx + 0];
          meanG[dst] += field[srcIdx + 1];
          meanB[dst] += field[srcIdx + 2];
          meanA[dst] += field[srcIdx + 3];
        }
      }
    }
    // finalize means
    const invN = 1.0 / numSamples;
    for (let i = 0; i < calcCount; i++) {
      meanR[i] *= invN;
      meanG[i] *= invN;
      meanB[i] *= invN;
      meanA[i] *= invN;
    }

    // compute variance (sum((x-mean)^2)/N across samples and channels)
    const varArr = new Float32Array(calcCount);
    for (const entry of ordered) {
      const field = entry.field;
      for (let y = 0; y < s; y++) {
        const srcY = Math.min(resolution - 1, Math.round((y + 0.5) * subsample - 0.5));
        for (let x = 0; x < s; x++) {
          const srcX = Math.min(resolution - 1, Math.round((x + 0.5) * subsample - 0.5));
          const srcIdx = (srcY * resolution + srcX) * 4;
          const dst = y * s + x;
          const dR = field[srcIdx + 0] - meanR[dst];
          const dG = field[srcIdx + 1] - meanG[dst];
          const dB = field[srcIdx + 2] - meanB[dst];
          const dA = field[srcIdx + 3] - meanA[dst];
          varArr[dst] += (dR * dR + dG * dG + dB * dB + dA * dA);
        }
      }
    }
    for (let i = 0; i < calcCount; i++) varArr[i] /= (numSamples * 4);

    // Convert variance -> coherence = 1 / (1 + variance)
    const smallCoherence = new Float32Array(calcCount);
    let sum = 0, mn = Infinity, mx = -Infinity;
    for (let i = 0; i < calcCount; i++) {
      const c = 1.0 / (1.0 + varArr[i]);
      smallCoherence[i] = c;
      sum += c;
      if (c < mn) mn = c;
      if (c > mx) mx = c;
    }
    const mean = sum / calcCount;

    // Upscale nearest to full resolution
    const full = new Float32Array(resolution * resolution);
    if (s === resolution) {
      // same resolution
      for (let i = 0; i < full.length; i++) full[i] = smallCoherence[i];
    } else {
      for (let y = 0; y < resolution; y++) {
        const sy = Math.min(s - 1, Math.floor(y / subsample));
        for (let x = 0; x < resolution; x++) {
          const sx = Math.min(s - 1, Math.floor(x / subsample));
          full[y * resolution + x] = smallCoherence[sy * s + sx];
        }
      }
    }

    return { perPixel: full, mean, min: mn, max: mx, gpuUsed: false };
  }

  /**
   * GPU-based coherence computation (subsampled). Dynamic import of GPUComputationRenderer is used.
   * Requires this._THREE and this._renderer to be set.
   *
   * Strategy:
   *  - Subsample to s x s grid (nearest)
   *  - Create one THREE.DataTexture per buffer sample (Float32Array, s*s*4)
   *  - Build a small shader that samples each texture and computes mean & variance across samples
   *  - Render to render target and read back Float32Array (s*s*4) containing coherence in .r channel
   *  - Upscale nearest to full resolution
   *
   * Cleans up GPU resources in a finally block.
   *
   * @private
   */
  async _computeDirectionalCoherenceGPU(resolution, subsample = 1) {
    // Validate prerequisites
    if (!this._THREE) throw new Error('GPU coherence requires THREE module (setTHREE)');
    if (!this._renderer) throw new Error('GPU coherence requires a WebGL renderer (setRenderer)');
    const THREE = this._THREE;
    const renderer = this._renderer;

    const ordered = this._orderedBuffer();
    const numSamples = ordered.length;
    if (numSamples < 2) {
      return {
        perPixel: new Float32Array(resolution * resolution).fill(1.0),
        mean: 1.0,
        min: 1.0,
        max: 1.0,
        gpuUsed: true
      };
    }

    // Small subsampled grid
    const s = Math.max(1, Math.floor(resolution / Math.max(1, subsample)));
    const smallCount = s * s;

    // dynamic import of GPUComputationRenderer
    let GPUComputationRenderer;
    try {
      const mod = await import('./gpuComputationRenderer.js');
      GPUComputationRenderer = mod.GPUComputationRenderer || mod.default || mod;
      if (!GPUComputationRenderer) throw new Error('GPUComputationRenderer not found in module');
    } catch (impErr) {
      throw new Error(`GPU coherence: failed to import GPUComputationRenderer: ${impErr && impErr.message ? impErr.message : String(impErr)}`);
    }

    // Prepare small Float32Array textures (nearest sampling)
    const smallTextures = []; // THREE.DataTexture
    const smallArrays = []; // Float32Array backing
    try {
      for (let si = 0; si < numSamples; si++) {
        const srcField = ordered[si].field;
        const smallArr = new Float32Array(smallCount * 4);
        // fill nearest
        for (let y = 0; y < s; y++) {
          const srcY = Math.min(resolution - 1, Math.round((y + 0.5) * subsample - 0.5));
          for (let x = 0; x < s; x++) {
            const srcX = Math.min(resolution - 1, Math.round((x + 0.5) * subsample - 0.5));
            const srcIdx = (srcY * resolution + srcX) * 4;
            const dstIdx = (y * s + x) * 4;
            smallArr[dstIdx + 0] = srcField[srcIdx + 0];
            smallArr[dstIdx + 1] = srcField[srcIdx + 1];
            smallArr[dstIdx + 2] = srcField[srcIdx + 2];
            smallArr[dstIdx + 3] = srcField[srcIdx + 3];
          }
        }
        smallArrays.push(smallArr);
      }
    } catch (e) {
      throw new Error('GPU coherence: failed to prepare subsampled arrays: ' + String(e));
    }

    const dataTextures = [];
    let gpu = null;
    let result = null;

    try {
      // Create DataTexture for each sample
      for (let i = 0; i < smallArrays.length; i++) {
        const tex = new THREE.DataTexture(
          smallArrays[i],
          s,
          s,
          THREE.RGBAFormat,
          THREE.FloatType
        );
        tex.needsUpdate = true;
        tex.minFilter = THREE.NearestFilter;
        tex.magFilter = THREE.NearestFilter;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        dataTextures.push(tex);
      }

      // Create GPU computation renderer (uses renderer + THREE)
      gpu = new GPUComputationRenderer(s, s, renderer, THREE);
      // Build fragment shader that samples all textures and computes coherence
      // We'll generate shader code that unrolls sampling for known numSamples
      const samplerDecls = [];
      const sampleAccum = [];
      for (let i = 0; i < numSamples; i++) {
        samplerDecls.push(`uniform sampler2D s${i};`);
        sampleAccum.push(`
          vec4 v${i} = texture2D(s${i}, vUv);
          sum += v${i};
          sumSq += v${i} * v${i};
        `);
      }

      const frag = `
        precision highp float;
        varying vec2 vUv;
        ${samplerDecls.join('\n')}
        void main() {
          vec4 sum = vec4(0.0);
          vec4 sumSq = vec4(0.0);
          ${sampleAccum.join('\n')}
          float N = ${numSamples}.0;
          vec4 mean = sum / N;
          vec4 varv = sumSq / N - mean * mean;
          float variance = varv.r + varv.g + varv.b + varv.a;
          float coherence = 1.0 / (1.0 + variance);
          gl_FragColor = vec4(coherence, coherence, coherence, 1.0);
        }
      `;

      // Use one of the sample textures as initial texture
      const initTex = dataTextures[0];
      const varCoherence = gpu.addVariable('coh', frag, initTex);

      // Set uniforms for each sampler
      for (let i = 0; i < numSamples; i++) {
        varCoherence.material.uniforms[`s${i}`] = { value: dataTextures[i] };
      }

      gpu.setVariableDependencies(varCoherence, [varCoherence]);

      // Init GPUComputationRenderer
      const initErr = gpu.init();
      if (initErr) {
        throw new Error('GPUComputationRenderer.init failed: ' + String(initErr));
      }

      // Compute
      gpu.compute();

      // Read back render target pixels
      const rt = gpu.getCurrentRenderTarget(varCoherence);
      const readBuf = new Float32Array(s * s * 4);
      try {
        renderer.readRenderTargetPixels(rt, 0, 0, s, s, readBuf);
      } catch (readErr) {
        throw new Error('GPU readback failed: ' + String(readErr));
      }

      // Extract coherence (r channel) from readBuf
      const smallCoherence = new Float32Array(s * s);
      let sum = 0, mn = Infinity, mx = -Infinity;
      for (let i = 0; i < s * s; i++) {
        const c = Number(readBuf[i * 4 + 0]) || 0.0;
        smallCoherence[i] = c;
        sum += c;
        if (c < mn) mn = c;
        if (c > mx) mx = c;
      }
      const mean = sum / (s * s);

      // Upscale nearest to full resolution
      const full = new Float32Array(resolution * resolution);
      if (s === resolution) {
        for (let i = 0; i < full.length; i++) full[i] = smallCoherence[i];
      } else {
        for (let y = 0; y < resolution; y++) {
          const sy = Math.min(s - 1, Math.floor(y / subsample));
          for (let x = 0; x < resolution; x++) {
            const sx = Math.min(s - 1, Math.floor(x / subsample));
            full[y * resolution + x] = smallCoherence[sy * s + sx];
          }
        }
      }

      result = { perPixel: full, mean, min: mn, max: mx, gpuUsed: true };
    } finally {
      // Always attempt cleanup
      if (gpu) {
        try { gpu.dispose(); } catch (er) { console.warn('DirectionalLifting: gpu.dispose failed', er); }
      }
      for (const dt of dataTextures) {
        try { if (dt && typeof dt.dispose === 'function') dt.dispose(); } catch (er) { console.warn('DirectionalLifting: texture.dispose failed', er); }
      }
    }

    if (!result) throw new Error('GPU coherence: unexpected null result');
    return result;
  }

  /**
   * Compute weighted temporal average across buffer samples (ordered oldest->newest)
   * @private
   */
  _computeWeightedAverage(count, currentTimestamp) {
    const ordered = this._orderedBuffer();
    const numSamples = ordered.length;

    if (numSamples === 0) throw new Error('Buffer empty - cannot compute weighted average');
    if (numSamples === 1) {
      return new Float32Array(ordered[0].field);
    }

    // Compute weights (oldest -> newest)
    const weights = this._computeWeights(numSamples);

    const averaged = new Float32Array(count * 4);

    for (let s = 0; s < numSamples; s++) {
      const w = weights[s];
      const field = ordered[s].field;
      for (let i = 0; i < count * 4; i++) {
        averaged[i] += w * field[i];
      }
    }
    return averaged;
  }

  /**
   * Compute temporal weights for a given number of samples (oldest -> newest)
   * @private
   */
  _computeWeights(numSamples) {
    const weights = new Float32Array(numSamples);

    if (this.weightingMode === 'exponential') {
      let sumWeights = 0;
      for (let i = 0; i < numSamples; i++) {
        // older frames have smaller exponent; weight oldest as decay^(num-1-i)
        weights[i] = Math.pow(this.decayFactor, numSamples - 1 - i);
        sumWeights += weights[i];
      }
      // normalize
      if (!isFinite(sumWeights) || sumWeights <= 0) sumWeights = 1.0;
      for (let i = 0; i < numSamples; i++) weights[i] /= sumWeights;
    } else if (this.weightingMode === 'triangular') {
      let sumWeights = 0;
      for (let i = 0; i < numSamples; i++) {
        weights[i] = i + 1;
        sumWeights += weights[i];
      }
      for (let i = 0; i < numSamples; i++) weights[i] /= sumWeights;
    } else {
      const w = 1.0 / numSamples;
      for (let i = 0; i < numSamples; i++) weights[i] = w;
    }

    return weights;
  }

  /**
   * Apply epsilon-thickening to enhance thin visibility sets
   * @private
   */
  _applyEpsilonThickening(field, coherence, count) {
    const thickened = new Float32Array(count * 4);
    const perPixel = (coherence && coherence.perPixel) ? coherence.perPixel : new Float32Array(count).fill(1.0);

    for (let px = 0; px < count; px++) {
      const coh = perPixel[px];
      const epsilon = (coh < 0.5) ? this.epsilonThreshold : 0;
      for (let ch = 0; ch < 4; ch++) {
        const idx = px * 4 + ch;
        thickened[idx] = Math.min(1.0, field[idx] + epsilon);
      }
    }
    return thickened;
  }

  // ---------------------------------------------------------------------------
  // Diagnostics / utility public methods
  // ---------------------------------------------------------------------------

  /**
   * Return current buffer snapshot
   */
  getBufferState() {
    const size = this._buffer.length;
    return {
      size,
      capacity: this.bufferSize,
      full: this._bufferFull,
      utilization: size / Math.max(1, this.bufferSize),
      oldestTimestamp: size > 0 ? this._buffer[0].timestamp : null,
      newestTimestamp: size > 0 ? this._buffer[size - 1].timestamp : null
    };
  }

  /**
   * Get module statistics (includes buffer state)
   */
  getStats() {
    const bufferState = this.getBufferState();
    return { ...this.stats, bufferState };
  }

  /**
   * Get current buffer state with more detail (alias)
   */
  getBufferStateDetailed() {
    return this.getBufferState();
  }

  /**
   * Clear rolling buffer
   */
  clearBuffer() {
    this._buffer = [];
    this._bufferIndex = 0;
    this._bufferFull = false;
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      framesProcessed: 0,
      bufferUtilization: 0,
      avgProcessingMs: 0,
      totalProcessingMs: 0,
      lastError: null
    };
  }

  /**
   * Cleanup resources
   */
  dispose() {
    // clear buffer
    this.clearBuffer();
    // null out references to allow GC
    this._THREE = null;
    this._renderer = null;
  }
}

/**
 * Factory function for convenience
 */
export function createDirectionalLifting(options = {}) {
  return new DirectionalLifting(options);
}

export default DirectionalLifting;