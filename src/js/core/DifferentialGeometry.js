// /src/js/core/DifferentialGeometry.js
//
// Stage 4 of the reconstruction pipeline.
//
// Reads 5 artifacts from storage, computes 8 differential geometry fields,
// persists them via PersistenceHelper, and returns all artifact keys.
//
// Inputs (read from storage):
//   sdf_field       signedSdf, narrowBandMask            (Stage 2)
//   disk_seeds      collocation points                    (Stage 2)
//   normal_map      xyz normalField Float32Array ×4       (motion.worker STEP 11)
//   flow_field      { u, v }                              (Stage 3, optional)
//   flux_field      { A_coo, SOCs, … }                   (motion.worker STEP 12, optional)
//
// Outputs (persisted):
//   curvature_field    κ_H, κ_G, κ₁, κ₂            Float32 ×4 per pixel
//   principal_frame    e₁, e₂ unit vectors          Float32 ×2 per vector, per pixel
//   sdf_divergence     ∇·(∇SDF/|∇SDF|) = κ_H        Float32 per pixel
//   sdf_curl           |∇×∇SDF| diagnostic (~0)      Float32 per pixel
//   normal_curl        ∇×n̂ from normal_map           Float32 per pixel
//   flow_divergence    ∇·(u,v)                       Float32 per pixel  (null if no flow)
//   flow_curl          ∂v/∂x − ∂u/∂y                Float32 per pixel  (null if no flow)
//   overhang_curl      ∇×n̂_overhang from SOC A rows  Float32 per pixel  (null if no flux)
//
// DIFFGEO_DONE always fires (from motion.worker caller) — null keys for unavailable outputs.

import { persist, persistMany, safeKey, TTL, PIN } from './PersistenceHelper.js';
import PackingSDF from './PackingSDF.js';

export class DifferentialGeometry {

  /**
   * @param {object} storageWrapper  motion.worker wrapped storage (putArtifact, getArtifact, raw)
   * @param {object} [flags]         feature flags snapshot
   */
    constructor({ flags = {} } = {}) {
    this._flags = flags;
    // storageWrapper is passed per-call to compute() — no stale singleton problem
  }

