// /src/js/core/MarchingSquares.js
//
// Marching squares zero-curve extraction with full topological organisation.
//
// Pipeline:
//   1. Per-cell case classification → raw line segments
//   2. Segment chaining → polylines (closed loops + open arcs)
//   3. Signed area (shoelace) → orientation (outer vs hole)
//   4. Nesting detection → which holes belong to which outer loop
//   5. Component assignment → which Stage 4A component each loop belongs to
//   6. Topological consistency check against b0 + b1
//
// Output schema:
//   {
//     loops: ClosedLoop[],
//     arcs:  OpenArc[],
//     topologyConsistent: boolean,
//     expectedLoops: number,
//     b0: number,
//     b1: number
//   }
//
// ClosedLoop: { points: Float32Array, isHole: boolean, area: number,
//               component: number, length: number, nestParent: number|null }
// OpenArc:    { points: Float32Array, component: number, length: number }

// ── Marching squares case table ───────────────────────────────────────────
//
// Corner order: 0=TL, 1=TR, 2=BR, 3=BL  (row-major, y-down)
// Edge order:   0=Top, 1=Right, 2=Bottom, 3=Left
//
// Each case is a list of edge-pair connections.
// Cases 5 and 10 (saddle points) use the sign of the cell centre
// to resolve ambiguity consistently.

const CASES = [
  [],               // 0:  0000 — all outside
  [[3, 2]],         // 1:  0001 — BL inside
  [[2, 1]],         // 2:  0010 — BR inside
  [[3, 1]],         // 3:  0011 — BR+BL inside
  [[1, 0]],         // 4:  0100 — TR inside
  null,             // 5:  0101 — saddle (resolved dynamically)
  [[2, 0]],         // 6:  0110 — TR+BR inside
  [[3, 0]],         // 7:  0111 — TR+BR+BL inside
  [[0, 3]],         // 8:  1000 — TL inside
  [[0, 2]],         // 9:  1001 — TL+BL inside
  null,             // 10: 1010 — saddle (resolved dynamically)
  [[0, 1]],         // 11: 1011 — TL+BR+BL inside
  [[1, 3]],         // 12: 1100 — TL+TR inside
  [[1, 2]],         // 13: 1101 — TL+TR+BL inside
  [[0, 3], [1, 2]], // 14: 1110 — wait, let me redo this properly
];

// Correct full 16-case table.
// Case index = BL*1 + BR*2 + TR*4 + TL*8  (standard winding)
// Edge indices: 0=bottom, 1=right, 2=top, 3=left
// Edge interpolation: bottom=(BL→BR), right=(BR→TR), top=(TR→TL), left=(TL→BL)

const MS_CASES = [
  [],                        // 0:  all pos
  [[0, 3]],                  // 1:  BL neg
  [[1, 0]],                  // 2:  BR neg
  [[1, 3]],                  // 3:  BL+BR neg
  [[2, 1]],                  // 4:  TR neg
  null,                      // 5:  saddle BL+TR neg
  [[2, 0]],                  // 6:  BR+TR neg
  [[2, 3]],                  // 7:  BL+BR+TR neg
  [[3, 2]],                  // 8:  TL neg
  [[0, 2]],                  // 9:  BL+TL neg
  null,                      // 10: BR+TL neg (saddle)
  [[1, 2]],                  // 11: BL+BR+TL neg
  [[3, 1]],                  // 12: TR+TL neg
  [[0, 1]],                  // 13: BL+TR+TL neg
  [[3, 0]],                  // 14: BR+TR+TL neg
  [],                        // 15: all neg
];

// Saddle case 5: BL+TR neg
const SADDLE_5A = [[0, 3], [2, 1]];   // centre positive  → two separate regions
const SADDLE_5B = [[0, 1], [2, 3]];   // centre negative  → connected

