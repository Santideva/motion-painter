// /src/js/core/WorldFrameId.js
//
// Stage 5 — AmbiAnamorph sub-module.
//
// Assigns stable integer worldFrameId labels to every narrow-band pixel,
// converting the continuous (r, θ) surface coordinates from SurfaceParam
// into discrete, persistent identities that remain consistent across frames.
//
// Two exported functions:
//
//   computeStructureId(b0, b1, ends)
//     Pure integer hash of the topological fingerprint. No floating-point.
//     Stable across sessions, cameras, and distances.
//
//   assignWorldFrameIds(params)
//     Keyframe path: hash(quantised r, quantised θ, componentLabel, endId).
//     Subsequent frames: LQE-guided backward-warp → inherit keyframe ID,
//     with direct-hash fallback for untracked pixels.
//     Session lock prevents spurious structureId changes from transient
//     topological instability.
//
// Displacement direction source:
//   end.motionStats.dominantDirection (radians) — computed by
//   LipschitzQuaternionEnds._attachMotionDescriptors as a weighted circular
//   mean of atan2(flowV, flowU) over the end's pixel support.
//   flowU/flowV are NOT passed into this module — dominantDirection is the
//   correct pre-computed value at the right granularity.
//
// Session state (owned by ambi.worker, passed by reference, mutated here):
//   {
//     structureId:           string | null,
//     inconsistentCount:     number,
//     keyframeWorldFrameMap: Int32Array | null,
//     frameCount:            number
//   }

import { hashFNV1a } from './hashFNV1a.js';

// ── Constants ─────────────────────────────────────────────────────────────
const TWO_PI = 2 * Math.PI;

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Quantise r ∈ [0,1] to an integer bin index.
 */
function quantiseR(r, rBins) {
  return Math.max(0, Math.min(rBins - 1, Math.floor(r * rBins)));
}

/**
 * Quantise θ (any value) to an integer bin index.
 * θ is wrapped to [0, 2π) before binning.
 */
function quantiseTheta(theta, thetaBins) {
  let t = theta % TWO_PI;
  if (t < 0) t += TWO_PI;
  return Math.max(0, Math.min(thetaBins - 1, Math.floor(t / TWO_PI * thetaBins)));
}

/**
 * Compute a single worldFrameId from quantised surface coordinates.
 * Includes componentLabel and endId to prevent cross-region collisions
 * between pixels with coincidentally matching (rQ, θQ).
 * Returns a non-zero unsigned 32-bit integer (0 is reserved for background).
 */
function pixelHash(rQ, thetaQ, componentLabel, endId) {
  const str  = `r:${rQ}|t:${thetaQ}|c:${componentLabel}|e:${endId}`;
  const hash = parseInt(hashFNV1a(str), 16) >>> 0;
  return hash === 0 ? 1 : hash;
}

// ─────────────────────────────────────────────────────────────────────────
// computeStructureId
// ─────────────────────────────────────────────────────────────────────────

/**
 * computeStructureId
 *
 * Hashes the discrete topological fingerprint of the scene into a stable
 * 8-character hex identifier.
 *
 * Uses only integer values — b0, b1, endCount, and sorted multiplicities —
 * so the result is identical across sessions, cameras, and distances.
 * No quantisation decisions, no floating-point values.
 *
 * @param {number} b0    — connected component count (from Stage 4A)
 * @param {number} b1    — independent cycle count
 * @param {Array}  ends  — PrimeEnd[] with multiplicity field (from Fix 1A)
 * @returns {string}       8-character hex structureId
 */
export function computeStructureId(b0, b1, ends) {
  // Sort multiplicities for order-independence — hash must not depend on
  // which end happens to be listed first in the array.
  const multiplicities = ends
    .map(e => e.multiplicity ?? 1)
    .sort((a, b) => a - b);

  const canonical =
    `b0:${b0 | 0}|b1:${b1 | 0}|n:${ends.length}|m:${multiplicities.join(',')}`;

  return hashFNV1a(canonical);
}

// ─────────────────────────────────────────────────────────────────────────
// LQE displacement field
// ─────────────────────────────────────────────────────────────────────────

/**
 * _buildDisplacementField
 *
 * Builds a per-pixel (dx, dy) displacement field from LQE end motion stats.
 * Each narrow-band pixel is assigned to the nearest LQE end centroid and
 * inherits that end's displacement vector.
 *
 * Displacement direction comes exclusively from
 * end.motionStats.dominantDirection (radians), which LipschitzQuaternionEnds
 * computes as a weighted circular mean of atan2(flowV, flowU) over the end's
 * correctly-mapped pixel support. flowU/flowV are not passed here — the
 * pre-computed dominantDirection is the correct granularity.
 *
 * If motionStats is absent (should not occur after LQE fix), zero
 * displacement is used as a safe fallback.
 *
 * @param {Array}         lipschitzEnds  — LQE end array with motionStats
 * @param {Float32Array}  narrowBandMask — res²
 * @param {number}        w              — resolution
 * @param {number}        frameRate      — fps for speed→pixel conversion
 * @returns {Float32Array} res²×2 — (dx, dy) per pixel; [0,0] outside band
 */
