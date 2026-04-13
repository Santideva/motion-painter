// /src/js/core/PenumbraAnalyzer.js
//
// Stage 1 — Visibility & Illumination
// Shadow edge characterizer and light source tracker.
//
// PURPOSE:
//   Answers three questions about each frame:
//     1. Where are the shadow edges?
//     2. How soft or hard are they (penumbra width)?
//     3. Where is the light source?
//
// OUTPUTS feed:
//   - PackingSDF     (widthMap → narrow band width, lightTrack → SDF orientation)
//   - f_map Route A  (lightTrack → Monte Carlo source point for visibility rays)
//   - Stage 3 DiffGeo (edgeMask → prevents shadow edges being read as surface creases)
//   - UR-MD-02       (edgeMask → shadow motion excluded from kinetic tension field)
//
// PATTERN:
//   Follows existing module conventions (DirectionalLifting.js, Tetrachromacy.js):
//   - Class with constructor options
//   - Single primary async method
//   - dispose() for cleanup
//   - Factory function export
//   - No GPU dependency — pure CPU typed array operations
//   - Runs in parallel with GPU pipeline (no depth required)
//
// INTEGRATION:
//   Imported by motion.worker.js alongside CalibratedFieldProducer,
//   Tetrachromacy, and DirectionalLifting.
//   Instantiated as a lazy singleton via _getPenumbraAnalyzer().

export class PenumbraAnalyzer {
  /**
   * @param {Object} options
   * @param {number} [options.profileWindowPx=17]
   *   Width of the crossing strip sampled orthogonally across each shadow
   *   edge. Wider = more robust against noise but smooths over fine detail.
   *   Forced to odd integer >= 5 internally.
   * @param {number} [options.brightnessThreshold=0.75]
   *   Fraction of frame max brightness above which a pixel is a light source
   *   candidate. Range 0–1.
   * @param {number} [options.minEdgeGradient=0.05]
   *   Minimum Sobel gradient magnitude to qualify as a shadow edge pixel.
   *   Normalised 0–1 (input intensity is normalised).
   * @param {number} [options.minEdgeLength=8]
   *   Minimum connected edge pixel count to survive texture-noise filtering.
   *   Shadow edges form long curves; texture edges form short isolated patches.
   * @param {number} [options.maxLightSources=8]
   *   Cap on the number of tracked light sources returned in lightTrack.
   * @param {number} [options.minFitR2=0.6]
   *   Minimum R² of logistic curve fit to accept a width measurement as valid.
   *   Fits below this quality are rejected (edgeMask stays 0 at that pixel).
   * @param {number} [options.stabilityWeight=0.6]
   *   Blend weight for temporal stability vs brightness in light source
   *   confidence score. 1.0 = stability only, 0.0 = brightness only.
   * @param {boolean} [options.debug=false]
   */
  constructor(options = {}) {
    // Force odd integer >= 5 for profile window
    const rawWin = options.profileWindowPx || 17;
    this.profileWindowPx = Math.max(5, rawWin % 2 === 0 ? rawWin + 1 : rawWin);

    this.brightnessThreshold = typeof options.brightnessThreshold === 'number'
      ? Math.max(0, Math.min(1, options.brightnessThreshold))
      : 0.75;

    this.minEdgeGradient = typeof options.minEdgeGradient === 'number'
      ? Math.max(0, options.minEdgeGradient)
      : 0.05;

    this.minEdgeLength = Number.isInteger(options.minEdgeLength) && options.minEdgeLength > 0
      ? options.minEdgeLength
      : 8;

    this.maxLightSources = Number.isInteger(options.maxLightSources) && options.maxLightSources > 0
      ? options.maxLightSources
      : 8;

    this.minFitR2 = typeof options.minFitR2 === 'number'
      ? Math.max(0, Math.min(1, options.minFitR2))
      : 0.6;

    this.stabilityWeight = typeof options.stabilityWeight === 'number'
      ? Math.max(0, Math.min(1, options.stabilityWeight))
      : 0.6;

    this.debug = !!options.debug;

    // Stats accumulated across calls
    this.stats = {
      framesProcessed:  0,
      totalProcessingMs: 0,
      avgProcessingMs:  0,
      lastError:        null
    };
  }

