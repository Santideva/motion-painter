// /src/js/core/MinimizerModule.js
//
// Stage 4B: Constrained isoperimetric minimizer.
// Volume-preserving mean-curvature flow in 2D, level-set formulation.
//
// PDE:  ∂φ/∂t = −(κ − λ_c) |∇φ|
//   κ  = level-set curvature (div of unit normal)
//   λ_c = per-component Lagrange multiplier (area constraint)
//
// Inputs:
//   signedSdf      Float32Array res²   — warm-start φ₀
//   narrowBandMask Float32Array res²   — active computation region
//   diskSeeds      { cx, cy, r }[]     — from PackingSDF
//   socNx, socNy   Float32Array res²   — SOC constraint normals
//   hasSoc         Uint8Array   res²   — SOC constraint presence mask
//   cosThetaSoc    Float32Array res²   — cos(contact angle) per pixel
//   componentMap   Int32Array   res²   — per-pixel component label (Stage 4A)
//   b0, b1         number              — from Stage 4A homology summary
//   kH             Float32Array res²   — curvature warm-start for λ
//   flags          object
//
// Output: { phiMin, zeroCurve, diagnostics, telemetry }

import { organiseZeroCurve } from './MarchingSquares.js';

// ── Pre-built narrow-band index ─────────────────────────────────────────
function buildNarrowBandIndex(narrowBandMask, res) {
  const count = res * res;
  const list  = [];
  for (let i = 0; i < count; i++) {
    if (narrowBandMask[i] > 0) list.push(i);
  }
  return new Int32Array(list);
}

// ── Centred finite difference helpers ──────────────────────────────────
// All operate on a flat Float32Array indexed as [y*w + x]

function phi_x(phi, i, w)  {
  return (phi[i + 1] - phi[i - 1]) * 0.5;
}
function phi_y(phi, i, w)  {
  return (phi[i + w] - phi[i - w]) * 0.5;
}
function phi_xx(phi, i, w) {
  return phi[i + 1] - 2 * phi[i] + phi[i - 1];
}
function phi_yy(phi, i, w) {
  return phi[i + w] - 2 * phi[i] + phi[i - w];
}
function phi_xy(phi, i, w) {
  return (phi[i + w + 1] - phi[i + w - 1] - phi[i - w + 1] + phi[i - w - 1]) * 0.25;
}

// Level-set curvature κ = (φxx·φy² − 2φxy·φx·φy + φyy·φx²) / |∇φ|³
// |∇φ| = sqrt(φx² + φy²)  (regularised)
function curvature(phi, i, w) {
  const px  = phi_x(phi, i, w),  py  = phi_y(phi, i, w);
  const pxx = phi_xx(phi, i, w), pyy = phi_yy(phi, i, w);
  const pxy = phi_xy(phi, i, w);
  const gradSq  = px * px + py * py;
  const gradSqR = Math.max(gradSq, 1e-4);   // regularise denominator
  const num = pxx * py * py - 2 * pxy * px * py + pyy * px * px;
  return num / (gradSqR * Math.sqrt(gradSqR));
}

function gradMag(phi, i, w) {
  const px = phi_x(phi, i, w), py = phi_y(phi, i, w);
  return Math.max(Math.sqrt(px * px + py * py), 0.1);
}

// ── Per-component area counting ──────────────────────────────────────────
function countComponentAreas(phi, narrowBand, componentMap, b0) {
  // Returns Float64Array[b0] of enclosed pixel counts per component
  const areas = new Float64Array(b0);
  for (const i of narrowBand) {
    const c = componentMap[i];
    if (c >= 0 && c < b0 && phi[i] < 0) areas[c]++;
  }
  return areas;
}

// ── λ update (per component) ─────────────────────────────────────────────
// Linear approximation: λ = ΔA_κ / (Δt · Σ|∇φ|) where ΔA_κ is the
// area change the κ term would cause without the λ correction.
// Returns Float64Array[b0] of raw λ values.
function computeLambdaRaw(phi, narrowBand, componentMap, b0, w, dt) {
  const kappaSum  = new Float64Array(b0);
  const gradSum   = new Float64Array(b0);

  for (const i of narrowBand) {
    const c = componentMap[i];
    if (c < 0 || c >= b0) continue;
    const kap = curvature(phi, i, w);
    const gm  = gradMag(phi, i, w);
    kappaSum[c] += kap * gm;
    gradSum[c]  += gm;
  }

  const lambda = new Float64Array(b0);
  for (let c = 0; c < b0; c++) {
    lambda[c] = gradSum[c] > 1e-10
      ? kappaSum[c] / gradSum[c]
      : 0;
  }
  return lambda;
}

