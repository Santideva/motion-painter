// /src/js/core/PixelGraph.js
//
// Shared weighted pixel graph for Stage 4A topology modules.
//
// Constructs a narrow-band graph from three gradient sources:
//   primary  (0.6) — directional field Sobel magnitude
//   secondary (0.3) — |kH| level-set curvature
//   tertiary (0.1)  — |normalCurl| geometric crease signal
//
// Exposes:
//   - CSR adjacency (adjPtr, adjNode, adjWeight) for Dijkstra
//   - Union-Find component labels (b0, b1, χ)
//   - Boundary node list (SDF sign-crossing pixels within narrow band)
//   - Per-component boundary node lists for constrained sampling
//
// Shared between PrimeEnds and LipschitzQuaternionEnds — both receive the
// SAME instance so graph identity is guaranteed.

// ────────────────────────────────────────────────────────────────────────────
// Binary Min-Heap (used by bidirectionalDijkstra)
// ────────────────────────────────────────────────────────────────────────────
class MinHeap {
  constructor() { this._h = []; }
  get size() { return this._h.length; }
  peek() { return this._h[0]; }

  push(dist, node) {
    this._h.push({ dist, node });
    this._up(this._h.length - 1);
  }

  pop() {
    const top  = this._h[0];
    const last = this._h.pop();
    if (this._h.length > 0) { this._h[0] = last; this._dn(0); }
    return top;
  }

