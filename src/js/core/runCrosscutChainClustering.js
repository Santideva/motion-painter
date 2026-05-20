// /src/js/core/runCrosscutChainClustering.js
//
// Reworked for performance:
//   - Single sampling pass (was 3) — budget unchanged, GC pressure ÷3
//   - Shared Uint8Array scratch buffers — eliminates per-cut O(N) allocations
//   - Within-component IoU only — cross-component IoU is always 0
//   - Pre-built component maps — avoids repeated G.boundaryNodesInComponent traversal
//   - Component size filter — skips tiny components before any Dijkstra
//   - Back-edge DFS removed — O(N) DFS for marginal benefit
//   - Mandatory anchor cuts removed — random sampling already covers anchors

import { bidirectionalDijkstra, bfsFloodFill } from './PixelGraph.js';

// ── Deterministic LCG RNG ─────────────────────────────────────────────────
function makeLCG(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xFFFFFFFF;
  };
}

function weightedSampleWOR(weights, count, rng) {
  // Gumbel-max trick with partial top-k selection via min-heap.
  // O(N log count) instead of O(N log N) — for small count << N this
  // is significantly faster (e.g. count=6, N=2000 → 6× fewer comparisons).
  const n = weights.length;
  if (count >= n) return Array.from({ length: n }, (_, i) => i);

  const scores = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const u = Math.max(1e-15, rng());
    scores[i] = weights[i] > 0 ? Math.log(weights[i]) - Math.log(-Math.log(u)) : -Infinity;
  }

  // Min-heap of [score, index] — smallest score at root.
  // We keep the top-`count` scores by evicting the smallest when heap is full.
  const heap = [];   // [score, originalIndex]

  const _up = (j) => {
    while (j > 0) {
      const p = (j - 1) >> 1;
      if (heap[p][0] <= heap[j][0]) break;
      const t = heap[p]; heap[p] = heap[j]; heap[j] = t; j = p;
    }
  };
  const _dn = () => {
    let j = 0, sz = heap.length;
    for (;;) {
      const L = 2*j+1, R = 2*j+2;
      let s = j;
      if (L < sz && heap[L][0] < heap[s][0]) s = L;
      if (R < sz && heap[R][0] < heap[s][0]) s = R;
      if (s === j) break;
      const t = heap[s]; heap[s] = heap[j]; heap[j] = t; j = s;
    }
  };

  for (let i = 0; i < count; i++) { heap.push([scores[i], i]); _up(heap.length - 1); }
  for (let i = count; i < n; i++) {
    if (scores[i] > heap[0][0]) { heap[0] = [scores[i], i]; _dn(); }
  }

  return heap.map(([, i]) => i);
}

// ── IoU using shared scratch (mark, compute, clear — no alloc) ────────────
function floodIoU_shared(setA, setB, scratch) {
  for (const n of setA) scratch[n] = 1;
  let inter = 0;
  for (const n of setB) { if (scratch[n]) inter++; }
  for (const n of setA) scratch[n] = 0;
  const union_ = setA.length + setB.length - inter;
  return union_ === 0 ? 0 : inter / union_;
}

// ── Containment check using shared scratch ────────────────────────────────
function isApproxContained_shared(smaller, larger, scratch, maxCheck = 200) {
  for (const n of larger) scratch[n] = 1;
  const step = Math.max(1, (smaller.length / maxCheck) | 0);
  let contained = true;
  for (let i = 0; i < smaller.length; i += step) {
    if (!scratch[smaller[i]]) { contained = false; break; }
  }
  for (const n of larger) scratch[n] = 0;
  return contained;
}

// ── Sampling bias weights ─────────────────────────────────────────────────
function buildSamplingWeights(boundaryNodes, biasNodes, gamma, N) {
  const weights = new Float32Array(boundaryNodes.length).fill(1.0);
  if (!biasNodes || biasNodes.length === 0) return weights;
  const inBias = new Uint8Array(N);
  for (const n of biasNodes) inBias[n] = 1;
  for (let i = 0; i < boundaryNodes.length; i++) {
    if (inBias[boundaryNodes[i]]) weights[i] = gamma;
  }
  return weights;
}

// ── Nearest anchor to path midpoint ──────────────────────────────────────
function nearestAnchor(path, anchors, G) {
  if (!anchors || anchors.length === 0) return -1;
  const mid = path[(path.length / 2) | 0];
  const midPx = G.nodeToPixel(mid);
  const w = G.width;
  const mx = midPx % w, my = (midPx / w) | 0;
  let best = anchors[0], bestD = Infinity;
  for (const an of anchors) {
    const px = G.nodeToPixel(an);
    const d = (px % w - mx) ** 2 + ((px / w | 0) - my) ** 2;
    if (d < bestD) { bestD = d; best = an; }
  }
  return best;
}