  // ============================================================================
  // PRIMARY PUBLIC METHOD
  // ============================================================================

  /**
   * Analyze a frame for shadow edges and light source locations.
   *
   * Called from motion.worker inside the Promise.all parallel branch — runs
   * concurrently with the GPU triangle preprocessor. No depth required; no GPU.
   *
   * @param {Float32Array} calibratedField
   *   Linearized RGBA frame after dark/flat/bias correction.
   *   length = resolution² × 4.
   * @param {Float32Array} directionalField
   *   Temporally averaged RGBA from DirectionalLifting.process().
   *   Same dimensions as calibratedField.
   * @param {Float32Array} intensity
   *   Single-channel luminance per pixel from Tetrachromacy opponentChannels.L
   *   (or luminance fallback). length = resolution².
   * @param {number} resolution
   *   Square grid side length (e.g. 512).
   * @param {Object} [options]
   *   Per-call overrides.
   * @param {Object} [options.derivatives]
   *   DirectionalLifting derivatives output { field: Float32Array, dt: number }.
   *   Used for temporal stability scoring of light source candidates.
   *   Optional — if absent, stability is estimated from directionalField variance.
   * @param {number} [options.profileWindowPx]
   *   Override constructor profileWindowPx for this call only.
   *
   * @returns {Promise<{
   *   widthMap:  Float32Array,  // transition width per pixel [0..1], res²
   *   edgeMask:  Uint8Array,    // 1 = valid shadow edge pixel, res²
   *   lightTrack: Array,        // [{imageXY, conf, radius, centroidI}]
   *   telemetry: Object
   * }>}
   */
  async analyze(calibratedField, directionalField, intensity, resolution, options = {}) {
    const startTime = performance.now();
    const telemetry = {
      stages:   {},
      warnings: [],
      success:  false
    };

    try {
      // ── Input validation ─────────────────────────────────────────────────
      const count = resolution * resolution;

      if (!calibratedField || calibratedField.length !== count * 4) {
        throw new Error(
          `calibratedField invalid: expected ${count * 4} elements, ` +
          `got ${calibratedField?.length ?? 0}`
        );
      }
      if (!directionalField || directionalField.length !== count * 4) {
        throw new Error(
          `directionalField invalid: expected ${count * 4} elements, ` +
          `got ${directionalField?.length ?? 0}`
        );
      }
      if (!intensity || intensity.length !== count) {
        throw new Error(
          `intensity invalid: expected ${count} elements, ` +
          `got ${intensity?.length ?? 0}`
        );
      }
      if (!Number.isInteger(resolution) || resolution < 4 || resolution > 4096) {
        throw new Error(`resolution out of range: ${resolution}`);
      }

      // Resolve profile window for this call
      const rawWin     = options.profileWindowPx || this.profileWindowPx;
      const profileWin = Math.max(5, rawWin % 2 === 0 ? rawWin + 1 : rawWin);
      const halfWin    = Math.floor(profileWin / 2);
      const derivatives = options.derivatives || null;

      // ── STEP 1: Sobel gradient on intensity field ─────────────────────────
      telemetry.stages.sobel_start = performance.now();
      const { gradMag, gradX, gradY } = this._computeSobel(intensity, resolution);
      telemetry.stages.sobel_ms = performance.now() - telemetry.stages.sobel_start;

      // ── STEP 2: Threshold to candidate edge pixels ────────────────────────
      telemetry.stages.threshold_start = performance.now();
      const candidateEdge = this._thresholdEdges(gradMag, count);
      telemetry.stages.threshold_ms = performance.now() - telemetry.stages.threshold_start;

      // ── STEP 3: Connected component filtering ─────────────────────────────
      // Removes short isolated components (texture noise, print patterns).
      // Shadow edges are elongated curves; texture edges are small and closed.
      telemetry.stages.connect_start = performance.now();
      const filteredEdge = this._filterByConnectivity(
        candidateEdge, resolution, this.minEdgeLength
      );
      telemetry.stages.connect_ms = performance.now() - telemetry.stages.connect_start;

      // ── STEP 4: Profile each edge pixel and fit logistic curve ────────────
      telemetry.stages.profile_start = performance.now();
      const { widthMap, edgeMask, fitStats } = this._profileAndFit(
        filteredEdge, gradX, gradY, gradMag, intensity, resolution, halfWin
      );
      telemetry.stages.profile_ms = performance.now() - telemetry.stages.profile_start;

      // ── STEP 5: Detect light source positions ─────────────────────────────
      telemetry.stages.lighttrack_start = performance.now();
      const lightTrack = this._detectLightTrack(
        intensity, directionalField, derivatives, resolution
      );
      telemetry.stages.lighttrack_ms = performance.now() - telemetry.stages.lighttrack_start;

      // ── Compile telemetry ─────────────────────────────────────────────────
      const processingMs = performance.now() - startTime;

      telemetry.edgeCount        = fitStats.accepted;
      telemetry.lightCount       = lightTrack.length;
      telemetry.meanWidth        = fitStats.meanWidth;
      telemetry.sharpEdgeFrac    = fitStats.sharpFrac;    // width < 0.05
      telemetry.softEdgeFrac     = fitStats.softFrac;     // width > 0.15
      telemetry.profileFitMeanR2 = fitStats.meanR2;
      telemetry.candidateEdgePx  = fitStats.candidates;
      telemetry.rejectedLowR2    = fitStats.rejectedR2;
      telemetry.processingMs     = processingMs;
      telemetry.success          = true;

      this.stats.framesProcessed++;
      this.stats.totalProcessingMs += processingMs;
      this.stats.avgProcessingMs =
        this.stats.totalProcessingMs / this.stats.framesProcessed;

      if (this.debug) {
        console.log('PenumbraAnalyzer: complete', {
          processingMs:  processingMs.toFixed(2),
          edgeCount:     fitStats.accepted,
          lightCount:    lightTrack.length,
          meanWidth:     fitStats.meanWidth.toFixed(4),
          meanR2:        fitStats.meanR2.toFixed(3),
          sharpEdgeFrac: fitStats.sharpFrac.toFixed(3),
          softEdgeFrac:  fitStats.softFrac.toFixed(3)
        });
      }

      return { widthMap, edgeMask, lightTrack, telemetry };

    } catch (err) {
      this.stats.lastError = err?.message ?? String(err);
      telemetry.success    = false;
      telemetry.error      = err?.message ?? String(err);
      if (this.debug) console.error('PenumbraAnalyzer: analyze failed', err);
      throw err;
    }
  }

