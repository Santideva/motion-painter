// /src/js/core/PrimeEnds.js
//
// Discrete prime-ends construction for Stage 4A.
//
// Inputs (loaded artifacts):
//   - sdf_field    → signedSdf, narrowBandMask
//   - curvature_field → kH (level-set curvature)
//   - directional_field → (via PixelGraph, already fused)
//
// Algorithm:
//   1. Identify curvature-peak anchor nodes (local maxima of |kH|).
//   2. Compute cross-cut sampling budget from b1 + curvaturePeaks.
//   3. Delegate to runCrosscutChainClustering with curvature-peak bias.
//   4. Build boundary parameterisation (angular intervals on model circle).
//   5. Validate invariants; emit diagnostics.
//
// Output artifact: prime_ends
//   {
//     ends:            PrimeEnd[],
//     topologyMap:     Int32Array(w·h),  full-res (−1 outside band, ≥0 inside)
//     boundaryParam:   { intervals: [{ endId, theta0, theta1 }], ... },
//     homologySummary: { b0, b1, chi, curvaturePeaks, endCount },
//     diagnostics:     object
//   }

import { runCrosscutChainClustering } from './runCrosscutChainClustering.js';

export class PrimeEnds {
  /**
   * @param {import('./PixelGraph.js').PixelGraph} G  — shared graph instance
   * @param {Float32Array} kH                         — level-set curvature res²
   * @param {number}       width
   * @param {number}       height
   * @param {object}       [flags={}]
   */
  constructor(G, kH, width, height, flags = {}) {
    this._G      = G;
    this._kH     = kH;
    this._width  = width;
    this._height = height;
    this._flags  = flags;
  }

  // ── Public entry point ────────────────────────────────────────────────
  compute(frameIndex = 0) {
    const G     = this._G;
    const kH    = this._kH;
    const flags = this._flags;
    const w     = this._width;
    const h     = this._height;

    // ── 1. Curvature peak detection ──────────────────────────────────────
    const curvaturePeaks = this._detectCurvaturePeaks(kH, w, G);

    if (this._flags.debugLog) {
      console.log(`[PrimeEnds] Curvature peaks: ${curvaturePeaks.length}`);
    }

    // ── 2. Cross-cut budget ──────────────────────────────────────────────
    const b1     = G.cycleCount;
    const S0     = flags.topoBudgetS0    ?? 30;
    const alpha  = flags.topoBudgetAlpha ?? 3.0;
    const beta   = flags.topoBudgetBeta  ?? 0.5;
    const Smax   = flags.topoBudgetSMax  ?? 120;
    const budget = Math.min(Smax, Math.floor(S0 * (1 + alpha * b1 + beta * curvaturePeaks.length)));

    if (this._flags.debugLog) {
      console.log(`[PrimeEnds] Budget: ${budget}  b0=${G.componentCount}  b1=${b1}`);
    }

    // ── 3. Crosscut/chain/clustering ─────────────────────────────────────
    const { ends, nodeEndMap, chains, diagnostics } =
      runCrosscutChainClustering(G, curvaturePeaks, budget, flags);

    // Stamp frameIndex into ends
    for (const end of ends) end.birthFrame = frameIndex;

    // ── 4. Full-resolution topology map ──────────────────────────────────
    const topologyMap = this._buildTopologyMap(nodeEndMap, G, w, h);

    // ── 5. Boundary parameterisation ─────────────────────────────────────
    const boundaryParam = this._buildBoundaryParam(ends, G, w);

    // ── 5a. Attach boundaryInterval back onto each end object ─────────────
    // _buildBoundaryParam computes angular intervals per end but does not
    // write them back onto the end objects. Stage 5 (AmbiAnamorph) needs
    // boundaryInterval on each end for the feature vector construction.
    // _serialiseEnds uses spread so any field set here survives persistence.
    {
      const intervalByEndId = new Map();
      for (const iv of boundaryParam.intervals) {
        intervalByEndId.set(iv.endId, [iv.theta0, iv.theta1]);
      }
      for (const end of ends) {
        const iv = intervalByEndId.get(end.id);
        if (iv) {
          end.boundaryInterval = iv;
        } else {
          // Should not happen — every end produced above has a corresponding
          // interval. Log a warning so a misconfiguration is visible rather
          // than silently producing [0,0] in the feature vector.
          console.warn(
            `[PrimeEnds] end id=${end.id} has no boundaryInterval — ` +
            `anchorPixel=${end.anchorPixel}. Defaulting to [0, 0]. ` +
            `This indicates a mismatch between ends[] and boundaryParam.intervals.`
          );
          end.boundaryInterval = [0, 0];
        }
      }
    }

    // ── 6. Invariant checks ───────────────────────────────────────────────
    const invariantReport = this._checkInvariants(ends, nodeEndMap, topologyMap, G, w, h);

    const homologySummary = {
      b0:              G.componentCount,
      b1:              G.cycleCount,
      chi:             G.eulerChar,
      curvaturePeaks:  curvaturePeaks.length,
      endCount:        ends.length
    };

    return {
      ends,
      topologyMap,
      boundaryParam,
      homologySummary,
      diagnostics: { ...diagnostics, invariants: invariantReport }
    };
  }