// ── Contact angle enforcement ────────────────────────────────────────────
// Penalty-projection hybrid: blend surface normal toward SOC target normal,
// then adjust φ linearly to be consistent with blended normal direction.
function enforceContactAngles(phi, phiNew, hasSoc, socNx, socNy, cosThetaSoc, narrowBand, w, alpha) {
  const contactEps = 2.0 / w;   // interface vicinity threshold

  for (const i of narrowBand) {
    if (!hasSoc[i]) continue;
    if (Math.abs(phi[i]) > contactEps) continue;

    const px = phi_x(phi, i, w), py = phi_y(phi, i, w);
    const gm = Math.max(Math.sqrt(px * px + py * py), 1e-8);
    const nx = px / gm, ny = py / gm;

    const tx = socNx[i], ty = socNy[i];
    const tMag = Math.max(Math.sqrt(tx * tx + ty * ty), 1e-8);
    const tnx = tx / tMag, tny = ty / tMag;

    // Blend toward target normal
    const bx = nx + alpha * (tnx - nx);
    const by = ny + alpha * (tny - ny);
    const bm = Math.max(Math.sqrt(bx * bx + by * by), 1e-8);
    const bnx = bx / bm, bny = by / bm;

    // Adjust φ so its gradient direction matches the blended normal:
    // Δφ ≈ dot(n_blend − n_phi, ∇φ) · (1/resolution)
    const dx = bnx - nx, dy = bny - ny;
    const adjustment = (dx * px + dy * py) * (1.0 / w);
    phiNew[i] += adjustment;
  }
}

// ── PDE reinitialization ─────────────────────────────────────────────────
// Drives |∇φ| → 1 without moving the zero level set.
// ∂φ/∂τ = sign(φ) · (1 − |∇φ|)
function reinitialize(phi, narrowBand, w, steps, dtau) {
  const tmp = new Float32Array(phi.length);
  tmp.set(phi);

  for (let s = 0; s < steps; s++) {
    for (const i of narrowBand) {
      const gm   = gradMag(tmp, i, w);
      const sgn  = tmp[i] > 0 ? 1 : (tmp[i] < 0 ? -1 : 0);
      tmp[i] += dtau * sgn * (1.0 - gm);
    }
    // Swap: write back to phi
    for (const i of narrowBand) phi[i] = tmp[i];
  }
}

// ── Narrow band expansion ────────────────────────────────────────────────
function maybeExpandBand(phi, narrowBandMask, narrowBand, w, h, bandWidth, maxExpansion) {
  const currentWidth = bandWidth;
  if (currentWidth >= maxExpansion) return { expanded: false, narrowBand, narrowBandMask };

  // Check if any zero crossing is within 1px of band boundary
  let needsExpansion = false;
  for (const i of narrowBand) {
    if (Math.abs(phi[i]) > (currentWidth - 1) / w) { needsExpansion = true; break; }
  }
  if (!needsExpansion) return { expanded: false, narrowBand, narrowBandMask };

  const newWidth = Math.min(currentWidth + 2, maxExpansion);
  const newBandW = newWidth / w;
  const newMask  = new Float32Array(narrowBandMask.length);
  const count    = w * h;

  for (let i = 0; i < count; i++) {
    newMask[i] = Math.abs(phi[i]) < newBandW ? 1 : 0;
  }

  const newBand = buildNarrowBandIndex(newMask, w);
  return { expanded: true, narrowBand: newBand, narrowBandMask: newMask, newWidth };
}

// ── Boundary pixel guard ─────────────────────────────────────────────────
// Returns Uint8Array: 1 if pixel is safe to update (not on image boundary)
function buildBoundaryGuard(w, h) {
  const guard = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      guard[y * w + x] = 1;
    }
  }
  return guard;
}

