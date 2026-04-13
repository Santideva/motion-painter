// /src/js/core/correspondence.worker.js
//
// Stage 7 — Bilateral correspondence worker shell.
//
// Execution model:
//   Triggered by: CORRESPONDENCE_ANALYZE (direct postMessage from main.js)
//   Fires when:   STAGE5_DONE has been dispatched (AMBI_DONE processed by main.js)
//   Runs in parallel with: kem.worker (Stage 6)
//   Outputs:      CORRESPONDENCE_DONE (BC broadcast — writes stage7, gates Stage 8)
//
// No persistent module-level state between calls.
// Each CORRESPONDENCE_ANALYZE is independent — one CorrespondenceModule per call.
//
// Artifact layout (confirmed from producing workers):
//   warp_field:        { field: number[], width, height }  → Float32Array (Stage 5)
//   world_frame_map:   { map: number[],   width, height }  → Int32Array   (Stage 5)
//   prime_ends:        { ends: PrimeEnd[], ... }                           (Stage 4A)
//   topology_map:      { map: number[],   width, height }  → Int32Array   (Stage 4A)
//   phi_min:           { phi: number[],   width, height }  → narrowBandMask from |phi|
//
// All corrections pre-applied:
//   - BC channel 'motion-painter-store'
//   - No applyFlagsSnapshot — Object.assign
//   - Storage import './storage.js'
//   - PersistenceHelper default import
//   - _buildStore 5-positional-arg signature
//   - All persist calls with TTL/pinType inside descriptor
//   - BC listener uses addEventListener

import { CorrespondenceModule } from './CorrespondenceModule.js';
import PersistenceHelper         from './PersistenceHelper.js';

// ── BroadcastChannel ─────────────────────────────────────────────────────
let _bc = null;
try { _bc = new BroadcastChannel('motion-painter-store'); } catch(e) {}

function _bcPost(p) { if (_bc) try { _bc.postMessage(p); } catch(e) {} }
function _safeErr(e) { return { message: e?.message ?? String(e), stack: e?.stack ?? null }; }

let _storageAPI = null;
let _flags      = {};

// ── Storage helpers ───────────────────────────────────────────────────────
async function _loadStorageAPI() {
  if (_storageAPI) return _storageAPI;
  const mod = await import('./storage.js');
  _storageAPI = mod.default ?? mod.storageAPI ?? mod;
  return _storageAPI;
}

async function _retryable(fn, attempts = 3, delay = 80) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); } catch(e) {
      last = e;
      const transient = e?.name === 'InvalidStateError' ||
                        e?.message?.includes('transaction');
      if (!transient || i === attempts) throw e;
      await new Promise(r => setTimeout(r, delay * i));
    }
  }
  throw last;
}

function _wrapStorage(api) {
  return {
    putArtifact: art => _retryable(() => api.putInboundArtifact(art)),
    raw:         api
  };
}

function _buildStore(sw) {
  return {
    persistAndPin: async (type, data, meta, ttlMs, pinType) => {
      const artifact = { type, data, meta };
      let putResult;
      try {
        putResult = await sw.putArtifact(artifact);
      } catch (e) {
        throw new Error(`correspondence.worker: putArtifact failed for ${type}: ${e.message}`);
      }
      if (!putResult?.ok || !putResult.metaKey) {
        throw new Error(`correspondence.worker: no metaKey returned for ${type}`);
      }
      const pinFn = sw.raw?.pinArtifact ??
        (typeof self.pinArtifact === 'function' ? self.pinArtifact : null);
      if (typeof pinFn === 'function') {
        try {
          await pinFn(putResult.metaKey, {
            owner:  'correspondence.worker',
            type:   pinType ?? 'soft',
            ttlMs:  ttlMs > 0 ? ttlMs : null
          });
        } catch (e) {
          console.warn(
            `[correspondence.worker] pin failed for ${putResult.metaKey.slice(0,20)}... (non-fatal):`,
            e.message
          );
        }
      }
      return putResult;
    }
  };
}

async function _loadArtifact(api, key) {
  if (!key) return null;
  return _retryable(() => api.getArtifact(key));
}

// ── Narrow band reconstruction (consistent with ambi.worker / kem.worker) ─
function _narrowBandFromPhi(phi, resolution) {
  const N     = resolution * resolution;
  const mask  = new Float32Array(N);
  const thresh = 12 / resolution;
  for (let i = 0; i < N; i++) mask[i] = Math.abs(phi[i]) < thresh ? 1 : 0;
  return mask;
}