// Saddle case 10: BR+TL neg
const SADDLE_10A = [[1, 0], [3, 2]];  // centre positive
const SADDLE_10B = [[1, 2], [3, 0]];  // centre negative

// Edge interpolation: given two corner values, compute t ∈ [0,1] where zero crossing is
function edgeT(v0, v1) {
  const d = v0 - v1;
  return Math.abs(d) < 1e-12 ? 0.5 : v0 / d;
}

// Edge endpoint coordinates (in cell-local coords, cell origin = (x,y) = top-left corner)
// Returns { x0,y0, x1,y1 } of the edge, and (t) gives the interpolated point
// Edge 0=bottom: (x,y+1)→(x+1,y+1)
// Edge 1=right:  (x+1,y+1)→(x+1,y)
// Edge 2=top:    (x+1,y)→(x,y)
// Edge 3=left:   (x,y)→(x,y+1)
function edgePoint(edge, t, cellX, cellY) {
  switch (edge) {
    case 0: return { x: cellX + t,       y: cellY + 1     };
    case 1: return { x: cellX + 1,       y: cellY + 1 - t };
    case 2: return { x: cellX + 1 - t,   y: cellY         };
    case 3: return { x: cellX,           y: cellY + t     };
  }
}

// ── Main extraction ────────────────────────────────────────────────────────

/**
 * extractRawSegments
 * Produces flat array of {x0,y0,x1,y1} segments.
 * @param {Float32Array} phi   — w×h signed distance field
 * @param {number}       w
 * @param {number}       h
 * @returns {{ ax: Float32Array, ay: Float32Array, bx: Float32Array, by: Float32Array }}
 */
function extractRawSegments(phi, w, h) {
  const maxSegs = (w - 1) * (h - 1) * 2;
  const ax = new Float32Array(maxSegs);
  const ay = new Float32Array(maxSegs);
  const bx = new Float32Array(maxSegs);
  const by = new Float32Array(maxSegs);
  let count = 0;

  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      // Corner values: BL, BR, TR, TL
      const vBL = phi[ y      * w +  x   ];
      const vBR = phi[ y      * w + (x+1)];
      const vTR = phi[(y+1)   * w + (x+1)];
      const vTL = phi[(y+1)   * w +  x   ];

      // Case index: BL*1 + BR*2 + TR*4 + TL*8
      const sBL = vBL < 0 ? 1 : 0;
      const sBR = vBR < 0 ? 1 : 0;
      const sTR = vTR < 0 ? 1 : 0;
      const sTL = vTL < 0 ? 1 : 0;
      const caseIdx = sBL | (sBR << 1) | (sTR << 2) | (sTL << 3);

      let pairs = MS_CASES[caseIdx];

      // Resolve saddle cases
      if (pairs === null) {
        const centre = (vBL + vBR + vTR + vTL) * 0.25;
        if (caseIdx === 5) {
          pairs = centre < 0 ? SADDLE_5B : SADDLE_5A;
        } else {
          pairs = centre < 0 ? SADDLE_10B : SADDLE_10A;
        }
      }

      if (pairs.length === 0) continue;

      // Corner values per edge endpoint
      const cornerVals = [vBL, vBR, vTR, vTL];
      // Edge: 0=BL→BR, 1=BR→TR, 2=TR→TL, 3=TL→BL
      const edgeStart = [0, 1, 2, 3]; // corner indices for edge start
      const edgeEnd   = [1, 2, 3, 0]; // corner indices for edge end

      for (const [eA, eB] of pairs) {
        const tA = edgeT(cornerVals[edgeStart[eA]], cornerVals[edgeEnd[eA]]);
        const tB = edgeT(cornerVals[edgeStart[eB]], cornerVals[edgeEnd[eB]]);
        const pA = edgePoint(eA, tA, x, y);
        const pB = edgePoint(eB, tB, x, y);
        ax[count] = pA.x; ay[count] = pA.y;
        bx[count] = pB.x; by[count] = pB.y;
        count++;
      }
    }
  }

  return {
    ax: ax.subarray(0, count),
    ay: ay.subarray(0, count),
    bx: bx.subarray(0, count),
    by: by.subarray(0, count),
    count
  };
}

