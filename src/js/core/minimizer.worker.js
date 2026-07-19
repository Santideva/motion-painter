// /src/js/core/minimizer.worker.js
//
// Stage 4B worker shell — CPU level-set minimizer.
// Lightweight: no GPU, no heartbeat, no TTL machinery.
//
// Execution model:
//   Phase A (immediate on RECON_DONE):
//     Load sdfField, diskSeeds, fluxField, curvatureField.
//     Construct MinimizerModule with global componentMap (single component)
//     as placeholder if Stage 4A has not yet completed.
//
//   Phase B (on TOPOLOGY_DONE or after Phase A if topology already arrived):
//     Call module.setTopology(componentMap, b0, b1).
//     Call module.solve().
//     Persist artifacts, broadcast MINIMIZER_DONE.

import { MinimizerModule }   from './MinimizerModule.js';        // FIX MW-B4/path: sibling in /src/js/core/
import PersistenceHelper     from './PersistenceHelper.js';      // FIX MW-B4: default import, not named
// REMOVED: import { applyFlagsSnapshot } from '../config/featureFlags.js';  // FIX MW-B2: applyFlagsSnapshot does not exist

// ── Broadcast channel ────────────────────────────────────────────────────
let _bc = null;
try { _bc = new BroadcastChannel('motion-painter-store'); } catch(e) {}  // FIX MW-B1: was 'motionpainter'

function _bcPost(p) { if (_bc) try { _bc.postMessage(p); } catch(e) {} }
function _safeErr(e) { return { message: e?.message ?? String(e), stack: e?.stack ?? null }; }

let _storageAPI = null;
let _flags      = {};

// Pending job state — holds Phase A result while waiting for TOPOLOGY_DONE
let _pendingJob = null;   // { jobId, metaKey, module, startMs, sw, socPixelCount, phaseADoneMs }
let _topoData   = null;   // { componentMap, b0, b1 } — cached if TOPOLOGY_DONE arrives before Phase A completes

// ── Storage ───────────────────────────────────────────────────────────────
async function _loadStorageAPI() {
  if (_storageAPI) return _storageAPI;
  const mod = await import('./storage.js');                       // FIX MW-B3: was '../storage/storageAPI.js'
  _storageAPI = mod.default ?? mod.storageAPI ?? mod;
  return _storageAPI;
}

// ── Retry helper ──────────────────────────────────────────────────────────
async function _retryable(fn, attempts = 3, delay = 80) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); } catch(e) {
      last = e;
      const transient = e?.name === 'InvalidStateError' || e?.message?.includes('transaction');
      if (!transient || i === attempts) throw e;
      await new Promise(r => setTimeout(r, delay * i));
    }
  }
  throw last;
}

// ── Storage wrapper ───────────────────────────────────────────────────────
function _wrapStorage(api) {
  return {
    putArtifact: art => _retryable(() => api.putInboundArtifact(art)),
    raw:         api
  };
}

// ── Store adapter for PersistenceHelper ──────────────────────────────────
// FIX MW-B5: PersistenceHelper calls persistAndPin(type, data, meta, ttlMs, pinType)
// with 5 positional args — the original (descriptor) single-arg signature was wrong.
function _buildStore(sw) {
  return {
    persistAndPin: async (type, data, meta, ttlMs, pinType) => {
      const artifact = { type, data, meta };

      let putResult;
      try {
        putResult = await sw.putArtifact(artifact);
      } catch (e) {
        throw new Error(`minimizer.worker: putArtifact failed for ${type}: ${e.message}`);
      }

      if (!putResult?.ok || !putResult.metaKey) {
        throw new Error(`minimizer.worker: no metaKey returned for ${type}`);
      }

      const pinFn = sw.raw?.pinArtifact ??
        (typeof self.pinArtifact === 'function' ? self.pinArtifact : null);
      if (typeof pinFn === 'function') {
        try {
          await pinFn(putResult.metaKey, {
            owner:  'minimizer.worker',
            type:   pinType ?? 'soft',
            ttlMs:  ttlMs > 0 ? ttlMs : null
          });
        } catch (e) {
          console.warn(
            `[minimizer.worker] pin failed for ${putResult.metaKey.slice(0,20)}... (non-fatal):`,
            e.message
          );
        }
      }

      return putResult;
    }
  };
}

