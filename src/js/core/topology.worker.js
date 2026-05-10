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

    console.log('[topology.worker] Loading artifacts:', {
      hasSdfInline:        !!sdfInline,
      hasStage1Inline:     !!stage1Inline,
      directionalFieldKey: artifactKeys.directionalFieldKey ?? null,
      diskSeedsKey:        artifactKeys.diskSeedsKey        ?? null,
      curvatureKey:        artifactKeys.curvatureKey        ?? null
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
      hasDiskSeeds:        !!diskSeedsArt
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
      // NOTE (Bug 7): field names below (e.g. .data.kH, .data.curl, .data.u/.v,
      // .data.divergence) must be verified against DifferentialGeometry.js output
      // before this worker is considered production-ready.
      const res = artifactKeys.resolution ?? 512;

      const artifacts = {
        directionalField:  directionalFieldArt.data.field,
        coherencePerPixel: directionalFieldArt.data.coherence?.perPixel   ?? null,
        derivatives:       directionalFieldArt.data.derivatives             ?? null,

        signedSdf:         sdfFieldArt.data.signedSdf,
        narrowBandMask:    sdfFieldArt.data.narrowBandMask,

        // DG fields from dgInline — no IDB read needed
        kH:                dgInline?.kH                                    ?? null,
        normalCurl:        dgInline?.normalCurl                            ?? null,
        flowU:             flowFieldArt?.data.u                            ?? null,
        flowV:             flowFieldArt?.data.v                            ?? null,
        flowCurl:          dgInline?.flowCurl                              ?? null,
        flowDivergence:    dgInline?.flowDiv                               ?? null,
      };

      // ── Run analysis ──────────────────────────────────────────────────────
      // Timeout scales with resolution: PixelGraph + PrimeEnds BFS at 1024²
      // (1M nodes) legitimately takes 60–120s with flow. Without flow LQE hangs
      // indefinitely. Scale by (res/512)² so 512²→60s, 1024²→240s.
      const TOPOLOGY_TIMEOUT_MS = 60_000 * Math.pow(Math.max(res, 512) / 512, 2);
      const analyzer = new TopologyAnalyzer(_flags);
      const result = await Promise.race([
        analyzer.compute({
          artifacts,
          storageWrapper: sw,
          sourceMetaKey:  metaKey,
          cameraId:       msg.cameraId ?? 'default',
          resolution:     res,
          frameIndex:     msg.frameIndex ?? 0
        }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(
              `TopologyAnalyzer.compute() timed out after ${TOPOLOGY_TIMEOUT_MS}ms ` +
              `at resolution ${res}² — likely LipschitzQuaternionEnds solver hang ` +
              `on null flowCurl/flowDiv. Ensure enableOpticalFlow=true.`
            )),
            TOPOLOGY_TIMEOUT_MS
          )
        )
      ]);

      // ── Broadcast completion ──────────────────────────────────────────────
      _bcPost({
        event:              'TOPOLOGY_DONE',
        metaKey,
        jobId,
        primeEndsKey:       result.primeEndsKey,
        topologyMapKey:     result.topologyMapKey,
        homologySummaryKey: result.homologySummaryKey,
        boundaryParamKey:   result.boundaryParamKey,
        lipschitzEndsKey:   result.lipschitzEndsKey,
        quaternionFieldKey: result.quaternionFieldKey,
        motionMapsKey:      result.motionMapsKey,
        componentMapKey:    result.componentMapKey,
        betti:              result.betti,
        endCount:           result.endCount,
        processingMs:       result.processingMs,
        wallMs:             Date.now() - startMs
      });

    } catch (err) {
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