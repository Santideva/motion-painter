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

  // Override from SOC cone descriptors if available
  if (fluxArt.data.SOCs) {
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
  const store = _buildStore(sw);

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

    const resolution  = module._w;
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

    const TTL = PersistenceHelper.TTL.PINNED;  // 300_000 ms

    // ── Persist phiMin ──────────────────────────────────────────────────
    // FIX MW-B6: ttl and pinType moved inside descriptor (were silent third arg)
    const phiMinResult = await PersistenceHelper.persist(store, {
      type:    'phi_min',
      data:    { phi: phiMin, width: resolution, height: resolution },
      meta:    { ...persistMeta },
      ttl:     TTL,
      pinType: PersistenceHelper.PIN.SOFT
    });

    // ── Persist zeroCurve ───────────────────────────────────────────────
    // Serialise loops/arcs (convert Float32Arrays to plain arrays for JSON)
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

    // FIX MW-B6: ttl and pinType moved inside descriptor
    const zeroCurveResult = await PersistenceHelper.persist(store, {
      type:    'zero_curve',
      data:    zeroCurveSerial,
      meta:    {
        ...persistMeta,
        loopCount: zeroCurve.loops.length,
        arcCount:  zeroCurve.arcs.length
      },
      ttl:     TTL,
      pinType: PersistenceHelper.PIN.SOFT
    });

    // ── Persist constrained_minimizer ───────────────────────────────────
    // FIX MW-B6: ttl and pinType moved inside descriptor
    const minimizerResult = await PersistenceHelper.persist(store, {
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

    // ── Persist telemetry (debug only) ──────────────────────────────────
    // FIX MW-B6: ttl and pinType moved inside descriptor
    let telemetryResult = null;
    if (_flags.packingDebug) {
      telemetryResult = await PersistenceHelper.persist(store, {
        type:    'minimizer_telemetry',
        data:    {
          convergenceCurve: Array.from(telemetry.convergenceCurve),
          lambdaCurve:      Array.from(telemetry.lambdaCurve),
          maxDeltaPhiCurve: Array.from(telemetry.maxDeltaPhiCurve),
          bandExpansions:   telemetry.bandExpansions,
          reinitCount:      telemetry.reinitCount
        },
        meta:    { ...persistMeta },
        ttl:     PersistenceHelper.TTL.DEBUG,   // 30_000 ms
        pinType: PersistenceHelper.PIN.SOFT
      });
    }

    _bcPost({
      event:                   'MINIMIZER_DONE',
      metaKey,
      jobId,
      constrainedMinimizerKey: minimizerResult?.metaKey    ?? null,
      phiMinKey:               phiMinResult?.metaKey       ?? null,
      zeroCurveKey:            zeroCurveResult?.metaKey    ?? null,
      telemetryKey:            telemetryResult?.metaKey    ?? null,
      converged,
      stopReason,
      targetArea:              diagnostics.targetAreas[0]  ?? null,
      finalArea:               diagnostics.finalAreas[0]   ?? null,
      topologyConsistent:      diagnostics.topologyConsistent,
      processingMs:            Date.now() - startMs
    });

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
    if (!data) return;

    if (data.event === 'TOPOLOGY_DONE' && _pendingJob) {
      // Load component_map artifact then run Phase B
      _loadTopoAndRunPhaseB(data).catch(err => {
        console.error('[minimizer.worker] topology load failed:', err);
        // Run Phase B without topology data (global λ fallback)
        if (_pendingJob) _runPhaseB(_pendingJob, null).catch(console.error);
      });
    }
  });
}

async function _loadTopoAndRunPhaseB(topoMsg) {
  const job = _pendingJob;
  if (!job) return;

  const api = await _loadStorageAPI();

  // Load component_map artifact (persisted by TopologyAnalyzer)
  const componentMapArt = topoMsg.componentMapKey
    ? await _loadArtifact(api, topoMsg.componentMapKey)
    : null;

  const topoData = componentMapArt
    ? {
        componentMap: new Int32Array(componentMapArt.data.map),
        b0:           topoMsg.betti?.b0 ?? 1,
        b1:           topoMsg.betti?.b1 ?? 0
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

  if (msg.op === 'MINIMIZE') {
    const { jobId, metaKey, flags: jobFlags, artifactKeys } = msg;
    if (jobFlags) Object.assign(_flags, jobFlags);    // FIX MW-B2: was applyFlagsSnapshot

    const startMs = Date.now();

    try {
      const api = await _loadStorageAPI();
      const sw  = _wrapStorage(api);

      // ── Load artifacts in parallel ────────────────────────────────────
      const [sdfArt, diskSeedsArt, fluxArt, curvArt, normalArt] = await Promise.all([
        _loadArtifact(api, artifactKeys.sdfFieldKey),
        _loadArtifact(api, artifactKeys.diskSeedsKey),
        _loadArtifact(api, artifactKeys.fluxFieldKey),
        _loadArtifact(api, artifactKeys.curvatureKey),
        _loadArtifact(api, artifactKeys.normalMapKey)
      ]);

      if (!sdfArt) throw new Error('sdf_field artifact required for minimizer');

      const resolution = artifactKeys.resolution ?? 512;

      // ── Unpack SDF ─────────────────────────────────────────────────────
      const signedSdf      = sdfArt.data.signedSdf;
      const narrowBandMask = sdfArt.data.narrowBandMask;

      // ── Disk seeds ─────────────────────────────────────────────────────
      let diskSeeds = [];
      if (diskSeedsArt?.data) {
        diskSeeds = diskSeedsArt.data.seeds ?? [];
      }

      // ── SOC extraction ─────────────────────────────────────────────────
      const { socNx, socNy, hasSoc, cosThetaSoc, socPixelCount } =
        extractSOCs(fluxArt, resolution);

      // ── Curvature warm-start ───────────────────────────────────────────
      const kH = curvArt?.data?.kH ?? null;

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

      // ── If topology data already arrived, run Phase B immediately ──────
      if (_topoData) {
        const td = _topoData;
        _topoData = null;
        await _runPhaseB(_pendingJob, td);
      }
      // Otherwise Phase B fires when TOPOLOGY_DONE arrives via BC listener.
      // Timeout fallback ensures minimizer never stalls indefinitely.
      else {
        const timeoutMs = 10_000;
        setTimeout(() => {
          if (_pendingJob?.jobId === jobId) {
            console.warn('[minimizer.worker] TOPOLOGY_DONE timeout — running Phase B without topology');
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