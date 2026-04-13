// /src/js/core/SurfaceParam.js
//
// Stage 5 — AmbiAnamorph sub-module.
//
// Constructs the (r, θ) surface parameterisation warp field for every
// narrow-band pixel using a hybrid arc-length seeding + BFS propagation
// algorithm.
//
// Coordinate definitions:
//
//   r — normalised radial distance from the zero curve.
//       r = (phi_min[i] − phiBandMin) / (phiBandMax − phiBandMin) ∈ [0,1]
//       phi_min < 0 → inside surface, phi_min > 0 → outside surface.
//       r is viewing-angle independent.
//
//   θ — angular position along the surface, in radians.
//       Derived from cumulative arc-length along the zero curve loops
//       extracted by Stage 4B (MarchingSquares), mapped into the
//       boundary interval [theta0, theta1] of the owning prime-end.
//
// Algorithm (hybrid arc-length seeding + BFS propagation):
//
//   Phase 1 — Phi range
//     Scan narrow band to find phiBandMin/phiBandMax for r normalisation.
//
//   Phase 2 — Arc-length seed map
//     For each closed loop in zeroCurve.loops:
//       Walk ordered points, accumulate cumulative arc-length.
//       Identify which prime-end owns each point (via topologyMap).
//       Map cumulative arc-length within each end's arc segment to
//       [theta0, theta1]. Snap each float (x,y) point to an integer
//       pixel and write θ into seedTheta[pixel].
//       Seam pixels (where adjacent points belong to different ends)
//       are recorded for Phase 5 blending.
//
//   Phase 3 — BFS propagation
//     Flood θ outward from seeded pixels through the narrow band.
//     Each unvisited neighbour inherits the θ of the nearest seed.
//     r is computed independently from phi_min. 4-connectivity BFS.
//
//   Phase 4 — e1-projection fallback
//     Any narrow-band pixel not reached by BFS (gap in zero curve or
//     disconnected fragment) uses the anchor e1-projection method as
//     a fallback. Rare in well-formed input.
//
//   Phase 5 — Seam blending (flag-controlled, default on)
//     Seam pixels and their immediate neighbours receive a
//     distance-weighted blend of θ from both abutting ends, removing
//     sharp angular discontinuities at end-boundary transitions.
//
//   Phase 6 — Assemble warpField, detect branch locations, diagnostics.
//
// Why this is better than pure e1-projection:
//   e1-projection assigns θ based on (pixel − anchor) · e1_at_anchor.
//   e1 rotates across large ends, causing systematic angular distortion
//   for pixels far from the anchor. Here every pixel's θ comes from its
//   nearest zero-curve neighbour — at most bandWidth/2 ≈ 3–6 pixels
//   away — where geometry is tightly constrained regardless of e1
//   rotation. Cost is identical: O(N + P) where P = zero-curve points.
//
// Output layout — warpField Float32Array of length res²×2:
//   warpField[i*2 + 0] = r  (radial, [0,1])
//   warpField[i*2 + 1] = θ  (angular, radians)
//
// Pixels outside the narrow band  : [0, 0] sentinel.
// Outer-class pixels (endId = 0)  : [r, 0]  (r valid, θ undefined).

// ── 4-connected neighbour offsets ────────────────────────────────────────
const DX4 = [ 1, -1,  0,  0];
const DY4 = [ 0,  0,  1, -1];

/**
 * buildWarpField
 *
 * @param {object}        params
 * @param {Float32Array}  params.phiMin          — refined SDF, res² (Stage 4B)
 * @param {Array}         params.ends            — PrimeEnd[] with anchorPixel and
 *                                                  boundaryInterval attached (Fix 1B)
 * @param {Int32Array}    params.topologyMap     — per-pixel end id, res²
 *                                                  (-1=outside band, 0=outer, ≥1=end id)
 * @param {object}        params.zeroCurve       — Stage 4B zero_curve artifact data
 *                                                  { loops: [{points: Float32Array}] }
 * @param {Float32Array}  params.principalFrame  — res²×4: e1x,e1y,e2x,e2y per pixel
 *                                                  (fallback only)
 * @param {Float32Array}  params.narrowBandMask  — res²: >0 inside band
 * @param {number}        params.resolution
 * @param {object}        [params.flags={}]
 *
 * @returns {{
 *   warpField:       Float32Array,
 *   branchLocations: Array,
 *   paramResolution: { rBins, thetaBins },
 *   diagnostics:     object
 * }}
 */