// ── Segment chaining ───────────────────────────────────────────────────────

const CHAIN_EPS = 0.5;  // pixel units — endpoints closer than this are the same point

/**
 * chainSegments
 * Connects raw segments end-to-end into polylines.
 * Returns array of { points: number[][], closed: boolean }
 */
function chainSegments(segs) {
  const { ax, ay, bx, by, count } = segs;
  if (count === 0) return [];

  // Build endpoint adjacency map using grid buckets for O(N) performance
  // Key: `${Math.round(x/CHAIN_EPS)},${Math.round(y/CHAIN_EPS)}`
  // Value: [{ segIdx, endpoint: 'a'|'b' }]
  const bucket = new Map();

  const key = (x, y) =>
    `${Math.round(x / CHAIN_EPS)},${Math.round(y / CHAIN_EPS)}`;

  for (let i = 0; i < count; i++) {
    const ka = key(ax[i], ay[i]);
    const kb = key(bx[i], by[i]);
    if (!bucket.has(ka)) bucket.set(ka, []);
    if (!bucket.has(kb)) bucket.set(kb, []);
    bucket.get(ka).push({ segIdx: i, end: 0 });
    bucket.get(kb).push({ segIdx: i, end: 1 });
  }

  const used   = new Uint8Array(count);
  const chains = [];

  for (let start = 0; start < count; start++) {
    if (used[start]) continue;

    // Build chain starting from segment `start`, growing in both directions
    const chain = [];  // ordered list of { x, y } points

    // Forward direction: start from B endpoint of `start`, chain forward
    chain.push({ x: ax[start], y: ay[start] });
    chain.push({ x: bx[start], y: by[start] });
    used[start] = 1;

    let extended = true;
    while (extended) {
      extended = false;
      const tail = chain[chain.length - 1];
      const candidates = bucket.get(key(tail.x, tail.y)) ?? [];
      for (const { segIdx, end } of candidates) {
        if (used[segIdx]) continue;
        used[segIdx] = 1;
        extended = true;
        if (end === 0) {
          chain.push({ x: bx[segIdx], y: by[segIdx] });
        } else {
          chain.push({ x: ax[segIdx], y: ay[segIdx] });
        }
        break;
      }
    }

    // Backward direction: grow from head of chain
    extended = true;
    while (extended) {
      extended = false;
      const head = chain[0];
      const candidates = bucket.get(key(head.x, head.y)) ?? [];
      for (const { segIdx, end } of candidates) {
        if (used[segIdx]) continue;
        used[segIdx] = 1;
        extended = true;
        if (end === 1) {
          chain.unshift({ x: ax[segIdx], y: ay[segIdx] });
        } else {
          chain.unshift({ x: bx[segIdx], y: by[segIdx] });
        }
        break;
      }
    }

    // Check if closed
    const head = chain[0], tail = chain[chain.length - 1];
    const dx = head.x - tail.x, dy = head.y - tail.y;
    const closed = Math.sqrt(dx * dx + dy * dy) < CHAIN_EPS * 2;

    // Convert to flat Float32Array
    const pts = new Float32Array(chain.length * 2);
    for (let i = 0; i < chain.length; i++) {
      pts[i * 2]     = chain[i].x;
      pts[i * 2 + 1] = chain[i].y;
    }

    chains.push({ points: pts, closed });
  }

  return chains;
}

// ── Signed area (shoelace) ─────────────────────────────────────────────────

function signedArea(points) {
  const n = points.length / 2;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j  = (i + 1) % n;
    area += points[i * 2]     * points[j * 2 + 1];
    area -= points[j * 2]     * points[i * 2 + 1];
  }
  return area * 0.5;
}

