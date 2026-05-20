// /src/js/core/LipschitzQuaternionEnds.js
//
// Lipschitz Quaternion Ends — Stage 4A motion-anchor module.
//
// Assembles a 4-channel quaternion-like field from:
//   w — Horn-Schunck flow magnitude (instantaneous motion)
//   x — DirectionalLifting temporal derivative magnitude (frame-to-frame change)
//   y — 1 − coherence (multi-frame instability)
//   z — |normalCurl| (geometric boundary texture)
//
// Seeds the cross-cut/chain algorithm with pixels whose quantised norm
// falls in a target range — identifying localised, consistent motion anchors.
//
// Outputs:
//   quaternionField   Float32Array  res²×4
//   ends              LQEEnd[]
//   motionMaps        { motionMagnitude, rotationalMap, motionEndsMap, saliencyMap }
//   seedMask          Uint8Array res²
//   diagnostics       object

import { runCrosscutChainClustering } from './runCrosscutChainClustering.js';

// ── Utility ───────────────────────────────────────────────────────────────
function percentile99(arr, count) {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < count; i++) {
    if (arr[i] < mn) mn = arr[i];
    if (arr[i] > mx) mx = arr[i];
  }
  if (mx <= mn) return Math.max(mx, 1e-6);
  const bins = 1000, hist = new Int32Array(bins);
  const range = mx - mn;
  for (let i = 0; i < count; i++) {
    hist[Math.min(bins - 1, ((arr[i] - mn) / range * bins) | 0)]++;
  }
  const target = count * 0.99; let cum = 0;
  for (let b = 0; b < bins; b++) {
    cum += hist[b];
    if (cum >= target) return mn + (b + 1) / bins * range;
  }
  return mx;
}

function trimmedMean(values, trimFrac) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const cut    = Math.floor(sorted.length * trimFrac);
  const slice  = sorted.slice(cut, sorted.length - cut);
  if (slice.length === 0) return sorted[sorted.length >> 1];
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

// percentile99 on absolute values — avoids allocating an intermediate array
// (src.flowCurl.map(Math.abs) at 1024² = 4MB wasted allocation)
function percentile99Abs(arr, count) {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < count; i++) {
    const v = Math.abs(arr[i]);
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (mx <= mn) return Math.max(mx, 1e-6);
  const bins = 1000, hist = new Int32Array(bins);
  const range = mx - mn;
  for (let i = 0; i < count; i++) {
    const v = Math.abs(arr[i]);
    hist[Math.min(bins - 1, ((v - mn) / range * bins) | 0)]++;
  }
  const target = count * 0.99; let cum = 0;
  for (let b = 0; b < bins; b++) {
    cum += hist[b];
    if (cum >= target) return mn + (b + 1) / bins * range;
  }
  return mx;
}

// ── Union-Find (component labelling for seed morphology) ─────────────────
function labelComponents(mask, w, h) {
  const DX = [-1, 0, 1, -1, 1, -1, 0, 1];
  const DY = [-1,-1,-1,  0, 0,  1, 1, 1];
  const N   = w * h;
  const lbl = new Int32Array(N).fill(-1);
  let nextLbl = 0;
  for (let i = 0; i < N; i++) {
    if (!mask[i] || lbl[i] >= 0) continue;
    const queue = [i]; lbl[i] = nextLbl;
    for (let q = 0; q < queue.length; q++) {
      const px = queue[q];
      const x = px % w, y = (px / w) | 0;
      for (let d = 0; d < 8; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const npx = ny * w + nx;
        if (mask[npx] && lbl[npx] < 0) { lbl[npx] = nextLbl; queue.push(npx); }
      }
    }
    nextLbl++;
  }
  return { labels: lbl, count: nextLbl };
}