  // ── PersistenceHelper store adapter ────────────────────────────────────────
  // Translates the PersistenceHelper contract (persistAndPin) onto the
  // motion.worker storageWrapper (putArtifact / raw.pinArtifact).
  _buildStore(sw) {
    return {
      persistAndPin: async (type, data, meta, ttlMs, pinType) => {
        const artifact = { type, data, meta };   // createdAt already in meta (injected by PersistenceHelper)

        let putResult;
        try {
          putResult = await sw.putArtifact(artifact);
        } catch (e) {
          throw new Error(`DifferentialGeometry: putArtifact failed for ${type}: ${e.message}`);
        }

        if (!putResult?.ok || !putResult.metaKey) {
          throw new Error(`DifferentialGeometry: no metaKey returned for ${type}`);
        }

        const pinFn = sw.raw?.pinArtifact ??
          (typeof self.pinArtifact === 'function' ? self.pinArtifact : null);
        if (typeof pinFn === 'function') {
          try {
            await pinFn(putResult.metaKey, {
              owner:  'differential_geometry',
              type:   pinType,
              ttlMs:  ttlMs > 0 ? ttlMs : null
            });
          } catch (e) {
            console.warn(`[DG] pin failed for ${putResult.metaKey.slice(0,20)}... (non-fatal):`, e.message);
          }
        }

        return putResult;
      }
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PUBLIC API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * compute()
   *
   * Loads inputs from storage, runs all differential geometry computations,
   * persists 8 artifacts, and returns their keys.
   *
   * Graceful degradation: each output that cannot be computed (missing inputs,
   * computation error) gets a null key — DIFFGEO_DONE fires regardless.
   *
   * @param {object} params
   * @param {string}      params.sdfFieldKey
   * @param {string|null} params.diskSeedsKey
   * @param {string}      params.normalMapKey
   * @param {string|null} params.flowFieldKey
   * @param {string|null} params.fluxFieldKey
   * @param {string}      params.sourceMetaKey
   * @param {string|null} params.cameraId
   * @param {number}      params.resolution
   * @param {object|null} params.samplingContext
   * @returns {Promise<{
   *   curvatureKey, principalFrameKey, sdfDivKey, sdfCurlKey,
   *   normalCurlKey, flowDivKey, flowCurlKey, overhangCurlKey,
   *   telemetry
   * }>}
   */
    async compute({
    storageWrapper,
    sdfFieldKey, diskSeedsKey = null, normalMapKey,
    flowFieldKey = null, fluxFieldKey = null,
    sourceMetaKey, cameraId, resolution, samplingContext = null,
    sdfInline = null, normalInline = null, fluxInline = null,
    diskSeedsInline = null,
    flowInline = null
  }) {
    const t0    = performance.now();
    const w     = resolution;
    const h     = resolution;
    const tel   = { errors: [], warnings: [], stages: {} };
    const sw    = storageWrapper;            // local alias — used for all getArtifact calls below
    const store = this._buildStore(sw);     // fresh store adapter for this job

    // ── Load inputs ──────────────────────────────────────────────────────────
    tel.stages.load_start = performance.now();

    // ── Load SDF — prefer inline data, fall back to IDB ───────────────────
    let signedSdf, narrowBandMask, sdfArt = null;
    if (sdfInline?.signedSdf) {
      console.log('[DG] using sdfInline — bypassing IDB read for sdf_field');
      signedSdf      = sdfInline.signedSdf;
      narrowBandMask = sdfInline.narrowBandMask ?? null;
      // sdfArt remains null — references to sdfArt.meta below use ?. safely
    } else {
      sdfArt = await sw.getArtifact(sdfFieldKey, { denormalize: true });
      if (!sdfArt?.data?.signedSdf) {
        throw new Error(`DifferentialGeometry: sdf_field missing signedSdf (key: ${sdfFieldKey})`);
      }
      signedSdf      = sdfArt.data.signedSdf;
      narrowBandMask = sdfArt.data.narrowBandMask ?? null;
    }

    // ── Load normal map — prefer inline data, fall back to IDB ───────────
    let normalData;
    if (normalInline?.field) {
      console.log('[DG] using normalInline — bypassing IDB read for normal_map');
      normalData = normalInline.field;
    } else {
      const normArt = await sw.getArtifact(normalMapKey, { denormalize: true });
      if (!normArt?.data?.field) {
        throw new Error(`DifferentialGeometry: normal_map missing field (key: ${normalMapKey})`);
      }
      normalData = normArt.data.field;
    }

    // disk_seeds: Stage 2 collocation points for RBF-FD curvature estimation.
    // Prefer inline data (passed directly from motion.worker, bypasses IDB).
    // Fall back to IDB load only when inline data is absent.
    let diskSeeds = null;
    if (diskSeedsInline?.length > 0) {
      // Filter to seeds with valid finite [0,1] coordinates — prevents
      // _buildKNNGrid from crashing on NaN bucket indices if any seed
      // has undefined x/y (e.g. wrong property names in normalization).
      diskSeeds = diskSeedsInline.filter(s =>
        typeof s?.x === 'number' && typeof s?.y === 'number' &&
        isFinite(s.x) && isFinite(s.y) &&
        s.x >= 0 && s.x <= 1 && s.y >= 0 && s.y <= 1
      );
      const filtered = diskSeedsInline.length - diskSeeds.length;
      if (filtered > 0) {
        console.warn(`[DG] diskSeedsInline: filtered ${filtered} seeds with invalid coordinates`);
      }
      tel.stages.seedCount = diskSeeds.length;
      console.log(`[DG] disk_seeds inline — ${diskSeeds.length} valid seeds, bypassing IDB read`);
      if (diskSeeds.length === 0) diskSeeds = null; // all invalid — fall through to IDB
    }
    if (!diskSeeds && diskSeedsKey) {
      try {
        const seedArt = await sw.getArtifact(diskSeedsKey, { denormalize: true });
        if (seedArt?.data?.header && seedArt?.data?.payload) {
          diskSeeds = PackingSDF.deserialize(seedArt.data.header, seedArt.data.payload);
          tel.stages.seedCount = diskSeeds?.length ?? 0;
          console.log(`[DG] loaded ${tel.stages.seedCount} disk seeds from IDB`);
        }
      } catch (e) {
        tel.warnings.push(`disk_seeds load failed: ${e.message} — falling back to FD`);
        diskSeeds = null;
      }
    } 

    // Optional: optical flow — prefer inline data, fall back to IDB key.
    // Inline path eliminates the IDB round-trip; consistent with sdfInline/normalInline.
    let flowU = null, flowV = null;
    if (flowInline?.u) {
      console.log('[DG] using flowInline — bypassing IDB read for flow_field');
      flowU = flowInline.u;
      flowV = flowInline.v;
    } else if (flowFieldKey) {
      try {
        const flowArt = await sw.getArtifact(flowFieldKey, { denormalize: true });
        flowU = flowArt?.data?.u ?? null;
        flowV = flowArt?.data?.v ?? null;
      } catch (e) {
        tel.warnings.push(`flow_field load failed: ${e.message}`);
      }
    }

    // Optional: flux field for overhang curl — prefer inline, fall back to IDB
    let fluxData = null;
    if (fluxInline?.A_coo) {
      console.log('[DG] using fluxInline — bypassing IDB read for flux_field');
      fluxData = fluxInline;
    } else if (fluxFieldKey) {
      try {
        const fluxArt = await sw.getArtifact(fluxFieldKey, { denormalize: true });
        fluxData = fluxArt?.data ?? null;
      } catch (e) {
        tel.warnings.push(`flux_field load failed: ${e.message}`);
      }
    }

    tel.stages.load_ms = performance.now() - tel.stages.load_start;

    // ── Compute ──────────────────────────────────────────────────────────────
    const baseMeta = {
      sourceMetaKey,
      cameraId,
      resolution,
      samplingContext,
      computedAt: Date.now()
    };

    // 1. Curvature (κ_H, κ_G, κ₁, κ₂) + principal frame (e₁, e₂)
    // Primary path: RBF-FD over disk_seeds neighbourhood graph (Stage 2 collocation points).
    // Fallback:     2D finite differences (always available, lower accuracy near edges).
    tel.stages.curvature_start = performance.now();

    let curvature;
    let curvatureMethod = 'fd';

    if (diskSeeds && diskSeeds.length >= 6 && this._flags.diffGeoDisableRBFFD !== true) {
      try {
        curvature = await this._computeCurvatureWithSeeds(
          signedSdf, diskSeeds, narrowBandMask, w, h
        );
        curvatureMethod = 'rbf_fd';
        console.log('[DG] curvature via RBF-FD');
      } catch (rbfErr) {
        tel.warnings.push(`RBF-FD curvature failed: ${rbfErr.message} — falling back to FD`);
        console.warn('[DG] RBF-FD failed, using FD fallback', rbfErr.message);
        curvature = this._computeCurvature(signedSdf, w, h);
      }
    } else {
      curvature = this._computeCurvature(signedSdf, w, h);
      if (!diskSeeds || diskSeeds.length < 6) {
        tel.warnings.push('disk_seeds unavailable or too sparse — using FD curvature');
      }
    }

    const principalFrm  = this._computePrincipalFrame(signedSdf, w, h);
    tel.stages.curvature_ms     = performance.now() - tel.stages.curvature_start;
    tel.stages.curvatureMethod  = curvatureMethod;

    // 2. SDF divergence = κ_H (mean curvature in level-set sense)
    //    Alias — no separate computation needed.
    const sdfDivergence = curvature.kH;

    // 3. SDF curl (diagnostic — should be ~0 for a valid SDF)
    tel.stages.sdfCurl_start = performance.now();
    const sdfCurl = this._computeSdfCurl(signedSdf, w, h);
    tel.stages.sdfCurl_ms = performance.now() - tel.stages.sdfCurl_start;

    // 4. Normal curl ∇×n̂ from normal_map
    tel.stages.normalCurl_start = performance.now();
    const normalCurl = this._computeNormalCurl(normalData, w, h);
    tel.stages.normalCurl_ms = performance.now() - tel.stages.normalCurl_start;

    // 5. Flow divergence / curl (null if no optical flow)
    let flowDivergence = null, flowCurl = null;
    if (flowU && flowV) {
      tel.stages.flow_start = performance.now();
      const fc     = this._computeFlowFields(flowU, flowV, w, h);
      flowDivergence = fc.divergence;
      flowCurl       = fc.curl;
      tel.stages.flow_ms = performance.now() - tel.stages.flow_start;
    }

    // 6. Overhang curl (null if no flux field)
    let overhangCurl = null;
    if (fluxData) {
      tel.stages.overhang_start = performance.now();
      try {
        overhangCurl = this._computeOverhangCurl(fluxData, w, h);
      } catch (e) {
        tel.warnings.push(`overhang_curl failed: ${e.message}`);
      }
      tel.stages.overhang_ms = performance.now() - tel.stages.overhang_start;
    }

    // ── Persist all 8 outputs via persistMany ─────────────────────────────
    // required=true: curvature_field, principal_frame, sdf_divergence.
    //   Failure here means DG cannot fulfil its contract — throw immediately
    //   so motion.worker logs it as a stage failure rather than a null key
    //   silently propagating into RECON_DONE.
    // required=false (default): diagnostic / conditional outputs — null key is OK.
    // ── All DG outputs travel inline — persistence is debug-only ──────────
    // Consumers receive kH, principalE1/E2, normalCurl, flowCurl, flowDiv
    // directly via dgInline in RECON_DONE. No downstream worker reads these
    // from IDB. persistMany is fire-and-forget so DG returns immediately.

    tel.processingMs = performance.now() - t0;

    console.log(
      `[DG] computed in ${tel.processingMs.toFixed(1)}ms — ` +
      `curvature✓ principalFrame✓ sdfDiv✓ sdfCurl✓ normalCurl✓` +
      ` flow:${!!(flowCurl)} overhang:${!!(overhangCurl)}` +
      ` — persisting async (non-blocking)`
    );

    // Fire-and-forget: IDB writes happen in background after return.
    // Keys are null — consumers use dgInline instead.
    // Gated behind dgPersistDebug: in production the concurrent IDB writes
    // (~11 MB of Float32Arrays) race with topology.worker and minimizer.worker
    // reads, causing transaction contention and OOM pressure on postImageBitmap.
    if (this._flags.dgPersistDebug) (async () => {
      try {
        tel.stages.persist_start = performance.now();

        const persistDescriptors = [
          // 0
          {
            type:     'curvature_field',
            data:     { kH: curvature.kH, kG: curvature.kG, k1: curvature.k1, k2: curvature.k2 },
            meta:     { ...baseMeta, method: 'finite_differences_2d_sdf',
                        narrowBandPx: sdfArt?.meta?.narrowBandPx ?? null },
            ttl:      TTL.PINNED,
            pinType:  PIN.SOFT,
            required: false   // non-blocking — consumers use dgInline
          },
          // 1
          {
            type:     'principal_frame',
            data:     { e1: principalFrm.e1, e2: principalFrm.e2 },
            meta:     baseMeta,
            ttl:      TTL.PINNED,
            pinType:  PIN.SOFT,
            required: false
          },
          // 2
          {
            type:     'sdf_divergence',
            data:     { divergence: sdfDivergence, narrowBandPx: sdfArt?.meta?.narrowBandPx ?? null },
            meta:     { ...baseMeta, geometryType: 'surface_level_set', curvatureMethod },
            ttl:      TTL.PINNED,
            pinType:  PIN.SOFT,
            required: false
          },
          // 3
          {
            type:    'sdf_curl',
            data:    { curl: sdfCurl },
            meta:    { ...baseMeta, note: 'diagnostic — should be ≈0 for valid SDF' },
            ttl:     TTL.PINNED,
            pinType: PIN.SOFT
          },
          // 4
          {
            type:    'normal_curl',
            data:    { curl: normalCurl },
            meta:    { ...baseMeta, source: 'normal_map' },
            ttl:     TTL.PINNED,
            pinType: PIN.SOFT
          },
          // 5 — conditional on optical flow
          {
            type:    'flow_divergence',
            data:    flowDivergence ? { divergence: flowDivergence } : null,
            meta:    { ...baseMeta, source: 'horn_schunck' },
            ttl:     TTL.PINNED,
            pinType: PIN.SOFT,
            skip:    !flowDivergence
          },
          // 6 — conditional on optical flow
          {
            type:    'flow_curl',
            data:    flowCurl ? { curl: flowCurl } : null,
            meta:    { ...baseMeta, source: 'horn_schunck' },
            ttl:     TTL.PINNED,
            pinType: PIN.SOFT,
            skip:    !flowCurl
          },
          // 7 — conditional on flux field / overhang
          {
            type:    'overhang_curl',
            data:    overhangCurl ? { curl: overhangCurl } : null,
            meta:    { ...baseMeta, source: 'flux_field_soc_normals' },
            ttl:     TTL.PINNED,
            pinType: PIN.SOFT,
            skip:    !overhangCurl
          }
        ];

        await persistMany(store, persistDescriptors);
        tel.stages.persist_ms = performance.now() - tel.stages.persist_start;
        console.log(`[DG] background persistence complete in ${tel.stages.persist_ms.toFixed(1)}ms`);
      } catch (e) {
        console.warn('[DG] background persistence failed (non-fatal):', e.message);
      }
    })(); // end if (this._flags.dgPersistDebug)

    // Return immediately with null IDB keys — all consumers use dgInline.
    return {
      curvatureKey:      null,
      principalFrameKey: null,
      sdfDivKey:         null,
      sdfCurlKey:        null,
      normalCurlKey:     null,
      flowDivKey:        null,
      flowCurlKey:       null,
      overhangCurlKey:   null,
      telemetry: tel,
      // ── Inline arrays for direct transfer to consumer workers ──────────
      dgInline: {
        kH:          curvature.kH,
        principalE1: principalFrm.e1,
        principalE2: principalFrm.e2,
        normalCurl:  normalCurl,
        flowCurl:    flowCurl        ?? null,
        flowDiv:     flowDivergence  ?? null
      }
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE COMPUTATION METHODS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * _computeCurvature
   *
   * Computes κ_H, κ_G, κ₁, κ₂ from the signed distance function.
   *
   * In 2D:
   *   κ_H (level-set mean curvature) = (SDF_xx·SDF_y² − 2·SDF_xy·SDF_x·SDF_y + SDF_yy·SDF_x²)
   *                                    / |∇SDF|³
   *   κ_G  = 0     (Gaussian curvature is identically zero in 2D)
   *   κ₁   = κ_H   (only one principal curvature in 2D)
   *   κ₂   = 0
   *
   * Border pixels (1-pixel margin) are left at zero.
   * NaN-safe: |∇SDF| is regularised by 1e-8 to avoid division by zero in flat
   * regions. In a valid Eikonal-normalised SDF |∇SDF| ≈ 1 everywhere; flat
   * patches indicate locally degenerate geometry.
   */
  _computeCurvature(sdf, w, h) {
    const count = w * h;
    const kH = new Float32Array(count);
    const kG = new Float32Array(count);   // always 0 in 2D
    const k1 = new Float32Array(count);
    const k2 = new Float32Array(count);   // always 0 in 2D

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i   = y * w + x;
        const c   = sdf[i];
        const xp  = sdf[i + 1];
        const xm  = sdf[i - 1];
        const yp  = sdf[i + w];
        const ym  = sdf[i - w];
        const pp  = sdf[i + w + 1];
        const pm  = sdf[i - w + 1];
        const mp  = sdf[i + w - 1];
        const mm  = sdf[i - w - 1];

        const fx  = (xp - xm) * 0.5;
        const fy  = (yp - ym) * 0.5;
        const fxx = xp - 2 * c + xm;
        const fyy = yp - 2 * c + ym;
        const fxy = (pp - pm - mp + mm) * 0.25;

        const g2 = fx * fx + fy * fy;
        const g  = Math.sqrt(g2) + 1e-8;
        const g3 = g2 * g + 1e-8;

        const kappa = (fxx * fy * fy - 2 * fxy * fx * fy + fyy * fx * fx) / g3;

        kH[i] = kappa;
        k1[i] = kappa;
        // kG[i] and k2[i] remain 0
      }
    }

    return { kH, kG, k1, k2 };
  }

  /**
   * _computePrincipalFrame
   *
   * Computes per-pixel orthonormal tangent/normal frame from ∇SDF.
   *   e₂ = ∇SDF / |∇SDF|          (normal to level curves, pointing outward)
   *   e₁ = (−SDF_y, SDF_x) / |∇SDF|  (tangent to level curves, 90° CCW from e₂)
   *
   * Stored as Float32Array of length res²×2 (x,y interleaved).
   */
  _computePrincipalFrame(sdf, w, h) {
    const count = w * h;
    const e1 = new Float32Array(count * 2);
    const e2 = new Float32Array(count * 2);

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i   = y * w + x;
        const fx  = (sdf[i + 1] - sdf[i - 1]) * 0.5;
        const fy  = (sdf[i + w] - sdf[i - w]) * 0.5;
        const mag = Math.sqrt(fx * fx + fy * fy) + 1e-8;

        e2[i * 2]     =  fx / mag;   // normal direction (outward)
        e2[i * 2 + 1] =  fy / mag;
        e1[i * 2]     = -fy / mag;   // tangent direction (CCW)
        e1[i * 2 + 1] =  fx / mag;
      }
    }

    return { e1, e2 };
  }