function polylineLength(points) {
  const n = points.length / 2;
  let len = 0;
  for (let i = 0; i < n - 1; i++) {
    const dx = points[(i+1)*2] - points[i*2];
    const dy = points[(i+1)*2+1] - points[i*2+1];
    len += Math.sqrt(dx*dx + dy*dy);
  }
  return len;
}

// ── Point-in-polygon (ray casting) ────────────────────────────────────────

function pointInPolygon(px, py, polyPoints) {
  const n = polyPoints.length / 2;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polyPoints[i * 2], yi = polyPoints[i * 2 + 1];
    const xj = polyPoints[j * 2], yj = polyPoints[j * 2 + 1];
    const intersect = ((yi > py) !== (yj > py)) &&
                      (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// ── Component assignment ───────────────────────────────────────────────────

function assignComponent(points, componentMap, w) {
  // Use centroid of loop points
  const n = points.length / 2;
  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) { cx += points[i*2]; cy += points[i*2+1]; }
  cx /= n; cy /= n;
  const px = Math.max(0, Math.min(w - 1, Math.round(cx)));
  const py = Math.max(0, Math.min(w - 1, Math.round(cy)));
  return componentMap ? componentMap[py * w + px] : -1;
}

// ── Main organise function ─────────────────────────────────────────────────

/**
 * organiseZeroCurve
 *
 * @param {Float32Array} phi            — w×h SDF
 * @param {number}       w
 * @param {number}       h
 * @param {Int32Array|null} componentMap — per-pixel component label (from Stage 4A)
 * @param {number}       b0              — from Stage 4A betti
 * @param {number}       b1
 * @returns {ZeroCurve}
 */
export function organiseZeroCurve(phi, w, h, componentMap, b0, b1) {
  // Step 1: extract raw segments
  const rawSegs = extractRawSegments(phi, w, h);

  // Step 2: chain into polylines
  const chains = chainSegments(rawSegs);

  const closedChains = chains.filter(c => c.closed);
  const openChains   = chains.filter(c => !c.closed);

  // Step 3: compute signed areas and classify
  const loops = closedChains.map((c, idx) => {
    const area = signedArea(c.points);
    return {
      idx,
      points:     c.points,
      isHole:     area < 0,
      area:       Math.abs(area),
      signedArea: area,
      component:  assignComponent(c.points, componentMap, w),
      length:     polylineLength(c.points),
      nestParent: null
    };
  });

  // Step 4: nesting detection
  // For each hole, find the smallest outer loop that contains it
  const outerLoops = loops.filter(l => !l.isHole);
  const holeLoops  = loops.filter(l =>  l.isHole);

  for (const hole of holeLoops) {
    // Test representative point (first point of hole)
    const testX = hole.points[0], testY = hole.points[1];
    let bestOuter = null, bestArea = Infinity;
    for (const outer of outerLoops) {
      if (outer.area < hole.area) continue;  // outer must be larger
      if (pointInPolygon(testX, testY, outer.points)) {
        if (outer.area < bestArea) { bestArea = outer.area; bestOuter = outer; }
      }
    }
    if (bestOuter) hole.nestParent = bestOuter.idx;
  }

  // Step 5: open arcs
  const arcs = openChains.map(c => ({
    points:    c.points,
    component: assignComponent(c.points, componentMap, w),
    length:    polylineLength(c.points)
  }));

  // Step 6: topological consistency check
  const expectedLoops      = (b0 ?? 1) + (b1 ?? 0);
  const topologyConsistent = (loops.length === expectedLoops) && (arcs.length === 0);

  // Clean up intermediate idx fields
  for (const l of loops) delete l.idx;

  return {
    loops,
    arcs,
    topologyConsistent,
    expectedLoops,
    b0: b0 ?? 1,
    b1: b1 ?? 0,
    rawSegmentCount: rawSegs.count,
    chainCount:      chains.length
  };
}

export default organiseZeroCurve;