// Compute bounding-box and covariance for morphological filters
function componentStats(pixels, w) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let sumX = 0, sumY = 0;
  for (const px of pixels) {
    const x = px % w, y = (px / w) | 0;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    sumX += x; sumY += y;
  }
  const n  = pixels.length;
  const cx = sumX / n, cy = sumY / n;
  // 2×2 covariance
  let cxx = 0, cyy = 0, cxy = 0;
  for (const px of pixels) {
    const dx = px % w - cx, dy = (px / w | 0) - cy;
    cxx += dx * dx; cyy += dy * dy; cxy += dx * dy;
  }
  cxx /= n; cyy /= n; cxy /= n;
  // Eigenvalues of [[cxx,cxy],[cxy,cyy]]
  const tr = cxx + cyy, det = cxx * cyy - cxy * cxy;
  const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const lam1 = tr / 2 + disc, lam2 = tr / 2 - disc;
  const eccentricity = lam1 > 1e-9 ? Math.sqrt(Math.max(0, 1 - lam2 / lam1)) : 0;
  const bboxW = maxX - minX + 1, bboxH = maxY - minY + 1;
  const aspectRatio = bboxH > 0 ? bboxW / bboxH : Infinity;

  return { eccentricity, aspectRatio: Math.max(aspectRatio, 1 / aspectRatio), n,
           centroid: { x: cx, y: cy } };
}

// ─────────────────────────────────────────────────────────────────────────

export class LipschitzQuaternionEnds {
  /**
   * @param {import('./PixelGraph.js').PixelGraph} G        — shared graph
   * @param {object}       sources
   * @param {Float32Array|null} sources.flowU              — H-S u component (res²)
   * @param {Float32Array|null} sources.flowV              — H-S v component (res²)
   * @param {object|null}  sources.derivatives             — from DirectionalLifting
   *   { field: Float32Array res²×4, dt, meanAbsDerivative }
   * @param {Float32Array|null} sources.coherencePerPixel  — res²
   * @param {Float32Array|null} sources.normalCurl         — res²
   * @param {Float32Array|null} sources.flowCurl           — from DG (res²)
   * @param {Float32Array|null} sources.flowDivergence     — from DG (res²)
   * @param {number}       resolution
   * @param {object}       [flags={}]
   */
  constructor(G, sources, resolution, flags = {}) {
    this._G          = G;
    this._sources    = sources;
    this._resolution = resolution;
    this._flags      = flags;
  }

