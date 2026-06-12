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

// ── Resolution downsampling helpers ──────────────────────────────────────
// All dgInline/flowField/coherence inputs arrive at reconstructionResolution
// (1024²). motionMaps come from topology at topoResolution (512²).
// Every input must be downsampled to match before KEMModule sees them.
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

function _downsampleField(src, srcRes, dstRes, stride) {
  if (!src || srcRes === dstRes) return src;
  const scale = srcRes / dstRes;
  const out   = new Float32Array(dstRes * dstRes * stride);
  for (let y = 0; y < dstRes; y++) {
    for (let x = 0; x < dstRes; x++) {
      const sy = Math.min(srcRes - 1, Math.floor(y * scale));
      const sx = Math.min(srcRes - 1, Math.floor(x * scale));
      const si = (sy * srcRes + sx) * stride;
      const di = (y  * dstRes + x ) * stride;
      for (let s = 0; s < stride; s++) out[di + s] = src[si + s];
    }
  }
  return out;
}
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
    // ── Resolve all inputs — inline-first (IDB never needed, all keys null) ─
    // api/sw are only opened inside the fire-and-forget IIFE below.
    const resolution = artifactKeys.resolution ?? 512;
    const N          = resolution * resolution;

    // principalFrame — from principalFrameInline (dgInline e1/e2 interleaved) or IDB
    let principalFrame = null;
    if (msg.principalFrameInline?.e1 && msg.principalFrameInline?.e2) {
      let { e1, e2 } = msg.principalFrameInline;
      // Downsample from native resolution (1024²) to topoResolution (512²) first.
      // Accessing flat 1024² stride-2 arrays with 512² indices reads only the
      // top-left quarter of the image — not a proper downsampled representation.
      const e1Res = Math.round(Math.sqrt(e1.length / 2));  // stride-2 → pixel count
      if (e1Res !== resolution) {
        e1 = _downsampleField(e1, e1Res, resolution, 2);
        e2 = _downsampleField(e2, e1Res, resolution, 2);
        console.log(`[kem.worker] principalFrame e1/e2 downsampled ${e1Res}² → ${resolution}²`);
      }
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
      let fU = msg.flowFieldInline.u instanceof Float32Array
        ? msg.flowFieldInline.u : new Float32Array(msg.flowFieldInline.u);
      let fV = msg.flowFieldInline.v instanceof Float32Array
        ? msg.flowFieldInline.v : new Float32Array(msg.flowFieldInline.v);
      const flowRes = Math.round(Math.sqrt(fU.length));
      if (flowRes !== resolution) {
        fU = _downsampleScalar(fU, flowRes, resolution);
        fV = _downsampleScalar(fV, flowRes, resolution);
        console.log(`[kem.worker] flowU/V downsampled ${flowRes}² → ${resolution}²`);
      }
      flowU = fU;
      flowV = fV;
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
      const cohRes = Math.round(Math.sqrt(msg.coherenceInline.length));
      coherencePerPixel = cohRes !== resolution
        ? _downsampleScalar(msg.coherenceInline, cohRes, resolution)
        : msg.coherenceInline;
      if (cohRes !== resolution) {
        console.log(`[kem.worker] coherencePerPixel downsampled ${cohRes}² → ${resolution}²`);
      } else {
        console.log('[kem.worker] coherencePerPixel from inline');
      }
    } else {
      const dArt    = await _loadArtifact(api, artifactKeys.directionalFieldKey);
      coherencePerPixel = _extractCoherence(dArt);
    }
    if (!coherencePerPixel) console.warn('[kem.worker] coherencePerPixel absent — reliability weighting defaults to 0.5');

    // narrowBandMask — reconstruct from phiMinInline or IDB phi artifact
    let narrowBandMask = null;
    if (msg.phiMinInline instanceof Float32Array) {
      // phiMinInline is at minimizerResolution (1024²). Direct indexing with i < N = 512²
      // reads only the top-left quarter. Downsample first.
      const phiMinRes = Math.round(Math.sqrt(msg.phiMinInline.length));
      const phiDS = phiMinRes !== resolution
        ? _downsampleScalar(msg.phiMinInline, phiMinRes, resolution)
        : msg.phiMinInline;
      const thresh = 12 / resolution;
      narrowBandMask = new Float32Array(N);
      for (let i = 0; i < N; i++) narrowBandMask[i] = Math.abs(phiDS[i]) < thresh ? 1 : 0;
      const bandPx = narrowBandMask.reduce((s, v) => s + v, 0);
      console.log('[kem.worker] narrowBandMask reconstructed from phiMinInline', {
        phiMinRes, resolution, downsampled: phiMinRes !== resolution, bandPx
      });
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

    // ── Broadcast KEM_DONE immediately — no IDB round-trip ────────────────
    // kemField, cladeMap, tensionField have no downstream IDB consumer.
    // Only meanKEM and cladeCount are needed by STAGE678_DONE.
    // Keys are null; fire-and-forget persistence runs behind persistInlineArtifacts.
    _bcPost({
      event:               'KEM_DONE',
      metaKey,
      jobId,
      kemMapKey:           null,
      cladeMapKey:         null,
      tensionFieldKey:     null,
      velocityManifoldKey: null,
      kemSummaryKey:       null,
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

    // ── Fire-and-forget IDB persistence — gated behind persistInlineArtifacts ──
    // kemField (1MB), cladeMap (1MB), tensionField (1MB): no downstream reader.
    // velocityManifold: large nested object, no downstream reader.
    // Persisting unconditionally creates ~3MB of unnecessary IDB writes per frame.
    if (_flags.persistInlineArtifacts) (async () => {
      try {
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
        await PersistenceHelper.persist(store, {
          type:    'kem_map',
          data:    { map: Array.from(kemField), width: resolution, height: resolution },
          meta:    { ...persistMeta },
          ttl:     TTL,
          pinType: PersistenceHelper.PIN?.SOFT ?? 'soft'
        });
        await PersistenceHelper.persist(store, {
          type:    'clade_map',
          data:    { map: Array.from(cladeMap), width: resolution, height: resolution },
          meta:    { ...persistMeta, cladeCount },
          ttl:     TTL,
          pinType: PersistenceHelper.PIN?.SOFT ?? 'soft'
        });
        await PersistenceHelper.persist(store, {
          type:    'tension_field',
          data:    { field: Array.from(tensionField), width: resolution, height: resolution },
          meta:    { ...persistMeta },
          ttl:     TTL,
          pinType: PersistenceHelper.PIN?.SOFT ?? 'soft'
        });
        await PersistenceHelper.persist(store, {
          type:    'velocity_manifold',
          data:    _serialiseVelocityManifold(velocityManifold),
          meta:    { ...persistMeta },
          ttl:     TTL,
          pinType: PersistenceHelper.PIN?.SOFT ?? 'soft'
        });
        await PersistenceHelper.persist(store, {
          type:    'kem_summary',
          data:    {
            meanKEM, cladeCount,
            kemRange:         diagnostics.kemRange,
            degeneratePixels: diagnostics.degeneratePixels,
            splitCount:       diagnostics.splitCount,
            totalClades:      diagnostics.totalClades,
            stage5Degraded,   stage5Legibility
          },
          meta:    { ...persistMeta },
          ttl:     TTL,
          pinType: PersistenceHelper.PIN?.SOFT ?? 'soft'
        });
        console.log('[kem.worker] Background persistence complete');
      } catch (e) {
        console.warn('[kem.worker] Background persistence failed (non-fatal):', e.message);
      }
    })();

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