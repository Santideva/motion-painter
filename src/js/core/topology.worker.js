// /src/js/core/topology.worker.js
//
// Stage 4A worker shell.
// Lightweight: no GPU, no heartbeat, no TTL timer machinery.
// Responsibilities:
//   1. Load storage API
//   2. Load all required artifacts from storage
//   3. Call TopologyAnalyzer.compute()
//   4. Broadcast TOPOLOGY_DONE

import { TopologyAnalyzer } from './TopologyAnalyzer.js';                 // FIX: was '../core/TopologyAnalyzer.js' — wrong path for /src/js/core/ location
// REMOVED: import { applyFlagsSnapshot } from '../config/featureFlags.js'; // FIX Bug 3: applyFlagsSnapshot does not exist in featureFlags.js

// ── Broadcast channel ────────────────────────────────────────────────────
let _bc = null;
try { _bc = new BroadcastChannel('motion-painter-store'); } catch(e) {}   // FIX Bug 2: was 'motionpainter' — TOPOLOGY_DONE would never reach main.js

function _bcPost(payload) {
  if (_bc) { try { _bc.postMessage(payload); } catch(e) {} }
}

// ── Storage ───────────────────────────────────────────────────────────────
let _storageAPI = null;

async function _loadStorageAPI() {
  if (_storageAPI) return _storageAPI;
  const mod = await import('./storage.js');                                 // FIX Bug 4: was '../storage/storageAPI.js' — non-existent path; storage module is a sibling in /src/js/core/
  _storageAPI = mod.default ?? mod.storageAPI ?? mod;
  return _storageAPI;
}

// ── Retry helper ──────────────────────────────────────────────────────────
async function _retryable(fn, maxAttempts = 3, delayMs = 80) {
  let last;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const transient = e?.name === 'InvalidStateError' || e?.message?.includes('transaction');
      if (!transient || attempt === maxAttempts) throw e;
      await new Promise(r => setTimeout(r, delayMs * attempt));
    }
  }
  throw last;
}

// ── Storage wrapper ────────────────────────────────────────────────────────
function _wrapStorage(api) {
  return {
    putArtifact: (art) => _retryable(() => api.putInboundArtifact(art)),
    raw:         api
  };
}

// ── Load a single artifact by metaKey (with retry) ────────────────────────
async function _loadArtifact(api, metaKey) {
  if (!metaKey) return null;
  return _retryable(() => api.getArtifact(metaKey));
}

// ── Error summary ─────────────────────────────────────────────────────────
function _safeErr(e) {
  return { message: e?.message ?? String(e), stack: e?.stack ?? null };
}

// ── Flags ──────────────────────────────────────────────────────────────────
let _flags = {};

