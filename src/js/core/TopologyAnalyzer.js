// /src/js/core/TopologyAnalyzer.js
//
// Stage 4A orchestrator. Constructs the shared PixelGraph, runs PrimeEnds
// and LipschitzQuaternionEnds, persists all output artifacts, returns keys.
//
// Called by topology.worker with pre-loaded artifact data.

import PixelGraph             from './PixelGraph.js';
import PrimeEnds              from './PrimeEnds.js';
import LipschitzQuaternionEnds from './LipschitzQuaternionEnds.js';

// ── Dimension injection patch ──────────────────────────────────────────────
// PrimeEnds (and potentially LipschitzQuaternionEnds) reference `width` and
// `height` as undeclared free variables in methods that assume those names
// are in closure scope. They are not — JS class methods don't share a closure
// with the constructor. Since the pipeline enforces square grids throughout
// (width === height === resolution, squarified at the triangle preprocessor),
// injecting `const width = resolution; const height = width;` at the top of
// each affected method is semantically correct.
//
// NOTE: Relies on unminified source (development builds). Replace with a
// direct fix in PrimeEnds.js for production.
(function patchDimensions() {
  // ── Variable injections: name → expression evaluated against `this` ─────
  const VAR_INJECTIONS = {
    width:  '(this._G && this._G.resolution) || this._w || this.resolution || 512',
    height: '(this._G && this._G.resolution) || this._h || this.resolution || 512',
    G:      'this._G',
    kH:     'this._kH',
  };

  // ── Function injections: module-scope helpers lost by new Function() ────
  // Internal variables prefixed with _p_ to avoid collisions with body locals.
  const FN_INJECTIONS = {
    percentile99: `
      function percentile99(_p_arr) {
        const _p_n = _p_arr.length;
        let _p_mn = Infinity, _p_mx = -Infinity;
        for (let _p_i = 0; _p_i < _p_n; _p_i++) {
          if (_p_arr[_p_i] < _p_mn) _p_mn = _p_arr[_p_i];
          if (_p_arr[_p_i] > _p_mx) _p_mx = _p_arr[_p_i];
        }
        if (_p_mx === _p_mn) return Math.max(_p_mx, 1e-6);
        const _p_bins = 1000, _p_hist = new Int32Array(_p_bins);
        const _p_range = _p_mx - _p_mn;
        for (let _p_i = 0; _p_i < _p_n; _p_i++) {
          const _p_b = Math.min(_p_bins - 1, ((_p_arr[_p_i] - _p_mn) / _p_range * _p_bins) | 0);
          _p_hist[_p_b]++;
        }
        const _p_target = _p_n * 0.99;
        let _p_cum = 0;
        for (let _p_b = 0; _p_b < _p_bins; _p_b++) {
          _p_cum += _p_hist[_p_b];
          if (_p_cum >= _p_target) return _p_mn + (_p_b + 1) / _p_bins * _p_range;
        }
        return _p_mx;
      }`,
  };

  // Check if `name` is already declared in the method body (const/let/var/function).
  // If it is, injecting would cause a duplicate-declaration SyntaxError.
  const alreadyDeclared = (name, body) =>
    new RegExp(`\\b(const|let|var)\\s+${name}\\b|\\bfunction\\s+${name}\\s*\\(`).test(body);

  // Check if `name` appears at all — skip injection if not referenced.
  const isReferenced = (name, body) =>
    new RegExp(`\\b${name}\\b`).test(body);

  function buildHeader(body) {
    const lines = [], injected = [];
    for (const [name, expr] of Object.entries(VAR_INJECTIONS)) {
      if (isReferenced(name, body) && !alreadyDeclared(name, body)) {
        lines.push(`const ${name} = ${expr};`);
        injected.push(name);
      }
    }
    for (const [name, impl] of Object.entries(FN_INJECTIONS)) {
      if (isReferenced(name, body) && !alreadyDeclared(name, body)) {
        lines.push(impl.trim());
        injected.push(name);
      }
    }
    return { header: lines.join('\n'), injected };
  }

  const targets = [
    { proto: PrimeEnds.prototype,                methods: ['_buildTopologyMap', '_buildBoundaryParam', '_buildHomologySummary'] },
    { proto: LipschitzQuaternionEnds?.prototype,  methods: ['_buildQuaternionField', '_buildMotionMaps'] },
  ];

  for (const { proto, methods } of targets) {
    if (!proto) continue;
    const className = proto.constructor?.name ?? '?';
    for (const name of methods) {
      const orig = proto[name];
      if (typeof orig !== 'function') continue;

      const src       = orig.toString();
      const bodyStart = src.indexOf('{') + 1;
      const body      = src.slice(bodyStart, src.lastIndexOf('}'));
      const paramMatch = src.match(/\(([^)]*)\)/);
      const params    = paramMatch ? paramMatch[1] : '';

      const { header, injected } = buildHeader(body);

      if (!injected.length) {
        console.log(`[DimPatch] ${className}.${name} — nothing to inject`);
        continue;
      }

      try {
        // eslint-disable-next-line no-new-func
        proto[name] = new Function(
          `return function ${name}(${params}) {\n${header}\n${body}\n}`
        )();
        console.log(`[DimPatch] Patched ${className}.${name}(${params}) — injected: ${injected.join(', ')}`);
      } catch (e) {
        console.warn(`[DimPatch] Failed to patch ${name} — apply direct fix in source. Error: ${e.message}`);
      }
    }
  }
})();

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
  async compute({
    artifacts,
    storageWrapper,
    sourceMetaKey,
    cameraId,
    resolution,
    width,
    height,
    frameIndex = 0
  }) {
    const flags = this._flags;
    const t0    = performance.now();

    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      throw new Error('TopologyAnalyzer.compute: width/height are required for non-square images');
    }

    const w = width;
    const h = height;

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

    // ── Construct shared PixelGraph ───────────────────────────────────────
    console.log(`[TopologyAnalyzer] Building PixelGraph at res=${w}x${h}`);
    const _t0 = performance.now();
    const G = new PixelGraph({
      directionalField,
      kH,
      normalCurl,
      narrowBandMask,
      signedSdf,
      width: w,
      height: h,
      flags
    });
    console.log(`[TopologyAnalyzer] PixelGraph done: ${G.nodeCount} nodes, `+
                `${G.componentCount} components, ${G.cycleCount} cycles — `+
                `${(performance.now()-_t0).toFixed(0)}ms`);

    // Yield the event loop — allows the Promise.race timeout to fire and
    // allows BC messages to be processed between synchronous steps.
    await Promise.resolve();

    const betti = { b0: G.componentCount, b1: G.cycleCount, chi: G.eulerChar };

    // ── Stage 4A-1: Prime-Ends ────────────────────────────────────────────
    let peResult = null;
    if (flags.enablePrimeEnds !== false) {
      console.log(`[TopologyAnalyzer] Starting PrimeEnds — ${G.nodeCount} nodes`);
      const _tPE = performance.now();
      const pe  = new PrimeEnds(G, kH, w, h, flags);
      peResult  = pe.compute(frameIndex);
      console.log(`[TopologyAnalyzer] PrimeEnds done: ${peResult?.ends?.length ?? 0} ends — `+
                  `${(performance.now()-_tPE).toFixed(0)}ms`);
    }

    // Yield again — keeps timeout and BC live between steps
    await Promise.resolve();
    // ── Stage 4A-2: Lipschitz Quaternion Ends ────────────────────────────
    let lqeResult = null;
    if (flags.enableLQE !== false) {
      console.log(`[TopologyAnalyzer] Starting LQE — ${G.nodeCount} nodes`);
      const _tLQE = performance.now();
      // Guard: LQE requires at least one non-null flow input for its convergence
      // a convergence criterion. With all flow inputs null the solver has no
      // gradient signal and will never converge — hanging the worker.
      // derivatives (DirectionalLifting temporal signal) is not sufficient
      // alone: it provides It but not the (u,v) directional stopping criterion.
      // Normal path: enableOpticalFlow=true ensures flowU/flowV are non-null.
      // Fallback path (GPU failure / flag override): LQE is skipped; topology
      // map and prime-ends still complete, quaternion_field key will be null.
      const hasFlowInput = !!(flowU || flowCurl || flowDivergence);
      if (hasFlowInput) {
        const lqe = new LipschitzQuaternionEnds(G, {
          flowU, flowV,
          derivatives,
          coherencePerPixel,
          normalCurl,
          flowCurl,
          flowDivergence
        }, w, flags);
        lqeResult = lqe.compute(frameIndex);
        console.log(`[TopologyAnalyzer] LQE done: ${lqeResult?.ends?.length ?? 0} ends — `+
                    `${(performance.now()-_tLQE).toFixed(0)}ms`);
      } else {
        console.warn(
          '[TopologyAnalyzer] LQE skipped — flowU, flowCurl and flowDivergence are all null.' +
          ' Ensure enableOpticalFlow=true in motion.worker flags.' +
          ' lipschitz_ends, quaternion_field and motion_maps keys will be null this frame.'
        );
      }
    }

    // ── Assemble topoInline — consumed directly by minimizer and ambi ──────
    // All topology outputs travel inline. IDB persistence is fire-and-forget
    // so TOPOLOGY_DONE broadcasts immediately after computation completes,
    // matching the pattern used by DG (dgInline), SDF (sdfInline), etc.

    // ── Build component map inline ─────────────────────────────────────────
    // -1 outside narrow band, ≥0 = component index
    const componentMap = new Int32Array(w * h).fill(-1);

    for (let ni = 0; ni < G.nodeCount; ni++) {
      componentMap[G.nodeToPixel(ni)] = G.componentOf(ni);
    }

    const topoInline = {
      componentMap,                           // Int32Array w×h
      topologyMap:     peResult?.topologyMap      ?? null,
      boundaryParam:   peResult?.boundaryParam    ?? null,
      homologySummary: peResult?.homologySummary  ?? null,
      primeEnds:       peResult?.ends             ?? [],
      lipschitzEnds:   lqeResult?.ends            ?? [],
      quaternionField: lqeResult?.quaternionField ?? null,
      motionMaps:      lqeResult?.motionMaps      ?? null,
      nodeEndMap:      peResult?.nodeEndMap       ?? null,
      betti,
      endCount: {
        primeEnds: peResult  ? peResult.ends.length  : 0,
        lipschitz: lqeResult ? lqeResult.ends.length : 0
      }
    };

    const processingMs = performance.now() - t0;

    // ── Fire-and-forget IDB persistence ───────────────────────────────────
    // Keys remain null on return — consumers use topoInline directly.
    (async () => {

      const TTL_FINAL = 300_000; // 5 min

      const persistMeta = {
        sourceMetaKey,
        cameraId,
        resolution,
        width: w,
        height: h,
        frameIndex
      };

      try {

        if (peResult) {

          await PersistenceHelper.persist(store, {
            type: 'prime_ends',
            data: {
              ends: this._serialiseEnds(peResult.ends),
              topologyMap: peResult.topologyMap,
              boundaryParam: peResult.boundaryParam,
              homologySummary: peResult.homologySummary
            },
            meta: {
              ...persistMeta,
              endCount: peResult.ends.length,
              betti,
              diagnostics: peResult.diagnostics,
              computedAt: Date.now()
            },
            ttl: TTL_FINAL,
            pinType: 'soft'
          });

          await PersistenceHelper.persist(store, {
            type: 'topology_map',
            data: {
              map: peResult.topologyMap,
              width: w,
              height: h
            },
            meta: {
              ...persistMeta,
              computedAt: Date.now()
            },
            ttl: TTL_FINAL,
            pinType: 'soft'
          });

          await PersistenceHelper.persist(store, {
            type: 'component_map',
            data: {
              map: componentMap,
              width: w,
              height: h
            },
            meta: {
              ...persistMeta,
              b0: G.componentCount,
              computedAt: Date.now()
            },
            ttl: TTL_FINAL,
            pinType: 'soft'
          });

          await PersistenceHelper.persist(store, {
            type: 'homology_summary',
            data: peResult.homologySummary,
            meta: {
              ...persistMeta,
              computedAt: Date.now()
            },
            ttl: TTL_FINAL,
            pinType: 'soft'
          });

          await PersistenceHelper.persist(store, {
            type: 'boundary_param',
            data: peResult.boundaryParam,
            meta: {
              ...persistMeta,
              computedAt: Date.now()
            },
            ttl: TTL_FINAL,
            pinType: 'soft'
          });
        }

        if (lqeResult) {

          await PersistenceHelper.persist(store, {
            type: 'lipschitz_ends',
            data: {
              ends: this._serialiseEnds(lqeResult.ends),
              seedMask: lqeResult.seedMask
            },
            meta: {
              ...persistMeta,
              endCount: lqeResult.ends.length,
              diagnostics: lqeResult.diagnostics,
              computedAt: Date.now()
            },
            ttl: TTL_FINAL,
            pinType: 'soft'
          });

          await PersistenceHelper.persist(store, {
            type: 'quaternion_field',
            data: {
              field: lqeResult.quaternionField,
              width: w,
              height: h
            },
            meta: {
              ...persistMeta,
              computedAt: Date.now()
            },
            ttl: TTL_FINAL,
            pinType: 'soft'
          });

          await PersistenceHelper.persist(store, {
            type: 'motion_maps',
            data: lqeResult.motionMaps,
            meta: {
              ...persistMeta,
              computedAt: Date.now()
            },
            ttl: TTL_FINAL,
            pinType: 'soft'
          });
        }

        console.log('[TopologyAnalyzer] Background persistence complete');

      } catch (e) {

        console.warn(
          '[TopologyAnalyzer] Background persistence failed (non-fatal):',
          e.message
        );
      }

    })();

    return {

      // Consumers now use topoInline directly
      primeEndsKey:       null,
      topologyMapKey:     null,
      homologySummaryKey: null,
      boundaryParamKey:   null,
      lipschitzEndsKey:   null,
      quaternionFieldKey: null,
      motionMapsKey:      null,
      componentMapKey:    null,

      topoInline,

      betti,

      endCount: topoInline.endCount,

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