// ── Load a single artifact by metaKey (with retry) ────────────────────────
async function _loadArtifact(api, key) {
  if (!key) return null;
  return _retryable(() => api.getArtifact(key));
}

// ── SOC extraction from flux field ───────────────────────────────────────
function extractSOCs(fluxArt, resolution) {
  const pxN         = resolution * resolution;
  const socNx       = new Float32Array(pxN);
  const socNy       = new Float32Array(pxN);
  const hasSoc      = new Uint8Array(pxN);
  const cosThetaSoc = new Float32Array(pxN).fill(0);

  if (!fluxArt?.data?.A_coo) return { socNx, socNy, hasSoc, cosThetaSoc, socPixelCount: 0 };

  const { row, col, data } = fluxArt.data.A_coo;
  let socPixelCount = 0;

  for (let k = 0; k < row.length; k++) {
    const px = row[k];
    if (px < 0 || px >= pxN) continue;
    if (col[k] === 0) { socNx[px] = data[k]; hasSoc[px] = 1; }
    if (col[k] === 1) { socNy[px] = data[k]; }
  }

  // Normalise SOC normals; compute cos(theta) from SOC cone descriptors if available
  for (let i = 0; i < pxN; i++) {
    if (!hasSoc[i]) continue;
    socPixelCount++;
    const mag = Math.sqrt(socNx[i] ** 2 + socNy[i] ** 2);
    if (mag > 1e-8) { socNx[i] /= mag; socNy[i] /= mag; }
    cosThetaSoc[i] = 0;  // default: 90° contact angle
  }

  // Override from precomputed cosThetaSoc Float32Array (SOCs array removed — OOM fix).
  // If cosThetaSoc is present it already contains cos(halfAngle) per pixel.
  if (fluxArt.data.cosThetaSoc) {
    const src = fluxArt.data.cosThetaSoc;
    for (let i = 0; i < pxN; i++) {
      if (hasSoc[i] && src[i] !== 0) {
        cosThetaSoc[i] = src[i];
      }
    }
  } else if (fluxArt.data.SOCs) {
    // Legacy fallback if SOCs still present
    for (const soc of fluxArt.data.SOCs) {
      const px = soc.pixelIdx;
      if (px >= 0 && px < pxN && hasSoc[px]) {
        cosThetaSoc[px] = Math.cos(soc.halfAngle ?? 0);
      }
    }
  }

  return { socNx, socNy, hasSoc, cosThetaSoc, socPixelCount };
}