// ── Main message handler ───────────────────────────────────────────────────
self.onmessage = async (evt) => {
  const msg = evt.data;
  if (!msg || !msg.op) return;

  if (msg.op === 'init') {
    if (msg.flags) Object.assign(_flags, msg.flags);                       // FIX Bug 3: was applyFlagsSnapshot(msg.flags)
    return;
  }

  if (msg.op === 'TOPOLOGY_ANALYZE') {
    const { jobId, metaKey, flags: jobFlags, artifactKeys } = msg;
    if (jobFlags) Object.assign(_flags, jobFlags);                         // FIX Bug 3: was applyFlagsSnapshot(jobFlags)

    const startMs = Date.now();
    if (self._activeTopoJobId) {
      console.warn('[topology.worker] ⚠ CONCURRENT JOB DETECTED — previous job still running', {
        activeJobId: self._activeTopoJobId,
        newJobId:    jobId,
        newMetaKey:  metaKey
      });
    }
    self._activeTopoJobId = jobId;
    try {
      const api = await _loadStorageAPI();
      const sw  = _wrapStorage(api);

      // ── Load all artifacts in parallel ──────────────────────────────────
      // directnessArt and penumbraArt come from stage1Inline (not IDB).
      // Their IDB keys are null — loading them would return null anyway.
      const stage1Inline = msg.stage1Inline ?? null;
      const sdfInline    = msg.sdfInline    ?? null;
      const normalInline = msg.normalInline ?? null;
      // normalInline is always null at dispatch — main.js passes it as null by design.
    // topology.worker uses dgInline.normalCurl only; the raw normal field is not needed.
    if (normalInline) {
      console.warn('[topology.worker] normalInline unexpectedly non-null — ignored (topology uses dgInline.normalCurl only)');
    }
      const dgInline = msg.dgInline ?? null;
      if (dgInline) {
        console.log('[topology.worker] dgInline received:', {
          hasKH:         !!dgInline.kH,
          hasNormalCurl: !!dgInline.normalCurl,
          hasFlowCurl:   !!dgInline.flowCurl,
          hasFlowDiv:    !!dgInline.flowDiv
        });
      } else {
        console.warn('[topology.worker] dgInline absent — kH/curl fields will be null');
      }

    const _artifactLoadStart = Date.now();
    console.log('[topology.worker] Loading artifacts:', {
      hasSdfInline:        !!sdfInline,
      hasStage1Inline:     !!stage1Inline,
      directionalFieldKey: artifactKeys.directionalFieldKey ?? null,
      diskSeedsKey:        artifactKeys.diskSeedsKey        ?? null,
      curvatureKey:        artifactKeys.curvatureKey        ?? null,
      loadStartedAt:       _artifactLoadStart
    });

    // sdfFieldArt is constructed from sdfInline — not loaded from IDB.
    // sdfFieldKey is null (the IDB record contains only scalar metadata).
    // Shape matches what getArtifact would have returned so downstream
    // code that reads sdfFieldArt.data.signedSdf etc. is unchanged.
    const sdfFieldArt = sdfInline
      ? {
          data: {
            signedSdf:      sdfInline.signedSdf,
            narrowBandMask: sdfInline.narrowBandMask,
            densityMap:     sdfInline.densityMap  ?? null,
            surfaceMask:    sdfInline.surfaceMask ?? null
          }
        }
      : null;  // will cause 'sdfField' to appear in missing[] below

    if (sdfInline) {
      console.log('[topology.worker] sdfInline received:', {
        signedSdfLength:      sdfInline.signedSdf?.length      ?? 0,
        narrowBandMaskLength: sdfInline.narrowBandMask?.length ?? 0,
        densityMapLength:     sdfInline.densityMap?.length     ?? 0,
        surfaceMaskLength:    sdfInline.surfaceMask?.length    ?? 0
      });
    } else {
      console.warn('[topology.worker] sdfInline absent — sdfFieldArt will be null');
    }

    const [
      directionalFieldArt,
      diskSeedsArt,
      curvatureArt,
      principalFrameArt,
      flowFieldArt,
      flowCurlArt,
      flowDivArt,
      normalCurlArt
    ] = await Promise.all([
      _loadArtifact(api, artifactKeys.directionalFieldKey),
      _loadArtifact(api, artifactKeys.diskSeedsKey),
      _loadArtifact(api, artifactKeys.curvatureKey),
      _loadArtifact(api, artifactKeys.principalFrameKey),
      _loadArtifact(api, artifactKeys.flowFieldKey),
      _loadArtifact(api, artifactKeys.flowCurlKey),
      _loadArtifact(api, artifactKeys.flowDivKey),
      _loadArtifact(api, artifactKeys.normalCurlKey)
    ]);

    // Stage 1 inline — directnessArt and penumbraArt from msg, not IDB
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

    console.log('[topology.worker] Artifact load complete:', {
      hasDirectionalField: !!directionalFieldArt,
      hasSdfField:         !!sdfFieldArt,
      hasCurvature:        !!curvatureArt,
      hasDirectness:       !!directnessArt,
      hasPenumbra:         !!penumbraArt,
      hasDiskSeeds:        !!diskSeedsArt,
      artifactLoadMs:      Date.now() - _artifactLoadStart
    });

      // ── Validate required artifacts ──────────────────────────────────────
      const missing = [];
      if (!directionalFieldArt) missing.push('directionalField');
      if (!sdfFieldArt)         missing.push('sdfField');
      // curvature can come from dgInline.kH (inline path) or curvatureArt (IDB path)
      const hasKH = !!(dgInline?.kH ?? curvatureArt?.data?.kH);
      if (!hasKH) missing.push('curvature (neither dgInline.kH nor curvatureArt available)');
      if (missing.length > 0) throw new Error(`Missing required artifacts: ${missing.join(', ')}`);

      // ── Unpack into typed arrays ──────────────────────────────────────────
      // Dimension resolution priority:
      //   1. Explicit width/height in msg or artifactKeys (future non-square support)
      //   2. artifactKeys.resolution (square grid — what main.js currently sends)
      //   3. Derive from SDF length (sqrt(signedSdf.length)) — ground-truth fallback
      //      that works even when main.js sends the wrong resolution value
      //   4. Hard floor of 512
      const _sdfDerivedRes = sdfInline?.signedSdf?.length
        ? Math.round(Math.sqrt(sdfInline.signedSdf.length))
        : null;
      const _res = artifactKeys.resolution ?? _sdfDerivedRes ?? 512;
      const sourceWidth  = msg.width  ?? artifactKeys.width  ?? _res;
      const sourceHeight = msg.height ?? artifactKeys.height ?? _res;

      // if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight)) {
      //   throw new Error(
      //     'topology.worker: width/height are required for non-square images ' +
      //     '(pass them in the message or artifactKeys)'
      //   );
      // }

      // Cap topology resolution while preserving aspect ratio.
      const TOPO_MAX_SIDE = _flags.topoMaxResolution ?? 512;
      const scale = Math.min(1, TOPO_MAX_SIDE / Math.max(sourceWidth, sourceHeight));
      const topoWidth  = Math.max(1, Math.round(sourceWidth  * scale));
      const topoHeight = Math.max(1, Math.round(sourceHeight * scale));
      // dsScale removed — _dsFlow multiplies by `scale` directly (< 1 when downsampling),
      // which correctly shrinks pixel-space displacement vectors for the smaller grid.

      // Nearest-neighbour downsample for stride-N fields.
      // stride=1: scalar  stride=2: xy-pairs  stride=4: RGBA
      const _dsN = (arr, stride) => {
        if (!arr || scale === 1) return arr;
        const out = new (arr.constructor)(topoWidth * topoHeight * stride);
        for (let y = 0; y < topoHeight; y++) {
          for (let x = 0; x < topoWidth; x++) {
            const si = (Math.floor(y / scale) * sourceWidth + Math.floor(x / scale)) * stride;
            const di = (y * topoWidth + x) * stride;
            for (let s = 0; s < stride; s++) out[di + s] = arr[si + s];
          }
        }
        return out;
      };

      // Flow vectors represent pixel-space displacements; rescale by the same factor.
      const _dsFlow = (arr) => {
        const d = _dsN(arr, 1);
        if (d && scale !== 1) for (let i = 0; i < d.length; i++) d[i] *= scale;
        return d;
      };

      const artifacts = {
        directionalField:  _dsN(directionalFieldArt.data.field, 4),
        coherencePerPixel: _dsN(directionalFieldArt.data.coherence?.perPixel ?? null, 1),
        derivatives:       directionalFieldArt.data.derivatives
          ? { field:             _dsN(directionalFieldArt.data.derivatives.field, 4),
              dt:                directionalFieldArt.data.derivatives.dt,
              meanAbsDerivative: directionalFieldArt.data.derivatives.meanAbsDerivative }
          : null,

        signedSdf:         _dsN(sdfFieldArt.data.signedSdf, 1),
        narrowBandMask:    _dsN(sdfFieldArt.data.narrowBandMask, 1),

        // DG fields from dgInline — no IDB read needed
        kH:                _dsN(dgInline?.kH        ?? null, 1),
        principalE1:       _dsN(dgInline?.principalE1 ?? null, 2), // xy-pairs, 2-channel
        normalCurl:        _dsN(dgInline?.normalCurl ?? null, 1),
        flowU:             _dsFlow(flowFieldArt?.data.u ?? null),
        flowV:             _dsFlow(flowFieldArt?.data.v ?? null),
        flowCurl:          _dsN(dgInline?.flowCurl  ?? null, 1),
        flowDivergence:    _dsN(dgInline?.flowDiv   ?? null, 1),
      };

      // ── Run analysis ──────────────────────────────────────────────────────
      console.log(
        `[topology.worker] Entering TopologyAnalyzer.compute() — ` +
        `topo=${topoWidth}x${topoHeight} (full res=${sourceWidth}x${sourceHeight}, scale=${scale.toFixed(2)})`
      );
      const TOPOLOGY_TIMEOUT_MS = 60_000 * Math.max(1, (topoWidth * topoHeight) / (512 * 512));
      console.log(`[topology.worker] Timeout budget: ${(TOPOLOGY_TIMEOUT_MS/1000).toFixed(0)}s`);
      const analyzer = new TopologyAnalyzer(_flags);
      const result = await Promise.race([
        analyzer.compute({
          artifacts,
          storageWrapper: sw,
          sourceMetaKey:  metaKey,
          cameraId:       msg.cameraId ?? 'default',
          resolution:     Math.max(topoWidth, topoHeight), // legacy field only
          width:          topoWidth,
          height:         topoHeight,
          frameIndex:     msg.frameIndex ?? 0
        }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(
              `TopologyAnalyzer.compute() timed out after ${TOPOLOGY_TIMEOUT_MS}ms ` +
              `at topo ${topoWidth}×${topoHeight} (full res ${sourceWidth}×${sourceHeight})`
            )),
            TOPOLOGY_TIMEOUT_MS
          )
        )
      ]);

      // ── Broadcast completion ──────────────────────────────────────────────
      self._activeTopoJobId = null;
      _bcPost({
        event:              'TOPOLOGY_DONE',
        metaKey,
        jobId,
        // Keys are null — all consumers use topoInline directly.
        // Fire-and-forget IDB persistence runs in background inside TopologyAnalyzer.
        primeEndsKey:       result.primeEndsKey       ?? null,
        topologyMapKey:     result.topologyMapKey     ?? null,
        homologySummaryKey: result.homologySummaryKey ?? null,
        boundaryParamKey:   result.boundaryParamKey   ?? null,
        lipschitzEndsKey:   result.lipschitzEndsKey   ?? null,
        quaternionFieldKey: result.quaternionFieldKey ?? null,
        motionMapsKey:      result.motionMapsKey      ?? null,
        componentMapKey:    result.componentMapKey    ?? null,
        // Inline topology data — typed arrays are structured-cloned (no IDB round-trip)
        topoInline:         result.topoInline         ?? null,
        betti:              result.betti,
        endCount:           result.endCount,
        processingMs:       result.processingMs,
        wallMs:             Date.now() - startMs
      });

    } catch (err) {
      self._activeTopoJobId = null;
      console.error('[topology.worker] TOPOLOGY_ANALYZE failed:', err);
      _bcPost({
        event:        'TOPOLOGY_ERROR',
        metaKey,
        jobId,
        error:        _safeErr(err),
        wallMs:       Date.now() - startMs
      });
    }
    return;
  }

  if (msg.op === 'shutdown') {
    if (_bc) { try { _bc.close(); } catch(e) {} }
    self.close();
  }
};