  // ── Public entry point ────────────────────────────────────────────────
  compute(frameIndex = 0) {
    const G   = this._G;
    const w   = this._resolution;
    const N   = G.nodeCount;
    const pxN = w * w;
    const src = this._sources;
    const f   = this._flags;

    const debug = !!f.debugLog;

    // ── 1. Assemble quaternion field ──────────────────────────────────────
    const { Q, channelAvail, warnings } = this._buildQuaternionField(w, pxN, src, f);

    // ── 2. Lattice quantisation ───────────────────────────────────────────
    const scale     = f.lqeQuantizationScale ?? 0.2;
    const hysterM   = f.lqeHysteresisMargin  ?? 0.1;  // fraction of scale
    const hysterAbs = hysterM * scale;

    const Q_int     = new Int32Array(pxN * 4);
    const latticeNorm = new Float32Array(pxN);
    const stableMask  = new Uint8Array(pxN);

    for (let i = 0; i < pxN; i++) {
      let normSq = 0; let stable = true;
      for (let ch = 0; ch < 4; ch++) {
        const v    = Q[i * 4 + ch];
        const frac = v / scale;
        const r    = Math.round(frac);
        Q_int[i * 4 + ch] = r;
        normSq += r * r;
        // Hysteresis: distance to nearest integer boundary
        const distToLattice = Math.abs(frac - r);
        if (distToLattice < hysterAbs / scale) stable = false;
      }
      latticeNorm[i]  = Math.sqrt(normSq);
      stableMask[i]   = stable ? 1 : 0;
    }

    // ── 3. Seed selection ─────────────────────────────────────────────────
    const normMin  = f.lqeNormThreshMin ?? 0.5;
    let   normMax  = f.lqeNormThreshMax ?? 6.0;
    // Recalibrate if flow was absent
    if (!channelAvail.flow) normMax *= (3 / 4);

    const rawSeedMask = new Uint8Array(pxN);
    for (let i = 0; i < pxN; i++) {
      rawSeedMask[i] = (stableMask[i] && latticeNorm[i] > normMin && latticeNorm[i] <= normMax) ? 1 : 0;
    }

    // ── 4. Morphological filtering ─────────────────────────────────────────
    const seedMask = this._morphologicalFilter(rawSeedMask, w, f);

    // Fallback: if zero seeds, relax constraints and retry
    let seedCount = 0;
    for (let i = 0; i < pxN; i++) if (seedMask[i]) seedCount++;

    if (seedCount === 0) {
      warnings.push('Zero seeds after morphological filter — retrying with relaxed params');
      const relaxed = new Uint8Array(pxN);
      const minSize = 4;
      for (let i = 0; i < pxN; i++) {
        relaxed[i] = (latticeNorm[i] > normMin * 0.5 && latticeNorm[i] <= normMax * 1.5) ? 1 : 0;
      }
      this._morphologicalFilterInPlace(relaxed, w, minSize, Infinity, Infinity);
      for (let i = 0; i < pxN; i++) if (relaxed[i]) { seedMask[i] = 1; seedCount++; }
    }

    if (debug) console.log(`[LQE] Seed pixels after filtering: ${seedCount}`);

    // Collect seed nodes (narrow-band seed pixels only)
    const seedNodes = [];
    for (let i = 0; i < pxN; i++) {
      if (!seedMask[i]) continue;
      const ni = G.pixelToNode(i);
      if (ni >= 0) seedNodes.push(ni);
    }

    // ── 5. Budget for cross-cut sampling ─────────────────────────────────
    const { labels: seedCompLabels, count: seedCompCount } = labelComponents(seedMask, w, w);
    const S0     = f.topoBudgetS0    ?? 30;
    const Smax   = f.topoBudgetSMax  ?? 120;
    const budget = Math.min(Smax, S0 + 2 * seedCompCount);

    // ── 6. Cross-cut / chain / clustering ─────────────────────────────────
    let ends = [], nodeEndMap = new Int32Array(N).fill(0), chains = [], ccDiag = {};

    if (seedNodes.length >= 2) {
      const result = runCrosscutChainClustering(
        G, new Int32Array(seedNodes), budget, f
      );
      ends       = result.ends;
      nodeEndMap = result.nodeEndMap;
      chains     = result.chains;
      ccDiag     = result.diagnostics;
    } else {
      warnings.push('Insufficient seed nodes for cross-cut sampling — zero LQE ends produced');
    }

    for (const end of ends) end.birthFrame = frameIndex;

    // ── 7. Motion descriptors per end ────────────────────────────────────
    this._attachMotionDescriptors(ends, Q, src, w, G, f);

    // ── 8. Motion maps ─────────────────────────────────────────────────
    const motionMaps = this._buildMotionMaps(ends, nodeEndMap, Q, src, pxN, w, G);

    // ── 9. Full-res motion-ends map ───────────────────────────────────────
    const motionEndsMap = new Int32Array(pxN).fill(-1);
    for (let ni = 0; ni < N; ni++) {
      motionEndsMap[G.nodeToPixel(ni)] = nodeEndMap[ni];
    }

    const diagnostics = {
      seedCount,
      seedComponents:  seedCompCount,
      endsProduced:    ends.length,
      channelAvail,
      warnings,
      ccDiag
    };

    return {
      quaternionField: Q,
      seedMask,
      ends,
      motionMaps: { ...motionMaps, motionEndsMap },
      diagnostics
    };
  }