// ─────────────────────────────────────────────────────────────────────────
// MinimizerModule
// ─────────────────────────────────────────────────────────────────────────

export class MinimizerModule {
  /**
   * @param {object} inputs
   * @param {Float32Array} inputs.signedSdf
   * @param {Float32Array} inputs.narrowBandMask
   * @param {Array}        inputs.diskSeeds         — [{cx,cy,r}]
   * @param {Float32Array} inputs.socNx
   * @param {Float32Array} inputs.socNy
   * @param {Uint8Array}   inputs.hasSoc
   * @param {Float32Array} inputs.cosThetaSoc
   * @param {Int32Array}   inputs.componentMap      — from Stage 4A (may be null initially)
   * @param {number}       inputs.b0
   * @param {number}       inputs.b1
   * @param {Float32Array} inputs.kH                — curvature warm-start
   * @param {number}       inputs.resolution
   * @param {object}       [inputs.flags={}]
   */
  constructor(inputs) {
    const {
      signedSdf, narrowBandMask, diskSeeds,
      socNx, socNy, hasSoc, cosThetaSoc,
      componentMap, b0, b1, kH,
      resolution, flags = {}
    } = inputs;

    this._w              = resolution;
    this._h              = resolution;
    this._flags          = flags;
    this._diskSeeds      = diskSeeds;
    this._socNx          = socNx;
    this._socNy          = socNy;
    this._hasSoc         = hasSoc;
    this._cosThetaSoc    = cosThetaSoc;
    this._b1             = b1 ?? 0;

    // Working copy of phi (will be modified in place)
    this._phi            = new Float32Array(signedSdf);
    this._narrowBandMask = new Float32Array(narrowBandMask);
    this._narrowBand     = buildNarrowBandIndex(narrowBandMask, resolution);
    this._boundaryGuard  = buildBoundaryGuard(resolution, resolution);

    // Component map and b0 — may be updated later via setTopology()
    this._componentMap   = componentMap;
    this._b0             = b0 ?? 1;

    // Per-component λ (EMA state)
    this._lambdaEma      = new Float64Array(this._b0);
    // Warm-start λ from kH
    if (kH) {
      const mean = this._componentMeans(kH);
      for (let c = 0; c < this._b0; c++) this._lambdaEma[c] = mean[c] ?? 0;
    }

    // Per-component target areas (from disk seeds)
    this._targetAreas    = null;  // computed lazily once componentMap is set
    this._initialAreas   = null;

    // Telemetry arrays (pre-allocated for maxIter entries)
    const maxIter = flags.minimizerMaxIter ?? 100;
    this._areaErrCurve    = new Float32Array(maxIter);
    this._lambdaCurve     = new Float32Array(maxIter);   // component 0
    this._maxDeltaPhiCurve = new Float32Array(maxIter);
    this._bandExpansions  = 0;
    this._reinitCount     = 0;
    this._currentBandWidth = flags.minimizerBandWidth ?? 6;

    // Best state tracking (for divergence recovery)
    this._bestPhi         = new Float32Array(this._phi);
    this._bestAreaErr     = Infinity;
    this._iterationsRun   = 0;
  }

  /**
   * Update topology information when TOPOLOGY_DONE arrives (Phase B).
   * May be called after construction if Stage 4A completes after construction.
   */
  setTopology(componentMap, b0, b1) {
    this._componentMap = componentMap;
    this._b0           = b0;
    this._b1           = b1;
    // Resize λ array if needed
    if (this._lambdaEma.length < b0) {
      const newLambda = new Float64Array(b0);
      newLambda.set(this._lambdaEma.subarray(0, Math.min(this._lambdaEma.length, b0)));
      this._lambdaEma = newLambda;
    }
    // Recompute target areas with proper component labels
    this._targetAreas = null;
  }

