// /src/js/core/ViewManifold.js
//
// Stage 5 — AmbiAnamorph sub-module.
//
// Maintains the sparse view manifold graph: a set of camera nodes with
// feature vectors, edges between compatible nodes, and connected components
// determined by topological identity (structureId) and feature similarity.
//
// Feature vector layout:
//
//   Unrefined (Stage 5, length = 10 + 2×endCount):
//     [0]       b0_n               — component count, normalised
//     [1]       b1_n               — cycle count, normalised
//     [2]       endCount_n         — prime-end count, normalised
//     [3..3+2N) theta0_k, theta1_k — boundary intervals, normalised to [0,1]
//     [3+2N]    meanFMap           — directness mean, [0,1]
//     [4+2N]    penumbraFraction   — [0,1]
//     [5+2N]    lqeEndCount_n      — normalised
//     [6+2N]    meanMotionMag_n    — image-space proxy, normalised
//     [7+2N]    meanLQESpeed_n     — end-level proxy, normalised
//     [8+2N]    cosDir             — cos(dominantFlowDirection)
//     [9+2N]    sinDir             — sin(dominantFlowDirection)
//     [10+2N]   meanKH_n           — normalised mean curvature
//     [11+2N]   curvaturePeakCount_n
//     → total length: 12 + 2×endCount   (indices 0..11+2N)
//
//   Refined (Stage 6, length = 11 + 2×endCount):
//     Same layout with meanMotionMag_n and meanLQESpeed_n replaced by
//     a single meanKEM_n component. Length decreases by 1.
//     node.refined = true marks the refined state.
//
// Normalisation scales (component-wise, before L2 normalisation):
//   b0            / 5.0
//   b1            / 3.0
//   endCount      / 10.0
//   theta0, theta1 / TWO_PI
//   meanFMap        already [0,1]
//   penumbraFraction already [0,1]
//   lqeEndCount    / 10.0
//   meanMotionMag  / 20.0   (pixels/frame, p99 expected max)
//   meanLQESpeed   / 20.0
//   meanKEM        / 400.0  (pixels²/frame², p99 expected max)
//   cosDir, sinDir  already [−1,1]
//   meanKH         / 10.0
//   curvaturePeakCount / 20.0
//
// cosineSimilarity asserts equal length and equal refined state — comparing
// an unrefined vector to a refined one returns 0 and logs an error.
//
// Exports:
//   buildFeatureVector(inputs)    → Float32Array (L2-normalised)
//   cosineSimilarity(a, b)        → number [0,1]
//   createViewManifold()          → ViewManifold object
//   updateViewManifold(params)    → { componentId, positionInManifold }
//   refineNode(params)            → { componentId, positionInManifold, residuals }

const TWO_PI = 2 * Math.PI;

// ── Normalisation scales ─────────────────────────────────────────────────
const SCALE_B0             = 5.0;
const SCALE_B1             = 3.0;
const SCALE_END_COUNT      = 10.0;
const SCALE_THETA          = TWO_PI;
const SCALE_LQE_END_COUNT  = 10.0;
const SCALE_MOTION_MAG     = 20.0;   // pixels/frame
const SCALE_LQE_SPEED      = 20.0;   // pixels/frame
const SCALE_KEM            = 400.0;  // pixels²/frame²
const SCALE_KH             = 10.0;
const SCALE_CURV_PEAKS     = 20.0;

// ── Sentinel on Float32Array to carry refinement state ───────────────────
// JavaScript typed arrays do not support extra properties natively.
// We use a plain wrapper object so the flag travels with the vector.

/**
 * FeatureVectorWrapper
 * Wraps a Float32Array with a refinement flag.
 * All operations (dot product, length) use the inner array.
 */
function makeVec(arr, refined = false) {
  return { data: arr, length: arr.length, refined };
}

// ─────────────────────────────────────────────────────────────────────────
// buildFeatureVector
// ─────────────────────────────────────────────────────────────────────────