// ── Phase B: run solve, persist, broadcast ────────────────────────────────
async function _runPhaseB(job, topoData) {
  const { jobId, metaKey, module, startMs, sw } = job;

  // Cancel the fallback "waiting for TOPOLOGY_DONE" timer now that Phase B is
  // actually starting — whether that's because topology arrived normally or
  // because the timeout itself fired with topoData=null. Without this the
  // timer keeps counting down after a normal, on-time completion and fires
  // ~180-210s later with a stale "TOPOLOGY_DONE timeout fired" warning even
  // though the job finished successfully long before (harmless today only
  // because _pendingJob is already null by then and the jobMatch guard no-ops).
  if (job.topoTimeoutHandle) {
    clearTimeout(job.topoTimeoutHandle);
    job.topoTimeoutHandle = null;
  }

  const store = _buildStore(sw);

  console.log('[minimizer.worker] Phase B starting', {
    jobId,
    metaKey,
    hasTopology:   !!topoData,
    hasComponentMap: !!topoData?.componentMap,
    b0:            topoData?.b0 ?? null,
    b1:            topoData?.b1 ?? null,
    phaseAToPhaseB: Date.now() - startMs
  });

  try {
    // Apply topology data if available
    if (topoData) {
      module.setTopology(topoData.componentMap, topoData.b0, topoData.b1);
    }

    // Run solver
    const solveStart = Date.now();
    const result     = module.solve();
    const solveMs    = Date.now() - solveStart;

    const {
      phiMin, zeroCurve, converged, stopReason,
      diagnostics, telemetry
    } = result;

    // Derive resolution from phiMin array length — module._w may reflect the
    // constructor `resolution` param rather than the actual working grid size
    // when MinimizerModule determines its grid from signedSdf.length internally.
    const resolution = phiMin?.length > 0
      ? Math.round(Math.sqrt(phiMin.length))
      : (module._w ?? 512);

    // ── Serialise zeroCurve for inline transfer and background IDB ────────
    const zeroCurveSerial = {
      loops: zeroCurve.loops.map(l => ({
        ...l,
        points: Array.from(l.points)
      })),
      arcs: zeroCurve.arcs.map(a => ({
        ...a,
        points: Array.from(a.points)
      })),
      topologyConsistent: zeroCurve.topologyConsistent,
      expectedLoops:      zeroCurve.expectedLoops,
      b0:                 zeroCurve.b0,
      b1:                 zeroCurve.b1,
      rawSegmentCount:    zeroCurve.rawSegmentCount,
      chainCount:         zeroCurve.chainCount
    };

    // ── Broadcast immediately — ambi.worker reads minimizerInline directly ─
    // IDB persistence runs fire-and-forget below; pipeline does not wait for it.
    _bcPost({
      event:                   'MINIMIZER_DONE',
      metaKey,
      jobId,
      // Keys null — consumers use minimizerInline directly.
      constrainedMinimizerKey: null,
      phiMinKey:               null,
      zeroCurveKey:            null,
      telemetryKey:            null,
      converged,
      stopReason,
      targetArea:              diagnostics.targetAreas[0]  ?? null,
      finalArea:               diagnostics.finalAreas[0]   ?? null,
      topologyConsistent:      diagnostics.topologyConsistent,
      minimizerInline: {
        phiMin,                    // Float32Array — structured-cloned
        zeroCurve: zeroCurveSerial,
        diagnostics,
        resolution,
        converged,
        stopReason
      },
      processingMs:            Date.now() - startMs
    });

    // ── Fire-and-forget IDB persistence — gated behind persistInlineArtifacts ──
    // phi_min (4MB) and zero_curve travel inline via minimizerInline to ambi,
    // kem, and correspondence. IDB writes are unnecessary in normal operation.
    if (_flags.persistInlineArtifacts) (async () => {
      const persistMeta = {
        sourceMetaKey:      metaKey,
        resolution,
        converged,
        stopReason,
        iterations:         diagnostics.iterations,
        targetAreas:        diagnostics.targetAreas,
        finalAreas:         diagnostics.finalAreas,
        topologyConsistent: diagnostics.topologyConsistent,
        socPixelCount:      job.socPixelCount ?? 0,
        solveMs,
        processingMs:       Date.now() - startMs,
        computedAt:         Date.now()
      };
      const TTL = PersistenceHelper.TTL.PINNED;
      try {
        const phiMinResult = await PersistenceHelper.persist(store, {
          type:    'phi_min',
          data:    { phi: phiMin, width: resolution, height: resolution },
          meta:    { ...persistMeta },
          ttl:     TTL,
          pinType: PersistenceHelper.PIN.SOFT
        });
        const zeroCurveResult = await PersistenceHelper.persist(store, {
          type:    'zero_curve',
          data:    zeroCurveSerial,
          meta:    { ...persistMeta, loopCount: zeroCurve.loops.length, arcCount: zeroCurve.arcs.length },
          ttl:     TTL,
          pinType: PersistenceHelper.PIN.SOFT
        });
        await PersistenceHelper.persist(store, {
          type:    'constrained_minimizer',
          data:    {
            phiMinKey:    phiMinResult?.metaKey    ?? null,
            zeroCurveKey: zeroCurveResult?.metaKey ?? null,
            diagnostics
          },
          meta:    { ...persistMeta },
          ttl:     TTL,
          pinType: PersistenceHelper.PIN.SOFT
        });
        if (_flags.packingDebug && telemetry) {
          await PersistenceHelper.persist(store, {
            type:    'minimizer_telemetry',
            data:    {
              convergenceCurve: Array.from(telemetry.convergenceCurve),
              lambdaCurve:      Array.from(telemetry.lambdaCurve),
              maxDeltaPhiCurve: Array.from(telemetry.maxDeltaPhiCurve),
              bandExpansions:   telemetry.bandExpansions,
              reinitCount:      telemetry.reinitCount
            },
            meta:    { ...persistMeta },
            ttl:     PersistenceHelper.TTL.DEBUG,
            pinType: PersistenceHelper.PIN.SOFT
          });
        }
        console.log('[minimizer.worker] Background persistence complete');
      } catch (e) {
        console.warn('[minimizer.worker] Background persistence failed (non-fatal):', e.message);
      }
    })();

  } catch (err) {
    console.error('[minimizer.worker] Phase B failed:', err);
    _bcPost({
      event:   'MINIMIZER_ERROR',
      metaKey,
      jobId,
      error:   _safeErr(err),
      wallMs:  Date.now() - startMs
    });
  } finally {
    _pendingJob = null;
    _topoData   = null;
  }
}