export function buildWarpField({
  phiMin,
  ends,
  topologyMap,
  zeroCurve,
  principalFrame,
  narrowBandMask,
  resolution,
  flags = {}
}) {
  const w          = resolution;
  const N          = w * w;
  const seamBlend  = flags.ambiSeamBlend !== false;   // default on
  let   fallbacks  = 0;

  // ── Per-end info lookup ─────────────────────────────────────────────────
  const endInfo = new Map();
  for (const end of ends) {
    const bi = end.boundaryInterval;
    endInfo.set(end.id, {
      anchorPixel: end.anchorPixel ?? -1,
      theta0:      Array.isArray(bi) ? bi[0] : 0,
      theta1:      Array.isArray(bi) ? bi[1] : 0
    });
  }

  // ── Phase 1: Phi range ──────────────────────────────────────────────────
  let phiBandMin =  Infinity;
  let phiBandMax = -Infinity;
  for (let i = 0; i < N; i++) {
    if (!narrowBandMask[i]) continue;
    const v = phiMin[i];
    if (v < phiBandMin) phiBandMin = v;
    if (v > phiBandMax) phiBandMax = v;
  }
  const phiRange = phiBandMax - phiBandMin;
  const rScale   = phiRange > 1e-10 ? 1.0 / phiRange : 1.0;

  // ── Phase 2: Arc-length seed map ────────────────────────────────────────
  const seedTheta = new Float32Array(N);
  const seedMask  = new Uint8Array(N);
  // seamInfo: pixel index → { thetaA, thetaB } for seam pixels
  const seamInfo  = new Map();

  const loops = zeroCurve?.loops ?? [];

  for (const loop of loops) {
    const pts  = loop.points;        // Float32Array: x0,y0,x1,y1,...
    const nPts = pts.length / 2;
    if (nPts < 2) continue;

    // Accumulate cumulative arc-length
    const arcLen = new Float64Array(nPts);
    for (let k = 1; k < nPts; k++) {
      const dx = pts[k*2] - pts[(k-1)*2];
      const dy = pts[k*2+1] - pts[(k-1)*2+1];
      arcLen[k] = arcLen[k-1] + Math.sqrt(dx*dx + dy*dy);
    }
    const totalArc = arcLen[nPts - 1];
    if (totalArc < 1e-8) continue;

    // Assign end id to each point via topologyMap
    const ptEndIds = new Int32Array(nPts);
    for (let k = 0; k < nPts; k++) {
      const px = Math.max(0, Math.min(w - 1, Math.round(pts[k*2])));
      const py = Math.max(0, Math.min(w - 1, Math.round(pts[k*2+1])));
      ptEndIds[k] = topologyMap[py * w + px];
    }

    // Collect contiguous segments of the same end id
    // segments: [{ endId, kStart, kEnd }]
    const segments = [];
    let segEndId = ptEndIds[0];
    let segStart = 0;
    for (let k = 1; k <= nPts; k++) {
      const cur = k < nPts ? ptEndIds[k] : -1;
      if (cur !== segEndId) {
        if (segEndId > 0) segments.push({ endId: segEndId, kStart: segStart, kEnd: k - 1 });
        segStart = k;
        segEndId = cur;
      }
    }

    // Detect seam boundaries: indices where segment end-id changes
    // A seam occurs at the pixel straddling kEnd of one segment and
    // kStart of the next.
    const seamBoundaryK = new Set();
    for (let s = 0; s < segments.length - 1; s++) {
      seamBoundaryK.add(segments[s].kEnd);
      seamBoundaryK.add(segments[s + 1].kStart);
    }

    // Map arc-length to θ and seed pixels for each segment
    for (const seg of segments) {
      const info = endInfo.get(seg.endId);
      if (!info) continue;

      const segArcStart = arcLen[seg.kStart];
      const segArcEnd   = arcLen[seg.kEnd];
      const segArcSpan  = segArcEnd - segArcStart;
      if (segArcSpan < 1e-8) continue;

      const { theta0, theta1 } = info;

      for (let k = seg.kStart; k <= seg.kEnd; k++) {
        const tNorm = (arcLen[k] - segArcStart) / segArcSpan;
        const theta = theta0 + tNorm * (theta1 - theta0);

        const px  = Math.max(0, Math.min(w - 1, Math.round(pts[k*2])));
        const py  = Math.max(0, Math.min(w - 1, Math.round(pts[k*2+1])));
        const idx = py * w + px;

        if (!narrowBandMask[idx]) continue;

        if (!seedMask[idx]) {
          seedTheta[idx] = theta;
          seedMask[idx]  = 1;
        } else if (seamBlend) {
          // Pixel already seeded by a prior segment — seam pixel
          const prev = seedTheta[idx];
          if (Math.abs(prev - theta) > 1e-6 && !seamInfo.has(idx)) {
            seamInfo.set(idx, { thetaA: prev, thetaB: theta });
          }
        }
      }
    }
  }

  // ── Phase 3: BFS propagation ────────────────────────────────────────────
  const visited  = new Uint8Array(N);
  const thetaMap = new Float32Array(N);

  // Pre-allocated queue — avoids dynamic array growth
  const queue = new Int32Array(N);
  let qHead = 0, qTail = 0;

  for (let i = 0; i < N; i++) {
    if (seedMask[i] && narrowBandMask[i]) {
      thetaMap[i] = seedTheta[i];
      visited[i]  = 1;
      queue[qTail++] = i;
    }
  }

  while (qHead < qTail) {
    const cur = queue[qHead++];
    const cx  = cur % w;
    const cy  = (cur / w) | 0;

    for (let d = 0; d < 4; d++) {
      const nx = cx + DX4[d];
      const ny = cy + DY4[d];
      if (nx < 0 || nx >= w || ny < 0 || ny >= w) continue;
      const nb = ny * w + nx;
      if (!narrowBandMask[nb] || visited[nb]) continue;
      thetaMap[nb] = thetaMap[cur];
      visited[nb]  = 1;
      queue[qTail++] = nb;
    }
  }

  // ── Phase 4: e1-projection fallback ────────────────────────────────────
  // Rare — only fires for disconnected narrow-band fragments or zero-curve
  // gaps. Build the anchor e1 map lazily to avoid work in the common case.
  let anyUnvisited = false;
  for (let i = 0; i < N; i++) {
    if (narrowBandMask[i] && !visited[i]) { anyUnvisited = true; break; }
  }

  if (anyUnvisited) {
    // Build anchor e1 map
    const anchorE1 = new Map();
    for (const end of ends) {
      const ap = end.anchorPixel ?? -1;
      if (ap < 0 || anchorE1.has(ap)) continue;
      let e1x = 1, e1y = 0;
      if (principalFrame && ap * 4 + 1 < principalFrame.length) {
        const rx = principalFrame[ap * 4];
        const ry = principalFrame[ap * 4 + 1];
        const mag = Math.sqrt(rx*rx + ry*ry);
        if (mag > 1e-8) { e1x = rx / mag; e1y = ry / mag; }
      }
      anchorE1.set(ap, { e1x, e1y });
    }

    // Two-pass projection: accumulate t range, then assign θ
    const tMin = new Map();
    const tMax = new Map();

    for (let i = 0; i < N; i++) {
      if (!narrowBandMask[i] || visited[i]) continue;
      const endId = topologyMap[i];
      if (endId <= 0) continue;
      const info = endInfo.get(endId);
      if (!info || info.anchorPixel < 0) continue;
      const e1 = anchorE1.get(info.anchorPixel);
      if (!e1) continue;
      const ax = info.anchorPixel % w, ay = (info.anchorPixel / w) | 0;
      const t  = (i % w - ax) * e1.e1x + ((i / w | 0) - ay) * e1.e1y;
      const p0 = tMin.get(endId), p1 = tMax.get(endId);
      tMin.set(endId, p0 === undefined ? t : Math.min(p0, t));
      tMax.set(endId, p1 === undefined ? t : Math.max(p1, t));
    }

    for (let i = 0; i < N; i++) {
      if (!narrowBandMask[i] || visited[i]) continue;
      fallbacks++;
      const endId = topologyMap[i];
      if (endId <= 0) { thetaMap[i] = 0; visited[i] = 1; continue; }
      const info = endInfo.get(endId);
      if (!info) { thetaMap[i] = 0; visited[i] = 1; continue; }
      const t0 = tMin.get(endId), t1 = tMax.get(endId);
      const tRange = (t0 !== undefined && t1 !== undefined) ? (t1 - t0) : 0;
      if (tRange < 1e-6 || info.anchorPixel < 0) {
        thetaMap[i] = (info.theta0 + info.theta1) * 0.5;
      } else {
        const e1 = anchorE1.get(info.anchorPixel) ?? { e1x: 1, e1y: 0 };
        const ax = info.anchorPixel % w, ay = (info.anchorPixel / w) | 0;
        const t  = (i % w - ax) * e1.e1x + ((i / w | 0) - ay) * e1.e1y;
        const tNorm = Math.max(0, Math.min(1, (t - t0) / tRange));
        thetaMap[i] = info.theta0 + tNorm * (info.theta1 - info.theta0);
      }
      visited[i] = 1;
    }

    if (fallbacks > 0) {
      console.warn(
        `[SurfaceParam] ${fallbacks} pixel(s) not reached by BFS — ` +
        `e1-projection fallback used. Possible zero-curve gap or ` +
        `disconnected narrow-band fragment.`
      );
    }
  }

  // ── Phase 5: Seam blending ──────────────────────────────────────────────
  // Seam pixels get 50/50 blend; immediate neighbours get 25% pull toward
  // the seam midpoint, softening the end-boundary transition.
  if (seamBlend && seamInfo.size > 0) {
    for (const [idx, { thetaA, thetaB }] of seamInfo) {
      thetaMap[idx] = (thetaA + thetaB) * 0.5;

      const cx = idx % w, cy = (idx / w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = cx + DX4[d], ny = cy + DY4[d];
        if (nx < 0 || nx >= w || ny < 0 || ny >= w) continue;
        const nb = ny * w + nx;
        if (!narrowBandMask[nb] || seamInfo.has(nb)) continue;
        thetaMap[nb] = thetaMap[nb] * 0.75 + thetaMap[idx] * 0.25;
      }
    }
  }

  // ── Phase 6: Assemble warpField ─────────────────────────────────────────
  const warpField = new Float32Array(N * 2);

  for (let i = 0; i < N; i++) {
    if (!narrowBandMask[i]) {
      warpField[i*2] = 0; warpField[i*2+1] = 0;
      continue;
    }
    const r = (phiMin[i] - phiBandMin) * rScale;
    if (topologyMap[i] <= 0) {
      warpField[i*2] = r; warpField[i*2+1] = 0;
    } else {
      warpField[i*2] = r; warpField[i*2+1] = thetaMap[i];
    }
  }

  // ── Branch location detection ───────────────────────────────────────────
  const anchorEndIds = new Map();
  for (const end of ends) {
    const ap = end.anchorPixel ?? -1;
    if (ap < 0) continue;
    if (!anchorEndIds.has(ap)) anchorEndIds.set(ap, []);
    anchorEndIds.get(ap).push(end.id);
  }
  const branchLocations = [];
  for (const [anchorPixel, endIds] of anchorEndIds) {
    if (endIds.length > 1) branchLocations.push({ anchorPixel, endIds: endIds.slice() });
  }

  // ── Diagnostics ─────────────────────────────────────────────────────────
  let seededPixels = 0, outerPixels = 0, outsidePixels = 0;
  for (let i = 0; i < N; i++) {
    if (!narrowBandMask[i])  { outsidePixels++; continue; }
    if (topologyMap[i] <= 0) { outerPixels++;   continue; }
    if (seedMask[i])           seededPixels++;
  }

  return {
    warpField,
    branchLocations,
    paramResolution: {
      rBins:     flags.ambiRBins     ?? 64,
      thetaBins: flags.ambiThetaBins ?? 128
    },
    diagnostics: {
      phiRange:       { min: phiBandMin, max: phiBandMax },
      seededPixels,
      bfsFallback:    fallbacks,
      seamPixels:     seamInfo.size,
      outerPixels,
      outsidePixels,
      loopsProcessed: loops.length,
      endCount:       ends.length,
      branchCount:    branchLocations.length
    }
  };
}

export default buildWarpField;