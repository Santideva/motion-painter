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

// ── Resolution downsampling helper ───────────────────────────────────────
// phiMinInline arrives at minimizerResolution (1024²); correspondence runs
// at topoResolution (512²). Direct indexing reads the top-left quarter only.
function _downsampleScalar(src, srcRes, dstRes) {
  if (!src || srcRes === dstRes) return src;
  const scale = srcRes / dstRes;
  const out   = new src.constructor(dstRes * dstRes);
  for (let y = 0; y < dstRes; y++) {
    for (let x = 0; x < dstRes; x++) {
      const sy = Math.min(srcRes - 1, Math.floor(y * scale));
      const sx = Math.min(srcRes - 1, Math.floor(x * scale));
      out[y * dstRes + x] = src[sy * srcRes + sx];
    }
  }
  return out;
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
    // ── Resolve all inputs — inline-first (IDB never needed, all keys null) ─
    // api/sw are only opened inside the fire-and-forget IIFE below.
    const resolution = artifactKeys.resolution ?? 512;
    const N          = resolution * resolution;

    // warpField — from warpFieldInline (ambi AMBI_DONE) or IDB
    let warpField = null;
    if (msg.warpFieldInline?.field) {
      warpField = msg.warpFieldInline.field instanceof Float32Array
        ? msg.warpFieldInline.field
        : new Float32Array(msg.warpFieldInline.field);
      console.log('[correspondence.worker] warpField from inline, length:', warpField.length);
    } else {
      const wfArt = await _loadArtifact(api, artifactKeys.warpFieldKey);
      if (!wfArt?.data?.field) throw new Error('warp_field artifact required for correspondence');
      warpField = new Float32Array(wfArt.data.field);
    }

    // worldFrameMap — from worldFrameMapInline (ambi AMBI_DONE) or IDB
    let worldFrameMap = null;
    if (msg.worldFrameMapInline?.map) {
      worldFrameMap = msg.worldFrameMapInline.map instanceof Int32Array
        ? msg.worldFrameMapInline.map
        : new Int32Array(msg.worldFrameMapInline.map);
      console.log('[correspondence.worker] worldFrameMap from inline, length:', worldFrameMap.length);
    } else {
      const wfmArt = await _loadArtifact(api, artifactKeys.worldFrameMapKey);
      if (!wfmArt?.data?.map) throw new Error('world_frame_map artifact required for correspondence');
      worldFrameMap = new Int32Array(wfmArt.data.map);
    }

    // primeEnds — from primeEndsInline (topoInline.primeEnds) or IDB
    let ends = [];
    if (Array.isArray(msg.primeEndsInline) && msg.primeEndsInline.length > 0) {
      ends = msg.primeEndsInline;
      console.log('[correspondence.worker] primeEnds from inline:', ends.length, 'ends');
    } else {
      const peArt = await _loadArtifact(api, artifactKeys.primeEndsKey);
      ends = peArt?.data?.ends ?? [];
      if (ends.length === 0) {
        console.warn('[correspondence.worker] prime_ends has no ends — symmetry axis will be degenerate');
      }
    }

    // topologyMap — from topologyMapInline (topoInline.topologyMap) or IDB
    let topologyMap = null;
    if (msg.topologyMapInline) {
      topologyMap = msg.topologyMapInline instanceof Int32Array
        ? msg.topologyMapInline
        : new Int32Array(msg.topologyMapInline);
      console.log('[correspondence.worker] topologyMap from inline, length:', topologyMap.length);
    } else {
      const tmArt = await _loadArtifact(api, artifactKeys.topologyMapKey);
      if (tmArt?.data?.map) {
        topologyMap = new Int32Array(tmArt.data.map);
      } else {
        console.warn(
          '[correspondence.worker] topology_map absent — per-end spatial index ' +
          'disabled; correspondence will use global fallback (degraded mode).'
        );
      }
    }

    // narrowBandMask — reconstruct from phiMinInline.
    // phiMinInline is at minimizerResolution (1024²); downsample to topoResolution
    // before thresholding — direct indexing reads the top-left quarter only.
    let narrowBandMask;
    if (msg.phiMinInline instanceof Float32Array) {
      const phiMinRes = Math.round(Math.sqrt(msg.phiMinInline.length));
      const phiDS     = phiMinRes !== resolution
        ? _downsampleScalar(msg.phiMinInline, phiMinRes, resolution)
        : msg.phiMinInline;
      narrowBandMask = _narrowBandFromPhi(phiDS, resolution);
      console.log('[correspondence.worker] narrowBandMask reconstructed from phiMinInline', {
        phiMinRes, resolution, downsampled: phiMinRes !== resolution
      });
    } else {
      const phiArt = await _loadArtifact(api, artifactKeys.phiMinKey);
      if (phiArt?.data?.phi) {
        narrowBandMask = _narrowBandFromPhi(new Float32Array(phiArt.data.phi), resolution);
      } else {
        console.warn('[correspondence.worker] phiMin absent — using full-image narrow band');
        narrowBandMask = new Float32Array(N).fill(1);
      }
    }

    // legibilityScore — from surfaceParamInline or IDB
    let legibilityScore = 1.0;
    if (msg.surfaceParamInline) {
      legibilityScore = msg.surfaceParamInline.legibilityScore ?? 1.0;
      console.log('[correspondence.worker] surfaceParam from inline');
    } else {
      const spArt = await _loadArtifact(api, artifactKeys.surfaceParamKey);
      legibilityScore = spArt?.data?.legibilityScore ?? 1.0;
    }

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

    // ── Broadcast CORRESPONDENCE_DONE immediately — no IDB round-trip ─────
    // correspondence_map (Int32Array 512²), confidence_map (Float32Array 512²),
    // bilateral_consistency_map (Uint8Array 512²): no downstream IDB consumer.
    // Array.from() on 262144-element typed arrays + JSON serialization = 6-15MB
    // of transient allocations that reliably OOM the worker under load.
    _bcPost({
      event:                      'CORRESPONDENCE_DONE',
      metaKey,
      jobId,
      correspondenceMapKey:       null,
      confidenceMapKey:           null,
      bilateralConsistencyMapKey: null,
      correspondenceSummaryKey:   null,
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
      symmetryMismatchScore:     symmetryMismatchScore.toFixed(3),
      geometricAsymmetry:        geometricAsymmetry.toFixed(3),
      reconstructionConsistency: reconstructionConsistency.toFixed(3),
      unmatchedFraction:         unmatchedFraction.toFixed(3),
      crossBoundaryPixels:       diagnostics.crossBoundaryPixels,
      processingMs:              Date.now() - startMs
    });

    // ── Fire-and-forget IDB persistence — gated behind persistInlineArtifacts ──
    if (_flags.persistInlineArtifacts) (async () => {
      try {
        const api   = await _loadStorageAPI();
        const sw    = _wrapStorage(api);
        const store = _buildStore(sw);
        const TTL   = PersistenceHelper.TTL?.PINNED ?? 300_000;
        const persistMeta = {
          sourceMetaKey: metaKey, resolution,
          symmetryMismatchScore, geometricAsymmetry, reconstructionConsistency,
          symmetryAxisAngle, thetaAxis, degradedSymmetryAxis, unmatchedFraction,
          legibilityScore,
          unreliableScore:     diagnostics.unreliableScore,
          crossBoundaryPixels: diagnostics.crossBoundaryPixels,
          topologyMapPresent:  !!topologyMap,
          computedAt:          Date.now()
        };
        await PersistenceHelper.persist(store, {
          type:    'correspondence_map',
          data:    { map: Array.from(correspondenceMap), width: resolution, height: resolution },
          meta:    { ...persistMeta }, ttl: TTL, pinType: PersistenceHelper.PIN?.SOFT ?? 'soft'
        });
        await PersistenceHelper.persist(store, {
          type:    'confidence_map',
          data:    { map: Array.from(confidenceMap), width: resolution, height: resolution },
          meta:    { ...persistMeta }, ttl: TTL, pinType: PersistenceHelper.PIN?.SOFT ?? 'soft'
        });
        await PersistenceHelper.persist(store, {
          type:    'bilateral_consistency_map',
          data:    { map: Array.from(bilateralConsistencyMap), width: resolution, height: resolution },
          meta:    { ...persistMeta }, ttl: TTL, pinType: PersistenceHelper.PIN?.SOFT ?? 'soft'
        });
        await PersistenceHelper.persist(store, {
          type:    'correspondence_summary',
          data:    {
            symmetryMismatchScore, geometricAsymmetry, reconstructionConsistency,
            symmetryAxisAngle, thetaAxis, degradedSymmetryAxis, unmatchedFraction,
            unreliableScore:     diagnostics.unreliableScore,
            crossBoundaryPixels: diagnostics.crossBoundaryPixels,
            matchedPixels:       diagnostics.matchedPixels,
            unmatchedPixels:     diagnostics.unmatchedPixels,
            totalNarrowBand:     diagnostics.totalNarrowBand,
            meanGeometricError:  diagnostics.meanGeometricError,
            meanConfidence:      diagnostics.meanConfidence,
            topologyMapPresent:  !!topologyMap,
            legibilityScore
          },
          meta:    { ...persistMeta }, ttl: TTL, pinType: PersistenceHelper.PIN?.SOFT ?? 'soft'
        });
        console.log('[correspondence.worker] Background persistence complete');
      } catch (e) {
        console.warn('[correspondence.worker] Background persistence failed (non-fatal):', e.message);
      }
    })();

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