function _buildDisplacementField(lipschitzEnds, narrowBandMask, w, frameRate) {
  const N   = w * w;
  const dxy = new Float32Array(N * 2);   // default: all zeros

  if (!lipschitzEnds || lipschitzEnds.length === 0) return dxy;

  // Compute per-end displacement vectors from dominantDirection + meanSpeed
  const endDisp = [];   // [{ cx, cy, dx, dy }]

  for (const end of lipschitzEnds) {
    const ap    = end.anchorPixel ?? -1;
    const cx    = ap >= 0 ? ap % w        : w * 0.5;
    const cy    = ap >= 0 ? (ap / w) | 0  : w * 0.5;
    const speed = end.motionStats?.meanSpeed ?? 0;

    let dx = 0, dy = 0;

    if (speed >= 1e-8 && typeof end.motionStats?.dominantDirection === 'number') {
      // Convert speed (pixels/frame at frameRate) to pixel displacement
      const dir = end.motionStats.dominantDirection;
      dx = speed * Math.cos(dir) / Math.max(frameRate, 1);
      dy = speed * Math.sin(dir) / Math.max(frameRate, 1);
    }
    // Else: stationary end or motionStats absent — zero displacement

    endDisp.push({ cx, cy, dx, dy });
  }

  if (endDisp.length === 0) return dxy;

  // Assign each narrow-band pixel to its nearest LQE end centroid (O(N×E))
  for (let i = 0; i < N; i++) {
    if (!narrowBandMask[i]) continue;
    const ix = i % w, iy = (i / w) | 0;
    let bestDist = Infinity, bestIdx = 0;
    for (let e = 0; e < endDisp.length; e++) {
      const { cx, cy } = endDisp[e];
      const d = (ix - cx) ** 2 + (iy - cy) ** 2;
      if (d < bestDist) { bestDist = d; bestIdx = e; }
    }
    dxy[i * 2]     = endDisp[bestIdx].dx;
    dxy[i * 2 + 1] = endDisp[bestIdx].dy;
  }

  return dxy;
}

// ─────────────────────────────────────────────────────────────────────────
// assignWorldFrameIds
// ─────────────────────────────────────────────────────────────────────────

/**
 * assignWorldFrameIds
 *
 * Assigns a worldFrameId integer to every narrow-band pixel and manages
 * the session structureId lock.
 *
 * Keyframe path (first topologically consistent frame, or after lock reset):
 *   worldFrameId = hash(rQ, θQ, componentLabel, endId)
 *   The result is stored as the canonical keyframe map.
 *
 * Subsequent frame path:
 *   For each pixel, backward-warp to predicted position in keyframe using
 *   LQE displacement. If a valid keyframe ID exists there, inherit it.
 *   Otherwise fall back to direct hash (same as keyframe path).
 *
 * Session lock:
 *   If the incoming structureId differs from the locked value,
 *   the locked value is used for this frame (degradedMode = true).
 *   After lockThresh consecutive mismatches, the lock updates (scene change).
 *
 * @param {object}        params
 * @param {Float32Array}  params.warpField       — res²×2, from SurfaceParam
 * @param {Int32Array}    params.componentMap    — res², null in degraded mode
 * @param {Int32Array}    params.topologyMap     — res², endId per pixel
 * @param {Float32Array}  params.narrowBandMask  — res²
 * @param {Array}         params.ends            — PrimeEnd[] with multiplicity
 * @param {Array}         params.lipschitzEnds   — LQE end array with motionStats
 * @param {number}        params.b0
 * @param {number}        params.b1
 * @param {number}        params.resolution
 * @param {object}        params.sessionState    — mutated in place
 * @param {object}        [params.flags={}]
 *
 * @returns {{
 *   worldFrameMap: Int32Array,
 *   structureId:   string,
 *   isKeyframe:    boolean,
 *   degradedMode:  boolean,
 *   diagnostics:   object
 * }}
 */