// ── CORRESPONDENCE_ANALYZE handler ───────────────────────────────────────
async function _handleCorrespondenceAnalyze(msg) {
  const { jobId, metaKey, flags: jobFlags, artifactKeys } = msg;
  if (jobFlags) Object.assign(_flags, jobFlags);

  const startMs = Date.now();

  try {
    const api = await _loadStorageAPI();
    const sw  = _wrapStorage(api);

    // ── Load Group A: always required ─────────────────────────────────────
    const [
      warpFieldArt,
      worldFrameMapArt,
      primeEndsArt,
      topologyMapArt       // promoted to Group A — needed for per-end index
    ] = await Promise.all([
      _loadArtifact(api, artifactKeys.warpFieldKey),
      _loadArtifact(api, artifactKeys.worldFrameMapKey),
      _loadArtifact(api, artifactKeys.primeEndsKey),
      _loadArtifact(api, artifactKeys.topologyMapKey)
    ]);

    if (!warpFieldArt)     throw new Error('warp_field artifact required for correspondence');
    if (!worldFrameMapArt) throw new Error('world_frame_map artifact required for correspondence');
    if (!primeEndsArt)     throw new Error('prime_ends artifact required for correspondence');

    // topologyMap is critical for per-end indexing; warn but continue if absent
    if (!topologyMapArt) {
      console.warn(
        '[correspondence.worker] topology_map absent — per-end spatial index ' +
        'disabled; correspondence will use global fallback (degraded mode). ' +
        'Cross-boundary unmatched check is also disabled.'
      );
    }

    // ── Load Group B: soft failures ───────────────────────────────────────
    const [
      phiMinArt,
      surfaceParamArt
    ] = await Promise.all([
      _loadArtifact(api, artifactKeys.phiMinKey),
      _loadArtifact(api, artifactKeys.surfaceParamKey)
    ]);

    // ── Unpack ─────────────────────────────────────────────────────────────
    const resolution = artifactKeys.resolution ?? 512;
    const N          = resolution * resolution;

    // warp_field → Float32Array
    const warpFieldRaw = warpFieldArt.data?.field;
    if (!warpFieldRaw) throw new Error('warp_field artifact missing field data');
    const warpField = new Float32Array(warpFieldRaw);

    // world_frame_map → Int32Array
    const worldFrameMapRaw = worldFrameMapArt.data?.map;
    if (!worldFrameMapRaw) throw new Error('world_frame_map artifact missing map data');
    const worldFrameMap = new Int32Array(worldFrameMapRaw);

    // prime_ends: PrimeEnd[] with boundaryInterval attached (Fix 1B)
    const ends = primeEndsArt.data?.ends ?? [];
    if (ends.length === 0) {
      console.warn('[correspondence.worker] prime_ends has no ends — symmetry axis will be degenerate');
    }

    // topology_map → Int32Array (null in degraded mode)
    // Used by CorrespondenceModule to build per-end spatial index and for
    // the explicit cross-boundary unmatched check.
    const topologyMap = topologyMapArt?.data?.map
      ? new Int32Array(topologyMapArt.data.map)
      : null;

    // narrowBandMask — reconstructed from phi_min
    let narrowBandMask;
    if (phiMinArt?.data?.phi) {
      narrowBandMask = _narrowBandFromPhi(new Float32Array(phiMinArt.data.phi), resolution);
    } else {
      console.warn('[correspondence.worker] phi_min absent — using full-image narrow band');
      narrowBandMask = new Float32Array(N).fill(1);
    }

    const legibilityScore = surfaceParamArt?.data?.legibilityScore ?? 1.0;

    // ── Construct and run CorrespondenceModule ─────────────────────────────
    const corrModule = new CorrespondenceModule({
      warpField,
      worldFrameMap,
      narrowBandMask,
      ends,
      topologyMap,        // now properly passed — enables per-end index + cross-boundary check
      legibilityScore,
      resolution,
      flags: _flags
    });

    const result = corrModule.compute();

    const {
      correspondenceMap,
      confidenceMap,
      bilateralConsistencyMap,
      symmetryMismatchScore,
      geometricAsymmetry,
      reconstructionConsistency,
      symmetryAxisAngle,
      thetaAxis,
      degradedSymmetryAxis,
      unmatchedFraction,
      diagnostics
    } = result;

    // ── Persist ────────────────────────────────────────────────────────────
    const store = _buildStore(sw);
    const TTL   = PersistenceHelper.TTL?.PINNED ?? 300_000;

    const persistMeta = {
      sourceMetaKey:            metaKey,
      resolution,
      symmetryMismatchScore,
      geometricAsymmetry,
      reconstructionConsistency,
      symmetryAxisAngle,
      thetaAxis,
      degradedSymmetryAxis,
      unmatchedFraction,
      legibilityScore,
      unreliableScore:          diagnostics.unreliableScore,
      crossBoundaryPixels:      diagnostics.crossBoundaryPixels,
      topologyMapPresent:       !!topologyMap,
      computedAt:               Date.now()
    };

    const corrMapResult = await PersistenceHelper.persist(store, {
      type:    'correspondence_map',
      data:    { map: Array.from(correspondenceMap), width: resolution, height: resolution },
      meta:    { ...persistMeta },
      ttl:     TTL,
      pinType: PersistenceHelper.PIN?.SOFT ?? 'soft'
    });

    const confMapResult = await PersistenceHelper.persist(store, {
      type:    'confidence_map',
      data:    { map: Array.from(confidenceMap), width: resolution, height: resolution },
      meta:    { ...persistMeta },
      ttl:     TTL,
      pinType: PersistenceHelper.PIN?.SOFT ?? 'soft'
    });

    const bilateralResult = await PersistenceHelper.persist(store, {
      type:    'bilateral_consistency_map',
      data:    { map: Array.from(bilateralConsistencyMap), width: resolution, height: resolution },
      meta:    { ...persistMeta },
      ttl:     TTL,
      pinType: PersistenceHelper.PIN?.SOFT ?? 'soft'
    });

    const summaryResult = await PersistenceHelper.persist(store, {
      type:    'correspondence_summary',
      data:    {
        symmetryMismatchScore,
        geometricAsymmetry,
        reconstructionConsistency,
        symmetryAxisAngle,
        thetaAxis,
        degradedSymmetryAxis,
        unmatchedFraction,
        unreliableScore:        diagnostics.unreliableScore,
        crossBoundaryPixels:    diagnostics.crossBoundaryPixels,
        matchedPixels:          diagnostics.matchedPixels,
        unmatchedPixels:        diagnostics.unmatchedPixels,
        totalNarrowBand:        diagnostics.totalNarrowBand,
        meanGeometricError:     diagnostics.meanGeometricError,
        meanConfidence:         diagnostics.meanConfidence,
        topologyMapPresent:     !!topologyMap,
        legibilityScore
      },
      meta:    { ...persistMeta },
      ttl:     TTL,
      pinType: PersistenceHelper.PIN?.SOFT ?? 'soft'
    });

    // ── Broadcast CORRESPONDENCE_DONE ─────────────────────────────────────
    _bcPost({
      event:                      'CORRESPONDENCE_DONE',
      metaKey,
      jobId,
      correspondenceMapKey:       corrMapResult?.metaKey    ?? null,
      confidenceMapKey:           confMapResult?.metaKey    ?? null,
      bilateralConsistencyMapKey: bilateralResult?.metaKey  ?? null,
      correspondenceSummaryKey:   summaryResult?.metaKey    ?? null,
      symmetryMismatchScore,
      geometricAsymmetry,
      reconstructionConsistency,
      symmetryAxisAngle,
      unmatchedFraction,
      unreliableScore:            diagnostics.unreliableScore,
      processingMs:               Date.now() - startMs
    });

    console.log('[correspondence.worker] CORRESPONDENCE_DONE broadcast', {
      metaKey,
      symmetryMismatchScore:    symmetryMismatchScore.toFixed(3),
      geometricAsymmetry:       geometricAsymmetry.toFixed(3),
      reconstructionConsistency: reconstructionConsistency.toFixed(3),
      unmatchedFraction:        unmatchedFraction.toFixed(3),
      crossBoundaryPixels:      diagnostics.crossBoundaryPixels,
      processingMs:             Date.now() - startMs
    });

  } catch (err) {
    console.error('[correspondence.worker] CORRESPONDENCE_ANALYZE failed:', err);
    _bcPost({
      event:   'CORRESPONDENCE_ERROR',
      metaKey,
      jobId,
      error:   _safeErr(err),
      wallMs:  Date.now() - startMs
    });
  }
}

// ── BC listener ───────────────────────────────────────────────────────────
if (_bc) {
  _bc.addEventListener('message', (evt) => {
    const data = evt.data;
    if (!data) return;
    if (data.event === 'flagsChanged') {
      Object.assign(_flags, data.flags ?? {});
    }
  });
}

// ── Main message handler ──────────────────────────────────────────────────
self.onmessage = async (evt) => {
  const msg = evt.data;
  if (!msg?.op) return;

  if (msg.op === 'init') {
    if (msg.flags) Object.assign(_flags, msg.flags);
    return;
  }

  if (msg.op === 'CORRESPONDENCE_ANALYZE') {
    await _handleCorrespondenceAnalyze(msg);
    return;
  }

  if (msg.op === 'shutdown') {
    if (_bc) try { _bc.close(); } catch(e) {}
    self.close();
  }
};