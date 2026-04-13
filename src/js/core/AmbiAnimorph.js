// /src/js/core/AmbiAnamorph.js
//
// Stage 5 — AmbiAnamorph orchestrator.
//
// Coordinates the four Stage 5 sub-modules in sequence:
//   1. SurfaceParam   — (r, θ) warp field via arc-length seeding + BFS
//   2. WorldFrameId   — discrete surface element identities + session lock
//   3. Integration weights — four-source per-pixel confidence map
//   4. ViewManifold   — feature vector construction + graph update
//
// AmbiAnamorph owns no novel mathematics. It receives all loaded artifacts
// from ambi.worker, delegates computation to sub-modules, and assembles the
// unified result that ambi.worker persists and broadcasts.
//
// One instance per AMBI_ANALYZE call. sessionState and manifold are owned
// by ambi.worker, live across calls, and are passed in by reference.

import { buildWarpField }      from './SurfaceParam.js';
import { assignWorldFrameIds } from './WorldFrameId.js';
import {
  buildFeatureVector,
  updateViewManifold
}                              from './ViewManifold.js';

export class AmbiAnamorph {
  /**
   * @param {object}        inputs
   *
   * Geometry (Stage 4B + Stage 3):
   * @param {Float32Array}  inputs.phiMin              — res², refined SDF
   * @param {object}        inputs.zeroCurve           — { loops:[{points}] }
   * @param {Float32Array}  inputs.principalFrame      — res²×4, e1/e2 per pixel
   * @param {Float32Array}  inputs.narrowBandMask      — res²
   * @param {Float32Array}  inputs.curvatureField      — res², kH
   * @param {object}        inputs.minimizerDiagnostics — { maxAreaErr, finalBandWidth }
   *
   * Topology (Stage 4A):
   * @param {Array}         inputs.ends                — PrimeEnd[] with multiplicity
   *                                                     and boundaryInterval (Fixes 1A/1B)
   * @param {Int32Array}    inputs.topologyMap         — res², endId per pixel
   * @param {Int32Array}    inputs.componentMap        — res², null in degraded mode
   * @param {Array}         inputs.lipschitzEnds       — LQE ends with motionStats
   * @param {object}        inputs.motionMaps          — { motionMagnitude, saliencyMap }
   * @param {number}        inputs.b0
   * @param {number}        inputs.b1
   *
   * Illumination (Stage 1):
   * @param {object}        inputs.directnessField     — { fMap: Float32Array }
   * @param {object}        inputs.penumbraField       — { edgeMask: Float32Array }
   *
   * Temporal (Stage 3 directional field):
   * @param {Float32Array}  inputs.coherencePerPixel   — res², may be null
   *
   * Session + manifold state (owned by ambi.worker, mutated in place):
   * @param {object}        inputs.sessionState
   * @param {object}        inputs.manifold            — ViewManifold object
   *
   * @param {number}        inputs.resolution
   * @param {object}        [inputs.flags={}]
   */
  constructor(inputs) {
    const {
      phiMin, zeroCurve, principalFrame, narrowBandMask,
      curvatureField, minimizerDiagnostics,
      ends, topologyMap, componentMap, lipschitzEnds, motionMaps,
      b0, b1,
      directnessField, penumbraField, coherencePerPixel,
      sessionState, manifold,
      resolution, flags = {}
    } = inputs;

    this._phiMin               = phiMin;
    this._zeroCurve            = zeroCurve;
    this._principalFrame       = principalFrame;
    this._narrowBandMask       = narrowBandMask;
    this._curvatureField       = curvatureField;
    this._minimizerDiagnostics = minimizerDiagnostics ?? { maxAreaErr: 0, finalBandWidth: 6 };
    this._ends                 = ends;
    this._topologyMap          = topologyMap;
    this._componentMap         = componentMap;
    this._lipschitzEnds        = lipschitzEnds ?? [];
    this._motionMaps           = motionMaps;
    this._b0                   = b0 ?? 1;
    this._b1                   = b1 ?? 0;
    this._directnessField      = directnessField;
    this._penumbraField        = penumbraField;
    this._coherencePerPixel    = coherencePerPixel;
    this._sessionState         = sessionState;
    this._manifold             = manifold;
    this._resolution           = resolution;
    this._flags                = flags;
  }

