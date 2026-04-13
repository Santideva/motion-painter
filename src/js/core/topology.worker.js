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
      const [
        directionalFieldArt,
        sdfFieldArt,
        diskSeedsArt,
        curvatureArt,
        principalFrameArt,
        flowFieldArt,
        flowCurlArt,
        flowDivArt,
        directnessArt,
        normalCurlArt,
        penumbraArt,
        normalMapArt
      ] = await Promise.all([
        _loadArtifact(api, artifactKeys.directionalFieldKey),
        _loadArtifact(api, artifactKeys.sdfFieldKey),
        _loadArtifact(api, artifactKeys.diskSeedsKey),
        _loadArtifact(api, artifactKeys.curvatureKey),
        _loadArtifact(api, artifactKeys.principalFrameKey),
        _loadArtifact(api, artifactKeys.flowFieldKey),
        _loadArtifact(api, artifactKeys.flowCurlKey),
        _loadArtifact(api, artifactKeys.flowDivKey),
        _loadArtifact(api, artifactKeys.directnessFieldKey),
        _loadArtifact(api, artifactKeys.normalCurlKey),
        _loadArtifact(api, artifactKeys.penumbraFieldKey),
        _loadArtifact(api, artifactKeys.normalMapKey)
      ]);

      // ── Validate required artifacts ──────────────────────────────────────
      const missing = [];
      if (!directionalFieldArt) missing.push('directionalField');
      if (!sdfFieldArt)         missing.push('sdfField');
      if (!curvatureArt)        missing.push('curvature');
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

        kH:                curvatureArt.data.kH                             ?? null,
        normalCurl:        normalCurlArt?.data.curl                         ?? null,

        flowU:             flowFieldArt?.data.u                             ?? null,
        flowV:             flowFieldArt?.data.v                             ?? null,
        flowCurl:          flowCurlArt?.data.curl                           ?? null,
        flowDivergence:    flowDivArt?.data.divergence                      ?? null,
      };

      // ── Run analysis ──────────────────────────────────────────────────────
      const analyzer = new TopologyAnalyzer(_flags);
      const result   = await analyzer.compute({
        artifacts,
        storageWrapper: sw,
        sourceMetaKey:  metaKey,
        cameraId:       msg.cameraId ?? 'default',
        resolution:     res,
        frameIndex:     msg.frameIndex ?? 0
      });

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