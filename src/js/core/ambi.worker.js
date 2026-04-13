// /src/js/core/ambi.worker.js
//
// Stage 5 — AmbiAnamorph worker shell.
//
// Execution model:
//   Triggered by: AMBI_ANALYZE (direct postMessage from main.js)
//   Fires when:   STAGE4_DONE has been broadcast (both 4A and 4B complete)
//   Outputs:      AMBI_DONE (BC broadcast for main.js + Stage 6/7)
//                 AMBI_REFINED (BC broadcast after Stage 6 refinement)
//
// Persistent module-level state (survives across calls):
//   _sessionState — structureId lock + keyframe worldFrameMap
//   _manifold     — ViewManifold sparse graph
//
// Pattern: topology.worker.js shell (lightweight, no GPU, no heartbeat).
// All corrections pre-applied:
//   - BC channel 'motion-painter-store'
//   - No applyFlagsSnapshot — Object.assign
//   - Storage import './storage.js'
//   - PersistenceHelper default import
//   - _buildStore 5-positional-arg signature
//   - All persist calls with TTL/pinType inside descriptor
//   - BC listener uses addEventListener

import { AmbiAnamorph }        from './AmbiAnimorph.js';
import PersistenceHelper        from './PersistenceHelper.js';
import { createViewManifold,
         refineNode }           from './ViewManifold.js';

// ── BroadcastChannel ─────────────────────────────────────────────────────
let _bc = null;
try { _bc = new BroadcastChannel('motion-painter-store'); } catch(e) {}

function _bcPost(p) { if (_bc) try { _bc.postMessage(p); } catch(e) {} }
function _safeErr(e) { return { message: e?.message ?? String(e), stack: e?.stack ?? null }; }

// ── Module-level state ────────────────────────────────────────────────────
let _storageAPI = null;
let _flags      = {};

// Session state — mutated by assignWorldFrameIds across calls
let _sessionState = {
  structureId:           null,
  inconsistentCount:     0,
  keyframeWorldFrameMap: null,
  frameCount:            0
};

