// /src/js/modules/Tetrachromacy.js
// Spectral decomposition module for 4-channel (RGBA + derived) analysis
// Implements tetrachromacy-like sensor expansion for metamer reduction
//
// NOTE:
// - Intensity (luminance) is exported explicitly as `intensity` for downstream
//   geometry/edge/bump processing. Chromaticity and opponent channels are for
//   material/specular discrimination and should NOT be used alone for geometry.
//
// Based on: Canonical Methods to Reduce Metamers (tetrachromacy_ringbuffer.pdf)

/**
 * Tetrachromacy Module
 *
 * Purpose: Expand 4-channel RGBA data into enriched spectral representation
 * for improved material/shape discrimination (metamer reduction).
 *
 * Key Features:
 * - Opponent color space transformation (RG, BY, Intensity)
 * - Chromaticity normalization (alpha-normalized chroma)
 * - Temporal statistics aggregation (optional)
 * - GPU-compatible output formats
 *
 * @module Tetrachromacy
 */

export class Tetrachromacy {
  /**
   * @param {Object} options - Configuration options
   * @param {boolean} [options.enableOpponentChannels=true] - Enable RG/BY opponent processing
   * @param {boolean} [options.enableChromaticity=true] - Enable chromaticity extraction
   * @param {boolean} [options.enableTemporalStats=false] - Enable temporal statistics
   * @param {number} [options.temporalAlpha=0.1] - EMA alpha for temporal stats
   * @param {boolean} [options.debug=false] - Enable debug logging
   */
  constructor(options = {}) {
    this.enableOpponentChannels = options.enableOpponentChannels !== false;
    this.enableChromaticity = options.enableChromaticity !== false;
    this.enableTemporalStats = options.enableTemporalStats || false;
    this.temporalAlpha = options.temporalAlpha || 0.1;
    this.debug = !!options.debug;

    // Temporal statistics buffers (if enabled)
    this._temporalMean = null;
    this._temporalVar = null;
    this._temporalMin = null;
    this._temporalMax = null;
    this._temporalCount = 0;

    // Statistics tracking
    this.stats = {
      framesProcessed: 0,
      avgProcessingMs: 0,
      totalProcessingMs: 0,
      lastError: null
    };
  }

