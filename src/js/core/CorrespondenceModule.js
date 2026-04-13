// /src/js/core/CorrespondenceModule.js
//
// Stage 7 — Bilateral correspondence core computation.
//
// Establishes the I↔E↔L correspondence: for every narrow-band pixel
// observing the surface, finds the pixel that observes the mirror-image
// point on that surface under bilateral symmetry.
//
// The mirror is defined entirely in surface coordinates:
//   (r, θ) → (r, 2·θ_axis − θ)
//
// where θ_axis is the angular position of the bilateral symmetry axis
// in boundary-parameterisation space, derived from the principal eigenvector
// of the covariance of prime-end anchor pixel positions.
//
// No image data is needed — correspondence is purely geometric.
//
// Algorithm:
//   Phase 1 — Symmetry axis
//     Compute principal axis from anchor position covariance.
//     Derive θ_axis from the boundary interval of the anchor-nearest end.
//
//   Phase 2 — Per-end spatial index
//     For each prime-end, build a separate rBins × thetaBins grid containing
//     only pixels belonging to that end (from topologyMap).
//     Each bin stores one representative pixel index.
//     O(N) to build; O(1) per lookup within an end.
//
//     Using per-end indices rather than a global index prevents false matches
//     across end boundaries. For a mirrored coordinate (r_m, θ_m), only pixels
//     from the end whose interval contains θ_m are searched. If θ_m falls in
//     no end's interval, the pixel is marked unmatched immediately without any
//     search — this is the explicit cross-boundary unmatched check.
//
//   Phase 3 — Correspondence map
//     For each narrow-band pixel p with coordinates (r, θ):
//       Mirror: (r_m, θ_m) = (r, 2·θ_axis − θ), wrapped to [0, 2π)
//       Find target end: which end's [theta0, theta1] contains θ_m?
//       If none → mark unmatched immediately (cross-boundary case)
//       Otherwise: search target end's spatial index for nearest bin
//       Compute distance d in normalised surface coordinates
//       confidence[p] = exp(-d² / sigma²)
//       If d > 3σ: mark unmatched
//
//   Phase 4 — Mismatch scores
//     geometricAsymmetry     = mean normalised (r,θ) distance between matched pairs
//     reconstructionConsistency = fraction of matched pairs with same worldFrameId
//     symmetryMismatchScore  = alpha·geometricAsymmetry + beta·(1−reconstructionConsistency)
//
//   Phase 5 — Bilateral consistency map
//     bilateralConsistencyMap[p] = 1 if worldFrameMap[p] === worldFrameMap[mirror(p)]

const TWO_PI = 2 * Math.PI;
const SQRT2  = Math.SQRT2;

export class CorrespondenceModule {
  /**
   * @param {object}        inputs
   * @param {Float32Array}  inputs.warpField        — res²×2, (r,θ) per pixel (Stage 5)
   * @param {Int32Array}    inputs.worldFrameMap    — res², worldFrameId per pixel (Stage 5)
   * @param {Float32Array}  inputs.narrowBandMask   — res², >0 inside band (Stage 4B)
   * @param {Array}         inputs.ends             — PrimeEnd[] with anchorPixel +
   *                                                  boundaryInterval (Fixes 1A/1B)
   * @param {Int32Array}    inputs.topologyMap      — res², endId per pixel (Stage 4A)
   *                                                  Used to build per-end spatial index
   *                                                  and for explicit cross-boundary check.
   * @param {number}        inputs.legibilityScore  — scalar from Stage 5
   * @param {number}        inputs.resolution
   * @param {object}        [inputs.flags={}]
   */
  constructor(inputs) {
    const {
      warpField, worldFrameMap, narrowBandMask,
      ends, topologyMap, legibilityScore,
      resolution, flags = {}
    } = inputs;

    this._warpField       = warpField;
    this._worldFrameMap   = worldFrameMap;
    this._narrowBandMask  = narrowBandMask;
    this._ends            = ends ?? [];
    this._topologyMap     = topologyMap;   // Int32Array res² — endId per pixel
    this._legibilityScore = legibilityScore ?? 1.0;
    this._w               = resolution;
    this._flags           = flags;

    // Pre-build end interval lookup: endId → [theta0, theta1]
    // Used by _findEndForTheta for O(1) interval lookup.
    this._endIntervals = new Map();
    for (const end of this._ends) {
      const bi = end.boundaryInterval;
      if (bi) this._endIntervals.set(end.id, [bi[0], bi[1]]);
    }
  }