// ── BC listener: intercept TOPOLOGY_DONE ─────────────────────────────────
// FIX MW-B7: was _bc.onmessage = ... (property assignment overwrites any
// other handler). Using addEventListener is consistent with the rest of
// the codebase and is non-destructive.
if (_bc) {
  _bc.addEventListener('message', (evt) => {
    const data = evt.data;
    if (!data || data.event !== 'TOPOLOGY_DONE') return;

    console.log('[minimizer.worker] BC: TOPOLOGY_DONE received', {
      metaKey:           data.metaKey,
      hasPendingJob:     !!_pendingJob,
      pendingJobMetaKey: _pendingJob?.metaKey ?? null,
      metaKeyMatch:      data.metaKey === _pendingJob?.metaKey,
      hasTopoInline:     !!data.topoInline,
      hasComponentMap:   !!data.topoInline?.componentMap,
      receivedAt:        Date.now()
    });

    if (_pendingJob) {
      // Phase A already done — run Phase B immediately
      _loadTopoAndRunPhaseB(data).catch(err => {
        console.error('[minimizer.worker] topology load failed:', err);
        if (_pendingJob) _runPhaseB(_pendingJob, null).catch(console.error);
      });
    } else {
      // Phase A still in progress — cache for pickup once _pendingJob is set
      _topoData = {
        componentMap: data.topoInline?.componentMap ?? null,
        b0: data.topoInline?.betti?.b0 ?? data.betti?.b0 ?? 1,
        b1: data.topoInline?.betti?.b1 ?? data.betti?.b1 ?? 0
      };
      console.log('[minimizer.worker] TOPOLOGY_DONE cached (Phase A still running)');
    }
  });
}