  /**
   * Process calibrated field to produce tetrachromatic representation
   *
   * @param {Float32Array} calibratedField - Input RGBA field [r,g,b,a, ...]
   * @param {number} resolution - Field resolution (assumes square)
   * @param {Object} options - Per-call options
   * @returns {Promise<Object>} { tetraField, opponentChannels?, chromaticity?, intensity?, temporalStats?, telemetry }
   */
  async process(calibratedField, resolution, options = {}) {
    const startTime = performance.now();
    const telemetry = {
      stages: {},
      warnings: [],
      success: false
    };

    try {
      const count = resolution * resolution;

      // Validate input
      if (!calibratedField || calibratedField.length !== count * 4) {
        throw new Error(`Invalid calibratedField: expected ${count * 4} elements, got ${calibratedField?.length || 0}`);
      }

      // ========================================
      // STAGE 1: Extract base channels
      // ========================================
      telemetry.stages.extract_start = performance.now();

      const { R, G, B, A } = this._extractChannels(calibratedField, count);

      telemetry.stages.extract_end = performance.now();
      telemetry.stages.extract_ms = telemetry.stages.extract_end - telemetry.stages.extract_start;

      // ========================================
      // STAGE 2: Compute opponent channels (RG, BY, intensity)
      // ========================================
      let opponentChannels = null;
      let intensity = null;

      if (this.enableOpponentChannels) {
        telemetry.stages.opponent_start = performance.now();

        opponentChannels = this._computeOpponentChannels(R, G, B, count);
        // opponentChannels contains RG, BY, intensity

        telemetry.stages.opponent_end = performance.now();
        telemetry.stages.opponent_ms = telemetry.stages.opponent_end - telemetry.stages.opponent_start;

        // make intensity available top-level (convenience)
        intensity = opponentChannels.intensity;
      }

      // ========================================
      // STAGE 3: Compute chromaticity (alpha-normalized)
      // ========================================
      let chromaticity = null;

      if (this.enableChromaticity) {
        telemetry.stages.chroma_start = performance.now();

        chromaticity = this._computeChromaticity(R, G, B, A, count);

        telemetry.stages.chroma_end = performance.now();
        telemetry.stages.chroma_ms = telemetry.stages.chroma_end - telemetry.stages.chroma_start;
      }

      // ========================================
      // STAGE 4: Build 4-channel tetraField
      // ========================================
      telemetry.stages.build_start = performance.now();

      // Pack as [R, G, B, A] (base representation)
      // Additional channels are returned separately for downstream use
      const tetraField = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) {
        tetraField[i * 4 + 0] = R[i];
        tetraField[i * 4 + 1] = G[i];
        tetraField[i * 4 + 2] = B[i];
        tetraField[i * 4 + 3] = A[i];
      }

      telemetry.stages.build_end = performance.now();
      telemetry.stages.build_ms = telemetry.stages.build_end - telemetry.stages.build_start;

      // ========================================
      // STAGE 5: Update temporal statistics (optional)
      // ========================================
      let temporalStats = null;

      if (this.enableTemporalStats) {
        telemetry.stages.temporal_start = performance.now();

        temporalStats = this._updateTemporalStats(
          R, G, B, A,
          count,
          this.temporalAlpha
        );

        telemetry.stages.temporal_end = performance.now();
        telemetry.stages.temporal_ms = telemetry.stages.temporal_end - telemetry.stages.temporal_start;
      }

      // ========================================
      // STAGE 6: Prepare output
      // ========================================
      const result = {
        tetraField: tetraField,
        resolution: resolution,
        channels: 4,
        encoding: 'float32',

        // Opponent channels: RG / BY (per-pixel), intensity included here for convenience
        opponentChannels: opponentChannels ? { RG: opponentChannels.RG, BY: opponentChannels.BY } : null,

        // Intensity (luminance) provided as a first-class signal for edges/bump/depth processing
        intensity: intensity || null,

        chromaticity: chromaticity,
        temporalStats: temporalStats,
        telemetry: telemetry
      };

      // Update statistics
      const processingMs = performance.now() - startTime;
      this.stats.framesProcessed++;
      this.stats.totalProcessingMs += processingMs;
      this.stats.avgProcessingMs = this.stats.totalProcessingMs / this.stats.framesProcessed;

      telemetry.success = true;
      telemetry.total_ms = processingMs;

      if (this.debug) {
        console.log('Tetrachromacy: Processing complete', {
          processingMs: processingMs.toFixed(2),
          resolution,
          opponentChannels: !!opponentChannels,
          chromaticity: !!chromaticity,
          temporalStats: !!temporalStats
        });
      }

      return result;

    } catch (err) {
      this.stats.lastError = err.message;
      telemetry.success = false;
      telemetry.error = err.message;
      telemetry.stack = err.stack;

      console.error('Tetrachromacy: Processing failed', err);
      throw err;
    }
  }

  /**
   * Extract individual RGBA channels
   * @private
   */
  _extractChannels(field, count) {
    const R = new Float32Array(count);
    const G = new Float32Array(count);
    const B = new Float32Array(count);
    const A = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      R[i] = field[i * 4 + 0];
      G[i] = field[i * 4 + 1];
      B[i] = field[i * 4 + 2];
      A[i] = field[i * 4 + 3];
    }

    return { R, G, B, A };
  }

  /**
   * Compute opponent color channels (RG, BY, Intensity)
   *
   * Opponent channels reduce correlation and improve discrimination:
   * - RG: Red-Green opponent (R - G)
   * - BY: Blue-Yellow opponent (B - 0.5*(R+G))
   * - intensity: Luminance (0.299*R + 0.587*G + 0.114*B)
   *
   * Returns { RG, BY, intensity }
   *
   * @private
   */
  _computeOpponentChannels(R, G, B, count) {
    const RG = new Float32Array(count);
    const BY = new Float32Array(count);
    const intensity = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const r = R[i];
      const g = G[i];
      const b = B[i];

      // Opponent channels
      RG[i] = r - g;
      BY[i] = b - 0.5 * (r + g);

      // Luminance (intensity) — ITU-R BT.601
      intensity[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    }

    return { RG, BY, intensity };
  }

  /**
   * Compute chromaticity (alpha-normalized chroma)
   *
   * Chromaticity separates color from intensity:
   * - chromaR: r / (r + g + b + epsilon)
   * - chromaG: g / (r + g + b + epsilon)
   * - chromaB: b / (r + g + b + epsilon)
   * - alphaNorm: alpha channel (preserved)
   *
   * @private
   */
  _computeChromaticity(R, G, B, A, count) {
    const chromaR = new Float32Array(count);
    const chromaG = new Float32Array(count);
    const chromaB = new Float32Array(count);
    const alphaNorm = new Float32Array(count);

    const epsilon = 1e-6;

    for (let i = 0; i < count; i++) {
      const r = R[i];
      const g = G[i];
      const b = B[i];
      const a = A[i];

      const sum = r + g + b + epsilon;

      chromaR[i] = r / sum;
      chromaG[i] = g / sum;
      chromaB[i] = b / sum;
      alphaNorm[i] = a;
    }

    return { chromaR, chromaG, chromaB, alphaNorm };
  }

  /**
   * Update temporal statistics using EMA (Exponential Moving Average)
   *
   * Maintains per-channel statistics:
   * - mean (EMA of channel values)
   * - variance (EMA of squared deviations)
   * - min/max (running extrema)
   *
   * @private
   */
  _updateTemporalStats(R, G, B, A, count, alpha) {
    // Initialize buffers on first call
    if (!this._temporalMean) {
      this._temporalMean = { R: new Float32Array(count), G: new Float32Array(count), B: new Float32Array(count), A: new Float32Array(count) };
      this._temporalVar = { R: new Float32Array(count), G: new Float32Array(count), B: new Float32Array(count), A: new Float32Array(count) };
      this._temporalMin = { R: new Float32Array(count).fill(Infinity), G: new Float32Array(count).fill(Infinity), B: new Float32Array(count).fill(Infinity), A: new Float32Array(count).fill(Infinity) };
      this._temporalMax = { R: new Float32Array(count).fill(-Infinity), G: new Float32Array(count).fill(-Infinity), B: new Float32Array(count).fill(-Infinity), A: new Float32Array(count).fill(-Infinity) };
    }

    const channels = [
      { current: R, mean: this._temporalMean.R, variance: this._temporalVar.R, min: this._temporalMin.R, max: this._temporalMax.R },
      { current: G, mean: this._temporalMean.G, variance: this._temporalVar.G, min: this._temporalMin.G, max: this._temporalMax.G },
      { current: B, mean: this._temporalMean.B, variance: this._temporalVar.B, min: this._temporalMin.B, max: this._temporalMax.B },
      { current: A, mean: this._temporalMean.A, variance: this._temporalVar.A, min: this._temporalMin.A, max: this._temporalMax.A }
    ];

    for (const ch of channels) {
      for (let i = 0; i < count; i++) {
        const value = ch.current[i];
        const oldMean = ch.mean[i];

        // Update mean (EMA)
        const newMean = oldMean + alpha * (value - oldMean);
        ch.mean[i] = newMean;

        // Update variance (EMA of squared deviation)
        const deviation = value - newMean;
        ch.variance[i] = ch.variance[i] + alpha * (deviation * deviation - ch.variance[i]);

        // Update min/max
        if (value < ch.min[i]) ch.min[i] = value;
        if (value > ch.max[i]) ch.max[i] = value;
      }
    }

    this._temporalCount++;

    // Return shallow copies of Float32Arrays (caller should treat them as read-only)
    return {
      mean: { R: this._temporalMean.R, G: this._temporalMean.G, B: this._temporalMean.B, A: this._temporalMean.A },
      variance: { R: this._temporalVar.R, G: this._temporalVar.G, B: this._temporalVar.B, A: this._temporalVar.A },
      min: { R: this._temporalMin.R, G: this._temporalMin.G, B: this._temporalMin.B, A: this._temporalMin.A },
      max: { R: this._temporalMax.R, G: this._temporalMax.G, B: this._temporalMax.B, A: this._temporalMax.A },
      count: this._temporalCount
    };
  }

  /**
   * Reset temporal statistics
   */
  resetTemporalStats() {
    this._temporalMean = null;
    this._temporalVar = null;
    this._temporalMin = null;
    this._temporalMax = null;
    this._temporalCount = 0;
  }

  /**
   * Get module statistics
   *
   * @returns {Object} Statistics object
   */
  getStats() {
    return { ...this.stats, temporalCount: this._temporalCount };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      framesProcessed: 0,
      avgProcessingMs: 0,
      totalProcessingMs: 0,
      lastError: null
    };
  }

  /**
   * Cleanup resources
   */
  dispose() {
    this._temporalMean = null;
    this._temporalVar = null;
    this._temporalMin = null;
    this._temporalMax = null;
  }
}

/**
 * Factory function for convenience
 *
 * @param {Object} options - Configuration options
 * @returns {Tetrachromacy} Tetrachromacy instance
 */
export function createTetrachromacy(options = {}) {
  return new Tetrachromacy(options);
}

export default Tetrachromacy;