  /**
   * _computeSdfCurl
   *
   * ∂(SDF_y)/∂x − ∂(SDF_x)/∂y   (should be ≈0 for a smooth, valid SDF)
   *
   * Both quantities equal the mixed partial ∂²SDF/∂x∂y analytically,
   * but are estimated here with two distinct 3-point stencils so that
   * discretisation residuals are visible. Useful for validating SDF quality:
   * large curl values indicate sharp corners or regions with incorrect SDF
   * values (e.g. near seams of a composited SDF).
   */
  _computeSdfCurl(sdf, w, h) {
    const count = w * h;
    const curl  = new Float32Array(count);

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;

        // ∂SDF_y/∂x: central difference on SDF_y
        //   SDF_y[x+1,y] = (sdf[(y+1)*w+(x+1)] − sdf[(y-1)*w+(x+1)]) / 2
        //   SDF_y[x-1,y] = (sdf[(y+1)*w+(x-1)] − sdf[(y-1)*w+(x-1)]) / 2
        const sdfy_xp = (sdf[(y + 1) * w + (x + 1)] - sdf[(y - 1) * w + (x + 1)]) * 0.5;
        const sdfy_xm = (sdf[(y + 1) * w + (x - 1)] - sdf[(y - 1) * w + (x - 1)]) * 0.5;
        const dSdfy_dx = (sdfy_xp - sdfy_xm) * 0.5;

        // ∂SDF_x/∂y: central difference on SDF_x
        //   SDF_x[x,y+1] = (sdf[y*w+(x+1)+w] − sdf[y*w+(x-1)+w]) / 2
        //   SDF_x[x,y-1] = (sdf[y*w+(x+1)-w] − sdf[y*w+(x-1)-w]) / 2
        const sdfx_yp = (sdf[(y + 1) * w + (x + 1)] - sdf[(y + 1) * w + (x - 1)]) * 0.5;
        const sdfx_ym = (sdf[(y - 1) * w + (x + 1)] - sdf[(y - 1) * w + (x - 1)]) * 0.5;
        const dSdfx_dy = (sdfx_yp - sdfx_ym) * 0.5;

        curl[i] = dSdfy_dx - dSdfx_dy;
      }
    }

    return curl;
  }

  /**
   * _computeNormalCurl
   *
   * ∇×n̂  =  ∂n_y/∂x − ∂n_x/∂y
   *
   * normalData is Float32Array res²×4 (RGBA layout):
   *   n_x = channel 0, n_y = channel 1, n_z = channel 2
   */
  _computeNormalCurl(normalData, w, h) {
    const count = w * h;
    const curl  = new Float32Array(count);

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        // n_y at (x±1, y)
        const ny_xr = normalData[(y * w + (x + 1)) * 4 + 1];
        const ny_xl = normalData[(y * w + (x - 1)) * 4 + 1];
        // n_x at (x, y±1)
        const nx_yd = normalData[((y + 1) * w + x) * 4];
        const nx_yu = normalData[((y - 1) * w + x) * 4];

        curl[i] = (ny_xr - ny_xl) * 0.5 - (nx_yd - nx_yu) * 0.5;
      }
    }

    return curl;
  }

  /**
   * _computeFlowFields
   *
   * From optical flow vectors (u, v):
   *   divergence  = ∂u/∂x + ∂v/∂y    (sources / sinks)
   *   curl        = ∂v/∂x − ∂u/∂y    (rotation)
   */
  _computeFlowFields(u, v, w, h) {
    const count      = w * h;
    const divergence = new Float32Array(count);
    const curl       = new Float32Array(count);

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;

        const du_dx = (u[i + 1] - u[i - 1]) * 0.5;
        const dv_dy = (v[i + w] - v[i - w]) * 0.5;
        const dv_dx = (v[i + 1] - v[i - 1]) * 0.5;
        const du_dy = (u[i + w] - u[i - w]) * 0.5;

        divergence[i] = du_dx + dv_dy;
        curl[i]       = dv_dx - du_dy;
      }
    }

    return { divergence, curl };
  }

  /**
   * _computeOverhangCurl
   *
   * Extracts per-pixel overhang normals from the flux_field COO matrix,
   * interpolates to a dense grid, then computes ∂n_y/∂x − ∂n_x/∂y.
   *
   * flux_field.A_coo encodes the SOC constraint matrix:
   *   A_coo.row[k]  = flattened pixel index of constrained pixel
   *   A_coo.col[k]  = component index (0 = n_x, 1 = n_y, 2 = n_z)
   *   A_coo.data[k] = component value
   *
   * Pixels not covered by any SOC constraint have curl = 0 (no information).
   */
  _computeOverhangCurl(fluxData, w, h) {
    const A_coo = fluxData.A_coo;
    if (!A_coo?.row || !A_coo?.col || !A_coo?.data) {
      return null;
    }

    const count = w * h;
    const nx       = new Float32Array(count);
    const ny       = new Float32Array(count);
    const occupied = new Uint8Array(count);

    // Scatter COO entries into dense per-pixel normal vectors
    const nnz = A_coo.row.length;
    for (let k = 0; k < nnz; k++) {
      const px  = A_coo.row[k];
      const col = A_coo.col[k];
      if (px < 0 || px >= count) continue;
      if (col === 0) { nx[px] = A_coo.data[k]; occupied[px] = 1; }
      if (col === 1) { ny[px] = A_coo.data[k]; }
    }

    // Curl on constrained pixels only; unconstrained pixels stay 0
    const curl = new Float32Array(count);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!occupied[i]) continue;

        const ny_xr = ny[i + 1];
        const ny_xl = ny[i - 1];
        const nx_yd = nx[i + w];
        const nx_yu = nx[i - w];

        curl[i] = (ny_xr - ny_xl) * 0.5 - (nx_yd - nx_yu) * 0.5;
      }
    }

    return curl;
  }

