// /src/js/core/TopologyAnalyzer.js
//
// Stage 4A orchestrator. Constructs the shared PixelGraph, runs PrimeEnds
// and LipschitzQuaternionEnds, persists all output artifacts, returns keys.
//
// Called by topology.worker with pre-loaded artifact data.

import PixelGraph             from './PixelGraph.js';
import PrimeEnds              from './PrimeEnds.js';
import LipschitzQuaternionEnds from './LipschitzQuaternionEnds.js';
import PersistenceHelper from './PersistenceHelper.js';

export class TopologyAnalyzer {
  /**
   * @param {object} flags
   */
  constructor(flags = {}) {
    this._flags = flags;
  }

  /**
   * @param {object} opts
   * @param {object} opts.artifacts        — pre-loaded artifact data keyed by type
   * @param {object} opts.storageWrapper   — { putArtifact, raw: { pinArtifact } }
   * @param {string} opts.sourceMetaKey
   * @param {string} opts.cameraId
   * @param {number} opts.resolution
   * @param {number} [opts.frameIndex=0]
   * @returns {Promise<TopologyResult>}
   */
  async compute({ artifacts, storageWrapper, sourceMetaKey, cameraId, resolution, frameIndex = 0 }) {
    const flags = this._flags;
    const t0    = performance.now();

    // ── Build PersistenceHelper store adapter ────────────────────────────
    const store = this._buildStore(storageWrapper);

    // ── Unpack loaded artifacts ──────────────────────────────────────────
    const {
      directionalField,      // Float32Array res²×4
      coherencePerPixel,     // Float32Array res²  (may be null)
      derivatives,           // { field, dt, meanAbsDerivative } (may be null)
      signedSdf,             // Float32Array res²
      narrowBandMask,        // Float32Array res² (>0 = in band)
      kH,                    // Float32Array res²  (curvature)
      normalCurl,            // Float32Array res²
      flowU,                 // Float32Array res²  (may be null)
      flowV,                 // Float32Array res²
      flowCurl,              // Float32Array res²  (from DG, may be null)
      flowDivergence,        // Float32Array res²
    } = artifacts;

    const w = resolution;

    // ── Construct shared PixelGraph ───────────────────────────────────────
    const G = new PixelGraph({
      directionalField,
      kH,
      normalCurl,
      narrowBandMask,
      signedSdf,
      resolution: w,
      flags
    });

    const betti = { b0: G.componentCount, b1: G.cycleCount, chi: G.eulerChar };

    // ── Stage 4A-1: Prime-Ends ────────────────────────────────────────────
    let peResult = null;
    if (flags.enablePrimeEnds !== false) {
      const pe  = new PrimeEnds(G, kH, w, flags);
      peResult  = pe.compute(frameIndex);
    }

    // ── Stage 4A-2: Lipschitz Quaternion Ends ────────────────────────────
    let lqeResult = null;
    if (flags.enableLQE !== false) {
      const lqe = new LipschitzQuaternionEnds(G, {
        flowU, flowV,
        derivatives,
        coherencePerPixel,
        normalCurl,
        flowCurl,
        flowDivergence
      }, w, flags);
      lqeResult = lqe.compute(frameIndex);
    }

    // ── Persist artifacts ────────────────────────────────────────────────
    const TTL_FINAL = 300_000;   // 5 min
    const TTL_DEBUG = 30_000;    // 30 s

    const persistMeta = { sourceMetaKey, cameraId, resolution, frameIndex };

    // prime_ends
    let primeEndsResult = null;
    if (peResult) {
        primeEndsResult = await PersistenceHelper.persist(store, {
        type: 'prime_ends',
        data: {
          ends:            this._serialiseEnds(peResult.ends),
          topologyMap:     peResult.topologyMap,
          boundaryParam:   peResult.boundaryParam,
          homologySummary: peResult.homologySummary
        },
        meta: {
          ...persistMeta,
          endCount:   peResult.ends.length,
          betti,
          diagnostics: peResult.diagnostics,
          computedAt:  Date.now()
        },
        ttl:     TTL_FINAL,
        pinType: 'soft'
      });
    }

    // topology_map (separate key — consumers often only need this)
    let topologyMapResult = null;
    if (peResult) {
        topologyMapResult = await PersistenceHelper.persist(store, {
        type:    'topology_map',
        data:    { map: peResult.topologyMap, width: w, height: w },
        meta:    { ...persistMeta, computedAt: Date.now() },
        ttl:     TTL_FINAL,
        pinType: 'soft'
      });
    }

    // homology_summary
    let homologySummaryResult = null;
    if (peResult) {
      homologySummaryResult = await PersistenceHelper.persist(store, {
        type:    'homology_summary',
        data:    peResult.homologySummary,
        meta:    { ...persistMeta, computedAt: Date.now() },
        ttl:     TTL_FINAL,
        pinType: 'soft'
      });
    }

    // component_map — per-pixel component label (Int32Array res²)
    // -1 outside narrow band, ≥0 = component index.
    // Required by minimizer.worker for per-component λ routing (Stage 4B).
    let componentMapResult = null;
    {
      const componentMap = new Int32Array(w * w).fill(-1);
      for (let ni = 0; ni < G.nodeCount; ni++) {
        componentMap[G.nodeToPixel(ni)] = G.componentOf(ni);
      }
      componentMapResult = await PersistenceHelper.persist(store, {
        type:    'component_map',
        data:    { map: componentMap, width: w, height: w },
        meta:    { ...persistMeta, b0: G.componentCount, computedAt: Date.now() },
        ttl:     TTL_FINAL,
        pinType: 'soft'
      });
    }

    // boundary_param
    let boundaryParamResult = null;
    if (peResult) {
        boundaryParamResult = await PersistenceHelper.persist(store, {
        type:    'boundary_param',
        data:    peResult.boundaryParam,
        meta:    { ...persistMeta, computedAt: Date.now() },
        ttl:     TTL_FINAL,
        pinType: 'soft'
      });
    }

    // lipschitz_ends
    let lipschitzEndsResult = null;
    if (lqeResult) {
        lipschitzEndsResult = await PersistenceHelper.persist(store, {
        type: 'lipschitz_ends',
        data: {
          ends:     this._serialiseEnds(lqeResult.ends),
          seedMask: lqeResult.seedMask
        },
        meta: {
          ...persistMeta,
          endCount:    lqeResult.ends.length,
          diagnostics: lqeResult.diagnostics,
          computedAt:  Date.now()
        },
        ttl:     TTL_FINAL,
        pinType: 'soft'
      });
    }

    // quaternion_field
    let quaternionFieldResult = null;
    if (lqeResult) {
        quaternionFieldResult = await PersistenceHelper.persist(store, {
        type:    'quaternion_field',
        data:    { field: lqeResult.quaternionField, width: w, height: w },
        meta:    { ...persistMeta, computedAt: Date.now() },
        ttl:     TTL_FINAL,
        pinType: 'soft'
      });
    }

    // motion_maps
    let motionMapsResult = null;
    if (lqeResult) {
        motionMapsResult = await PersistenceHelper.persist(store, {
        type:    'motion_maps',
        data:    lqeResult.motionMaps,
        meta:    { ...persistMeta, computedAt: Date.now() },
        ttl:     TTL_FINAL,
        pinType: 'soft'
      });
    }

    const processingMs = performance.now() - t0;

    return {
      primeEndsKey:       primeEndsResult?.metaKey       ?? null,
      topologyMapKey:     topologyMapResult?.metaKey     ?? null,
      homologySummaryKey: homologySummaryResult?.metaKey ?? null,
      boundaryParamKey:   boundaryParamResult?.metaKey   ?? null,
      lipschitzEndsKey:   lipschitzEndsResult?.metaKey   ?? null,
      quaternionFieldKey: quaternionFieldResult?.metaKey ?? null,
      motionMapsKey:      motionMapsResult?.metaKey      ?? null,
      componentMapKey:    componentMapResult?.metaKey    ?? null,
      betti,
      endCount: {
        primeEnds: peResult  ? peResult.ends.length  : 0,
        lipschitz: lqeResult ? lqeResult.ends.length : 0
      },
      processingMs
    };
  }