async function _loadTopoAndRunPhaseB(topoMsg) {
  const job = _pendingJob;
  if (!job) return;

  // Cancel the fallback timer as soon as we know topology has genuinely
  // arrived — even before Phase B itself starts (IDB fallback load below can
  // still take time). Prevents a race where the timer fires mid-load.
  if (job.topoTimeoutHandle) {
    clearTimeout(job.topoTimeoutHandle);
    job.topoTimeoutHandle = null;
  }

  // Fast path: componentMap travels inline — skip IDB entirely.
  let componentMap = topoMsg.topoInline?.componentMap ?? null;

  if (!componentMap && topoMsg.componentMapKey) {
    // Slow path: inline absent, fall back to IDB.
    const api = await _loadStorageAPI();
    // Re-check: timeout may have fired and cleared _pendingJob while we awaited IDB.
    if (_pendingJob?.jobId !== job.jobId) {
      console.warn('[minimizer.worker] _loadTopoAndRunPhaseB: job superseded during IDB load — aborting');
      return;
    }
    componentMap = (await _loadArtifact(api, topoMsg.componentMapKey))?.data?.map ?? null;
  }

  // Guard: if timeout already claimed the job, don't run Phase B a second time.
  if (_pendingJob?.jobId !== job.jobId) {
    console.warn('[minimizer.worker] _loadTopoAndRunPhaseB: job superseded before Phase B — aborting');
    return;
  }

  const topoData = componentMap
    ? {
        componentMap: componentMap instanceof Int32Array
          ? componentMap
          : new Int32Array(componentMap),
        b0: topoMsg.topoInline?.betti?.b0 ?? topoMsg.betti?.b0 ?? 1,
        b1: topoMsg.topoInline?.betti?.b1 ?? topoMsg.betti?.b1 ?? 0
      }
    : null;

  await _runPhaseB(job, topoData);
}