// View manifold — mutated by updateViewManifold and refineNode across calls
let _manifold = createViewManifold();

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
        throw new Error(`ambi.worker: putArtifact failed for ${type}: ${e.message}`);
      }

      if (!putResult?.ok || !putResult.metaKey) {
        throw new Error(`ambi.worker: no metaKey returned for ${type}`);
      }

      const pinFn = sw.raw?.pinArtifact ??
        (typeof self.pinArtifact === 'function' ? self.pinArtifact : null);
      if (typeof pinFn === 'function') {
        try {
          await pinFn(putResult.metaKey, {
            owner:  'ambi.worker',
            type:   pinType ?? 'soft',
            ttlMs:  ttlMs > 0 ? ttlMs : null
          });
        } catch (e) {
          console.warn(
            `[ambi.worker] pin failed for ${putResult.metaKey.slice(0,20)}... (non-fatal):`,
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

// ── Unpack helpers ────────────────────────────────────────────────────────

/**
 * Defensively extract coherencePerPixel from a directional_field artifact.
 * liftResult.coherence may be { perPixel: Float32Array } or a Float32Array
 * directly, depending on the DirectionalLifting version.
 */
function _extractCoherence(art) {
  if (!art?.data) return null;
  const c = art.data.coherence;
  if (!c) return null;
  if (c instanceof Float32Array) return c;           // direct array form
  if (c.perPixel instanceof Float32Array) return c.perPixel;  // object form
  return null;
}

// ── AMBI_ANALYZE handler ─────────────────────────────────────────────────
async function _handleAmbiAnalyze(msg) {
  const { jobId, metaKey, flags: jobFlags, artifactKeys, stage4a, stage4b } = msg;
  if (jobFlags) Object.assign(_flags, jobFlags);

  const startMs = Date.now();

  try {
    const api = await _loadStorageAPI();
    const sw  = _wrapStorage(api);

    // ── Load Group A: always required ─────────────────────────────────────
    const [
      phiMinArt,
      zeroCurveArt,
      primeEndsArt,
      topologyMapArt,
      constrainedMinimizerArt
    ] = await Promise.all([
      _loadArtifact(api, artifactKeys.phiMinKey),
      _loadArtifact(api, artifactKeys.zeroCurveKey),
      _loadArtifact(api, artifactKeys.primeEndsKey),
      _loadArtifact(api, artifactKeys.topologyMapKey),
      _loadArtifact(api, artifactKeys.constrainedMinimizerKey)
    ]);

    if (!phiMinArt)              throw new Error('phi_min artifact required for AmbiAnamorph');
    if (!zeroCurveArt)           throw new Error('zero_curve artifact required for AmbiAnamorph');
    if (!primeEndsArt)           throw new Error('prime_ends artifact required for AmbiAnamorph');
    if (!topologyMapArt)         throw new Error('topology_map artifact required for AmbiAnamorph');
    if (!constrainedMinimizerArt) throw new Error('constrained_minimizer artifact required for AmbiAnamorph');

    // ── Load Group B: soft failures ───────────────────────────────────────
    const [
      componentMapArt,
      lipschitzEndsArt,
      motionMapsArt,
      principalFrameArt,
      curvatureArt,
      directionalArt,
      directnessArt,
      penumbraArt
    ] = await Promise.all([
      _loadArtifact(api, artifactKeys.componentMapKey),
      _loadArtifact(api, artifactKeys.lipschitzEndsKey),
      _loadArtifact(api, artifactKeys.motionMapsKey),
      _loadArtifact(api, artifactKeys.principalFrameKey),
      _loadArtifact(api, artifactKeys.curvatureKey),
      _loadArtifact(api, artifactKeys.directionalFieldKey),
      _loadArtifact(api, artifactKeys.directnessKey),
      _loadArtifact(api, artifactKeys.penumbraKey)
    ]);

    // ── Unpack Group A ─────────────────────────────────────────────────────
    const phiMin         = phiMinArt.data.phi;
    const narrowBandMask = phiMinArt.data.narrowBandMask
                           ?? _buildNarrowBandFromPhi(phiMin, artifactKeys.resolution ?? 512);
    const zeroCurve      = zeroCurveArt.data;
    const ends           = primeEndsArt.data.ends ?? [];
    const topologyMap    = new Int32Array(topologyMapArt.data.map ?? topologyMapArt.data);
    const minimizerDiagnostics = {
      maxAreaErr:    constrainedMinimizerArt.data?.diagnostics?.maxAreaErr    ?? 0,
      finalBandWidth: constrainedMinimizerArt.data?.diagnostics?.finalBandWidth ?? 6
    };

    const resolution = artifactKeys.resolution ?? 512;
    const b0 = (stage4a?.betti?.b0 ?? msg.b0) ?? 1;
    const b1 = (stage4a?.betti?.b1 ?? msg.b1) ?? 0;

    // ── Unpack Group B ─────────────────────────────────────────────────────
    const componentMap = componentMapArt?.data?.map
      ? new Int32Array(componentMapArt.data.map)
      : null;

    if (!componentMap) {
      console.warn('[ambi.worker] componentMap absent — proceeding in degraded mode');
    }

    const lipschitzEnds = lipschitzEndsArt?.data?.ends ?? [];

    const motionMaps = motionMapsArt?.data
      ? {
          motionMagnitude: motionMapsArt.data.motionMagnitude ?? null,
          saliencyMap:     motionMapsArt.data.saliencyMap     ?? null,
          rotationalMap:   motionMapsArt.data.rotationalMap   ?? null
        }
      : { motionMagnitude: null, saliencyMap: null, rotationalMap: null };

    const principalFrame = principalFrameArt?.data?.frame
                           ?? principalFrameArt?.data?.principalFrame
                           ?? null;

    const curvatureField = curvatureArt?.data?.kH ?? null;

    // Defensive coherence extraction (Issue 4)
    const coherencePerPixel = _extractCoherence(directionalArt);
    if (!coherencePerPixel) {
      console.warn('[ambi.worker] directional_field: coherence.perPixel absent — integration weights degraded');
    }

    const directnessField = directnessArt?.data
      ? { fMap: directnessArt.data.fMap ?? directnessArt.data.directnessMap ?? null }
      : null;

    const penumbraField = penumbraArt?.data
      ? { edgeMask: penumbraArt.data.edgeMask ?? penumbraArt.data.edge_mask ?? null }
      : null;

    // ── Construct and run AmbiAnamorph ─────────────────────────────────────
    const ambi = new AmbiAnamorph({
      phiMin,
      zeroCurve,
      principalFrame,
      narrowBandMask,
      curvatureField,
      minimizerDiagnostics,
      ends,
      topologyMap,
      componentMap,
      lipschitzEnds,
      motionMaps,
      b0,
      b1,
      directnessField,
      penumbraField,
      coherencePerPixel,
      sessionState:  _sessionState,   // mutated in place
      manifold:      _manifold,       // mutated in place
      resolution,
      flags: {
        ..._flags,
        cameraId: artifactKeys.cameraId ?? msg.cameraId ?? 'default'
      }
    });

    const result = ambi.compute();

    const {
      warpField,
      worldFrameMap,
      integrationWeights,
      surfaceParamMeta,
      structureId,
      isKeyframe,
      legibilityScore,
      viewManifold: { componentId, positionInManifold },
      degradedMode,
      diagnostics,
      telemetry
    } = result;

    // ── Persist artifacts ──────────────────────────────────────────────────
    const store = _buildStore(sw);
    const TTL   = PersistenceHelper.TTL?.PINNED ?? 300_000;

    const persistMeta = {
      sourceMetaKey: metaKey,
      resolution,
      structureId,
      isKeyframe,
      legibilityScore,
      degradedMode,
      b0, b1,
      computedAt: Date.now()
    };

    // world_frame_map (Int32Array — convert to regular array for storage)
    const worldFrameMapResult = await PersistenceHelper.persist(store, {
      type:    'world_frame_map',
      data:    { map: Array.from(worldFrameMap), width: resolution, height: resolution },
      meta:    { ...persistMeta },
      ttl:     TTL,
      pinType: PersistenceHelper.PIN?.SOFT ?? 'soft'
    });

    // warp_field
    const warpFieldResult = await PersistenceHelper.persist(store, {
      type:    'warp_field',
      data:    { field: Array.from(warpField), width: resolution, height: resolution },
      meta:    { ...persistMeta },
      ttl:     TTL,
      pinType: PersistenceHelper.PIN?.SOFT ?? 'soft'
    });

    // integration_weights
    const integrationWeightsResult = await PersistenceHelper.persist(store, {
      type:    'integration_weights',
      data:    { weights: Array.from(integrationWeights), width: resolution, height: resolution },
      meta:    { ...persistMeta, ...diagnostics.integration },
      ttl:     TTL,
      pinType: PersistenceHelper.PIN?.SOFT ?? 'soft'
    });

    // surface_param (metadata + diagnostics)
    const surfaceParamResult = await PersistenceHelper.persist(store, {
      type:    'surface_param',
      data:    {
        surfaceParamMeta,
        structureId,
        legibilityScore,
        viewManifoldComponent: componentId,
        diagnostics
      },
      meta:    { ...persistMeta },
      ttl:     TTL,
      pinType: PersistenceHelper.PIN?.SOFT ?? 'soft'
    });

    // ambi_anamorph_telemetry (debug only)
    let telemetryResult = null;
    if (_flags.ambiDebug && telemetry) {
      telemetryResult = await PersistenceHelper.persist(store, {
        type:    'ambi_anamorph_telemetry',
        data:    telemetry,
        meta:    { ...persistMeta },
        ttl:     PersistenceHelper.TTL?.DEBUG ?? 30_000,
        pinType: PersistenceHelper.PIN?.SOFT ?? 'soft'
      });
    }

    // ── Broadcast AMBI_DONE ────────────────────────────────────────────────
    _bcPost({
      event:                 'AMBI_DONE',
      metaKey,
      jobId,
      worldFrameMapKey:      worldFrameMapResult?.metaKey       ?? null,
      warpFieldKey:          warpFieldResult?.metaKey           ?? null,
      integrationWeightsKey: integrationWeightsResult?.metaKey  ?? null,
      surfaceParamKey:       surfaceParamResult?.metaKey        ?? null,
      telemetryKey:          telemetryResult?.metaKey           ?? null,
      containerUpdate: {
        ambiFrame: {
          worldFrameId:          structureId,
          legibilityScore,
          viewManifoldComponent: componentId,
          positionInManifold:    Array.from(positionInManifold),
          sharedStructureId:     structureId
        }
      },
      // Forwarded so main.js stores them in stage5 for kem.worker's
      // AMBI_REFINE residual computation
      meanMotionMagnitude: diagnostics.featureVector?.meanMotionMagnitude ?? null,
      meanLQESpeed:        diagnostics.featureVector?.meanLQESpeed        ?? null,
      degradedMode,
      isKeyframe,
      processingMs: Date.now() - startMs
    });

    console.log('[ambi.worker] AMBI_DONE broadcast', {
      metaKey,
      structureId,
      isKeyframe,
      legibilityScore: legibilityScore.toFixed(3),
      degradedMode,
      processingMs: Date.now() - startMs
    });

  } catch (err) {
    console.error('[ambi.worker] AMBI_ANALYZE failed:', err);
    _bcPost({
      event:    'AMBI_ERROR',
      metaKey,
      jobId,
      error:    _safeErr(err),
      wallMs:   Date.now() - startMs
    });
  }
}

// ── AMBI_REFINE handler ───────────────────────────────────────────────────
function _handleAmbiRefine(msg) {
  const {
    cameraId,
    meanKEM,
    meanMotionMagnitude,
    meanLQESpeed
  } = msg;

  if (!cameraId) {
    console.warn('[ambi.worker] AMBI_REFINE: no cameraId provided');
    return;
  }

  try {
    const result = refineNode({
      manifold:            _manifold,
      cameraId,
      meanKEM:             meanKEM             ?? 0,
      meanMotionMagnitude: meanMotionMagnitude ?? 0,
      meanLQESpeed:        meanLQESpeed        ?? 0,
      compatibilityThresh: _flags.viewManifoldCompatibilityThresh ?? 0.85
    });

    _bcPost({
      event:              'AMBI_REFINED',
      cameraId,
      componentId:        result.componentId,
      positionInManifold: Array.from(result.positionInManifold),
      residuals:          result.residuals,
      timestamp:          Date.now()
    });

    console.log('[ambi.worker] AMBI_REFINED broadcast', {
      cameraId,
      componentId:           result.componentId,
      motionMagResidual:     result.residuals.motionMagResidual.toFixed(3),
      lqeSpeedResidual:      result.residuals.lqeSpeedResidual.toFixed(3)
    });

  } catch (err) {
    console.error('[ambi.worker] AMBI_REFINE failed:', err);
    _bcPost({
      event:    'AMBI_REFINE_ERROR',
      cameraId,
      error:    _safeErr(err)
    });
  }
}

// ── Fallback: build narrowBandMask from phi if artifact didn't include it ─
// PackingSDF always persists narrowBandMask alongside signedSdf in sdf_field,
// but phi_min from Stage 4B stores phi only. Fall back to |phi| < bandWidth/res.
function _buildNarrowBandFromPhi(phi, resolution) {
  const N    = resolution * resolution;
  const mask = new Float32Array(N);
  // Conservative band: |phi| < 12/resolution (≈ 6 pixels at 512²)
  const thresh = 12 / resolution;
  for (let i = 0; i < N; i++) {
    mask[i] = Math.abs(phi[i]) < thresh ? 1 : 0;
  }
  return mask;
}

// ── BC listener: flags sync + AMBI_REFINE from kem.worker ────────────────
if (_bc) {
  _bc.addEventListener('message', (evt) => {
    const data = evt.data;
    if (!data) return;
    if (data.event === 'flagsChanged') {
      Object.assign(_flags, data.flags ?? {});
      return;
    }
    if (data.event === 'AMBI_REFINE') {
      _handleAmbiRefine(data);
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

  if (msg.op === 'AMBI_ANALYZE') {
    await _handleAmbiAnalyze(msg);
    return;
  }

  if (msg.op === 'AMBI_REFINE') {
    _handleAmbiRefine(msg);
    return;
  }

  if (msg.op === 'shutdown') {
    if (_bc) try { _bc.close(); } catch(e) {}
    self.close();
  }
};