  // ── Public entry point ────────────────────────────────────────────────

  /**
   * compute()
   *
   * Runs all Stage 5 phases in sequence and returns a unified result.
   * Mutates sessionState and manifold in place.
   *
   * @returns {object} — see return block at end of method
   */
  compute() {
    const startMs = Date.now();
    const flags   = this._flags;
    const w       = this._resolution;
    const N       = w * w;
    let   degradedMode = !this._componentMap;

    // ── Phase 1: Warp field ─────────────────────────────────────────────
    const spResult = buildWarpField({
      phiMin:         this._phiMin,
      ends:           this._ends,
      topologyMap:    this._topologyMap,
      zeroCurve:      this._zeroCurve,
      principalFrame: this._principalFrame,
      narrowBandMask: this._narrowBandMask,
      resolution:     w,
      flags
    });

    const { warpField, branchLocations, paramResolution } = spResult;

    // Flag degraded if BFS covered none of the narrow band
    if (spResult.diagnostics.seededPixels === 0 &&
        spResult.diagnostics.bfsFallback > 0) {
      degradedMode = true;
      console.warn('[AmbiAnamorph] Zero BFS seeds — zero_curve may be absent or empty');
    }

    // ── Phase 2: WorldFrameId assignment ──────────────────────────────────
    const wfResult = assignWorldFrameIds({
      warpField,
      componentMap:    this._componentMap,
      topologyMap:     this._topologyMap,
      narrowBandMask:  this._narrowBandMask,
      ends:            this._ends,
      lipschitzEnds:   this._lipschitzEnds,
      b0:              this._b0,
      b1:              this._b1,
      resolution:      w,
      sessionState:    this._sessionState,
      flags
    });

    const { worldFrameMap, structureId, isKeyframe } = wfResult;
    degradedMode = degradedMode || wfResult.degradedMode;

    // ── Phase 3: Integration weight map ───────────────────────────────────
    const integrationWeights = this._computeIntegrationWeights(N, w);

    // ── Phase 4: Dominant flow direction (global) ─────────────────────────
    const dominantFlowDirection = this._computeDominantFlowDirection();

    // ── Phase 5: Legibility score ─────────────────────────────────────────
    const legibilityScore = this._computeLegibilityScore(
      integrationWeights, N, degradedMode
    );

    // ── Phase 6: Feature vector inputs ────────────────────────────────────
    const fvInputs = this._computeFeatureVectorInputs(N, dominantFlowDirection);

    // ── Phase 7: View manifold update ─────────────────────────────────────
    const cameraId = flags.cameraId ?? 'default';

    const featureVector = buildFeatureVector({
      b0:                   this._b0,
      b1:                   this._b1,
      endCount:             this._ends.length,
      ends:                 this._ends,
      meanFMap:             fvInputs.meanFMap,
      penumbraFraction:     fvInputs.penumbraFraction,
      lqeEndCount:          this._lipschitzEnds.length,
      meanMotionMagnitude:  fvInputs.meanMotionMagnitude,
      meanLQESpeed:         fvInputs.meanLQESpeed,
      dominantFlowDirection,
      meanKH:               fvInputs.meanKH,
      curvaturePeakCount:   fvInputs.curvaturePeakCount
    });

    const manifoldResult = updateViewManifold({
      manifold:           this._manifold,
      cameraId,
      featureVector,
      structureId,
      legibilityScore,
      compatibilityThresh: flags.viewManifoldCompatibilityThresh ?? 0.85
    });

    // ── Surface param metadata ────────────────────────────────────────────
    const surfaceParamMeta = {
      anchorPoints:       this._ends.map(e => ({
                            endId:       e.id,
                            anchorPixel: e.anchorPixel ?? -1
                          })),
      branchLocations,
      componentCount:     this._b0,
      paramResolution,
      topologyConsistent: !degradedMode
    };

    // ── Debug telemetry ───────────────────────────────────────────────────
    let telemetry = null;
    if (flags.ambiDebug) {
      telemetry = this._buildTelemetry(integrationWeights, N, spResult, wfResult, fvInputs);
    }

    // ── Diagnostics ───────────────────────────────────────────────────────
    const diagnostics = {
      surfaceParam:  spResult.diagnostics,
      worldFrameId:  wfResult.diagnostics,
      integration:   this._integrationDiagnostics(integrationWeights, N),
      featureVector: fvInputs,
      processingMs:  Date.now() - startMs
    };

    return {
      // Geometry output
      warpField,
      branchLocations,
      paramResolution,

      // Identity output
      worldFrameMap,
      structureId,
      isKeyframe,

      // Weight and legibility
      integrationWeights,
      legibilityScore,

      // Manifold placement
      viewManifold: {
        componentId:        manifoldResult.componentId,
        positionInManifold: manifoldResult.positionInManifold
      },

      // State
      degradedMode,

      // Metadata for persistence
      surfaceParamMeta,

      // Diagnostics and telemetry
      diagnostics,
      telemetry
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Phase 3: Integration weight map
  // ─────────────────────────────────────────────────────────────────────

  /**
   * _computeIntegrationWeights
   *
   * Combines four evidence sources into a per-pixel weight map:
   *   w(x,y) = coherence^α · fMap^β · geomConf^γ · topoStab^δ
   *
   * Sources:
   *   coherence  — temporal stability from DirectionalLifting
   *   fMap       — illumination directness from Stage 1
   *   geomConf   — geometric confidence from minimizer convergence,
   *                spatially varying by |phi| proximity to zero curve
   *   topoStab   — topological stability from prime-end persistenceScore
   */
  _computeIntegrationWeights(N, w) {
    const flags    = this._flags;
    const alpha    = flags.ambiCoherenceExponent  ?? 0.4;
    const beta     = flags.ambiFMapExponent       ?? 0.3;
    const gamma    = flags.ambiGeomConfExponent   ?? 0.2;
    const delta    = flags.ambiTopoStabExponent   ?? 0.1;

    const mask     = this._narrowBandMask;
    const phi      = this._phiMin;
    const topoMap  = this._topologyMap;

    // ── Coherence field ────────────────────────────────────────────────
    // Defensive access: liftResult.coherence may be { perPixel } or
    // a direct Float32Array (see Issue 4 in pre-implementation checklist)
    const coherence = this._coherencePerPixel;

    // ── fMap field ─────────────────────────────────────────────────────
    const fMap = this._directnessField?.fMap ?? null;

    // ── geomConf: spatially varying from phi and minimizer diagnostics ──
    const maxAreaErr    = Math.max(0, Math.min(1, this._minimizerDiagnostics.maxAreaErr ?? 0));
    const finalBandWidth = Math.max(1, this._minimizerDiagnostics.finalBandWidth ?? 6);
    const baseConf      = Math.max(0, 1 - maxAreaErr);

    // ── topoStab: persistenceScore per end, mapped via topologyMap ──────
    // Build endId → persistenceScore lookup
    const persScore = new Map();
    for (const end of this._ends) {
      persScore.set(end.id, end.persistenceScore ?? 1.0);
    }

    // ── Assemble weight map ────────────────────────────────────────────
    const weights = new Float32Array(N);

    for (let i = 0; i < N; i++) {
      if (!mask[i]) { weights[i] = 0; continue; }

      // coherence: [0,1], default 0.5 if absent
      const coh = coherence
        ? Math.max(0, Math.min(1, coherence[i]))
        : 0.5;

      // fMap: [0,1], default 0.5 if absent
      const fm = fMap
        ? Math.max(0, Math.min(1, fMap[i]))
        : 0.5;

      // geomConf: spatially varying
      const normDist  = Math.min(1, Math.abs(phi[i]) * w / finalBandWidth);
      const geomConf  = baseConf * (1 - normDist * 0.5);

      // topoStab: from end's persistenceScore; outer class gets 0.1
      const endId    = topoMap[i];
      const topoStab = endId > 0 ? (persScore.get(endId) ?? 1.0) : 0.1;

      weights[i] =
        Math.pow(Math.max(1e-8, coh),      alpha) *
        Math.pow(Math.max(1e-8, fm),       beta)  *
        Math.pow(Math.max(1e-8, geomConf), gamma) *
        Math.pow(Math.max(1e-8, topoStab), delta);
    }

    return weights;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Phase 4: Dominant flow direction
  // ─────────────────────────────────────────────────────────────────────

  /**
   * _computeDominantFlowDirection
   *
   * Speed-weighted circular mean of per-end dominantDirection values.
   * dominantDirection is pre-computed by LipschitzQuaternionEnds using
   * the correctly-mapped pixel support (via G.nodeToPixel). No flowU/flowV
   * needed here.
   *
   * @returns {number} radians ∈ [−π, π]
   */
  _computeDominantFlowDirection() {
    let sinSum = 0, cosSum = 0;

    for (const end of this._lipschitzEnds) {
      const speed = end.motionStats?.meanSpeed ?? 0;
      const dir   = end.motionStats?.dominantDirection ?? 0;
      if (speed < 1e-8) continue;
      sinSum += speed * Math.sin(dir);
      cosSum += speed * Math.cos(dir);
    }

    // If all ends are stationary, return 0 (arbitrary but consistent)
    if (sinSum === 0 && cosSum === 0) return 0;
    return Math.atan2(sinSum, cosSum);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Phase 5: Legibility score
  // ─────────────────────────────────────────────────────────────────────

  /**
   * _computeLegibilityScore
   *
   * Scalar ∈ [0,1] summarising frame observability.
   *
   *   legibility = meanWeight × coverageFraction × degradedPenalty
   *
   * meanWeight:       mean integration weight over narrow-band pixels
   * coverageFraction: fraction of narrow-band pixels with weight > threshold
   * degradedPenalty:  0.5 if degradedMode, 1.0 otherwise
   *
   * A frame can have high mean weight but low coverage (a few bright pixels
   * surrounded by weak ones) — both factors are needed.
   */
  _computeLegibilityScore(weights, N, degradedMode) {
    const flags     = this._flags;
    const mask      = this._narrowBandMask;
    const threshold = flags.ambiLegibilityWeightThresh ?? 0.1;

    let sum = 0, bandCount = 0, aboveThresh = 0;

    for (let i = 0; i < N; i++) {
      if (!mask[i]) continue;
      bandCount++;
      sum += weights[i];
      if (weights[i] > threshold) aboveThresh++;
    }

    if (bandCount === 0) return 0;

    const meanWeight       = sum / bandCount;
    const coverageFraction = aboveThresh / bandCount;
    const degradedPenalty  = degradedMode ? 0.5 : 1.0;

    return Math.max(0, Math.min(1,
      meanWeight * coverageFraction * degradedPenalty
    ));
  }

  // ─────────────────────────────────────────────────────────────────────
  // Phase 6: Feature vector inputs
  // ─────────────────────────────────────────────────────────────────────

  /**
   * _computeFeatureVectorInputs
   *
   * O(N) scan over already-loaded arrays to compute aggregate statistics
   * needed by buildFeatureVector. No additional artifact loading.
   */
  _computeFeatureVectorInputs(N, dominantFlowDirection) {
    const mask    = this._narrowBandMask;
    const kH      = this._curvatureField;
    const fMapArr = this._directnessField?.fMap ?? null;
    const edgeMask = this._penumbraField?.edgeMask ?? null;
    const motMag  = this._motionMaps?.motionMagnitude ?? null;

    let sumFMap = 0, sumMotMag = 0, sumKH = 0;
    let bandCount = 0, penumbraCount = 0;
    let kHSum = 0, kHSumSq = 0;

    for (let i = 0; i < N; i++) {
      if (!mask[i]) continue;
      bandCount++;

      sumFMap   += fMapArr  ? Math.max(0, Math.min(1, fMapArr[i]))  : 0.5;
      sumMotMag += motMag   ? motMag[i]                             : 0;
      sumKH     += kH       ? Math.abs(kH[i])                       : 0;

      if (edgeMask && edgeMask[i] > 0) penumbraCount++;

      if (kH) {
        const v = Math.abs(kH[i]);
        kHSum   += v;
        kHSumSq += v * v;
      }
    }

    const n = Math.max(1, bandCount);
    const meanFMap            = sumFMap   / n;
    const meanMotionMagnitude = sumMotMag / n;
    const meanKH              = sumKH     / n;
    const penumbraFraction    = penumbraCount / n;

    // curvaturePeakCount: pixels where |kH| > mean + 2σ
    let curvaturePeakCount = 0;
    if (kH && bandCount > 0) {
      const kHMean = kHSum / n;
      const kHVar  = Math.max(0, kHSumSq / n - kHMean * kHMean);
      const kHStd  = Math.sqrt(kHVar);
      const thresh = kHMean + 2 * kHStd;
      for (let i = 0; i < N; i++) {
        if (mask[i] && Math.abs(kH[i]) > thresh) curvaturePeakCount++;
      }
    }

    // meanLQESpeed: mean of trimmed-mean speeds across LQE ends
    let lqeSpeedSum = 0;
    for (const end of this._lipschitzEnds) {
      lqeSpeedSum += end.motionStats?.meanSpeed ?? 0;
    }
    const meanLQESpeed = this._lipschitzEnds.length > 0
      ? lqeSpeedSum / this._lipschitzEnds.length
      : 0;

    return {
      meanFMap,
      penumbraFraction,
      meanMotionMagnitude,
      meanLQESpeed,
      dominantFlowDirection,
      meanKH,
      curvaturePeakCount
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Diagnostics helpers
  // ─────────────────────────────────────────────────────────────────────

  _integrationDiagnostics(weights, N) {
    const mask = this._narrowBandMask;
    let min = Infinity, max = -Infinity, sum = 0, count = 0;

    for (let i = 0; i < N; i++) {
      if (!mask[i]) continue;
      const w = weights[i];
      if (w < min) min = w;
      if (w > max) max = w;
      sum += w;
      count++;
    }

    return {
      min:   count > 0 ? min   : 0,
      max:   count > 0 ? max   : 0,
      mean:  count > 0 ? sum / count : 0,
      count
    };
  }

  _buildTelemetry(weights, N, spResult, wfResult, fvInputs) {
    // Weight histogram: 10 equal bins over [0,1]
    const bins = new Int32Array(10);
    const mask = this._narrowBandMask;
    for (let i = 0; i < N; i++) {
      if (!mask[i]) continue;
      const bin = Math.min(9, Math.floor(weights[i] * 10));
      bins[bin]++;
    }

    return {
      weightHistogram:  Array.from(bins),
      phiRange:         spResult.diagnostics.phiRange,
      warpFieldStats: {
        seededPixels:   spResult.diagnostics.seededPixels,
        bfsFallback:    spResult.diagnostics.bfsFallback,
        seamPixels:     spResult.diagnostics.seamPixels
      },
      worldFrameIdStats: {
        inheritedPixels: wfResult.diagnostics.inheritedPixels ?? 0,
        fallbackPixels:  wfResult.diagnostics.fallbackPixels  ?? 0,
        isKeyframe:      wfResult.isKeyframe
      },
      featureVectorInputs: fvInputs
    };
  }
}

export default AmbiAnamorph;