// ── Main message handler ──────────────────────────────────────────────────
self.onmessage = async (evt) => {
  const msg = evt.data;
  if (!msg?.op) return;

  if (msg.op === 'init') {
    if (msg.flags) Object.assign(_flags, msg.flags);  // FIX MW-B2: was applyFlagsSnapshot
    return;
  }

  if (msg.op === 'TOPOLOGY_DONE') {
    if (_pendingJob) {
      _loadTopoAndRunPhaseB(msg).catch(err => {
        console.error('[minimizer.worker] direct topology load failed:', err);
        if (_pendingJob) _runPhaseB(_pendingJob, null).catch(console.error);
      });
    } else {
      _topoData = {
        componentMap: msg.topoInline?.componentMap ?? null,
        b0: msg.topoInline?.betti?.b0 ?? msg.betti?.b0 ?? 1,
        b1: msg.topoInline?.betti?.b1 ?? msg.betti?.b1 ?? 0
      };
      console.log('[minimizer.worker] TOPOLOGY_DONE cached via direct message (Phase A still running)');
    }
    return;
  }

  if (msg.op === 'MINIMIZE') {
    const { jobId, metaKey, flags: jobFlags, artifactKeys } = msg;
    if (jobFlags) Object.assign(_flags, jobFlags);    // FIX MW-B2: was applyFlagsSnapshot

    const startMs = Date.now();

    try {
      const api = await _loadStorageAPI();
      const sw  = _wrapStorage(api);

      // ── Load artifacts in parallel ────────────────────────────────────
      const sdfInline = msg.sdfInline ?? null;

      console.log('[minimizer.worker] Loading artifacts:', {
        hasSdfInline: !!sdfInline,
        diskSeedsKey: artifactKeys.diskSeedsKey ?? null,
        fluxFieldKey: artifactKeys.fluxFieldKey ?? null,
        curvatureKey: artifactKeys.curvatureKey ?? null
      });

      // sdfArt is constructed from sdfInline — not loaded from IDB.
      // sdfFieldKey is null (the IDB record contains only scalar metadata).
      // Shape matches what getArtifact would have returned so the unpack
      // block below (signedSdf, narrowBandMask) is unchanged.
      const sdfArt = sdfInline
        ? {
            data: {
              signedSdf:      sdfInline.signedSdf,
              narrowBandMask: sdfInline.narrowBandMask,
              densityMap:     sdfInline.densityMap  ?? null,
              surfaceMask:    sdfInline.surfaceMask ?? null
            }
          }
        : null;

      if (sdfInline) {
        console.log('[minimizer.worker] sdfInline received:', {
          signedSdfLength:      sdfInline.signedSdf?.length      ?? 0,
          narrowBandMaskLength: sdfInline.narrowBandMask?.length ?? 0,
          densityMapLength:     sdfInline.densityMap?.length     ?? 0,
          surfaceMaskLength:    sdfInline.surfaceMask?.length    ?? 0
        });
      } else {
        console.warn('[minimizer.worker] sdfInline absent — sdfArt will be null, minimizer will throw');
      }

      // fluxArt is constructed from fluxInline — not loaded from IDB.
      // fluxFieldKey is null — flux_field bypasses IDB entirely.
      // Shape matches what getArtifact would return so extractSOCs() and
      // any other consumer of fluxArt.data is unchanged.
      const fluxInline = msg.fluxInline ?? null;
      const fluxArt = fluxInline
        ? { data: {
              // Full flux_field — all components available
              A_coo:       fluxInline.A_coo       ?? null,
              A_csr:       fluxInline.A_csr       ?? null,
              b:           fluxInline.b           ?? null,
              SOCs:        fluxInline.SOCs        ?? null,
              groups:      fluxInline.groups      ?? null,
              supports:    fluxInline.supports    ?? null,
              init_h:      fluxInline.init_h      ?? null,
              diagnostics: fluxInline.diagnostics ?? null,
              solverReady: fluxInline.solverReady ?? false
            }}
        : null;

      if (fluxInline) {
        console.log('[minimizer.worker] fluxInline received (full flux_field):', {
          hasACoo:       !!fluxInline.A_coo,
          hasAcsr:       !!fluxInline.A_csr,
          hasB:          !!fluxInline.b,
          hasSOCs:       !!fluxInline.SOCs,
          hasInitH:      !!fluxInline.init_h,
          acoRowLength:  fluxInline.A_coo?.row?.length  ?? 0,
          solverReady:   fluxInline.solverReady          ?? false
        });
      } else {
        console.warn('[minimizer.worker] fluxInline absent — SOC normals will be zero (90° contact angle)');
      }

      // disk_seeds: use inline if provided, fall back to IDB.
      // Note: IDB format uses {header, payload} binary — diskSeedsArt.data.seeds
      // was always undefined. Inline format uses {x, y, r} directly.
      const diskSeedsInline = msg.diskSeedsInline ?? null;

      const [curvArt, normalArt] = await Promise.all([
        _loadArtifact(api, artifactKeys.curvatureKey),
        _loadArtifact(api, artifactKeys.normalMapKey)
      ]);

      // diskSeedsArt only loaded from IDB if inline is absent
      let diskSeedsArt = null;
      if (!diskSeedsInline && artifactKeys.diskSeedsKey) {
        diskSeedsArt = await _loadArtifact(api, artifactKeys.diskSeedsKey);
      }

      console.log('[minimizer.worker] Artifact load complete:', {
        hasSdfArt:      !!sdfArt,
        hasFluxArt:     !!fluxArt,
        hasFluxInline:  !!fluxInline,
        hasDiskSeeds:   !!diskSeedsArt,
        hasCurvature:   !!curvArt,
        hasNormalMap:   !!normalArt,
        diskSeedsCount: diskSeedsArt?.data?.seeds?.length ?? 0
      });

      if (!sdfArt) throw new Error('sdf_field artifact required for minimizer — sdfInline was absent in MINIMIZE message');

      const resolution = artifactKeys.resolution ?? 512;

      // ── Unpack SDF ─────────────────────────────────────────────────────
      const signedSdf      = sdfArt.data.signedSdf;
      const narrowBandMask = sdfArt.data.narrowBandMask;

      // ── Disk seeds ─────────────────────────────────────────────────────────
      // Prefer inline (normalized {x,y,r} objects, already in [0,1]).
      // IDB format uses {header,payload} binary — diskSeedsArt.data.seeds was
      // always undefined, so minimizer was silently receiving empty diskSeeds.
      let diskSeeds = [];
      if (diskSeedsInline?.length > 0) {
        diskSeeds = diskSeedsInline;
        console.log('[minimizer.worker] disk_seeds inline:', diskSeeds.length, 'seeds, bypassing IDB');
      } else if (diskSeedsArt?.data) {
        diskSeeds = diskSeedsArt.data.seeds ?? [];
        console.log('[minimizer.worker] disk_seeds from IDB:', diskSeeds.length, 'seeds');
      }

      // ── SOC extraction ─────────────────────────────────────────────────
      const { socNx, socNy, hasSoc, cosThetaSoc, socPixelCount } =
        extractSOCs(fluxArt, resolution);

      // ── Curvature warm-start — from dgInline, not IDB ─────────────────
      const dgInline = msg.dgInline ?? null;
      const kH = dgInline?.kH ?? curvArt?.data?.kH ?? null;
      if (dgInline?.kH) {
        console.log('[minimizer.worker] kH from dgInline — bypassing IDB read');
      }

      // ── Placeholder componentMap (single component) ───────────────────
      // Will be replaced in Phase B when TOPOLOGY_DONE arrives.
      const placeholderMap = new Int32Array(resolution * resolution).fill(0);

      // ── Construct module (Phase A) ─────────────────────────────────────
      const module = new MinimizerModule({
        signedSdf,
        narrowBandMask,
        diskSeeds,
        socNx, socNy, hasSoc, cosThetaSoc,
        componentMap: placeholderMap,
        b0:           1,
        b1:           0,
        kH,
        resolution,
        flags: _flags
      });

      // ── Store pending job ──────────────────────────────────────────────
      _pendingJob = { jobId, metaKey, module, startMs, sw, socPixelCount };
      console.log('[minimizer.worker] Phase A complete — _pendingJob set', {
        jobId,
        metaKey,
        phaseAMs: Date.now() - startMs,
        setAt:    Date.now()
      });

      // ── If topology data already arrived, run Phase B immediately ──────
      if (_topoData) {
        const td = _topoData;
        _topoData = null;
        await _runPhaseB(_pendingJob, td);
      }
      // Otherwise Phase B fires when TOPOLOGY_DONE arrives via BC listener.
      // Timeout fallback ensures minimizer never stalls indefinitely.
      else {
        // Scale wait to match topology.worker's own computation time.
        // topology.worker caps at topoMaxResolution (default 512²) → 60s.
        // Add 30s margin for IDB persist inside TopologyAnalyzer.
        const _topoRes  = Math.min(artifactKeys.resolution ?? 512,
                                   _flags.topoMaxResolution    ?? 512);
        // Base increased from 60s → 180s to match topology.worker's own timeout budget.
        // At 512², topology takes ~29s + fire-and-forget IDB writes under quota pressure.
        // minimizer must wait the full duration before falling back to null topology.
        const timeoutMs = 180_000 * Math.pow(Math.max(_topoRes, 512) / 512, 2) + 30_000;
        console.log(`[minimizer.worker] Waiting up to ${(timeoutMs/1000).toFixed(0)}s for TOPOLOGY_DONE (topoRes=${_topoRes})`);
        // Handle stored on _pendingJob itself (not a local variable) so
        // _runPhaseB — reached via the BC/direct-message TOPOLOGY_DONE path,
        // which has no visibility into this closure — can find and cancel it.
        _pendingJob.topoTimeoutHandle = setTimeout(() => {
          const jobMatch = _pendingJob?.jobId === jobId;
          console.warn('[minimizer.worker] TOPOLOGY_DONE timeout fired', {
            jobId,
            jobMatch,
            pendingJobId:      _pendingJob?.jobId ?? null,
            actualElapsedMs:   Date.now() - startMs,
            expectedTimeoutMs: timeoutMs
          });
          if (jobMatch) {
            console.warn('[minimizer.worker] Running Phase B without topology');
            const job = _pendingJob;
            _runPhaseB(job, null).catch(console.error);
          }
        }, timeoutMs);
      }

    } catch (err) {
      console.error('[minimizer.worker] MINIMIZE setup failed:', err);
      _bcPost({
        event:   'MINIMIZER_ERROR',
        metaKey,
        jobId,
        error:   _safeErr(err),
        wallMs:  Date.now() - startMs
      });
    }
    return;
  }

  if (msg.op === 'shutdown') {
    if (_bc) try { _bc.close(); } catch(e) {}
    self.close();
  }
};