  // ============================================================================
  // STEP 1 — SOBEL GRADIENT
  // ============================================================================

  /**
   * Compute Sobel gradient on the scalar intensity field.
   *
   * Sobel kernels (3×3):
   *   Gx = [[-1, 0, +1],       Gy = [[-1, -2, -1],
   *         [-2, 0, +2],              [ 0,  0,  0],
   *         [-1, 0, +1]]              [+1, +2, +1]]
   *
   * All outputs normalised to [0,1] by dividing by the theoretical maximum
   * response (8.0) for a [0,1] input. Border pixels carry zero gradient.
   *
   * @param {Float32Array} intensity  length = resolution²
   * @param {number}       resolution
   * @returns {{ gradMag, gradX, gradY }}  each Float32Array length = resolution²
   * @private
   */
  _computeSobel(intensity, resolution) {
    const count   = resolution * resolution;
    const gradX   = new Float32Array(count);
    const gradY   = new Float32Array(count);
    const gradMag = new Float32Array(count);

    const get = (x, y) => {
      // Clamp-to-border: out-of-bounds positions return 0
      if (x < 0 || x >= resolution || y < 0 || y >= resolution) return 0;
      return intensity[y * resolution + x];
    };

    for (let y = 1; y < resolution - 1; y++) {
      for (let x = 1; x < resolution - 1; x++) {
        const gx = (
          -1 * get(x - 1, y - 1) + 1 * get(x + 1, y - 1) +
          -2 * get(x - 1, y    ) + 2 * get(x + 1, y    ) +
          -1 * get(x - 1, y + 1) + 1 * get(x + 1, y + 1)
        ) / 8.0;

        const gy = (
          -1 * get(x - 1, y - 1) - 2 * get(x, y - 1) - 1 * get(x + 1, y - 1) +
           1 * get(x - 1, y + 1) + 2 * get(x, y + 1) + 1 * get(x + 1, y + 1)
        ) / 8.0;

        const idx    = y * resolution + x;
        gradX[idx]   = gx;
        gradY[idx]   = gy;
        gradMag[idx] = Math.sqrt(gx * gx + gy * gy);
      }
    }

    return { gradMag, gradX, gradY };
  }

