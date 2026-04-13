// /src/js/core/KEMModule.js
//
// Stage 6 — Kinetic Energy Map (KEM) core computation.
//
// Computes a per-pixel kinetic energy field in surface coordinates, identifies
// clade structure from LQE end assignments, computes the tension field at clade
// boundaries, and classifies boundary pixels into leading/trailing/lateral edges.
//
// KEM formula (per narrow-band pixel):
//   Using principal frame (e1=tangent, e2=outward normal) from Stage 3:
//
//   dr  = flowU·e2x + flowV·e2y              (radial component — across level curves)
//   dθ  = flowU·e1x + flowV·e1y              (tangential component — along level curves)
//
//   KEM(x,y) = (dr² + (dθ/2π)²)             — surface-coordinate motion direction
//            × (1 - coherence[x,y])          — temporal reliability weight
//            × motionMagnitude[x,y]²          — image-space speed scaling
//
//   Degenerate guard: if |∇SDF| < 1e-6 (flat SDF, unreliable principal frame):
//   KEM(x,y) = motionMagnitude[x,y]² × (1 - coherence[x,y])
//
// Clade encoding: cladeId = endId × 2
//   Base / low-energy sub-clade: endId × 2
//   High-energy sub-clade:       endId × 2 + 1
//   Background (endId=0):        0
//   Outside narrow band:         -1
//
// Tension field: cross-clade KEM discontinuity (8-connectivity, sparse at boundaries).
//
// Velocity manifold: per-clade leading/trailing/lateral boundary classification
// based on alignment of mean clade flow with outward boundary normal.

const TWO_PI = 2 * Math.PI;

// ── 8-connected neighbour offsets ─────────────────────────────────────────
const DX8 = [-1, 0, 1, -1, 1, -1, 0, 1];
const DY8 = [-1,-1,-1,  0, 0,  1, 1, 1];

export class KEMModule {
  /**
   * @param {object}        inputs
   *
   * @param {Float32Array}  inputs.phiMin           — res², refined SDF (Stage 4B)
   *                                                  used only for degenerate guard context
   * @param {Float32Array}  inputs.warpField         — res²×2, (r,θ) per pixel (Stage 5)
   *                                                  not used in KEM computation directly
   *                                                  but available for downstream
   * @param {Float32Array}  inputs.principalFrame    — res²×4, e1x,e1y,e2x,e2y (Stage 3)
   * @param {Float32Array}  inputs.flowU             — res², H-S flow u-component (Stage 3)
   * @param {Float32Array}  inputs.flowV             — res², H-S flow v-component (Stage 3)
   * @param {Float32Array}  inputs.coherencePerPixel — res², from directional_field
   * @param {Float32Array}  inputs.motionMagnitude   — res², |flow| per pixel (Stage 4A)
   * @param {Int32Array}    inputs.motionEndsMap     — res², LQE end assignment (Stage 4A)
   *                                                  0=outer/background, ≥1=end id, -1=outside
   * @param {Float32Array}  inputs.narrowBandMask    — res², >0 inside band
   * @param {number}        inputs.resolution
   * @param {object}        [inputs.flags={}]
   */
  constructor(inputs) {
    const {
      phiMin, warpField, principalFrame,
      flowU, flowV, coherencePerPixel,
      motionMagnitude, motionEndsMap,
      narrowBandMask, resolution, flags = {}
    } = inputs;

    this._phiMin            = phiMin;
    this._warpField         = warpField;
    this._principalFrame    = principalFrame;
    this._flowU             = flowU;
    this._flowV             = flowV;
    this._coherence         = coherencePerPixel;
    this._motionMag         = motionMagnitude;
    this._motionEndsMap     = motionEndsMap;
    this._narrowBandMask    = narrowBandMask;
    this._w                 = resolution;
    this._flags             = flags;
  }

  // ── Public entry point ────────────────────────────────────────────────