  // ── Serialise ends (convert Int32Arrays to plain arrays for JSON storage)
  _serialiseEnds(ends) {
    return ends.map(e => ({
      ...e,
      pixelIndices:       Array.from(e.pixelIndices),
      representativeCuts: e.representativeCuts
    }));
  }

    // ── Storage adapter (mirrors DifferentialGeometry._buildStore pattern) ─
    _buildStore(storageWrapper) {
    const sw = storageWrapper;
    return {
      persistAndPin: async (type, data, meta, ttlMs, pinType) => {
        const artifact = { type, data, meta };

        let putResult;
        try {
          putResult = await sw.putArtifact(artifact);
        } catch (e) {
          throw new Error(`TopologyAnalyzer: putArtifact failed for ${type}: ${e.message}`);
        }

        if (!putResult?.ok || !putResult.metaKey) {
          throw new Error(`TopologyAnalyzer: no metaKey returned for ${type}`);
        }

        const pinFn = sw.raw?.pinArtifact ??
          (typeof self.pinArtifact === 'function' ? self.pinArtifact : null);
        if (typeof pinFn === 'function') {
          try {
            await pinFn(putResult.metaKey, {
              owner:  'topology.worker',
              type:   pinType ?? 'soft',
              ttlMs:  ttlMs > 0 ? ttlMs : null
            });
          } catch (e) {
            console.warn(
              `[TopologyAnalyzer] pin failed for ${putResult.metaKey.slice(0,20)}... (non-fatal):`,
              e.message
            );
          }
        }

        return putResult;
      }
    };
  }
}

export default TopologyAnalyzer;