export function assignWorldFrameIds({
  warpField,
  componentMap,
  topologyMap,
  narrowBandMask,
  ends,
  lipschitzEnds,
  b0,
  b1,
  resolution,
  sessionState,
  flags = {}
}) {
  const w          = resolution;
  const N          = w * w;
  const rBins      = flags.ambiRBins                ?? 64;
  const tBins      = flags.ambiThetaBins            ?? 128;
  const lockThresh = flags.structureIdLockThreshold ?? 5;
  const frameRate  = flags.ambiFrameRate            ?? 30;

  // ── 1. Compute structureId and apply session lock ─────────────────────
  const incomingId  = computeStructureId(b0, b1, ends);
  let   structureId = incomingId;
  let   degradedMode = !componentMap;   // degraded if componentMap absent

  const state = sessionState;

  if (state.structureId === null) {
    // First call — establish the lock
    state.structureId       = incomingId;
    state.inconsistentCount = 0;

  } else if (incomingId !== state.structureId) {
    // Mismatch: capture incomingId BEFORE overriding structureId.
    // The lock-update branch must use the genuine new value, not the locked one.
    state.inconsistentCount++;
    structureId  = state.structureId;   // use stable locked value this frame
    degradedMode = true;

    if (state.inconsistentCount >= lockThresh) {
      // Genuine scene change — update the lock and force a new keyframe
      state.structureId       = incomingId;   // incomingId still holds the real value
      state.inconsistentCount = 0;
      state.frameCount        = 0;            // force next call to be a keyframe
      state.keyframeWorldFrameMap = null;
      structureId  = incomingId;
      degradedMode = !componentMap;
      console.log(
        `[WorldFrameId] Scene change detected after ${lockThresh} mismatches. ` +
        `New structureId: ${incomingId}`
      );
    } else {
      console.warn(
        `[WorldFrameId] structureId mismatch ` +
        `(${state.inconsistentCount}/${lockThresh}): ` +
        `incoming=${incomingId} locked=${state.structureId} — ` +
        `using locked value, degradedMode=true`
      );
    }

  } else {
    // Match — reset mismatch counter
    state.inconsistentCount = 0;
  }

  // ── 2. Determine keyframe status ──────────────────────────────────────
  const isKeyframe =
    state.frameCount === 0 || state.keyframeWorldFrameMap === null;

  // ── 3. Allocate output ─────────────────────────────────────────────────
  // -1 = outside band, 0 = outer class / background, ≥1 = surface element
  const worldFrameMap = new Int32Array(N).fill(-1);

  // ── 4. Keyframe path ───────────────────────────────────────────────────
  if (isKeyframe) {
    let assigned = 0, outer = 0;

    for (let i = 0; i < N; i++) {
      if (!narrowBandMask[i]) { worldFrameMap[i] = -1; continue; }

      const endId = topologyMap[i];
      if (endId <= 0) {
        worldFrameMap[i] = 0;
        outer++;
        continue;
      }

      const r     = warpField[i * 2];
      const theta = warpField[i * 2 + 1];
      const rQ    = quantiseR(r, rBins);
      const tQ    = quantiseTheta(theta, tBins);
      const comp  = componentMap ? componentMap[i] : 0;

      worldFrameMap[i] = pixelHash(rQ, tQ, comp, endId);
      assigned++;
    }

    // Store as canonical keyframe map for subsequent frame integration
    state.keyframeWorldFrameMap = new Int32Array(worldFrameMap);
    state.frameCount++;

    return {
      worldFrameMap,
      structureId,
      isKeyframe: true,
      degradedMode,
      diagnostics: {
        assignedPixels:  assigned,
        outerPixels:     outer,
        inheritedPixels: 0,
        fallbackPixels:  0,
        frameCount:      state.frameCount,
        structureId,
        inconsistentCount: state.inconsistentCount
      }
    };
  }

  // ── 5. Subsequent frame path ───────────────────────────────────────────
  const prevMap = state.keyframeWorldFrameMap;

  // Build displacement field from LQE end dominantDirection + meanSpeed.
  // flowU/flowV not needed — dominantDirection is pre-computed in LQE.
  const dxy = _buildDisplacementField(
    lipschitzEnds, narrowBandMask, w, frameRate
  );

  let inherited = 0, fallback = 0, outer = 0;

  for (let i = 0; i < N; i++) {
    if (!narrowBandMask[i]) { worldFrameMap[i] = -1; continue; }

    const endId = topologyMap[i];
    if (endId <= 0) {
      worldFrameMap[i] = 0;
      outer++;
      continue;
    }

    // Backward-warp: predicted position in keyframe coordinate system
    const ix = i % w,     iy = (i / w) | 0;
    const dx = dxy[i * 2], dy = dxy[i * 2 + 1];

    const prevX = Math.max(0, Math.min(w - 1, Math.round(ix - dx)));
    const prevY = Math.max(0, Math.min(w - 1, Math.round(iy - dy)));
    const prevIdx = prevY * w + prevX;

    const prevId = prevMap ? prevMap[prevIdx] : -1;

    if (prevId > 0) {
      // Valid keyframe identity found — inherit it
      worldFrameMap[i] = prevId;
      inherited++;
    } else {
      // No valid keyframe ID at predicted position — direct hash fallback
      const r     = warpField[i * 2];
      const theta = warpField[i * 2 + 1];
      const rQ    = quantiseR(r, rBins);
      const tQ    = quantiseTheta(theta, tBins);
      const comp  = componentMap ? componentMap[i] : 0;
      worldFrameMap[i] = pixelHash(rQ, tQ, comp, endId);
      fallback++;
    }
  }

  state.frameCount++;

  return {
    worldFrameMap,
    structureId,
    isKeyframe: false,
    degradedMode,
    diagnostics: {
      inheritedPixels: inherited,
      fallbackPixels:  fallback,
      outerPixels:     outer,
      assignedPixels:  inherited + fallback,
      frameCount:      state.frameCount,
      structureId,
      inconsistentCount: state.inconsistentCount
    }
  };
}

export default { computeStructureId, assignWorldFrameIds };