  /**
   * Run the solver.
   * @returns {{ phiMin, zeroCurve, converged, stopReason, diagnostics, telemetry }}
   */
  solve() {
    const flags      = this._flags;
    const maxIter    = flags.minimizerMaxIter   ?? 100;
    const tolArea    = flags.minimizerTolArea    ?? 0.02;
    const tolPhi     = flags.minimizerTolPhi     ?? 0.005;
    const reinitFreq = flags.minimizerReinitFreq ?? 10;
    const contactAlpha = flags.minimizerContactAlpha ?? 0.3;
    const maxBandWidth = (flags.minimizerBandWidth ?? 6) * 3;
    const w          = this._w;
    const phi        = this._phi;
    const guard      = this._boundaryGuard;
    const dt         = flags.minimizerDt ?? (0.2 / w);
    const dtau       = 0.5 / w;   // reinit pseudo-timestep

    // Compute initial and target areas
    this._ensureTargetAreas();
    this._initialAreas = countComponentAreas(phi, this._narrowBand, this._componentMap, this._b0);

    const tmp         = new Float32Array(phi.length);
    let   converged   = false;
    let   stopReason  = 'maxIter';
    let   divergentCount = 0;

    for (let iter = 0; iter < maxIter; iter++) {
      this._iterationsRun = iter + 1;

      // ── Reinitialization ────────────────────────────────────────────────
      if (iter > 0 && iter % reinitFreq === 0) {
        reinitialize(phi, this._narrowBand, w, 5, dtau);
        this._reinitCount++;

        // Band expansion check
        const exp = maybeExpandBand(
          phi, this._narrowBandMask, this._narrowBand,
          w, this._h, this._currentBandWidth, maxBandWidth
        );
        if (exp.expanded) {
          this._narrowBandMask  = exp.narrowBandMask;
          this._narrowBand      = exp.narrowBand;
          this._currentBandWidth = exp.newWidth;
          this._bandExpansions++;
        }
      }

      // ── λ update ─────────────────────────────────────────────────────────
      const lambdaRaw = computeLambdaRaw(
        phi, this._narrowBand, this._componentMap, this._b0, w, dt
      );
      const emaAlpha = 0.3;
      for (let c = 0; c < this._b0; c++) {
        this._lambdaEma[c] = (1 - emaAlpha) * this._lambdaEma[c] + emaAlpha * lambdaRaw[c];
      }

      // ── φ update ──────────────────────────────────────────────────────────
      tmp.set(phi);
      let maxDeltaPhi = 0;

      for (const i of this._narrowBand) {
        if (!guard[i]) continue;
        const c      = this._componentMap ? this._componentMap[i] : 0;
        const lambda = (c >= 0 && c < this._b0) ? this._lambdaEma[c] : this._lambdaEma[0];
        const kap    = curvature(phi, i, w);
        const gm     = gradMag(phi, i, w);
        const delta  = -dt * (kap - lambda) * gm;
        tmp[i]       = phi[i] + delta;
        const absDelta = Math.abs(delta);
        if (absDelta > maxDeltaPhi) maxDeltaPhi = absDelta;
      }

      // ── Contact angle enforcement ─────────────────────────────────────────
      if (this._hasSoc) {
        enforceContactAngles(
          phi, tmp,
          this._hasSoc, this._socNx, this._socNy, this._cosThetaSoc,
          this._narrowBand, w, contactAlpha
        );
      }

      // Write back
      for (const i of this._narrowBand) phi[i] = tmp[i];

      // ── Convergence check ─────────────────────────────────────────────────
      const currentAreas = countComponentAreas(phi, this._narrowBand, this._componentMap, this._b0);
      let   maxAreaErr   = 0;

      for (let c = 0; c < this._b0; c++) {
        const target = this._targetAreas[c];
        if (target < 1) continue;
        const err = Math.abs(currentAreas[c] - target) / target;
        if (err > maxAreaErr) maxAreaErr = err;
      }

      // Telemetry
      this._areaErrCurve[iter]     = maxAreaErr;
      this._lambdaCurve[iter]      = this._lambdaEma[0];
      this._maxDeltaPhiCurve[iter] = maxDeltaPhi;

      // Track best state
      if (maxAreaErr < this._bestAreaErr) {
        this._bestAreaErr = maxAreaErr;
        this._bestPhi.set(phi);
      }

      // Divergence detection: area grows monotonically for 10 steps
      if (iter >= 10) {
        let growingCount = 0;
        for (let k = iter - 9; k <= iter; k++) {
          if (this._areaErrCurve[k] > this._areaErrCurve[Math.max(0, k-1)]) growingCount++;
        }
        if (growingCount >= 10) {
          stopReason = 'divergence';
          // Restore best state
          phi.set(this._bestPhi);
          break;
        }
      }

      // Check tolerance
      if (maxAreaErr < tolArea && maxDeltaPhi < tolPhi) {
        converged  = true;
        stopReason = 'tolerance';
        break;
      }
    }

    // ── Final area measurements ─────────────────────────────────────────────
    const finalAreas = countComponentAreas(phi, this._narrowBand, this._componentMap, this._b0);

    // ── Zero curve extraction and organisation ────────────────────────────
    const zeroCurve = organiseZeroCurve(
      phi, w, this._h,
      this._componentMap, this._b0, this._b1
    );

    // ── Topological consistency as additional convergence signal ──────────
    if (!zeroCurve.topologyConsistent && converged) {
      // Numerically converged but topologically wrong — flag as incomplete
      converged  = false;
      stopReason = 'topologyInconsistent';
    }

    // ── Diagnostics ────────────────────────────────────────────────────────
    const diagnostics = {
      converged,
      stopReason,
      iterations:          this._iterationsRun,
      b0:                  this._b0,
      b1:                  this._b1,
      initialAreas:        Array.from(this._initialAreas),
      targetAreas:         Array.from(this._targetAreas),
      finalAreas:          Array.from(finalAreas),
      maxAreaErr:          this._bestAreaErr,
      bandExpansions:      this._bandExpansions,
      reinitCount:         this._reinitCount,
      finalBandWidth:      this._currentBandWidth,
      zeroCurveLoops:      zeroCurve.loops.length,
      zeroCurveArcs:       zeroCurve.arcs.length,
      topologyConsistent:  zeroCurve.topologyConsistent,
      lambdaFinal:         Array.from(this._lambdaEma)
    };

    const telemetry = {
      convergenceCurve:  this._areaErrCurve.subarray(0, this._iterationsRun),
      lambdaCurve:       this._lambdaCurve.subarray(0, this._iterationsRun),
      maxDeltaPhiCurve:  this._maxDeltaPhiCurve.subarray(0, this._iterationsRun),
      bandExpansions:    this._bandExpansions,
      reinitCount:       this._reinitCount
    };

    return {
      phiMin:      phi,
      zeroCurve,
      converged,
      stopReason,
      diagnostics,
      telemetry
    };
  }