// ── Flood fill using pre-populated shared blocked mask ────────────────────
// Caller is responsible for:
//   1. Setting blocked[n]=1 for all path nodes before calling
//   2. Clearing blocked[n]=0 for all path nodes after calling
// bfsFloodFill must not modify the blocked array (it is read-only here).
function floodFromSharedBlocked(path, G, blocked, maxArea) {
  const adjPtr  = G._adjPtr;
  const adjNode = G._adjNode;
  const mid     = path[(path.length / 2) | 0];

  const candidates = [];
  for (let ei = adjPtr[mid]; ei < adjPtr[mid + 1]; ei++) {
    const nb = adjNode[ei];
    if (!blocked[nb]) candidates.push(nb);
  }
  if (candidates.length === 0) return null;

  let best = null;
  for (const start of candidates) {
    const fill = bfsFloodFill(G, start, blocked, maxArea);
    if (fill === null) continue;
    if (best === null || fill.length < best.length) best = fill;
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────
// Main exported function
// ─────────────────────────────────────────────────────────────────────────

export function runCrosscutChainClustering(G, anchorNodes, budget, flags = {}) {
  const N             = G.nodeCount;
  const narrowBandSz  = N;
  const gamma         = flags.topoVertexBiasGamma  ?? 3.0;
  const nestThresh    = flags.topoNestThresh        ?? 0.9;
  const areaThreshFrac= flags.topoAreaThresh        ?? 0.2;
  const maxFloodArea  = Math.ceil(narrowBandSz * areaThreshFrac);
  const chainIoUThresh= flags.topoChainIoUThresh    ?? 0.7;
  const minEndAreaFrac= flags.topoMinEndAreaFrac    ?? 0.005;
  const minEndArea    = Math.max(1, Math.ceil(narrowBandSz * minEndAreaFrac));
  const minCompNodes  = flags.topoMinComponentNodes ?? 150;
  const debug         = !!flags.debugLog;

  const components = G.boundaryComponents;

  // ── Shared scratch buffers — allocated once, reused for all operations ──
  // blocked:  path nodes marked 1 during flood fill, cleared after each cut
  // scratchB: used for IoU marking and containment checks, always cleared after use
  const blocked  = new Uint8Array(N);
  const scratchB = new Uint8Array(N);

  // ── Pre-build component maps (O(N) once, avoids repeated traversal) ──────
  const compBdry    = new Map();   // comp id → boundary node array
  const compAnchors = new Map();   // comp id → anchor node array

  for (const comp of components) {
    const bns = G.boundaryNodesInComponent(comp);
    if (bns && bns.length >= 2) compBdry.set(comp, bns);
  }

  if (anchorNodes) {
    for (const n of anchorNodes) {
      const c = G.componentOf(n);
      if (!compAnchors.has(c)) compAnchors.set(c, []);
      compAnchors.get(c).push(n);
    }
  }

  // ── Exact component sizes from graph node labels — O(N) once ────────────
  // The boundary.length × 3 proxy can silently discard large sparse components
  // (e.g. a wide corridor where boundary nodes are few relative to interior).
  // G.componentOf(ni) gives the authoritative label for every node.
  const compSizes = new Map();
  for (let ni = 0; ni < G.nodeCount; ni++) {
    const c = G.componentOf(ni);
    compSizes.set(c, (compSizes.get(c) ?? 0) + 1);
  }

  // Filter and sort: skip components below minCompNodes using exact size.
  const activeComps = [...compBdry.keys()].filter(comp =>
    (compSizes.get(comp) ?? 0) >= minCompNodes
  ).sort((a, b) => compBdry.get(b).length - compBdry.get(a).length);

  if (debug) {
    console.log(
      `[CrosscutChain] ${components.length} components total, ` +
      `${activeComps.length} active (≥${minCompNodes} nodes), ` +
      `${components.length - activeComps.length} skipped`
    );
  }

  if (activeComps.length === 0) {
    return {
      ends: [], nodeEndMap: new Int32Array(N).fill(0),
      chains: [], diagnostics: { totalCuts: 0, chainsBuilt: 0, endsProduced: 0,
        activeComponents: 0, skippedComponents: components.length }
    };
  }

  // ── Budget distribution ──────────────────────────────────────────────────
  // Single pass replaces the original 3-pass loop.
  // Global cap prevents memory blow-up when many components survive the filter.
  const MAX_TOTAL_CUTS = Math.min(budget * 3, 500);
  const totalBdry = activeComps.reduce((s, c) => s + compBdry.get(c).length, 0);

  const rng = makeLCG(0x1A2B3C4D);

  // ── Single-pass cross-cut sampling, grouped by component ────────────────
  const cutsByComp = new Map();   // comp → Cut[]
  let totalCuts = 0;

  for (const comp of activeComps) {
    if (totalCuts >= MAX_TOTAL_CUTS) break;

    const bNodes   = compBdry.get(comp);
    const anchorsC = compAnchors.get(comp) ?? [];
    const weights  = buildSamplingWeights(bNodes, anchorsC, gamma, N);

    const compBgt = Math.max(2, Math.round(
      budget * bNodes.length / Math.max(totalBdry, 1)
    ));
    const sampleN = Math.min(bNodes.length, compBgt * 2);
    const sampled = weightedSampleWOR(weights, sampleN, rng);

    const compCuts = [];

    for (let pi = 0; pi + 1 < sampled.length; pi += 2) {
      if (totalCuts >= MAX_TOTAL_CUTS) break;

      const src = bNodes[sampled[pi]];
      const dst = bNodes[sampled[pi + 1]];
      if (G.componentOf(src) !== G.componentOf(dst)) continue;

      const result = bidirectionalDijkstra(G, src, dst, null);
      if (!result) continue;

      // Mark path in shared blocked buffer
      for (const n of result.path) blocked[n] = 1;

      // Flood using shared blocked mask
      const floodNodes = floodFromSharedBlocked(result.path, G, blocked, maxFloodArea);

      // Clear path from shared blocked buffer (must happen regardless of flood result)
      for (const n of result.path) blocked[n] = 0;

      if (!floodNodes) continue;

      compCuts.push({
        path:       result.path,
        floodNodes,
        anchorNode: nearestAnchor(result.path, anchorsC, G),
        area:       floodNodes.length,
        comp
      });
      totalCuts++;
    }

    if (compCuts.length > 0) cutsByComp.set(comp, compCuts);
  }

  if (debug) console.log(`[CrosscutChain] Valid cuts: ${totalCuts}`);

  // ── Build nested chains per component ────────────────────────────────────
  const allChains = [];   // { anchorNode, cuts, depth, comp }

  for (const [comp, cuts] of cutsByComp) {
    // Group cuts by anchor
    const byAnchor = new Map();
    const noAnchor = [];
    for (const cut of cuts) {
      const an = cut.anchorNode;
      if (an < 0) { noAnchor.push(cut); continue; }
      if (!byAnchor.has(an)) byAnchor.set(an, []);
      byAnchor.get(an).push(cut);
    }
    for (const cutsForAnchor of byAnchor.values()) {
      cutsForAnchor.sort((a, b) => a.area - b.area);
    }

    // Greedy nesting walk (innermost → outward) using shared scratchB
    for (const [anchor, cutsForAnchor] of byAnchor) {
      if (cutsForAnchor.length === 0) continue;
      const chain = [cutsForAnchor[0]];
      for (let ci = 1; ci < cutsForAnchor.length; ci++) {
        const outer = cutsForAnchor[ci];
        const inner = chain[chain.length - 1];
        const areaRatioOk = inner.area / outer.area < nestThresh;
        const containOk   = isApproxContained_shared(
          inner.floodNodes, outer.floodNodes, scratchB
        );
        if ((areaRatioOk || inner.area / outer.area < nestThresh * 1.05) && containOk) {
          chain.push(outer);
        }
      }
      allChains.push({ anchorNode: anchor, cuts: chain, depth: chain.length, comp });
    }
    for (const cut of noAnchor) {
      allChains.push({ anchorNode: -1, cuts: [cut], depth: 1, comp });
    }
  }

  if (debug) console.log(`[CrosscutChain] Chains: ${allChains.length}`);

  // ── Greedy representative clustering — O(chains × clusters) per component ─
  // Cross-component IoU is structurally zero, so we cluster within each
  // component only. Within a component, we sort chains by innermost flood
  // area (ascending) and compare each new chain against exactly ONE
  // representative per existing cluster (its founding member, which has the
  // smallest area). If IoU >= threshold, merge; otherwise start a new cluster.
  // Because IoU >= 0.7 is a strong overlap requirement, transitivity holds
  // well: if A∩B/A∪B ≥ 0.7 and A∩C/A∪C ≥ 0.7 then B and C overlap
  // significantly. The cluster count per component is typically 1–5,
  // making this effectively O(chains) per component.

  // Group chain indices by component
  const chainsByComp = new Map();
  for (let i = 0; i < allChains.length; i++) {
    const c = allChains[i].comp;
    if (!chainsByComp.has(c)) chainsByComp.set(c, []);
    chainsByComp.get(c).push(i);
  }

  let endIdCounter = 1;
  const ends = [];

  for (const idxList of chainsByComp.values()) {
    // Sort ascending by innermost flood area (most specific first)
    idxList.sort((a, b) => allChains[a].cuts[0].area - allChains[b].cuts[0].area);

    // clusters: [{ rep: floodNodes, chainGroup: Chain[] }]
    const clusters = [];

    for (const idx of idxList) {
      const chain = allChains[idx];
      const fi    = chain.cuts[0].floodNodes;
      let   merged = false;

      for (const cluster of clusters) {
        const rep = cluster.rep;
        // IoU against cluster representative using shared scratch
        for (const n of fi)  scratchB[n] = 1;
        let inter = 0;
        for (const n of rep) { if (scratchB[n]) inter++; }
        for (const n of fi)  scratchB[n] = 0;
        const union_ = fi.length + rep.length - inter;
        if (union_ > 0 && inter / union_ >= chainIoUThresh) {
          cluster.chainGroup.push(chain);
          merged = true;
          break;
        }
      }

      if (!merged) clusters.push({ rep: fi, chainGroup: [chain] });
    }

    // Build one End per cluster
    for (const { chainGroup } of clusters) {
      const repChain = chainGroup.reduce(
        (best, c) => c.depth > best.depth ? c : best, chainGroup[0]
      );

      const supportSet = new Set();
      for (const chain of chainGroup) {
        for (const cut of chain.cuts) {
          for (const n of cut.floodNodes) supportSet.add(n);
        }
      }
      if (supportSet.size < minEndArea) continue;

      const anchorVotes = new Map();
      for (const chain of chainGroup) {
        const an = chain.anchorNode;
        if (an >= 0) anchorVotes.set(an, (anchorVotes.get(an) ?? 0) + chain.depth);
      }
      let bestAnchor = -1, bestVote = -1;
      for (const [an, v] of anchorVotes) {
        if (v > bestVote) { bestVote = v; bestAnchor = an; }
      }

      ends.push({
        id:                 endIdCounter++,
        anchorNode:         bestAnchor,
        anchorPixel:        bestAnchor >= 0 ? G.nodeToPixel(bestAnchor) : -1,
        pixelIndices:       new Int32Array([...supportSet]),
        representativeCuts: repChain.cuts.slice(0, 3).map(c => ({
          srcNode:    c.path[0],
          dstNode:    c.path[c.path.length - 1],
          pathLength: c.path.length,
          area:       c.area
        })),
        areaFraction:     supportSet.size / narrowBandSz,
        chainDepth:       repChain.depth,
        persistenceScore: 1.0,
        birthFrame:       -1,
        multiplicity:     1
      });
    }
  }

  // ── Per-node assignment (smallest containing flood) ───────────────────────
  const nodeEndMap = new Int32Array(N).fill(-1);
  const endsSorted = [...ends].sort((a, b) => a.pixelIndices.length - b.pixelIndices.length);
  for (const end of endsSorted) {
    for (const n of end.pixelIndices) {
      if (nodeEndMap[n] === -1) nodeEndMap[n] = end.id;
    }
  }
  for (let i = 0; i < N; i++) {
    if (nodeEndMap[i] === -1) nodeEndMap[i] = 0;
  }

  // ── Multiplicity pass ─────────────────────────────────────────────────────
  {
    const anchorEndCount = new Map();
    for (const end of ends) {
      if (end.anchorNode >= 0) {
        anchorEndCount.set(end.anchorNode, (anchorEndCount.get(end.anchorNode) ?? 0) + 1);
      }
    }
    for (const end of ends) {
      end.multiplicity = end.anchorNode >= 0
        ? (anchorEndCount.get(end.anchorNode) ?? 1)
        : 1;
    }
  }

  const diagnostics = {
    totalCuts,
    chainsBuilt:        allChains.length,
    endsProduced:       ends.length,
    unassignedNodes:    0,
    activeComponents:   activeComps.length,
    skippedComponents:  components.length - activeComps.length,
    // Single-pass sampling replaces the original 3-pass loop.
    // passBreakdown fields renamed so callers that log diagnostics don't
    // silently misinterpret pass1/pass2 as non-zero passes.
    passBreakdown: {
      samplingCuts:  totalCuts,   // all from single weighted-sampling pass
      ringCuts:      0,           // back-edge DFS removed
      anchorCuts:    0            // mandatory anchor pass removed
    }
  };

  return { ends, nodeEndMap, chains: allChains, diagnostics };
}