/**
 * buildFeatureVector
 *
 * Constructs the unrefined Stage 5 feature vector for a camera node.
 * Flow direction is encoded as (cos θ, sin θ) rather than a scalar
 * to avoid wrap-around discontinuity in cosine similarity.
 *
 * @param {object} inputs
 * @param {number} inputs.b0
 * @param {number} inputs.b1
 * @param {number} inputs.endCount
 * @param {Array}  inputs.ends               — PrimeEnd[] with boundaryInterval
 * @param {number} inputs.meanFMap            — [0,1]
 * @param {number} inputs.penumbraFraction    — [0,1]
 * @param {number} inputs.lqeEndCount
 * @param {number} inputs.meanMotionMagnitude — image-space proxy
 * @param {number} inputs.meanLQESpeed        — end-level proxy
 * @param {number} inputs.dominantFlowDirection — radians ∈ [−π, π]
 * @param {number} inputs.meanKH
 * @param {number} inputs.curvaturePeakCount
 *
 * @returns {{ data: Float32Array, length: number, refined: boolean }}
 *   L2-normalised, refined=false
 */
export function buildFeatureVector({
  b0,
  b1,
  endCount,
  ends,
  meanFMap,
  penumbraFraction,
  lqeEndCount,
  meanMotionMagnitude,
  meanLQESpeed,
  dominantFlowDirection,
  meanKH,
  curvaturePeakCount
}) {
  // Fixed-length prefix: 3 topological + 3 scalar evidence = 6
  // Variable section: 2 × endCount (boundary intervals)
  // Suffix: 7 evidence components
  // Total: 13 + 2×endCount
  // Index layout:
  //   0            b0_n
  //   1            b1_n
  //   2            endCount_n
  //   3..3+2N-1    theta0_k, theta1_k  (N = endCount)
  //   3+2N         meanFMap
  //   4+2N         penumbraFraction
  //   5+2N         lqeEndCount_n
  //   6+2N         meanMotionMag_n
  //   7+2N         meanLQESpeed_n
  //   8+2N         cosDir
  //   9+2N         sinDir
  //   10+2N        meanKH_n
  //   11+2N        curvaturePeakCount_n
  //   Total: 12 + 2N

  const N    = ends.length;
  const len  = 12 + 2 * N;
  const arr  = new Float32Array(len);

  // ── Topological group ──────────────────────────────────────────────────
  arr[0] = (b0 | 0)       / SCALE_B0;
  arr[1] = (b1 | 0)       / SCALE_B1;
  arr[2] = (endCount | 0) / SCALE_END_COUNT;

  // ── Parametric group: boundary intervals in end-id order ───────────────
  // Ends must be sorted by id before flattening to guarantee consistent
  // ordering across frames and cameras.
  const sortedEnds = ends.slice().sort((a, b) => a.id - b.id);
  for (let k = 0; k < N; k++) {
    const bi = sortedEnds[k].boundaryInterval ?? [0, 0];
    arr[3 + k * 2]     = bi[0] / SCALE_THETA;
    arr[3 + k * 2 + 1] = bi[1] / SCALE_THETA;
  }

  const base = 3 + 2 * N;

  // ── Evidence group ─────────────────────────────────────────────────────
  arr[base + 0] = Math.max(0, Math.min(1, meanFMap ?? 0));
  arr[base + 1] = Math.max(0, Math.min(1, penumbraFraction ?? 0));
  arr[base + 2] = (lqeEndCount | 0)       / SCALE_LQE_END_COUNT;
  arr[base + 3] = (meanMotionMagnitude ?? 0) / SCALE_MOTION_MAG;
  arr[base + 4] = (meanLQESpeed ?? 0)        / SCALE_LQE_SPEED;

  // Encode flow direction as unit circle components — avoids wrap-around
  const dir     = dominantFlowDirection ?? 0;
  arr[base + 5] = Math.cos(dir);
  arr[base + 6] = Math.sin(dir);

  arr[base + 7] = (meanKH ?? 0)                / SCALE_KH;
  arr[base + 8] = (curvaturePeakCount | 0)     / SCALE_CURV_PEAKS;

  // ── L2 normalisation ───────────────────────────────────────────────────
  let magSq = 0;
  for (let i = 0; i < len; i++) magSq += arr[i] * arr[i];
  const mag = Math.sqrt(magSq);
  if (mag > 1e-10) {
    for (let i = 0; i < len; i++) arr[i] /= mag;
  }

  return makeVec(arr, false);
}

// ─────────────────────────────────────────────────────────────────────────
// cosineSimilarity
// ─────────────────────────────────────────────────────────────────────────