  // ── Lazy target area computation ────────────────────────────────────────
  _ensureTargetAreas() {
    if (this._targetAreas) return;
    const b0 = this._b0;
    const w  = this._w;

    // Per-component seed area sum
    const seedAreas = new Float64Array(b0);
    if (this._componentMap && this._diskSeeds) {
      for (const seed of this._diskSeeds) {
        const px = Math.max(0, Math.min(w - 1, Math.round(seed.cx * w)));
        const py = Math.max(0, Math.min(w - 1, Math.round(seed.cy * w)));
        const c  = this._componentMap[py * w + px];
        if (c >= 0 && c < b0) {
          seedAreas[c] += Math.PI * seed.r * seed.r * w * w;
        }
      }
    }

    // Current phi<0 area per component as fallback for components with no seeds
    const currentAreas = countComponentAreas(
      this._phi, this._narrowBand, this._componentMap, b0
    );

    this._targetAreas = new Float64Array(b0);
    for (let c = 0; c < b0; c++) {
      this._targetAreas[c] = seedAreas[c] > 0 ? seedAreas[c] : currentAreas[c];
    }
  }

  // ── Component-mean kH for λ warm-start ─────────────────────────────────
  _componentMeans(kH) {
    const b0     = this._b0;
    const sums   = new Float64Array(b0);
    const counts = new Int32Array(b0);
    for (const i of this._narrowBand) {
      const c = this._componentMap ? this._componentMap[i] : 0;
      if (c >= 0 && c < b0) { sums[c] += kH[i]; counts[c]++; }
    }
    return sums.map((s, c) => counts[c] > 0 ? s / counts[c] : 0);
  }
}

export default MinimizerModule;