  // ── Curvature peak detection ──────────────────────────────────────────
  _detectCurvaturePeaks(kH, w, G) {
    if (!kH) return [];
    const N       = G.nodeCount;
    const sigmaF  = this._flags.topoCurvPeakSigmaFactor ?? 2.0;

    // Compute mean and std of |kH| over narrow-band nodes only
    let sum = 0, sumSq = 0;
    for (let ni = 0; ni < N; ni++) {
      const v = Math.abs(kH[G.nodeToPixel(ni)]);
      sum += v; sumSq += v * v;
    }
    const mean = sum / N;
    const std  = Math.sqrt(Math.max(0, sumSq / N - mean * mean));
    const threshold = mean + sigmaF * std;

    // Local maxima of |kH| within narrow band (3×3 neighbourhood)
    const peaks   = [];
    const adjPtr  = G._adjPtr;
    const adjNode = G._adjNode;

    for (let ni = 0; ni < N; ni++) {
      const px  = G.nodeToPixel(ni);
      const val = Math.abs(kH[px]);
      if (val < threshold) continue;

      // Check all neighbours in graph — val must be local max
      let isMax = true;
      for (let ei = adjPtr[ni]; ei < adjPtr[ni + 1]; ei++) {
        if (Math.abs(kH[G.nodeToPixel(adjNode[ei])]) > val) { isMax = false; break; }
      }
      if (isMax) peaks.push(ni);
    }

    return peaks;
  }

  // ── Full-resolution topology map ──────────────────────────────────────
  // Maps every pixel (w×h) to an end ID.
  // Narrow-band pixels: from nodeEndMap.
  // Outside narrow band: -1.
  _buildTopologyMap(nodeEndMap, G, width, height) {
    const total = width * height;
    const topoMap = new Int32Array(total).fill(-1);
    const N       = G.nodeCount;

    for (let ni = 0; ni < N; ni++) {
      const px = G.nodeToPixel(ni);
      if (px >= 0 && px < total) {
        topoMap[px] = nodeEndMap[ni];
      }
    }

    return topoMap;
  }

  // ── Boundary parameterisation ─────────────────────────────────────────
  // Assign angular intervals [θ_start, θ_end] on [0, 2π) to each end.
  // Width ∝ 1 / mean_distance_to_anchor_pixel (smaller distance = finer interval).
  _buildBoundaryParam(ends, G, w) {
    if (ends.length === 0) {
      return { intervals: [], totalAngle: 0 };
    }

    // Compute weight for each end
    const weights = ends.map(end => {
      if (end.anchorPixel < 0) return 1.0;
      const ax = end.anchorPixel % w, ay = (end.anchorPixel / w) | 0;
      let sumDist = 0;
      for (const ni of end.pixelIndices) {
        const px = G.nodeToPixel(ni);
        const dx = px % w - ax, dy = (px / w | 0) - ay;
        sumDist += Math.sqrt(dx * dx + dy * dy);
      }
      const meanDist = sumDist / Math.max(end.pixelIndices.length, 1);
      return meanDist > 0 ? 1.0 / meanDist : 1.0;
    });

    const totalWeight = weights.reduce((s, v) => s + v, 0);
    const TWO_PI = 2 * Math.PI;

    const intervals = [];
    let theta = 0;
    for (let i = 0; i < ends.length; i++) {
      const span = (weights[i] / totalWeight) * TWO_PI;
      intervals.push({
        endId:  ends[i].id,
        theta0: theta,
        theta1: theta + span
      });
      theta += span;
    }

    return { intervals, totalAngle: theta };
  }

  // ── Invariant checking ─────────────────────────────────────────────────
  _checkInvariants(ends, nodeEndMap, topologyMap, G, width, height) {
    const N      = G.nodeCount;
    const report = { passed: true, issues: [] };

    const expectedPixels = width * height;
    if (topologyMap.length !== expectedPixels) {
      report.passed = false;
      report.issues.push(
        `topologyMap length mismatch: got ${topologyMap.length}, expected ${expectedPixels}`
      );
    }

    // 1. Angular interval sum ≈ 2π
    // (Only meaningful if ends.length > 0; boundaryParam computed separately)

    // 2. Unassigned narrow-band nodes
    let unassigned = 0;
    for (let i = 0; i < N; i++) if (nodeEndMap[i] < 0) unassigned++;
    const unassignedFrac = unassigned / Math.max(N, 1);
    if (unassignedFrac > 0.01) {
      report.passed = false;
      report.issues.push(
        `${(unassignedFrac * 100).toFixed(1)}% narrow-band nodes unassigned (>${1}% threshold)`
      );
    }

    // 3. Disjoint pixel support (spot-check: sample 1000 nodes)
    const assigned = new Int32Array(N).fill(-1);
    let overlapCount = 0;
    for (const end of ends) {
      for (let k = 0; k < end.pixelIndices.length; k += Math.max(1, (end.pixelIndices.length / 100) | 0)) {
        const n = end.pixelIndices[k];
        if (assigned[n] >= 0 && assigned[n] !== end.id) overlapCount++;
        assigned[n] = end.id;
      }
    }
    if (overlapCount > 0) {
      report.passed = false;
      report.issues.push(`Pixel overlap detected in ${overlapCount} sampled nodes`);
    }

    // 4. Chain monotone nestedness already enforced during construction
    // — report chain depths as diagnostic only
    report.maxChainDepth = ends.length > 0
      ? Math.max(...ends.map(e => e.chainDepth))
      : 0;
    report.unassignedFrac = unassignedFrac;

    return report;
  }
}

export default PrimeEnds;