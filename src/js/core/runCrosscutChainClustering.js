// /src/js/core/runCrosscutChainClustering.js
//
// Shared topological core used by both PrimeEnds and LipschitzQuaternionEnds.
//
// Algorithm:
//   1. For each component, sample endpoint pairs from boundary nodes
//      using the provided sampling bias weights.
//   2. For each pair, run bidirectional Dijkstra to get a cross-cut path.
//   3. Flood-fill from the nearest anchor node with the path blocked.
//      If fill area < areaThreshold × narrowBandSize → valid cut.
//   4. Group valid cuts by their associated anchor node.
//      Sort per anchor by enclosed area (ascending = innermost first).
//   5. Build nested chains: each cut's flood ⊆ next cut's flood.
//   6. Cluster chains into equivalence classes (IoU of innermost floods).
//   7. Assign each narrow-band node to the smallest containing flood.
//      Unassigned → outer class (id=0).
//
// Three independent sampling passes (fixed RNG seeds) are run and their
// chains are unioned before clustering, improving coverage.

import { bidirectionalDijkstra, bfsFloodFill } from './PixelGraph.js';

// ── Deterministic LCG RNG ─────────────────────────────────────────────────
function makeLCG(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xFFFFFFFF;
  };
}

// ── Weighted random sample without replacement ────────────────────────────
// Returns an array of `count` indices sampled from weights[] (unnormalised).
function weightedSampleWOR(weights, count, rng) {
  // Gumbel-max trick: assign score = log(weight) − log(−log(U)) per item,
  // return indices of top `count` scores. O(N log N) via sort.
  const n = weights.length;
  const scores = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const u = Math.max(1e-15, rng());
    scores[i] = weights[i] > 0 ? Math.log(weights[i]) - Math.log(-Math.log(u)) : -Infinity;
  }
  const idx = Array.from({ length: n }, (_, i) => i);
  idx.sort((a, b) => scores[b] - scores[a]);
  return idx.slice(0, Math.min(count, n));
}

// ── Flood region IoU ──────────────────────────────────────────────────────
function floodIoU(setA, setB, graphN) {
  // setA, setB: Int32Array of node indices
  // Build bitsets using Uint8Array as presence flags
  const presA = new Uint8Array(graphN);
  for (const n of setA) presA[n] = 1;
  let inter = 0, union_ = setA.length;
  for (const n of setB) {
    if (presA[n]) inter++;
    else union_++;
  }
  return union_ === 0 ? 0 : inter / union_;
}

// ── Spatial containment check ─────────────────────────────────────────────
// Returns true if every node in smaller is also in larger.
// Approximate (sample-based) for performance: checks up to maxCheck nodes.
function isApproxContained(smaller, larger, graphN, maxCheck = 200) {
  const presLarger = new Uint8Array(graphN);
  for (const n of larger) presLarger[n] = 1;
  const step = Math.max(1, (smaller.length / maxCheck) | 0);
  for (let i = 0; i < smaller.length; i += step) {
    if (!presLarger[smaller[i]]) return false;
  }
  return true;
}

// ── Build sampling bias weights ───────────────────────────────────────────
// biasNodes: Int32Array of node indices that should receive boosted weight.
// gamma:     multiplier for bias nodes.
// boundaryNodes: all boundary nodes for this component.
function buildSamplingWeights(boundaryNodes, biasNodes, gamma, graphN) {
  const weights = new Float32Array(boundaryNodes.length).fill(1.0);
  if (!biasNodes || biasNodes.length === 0) return weights;
  const inBias = new Uint8Array(graphN);
  for (const n of biasNodes) inBias[n] = 1;
  for (let i = 0; i < boundaryNodes.length; i++) {
    if (inBias[boundaryNodes[i]]) weights[i] = gamma;
  }
  return weights;
}

// ── Mark path as blocked ──────────────────────────────────────────────────
// Returns a Uint8Array(nodeCount) with path nodes set to 1.
function pathToBlockedMask(path, graphN) {
  const blocked = new Uint8Array(graphN);
  for (const n of path) blocked[n] = 1;
  return blocked;
}

