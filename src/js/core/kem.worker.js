// /src/js/core/kem.worker.js
//
// Stage 6 — Kinetic Energy Map (KEM) worker shell.
//
// Execution model:
//   Triggered by: KEM_ANALYZE (direct postMessage from main.js)
//   Fires when:   STAGE5_DONE has been dispatched (AMBI_DONE processed by main.js)
//   Outputs:      AMBI_REFINE (BC broadcast to ambi.worker — feedback to Stage 5)
//                 KEM_DONE    (BC broadcast to main.js — writes stage6, gates Stage 8)
//
// No persistent module-level state between calls.
// Each KEM_ANALYZE is independent — one KEMModule instance per call.
//
// Flow field artifact layout (confirmed from motion.worker CHANGE 7):
//   art.data.u — Float32Array res²  (H-S flow u-component)
//   art.data.v — Float32Array res²  (H-S flow v-component)
//
// All corrections pre-applied:
//   - BC channel 'motion-painter-store'
//   - No applyFlagsSnapshot — Object.assign
//   - Storage import './storage.js'
//   - PersistenceHelper default import
//   - _buildStore 5-positional-arg signature
//   - All persist calls with TTL/pinType inside descriptor
//   - BC listener uses addEventListener

import { KEMModule }       from './KEMModule.js';
import PersistenceHelper   from './PersistenceHelper.js';

// ── BroadcastChannel ─────────────────────────────────────────────────────
let _bc = null;
try { _bc = new BroadcastChannel('motion-painter-store'); } catch(e) {}

function _bcPost(p) { if (_bc) try { _bc.postMessage(p); } catch(e) {} }
function _safeErr(e) { return { message: e?.message ?? String(e), stack: e?.stack ?? null }; }

// ── Module-level state ────────────────────────────────────────────────────
let _storageAPI = null;
let _flags      = {};

// ── Storage ───────────────────────────────────────────────────────────────
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

// ── Store adapter ─────────────────────────────────────────────────────────
function _buildStore(sw) {
  return {
    persistAndPin: async (type, data, meta, ttlMs, pinType) => {
      const artifact = { type, data, meta };

      let putResult;
      try {
        putResult = await sw.putArtifact(artifact);
      } catch (e) {
        throw new Error(`kem.worker: putArtifact failed for ${type}: ${e.message}`);
      }

      if (!putResult?.ok || !putResult.metaKey) {
        throw new Error(`kem.worker: no metaKey returned for ${type}`);
      }

      const pinFn = sw.raw?.pinArtifact ??
        (typeof self.pinArtifact === 'function' ? self.pinArtifact : null);
      if (typeof pinFn === 'function') {
        try {
          await pinFn(putResult.metaKey, {
            owner:  'kem.worker',
            type:   pinType ?? 'soft',
            ttlMs:  ttlMs > 0 ? ttlMs : null
          });
        } catch (e) {
          console.warn(
            `[kem.worker] pin failed for ${putResult.metaKey.slice(0,20)}... (non-fatal):`,
            e.message
          );
        }
      }

      return putResult;
    }
  };
}

// ── Artifact loading ───────────────────────────────────────────────────────
async function _loadArtifact(api, key) {
  if (!key) return null;
  return _retryable(() => api.getArtifact(key));
}

// ── coherencePerPixel defensive extraction (same pattern as ambi.worker) ──
function _extractCoherence(art) {
  if (!art?.data) return null;
  const c = art.data.coherence;
  if (!c) return null;
  if (c instanceof Float32Array) return c;
  if (c.perPixel instanceof Float32Array) return c.perPixel;
  return null;
}

