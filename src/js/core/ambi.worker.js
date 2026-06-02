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
  const { jobId, metaKey, flags: jobFlags, artifactKeys, stage4a, stage4b, stage1Inline, dgInline } = msg;
  if (jobFlags) Object.assign(_flags, jobFlags);

  const startMs = Date.now();

  try {
    // ── Resolve inline sources ────────────────────────────────────────────
    const topoInline      = msg.topoInline      ?? null;
    const minimizerInline = msg.minimizerInline ?? null;

    if (!minimizerInline?.phiMin)    throw new Error('minimizerInline.phiMin required — was MINIMIZER_DONE missing minimizerInline?');
    if (!minimizerInline?.zeroCurve) throw new Error('minimizerInline.zeroCurve required — was MINIMIZER_DONE missing minimizerInline?');
    if (!topoInline?.topologyMap)    throw new Error('topoInline.topologyMap required — was TOPOLOGY_DONE missing topoInline?');
    if (!topoInline?.primeEnds)      console.warn('[ambi.worker] topoInline.primeEnds absent — ends will be empty');

    // ── Resolution audit ──────────────────────────────────────────────────
    // topology.worker downsamples to topoMaxResolution (default 512).
    // minimizer runs at full reconstructionResolution (e.g. 1024).
    // Mismatch causes OOB reads on topology arrays and OOM from 1024² allocations.
    // Derive from actual array length — minimizerInline.resolution may be stale
    // or undefined if module._w doesn't match the internal working grid size.
    const minimizerResolution = minimizerInline.phiMin?.length > 0
      ? Math.round(Math.sqrt(minimizerInline.phiMin.length))
      : (minimizerInline.resolution ?? artifactKeys.resolution ?? 512);
    const topoResolution      = topoInline?.topoResolution
      ?? (topoInline?.componentMap?.length > 0
          ? Math.round(Math.sqrt(topoInline.componentMap.length))
          : null)
      ?? minimizerResolution;
    const resolutionMismatch  = topoResolution !== minimizerResolution;

    // Count in-band nodes from componentMap for topology health diagnostics
    let _topoNodeCount = 0;
    if (topoInline?.componentMap) {
      for (let _i = 0; _i < topoInline.componentMap.length; _i++) {
        if (topoInline.componentMap[_i] >= 0) _topoNodeCount++;
      }
    }

    console.log('[ambi.worker] Inline data received:', {
      hasPhiMin:           !!minimizerInline.phiMin,
      hasZeroCurve:        !!minimizerInline.zeroCurve,
      hasTopologyMap:      !!topoInline.topologyMap,
      hasComponentMap:     !!topoInline?.componentMap,
      primeEndsCount:      topoInline?.primeEnds?.length     ?? 0,
      lipschitzEndsCount:  topoInline?.lipschitzEnds?.length ?? 0,
      betti:               topoInline?.betti                 ?? null,
      minimizerResolution,
      topoResolution,
      resolutionMismatch,
      phiMinLength:        minimizerInline.phiMin?.length     ?? 0,
      topologyMapLength:   topoInline?.topologyMap?.length    ?? 0,
      componentMapLength:  topoInline?.componentMap?.length   ?? 0,
      topoNodeCount:       _topoNodeCount,
      topoBandFraction:    topoInline?.componentMap?.length > 0
        ? (_topoNodeCount / topoInline.componentMap.length).toFixed(3)
        : 'n/a'
    });
    if (resolutionMismatch) {
      console.warn(
        `[ambi.worker] ⚠ Resolution mismatch: topology=${topoResolution}² minimizer=${minimizerResolution}². ` +
        `Downsampling phiMin to ${topoResolution}² — ambi runs at topoResolution to avoid OOB and OOM.`
      );
    }

    // ── Load only what cannot travel inline ───────────────────────────────
    // directionalArt: needed for coherencePerPixel only.
    // principalFrameArt + curvatureArt: fallback only when dgInline absent.
    const api = await _loadStorageAPI();
    const sw  = _wrapStorage(api);

    const _dfInline = msg.directionalFieldInline ?? null;
    const _dfArt = _dfInline
      ? { data: {
            field:    _dfInline.field,
            coherence: (_dfInline.coherence instanceof Float32Array)
              ? { perPixel: _dfInline.coherence }
              : (_dfInline.coherence ?? null)
          }}
      : null;
    const [directionalArt, principalFrameArt, curvatureArt] = await Promise.all([
      _dfArt ? Promise.resolve(_dfArt) : _loadArtifact(api, artifactKeys.directionalFieldKey),
      dgInline ? null : _loadArtifact(api, artifactKeys.principalFrameKey),
      dgInline ? null : _loadArtifact(api, artifactKeys.curvatureKey)
    ]);

    // directnessArt and penumbraArt come from stage1Inline — not IDB.
    // Reconstruct the same shape that getArtifact would have returned.
    const directnessArt = stage1Inline?.fMapFinal
      ? { data: {
            fMap:        stage1Inline.fMapFinal.fMap,
            directness:  stage1Inline.fMapFinal.directness,
            modalLabels: stage1Inline.fMapFinal.modalLabels
          }}
      : null;

    const penumbraArt = stage1Inline?.penumbra
      ? { data: {
            widthMap:   stage1Inline.penumbra.widthMap,
            edgeMask:   stage1Inline.penumbra.edgeMask,
            lightTrack: stage1Inline.penumbra.lightTrack
          }}
      : null;

    // ── Unpack Group A — from minimizerInline and topoInline ──────────────
    // Downsample phiMin to topoResolution when there is a mismatch.
    // AmbiAnamorph then runs entirely at topoResolution — all arrays are
    // consistent, OOB reads on topology arrays are eliminated, and peak
    // memory is 4× lower than running at minimizerResolution (1024²).
    const phiMin         = resolutionMismatch
      ? _downsampleScalar(minimizerInline.phiMin, minimizerResolution, topoResolution)
      : minimizerInline.phiMin;
    const narrowBandMask = _buildNarrowBandFromPhi(phiMin, topoResolution);
    // Scale zeroCurve pixel coordinates from minimizerResolution → topoResolution.
    // zeroCurve.loops[].points[].{x,y} are produced by the minimizer at 1024²;
    // ambi runs at 512². Unscaled coordinates map outside the grid → zero BFS seeds.
    const _zcScale  = resolutionMismatch ? (topoResolution / minimizerResolution) : 1;
    const zeroCurve = (minimizerInline.zeroCurve && _zcScale !== 1)
      ? {
          ...minimizerInline.zeroCurve,
          loops: (minimizerInline.zeroCurve.loops ?? []).map(loop => ({
            ...loop,
            points: (loop.points ?? []).map(pt => ({
              ...pt,
              x: pt.x * _zcScale,
              y: pt.y * _zcScale
            }))
          }))
        }
      : (minimizerInline.zeroCurve ?? null);
    const ends           = topoInline?.primeEnds ?? [];
    const topologyMap    = topoInline.topologyMap instanceof Int32Array
                           ? topoInline.topologyMap
                           : new Int32Array(topoInline.topologyMap);
    const minimizerDiagnostics = {
      maxAreaErr:     minimizerInline.diagnostics?.maxAreaErr     ?? 0,
      finalBandWidth: minimizerInline.diagnostics?.finalBandWidth ?? 6
    };

    // ambi runs at topoResolution — keeps all arrays consistent.
    const resolution = topoResolution;
    const b0 = (topoInline?.betti?.b0 ?? stage4a?.betti?.b0 ?? msg.b0) ?? 1;
    const b1 = (topoInline?.betti?.b1 ?? stage4a?.betti?.b1 ?? msg.b1) ?? 0;

    // ── Unpack Group B — from topoInline and dgInline ─────────────────────
    const componentMap = topoInline?.componentMap instanceof Int32Array
      ? topoInline.componentMap
      : (topoInline?.componentMap ? new Int32Array(topoInline.componentMap) : null);

    if (!componentMap) {
      console.warn('[ambi.worker] componentMap absent — proceeding in degraded mode');
    }

    const lipschitzEnds = topoInline?.lipschitzEnds ?? [];

    const motionMaps = topoInline?.motionMaps
      ? {
          motionMagnitude: topoInline.motionMaps.motionMagnitude ?? null,
          saliencyMap:     topoInline.motionMaps.saliencyMap     ?? null,
          rotationalMap:   topoInline.motionMaps.rotationalMap   ?? null
        }
      : { motionMagnitude: null, saliencyMap: null, rotationalMap: null };

    // principalFrame and curvatureField from dgInline — no IDB read needed
    // principalFrame — from dgInline at minimizerResolution (reconstructionResolution).
    // dgInline format: { e1: Float32Array stride-2, e2: Float32Array stride-2 }.
    // IDB fallback format: Float32Array stride-4 (e1x,e1y,e2x,e2y per pixel).
    // buildWarpField seeds BFS using these vectors — wrong resolution → wrong
    // edge weights on every pixel in the warp field.
    const _pfRaw = dgInline
      ? { e1: dgInline.principalE1, e2: dgInline.principalE2 }
      : (principalFrameArt?.data?.frame ?? principalFrameArt?.data?.principalFrame ?? null);
    let principalFrame = _pfRaw;
    if (resolutionMismatch && _pfRaw) {
      if (_pfRaw.e1 && _pfRaw.e2) {
        // dgInline format: stride-2 xy-pair arrays
        principalFrame = {
          e1: _downsampleField(_pfRaw.e1, minimizerResolution, topoResolution, 2),
          e2: _downsampleField(_pfRaw.e2, minimizerResolution, topoResolution, 2)
        };
      } else if (_pfRaw instanceof Float32Array) {
        // IDB format: stride-4 flat array
        principalFrame = _downsampleField(_pfRaw, minimizerResolution, topoResolution, 4);
      }
    }

    // curvatureField (kH) — scalar Float32Array at minimizerResolution.
    // Used in integration weight computation (topoStab) and feature vectors (meanKH).
    const _kHRaw     = dgInline?.kH ?? curvatureArt?.data?.kH ?? null;
    const curvatureField = (resolutionMismatch && _kHRaw)
      ? _downsampleScalar(_kHRaw, minimizerResolution, topoResolution)
      : _kHRaw;

    if (dgInline) {
      console.log('[ambi.worker] DG fields from dgInline:', {
        hasKH:          !!dgInline.kH,
        hasPrincipalE1: !!dgInline.principalE1,
        hasPrincipalE2: !!dgInline.principalE2
      });
    }

    // Defensive coherence extraction — then downsample to topoResolution.
    // directionalFieldInline is at minimizerResolution (reconstructionResolution).
    // Undownsampled: _computeIntegrationWeights reads coherence[0..262143]
    // which is the top-left quarter of the 1024² array, not a proper sample.
    const _cohRaw = _extractCoherence(directionalArt);
    const coherencePerPixel = (resolutionMismatch && _cohRaw)
      ? _downsampleScalar(_cohRaw, minimizerResolution, topoResolution)
      : _cohRaw;
    if (!coherencePerPixel) {
      console.warn('[ambi.worker] directional_field: coherence.perPixel absent — integration weights degraded');
    }

    // directnessField.fMap — from stage1Inline at reconstructionResolution (1024²).
    // Used in _computeIntegrationWeights (fMap exponent) and
    // _computeFeatureVectorInputs (meanFMap). Undownsampled: reads top-left
    // quarter of the 1024² array on every pixel loop iteration.
    const _fMapRaw = directnessArt?.data?.fMap ?? directnessArt?.data?.directnessMap ?? null;
    const directnessField = directnessArt?.data
      ? { fMap: (resolutionMismatch && _fMapRaw)
              ? _downsampleScalar(_fMapRaw, minimizerResolution, topoResolution)
              : _fMapRaw }
      : null;

    // penumbraField.edgeMask — from stage1Inline at reconstructionResolution (1024²).
    // Uint8Array — _downsampleScalar uses src.constructor so the type is preserved.
    // Used in _computeFeatureVectorInputs (penumbraFraction).
    const _edgeMaskRaw = penumbraArt?.data?.edgeMask ?? penumbraArt?.data?.edge_mask ?? null;
    const penumbraField = penumbraArt?.data
      ? { edgeMask: (resolutionMismatch && _edgeMaskRaw)
                ? _downsampleScalar(_edgeMaskRaw, minimizerResolution, topoResolution)
                : _edgeMaskRaw }
      : null;

    if (resolutionMismatch) {
      console.log('[ambi.worker] Resolution reconciliation complete — all reconstruction-resolution inputs downsampled to topoResolution:', {
        from:            minimizerResolution,
        to:              topoResolution,
        zeroCurveScaled: _zcScale !== 1 && !!zeroCurve,
        principalFrameDs: !!principalFrame,
        kHDownsampled:   !!curvatureField,
        coherenceDs:     !!coherencePerPixel,
        fMapDs:          !!directnessField?.fMap,
        edgeMaskDs:      !!penumbraField?.edgeMask
      });
    }

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

    // ── Broadcast AMBI_DONE immediately with inline data ──────────────────
    // IDB persistence runs fire-and-forget below so Stage 6/7 are unblocked
    // immediately. Keys in broadcast are null — all consumers use inline data.
    _bcPost({
      event:                 'AMBI_DONE',
      metaKey,
      jobId,
      // Keys null — set asynchronously by background persistence (not needed by consumers)
      worldFrameMapKey:      null,
      warpFieldKey:          null,
      integrationWeightsKey: null,
      surfaceParamKey:       null,
      telemetryKey:          null,
      containerUpdate: {
        ambiFrame: {
          worldFrameId:          structureId,
          legibilityScore,
          viewManifoldComponent: componentId,
          positionInManifold:    Array.from(positionInManifold),
          sharedStructureId:     structureId
        }
      },
      meanMotionMagnitude: diagnostics.featureVector?.meanMotionMagnitude ?? null,
      meanLQESpeed:        diagnostics.featureVector?.meanLQESpeed        ?? null,
      degradedMode,
      isKeyframe,
      processingMs: Date.now() - startMs,
      // ── Inline payloads for Stage 6/7 — no IDB read needed ───────────────
      warpFieldInline:          { field: warpField,          width: resolution, height: resolution },
      worldFrameMapInline:      { map:   worldFrameMap,       width: resolution, height: resolution },
      integrationWeightsInline: { weights: integrationWeights, width: resolution, height: resolution },
      surfaceParamInline: {
        surfaceParamMeta,
        structureId,
        legibilityScore,
        viewManifoldComponent: componentId,
        degradedMode,
        diagnostics
      }
    });

    // ── Fire-and-forget IDB persistence ───────────────────────────────────
    // Stage 6/7 receive everything inline above. Persistence is for
    // durability / debugging only. Failures are non-fatal.
    (async () => {
      try {
        const store = _buildStore(sw);
        const TTL   = PersistenceHelper.TTL?.PINNED ?? 300_000;
        const persistMeta = {
          sourceMetaKey: metaKey, resolution, structureId,
          isKeyframe, legibilityScore, degradedMode, b0, b1,
          computedAt: Date.now()
        };
        await PersistenceHelper.persist(store, {
          type:    'world_frame_map',
          data:    { map: worldFrameMap, width: resolution, height: resolution },
          meta:    { ...persistMeta },
          ttl:     TTL, pinType: PersistenceHelper.PIN?.SOFT ?? 'soft'
        });
        await PersistenceHelper.persist(store, {
          type:    'warp_field',
          data:    { field: warpField, width: resolution, height: resolution },
          meta:    { ...persistMeta },
          ttl:     TTL, pinType: PersistenceHelper.PIN?.SOFT ?? 'soft'
        });
        await PersistenceHelper.persist(store, {
          type:    'integration_weights',
          data:    { weights: integrationWeights, width: resolution, height: resolution },
          meta:    { ...persistMeta, ...diagnostics.integration },
          ttl:     TTL, pinType: PersistenceHelper.PIN?.SOFT ?? 'soft'
        });
        await PersistenceHelper.persist(store, {
          type:    'surface_param',
          data:    { surfaceParamMeta, structureId, legibilityScore,
                     viewManifoldComponent: componentId, diagnostics },
          meta:    { ...persistMeta },
          ttl:     TTL, pinType: PersistenceHelper.PIN?.SOFT ?? 'soft'
        });
        if (_flags.ambiDebug && telemetry) {
          await PersistenceHelper.persist(store, {
            type:    'ambi_anamorph_telemetry',
            data:    telemetry,
            meta:    { ...persistMeta },
            ttl:     PersistenceHelper.TTL?.DEBUG ?? 30_000,
            pinType: PersistenceHelper.PIN?.SOFT ?? 'soft'
          });
        }
        console.log('[ambi.worker] Background persistence complete');
      } catch (e) {
        console.warn('[ambi.worker] Background persistence failed (non-fatal):', e.message);
      }
    })();

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

// ── Nearest-neighbour scalar downsample ───────────────────────────────────
// Used to reconcile minimizerResolution (1024) → topoResolution (512) when
// topology.worker downsampled its inputs and ambi must match.
// Preserves input constructor (Float32Array, Uint8Array, etc.).
function _downsampleScalar(src, srcRes, dstRes) {
  if (!src || srcRes === dstRes) return src;
  const scale = srcRes / dstRes;
  const N     = dstRes * dstRes;
  const out   = new src.constructor(N);
  for (let y = 0; y < dstRes; y++) {
    for (let x = 0; x < dstRes; x++) {
      const sy = Math.min(srcRes - 1, Math.floor(y * scale));
      const sx = Math.min(srcRes - 1, Math.floor(x * scale));
      out[y * dstRes + x] = src[sy * srcRes + sx];
    }
  }
  return out;
}

// ── Nearest-neighbour multi-channel downsample ────────────────────────────
// Extends _downsampleScalar to stride > 1. Always returns Float32Array.
//   stride = 2: xy-pair arrays (principalE1, principalE2 from dgInline)
//   stride = 4: RGBA / e1x,e1y,e2x,e2y flat arrays (IDB principalFrame format)
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