  _up(i) {
    const h = this._h;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p].dist <= h[i].dist) break;
      const tmp = h[p]; h[p] = h[i]; h[i] = tmp;
      i = p;
    }
  }

  _dn(i) {
    const h = this._h, n = h.length;
    for (;;) {
      let s = i, l = 2*i+1, r = 2*i+2;
      if (l < n && h[l].dist < h[s].dist) s = l;
      if (r < n && h[r].dist < h[s].dist) s = r;
      if (s === i) break;
      const tmp = h[s]; h[s] = h[i]; h[i] = tmp;
      i = s;
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Bidirectional Dijkstra (exported for use by runCrosscutChainClustering)
// ────────────────────────────────────────────────────────────────────────────
/**
 * bidirectionalDijkstra
 *
 * Simultaneous forward (from src) + backward (from dst) Dijkstra on an
 * undirected graph. Terminates when the sum of the two frontier distances
 * exceeds the current best path. Returns null if no path exists.
 *
 * @param {PixelGraph} G
 * @param {number}     srcNode  — graph node index
 * @param {number}     dstNode  — graph node index
 * @param {Uint8Array} blocked  — length G.nodeCount; blocked[i]=1 means node i is impassable
 * @returns {{ path: Int32Array, dist: number } | null}
 */
export function bidirectionalDijkstra(G, srcNode, dstNode, blocked) {
  if (srcNode === dstNode) return null;

  const N   = G.nodeCount;
  const INF = Infinity;
  const adjPtr    = G._adjPtr;
  const adjNodeA  = G._adjNode;
  const adjWeight = G._adjWeight;

  const distF    = new Float32Array(N).fill(INF);
  const distB    = new Float32Array(N).fill(INF);
  const parentF  = new Int32Array(N).fill(-1);
  const parentB  = new Int32Array(N).fill(-1);
  const settledF = new Uint8Array(N);
  const settledB = new Uint8Array(N);

  distF[srcNode] = 0;
  distB[dstNode] = 0;

  const qF = new MinHeap();
  const qB = new MinHeap();
  qF.push(0, srcNode);
  qB.push(0, dstNode);

  let bestDist = INF;
  let meetNode = -1;

  while (qF.size > 0 || qB.size > 0) {
    const topF = qF.size > 0 ? qF.peek().dist : INF;
    const topB = qB.size > 0 ? qB.peek().dist : INF;
    if (topF + topB >= bestDist) break;

    // Expand smaller frontier
    const expandFwd = topF <= topB && qF.size > 0;

    if (expandFwd) {
      const { dist, node } = qF.pop();
      if (settledF[node] || dist > distF[node]) continue;
      settledF[node] = 1;
      if (settledB[node] && distF[node] + distB[node] < bestDist) {
        bestDist = distF[node] + distB[node]; meetNode = node;
      }
      for (let ei = adjPtr[node]; ei < adjPtr[node + 1]; ei++) {
        const nb = adjNodeA[ei];
        if (blocked && blocked[nb]) continue;
        const nd = dist + adjWeight[ei];
        if (nd < distF[nb]) {
          distF[nb] = nd; parentF[nb] = node; qF.push(nd, nb);
        }
      }
    } else {
      const { dist, node } = qB.pop();
      if (settledB[node] || dist > distB[node]) continue;
      settledB[node] = 1;
      if (settledF[node] && distF[node] + distB[node] < bestDist) {
        bestDist = distF[node] + distB[node]; meetNode = node;
      }
      for (let ei = adjPtr[node]; ei < adjPtr[node + 1]; ei++) {
        const nb = adjNodeA[ei];
        if (blocked && blocked[nb]) continue;
        const nd = dist + adjWeight[ei];
        if (nd < distB[nb]) {
          distB[nb] = nd; parentB[nb] = node; qB.push(nd, nb);
        }
      }
    }
  }

  if (meetNode < 0 || bestDist === INF) return null;

  // Reconstruct: forward path from src → meetNode
  const fwdPath = [];
  for (let c = meetNode; c !== -1; c = parentF[c]) fwdPath.push(c);
  fwdPath.reverse();

  // Backward path from meetNode → dst (parent pointers point away from dst)
  const bwdPath = [];
  for (let c = parentB[meetNode]; c !== -1; c = parentB[c]) bwdPath.push(c);

  const full = new Int32Array(fwdPath.length + bwdPath.length);
  full.set(fwdPath, 0);
  full.set(bwdPath, fwdPath.length);

  return { path: full, dist: bestDist };
}

// ────────────────────────────────────────────────────────────────────────────
// BFS flood fill (exported)
// ────────────────────────────────────────────────────────────────────────────
/**
 * bfsFloodFill
 *
 * BFS from startNode treating blocked nodes as walls. Returns the set of
 * visited node indices as an Int32Array, or null if the region exceeds
 * maxArea nodes (early-termination optimisation for the validity check).
 *
 * @param {PixelGraph} G
 * @param {number}     startNode
 * @param {Uint8Array} blocked       — length G.nodeCount
 * @param {number}     [maxArea=Inf] — abort if more than maxArea nodes visited
 * @returns {Int32Array | null}
 */
export function bfsFloodFill(G, startNode, blocked, maxArea = Infinity) {
  if (blocked[startNode]) return null;
  const N       = G.nodeCount;
  const visited = new Uint8Array(N);
  const queue   = new Int32Array(N);
  let head = 0, tail = 0;

  visited[startNode] = 1;
  queue[tail++] = startNode;
  let count = 1;

  const adjPtr    = G._adjPtr;
  const adjNodeA  = G._adjNode;

  while (head < tail) {
    if (count > maxArea) return null;    // region too large — invalid cut
    const node = queue[head++];
    for (let ei = adjPtr[node]; ei < adjPtr[node + 1]; ei++) {
      const nb = adjNodeA[ei];
      if (visited[nb] || blocked[nb]) continue;
      visited[nb] = 1;
      queue[tail++] = nb;
      count++;
    }
  }

  const result = new Int32Array(count);
  let k = 0;
  for (let i = 0; i < N; i++) { if (visited[i]) result[k++] = i; }
  return result;
}

// ────────────────────────────────────────────────────────────────────────────
// PixelGraph
// ────────────────────────────────────────────────────────────────────────────
export class PixelGraph {
  /**
   * @param {object} opts
   * @param {Float32Array} opts.directionalField  res²×4
   * @param {Float32Array} opts.kH                res²  (may be null)
   * @param {Float32Array} opts.normalCurl        res²  (may be null)
   * @param {Float32Array} opts.narrowBandMask    res²  (>0 = in band)
   * @param {Float32Array} opts.signedSdf         res²
   * @param {number}       opts.resolution
   * @param {object}       [opts.flags={}]
   */
  constructor({ directionalField, kH, normalCurl, narrowBandMask,
                signedSdf, resolution, flags = {} }) {
    const w = resolution, h = resolution;
    this._w          = w;
    this._h          = h;
    this._resolution = resolution;
    this._flags      = flags;

    // ── 1. Fused gradient magnitude ───────────────────────────────────────
    this.fusedGradMag = this._computeFusedGradient(
      directionalField, kH, normalCurl, w, h, flags
    );

    // ── 2. Node map (narrow band restriction) ─────────────────────────────
    const count = w * h;
    const nodeMap  = new Int32Array(count).fill(-1);
    const nodeList = [];
    for (let i = 0; i < count; i++) {
      if (narrowBandMask[i] > 0) {
        nodeMap[i] = nodeList.length;
        nodeList.push(i);
      }
    }
    this._nodeMap = nodeMap;
    this._nodes   = new Int32Array(nodeList);   // node → pixel
    const N       = nodeList.length;

    // ── 3. CSR adjacency ──────────────────────────────────────────────────
    const lambda = flags.topoLambda ?? 5.0;
    const SQRT2  = Math.SQRT2;
    // 8-neighbor offsets and diagonal flags
    const DX   = [-1, 0, 1, -1, 1, -1, 0, 1];
    const DY   = [-1,-1,-1,  0, 0,  1, 1, 1];
    const DIAG = [ 1, 0, 1,  0, 0,  1, 0, 1];

    const deg = new Int32Array(N);
    for (let ni = 0; ni < N; ni++) {
      const px = nodeList[ni];
      const x  = px % w, y = (px / w) | 0;
      for (let d = 0; d < 8; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        if (nodeMap[ny * w + nx] >= 0) deg[ni]++;
      }
    }

    const adjPtr = new Int32Array(N + 1);
    for (let i = 0; i < N; i++) adjPtr[i + 1] = adjPtr[i] + deg[i];
    const E        = adjPtr[N];
    const adjNode  = new Int32Array(E);
    const adjWeight = new Float32Array(E);
    const fill     = new Int32Array(N);

    const fg = this.fusedGradMag;
    for (let ni = 0; ni < N; ni++) {
      const px = nodeList[ni];
      const x  = px % w, y = (px / w) | 0;
      for (let d = 0; d < 8; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const npx = ny * w + nx;
        const nni = nodeMap[npx];
        if (nni < 0) continue;
        const dist   = DIAG[d] ? SQRT2 : 1.0;
        const gradAv = (fg[px] + fg[npx]) * 0.5;
        const pos    = adjPtr[ni] + fill[ni]++;
        adjNode[pos]   = nni;
        adjWeight[pos] = dist * (1.0 + lambda * gradAv);
      }
    }

    this._adjPtr    = adjPtr;
    this._adjNode   = adjNode;
    this._adjWeight = adjWeight;

    // ── 4. Union-Find → b0, b1 ────────────────────────────────────────────
    const uf     = new Int32Array(N);
    for (let i = 0; i < N; i++) uf[i] = i;

    const find = (x) => {
      while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; } return x;
    };

    let treeEdges = 0, backEdges = 0;
    for (let ni = 0; ni < N; ni++) {
      for (let ei = adjPtr[ni]; ei < adjPtr[ni + 1]; ei++) {
        const nni = adjNode[ei];
        if (nni <= ni) continue;
        if (find(ni) !== find(nni)) { uf[find(ni)] = find(nni); treeEdges++; }
        else backEdges++;
      }
    }

    const compLabel = new Int32Array(N);
    const rootMap   = new Map();
    let   nextLabel = 0;
    for (let i = 0; i < N; i++) {
      const r = find(i);
      if (!rootMap.has(r)) rootMap.set(r, nextLabel++);
      compLabel[i] = rootMap.get(r);
    }

    this._componentLabel = compLabel;
    this._uf             = uf;
    this._find           = find;

    // b0 = components, b1 = independent cycles = backEdges
    this._b0 = nextLabel;
    this._b1 = backEdges;
    this._chi = this._b0 - this._b1;

    // ── 5. Boundary nodes (SDF sign-crossing) ─────────────────────────────
    this._boundaryNodes = this._findBoundaryNodes(signedSdf, nodeMap, nodeList, w, h);

    // ── 6. Per-component boundary node lists ──────────────────────────────
    this._compBoundaryMap = new Map();
    for (const ni of this._boundaryNodes) {
      const c = compLabel[ni];
      if (!this._compBoundaryMap.has(c)) this._compBoundaryMap.set(c, []);
      this._compBoundaryMap.get(c).push(ni);
    }
    // Convert to Int32Arrays
    for (const [c, arr] of this._compBoundaryMap) {
      this._compBoundaryMap.set(c, new Int32Array(arr));
    }
  }

  // ── Public accessors ────────────────────────────────────────────────────
  get nodeCount()         { return this._nodes.length; }
  get componentCount()    { return this._b0; }
  get cycleCount()        { return this._b1; }
  get eulerChar()         { return this._chi; }
  get boundaryNodes()     { return this._boundaryNodes; }
  get resolution()        { return this._resolution; }

  pixelToNode(px)         { return this._nodeMap[px]; }
  nodeToPixel(ni)         { return this._nodes[ni]; }
  componentOf(ni)         { return this._componentLabel[ni]; }

  /** Boundary nodes belonging to a given component label */
  boundaryNodesInComponent(compLabel) {
    return this._compBoundaryMap.get(compLabel) ?? new Int32Array(0);
  }

  /** All component labels that have ≥1 boundary node */
  get boundaryComponents() {
    return [...this._compBoundaryMap.keys()];
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  _computeFusedGradient(dirField, kH, normalCurl, w, h, flags) {
    const wDir  = flags.topoGradWeightDir  ?? 0.6;
    const wKH   = flags.topoGradWeightKH   ?? 0.3;
    const wCurl = flags.topoGradWeightCurl ?? 0.1;
    const count = w * h;

    // ── Directional field Sobel ──────────────────────────────────────────
    const gradDir = new Float32Array(count);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        let gxSq = 0, gySq = 0;
        for (let ch = 0; ch < 4; ch++) {
          const G = (dx, dy) => dirField[((y + dy) * w + (x + dx)) * 4 + ch];
          const gx = (-G(-1,-1) + G(1,-1) - 2*G(-1,0) + 2*G(1,0) - G(-1,1) + G(1,1)) / 8;
          const gy = (-G(-1,-1) - 2*G(0,-1) - G(1,-1) + G(-1,1) + 2*G(0,1) + G(1,1)) / 8;
          gxSq += gx * gx;
          gySq += gy * gy;
        }
        gradDir[i] = Math.sqrt((gxSq + gySq) / 4);
      }
    }

    // ── |kH| and |normalCurl| ────────────────────────────────────────────
    const gradKH   = new Float32Array(count);
    const gradCurl = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      gradKH[i]   = kH         ? Math.abs(kH[i])         : 0;
      gradCurl[i] = normalCurl ? Math.abs(normalCurl[i]) : 0;
    }

    // ── 99th-percentile normalisation (histogram approach) ───────────────
    const p99 = (arr) => {
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < count; i++) {
        if (arr[i] < mn) mn = arr[i];
        if (arr[i] > mx) mx = arr[i];
      }
      if (mx === mn) return Math.max(mx, 1e-6);
      const bins = 1000, hist = new Int32Array(bins);
      const range = mx - mn;
      for (let i = 0; i < count; i++) {
        const b = Math.min(bins - 1, ((arr[i] - mn) / range * bins) | 0);
        hist[b]++;
      }
      const target = count * 0.99;
      let cum = 0;
      for (let b = 0; b < bins; b++) {
        cum += hist[b];
        if (cum >= target) return mn + (b + 1) / bins * range;
      }
      return mx;
    };

    const p99dir  = p99(gradDir);
    const p99kh   = p99(gradKH);
    const p99curl = p99(gradCurl);

    const fused = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const d = Math.min(1.0, gradDir[i]   / p99dir);
      const k = Math.min(1.0, gradKH[i]    / p99kh);
      const c = Math.min(1.0, gradCurl[i]  / p99curl);
      fused[i] = wDir * d + wKH * k + wCurl * c;
    }
    return fused;
  }

  _findBoundaryNodes(signedSdf, nodeMap, nodeList, w, h) {
    const DX = [-1, 0, 1, -1, 1, -1, 0, 1];
    const DY = [-1,-1,-1,  0, 0,  1, 1, 1];
    const result = [];
    for (const px of nodeList) {
      const x = px % w, y = (px / w) | 0;
      const sv = signedSdf[px];
      for (let d = 0; d < 8; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const npx = ny * w + nx;
        if (nodeMap[npx] < 0) continue;
        if (sv * signedSdf[npx] < 0) { result.push(nodeMap[px]); break; }
      }
    }
    return new Int32Array(result);
  }
}

export default PixelGraph;