// ─────────────────────────────────────────────────────────────────────────
  // RBF-FD CURVATURE (PRIMARY PATH)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * _computeCurvatureWithSeeds
   *
   * RBF-FD Laplacian over the Stage 2 disk-seed neighbourhood graph.
   *
   * Pipeline:
   *   1. Build k-NN graph among seeds                 (O(N²), N≤2048)
   *   2. Compute ε from mean nearest-neighbour distance
   *   3. Per seed: assemble (k+1)×(k+1) RBF-FD system, solve via Gaussian
   *      elimination → κ_H at that seed
   *      Fallback: quadric fitting if local system is singular
   *   4. Solve global RBF interpolation system Φ·α = κ_seeds via CG
   *      → interpolation coefficients α
   *   5. Evaluate interpolant at all narrow-band pixels
   *      (k-nearest seeds only — O(k·M) not O(N·M))
   *   6. Fill non-narrow-band pixels from FD result
   *
   * @param {Float32Array}      sdf
   * @param {Array<{x,y,r}>}    seeds   normalised [0,1] coordinates
   * @param {Float32Array|null} narrowBandMask
   * @param {number}            w
   * @param {number}            h
   * @returns {{ kH, kG, k1, k2 }}
   */
  async _computeCurvatureWithSeeds(sdf, seeds, narrowBandMask, w, h) {
    const N = seeds.length;
    const K = Math.min(12, N - 1);   // stencil neighbours

    // ── 1. k-NN graph ───────────────────────────────────────────────────────
    const { neighborIdx, neighborDist } = this._buildKNN(seeds, K);

    // ── 2. ε from mean 1st-NN distance ─────────────────────────────────────
    let sumDist = 0;
    for (let i = 0; i < N; i++) sumDist += neighborDist[i * K];
    const hMean = sumDist / N + 1e-10;
    const epsilon = 2.0 / hMean;    // shape parameter: ε·h ≈ 2 (standard heuristic)

    // ── 3. RBF-FD κ at each seed ────────────────────────────────────────────
    const kappaSeeds = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const knn = [];
      for (let j = 0; j < K; j++) knn.push(neighborIdx[i * K + j]);

      const kappa = this._curvatureAtSeedRBFFD(sdf, seeds, i, knn, epsilon, w, h);

      if (kappa !== null) {
        kappaSeeds[i] = kappa;
      } else {
        // Quadric fallback for this seed
        const px = seeds[i].x * (w - 1);
        const py = seeds[i].y * (h - 1);
        kappaSeeds[i] = this._curvatureAtSeedQuadric(sdf, px, py, 5, w, h);
      }
    }

    // ── 4. CG: solve Φ·α = κ_seeds ─────────────────────────────────────────
    const eps2 = epsilon * epsilon;
    const matvec = (x) => {
      const y = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        let s = 0;
        for (let j = 0; j < N; j++) {
          const dx = seeds[i].x - seeds[j].x;
          const dy = seeds[i].y - seeds[j].y;
          s += x[j] * Math.exp(-eps2 * (dx*dx + dy*dy));
        }
        y[i] = s;
      }
      return y;
    };

    const alpha = this._solveCG(
      matvec, kappaSeeds, N,
      /*maxIter=*/ Math.min(200, N),
      /*tol=*/ 1e-6
    );

    // ── 5. Evaluate interpolant at narrow-band pixels ───────────────────────
    // k-nearest lookup per pixel — build seed spatial index (flat grid buckets)
    const kH  = new Float32Array(w * h);
    const FD  = this._computeCurvature(sdf, w, h);   // FD fallback grid

    const EVAL_K = 8;   // seeds used per pixel evaluation
    const { neighborIdx: pixNbrIdx } = this._buildKNNGrid(seeds, EVAL_K, w, h);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const pi = y * w + x;

        // Non-narrow-band pixels: take FD value directly
        if (narrowBandMask && !narrowBandMask[pi]) {
          kH[pi] = FD.kH[pi];
          continue;
        }

        // Narrow-band: evaluate RBF interpolant with EVAL_K nearest seeds
        const nx = x / (w - 1);
        const ny = y / (h - 1);
        let val = 0;
        for (let j = 0; j < EVAL_K; j++) {
          const si = pixNbrIdx[pi * EVAL_K + j];
          if (si < 0) continue;
          const dx = nx - seeds[si].x;
          const dy = ny - seeds[si].y;
          val += alpha[si] * Math.exp(-eps2 * (dx*dx + dy*dy));
        }
        kH[pi] = val;
      }
    }

    // kG = 0 in 2D; k1 = kH; k2 = 0
    const count = w * h;
    const kG = new Float32Array(count);
    const k1 = kH.slice();
    const k2 = new Float32Array(count);

    return { kH, kG, k1, k2 };
  }

  /**
   * _curvatureAtSeedRBFFD
   *
   * RBF-FD stencil for ∇²SDF at a single seed point.
   *
   * Gaussian RBF: φ(r) = exp(−ε²r²)
   * ∇²φ at x_0:   4ε²(ε²·r₀ᵢ² − 1)·exp(−ε²·r₀ᵢ²)
   *
   * System size: (K+1)×(K+1) — solved with Gaussian elimination.
   *
   * @returns {number|null}  κ_H at seed, or null if system is singular
   */
  _curvatureAtSeedRBFFD(sdf, seeds, centerIdx, knnIdx, epsilon, w, h) {
    const K  = knnIdx.length;
    const SZ = K + 1;
    const eps2 = epsilon * epsilon;

    // Stencil nodes: [center, ...neighbors]
    const nodes = [seeds[centerIdx]];
    for (const ni of knnIdx) nodes.push(seeds[ni]);

    // SDF value at each stencil node (bilinear interpolation)
    const sdfVals = nodes.map(s =>
      this._bilinearSample(sdf, s.x * (w - 1), s.y * (h - 1), w, h)
    );

    // Build (SZ×SZ) RBF matrix A and RHS vector b
    const A = new Float64Array(SZ * SZ);
    const b = new Float64Array(SZ);

    for (let i = 0; i < SZ; i++) {
      for (let j = 0; j < SZ; j++) {
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        const r2 = dx*dx + dy*dy;
        A[i * SZ + j] = Math.exp(-eps2 * r2);
      }
      // b[i] = ∇²φ(||x_i − x_0||) at x_0
      const dx = nodes[i].x - nodes[0].x;
      const dy = nodes[i].y - nodes[0].y;
      const r2  = dx*dx + dy*dy;
      b[i] = 4 * eps2 * (eps2 * r2 - 1) * Math.exp(-eps2 * r2);
    }

    // Regularise diagonal slightly to handle near-duplicate nodes
    for (let i = 0; i < SZ; i++) A[i * SZ + i] += 1e-10;

    const w_vec = this._gaussElimSmall(A, b, SZ);
    if (!w_vec) return null;   // singular system → caller uses quadric fallback

    let kappa = 0;
    for (let j = 0; j < SZ; j++) kappa += w_vec[j] * sdfVals[j];
    return kappa;
  }

  /**
   * _curvatureAtSeedQuadric
   *
   * Fit f(x,y) = ax²+bxy+cy²+dx+ey+g to SDF values in a square window,
   * then return level-set curvature at the window centre.
   *
   * κ_H = (2a·e² − 2b·d·e + 2c·d²) / (d²+e²)^(3/2)
   *
   * Uses 6-parameter least squares (normal equations, 6×6 Cholesky).
   */
  _curvatureAtSeedQuadric(sdf, cx, cy, windowR, w, h) {
    // Collect pixels in circular window
    const px0 = Math.round(cx), py0 = Math.round(cy);
    const pts = [];
    for (let dy = -windowR; dy <= windowR; dy++) {
      for (let dx = -windowR; dx <= windowR; dx++) {
        if (dx*dx + dy*dy > windowR*windowR) continue;
        const nx = px0 + dx, ny = py0 + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        pts.push({ dx, dy, z: sdf[ny * w + nx] });
      }
    }

    if (pts.length < 6) {
      // Not enough points — use raw FD at this pixel
      const i = py0 * w + px0;
      return (i >= 0 && i < w * h) ? sdf[i] : 0;
    }

    // Normal equations: A^T A x = A^T b
    // Basis: [x², xy, y², x, y, 1]
    const ATA = new Float64Array(36);   // 6×6
    const ATb = new Float64Array(6);

    for (const { dx, dy, z } of pts) {
      const row = [dx*dx, dx*dy, dy*dy, dx, dy, 1];
      for (let i = 0; i < 6; i++) {
        ATb[i] += row[i] * z;
        for (let j = 0; j < 6; j++) ATA[i*6+j] += row[i] * row[j];
      }
    }

    const coeffs = this._gaussElimSmall(ATA, ATb, 6);
    if (!coeffs) return 0;

    const [a, b, c, d, e] = coeffs;   // f = ax²+bxy+cy²+dx+ey+g
    const g2 = d*d + e*e + 1e-12;
    const g3 = g2 * Math.sqrt(g2);
    return (2*a*e*e - 2*b*d*e + 2*c*d*d) / g3;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CG SOLVER
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * _solveCG
   *
   * Matrix-free preconditioned conjugate gradient for symmetric positive
   * semi-definite systems. Diagonal (Jacobi) preconditioner.
   *
   * @param {Function}    matvec  x → A·x  (returns Float64Array length N)
   * @param {Float64Array} b
   * @param {number}       N
   * @param {number}       maxIter
   * @param {number}       tol      convergence threshold on relative residual
   * @returns {Float64Array}        solution x
   */
  _solveCG(matvec, b, N, maxIter = 200, tol = 1e-6) {
    const x   = new Float64Array(N);   // initial guess: zero
    const r   = b.slice();            // r = b − A·x = b (x=0)
    const p   = r.slice();
    let rDotr = 0;
    for (let i = 0; i < N; i++) rDotr += r[i] * r[i];

    const b2 = rDotr;
    if (b2 < 1e-20) return x;   // already converged

    for (let iter = 0; iter < maxIter; iter++) {
      const Ap     = matvec(p);
      let   pTAp   = 0;
      for (let i = 0; i < N; i++) pTAp += p[i] * Ap[i];

      if (Math.abs(pTAp) < 1e-20) break;

      const alpha  = rDotr / pTAp;
      let   newRDotR = 0;

      for (let i = 0; i < N; i++) {
        x[i] += alpha * p[i];
        r[i] -= alpha * Ap[i];
        newRDotR += r[i] * r[i];
      }

      if (newRDotR / b2 < tol * tol) break;

      const beta = newRDotR / rDotr;
      for (let i = 0; i < N; i++) p[i] = r[i] + beta * p[i];
      rDotr = newRDotR;
    }

    return x;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SPATIAL INDEXING
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * _buildKNN
   *
   * Brute-force k-nearest-neighbours for N≤2048 seeds.
   * Returns flat arrays of length N×K (row-major).
   *
   * @param {Array<{x,y}>} seeds   normalised [0,1] coords
   * @param {number}        K
   * @returns {{ neighborIdx: Int32Array, neighborDist: Float32Array }}
   */
  _buildKNN(seeds, K) {
    const N          = seeds.length;
    const neighborIdx  = new Int32Array(N * K).fill(-1);
    const neighborDist = new Float32Array(N * K).fill(Infinity);

    for (let i = 0; i < N; i++) {
      // Collect distances to all other seeds
      const dists = [];
      for (let j = 0; j < N; j++) {
        if (j === i) continue;
        const dx = seeds[i].x - seeds[j].x;
        const dy = seeds[i].y - seeds[j].y;
        // Guard: skip pairs where coordinates are NaN or undefined.
        // NaN distances would produce a corrupted kNN graph and garbage curvature.
        if (!isFinite(dx) || !isFinite(dy)) continue;
        dists.push({ idx: j, d2: dx*dx + dy*dy });
      }
      dists.sort((a, b) => a.d2 - b.d2);
      const take = Math.min(K, dists.length);
      for (let k = 0; k < take; k++) {
        neighborIdx[i * K + k]  = dists[k].idx;
        neighborDist[i * K + k] = Math.sqrt(dists[k].d2);
      }
    }

    return { neighborIdx, neighborDist };
  }

  /**
   * _buildKNNGrid
   *
   * Spatial index: for every grid pixel, find K nearest seed indices.
   * Uses a flat bucket grid for O(bucketSize × W × H) rather than O(N × W × H).
   *
   * @param {Array<{x,y}>} seeds
   * @param {number}        K
   * @param {number}        w
   * @param {number}        h
   * @returns {{ neighborIdx: Int32Array }}  length W×H×K
   */
  _buildKNNGrid(seeds, K, w, h) {
    const N           = seeds.length;
    const count       = w * h;
    const neighborIdx = new Int32Array(count * K).fill(-1);

    // Bucket grid for fast lookups
    const BUCKETS = Math.max(4, Math.floor(Math.sqrt(N / 4)));
    const bw = BUCKETS, bh = BUCKETS;
    const buckets = Array.from({ length: bw * bh }, () => []);
    for (let s = 0; s < N; s++) {
      const bx = Math.min(bw - 1, Math.floor(seeds[s].x * bw));
      const by = Math.min(bh - 1, Math.floor(seeds[s].y * bh));
      // Guard: NaN or out-of-range index means seed has invalid coordinates.
      // buckets[NaN] is undefined — .push on it throws the RBF-FD crash.
      if (!isFinite(bx) || !isFinite(by) || bx < 0 || by < 0) continue;
      buckets[by * bw + bx].push(s);
    }

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const pi = y * w + x;
        const nx = x / (w - 1);
        const ny = y / (h - 1);

        // Search expanding bucket rings until K seeds found or all searched
        const candidates = [];
        const visited    = new Set();
        const bx0 = Math.min(bw - 1, Math.floor(nx * bw));
        const by0 = Math.min(bh - 1, Math.floor(ny * bh));

        for (let ring = 0; ring <= Math.max(bw, bh) && candidates.length < K; ring++) {
          for (let dy = -ring; dy <= ring; dy++) {
            for (let dx = -ring; dx <= ring; dx++) {
              if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
              const bx2 = bx0 + dx, by2 = by0 + dy;
              if (bx2 < 0 || bx2 >= bw || by2 < 0 || by2 >= bh) continue;
              const bi = by2 * bw + bx2;
              if (visited.has(bi)) continue;
              visited.add(bi);
              for (const s of buckets[bi]) {
                const ddx = nx - seeds[s].x;
                const ddy = ny - seeds[s].y;
                candidates.push({ idx: s, d2: ddx*ddx + ddy*ddy });
              }
            }
          }
        }

        candidates.sort((a, b) => a.d2 - b.d2);
        const take = Math.min(K, candidates.length);
        for (let k = 0; k < take; k++) {
          neighborIdx[pi * K + k] = candidates[k].idx;
        }
      }
    }

    return { neighborIdx };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LINEAR ALGEBRA UTILITIES
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * _gaussElimSmall
   *
   * In-place Gaussian elimination with partial pivoting for small dense
   * systems (n ≤ ~20). Modifies A and b in-place.
   *
   * @param {Float64Array} A  n×n row-major, modified in-place
   * @param {Float64Array} b  length n, modified in-place
   * @param {number}        n
   * @returns {Float64Array|null}  solution or null if system is singular
   */
  _gaussElimSmall(A, b, n) {
    // Clone to avoid mutating caller's arrays
    const a = new Float64Array(A);
    const x = new Float64Array(b);

    for (let col = 0; col < n; col++) {
      // Partial pivot
      let maxVal = Math.abs(a[col * n + col]);
      let maxRow = col;
      for (let row = col + 1; row < n; row++) {
        const v = Math.abs(a[row * n + col]);
        if (v > maxVal) { maxVal = v; maxRow = row; }
      }

      if (maxVal < 1e-14) return null;   // singular

      if (maxRow !== col) {
        for (let j = 0; j < n; j++) {
          const tmp = a[col * n + j];
          a[col * n + j] = a[maxRow * n + j];
          a[maxRow * n + j] = tmp;
        }
        const tmp = x[col]; x[col] = x[maxRow]; x[maxRow] = tmp;
      }

      const diag = a[col * n + col];
      for (let row = col + 1; row < n; row++) {
        const factor = a[row * n + col] / diag;
        x[row] -= factor * x[col];
        for (let j = col; j < n; j++) a[row * n + j] -= factor * a[col * n + j];
      }
    }

    // Back-substitution
    const sol = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let s = x[i];
      for (let j = i + 1; j < n; j++) s -= a[i * n + j] * sol[j];
      sol[i] = s / a[i * n + i];
    }

    return sol;
  }

  /**
   * _bilinearSample
   *
   * Bilinear interpolation of a scalar field at fractional pixel coordinates.
   *
   * @param {Float32Array} field
   * @param {number}        px   fractional x in [0, w-1]
   * @param {number}        py   fractional y in [0, h-1]
   * @param {number}        w
   * @param {number}        h
   * @returns {number}
   */
  _bilinearSample(field, px, py, w, h) {
    const x0 = Math.max(0, Math.min(w - 2, Math.floor(px)));
    const y0 = Math.max(0, Math.min(h - 2, Math.floor(py)));
    const tx = px - x0;
    const ty = py - y0;
    const i00 =  y0      * w + x0;
    const i10 =  y0      * w + x0 + 1;
    const i01 = (y0 + 1) * w + x0;
    const i11 = (y0 + 1) * w + x0 + 1;
    return field[i00] * (1-tx)*(1-ty) +
           field[i10] *    tx *(1-ty) +
           field[i01] * (1-tx)*   ty  +
           field[i11] *    tx *    ty;
  }  

}

export default DifferentialGeometry;