// ── velocityManifold serialisation ────────────────────────────────────────
// KEMModule returns Int32Array pixel index arrays per clade.
// Storage requires plain JSON-serialisable values — convert typed arrays.
function _serialiseVelocityManifold(vm) {
  const out = {};
  for (const [cladeId, entry] of Object.entries(vm)) {
    out[cladeId] = {
      meanFlowU:      entry.meanFlowU,
      meanFlowV:      entry.meanFlowV,
      meanSpeed:      entry.meanSpeed,
      meanKEM:        entry.meanKEM,
      leadingKEM:     entry.leadingKEM,
      trailingKEM:    entry.trailingKEM,
      pixelCount:     entry.pixelCount,
      boundaryCount:  entry.boundaryCount,
      leadingPixels:  Array.from(entry.leadingPixels),
      trailingPixels: Array.from(entry.trailingPixels),
      lateralPixels:  Array.from(entry.lateralPixels)
    };
  }
  return out;
}

// ── KEM_ANALYZE handler ───────────────────────────────────────────────────
async function _handleKEMAnalyze(msg) {
  const {
    jobId, metaKey, cameraId, flags: jobFlags, artifactKeys,
    meanMotionMagnitude, meanLQESpeed
  } = msg;
  if (jobFlags) Object.assign(_flags, jobFlags);

  const startMs = Date.now();

  try {
    const api = await _loadStorageAPI();
    const sw  = _wrapStorage(api);

    // ── Resolve all inputs — inline-first, IDB fallback ──────────────────
    const resolution = artifactKeys.resolution ?? 512;
    const N          = resolution * resolution;

    // principalFrame — from principalFrameInline (dgInline e1/e2 interleaved) or IDB
    let principalFrame = null;
    if (msg.principalFrameInline?.e1 && msg.principalFrameInline?.e2) {
      const { e1, e2 } = msg.principalFrameInline;
      // Interleave xy-pairs → e1x,e1y,e2x,e2y per pixel (KEMModule layout)
      principalFrame = new Float32Array(N * 4);
      for (let i = 0; i < N; i++) {
        principalFrame[i * 4]     = e1[i * 2];
        principalFrame[i * 4 + 1] = e1[i * 2 + 1];
        principalFrame[i * 4 + 2] = e2[i * 2];
        principalFrame[i * 4 + 3] = e2[i * 2 + 1];
      }
      console.log('[kem.worker] principalFrame interleaved from inline dgInline e1/e2');
    } else {
      const pfArt    = await _loadArtifact(api, artifactKeys.principalFrameKey);
      principalFrame = pfArt?.data?.frame ?? pfArt?.data?.principalFrame ?? null;
    }
    if (!principalFrame) {
      console.warn('[kem.worker] principalFrame unavailable — KEM surface decomposition degenerates to raw magnitude');
    }

    // flowU / flowV — from flowFieldInline or IDB
    let flowU = null, flowV = null;
    if (msg.flowFieldInline?.u && msg.flowFieldInline?.v) {
      flowU = msg.flowFieldInline.u instanceof Float32Array
        ? msg.flowFieldInline.u : new Float32Array(msg.flowFieldInline.u);
      flowV = msg.flowFieldInline.v instanceof Float32Array
        ? msg.flowFieldInline.v : new Float32Array(msg.flowFieldInline.v);
      console.log('[kem.worker] flowU/V from inline');
    } else {
      const ffArt = await _loadArtifact(api, artifactKeys.flowFieldKey);
      flowU = ffArt?.data?.u ?? null;
      flowV = ffArt?.data?.v ?? null;
    }
    if (!flowU || !flowV) {
      console.warn('[kem.worker] flowU/V unavailable — KEM will produce zero surface decomposition');
    }

    // motionMagnitude + motionEndsMap — from motionMapsInline (topoInline.motionMaps) or IDB
    let motionMagnitude = null, motionEndsMap = null;
    if (msg.motionMapsInline) {
      motionMagnitude = msg.motionMapsInline.motionMagnitude ?? null;
      const rawEnds   = msg.motionMapsInline.motionEndsMap   ?? null;
      motionEndsMap   = rawEnds
        ? (rawEnds instanceof Int32Array ? rawEnds : new Int32Array(rawEnds))
        : null;
      console.log('[kem.worker] motionMaps from inline:', {
        hasMotionMagnitude: !!motionMagnitude,
        hasMotionEndsMap:   !!motionEndsMap
      });
    } else {
      const mmArt    = await _loadArtifact(api, artifactKeys.motionMapsKey);
      motionMagnitude = mmArt?.data?.motionMagnitude ?? null;
      const rawEnds   = mmArt?.data?.motionEndsMap   ?? null;
      motionEndsMap   = rawEnds ? new Int32Array(rawEnds) : null;
    }
    if (!motionMagnitude) console.warn('[kem.worker] motionMagnitude absent — KEM magnitudes will be zero');
    if (!motionEndsMap)   console.warn('[kem.worker] motionEndsMap absent — clade assignment will use background only');

    // coherencePerPixel — from coherenceInline or directionalField IDB
    let coherencePerPixel = null;
    if (msg.coherenceInline instanceof Float32Array) {
      coherencePerPixel = msg.coherenceInline;
      console.log('[kem.worker] coherencePerPixel from inline');
    } else {
      const dArt    = await _loadArtifact(api, artifactKeys.directionalFieldKey);
      coherencePerPixel = _extractCoherence(dArt);
    }
    if (!coherencePerPixel) console.warn('[kem.worker] coherencePerPixel absent — reliability weighting defaults to 0.5');

    // narrowBandMask — reconstruct from phiMinInline or IDB phi artifact
    let narrowBandMask = null;
    if (msg.phiMinInline instanceof Float32Array) {
      const thresh = 12 / resolution;
      narrowBandMask = new Float32Array(N);
      for (let i = 0; i < N; i++) narrowBandMask[i] = Math.abs(msg.phiMinInline[i]) < thresh ? 1 : 0;
      console.log('[kem.worker] narrowBandMask reconstructed from phiMinInline');
    } else {
      const phiArt = await _loadArtifact(api, artifactKeys.narrowBandKey);
      if (phiArt?.data?.phi) {
        const phi    = phiArt.data.phi;
        const thresh = 12 / resolution;
        narrowBandMask = new Float32Array(N);
        for (let i = 0; i < N; i++) narrowBandMask[i] = Math.abs(phi[i]) < thresh ? 1 : 0;
      } else {
        console.warn('[kem.worker] phiMin unavailable — using full-image narrow band');
        narrowBandMask = new Float32Array(N).fill(1);
      }
    }

    // surfaceParam metadata — from surfaceParamInline or IDB
    let stage5Degraded = false, stage5Legibility = 1.0;
    if (msg.surfaceParamInline) {
      stage5Degraded   = msg.surfaceParamInline.degradedMode    ?? false;
      stage5Legibility = msg.surfaceParamInline.legibilityScore ?? 1.0;
      console.log('[kem.worker] surfaceParam from inline');
    } else {
      const spArt      = await _loadArtifact(api, artifactKeys.surfaceParamKey);
      stage5Degraded   = spArt?.data?.degradedMode    ?? false;
      stage5Legibility = spArt?.data?.legibilityScore ?? 1.0;
    }

    // ── Construct and run KEMModule ────────────────────────────────────────
    const kem = new KEMModule({
      principalFrame,
      flowU,
      flowV,
      coherencePerPixel,
      motionMagnitude,
      motionEndsMap,
      narrowBandMask,
      resolution,
      flags: _flags
    });

    const result = kem.compute();

    const {
      kemField,
      cladeMap,
      tensionField,
      velocityManifold,
      meanKEM,
      cladeCount,
      diagnostics
    } = result;

    // ── Broadcast AMBI_REFINE immediately (parallel with persistence) ──────
    // ambi.worker's BC listener catches this and calls refineNode(),
    // replacing proxy feature vector components with measured meanKEM.
    _bcPost({
      event:               'AMBI_REFINE',
      cameraId:            cameraId ?? 'default',
      meanKEM,
      meanMotionMagnitude: meanMotionMagnitude ?? null,
      meanLQESpeed:        meanLQESpeed        ?? null,
      cladeCount
    });
    console.log('[kem.worker] AMBI_REFINE broadcast', {
      meanKEM: meanKEM.toExponential(3),
      cladeCount,
      meanMotionMagnitude,
      meanLQESpeed
    });

    // ── Persist artifacts ──────────────────────────────────────────────────
    const store = _buildStore(sw);
    const TTL   = PersistenceHelper.TTL?.PINNED ?? 300_000;

    const persistMeta = {
      sourceMetaKey:    metaKey,
      resolution,
      meanKEM,
      cladeCount,
      stage5Degraded,
      stage5Legibility,
      degeneratePixels: diagnostics.degeneratePixels,
      splitCount:       diagnostics.splitCount,
      computedAt:       Date.now()
    };

    // kem_map — Float32Array res²
    const kemMapResult = await PersistenceHelper.persist(store, {
      type:    'kem_map',
      data:    { map: Array.from(kemField), width: resolution, height: resolution },
      meta:    { ...persistMeta },
      ttl:     TTL,
      pinType: PersistenceHelper.PIN?.SOFT ?? 'soft'
    });

    // clade_map — Int32Array res²
    const cladeMapResult = await PersistenceHelper.persist(store, {
      type:    'clade_map',
      data:    { map: Array.from(cladeMap), width: resolution, height: resolution },
      meta:    { ...persistMeta, cladeCount },
      ttl:     TTL,
      pinType: PersistenceHelper.PIN?.SOFT ?? 'soft'
    });

    // tension_field — Float32Array res²
    const tensionResult = await PersistenceHelper.persist(store, {
      type:    'tension_field',
      data:    { field: Array.from(tensionField), width: resolution, height: resolution },
      meta:    { ...persistMeta },
      ttl:     TTL,
      pinType: PersistenceHelper.PIN?.SOFT ?? 'soft'
    });

    // velocity_manifold — serialised per-clade object
    const vmResult = await PersistenceHelper.persist(store, {
      type:    'velocity_manifold',
      data:    _serialiseVelocityManifold(velocityManifold),
      meta:    { ...persistMeta },
      ttl:     TTL,
      pinType: PersistenceHelper.PIN?.SOFT ?? 'soft'
    });

    // kem_summary — metadata + diagnostics
    const summaryResult = await PersistenceHelper.persist(store, {
      type:    'kem_summary',
      data:    {
        meanKEM,
        cladeCount,
        kemRange:      diagnostics.kemRange,
        degeneratePixels: diagnostics.degeneratePixels,
        splitCount:    diagnostics.splitCount,
        totalClades:   diagnostics.totalClades,
        stage5Degraded,
        stage5Legibility
      },
      meta:    { ...persistMeta },
      ttl:     TTL,
      pinType: PersistenceHelper.PIN?.SOFT ?? 'soft'
    });

    // ── Broadcast KEM_DONE ─────────────────────────────────────────────────
    _bcPost({
      event:               'KEM_DONE',
      metaKey,
      jobId,
      kemMapKey:           kemMapResult?.metaKey    ?? null,
      cladeMapKey:         cladeMapResult?.metaKey  ?? null,
      tensionFieldKey:     tensionResult?.metaKey   ?? null,
      velocityManifoldKey: vmResult?.metaKey        ?? null,
      kemSummaryKey:       summaryResult?.metaKey   ?? null,
      meanKEM,
      cladeCount,
      processingMs: Date.now() - startMs
    });

    console.log('[kem.worker] KEM_DONE broadcast', {
      metaKey,
      meanKEM:      meanKEM.toExponential(3),
      cladeCount,
      processingMs: Date.now() - startMs
    });

  } catch (err) {
    console.error('[kem.worker] KEM_ANALYZE failed:', err);
    _bcPost({
      event:   'KEM_ERROR',
      metaKey,
      jobId,
      error:   _safeErr(err),
      wallMs:  Date.now() - startMs
    });
  }
}

// ── BC listener: flags sync ───────────────────────────────────────────────
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

  if (msg.op === 'KEM_ANALYZE') {
    await _handleKEMAnalyze(msg);
    return;
  }

  if (msg.op === 'shutdown') {
    if (_bc) try { _bc.close(); } catch(e) {}
    self.close();
  }
};