// ── Find nearest anchor to path midpoint ─────────────────────────────────
function nearestAnchor(path, anchorNodes, G) {
  if (!anchorNodes || anchorNodes.length === 0) return -1;
  const midNode = path[(path.length / 2) | 0];
  const midPx   = G.nodeToPixel(midNode);
  const w       = G.resolution;
  const mx      = midPx % w, my = (midPx / w) | 0;
  let bestAnchor = anchorNodes[0], bestDist = Infinity;
  for (const an of anchorNodes) {
    const apx = G.nodeToPixel(an);
    const ax  = apx % w, ay = (apx / w) | 0;
    const d   = (ax - mx) ** 2 + (ay - my) ** 2;
    if (d < bestDist) { bestDist = d; bestAnchor = an; }
  }
  return bestAnchor;
}

// ── Flood fill from anchor side of cut ───────────────────────────────────
// Tries flood from each side of the cut midpoint, picks the smaller fill.
function floodFromCutSide(path, G, maxArea) {
  const N       = G.nodeCount;
  const blocked = pathToBlockedMask(path, N);

  // Pick two candidate start nodes adjacent to midpoint but not on path
  const mid = path[(path.length / 2) | 0];
  const adjPtr    = G._adjPtr;
  const adjNodeA  = G._adjNode;

  const candidates = [];
  for (let ei = adjPtr[mid]; ei < adjPtr[mid + 1]; ei++) {
    const nb = adjNodeA[ei];
    if (!blocked[nb]) candidates.push(nb);
  }

  if (candidates.length === 0) return null;

  // Try both sides, keep smaller flood
  let best = null;
  const tried = new Set();
  for (const start of candidates) {
    if (tried.has(start)) continue;
    tried.add(start);
    const fill = bfsFloodFill(G, start, blocked, maxArea);
    if (fill === null) continue;           // exceeded maxArea — cut invalid
    if (best === null || fill.length < best.length) best = fill;
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────
// Main exported function
// ─────────────────────────────────────────────────────────────────────────

/**
 * runCrosscutChainClustering
 *
 * @param {import('./PixelGraph.js').PixelGraph} G
 * @param {Int32Array}   anchorNodes    — per-component preferred anchor nodes
 *                                        (curvature peaks for PE, seed nodes for LQE)
 * @param {number}       budget         — total cross-cut attempts across all components
 * @param {object}       flags
 * @param {boolean}      [flags.debugLog=false]
 * @returns {TopologicalStructure}
 *
 * TopologicalStructure = {
 *   ends:         End[],         // prime-end / Lipschitz-end objects
 *   nodeEndMap:   Int32Array,    // length G.nodeCount; -1=unclassified, 0=outer, ≥1=end id
 *   chains:       Chain[],       // all validated chains (for diagnostics)
 *   diagnostics:  object
 * }
 */
export function runCrosscutChainClustering(G, anchorNodes, budget, flags = {}) {
  const N             = G.nodeCount;
  const narrowBandSz  = N;
  const gamma         = flags.topoVertexBiasGamma ?? 3.0;
  const nestThresh    = flags.topoNestThresh      ?? 0.9;
  const areaThreshFrac= flags.topoAreaThresh      ?? 0.2;
  const maxFloodArea  = Math.ceil(narrowBandSz * areaThreshFrac);
  const chainIoUThresh= flags.topoChainIoUThresh  ?? 0.7;
  const minEndAreaFrac= flags.topoMinEndAreaFrac  ?? 0.005;
  const minEndArea    = Math.max(1, Math.ceil(narrowBandSz * minEndAreaFrac));
  const debug         = !!flags.debugLog;

  const components    = G.boundaryComponents;
  // Distribute budget proportionally to boundary-node count per component
  const compBudgets   = new Map();
  let   totalBdry     = 0;
  for (const c of components) totalBdry += G.boundaryNodesInComponent(c).length;
  for (const c of components) {
    const bNodes = G.boundaryNodesInComponent(c);
    compBudgets.set(c, Math.max(2, Math.round(budget * bNodes.length / Math.max(totalBdry, 1))));
  }

  // ── Three-pass union of cross-cuts ─────────────────────────────────────
  // Fixed seeds for reproducibility across frames
  const PASS_SEEDS  = [0x1A2B3C, 0x4D5E6F, 0x7A8B9C];
  const allCuts     = [];   // { path, floodNodes, anchorNode, area, comp }

  for (const passSeed of PASS_SEEDS) {
    const rng = makeLCG(passSeed);

    for (const comp of components) {
      const bNodes  = G.boundaryNodesInComponent(comp);
      if (bNodes.length < 2) continue;

      // Anchor nodes belonging to this component
      const compAnchors = anchorNodes
        ? anchorNodes.filter(n => G.componentOf(n) === comp)
        : [];

      const weights = buildSamplingWeights(bNodes, compAnchors, gamma, N);
      const bgt     = compBudgets.get(comp) ?? 2;

      // Sample endpoint pairs (2× budget, half will fail validity)
      const sampled = weightedSampleWOR(weights, Math.min(bNodes.length, bgt * 2), rng);

      // Pair consecutive sampled nodes (simple pairing strategy)
      for (let pi = 0; pi + 1 < sampled.length && allCuts.length < budget * 3; pi += 2) {
        const src = bNodes[sampled[pi]];
        const dst = bNodes[sampled[pi + 1]];

        if (G.componentOf(src) !== G.componentOf(dst)) continue;

        const result = bidirectionalDijkstra(G, src, dst, null);
        if (!result) continue;

        const floodNodes = floodFromCutSide(result.path, G, maxFloodArea);
        if (!floodNodes) continue;   // null = exceeded maxFloodArea → invalid

        const anchor = nearestAnchor(result.path, compAnchors, G);

        allCuts.push({
          path:       result.path,
          floodNodes,
          anchorNode: anchor,
          area:       floodNodes.length,
          comp,
          passIdx:    PASS_SEEDS.indexOf(passSeed)
        });
      }
    }
  }

  // ── Homology ring cuts for b1 > 0 ─────────────────────────────────────
  // For each cycle in the graph (identified by back-edge cycle basis),
  // force a cross-cut that straddles that cycle.
  // We approximate this by finding pairs of boundary nodes on opposite
  // sides of each back-edge and adding them as mandatory cuts.
  //
  // (Full cycle basis recovery is expensive; we use the heuristic that
  // the two endpoints of a back-edge tend to be on opposite sides of
  // the cycle it closes.)
  if (G.cycleCount > 0 && G._adjPtr) {
    const adjPtr    = G._adjPtr;
    const adjNodeA  = G._adjNode;
    const visited   = new Uint8Array(N);
    const parent    = new Int32Array(N).fill(-1);

    // Simple DFS tree to find back-edges
    const backEdgePairs = [];
    const stack = [];
    for (const comp of components) {
      const bNodes = G.boundaryNodesInComponent(comp);
      if (bNodes.length === 0) continue;
      const root = bNodes[0];
      if (visited[root]) continue;
      stack.push(root);
      while (stack.length > 0) {
        const node = stack.pop();
        if (visited[node]) continue;
        visited[node] = 1;
        for (let ei = adjPtr[node]; ei < adjPtr[node + 1]; ei++) {
          const nb = adjNodeA[ei];
          if (!visited[nb]) { parent[nb] = node; stack.push(nb); }
          else if (parent[node] !== nb && backEdgePairs.length < G.cycleCount) {
            backEdgePairs.push([node, nb]);
          }
        }
      }
    }

    for (const [a, b] of backEdgePairs) {
      if (G.componentOf(a) !== G.componentOf(b)) continue;
      const result = bidirectionalDijkstra(G, a, b, null);
      if (!result) continue;
      const floodNodes = floodFromCutSide(result.path, G, maxFloodArea);
      if (!floodNodes) continue;
      allCuts.push({
        path:       result.path,
        floodNodes,
        anchorNode: nearestAnchor(result.path, anchorNodes, G),
        area:       floodNodes.length,
        comp:       G.componentOf(a),
        passIdx:    -1   // mandatory ring cut
      });
    }
  }

  // ── Mandatory per-anchor cuts ──────────────────────────────────────────
  // Guarantee at least one cut per anchor node, even if random sampling
  // missed it. For each anchor, find the nearest two boundary nodes in
  // its component and force a cut between them.
  if (anchorNodes && anchorNodes.length > 0) {
    for (const anchor of anchorNodes) {
      const comp   = G.componentOf(anchor);
      const bNodes = G.boundaryNodesInComponent(comp);
      if (bNodes.length < 2) continue;

      // Already have a cut for this anchor?
      const hasCut = allCuts.some(c => c.anchorNode === anchor);
      if (hasCut) continue;

      // Find two boundary nodes nearest to anchor
      const aPx   = G.nodeToPixel(anchor);
      const w     = G.resolution;
      const ax    = aPx % w, ay = (aPx / w) | 0;

      const dists = bNodes.map(n => {
        const px = G.nodeToPixel(n);
        return (px % w - ax) ** 2 + ((px / w | 0) - ay) ** 2;
      });
      const sorted = Array.from({ length: bNodes.length }, (_, i) => i)
                         .sort((a, b) => dists[a] - dists[b]);

      const src = bNodes[sorted[0]];
      const dst = bNodes[sorted[Math.min(sorted.length - 1, 4)]];
      if (src === dst) continue;

      const result = bidirectionalDijkstra(G, src, dst, null);
      if (!result) continue;
      const floodNodes = floodFromCutSide(result.path, G, maxFloodArea);
      if (!floodNodes) continue;
      allCuts.push({
        path:       result.path,
        floodNodes,
        anchorNode: anchor,
        area:       floodNodes.length,
        comp,
        passIdx:    -2   // mandatory anchor cut
      });
    }
  }

  if (debug) console.log(`[CrosscutChain] Total valid cuts: ${allCuts.length}`);

  // ── Group cuts by anchor, sort by area (ascending = innermost) ─────────
  const anchorCutsMap = new Map();    // anchorNode → Cut[]
  const noAnchorCuts  = [];

  for (const cut of allCuts) {
    const an = cut.anchorNode;
    if (an < 0) { noAnchorCuts.push(cut); continue; }
    if (!anchorCutsMap.has(an)) anchorCutsMap.set(an, []);
    anchorCutsMap.get(an).push(cut);
  }
  for (const cuts of anchorCutsMap.values()) {
    cuts.sort((a, b) => a.area - b.area);
  }

  // ── Build nested chains per anchor ─────────────────────────────────────
  const allChains = [];   // { anchorNode, cuts: Cut[], depth: number }

  for (const [anchor, cuts] of anchorCutsMap) {
    if (cuts.length === 0) continue;

    // Greedy nesting: walk outward from innermost cut
    const chain = [cuts[0]];
    for (let ci = 1; ci < cuts.length; ci++) {
      const outer = cuts[ci];
      const inner = chain[chain.length - 1];
      // Nesting test: area ratio + spatial containment
      const areaRatioOk = inner.area / outer.area < nestThresh;
      const containOk   = isApproxContained(inner.floodNodes, outer.floodNodes, N);
      // Allow 5% violation on area ratio if spatial containment holds
      const areaRelax   = inner.area / outer.area < (nestThresh * 1.05);
      if ((areaRatioOk || areaRelax) && containOk) {
        chain.push(outer);
      }
    }

    allChains.push({ anchorNode: anchor, cuts: chain, depth: chain.length });
  }

  // Also add cuts with no anchor as singleton chains
  for (const cut of noAnchorCuts) {
    allChains.push({ anchorNode: -1, cuts: [cut], depth: 1 });
  }

  if (debug) console.log(`[CrosscutChain] Chains built: ${allChains.length}`);

  // ── Chain equivalence clustering (IoU of innermost floods) ────────────
  const chainCount = allChains.length;
  // Union-Find over chains
  const chainUF = Array.from({ length: chainCount }, (_, i) => i);
  const chainFind = (x) => {
    while (chainUF[x] !== x) { chainUF[x] = chainUF[chainUF[x]]; x = chainUF[x]; }
    return x;
  };

  for (let i = 0; i < chainCount; i++) {
    for (let j = i + 1; j < chainCount; j++) {
      if (chainFind(i) === chainFind(j)) continue;
      const fi = allChains[i].cuts[0].floodNodes;
      const fj = allChains[j].cuts[0].floodNodes;
      if (floodIoU(fi, fj, N) >= chainIoUThresh) {
        chainUF[chainFind(i)] = chainFind(j);
      }
    }
  }

  // Collect equivalence classes
  const classMap = new Map();
  for (let i = 0; i < chainCount; i++) {
    const root = chainFind(i);
    if (!classMap.has(root)) classMap.set(root, []);
    classMap.get(root).push(allChains[i]);
  }

  // ── Build End objects from equivalence classes ─────────────────────────
  let endIdCounter = 1;  // 0 = outer class
  const ends = [];

  for (const [, chainGroup] of classMap) {
    // Representative chain: deepest (most nested)
    const repChain = chainGroup.reduce((best, c) =>
      c.depth > best.depth ? c : best, chainGroup[0]);

    // Pixel support = union of all cuts' flood regions in this class
    const supportSet = new Set();
    for (const chain of chainGroup) {
      for (const cut of chain.cuts) {
        for (const n of cut.floodNodes) supportSet.add(n);
      }
    }

    if (supportSet.size < minEndArea) continue;   // spatial persistence filter

    // Anchor = most common anchor node in group
    const anchorVotes = new Map();
    for (const chain of chainGroup) {
      const an = chain.anchorNode;
      if (an >= 0) anchorVotes.set(an, (anchorVotes.get(an) ?? 0) + chain.depth);
    }
    let bestAnchor = -1, bestVote = -1;
    for (const [an, v] of anchorVotes) {
      if (v > bestVote) { bestVote = v; bestAnchor = an; }
    }

    const pixelIndices = new Int32Array([...supportSet]);

    ends.push({
      id:                   endIdCounter++,
      anchorNode:           bestAnchor,
      anchorPixel:          bestAnchor >= 0 ? G.nodeToPixel(bestAnchor) : -1,
      pixelIndices,
      representativeCuts:   repChain.cuts.slice(0, 3).map(c => ({
        srcNode: c.path[0],
        dstNode: c.path[c.path.length - 1],
        pathLength: c.path.length,
        area: c.area
      })),
      areaFraction:         supportSet.size / narrowBandSz,
      chainDepth:           repChain.depth,
      persistenceScore:     1.0,
      birthFrame:           -1    // set by caller
    });
  }

  // ── Per-node assignment (smallest containing flood) ────────────────────
  const nodeEndMap = new Int32Array(N).fill(-1);   // -1 = unclassified

  // For each end, sorted by ascending area (smallest = most specific)
  const endsSortedByArea = [...ends].sort((a, b) => a.pixelIndices.length - b.pixelIndices.length);

  for (const end of endsSortedByArea) {
    for (const n of end.pixelIndices) {
      if (nodeEndMap[n] === -1) nodeEndMap[n] = end.id;
    }
  }

  // Remaining narrow-band nodes → outer class (id=0)
  for (let i = 0; i < N; i++) {
    if (nodeEndMap[i] === -1) nodeEndMap[i] = 0;
  }

  // ── Diagnostics ─────────────────────────────────────────────────────────
  let unassigned = 0;
  for (let i = 0; i < N; i++) if (nodeEndMap[i] < 0) unassigned++;

  const diagnostics = {
    totalCuts:       allCuts.length,
    chainsBuilt:     allChains.length,
    endsProduced:    ends.length,
    unassignedNodes: unassigned,
    passBreakdown: {
      pass0: allCuts.filter(c => c.passIdx === 0).length,
      pass1: allCuts.filter(c => c.passIdx === 1).length,
      pass2: allCuts.filter(c => c.passIdx === 2).length,
      ringCuts: allCuts.filter(c => c.passIdx === -1).length,
      anchorCuts: allCuts.filter(c => c.passIdx === -2).length
    }
  };

  // ── Multiplicity second-pass ──────────────────────────────────────────
  // Multiplicity of an end = number of ends sharing the same anchorNode.
  // Required by Stage 5 computeStructureId() — without this field,
  // the structureId hash cannot distinguish [1,1,2] from [1,1,1].
  // Placed after ends[] is fully assembled so all anchorNode values
  // are final and the count is accurate.
  {
    const anchorEndCount = new Map();
    for (const end of ends) {
      const an = end.anchorNode;
      if (an >= 0) anchorEndCount.set(an, (anchorEndCount.get(an) ?? 0) + 1);
    }
    for (const end of ends) {
      end.multiplicity = end.anchorNode >= 0
        ? (anchorEndCount.get(end.anchorNode) ?? 1)
        : 1;
    }
  }

  return { ends, nodeEndMap, chains: allChains, diagnostics };
}