  // ── Build quaternion field ─────────────────────────────────────────────
  _buildQuaternionField(w, pxN, src, f) {
    const Q        = new Float32Array(pxN * 4);
    const warnings = [];
    const channelAvail = { flow: false, derivative: false, coherence: false, curl: false };

    // ── w channel: flow magnitude ────────────────────────────────────────
    const flowMag = new Float32Array(pxN);
    if (src.flowU && src.flowV) {
      channelAvail.flow = true;
      for (let i = 0; i < pxN; i++) {
        flowMag[i] = Math.sqrt(src.flowU[i] ** 2 + src.flowV[i] ** 2);
      }
      const p99fm = percentile99(flowMag, pxN);
      for (let i = 0; i < pxN; i++) {
        Q[i * 4 + 0] = Math.tanh(2.0 * flowMag[i] / p99fm);
      }
    } else {
      warnings.push('flowU/flowV absent — w channel set to 0');
    }

    // ── x channel: temporal derivative luminance ─────────────────────────
    if (src.derivatives && src.derivatives.field) {
      channelAvail.derivative = true;
      const dtField = src.derivatives.field;
      const lumArr  = new Float32Array(pxN);
      for (let i = 0; i < pxN; i++) {
        lumArr[i] = Math.abs(
          0.299 * dtField[i * 4 + 0] +
          0.587 * dtField[i * 4 + 1] +
          0.114 * dtField[i * 4 + 2]
        );
      }
      const p99dt = percentile99(lumArr, pxN);
      for (let i = 0; i < pxN; i++) {
        Q[i * 4 + 1] = Math.tanh(2.0 * lumArr[i] / p99dt);
      }
    } else {
      warnings.push('DirectionalLifting derivatives absent — x channel set to 0');
    }

    // ── y channel: 1 − coherence ─────────────────────────────────────────
    if (src.coherencePerPixel) {
      channelAvail.coherence = true;
      for (let i = 0; i < pxN; i++) {
        Q[i * 4 + 2] = 1.0 - Math.max(0, Math.min(1, src.coherencePerPixel[i]));
      }
    } else {
      warnings.push('coherencePerPixel absent — y channel set to 0.5 (neutral)');
      for (let i = 0; i < pxN; i++) Q[i * 4 + 2] = 0.5;
    }

    // ── z channel: |normalCurl| ──────────────────────────────────────────
    if (src.normalCurl) {
      channelAvail.curl = true;
      const p99nc = percentile99(src.normalCurl, pxN);
      for (let i = 0; i < pxN; i++) {
        Q[i * 4 + 3] = Math.min(1.0, Math.abs(src.normalCurl[i]) / p99nc);
      }
    } else {
      warnings.push('normalCurl absent — z channel set to 0');
    }

    return { Q, channelAvail, warnings };
  }

  // ── Morphological filtering of seed mask ─────────────────────────────
  _morphologicalFilter(rawMask, w, f) {
    const mask        = new Uint8Array(rawMask);
    const minSize     = f.lqeMinSeedSize      ?? 16;
    const maxAspect   = f.lqeMaxAspectRatio   ?? 10.0;
    const maxEcc      = f.lqeMaxEccentricity  ?? 0.97;
    this._morphologicalFilterInPlace(mask, w, minSize, maxAspect, maxEcc);
    return mask;
  }

  _morphologicalFilterInPlace(mask, w, minSize, maxAspect, maxEcc) {
    const pxN = w * w;
    const { labels, count } = labelComponents(mask, w, w);

    // Collect pixels per component
    const compPixels = Array.from({ length: count }, () => []);
    for (let i = 0; i < pxN; i++) {
      if (mask[i] && labels[i] >= 0) compPixels[labels[i]].push(i);
    }

    for (let c = 0; c < count; c++) {
      const pixels = compPixels[c];
      if (pixels.length < minSize) {
        for (const px of pixels) mask[px] = 0;
        continue;
      }
      const stats = componentStats(pixels, w);
      if (stats.aspectRatio > maxAspect || stats.eccentricity > maxEcc) {
        for (const px of pixels) mask[px] = 0;
      }
    }
  }