  /**
   * compute()
   *
   * Runs all six KEM phases and returns the unified result.
   *
   * @returns {{
   *   kemField:         Float32Array,
   *   cladeMap:         Int32Array,
   *   tensionField:     Float32Array,
   *   velocityManifold: object,
   *   meanKEM:          number,
   *   cladeCount:       number,
   *   diagnostics:      object
   * }}
   */
  compute() {
    const w    = this._w;
    const N    = w * w;
    const mask = this._narrowBandMask;

    // ── Phase 1: Raw KEM field ─────────────────────────────────────────
    const { kemField, degeneratePixels } = this._computeKEMField(N, w);

    // ── Phase 2: Base clade assignment from motionEndsMap ─────────────
    // cladeId = endId × 2; background=0; outside=-1
    const cladeMap = this._buildBaseCladeMap(N);

    // ── Phase 3: KEM threshold split ──────────────────────────────────
    const { splitCount } = this._applyCladeSplit(kemField, cladeMap, N);

    // ── Phase 4: Tension field ─────────────────────────────────────────
    const tensionField = this._computeTensionField(kemField, cladeMap, N, w);

    // ── Phase 5: Velocity manifold ─────────────────────────────────────
    const velocityManifold = this._computeVelocityManifold(kemField, cladeMap, N, w);

    // ── Phase 6: Aggregate statistics ─────────────────────────────────
    let sumKEM = 0, countKEM = 0, minKEM = Infinity, maxKEM = -Infinity;
    for (let i = 0; i < N; i++) {
      if (!mask[i]) continue;
      const v = kemField[i];
      sumKEM += v;
      countKEM++;
      if (v < minKEM) minKEM = v;
      if (v > maxKEM) maxKEM = v;
    }
    const meanKEM = countKEM > 0 ? sumKEM / countKEM : 0;

    // Count distinct non-background clades
    const cladeIds = new Set();
    for (let i = 0; i < N; i++) {
      const c = cladeMap[i];
      if (c > 0) cladeIds.add(c);
    }
    const cladeCount = cladeIds.size;

    return {
      kemField,
      cladeMap,
      tensionField,
      velocityManifold,
      meanKEM,
      cladeCount,
      diagnostics: {
        degeneratePixels,
        splitCount,
        totalClades:  cladeCount + 1,   // including background
        kemRange: {
          min:  countKEM > 0 ? minKEM : 0,
          max:  countKEM > 0 ? maxKEM : 0,
          mean: meanKEM
        }
      }
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Phase 1: KEM field computation
  // ─────────────────────────────────────────────────────────────────────

  _computeKEMField(N, w) {
    const kemField        = new Float32Array(N);
    const pf              = this._principalFrame;
    const flowU           = this._flowU;
    const flowV           = this._flowV;
    const coherence       = this._coherence;
    const motionMag       = this._motionMag;
    const mask            = this._narrowBandMask;
    let   degeneratePixels = 0;

    for (let i = 0; i < N; i++) {
      if (!mask[i]) { kemField[i] = 0; continue; }

      // Principal frame at this pixel
      // Layout: e1x, e1y, e2x, e2y  (e1=tangent, e2=outward normal)
      const e1x = pf ? pf[i * 4]     : 1;
      const e1y = pf ? pf[i * 4 + 1] : 0;
      const e2x = pf ? pf[i * 4 + 2] : 0;
      const e2y = pf ? pf[i * 4 + 3] : 1;

      const u   = flowU   ? flowU[i]   : 0;
      const v   = flowV   ? flowV[i]   : 0;
      const coh = coherence ? Math.max(0, Math.min(1, coherence[i])) : 0.5;
      const mag = motionMag ? motionMag[i] : Math.sqrt(u * u + v * v);

      // Degenerate guard: check e2 magnitude (outward normal = SDF gradient direction)
      const gradMag = Math.sqrt(e2x * e2x + e2y * e2y);

      if (gradMag < 1e-6) {
        // Flat SDF — principal frame unreliable.
        // Fall back: raw motion magnitude × temporal reliability, no direction decomposition.
        kemField[i] = mag * mag * (1 - coh);
        degeneratePixels++;
      } else {
        // Full formula
        // e2 (outward normal) — normalise defensively
        const invGrad = 1.0 / gradMag;
        const ne2x = e2x * invGrad, ne2y = e2y * invGrad;
        // e1 (tangent) — normalise defensively
        const e1Mag = Math.sqrt(e1x * e1x + e1y * e1y);
        const ne1x  = e1Mag > 1e-8 ? e1x / e1Mag : 0;
        const ne1y  = e1Mag > 1e-8 ? e1y / e1Mag : 0;

        // Project flow onto frame axes
        const dr  = u * ne2x + v * ne2y;          // radial component
        const dth = u * ne1x + v * ne1y;           // tangential component

        // Scale dθ by 1/(2π) to bring into same [0,1] range as dr ∈ [0,1]
        const dthN = dth / TWO_PI;

        // Surface-coordinate direction factor × temporal reliability × speed scaling
        kemField[i] = (dr * dr + dthN * dthN) * (1 - coh) * mag * mag;
      }
    }

    return { kemField, degeneratePixels };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Phase 2: Base clade map from motionEndsMap
  // ─────────────────────────────────────────────────────────────────────

  _buildBaseCladeMap(N) {
    const cladeMap      = new Int32Array(N).fill(-1);
    const motionEndsMap = this._motionEndsMap;
    const mask          = this._narrowBandMask;

    if (!motionEndsMap) {
      // No LQE ends — everything in narrow band is background clade 0
      for (let i = 0; i < N; i++) {
        if (mask[i]) cladeMap[i] = 0;
      }
      return cladeMap;
    }

    for (let i = 0; i < N; i++) {
      if (!mask[i]) { cladeMap[i] = -1; continue; }
      const endId = motionEndsMap[i];
      // endId: -1=outside, 0=outer/background, ≥1=LQE end
      cladeMap[i] = endId >= 0 ? endId * 2 : 0;   // fallback unknown to background
    }

    return cladeMap;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Phase 3: KEM threshold split
  // ─────────────────────────────────────────────────────────────────────

  _applyCladeSplit(kemField, cladeMap, N) {
    const splitThreshold = this._flags.kemSplitThreshold ?? 2.0;
    const minCladePx     = this._flags.lqeMinSeedSize    ?? 16;
    const mask           = this._narrowBandMask;
    const motionEndsMap  = this._motionEndsMap;

    if (!motionEndsMap) return { splitCount: 0 };

    // Collect unique end IDs (≥1) present in the narrow band
    const endPixels = new Map();   // endId → [pixel index, ...]
    for (let i = 0; i < N; i++) {
      if (!mask[i]) continue;
      const endId = motionEndsMap[i];
      if (endId < 1) continue;
      if (!endPixels.has(endId)) endPixels.set(endId, []);
      endPixels.get(endId).push(i);
    }

    let splitCount = 0;

    for (const [endId, pixels] of endPixels) {
      if (pixels.length < minCladePx * 2) continue;

      // Compute mean KEM for this end's pixels
      let sumKEM = 0;
      for (const i of pixels) sumKEM += kemField[i];
      const meanKEM_end = sumKEM / pixels.length;

      const threshold = meanKEM_end * splitThreshold;

      // Partition into high and low
      const highPixels = pixels.filter(i => kemField[i] > threshold);
      const lowPixels  = pixels.filter(i => kemField[i] <= threshold);

      if (highPixels.length >= minCladePx && lowPixels.length >= minCladePx) {
        // Split: high-energy sub-clade gets endId*2+1, low keeps endId*2
        for (const i of highPixels) cladeMap[i] = endId * 2 + 1;
        // lowPixels already have endId*2 from Phase 2 — no change needed
        splitCount++;
      }
      // Else: no split, both remain at endId*2
    }

    return { splitCount };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Phase 4: Tension field (8-connectivity)
  // ─────────────────────────────────────────────────────────────────────

  _computeTensionField(kemField, cladeMap, N, w) {
    const tensionField = new Float32Array(N);
    const mask         = this._narrowBandMask;
    const h            = w;   // square grid

    for (let i = 0; i < N; i++) {
      if (!mask[i] || cladeMap[i] < 0) continue;

      const cx   = i % w;
      const cy   = (i / w) | 0;
      const kcI  = cladeMap[i];
      const kemI = kemField[i];
      let   maxCross = 0;

      for (let d = 0; d < 8; d++) {
        const nx = cx + DX8[d];
        const ny = cy + DY8[d];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const nb = ny * w + nx;
        if (!mask[nb]) continue;
        const kcNb = cladeMap[nb];
        if (kcNb < 0 || kcNb === kcI) continue;
        // Cross-clade neighbour — compute KEM discontinuity
        const diff = Math.abs(kemI - kemField[nb]);
        if (diff > maxCross) maxCross = diff;
      }

      tensionField[i] = maxCross;
    }

    return tensionField;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Phase 5: Velocity manifold
  // ─────────────────────────────────────────────────────────────────────

  _computeVelocityManifold(kemField, cladeMap, N, w) {
    const mask      = this._narrowBandMask;
    const flowU     = this._flowU;
    const flowV     = this._flowV;
    const thresh    = this._flags.kemEdgeAlignmentThresh ?? 0.3;
    const h         = w;

    // ── Collect pixels per clade ────────────────────────────────────────
    const cladePixels = new Map();   // cladeId → [pixel indices]
    for (let i = 0; i < N; i++) {
      if (!mask[i]) continue;
      const c = cladeMap[i];
      if (c < 0) continue;
      if (!cladePixels.has(c)) cladePixels.set(c, []);
      cladePixels.get(c).push(i);
    }

    const velocityManifold = {};

    for (const [cladeId, pixels] of cladePixels) {
      if (pixels.length === 0) continue;

      // ── Step 1: Mean flow direction of the clade ──────────────────────
      let sumU = 0, sumV = 0;
      for (const i of pixels) {
        sumU += flowU ? flowU[i] : 0;
        sumV += flowV ? flowV[i] : 0;
      }
      const meanU  = sumU / pixels.length;
      const meanV  = sumV / pixels.length;
      const flowMag = Math.sqrt(meanU * meanU + meanV * meanV);
      const dirU    = flowMag > 1e-8 ? meanU / flowMag : 0;
      const dirV    = flowMag > 1e-8 ? meanV / flowMag : 0;

      // ── Step 2: Identify boundary pixels ─────────────────────────────
      const boundaryPixels = [];
      for (const i of pixels) {
        const cx = i % w, cy = (i / w) | 0;
        let isBoundary = false;
        for (let d = 0; d < 8; d++) {
          const nx = cx + DX8[d], ny = cy + DY8[d];
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const nb = ny * w + nx;
          if (!mask[nb]) continue;
          if (cladeMap[nb] !== cladeId) { isBoundary = true; break; }
        }
        if (isBoundary) boundaryPixels.push(i);
      }

      // ── Step 3: Classify boundary pixels ─────────────────────────────
      const leadingPixels  = [];
      const trailingPixels = [];
      const lateralPixels  = [];

      for (const i of boundaryPixels) {
        const cx = i % w, cy = (i / w) | 0;

        // Compute outward normal: mean direction toward cross-clade neighbours
        let normX = 0, normY = 0, crossCount = 0;
        for (let d = 0; d < 8; d++) {
          const nx = cx + DX8[d], ny = cy + DY8[d];
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const nb = ny * w + nx;
          if (!mask[nb] || cladeMap[nb] === cladeId) continue;
          normX += (nx - cx);
          normY += (ny - cy);
          crossCount++;
        }

        if (crossCount === 0) { lateralPixels.push(i); continue; }

        const nMag = Math.sqrt(normX * normX + normY * normY);
        if (nMag < 1e-8) { lateralPixels.push(i); continue; }

        const outNX = normX / nMag;
        const outNY = normY / nMag;

        // Alignment of clade flow with outward boundary normal
        const alignment = dirU * outNX + dirV * outNY;

        if (alignment > thresh)   leadingPixels.push(i);
        else if (alignment < -thresh) trailingPixels.push(i);
        else                      lateralPixels.push(i);
      }

      // ── Step 4: KEM statistics per edge class ────────────────────────
      const meanKEM_lead = _meanOverPixels(kemField, leadingPixels);
      const meanKEM_trail = _meanOverPixels(kemField, trailingPixels);
      const meanKEM_clade = _meanOverPixels(kemField, pixels);

      velocityManifold[cladeId] = {
        meanFlowU:      meanU,
        meanFlowV:      meanV,
        meanSpeed:      flowMag,
        meanKEM:        meanKEM_clade,
        leadingPixels:  new Int32Array(leadingPixels),
        trailingPixels: new Int32Array(trailingPixels),
        lateralPixels:  new Int32Array(lateralPixels),
        leadingKEM:     meanKEM_lead,
        trailingKEM:    meanKEM_trail,
        pixelCount:     pixels.length,
        boundaryCount:  boundaryPixels.length
      };
    }

    return velocityManifold;
  }
}

// ── Utility ───────────────────────────────────────────────────────────────

function _meanOverPixels(field, pixelIndices) {
  if (!pixelIndices || pixelIndices.length === 0) return 0;
  let sum = 0;
  for (const i of pixelIndices) sum += field[i];
  return sum / pixelIndices.length;
}

export default KEMModule;