/**
 * cosineSimilarity
 *
 * Computes cosine similarity between two feature vector wrappers.
 * Because vectors are L2-normalised at construction, this equals
 * the dot product.
 *
 * Asserts:
 *   1. Equal length — a length mismatch means structureId matched two
 *      cameras with different endCount, or one vector has been refined
 *      and the other has not. Either is a logic error in the caller.
 *   2. Equal refined state — comparing unrefined (proxy) to refined
 *      (meanKEM) vectors produces a meaningless similarity score because
 *      the component at index 6+2N means different things in each state.
 *
 * @param {{ data: Float32Array, length: number, refined: boolean }} a
 * @param {{ data: Float32Array, length: number, refined: boolean }} b
 * @returns {number} cosine similarity ∈ [0,1], or 0 on assertion failure
 */
export function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    console.error(
      `[ViewManifold] cosineSimilarity: length mismatch ${a.length} vs ${b.length}. ` +
      `Possible causes: (1) structureId matched two cameras with different endCount ` +
      `— check computeStructureId() in WorldFrameId.js; ` +
      `(2) one vector is refined (Stage 6) and the other is not ` +
      `— never compare across refinement states. Returning 0.`
    );
    return 0;
  }

  if (a.refined !== b.refined) {
    console.error(
      `[ViewManifold] cosineSimilarity: refinement state mismatch ` +
      `(a.refined=${a.refined}, b.refined=${b.refined}). ` +
      `Refined and unrefined vectors encode different quantities at overlapping ` +
      `indices. Returning 0.`
    );
    return 0;
  }

  // Vectors are L2-normalised — dot product equals cosine similarity
  let dot = 0;
  const da = a.data, db = b.data;
  for (let i = 0; i < a.length; i++) dot += da[i] * db[i];

  // Clamp to [0,1]: negative similarity is treated as incompatible
  return Math.max(0, Math.min(1, dot));
}

// ─────────────────────────────────────────────────────────────────────────
// createViewManifold
// ─────────────────────────────────────────────────────────────────────────

/**
 * createViewManifold
 *
 * Initialises an empty view manifold object.
 * Owned by ambi.worker; passed to updateViewManifold and refineNode.
 *
 * @returns {{ nodes: Map, edges: Map, components: Map }}
 */