  // ── Motion descriptors ────────────────────────────────────────────────
  _attachMotionDescriptors(ends, Q, src, w, G, f) {
    const trim = f.lqeTrimmedMeanFrac ?? 0.05;

    for (const end of ends) {
      const pixels = end.pixelIndices.map(ni => G.nodeToPixel(ni));
      if (pixels.length === 0) continue;

      // Centroid
      let cx = 0, cy = 0;
      for (const px of pixels) { cx += px % w; cy += (px / w) | 0; }
      end.centroid = { x: cx / pixels.length, y: cy / pixels.length };

      // avgQuaternion (trimmed mean per channel)
      end.avgQuaternion = [0, 1, 2, 3].map(ch => {
        const vals = pixels.map(px => Q[px * 4 + ch]);
        return trimmedMean(vals, trim);
      });

      // motionStats
      const speeds = src.flowU
        ? pixels.map(px => Math.sqrt(src.flowU[px] ** 2 + src.flowV[px] ** 2))
        : pixels.map(() => 0);
      const curls  = src.flowCurl       ? pixels.map(px => src.flowCurl[px])       : null;
      const divs   = src.flowDivergence ? pixels.map(px => src.flowDivergence[px]) : null;

      const meanSpeed = trimmedMean(speeds, trim);
      const varSpeed  = speeds.reduce((s, v) => s + (v - meanSpeed) ** 2, 0) / Math.max(speeds.length, 1);

      // Dominant flow direction — weighted circular mean of atan2(v, u)
      // over the end's pixel support, weighted by per-pixel flow magnitude.
      // Uses pixels[] (correctly mapped via G.nodeToPixel) not pixelIndices directly.
      let dominantDirection = 0;
      if (src.flowU && src.flowV && pixels.length > 0) {
        let sinSum = 0, cosSum = 0;
        for (const px of pixels) {
          const u   = src.flowU[px];
          const v   = src.flowV[px];
          const mag = Math.sqrt(u * u + v * v);
          if (mag < 1e-8) continue;
          const theta = Math.atan2(v, u);
          sinSum += mag * Math.sin(theta);
          cosSum += mag * Math.cos(theta);
        }
        dominantDirection = Math.atan2(sinSum, cosSum);   // ∈ [−π, π]
      }

      end.motionStats = {
        meanSpeed,
        varSpeed,
        curl:             curls ? trimmedMean(curls, trim) : 0,
        divergence:       divs  ? trimmedMean(divs,  trim) : 0,
        dominantDirection                                        // radians ∈ [−π, π]
      };

      // Dominant lattice label: most frequent 4-tuple in pixel support
      end.latticeLabel = end.avgQuaternion.map(v => Math.round(v));
    }
  }

  // ── Motion maps ───────────────────────────────────────────────────────
  _buildMotionMaps(ends, nodeEndMap, Q, src, pxN, w, G) {
    const N = G.nodeCount;

    // motion_magnitude_map
    const motionMagnitude = new Float32Array(pxN);
    if (src.flowU) {
      for (let i = 0; i < pxN; i++) {
        motionMagnitude[i] = Math.sqrt(src.flowU[i] ** 2 + src.flowV[i] ** 2);
      }
    }

    // rotational_map (|flowCurl| normalised)
    const rotationalMap = new Float32Array(pxN);
    if (src.flowCurl) {
      const p99 = percentile99Abs(src.flowCurl, pxN);  // no intermediate array
      for (let i = 0; i < pxN; i++) {
        rotationalMap[i] = Math.min(1.0, Math.abs(src.flowCurl[i]) / p99);
      }
    }

    // saliency_map: 0.5·w + 0.3·y + 0.2·z
    const saliencyMap = new Float32Array(pxN);
    for (let i = 0; i < pxN; i++) {
      saliencyMap[i] = 0.5 * Q[i * 4 + 0] + 0.3 * Q[i * 4 + 2] + 0.2 * Q[i * 4 + 3];
    }

    return { motionMagnitude, rotationalMap, saliencyMap };
  }
}

export default LipschitzQuaternionEnds;