  // ── Public entry point ────────────────────────────────────────────────

  /**
   * compute()
   * @returns {{
   *   correspondenceMap:       Int32Array,
   *   confidenceMap:           Float32Array,
   *   bilateralConsistencyMap: Uint8Array,
   *   symmetryMismatchScore:   number,
   *   geometricAsymmetry:      number,
   *   reconstructionConsistency: number,
   *   symmetryAxisAngle:       number,
   *   thetaAxis:               number,
   *   degradedSymmetryAxis:    boolean,
   *   unmatchedFraction:       number,
   *   diagnostics:             object
   * }}
   */
  compute() {
    const w    = this._w;
    const N    = w * w;
    const mask = this._narrowBandMask;

    // ── Phase 1: Bilateral symmetry axis ─────────────────────────────────
    const {
      axisAngle, thetaAxis, degradedSymmetryAxis
    } = this._computeSymmetryAxis();

    // ── Phase 2: Per-end spatial index ────────────────────────────────────
    const rBins = this._flags.ambiRBins     ?? 64;
    const tBins = this._flags.ambiThetaBins ?? 128;
    // endIndices: Map<endId, Int32Array(rBins × tBins)>
    // Each Int32Array cell holds the pixel index of one representative
    // narrow-band pixel in that (r,θ) bin for the given end.
    const endIndices = this._buildPerEndSpatialIndex(N, rBins, tBins);

    // ── Phase 3: Correspondence map ───────────────────────────────────────
    const sigma      = this._flags.correspondenceConfidenceSigma ?? 0.1;
    const minConf    = this._flags.correspondenceMinConfidence   ?? 0.1;
    const sigma2     = sigma * sigma;
    const cutoffDist = 3 * sigma;

    const correspondenceMap = new Int32Array(N).fill(-1);
    const confidenceMap     = new Float32Array(N);

    let totalNarrow    = 0;
    let unmatchedCount = 0;
    let crossBoundary  = 0;   // pixels unmatched due to θ_m outside all intervals

    for (let i = 0; i < N; i++) {
      if (!mask[i]) continue;
      totalNarrow++;

      const r     = this._warpField[i * 2];
      const theta = this._warpField[i * 2 + 1];

      // Mirror in surface coordinates
      const thetaMirror = _wrapTheta(2 * thetaAxis - theta);

      // ── Explicit cross-boundary check ──────────────────────────────────
      // Find which end's interval contains thetaMirror.
      // If none → unmatched immediately, no search needed.
      const targetEndId = this._findEndForTheta(thetaMirror);

      if (targetEndId < 0) {
        correspondenceMap[i] = -1;
        confidenceMap[i]     = 0;
        unmatchedCount++;
        crossBoundary++;
        continue;
      }

      // ── Nearest-bin search within target end's index ──────────────────
      const targetIndex = endIndices.get(targetEndId);
      if (!targetIndex) {
        // End exists in intervals but has no pixels in spatial index
        // (shouldn't happen in well-formed input; treat as unmatched)
        correspondenceMap[i] = -1;
        confidenceMap[i]     = 0;
        unmatchedCount++;
        continue;
      }

      const { pixelIdx, dist } = this._lookupNearest(
        r, thetaMirror, rBins, tBins, targetIndex, cutoffDist
      );

      if (pixelIdx < 0 || dist > cutoffDist) {
        correspondenceMap[i] = -1;
        confidenceMap[i]     = 0;
        unmatchedCount++;
      } else {
        const conf = Math.exp(-dist * dist / sigma2);
        if (conf < minConf) {
          correspondenceMap[i] = -1;
          confidenceMap[i]     = 0;
          unmatchedCount++;
        } else {
          correspondenceMap[i] = pixelIdx;
          confidenceMap[i]     = conf;
        }
      }
    }

    // ── Phase 4: Mismatch scores ──────────────────────────────────────────
    let sumGeomErr = 0, matchedCount = 0, consistentCount = 0;

    for (let i = 0; i < N; i++) {
      if (!mask[i]) continue;
      const j = correspondenceMap[i];
      if (j < 0) continue;
      matchedCount++;

      // Geometric error: normalised (r,θ) distance
      // The ideal mirror of p at (r_i, θ_i) is (r_i, 2·θ_axis − θ_i).
      // p' is at (r_j, θ_j). The error is the distance from p' to the ideal.
      const r_i     = this._warpField[i * 2];
      const theta_i = this._warpField[i * 2 + 1];
      const r_j     = this._warpField[j * 2];
      const theta_j = this._warpField[j * 2 + 1];

      const idealThetaMirror = _wrapTheta(2 * thetaAxis - theta_i);
      const dr    = r_i - r_j;                                         // r should be preserved
      const dth   = _wrapThetaDiff(idealThetaMirror - theta_j);
      const dthN  = dth / TWO_PI;
      const geomErr = Math.sqrt(dr * dr + dthN * dthN) / SQRT2;       // normalise to [0,1]
      sumGeomErr += geomErr;

      // Reconstruction consistency
      const idI = this._worldFrameMap ? this._worldFrameMap[i] : -1;
      const idJ = this._worldFrameMap ? this._worldFrameMap[j] : -1;
      if (idI > 0 && idI === idJ) consistentCount++;
    }

    const geometricAsymmetry = matchedCount > 0
      ? Math.min(1, sumGeomErr / matchedCount)
      : 1;
    const reconstructionConsistency = matchedCount > 0
      ? consistentCount / matchedCount
      : 0;

    const alpha = this._flags.symmetryMismatchAlpha ?? 0.5;
    const beta  = this._flags.symmetryMismatchBeta  ?? 0.5;
    const symmetryMismatchScore =
      alpha * geometricAsymmetry + beta * (1 - reconstructionConsistency);

    // ── Phase 5: Bilateral consistency map ───────────────────────────────
    const bilateralConsistencyMap = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (!mask[i]) continue;
      const j = correspondenceMap[i];
      if (j < 0) { bilateralConsistencyMap[i] = 0; continue; }
      const idI = this._worldFrameMap ? this._worldFrameMap[i] : -1;
      const idJ = this._worldFrameMap ? this._worldFrameMap[j] : -1;
      bilateralConsistencyMap[i] = (idI > 0 && idI === idJ) ? 1 : 0;
    }