export function createViewManifold() {
  return {
    nodes:      new Map(),   // cameraId → ViewManifoldNode
    edges:      new Map(),   // edgeKey  → ViewManifoldEdge
    components: new Map()    // componentId → Set<cameraId>
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Internal: union-find
// ─────────────────────────────────────────────────────────────────────────

function _recomputeComponents(manifold) {
  const nodes = manifold.nodes;
  const edges = manifold.edges;

  if (nodes.size === 0) { manifold.components.clear(); return; }

  // Union-Find over camera ids
  const parent = new Map();
  for (const id of nodes.keys()) parent.set(id, id);

  const find = (x) => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    // Path compression
    let cur = x;
    while (cur !== root) {
      const next = parent.get(cur);
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };

  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  // Union cameras connected by edges
  for (const edge of edges.values()) {
    union(edge.cameraA, edge.cameraB);
  }

  // Collect components: componentId = structureId + lexicographically
  // smallest cameraId in the component, for determinism
  const compMembers = new Map();   // root → [cameraId, ...]
  for (const id of nodes.keys()) {
    const root = find(id);
    if (!compMembers.has(root)) compMembers.set(root, []);
    compMembers.get(root).push(id);
  }

  manifold.components.clear();
  for (const [root, members] of compMembers) {
    members.sort();   // lexicographic for determinism
    const structureId = nodes.get(root).structureId;
    const compId      = `component:${structureId}:${members[0]}`;
    manifold.components.set(compId, new Set(members));
  }
}

// Canonical edge key: smaller id first, separated by '::'
function _edgeKey(a, b) {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

// Find the componentId that contains cameraId after recompute
function _componentIdFor(manifold, cameraId) {
  for (const [compId, members] of manifold.components) {
    if (members.has(cameraId)) return compId;
  }
  return `component:solo:${cameraId}`;
}

// ─────────────────────────────────────────────────────────────────────────
// updateViewManifold
// ─────────────────────────────────────────────────────────────────────────

/**
 * updateViewManifold
 *
 * Adds or updates a camera node with the current feature vector,
 * checks compatibility against all existing nodes that share the
 * same structureId, updates edges, and recomputes connected components.
 *
 * Only nodes with the same structureId (necessary condition) and
 * feature vector similarity above compatibilityThresh (sufficient
 * condition) are connected by an edge.
 *
 * @param {object} params
 * @param {{ nodes, edges, components }} params.manifold  — mutated in place
 * @param {string} params.cameraId
 * @param {{ data, length, refined }} params.featureVector
 * @param {string} params.structureId
 * @param {number} params.legibilityScore
 * @param {number} [params.compatibilityThresh=0.85]
 *
 * @returns {{ componentId: string, positionInManifold: Float32Array }}
 */
export function updateViewManifold({
  manifold,
  cameraId,
  featureVector,
  structureId,
  legibilityScore,
  compatibilityThresh = 0.85
}) {
  const { nodes, edges } = manifold;

  // ── Upsert node ────────────────────────────────────────────────────────
  nodes.set(cameraId, {
    cameraId,
    featureVector,         // FeatureVectorWrapper { data, length, refined }
    structureId,
    legibilityScore,
    updatedAt: Date.now()
  });

  // ── Update edges against all existing nodes ────────────────────────────
  // Only check cameras that share this structureId — cross-structure
  // comparison is structurally meaningless.
  for (const [otherId, other] of nodes) {
    if (otherId === cameraId) continue;
    if (other.structureId !== structureId) continue;

    const sim = cosineSimilarity(featureVector, other.featureVector);
    const key = _edgeKey(cameraId, otherId);

    if (sim >= compatibilityThresh) {
      edges.set(key, {
        cameraA:       cameraId < otherId ? cameraId : otherId,
        cameraB:       cameraId < otherId ? otherId  : cameraId,
        compatibility: sim
      });
    } else {
      // Remove edge if it existed and cameras are now incompatible
      edges.delete(key);
    }
  }

  // ── Recompute components ───────────────────────────────────────────────
  _recomputeComponents(manifold);

  const componentId = _componentIdFor(manifold, cameraId);

  return {
    componentId,
    positionInManifold: featureVector.data
  };
}

// ─────────────────────────────────────────────────────────────────────────
// refineNode
// ─────────────────────────────────────────────────────────────────────────

/**
 * refineNode
 *
 * Called after Stage 6 KEM computation. Replaces the two proxy motion
 * components (meanMotionMag_n, meanLQESpeed_n) with a single meanKEM_n
 * component, reducing the vector length by 1. Sets refined=true.
 *
 * Computes residuals:
 *   motionMagResidual = meanKEM − meanMotionMagnitude (raw, unnormalised)
 *   lqeSpeedResidual  = meanKEM − meanLQESpeed        (raw, unnormalised)
 *
 * These residuals are returned for Stage 7 consumption and for
 * legibilityScore adjustment. A large negative motionMagResidual
 * indicates camera motion or illumination change dominated the
 * image-plane signal.
 *
 * After substitution, re-checks compatibility against all nodes that
 * share the same structureId AND are already refined. Nodes that are
 * not yet refined are not compared (mixed refinement state is invalid).
 *
 * @param {object} params
 * @param {{ nodes, edges, components }} params.manifold  — mutated in place
 * @param {string} params.cameraId
 * @param {number} params.meanKEM              — from Stage 6 (raw, unnormalised)
 * @param {number} params.meanMotionMagnitude  — original proxy (raw)
 * @param {number} params.meanLQESpeed         — original proxy (raw)
 * @param {number} [params.compatibilityThresh=0.85]
 *
 * @returns {{
 *   componentId:        string,
 *   positionInManifold: Float32Array,
 *   residuals: {
 *     motionMagResidual: number,
 *     lqeSpeedResidual:  number
 *   }
 * }}
 */
export function refineNode({
  manifold,
  cameraId,
  meanKEM,
  meanMotionMagnitude,
  meanLQESpeed,
  compatibilityThresh = 0.85
}) {
  const { nodes, edges } = manifold;
  const node = nodes.get(cameraId);

  if (!node) {
    console.warn(`[ViewManifold] refineNode: cameraId '${cameraId}' not found in manifold`);
    return { componentId: `component:solo:${cameraId}`, positionInManifold: new Float32Array(0), residuals: { motionMagResidual: 0, lqeSpeedResidual: 0 } };
  }

  if (node.featureVector.refined) {
    console.warn(`[ViewManifold] refineNode: node '${cameraId}' already refined — skipping`);
    const compId = _componentIdFor(manifold, cameraId);
    return {
      componentId:        compId,
      positionInManifold: node.featureVector.data,
      residuals: { motionMagResidual: 0, lqeSpeedResidual: 0 }
    };
  }

  // ── Compute residuals (raw, unnormalised) ──────────────────────────────
  const motionMagResidual = meanKEM - (meanMotionMagnitude ?? 0);
  const lqeSpeedResidual  = meanKEM - (meanLQESpeed ?? 0);

  // ── Build refined vector: length decreases by 1 ───────────────────────
  // Unrefined layout (length = 12 + 2N):
  //   [base+3] = meanMotionMag_n    ← replace with meanKEM_n
  //   [base+4] = meanLQESpeed_n     ← remove
  //   [base+5..base+8] = cosDir, sinDir, meanKH_n, curvPeaks_n ← shift left by 1
  //
  // Refined layout (length = 11 + 2N):
  //   [base+3] = meanKEM_n
  //   [base+4] = cosDir
  //   [base+5] = sinDir
  //   [base+6] = meanKH_n
  //   [base+7] = curvaturePeakCount_n

  const oldArr = node.featureVector.data;
  const oldLen = oldArr.length;
  const newLen = oldLen - 1;
  const newArr = new Float32Array(newLen);

  // The variable section ends at index 3 + 2N.
  // We need N = (oldLen - 12) / 2. Because oldLen = 12 + 2N → N = (oldLen-12)/2.
  const N    = (oldLen - 12) / 2;
  const base = 3 + 2 * N;

  // Copy everything up to and including [base+2] (lqeEndCount_n) unchanged
  for (let i = 0; i < base + 3; i++) newArr[i] = oldArr[i];

  // Insert meanKEM_n at [base+3]
  newArr[base + 3] = (Number.isFinite(meanKEM) ? meanKEM : 0) / SCALE_KEM;

  // Copy cosDir, sinDir, meanKH_n, curvPeaks_n from [base+5..base+8]
  // into [base+4..base+7] — shift left by 1
  for (let i = base + 5; i < oldLen; i++) newArr[i - 1] = oldArr[i];

  // ── L2 re-normalise ────────────────────────────────────────────────────
  let magSq = 0;
  for (let i = 0; i < newLen; i++) magSq += newArr[i] * newArr[i];
  const mag = Math.sqrt(magSq);
  if (mag > 1e-10) {
    for (let i = 0; i < newLen; i++) newArr[i] /= mag;
  }

  const refinedVec = makeVec(newArr, true);
  node.featureVector = refinedVec;

  // ── Re-check edges against other refined nodes only ───────────────────
  for (const [otherId, other] of nodes) {
    if (otherId === cameraId) continue;
    if (other.structureId !== node.structureId) continue;
    if (!other.featureVector.refined) continue;   // skip unrefined nodes

    const sim = cosineSimilarity(refinedVec, other.featureVector);
    const key = _edgeKey(cameraId, otherId);

    if (sim >= compatibilityThresh) {
      edges.set(key, {
        cameraA:       cameraId < otherId ? cameraId : otherId,
        cameraB:       cameraId < otherId ? otherId  : cameraId,
        compatibility: sim
      });
    } else {
      edges.delete(key);
    }
  }

  // Also remove any edges between this node and unrefined nodes —
  // they are now incomparably encoded.
  for (const [otherId, other] of nodes) {
    if (otherId === cameraId) continue;
    if (!other.featureVector.refined) {
      edges.delete(_edgeKey(cameraId, otherId));
    }
  }

  // ── Recompute components ───────────────────────────────────────────────
  _recomputeComponents(manifold);

  const componentId = _componentIdFor(manifold, cameraId);

  return {
    componentId,
    positionInManifold: refinedVec.data,
    residuals: {
      motionMagResidual,
      lqeSpeedResidual
    }
  };
}

export default {
  buildFeatureVector,
  cosineSimilarity,
  createViewManifold,
  updateViewManifold,
  refineNode
};