  // ============================================================================
  // STEP 2 — THRESHOLD
  // ============================================================================

  /**
   * Produce a binary candidate edge mask: 1 where gradMag >= minEdgeGradient.
   *
   * @param {Float32Array} gradMag  length = count
   * @param {number}       count    resolution²
   * @returns {Uint8Array}          length = count
   * @private
   */
  _thresholdEdges(gradMag, count) {
    const candidate = new Uint8Array(count);
    const thresh    = this.minEdgeGradient;
    for (let i = 0; i < count; i++) {
      candidate[i] = gradMag[i] >= thresh ? 1 : 0;
    }
    return candidate;
  }

  // ============================================================================
  // STEP 3 — CONNECTED COMPONENT FILTERING
  // ============================================================================

  /**
   * Remove connected components shorter than minEdgeLength pixels.
   *
   * Uses 8-connectivity BFS flood fill. Components with fewer pixels than
   * minEdgeLength are cleared. Larger components are kept intact.
   *
   * Rationale: shadow edges are long continuous curves. Texture edges (fabric,
   * print, surface markings) produce short or closed edge fragments. This
   * filter surgically removes the short fragments without affecting genuine
   * shadow edge curves.
   *
   * @param {Uint8Array} candidate   thresholded edge mask
   * @param {number}     resolution
   * @param {number}     minLen      minimum component pixel count to keep
   * @returns {Uint8Array}           filtered edge mask
   * @private
   */
  _filterByConnectivity(candidate, resolution, minLen) {
    const count    = resolution * resolution;
    const visited  = new Uint8Array(count);
    const filtered = new Uint8Array(count);

    // 8-connected neighbour offsets [dx, dy]
    const nbrs = [
      [-1,-1], [ 0,-1], [ 1,-1],
      [-1, 0],           [ 1, 0],
      [-1, 1], [ 0, 1], [ 1, 1]
    ];

    // Reusable BFS queue — avoids repeated allocation
    const queue = new Int32Array(count);

    for (let y = 0; y < resolution; y++) {
      for (let x = 0; x < resolution; x++) {
        const seed = y * resolution + x;
        if (!candidate[seed] || visited[seed]) continue;

        // BFS from this seed
        let qHead = 0;
        let qTail = 0;
        queue[qTail++] = seed;
        visited[seed]  = 1;

        // Collect component pixel indices in a temporary list
        const component = [seed];

        while (qHead < qTail) {
          const cur = queue[qHead++];
          const cx  = cur % resolution;
          const cy  = Math.floor(cur / resolution);

          for (const [dx, dy] of nbrs) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || nx >= resolution || ny < 0 || ny >= resolution) continue;
            const nIdx = ny * resolution + nx;
            if (!candidate[nIdx] || visited[nIdx]) continue;
            visited[nIdx]      = 1;
            queue[qTail++]     = nIdx;
            component.push(nIdx);
          }
        }

        // Keep only if the component meets the minimum length
        if (component.length >= minLen) {
          for (const i of component) filtered[i] = 1;
        }
      }
    }

    return filtered;
  }

  // ============================================================================
  // STEP 4 — PROFILE AND FIT
  // ============================================================================

  /**
   * Sample crossing strips at each surviving edge pixel and fit a logistic
   * curve to measure the shadow transition width.
   *
   * The crossing direction at each pixel is the gradient direction (normX,
   * normY) — gradient always points in the direction of steepest brightness
   * change, which is perpendicular to the edge.
   *
   * Logistic model:
   *   I(t) = I_low + (I_high - I_low) / (1 + exp(-k × (t - t₀)))
   *
   *   width = 4 / k   (the span covering 10%–90% of the brightness transition)
   *
   * Width is normalised by resolution so the value is scale-independent
   * and comparable across reconstructions at different resolutions.
   *
   * Fits with R² < minFitR2 are rejected — edgeMask stays 0 at that pixel.
   *
   * @returns {{ widthMap: Float32Array, edgeMask: Uint8Array, fitStats: Object }}
   * @private
   */
  _profileAndFit(edgeMap, gradX, gradY, gradMag, intensity, resolution, halfWin) {
    const count    = resolution * resolution;
    const widthMap = new Float32Array(count);
    const edgeMask = new Uint8Array(count);

    let sumWidth   = 0;
    let sumR2      = 0;
    let accepted   = 0;
    let rejectedR2 = 0;
    let candidates = 0;
    let sharpCount = 0;   // width < 0.05 (sharp shadow, point-like source)
    let softCount  = 0;   // width > 0.15 (soft shadow, extended source)

    for (let y = 1; y < resolution - 1; y++) {
      for (let x = 1; x < resolution - 1; x++) {
        const idx = y * resolution + x;
        if (!edgeMap[idx]) continue;
        candidates++;

        // Gradient direction at this pixel (unit vector)
        const gm = gradMag[idx];
        if (gm < 1e-6) continue;   // degenerate pixel — skip
        const normX = gradX[idx] / gm;
        const normY = gradY[idx] / gm;

        // Sample crossing strip (bilinear interpolation)
        const profile = this._sampleStrip(
          intensity, resolution, x, y, normX, normY, halfWin
        );
        if (!profile) continue;   // strip went out of bounds

        // Fit logistic to the strip
        const fit = this._fitLogistic(profile);
        if (!fit || fit.r2 < this.minFitR2) {
          rejectedR2++;
          continue;
        }

        // Width normalised to [0, 1] by dividing by resolution
        const widthNorm = fit.width / resolution;

        widthMap[idx] = widthNorm;
        edgeMask[idx] = 1;
        accepted++;
        sumWidth += widthNorm;
        sumR2    += fit.r2;

        if (widthNorm < 0.05) sharpCount++;
        if (widthNorm > 0.15) softCount++;
      }
    }

    return {
      widthMap,
      edgeMask,
      fitStats: {
        candidates,
        accepted,
        rejectedR2,
        meanWidth: accepted > 0 ? sumWidth / accepted : 0,
        meanR2:    accepted > 0 ? sumR2    / accepted : 0,
        sharpFrac: accepted > 0 ? sharpCount / accepted : 0,
        softFrac:  accepted > 0 ? softCount  / accepted : 0
      }
    };
  }

  /**
   * Sample a 1D brightness strip of length (2 × halfWin + 1) pixels centered
   * at (cx, cy), stepping in direction (normX, normY).
   *
   * Uses bilinear interpolation so the strip can be sampled at any sub-pixel
   * angle without aliasing.
   *
   * Returns null if any sample falls outside the image bounds.
   *
   * @param {Float32Array} intensity
   * @param {number}       resolution
   * @param {number}       cx, cy     center pixel (integer)
   * @param {number}       normX, normY  unit direction vector
   * @param {number}       halfWin    half-length of strip in pixels
   * @returns {Float32Array | null}
   * @private
   */
  _sampleStrip(intensity, resolution, cx, cy, normX, normY, halfWin) {
    const len   = 2 * halfWin + 1;
    const strip = new Float32Array(len);

    for (let s = -halfWin; s <= halfWin; s++) {
      const px = cx + s * normX;
      const py = cy + s * normY;

      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const x1 = x0 + 1;
      const y1 = y0 + 1;

      // Reject if the bilinear quad goes out of bounds
      if (x0 < 0 || x1 >= resolution || y0 < 0 || y1 >= resolution) return null;

      const fx = px - x0;
      const fy = py - y0;

      const v00 = intensity[y0 * resolution + x0];
      const v10 = intensity[y0 * resolution + x1];
      const v01 = intensity[y1 * resolution + x0];
      const v11 = intensity[y1 * resolution + x1];

      strip[s + halfWin] =
        v00 * (1 - fx) * (1 - fy) +
        v10 * fx       * (1 - fy) +
        v01 * (1 - fx) * fy       +
        v11 * fx       * fy;
    }

    return strip;
  }

  /**
   * Fit a logistic function to a 1D brightness strip and return the
   * transition width and goodness of fit (R²).
   *
   * Parameter estimation:
   *   I_low  = profile minimum (dark side of shadow)
   *   I_high = profile maximum (lit side)
   *   t₀     = position where profile crosses the midpoint value
   *   k      = steepness derived from the 25%–75% crossing span:
   *            k = 2 × ln(3) / span
   *            (comes from inverting the logistic at 0.25 and 0.75)
   *   width  = 4 / k  (the 10%–90% transition distance in strip sample units)
   *
   * Returns null if the strip has insufficient brightness contrast (< 0.02
   * normalised), which happens for non-edge pixels that survived earlier
   * filtering due to noise.
   *
   * @param {Float32Array} profile
   * @returns {{ width, k, t0, r2 } | null}
   * @private
   */
  _fitLogistic(profile) {
    const n      = profile.length;
    let   I_low  =  Infinity;
    let   I_high = -Infinity;

    for (let i = 0; i < n; i++) {
      if (profile[i] < I_low)  I_low  = profile[i];
      if (profile[i] > I_high) I_high = profile[i];
    }

    const range = I_high - I_low;
    if (range < 0.02) return null;   // insufficient contrast to fit

    // Locate t₀: position closest to the midpoint brightness
    const midVal = I_low + range * 0.5;
    let   t0     = Math.floor(n / 2);
    let   minD   = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(profile[i] - midVal);
      if (d < minD) { minD = d; t0 = i; }
    }

    // Locate the 25% and 75% crossing positions to estimate k
    const val25 = I_low + range * 0.25;
    const val75 = I_low + range * 0.75;
    let   i25   = t0;
    let   i75   = t0;
    let   best25 = Infinity;
    let   best75 = Infinity;

    for (let i = 0; i < n; i++) {
      const d25 = Math.abs(profile[i] - val25);
      const d75 = Math.abs(profile[i] - val75);
      if (d25 < best25) { best25 = d25; i25 = i; }
      if (d75 < best75) { best75 = d75; i75 = i; }
    }

    // k from 25%–75% span
    // Logistic inverse: σ⁻¹(0.75) - σ⁻¹(0.25) = 2 × ln(3) / k
    const span  = Math.max(1, Math.abs(i75 - i25));
    const k     = (2 * Math.log(3)) / span;
    const width = 4 / k;   // 10%–90% transition in strip sample units

    // R² of the logistic fit against the actual profile
    let ssTot = 0;
    let ssRes = 0;
    let meanP = 0;
    for (let i = 0; i < n; i++) meanP += profile[i];
    meanP /= n;

    for (let i = 0; i < n; i++) {
      const predicted = I_low + range / (1 + Math.exp(-k * (i - t0)));
      ssRes += (profile[i] - predicted) * (profile[i] - predicted);
      ssTot += (profile[i] - meanP)     * (profile[i] - meanP);
    }

    const r2 = ssTot > 1e-9 ? Math.max(0, 1 - ssRes / ssTot) : 0;

    return { width, k, t0, r2 };
  }

  // ============================================================================
  // STEP 5 — LIGHT SOURCE DETECTION
  // ============================================================================

  /**
   * Find light source positions in the frame.
   *
   * Algorithm:
   *   1. Locate pixels above (brightnessThreshold × frame_maximum) in intensity.
   *   2. Region-grow bright pixels into candidate blobs (4-connectivity BFS).
   *   3. Score each blob: conf = stabilityWeight × stability + (1-w) × brightness
   *      where stability comes from the temporal derivative field — low
   *      frame-to-frame change = stable = more likely a real source than a
   *      transient specular reflection.
   *   4. Sort by confidence, return top maxLightSources.
   *
   * Temporal stability source (priority order):
   *   A. derivatives.field from DirectionalLifting — most direct measurement.
   *      Low |derivative| at a pixel means it barely changed between frames.
   *   B. Discrepancy between directionalField (temporal average) and
   *      calibratedField (current frame) — where they agree, scene is stable.
   *
   * @param {Float32Array} intensity
   * @param {Float32Array} directionalField
   * @param {Object|null}  derivatives  { field: Float32Array, dt: number }
   * @param {number}       resolution
   * @returns {Array<{ imageXY: number[], conf: number, radius: number, centroidI: number }>}
   * @private
   */
  _detectLightTrack(intensity, directionalField, derivatives, resolution) {
    const count = resolution * resolution;

    // Find frame maximum for brightness thresholding
    let maxI = 0;
    for (let i = 0; i < count; i++) {
      if (intensity[i] > maxI) maxI = intensity[i];
    }
    if (maxI < 1e-6) return [];   // entirely dark frame — no sources

    const absThresh = maxI * this.brightnessThreshold;

    // Build bright pixel mask
    const brightMask = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      brightMask[i] = intensity[i] >= absThresh ? 1 : 0;
    }

    // ── Region-grow bright pixels into blobs ─────────────────────────────
    // 4-connectivity only (light sources are compact; 4-conn is faster and
    // avoids connecting diagonally adjacent reflections into one blob).
    const visited = new Uint8Array(count);
    const blobs   = [];

    const nbrs4 = [[-1,0],[1,0],[0,-1],[0,1]];
    const bfsQ  = new Int32Array(count);   // reusable queue

    for (let y = 0; y < resolution; y++) {
      for (let x = 0; x < resolution; x++) {
        const seed = y * resolution + x;
        if (!brightMask[seed] || visited[seed]) continue;

        let qHead = 0;
        let qTail = 0;
        bfsQ[qTail++] = seed;
        visited[seed] = 1;

        const pixels = [seed];
        let sumI = intensity[seed];
        let sumX = x;
        let sumY = y;

        while (qHead < qTail) {
          const cur = bfsQ[qHead++];
          const cx  = cur % resolution;
          const cy  = Math.floor(cur / resolution);

          for (const [dx, dy] of nbrs4) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || nx >= resolution || ny < 0 || ny >= resolution) continue;
            const nIdx = ny * resolution + nx;
            if (!brightMask[nIdx] || visited[nIdx]) continue;
            visited[nIdx]   = 1;
            bfsQ[qTail++]   = nIdx;
            pixels.push(nIdx);
            sumI += intensity[nIdx];
            sumX += nx;
            sumY += ny;
          }
        }

        const n       = pixels.length;
        const centX   = sumX / n;
        const centY   = sumY / n;
        const centI   = (sumI / n) / maxI;          // normalised [0,1]
        const radius  = Math.sqrt(n / Math.PI);     // effective circular radius

        blobs.push({ pixels, centX, centY, centI, radius });
      }
    }

    if (blobs.length === 0) return [];

    // ── Score each blob ───────────────────────────────────────────────────
    const useDerivatives = !!(
      derivatives &&
      derivatives.field &&
      derivatives.field.length === count * 4
    );

    const scored = blobs.map(blob => {
      let stabilitySum = 0;
      const n = blob.pixels.length;

      if (useDerivatives) {
        // Route A: temporal stability from DirectionalLifting derivative field.
        // Low derivative magnitude → pixel barely changed → stable source.
        for (const px of blob.pixels) {
          const base = px * 4;
          const dr   = derivatives.field[base];
          const dg   = derivatives.field[base + 1];
          const db   = derivatives.field[base + 2];
          const mag  = Math.sqrt(dr*dr + dg*dg + db*db);
          stabilitySum += 1 / (1 + mag);
        }
      } else {
        // Route B: compare directionalField (temporal average) to current
        // intensity at each blob pixel. Close agreement → stable.
        for (const px of blob.pixels) {
          const base = px * 4;
          const dr   = directionalField[base]     - blob.centI;
          const dg   = directionalField[base + 1] - blob.centI;
          const db   = directionalField[base + 2] - blob.centI;
          const diff = Math.sqrt(dr*dr + dg*dg + db*db);
          stabilitySum += 1 / (1 + diff);
        }
      }

      const stability = n > 0 ? stabilitySum / n : 0;
      const w         = this.stabilityWeight;
      const conf      = Math.max(0, Math.min(1, w * stability + (1 - w) * blob.centI));

      return {
        imageXY:   [blob.centX, blob.centY],
        conf,
        radius:    blob.radius,
        centroidI: blob.centI
      };
    });

    // Return top N by confidence
    scored.sort((a, b) => b.conf - a.conf);
    return scored.slice(0, this.maxLightSources);
  }

  // ============================================================================
  // DIAGNOSTICS
  // ============================================================================

  /**
   * Return accumulated processing statistics across all analyze() calls.
   * @returns {Object}
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * Reset accumulated statistics.
   */
  resetStats() {
    this.stats = {
      framesProcessed:  0,
      totalProcessingMs: 0,
      avgProcessingMs:  0,
      lastError:        null
    };
  }

  /**
   * Release held references.
   *
   * PenumbraAnalyzer is stateless across frames — no GPU resources, no rolling
   * buffer. This method is provided for API consistency with DirectionalLifting
   * and Tetrachromacy, both of which do hold state and require explicit disposal.
   */
  dispose() {
    // No resources to release.
    // Included for consistency with the module dispose() contract.
  }
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

/**
 * Convenience factory following the createDirectionalLifting() pattern.
 *
 * @param {Object} options - See PenumbraAnalyzer constructor.
 * @returns {PenumbraAnalyzer}
 *
 * @example
 * // In motion.worker.js lazy singleton getter:
 * let _penumbraAnalyzer = null;
 * function _getPenumbraAnalyzer() {
 *   if (!_penumbraAnalyzer) {
 *     _penumbraAnalyzer = createPenumbraAnalyzer({
 *       profileWindowPx:    _flags.penumbraProfileWindow || 17,
 *       brightnessThreshold: _flags.penumbraBrightnessThresh || 0.75,
 *       debug:              _flags.penumbraDebug || false
 *     });
 *   }
 *   return _penumbraAnalyzer;
 * }
 */
export function createPenumbraAnalyzer(options = {}) {
  return new PenumbraAnalyzer(options);
}

export default PenumbraAnalyzer;