    const unmatchedFraction = totalNarrow > 0 ? unmatchedCount / totalNarrow : 1;

    return {
      correspondenceMap,
      confidenceMap,
      bilateralConsistencyMap,
      symmetryMismatchScore: Math.max(0, Math.min(1, symmetryMismatchScore)),
      geometricAsymmetry,
      reconstructionConsistency,
      symmetryAxisAngle: axisAngle,
      thetaAxis,
      degradedSymmetryAxis,
      unmatchedFraction,
      diagnostics: {
        matchedPixels:          matchedCount,
        unmatchedPixels:        unmatchedCount,
        crossBoundaryPixels:    crossBoundary,
        totalNarrowBand:        totalNarrow,
        meanGeometricError:     matchedCount > 0 ? sumGeomErr / matchedCount : 0,
        meanConfidence:         _meanOver(confidenceMap, mask, N),
        symmetryAxisAngle:      axisAngle,
        thetaAxis,
        degradedSymmetryAxis,
        unreliableScore:        unmatchedFraction > 0.3
      }
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Phase 1: Symmetry axis
  // ─────────────────────────────────────────────────────────────────────

  _computeSymmetryAxis() {
    const w        = this._w;
    const ends     = this._ends;
    const fallback = this._flags.symmetryAxisFallbackVertical !== false;

    // Collect anchor positions for ends with valid anchorPixel
    const anchors = ends
      .filter(e => e.anchorPixel >= 0)
      .map(e => ({
        x:   e.anchorPixel % w,
        y:   (e.anchorPixel / w) | 0,
        end: e
      }));

    if (anchors.length < 2) {
      return {
        axisAngle: fallback ? Math.PI / 2 : 0,
        thetaAxis: this._fallbackThetaAxis(),
        degradedSymmetryAxis: true
      };
    }

    // Centroid
    let cx = 0, cy = 0;
    for (const a of anchors) { cx += a.x; cy += a.y; }
    cx /= anchors.length;
    cy /= anchors.length;

    // Covariance
    let Cxx = 0, Cyy = 0, Cxy = 0;
    for (const a of anchors) {
      const dx = a.x - cx, dy = a.y - cy;
      Cxx += dx * dx; Cyy += dy * dy; Cxy += dx * dy;
    }
    Cxx /= anchors.length;
    Cyy /= anchors.length;
    Cxy /= anchors.length;

    // Eigendecomposition
    const trace = Cxx + Cyy;
    const disc  = Math.sqrt(Math.max(0, (Cxx - Cyy) ** 2 / 4 + Cxy * Cxy));

    if (disc < 1e-6) {
      return {
        axisAngle: fallback ? Math.PI / 2 : 0,
        thetaAxis: this._fallbackThetaAxis(),
        degradedSymmetryAxis: true
      };
    }

    const lambda1   = trace / 2 + disc;
    const axisAngle = Math.atan2(lambda1 - Cxx, Cxy);

    // θ_axis: midpoint of the interval of the end nearest to centroid
    let bestEnd = null, bestDist2 = Infinity;
    for (const a of anchors) {
      const d2 = (a.x - cx) ** 2 + (a.y - cy) ** 2;
      if (d2 < bestDist2) { bestDist2 = d2; bestEnd = a.end; }
    }
    const bi       = bestEnd?.boundaryInterval ?? [0, Math.PI];
    const thetaAxis = (bi[0] + bi[1]) / 2;

    return { axisAngle, thetaAxis, degradedSymmetryAxis: false };
  }

  _fallbackThetaAxis() {
    if (this._ends.length > 0) {
      const bi = this._ends[0].boundaryInterval ?? [0, TWO_PI];
      return (bi[0] + bi[1]) / 2;
    }
    return Math.PI;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Phase 2: Per-end spatial index
  // ─────────────────────────────────────────────────────────────────────

  /**
   * _buildPerEndSpatialIndex
   *
   * Returns Map<endId, Int32Array(rBins × tBins)>.
   * Each entry is a spatial index containing only pixels that belong
   * to that end according to topologyMap.
   *
   * Pixels in the outer class (endId=0) and outside the band (endId=-1)
   * are excluded — they have no defined boundary interval and cannot be
   * valid correspondence targets.
   *
   * When topologyMap is null (degraded mode), falls back to a single
   * global index under the key -2 (sentinel for "all pixels").
   */
  _buildPerEndSpatialIndex(N, rBins, tBins) {
    const endIndices = new Map();
    const mask       = this._narrowBandMask;
    const wf         = this._warpField;
    const topoMap    = this._topologyMap;

    for (let i = 0; i < N; i++) {
      if (!mask[i]) continue;

      const endId = topoMap ? topoMap[i] : -2;   // -2 = global fallback key

      // Skip outer class (0) and outside-band (-1)
      // They have no boundary interval and cannot be correspondence targets
      if (topoMap && endId <= 0) continue;

      if (!endIndices.has(endId)) {
        endIndices.set(endId, new Int32Array(rBins * tBins).fill(-1));
      }

      const r     = wf[i * 2];
      const theta = wf[i * 2 + 1];
      const rBin  = _quantiseR(r, rBins);
      const tBin  = _quantiseTheta(theta, tBins);
      const cell  = rBin * tBins + tBin;

      const idx = endIndices.get(endId);
      if (idx[cell] < 0) idx[cell] = i;   // first occupant wins
    }

    return endIndices;
  }

  // ─────────────────────────────────────────────────────────────────────
  // _findEndForTheta — explicit cross-boundary check
  // ─────────────────────────────────────────────────────────────────────

  /**
   * _findEndForTheta
   *
   * Returns the endId whose boundary interval [theta0, theta1] contains
   * the given theta value. Returns -1 if theta falls in no interval —
   * this is the cross-boundary unmatched case.
   *
   * When topologyMap is absent (degraded), returns -2 (global fallback).
   *
   * Intervals are assumed to be non-overlapping and to partition [0, 2π).
   * A small epsilon tolerance handles floating-point boundary cases.
   */
  _findEndForTheta(theta) {
    if (!this._topologyMap) return -2;   // degraded: use global fallback

    const eps = 1e-6;
    for (const [endId, interval] of this._endIntervals) {
      if (endId <= 0) continue;
      const [t0, t1] = interval;
      if (theta >= t0 - eps && theta <= t1 + eps) return endId;
    }
    return -1;   // cross-boundary: θ_m falls in no end's interval
  }

  // ─────────────────────────────────────────────────────────────────────
  // Phase 3: Nearest-bin lookup within a single end's index
  // ─────────────────────────────────────────────────────────────────────

  /**
   * _lookupNearest
   *
   * Expanding Chebyshev-radius search within a single end's spatial index.
   * Only pixels belonging to the target end are considered, enforcing
   * end-boundary correspondence constraints.
   *
   * Normalised distance metric (consistent with KEM formula):
   *   d = sqrt((r_p − r_m)² + ((θ_p − θ_m) / 2π)²)
   */
  _lookupNearest(rTarget, thetaTarget, rBins, tBins, endIndex, cutoffDist) {
    const rBin = _quantiseR(rTarget, rBins);
    const tBin = _quantiseTheta(thetaTarget, tBins);

    const rScale    = 1.0 / rBins;
    const tScale    = 1.0 / tBins;
    const maxRadius = Math.ceil(cutoffDist / Math.min(rScale, tScale)) + 2;

    let bestPixel = -1;
    let bestDist  = Infinity;
    const wf      = this._warpField;

    for (let radius = 0; radius <= maxRadius; radius++) {
      // Early exit if minimum possible next-ring distance exceeds best found
      if (radius > 0 && bestPixel >= 0) {
        const minNext = Math.sqrt(
          ((radius - 1) * rScale) ** 2 + ((radius - 1) * tScale) ** 2
        );
        if (minNext > bestDist) break;
      }
      if (radius > 0) {
        const minThis = Math.sqrt(
          ((radius - 1) * rScale) ** 2 + ((radius - 1) * tScale) ** 2
        );
        if (minThis > cutoffDist && bestPixel < 0) break;
      }

      // Walk perimeter of Chebyshev square at this radius
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dt = -radius; dt <= radius; dt++) {
          if (Math.abs(dr) !== radius && Math.abs(dt) !== radius) continue;

          const nr = rBin + dr;
          const nt = ((tBin + dt) % tBins + tBins) % tBins;
          if (nr < 0 || nr >= rBins) continue;

          const cell = nr * tBins + nt;
          const pIdx = endIndex[cell];
          if (pIdx < 0) continue;

          const r_p     = wf[pIdx * 2];
          const theta_p = wf[pIdx * 2 + 1];
          const dR      = r_p - rTarget;
          const dTh     = _wrapThetaDiff(theta_p - thetaTarget);
          const dThN    = dTh / TWO_PI;
          const d       = Math.sqrt(dR * dR + dThN * dThN);

          if (d < bestDist) {
            bestDist  = d;
            bestPixel = pIdx;
          }
        }
      }
    }

    return { pixelIdx: bestPixel, dist: bestDist };
  }
}

// ── Module utilities ──────────────────────────────────────────────────────

function _quantiseR(r, rBins) {
  return Math.max(0, Math.min(rBins - 1, Math.floor(r * rBins)));
}

function _quantiseTheta(theta, tBins) {
  let t = theta % TWO_PI;
  if (t < 0) t += TWO_PI;
  return Math.max(0, Math.min(tBins - 1, Math.floor(t / TWO_PI * tBins)));
}

function _wrapTheta(theta) {
  let t = theta % TWO_PI;
  if (t < 0) t += TWO_PI;
  return t;
}

function _wrapThetaDiff(dtheta) {
  let d = dtheta % TWO_PI;
  if (d > Math.PI)  d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return d;
}

function _meanOver(arr, mask, N) {
  let sum = 0, count = 0;
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    sum += arr[i]; count++;
  }
  return count > 0 ? sum / count : 0;
}

export default CorrespondenceModule;