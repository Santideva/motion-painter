// src/config/featureFlags.js
// Robust feature flags helper for Motion-Painter
// Implements: localStorage persistence (with quota detection), BroadcastChannel bootstrap + handler registry,
// synchronous subscribe bootstrap, monotonic __seq management, reserved-key protection, and safe BC replacement.

/* eslint-disable no-console */

const FEATURE_FLAGS_VERSION = 2; // bump when defaults change incompatibly
const STORAGE_KEY = 'motionPainter.features.v1';
const BC_CHANNEL = 'motion-painter-store';

// ------------------------ Defaults ------------------------
const DEFAULTS = {
  // Core features & pipelines
  enableFresnelEviction: false,
  enablePackingSdf: false,
  enableKeypointPipeline: false,
  enableAmbiAdapter: false,
  enablePascalQuadSdf: false,
  enableTopologyEngine: false,
  fmapGeneration: false,
  topologyTelemetry: false,
  enableMotionWorker: true,
  enableSamplerPlugins: true,
  enableDevPanels: false,

// ✅ NEW: Core pipeline control (calibrated pipeline modules)
  enableTetrachromacy: true,          // Enable Tetrachromacy spectral decomposition
  enableDirectionalLifting: true,      // Enable DirectionalLifting temporal aggregation

  // ============================================================================
  // ✅ NEW: Artifact Persistence Control
  // ============================================================================
  /**
   * persistIntermediates: Controls persistence of intermediate pipeline artifacts
   * 
   * When enabled, motion.worker will persist:
   * - tetra_field (Tetrachromacy output)
   * - directional_field (DirectionalLifting output)
   * - bump_map (Laplacian-based bump)
   * - specular_mask (Chromaticity-based specular)
   * - triangle_output (Triangle preprocessor depths/tilts/winding)
   * 
   * These artifacts are expensive to compute (1-5s) but primarily useful for debugging.
   * Storage impact: ~2-5MB per reconstruction (5 artifacts × ~1MB each)
   * 
   * Recommended: false (production), true (development/debugging)
   */
  persistIntermediates: false,

  /**
   * persistDebugArtifacts: Controls persistence of MotionDetector debug artifacts
   * 
   * When enabled, MotionDetector will persist:
   * - motion_analysis (ImageData motion detection results)
   * - motion_detector_metrics (aggregated performance stats)
   * 
   * These artifacts are high-frequency (30fps for motion_analysis, 0.1Hz for metrics)
   * and primarily useful for algorithm tuning and debugging.
   * 
   * Storage impact: ~5-8KB per frame for motion_analysis, ~15KB per 10s for metrics
   * At 30fps, this is ~240KB/s or ~14MB/min of continuous capture
   * 
   * Recommended: false (always in production), true (short debugging sessions only)
   */
  persistDebugArtifacts: false,

  /**
   * MOTION_UNPIN_ON_CLAIM: Controls motion.worker pin release behavior
   * 
   * false (conservative, default):
   *   - Producer keeps pin as fallback until consumer releases
   *   - Higher pinnedBytes but safer (protects against consumer bugs)
   *   - Recommended for development
   * 
   * true (aggressive, memory-optimized):
   *   - Producer unpins immediately on consumer claim
   *   - Lower pinnedBytes (frees memory early)
   *   - Requires well-behaved consumers (always pin before use)
   *   - Recommended for production after thorough testing
   */
  MOTION_UNPIN_ON_CLAIM: false,

  /**
   * enableLegacyFluxManifest: Controls motion.worker's legacy _computeFluxFromCalibration
   * path, which runs on every 'calibration:ready' BC broadcast and produces a
   * 'flux-manifest' artifact type that NO downstream worker (topology, minimizer,
   * ambi, kem, correspondence) reads. Confirmed dead output. Disabled by default
   * to stop duplicate GPU/CPU work and IDB writes on every calibration cycle.
   * Set true only if external tooling still depends on flux-manifest artifacts.
   */
  enableLegacyFluxManifest: false,

  // ✅ NEW: Module debug flags
  calibDebug: false,                   // CalibratedFieldProducer debug logging
  tetraDebug: false,                   // Tetrachromacy debug logging
  dirLiftDebug: false,                 // DirectionalLifting debug logging
  heartbeatDebug: false,               // Heartbeat success/failure logging
  gpuContextDebug: false,              // Log WebGL context loss/restore + _gpuCapabilities cache resets

  // ✅ NEW: DirectionalLifting buffer management
  dirLiftBufferSize: null,            // Manual buffer size override (null = auto)
  dirLiftMaxBufferMB: 32,             // Max MB for temporal buffer allocation

  // ✅ NEW: Bump mapping (Laplacian-based depth-to-bump)
  bumpScale: 1.0,                     // Bump intensity multiplier
  bumpFusionMode: false,              // Enable stddev fusion with Laplacian

  // ✅ NEW: Normal mapping (Sobel-based bump-to-normal)
  normalScale: 1.0,                   // Normal map gradient scale

  // ✅ NEW: Specular masking (chromaticity-based specular detection)
  specularHpGain: 4.0,                // High-pass gain for specular detection
  specularAlpha: 0.5,                 // Blend ratio for chroma component (0..1)
  specularChromaScale: 3.0,           // Chroma deviation amplification
  specularThreshold: 0.15,            // Minimum specular mask threshold (0..1)

  // Stage 1: f_map (visible-fraction field)
  enableFMapRouteA: true,             // true  → Route A (depth MC) runs after GPU branch
                                      // false → always use Route B (temporal proxy)
  fMapDebug: true,                   // log Route A source position + timing per frame
  fMapDirectThresh: 0.9,              // f >= this  →  DIRECT   modal label (2)
  fMapUmbraThresh: 0.1,               // f <= this  →  UMBRA    modal label (0)
                                      // in between →  PENUMBRA modal label (1)
  fMapNSamples: 128,                  // Monte Carlo source samples (Route A only)
  fMapOcclusionBias: 0.04,            // depth tolerance preventing self-occlusion
                                      // from quantisation noise; normalised [0,1]
  fMapMarchSteps: 8,                  // intermediate depth-march steps per ray
  fMapCoarseMaxSide: 256,             // Route A hybrid: coarse-pass grid cap used only
                                      // to flag which pixels need exact full-res
                                      // refinement (see _computeFMapRouteAHybrid). The
                                      // final DIRECT/PENUMBRA/UMBRA boundary is always
                                      // computed exactly, never from this coarse pass.
  fresnelDerivedBlurRadiusPx: 12,     // box-blur radius (px) used to derive a Fresnel
                                      // density fallback from PenumbraAnalyzer's edgeMask
                                      // when no upstream fresnelKey artifact exists (see
                                      // _deriveFresnelDensityFromPenumbra). Overridden per-
                                      // frame by PenumbraAnalyzer's own mean penumbra width
                                      // when available.
  fMapRefineMargin: 0.05,             // extra margin around [umbraThresh, directThresh]
                                      // that still triggers exact refinement
  fMapRefineGradientThresh: 0.1,      // local |Δ| in upsampled coarse fMap that triggers
                                      // exact refinement even outside the threshold band
  fMapRefineDilatePx: 1,              // dilation radius (px) applied to the refine mask

  // Stage 1: DOA + modal decomposition
  doaKappaThreshold: 3.0,             // angular concentration (kappa) above which a
                                      // pixel is classified as point-like / direct;
                                      // empirical: 3.0 suits most indoor scenes

  // Stage 1: PenumbraAnalyzer
  penumbraProfileWindow: 17,          // crossing-strip width in pixels (forced odd, >= 5)
  penumbraBrightnessThresh: 0.75,     // fraction of frame-max brightness above which a
                                      // region is treated as a light-source blob
  penumbraMinEdgeGrad: 0.05,          // Sobel gradient magnitude required for an edge
                                      // pixel to be treated as a shadow boundary
  penumbraMinEdgeLength: 8,           // minimum connected-component length (pixels);
                                      // shorter components are rejected as texture noise
  penumbraMaxLights: 8,               // cap on tracked light-source blobs per frame
  penumbraMinFitR2: 0.6,              // minimum R² for logistic profile fit;
                                      // fits below this are discarded as noisy edges
  penumbraStabilityWeight: 0.6,       // blend weight: temporal stability vs brightness
                                      // when scoring light-source candidates (0..1)
  penumbraDebug: false,               // verbose PenumbraAnalyzer console logging

  // Stage 2: PackingSDF
  // All flags are also valid runtime overrides via flagsChanged BroadcastChannel event.
  enablePackingSDF:     true,           // set false to skip Stage 2 entirely
  packingUmbraPolicy:   'half-weight',  // 'half-weight' | 'include' | 'exclude'
                                        //   half-weight: SDF × 0.5 in UMBRA regions
                                        //   include:     no change
                                        //   exclude:     SDF → NaN (downstream skips)
  packingBandBase:      0.03,           // minimum narrow band width as fraction of
                                        // sdfRange (GPT latent heat lower bound)
  packingBandScale:     3.0,            // penumbraWidth × this = extra band width
  packingFalloffExp:    2.0,            // smooth fall-off exponent for narrow band mask
  packingSeedRMin:      0.01,           // minimum disk seed radius (normalised coords)
  packingSeedRMax:      0.08,           // maximum disk seed radius (normalised coords)
  packingMaxSeeds:      2048,           // MultiSampler ceiling across all modal partitions
  packingDensitySmooth: 4,              // box-blur radius for density map smoothing
  packingSamplerSeed:   0xF1E2D3C4,     // deterministic RNG seed (uint32 hex literal)
  packingDebug:         false,          // when true, persist medStressMap +
                                        // scaleneVariance as sdf_diagnostics artifact

    // ── Stage 3: Horn-Schunck optical flow ───────────────────────────────────
    enableOpticalFlow:     true,    // gate entire H-S pass (adds ~5–15ms GPU cost)
    opticalFlowAlpha:      1.0,      // smoothness weight α² [0.1, 10]
    opticalFlowIterations: 30,       // ping-pong passes    [10, 100]                                        

    // ── Stage 4A: topology analysis ──────────────────────────────────────────
    enablePrimeEnds:         true,
    // Fraction of the PackingSDF narrow band to retain for topology.
    // PackingSDF band is wide (penumbra-scaled); >20% coverage causes
    // pathological cycle counts. 0.25 keeps the tightest quartile.
    topoNarrowBandFraction:  0.25,
    enableLQE:               true,
    // Maximum side length (px) topology.worker downsamples to before running
    // PixelGraph/PrimeEnds/LQE. Lower = faster but less accurate topology.
    topoMaxResolution:       512,
    // Guard for background IDB persistence of topology artifacts.
    // false = skip entirely (normal path; data travels inline via topoInline).
    // true  = persist prime_ends, topology_map etc. for cold-start recovery.
    persistTopologyArtifacts: false,
    // When false (default): artifacts that already travel inline are NOT written
    // to IDB. Eliminates ~28MB of fire-and-forget writes per frame
    // (directional_field 16MB + flow_field 8MB + phi_min 4MB + KEM ~3MB)
    // that cause memory pressure and OOM under sustained load.
    // Set true only for crash-recovery testing or cold-start validation.
    persistInlineArtifacts:   false,
    // PixelGraph gradient fusion weights (must sum to 1.0)
    topoGradWeightDir:       0.6,    // directional field weight
    topoGradWeightKH:        0.3,    // |kH| curvature weight
    topoGradWeightCurl:      0.1,    // normal curl weight
    // Edge weight lambda
    topoLambda:              5.0,    // w = 1 + λ·gradMag
    // Cross-cut sampling budget
    topoBudgetS0:            30,     // base budget
    topoBudgetAlpha:         3.0,    // b1 multiplier
    topoBudgetBeta:          0.5,    // curvature peak multiplier
    topoBudgetSMax:          120,    // absolute cap
    // Topology thresholds
    topoNestThresh:          0.9,    // area ratio for nesting test
    topoAreaThresh:          0.2,    // max enclosed fraction (valid cut)
    topoVertexBiasGamma:     3.0,    // sampling weight boost near peaks
    topoCurvPeakSigmaFactor: 2.0,    // peak = mean + σ * factor
    topoMinEndAreaFrac:      0.005,  // min end area (fraction of narrow band)
    topoChainIoUThresh:      0.7,    // equivalence clustering IoU threshold
    // LQE parameters
    lqeQuantizationScale:    0.2,
    lqeNormThreshMin:        0.5,
    lqeNormThreshMax:        6.0,
    lqeMinSeedSize:          16,     // px
    lqeHysteresisMargin:     0.1,    // fraction of scale
    lqeMaxAspectRatio:       10.0,   // elongation filter
    lqeMaxEccentricity:      0.97,   // eccentricity filter
    lqeTrimmedMeanFrac:      0.05,   // per-end descriptor trimming

    // ── Stage 4B: constrained minimizer ──────────────────────────────────────
    minimizerMaxIter:        100,    // maximum PDE iterations
    minimizerTolArea:        0.02,   // area convergence tolerance (fraction)
    minimizerTolPhi:         0.005,  // phi convergence tolerance
    minimizerReinitFreq:     10,     // reinitialization every N iterations
    minimizerContactAlpha:   0.3,    // contact angle enforcement blend weight
    minimizerBandWidth:      6,      // narrow band initial width (pixels)
    minimizerDt:             null,   // PDE time step (null = auto: 0.2/resolution)

    /**
     * strictInlineOnlyWorkers: When true (default), Stage 6/7 workers (kem.worker,
     * correspondence.worker) never attempt the undefined storage-fallback branches
     * for inputs that should always arrive inline (flowFieldInline, warpFieldInline,
     * worldFrameMapInline, primeEndsInline, topologyMapInline, phiMinInline,
     * surfaceParamInline). Missing inline data degrades to null inputs with a
     * console.warn instead of throwing `ReferenceError: api is not defined`.
     *
     * Set false only after a real storageWrapper is wired into those branches.
     */
    strictInlineOnlyWorkers: true,

    // ── Stage 6: KEM ──────────────────────────────────────────────────────
  kemSplitThreshold:               2.0,   // KEM ratio above end-mean to split a clade
  kemEdgeAlignmentThresh:          0.3,   // dot-product threshold for leading/trailing
  viewManifoldKEMScale:          400.0,   // feature vector normalisation for meanKEM

  // ── Stage 7: Correspondence ───────────────────────────────────────────
  symmetryAxisFallbackVertical:    true,  // vertical axis when covariance is degenerate
  correspondenceConfidenceSigma:   0.1,   // sigma for nearest-valid confidence decay
  correspondenceMinConfidence:     0.1,   // pixels below this are marked unmatched
  symmetryMismatchAlpha:           0.5,   // weight of geometricAsymmetry in combined score
  symmetryMismatchBeta:            0.5,   // weight of (1-reconstructionConsistency)

  // ── Stage 5: AmbiAnamorph ─────────────────────────────────────────────
  // Surface parameterisation
  ambiRBins:                       64,     // radial quantisation bins for worldFrameId hash
  ambiThetaBins:                   128,    // angular quantisation bins for worldFrameId hash
  ambiSeamBlend:                   true,   // blend θ at end-boundary seams in SurfaceParam

  // WorldFrameId session lock
  structureIdLockThreshold:        5,      // consecutive mismatches before accepting new structureId
  ambiFrameRate:                   30,     // fps for LQE speed → pixel displacement conversion

  // View manifold
  viewManifoldCompatibilityThresh: 0.85,   // cosine similarity threshold for edge creation

  // Integration weight exponents (must sum to 1.0)
  ambiCoherenceExponent:           0.4,    // α — temporal stability weight
  ambiFMapExponent:                0.3,    // β — illumination directness weight
  ambiGeomConfExponent:            0.2,    // γ — geometric convergence weight
  ambiTopoStabExponent:            0.1,    // δ — topological stability weight

  // Legibility score
  ambiLegibilityWeightThresh:      0.1,    // minimum weight for coverage fraction count

  // Debug
  ambiDebug:                       false,  // emit ambi_anamorph_telemetry artifact (expensive: disable in production)

  // Pipeline phase control (NEW)
  // enablePreprocessAnnotate: allow preprocessors to annotate manifests / metadata
  // enablePreprocessQuantize: allow preprocessors to emit quantized/solver-ready artifacts (SOC/A,b)
  // enableReconstructionSolve: allow heavy backend/solver runs (future worker)
  enablePreprocessAnnotate: true,
  enablePreprocessQuantize: true,
  enableReconstructionSolve: false,

  // Overhang behavior control (NEW: policy vs compute)
  // 'off' -> skip overhang entirely
  // 'annotate' -> detect + annotate only (lightweight)
  // 'constraints' -> emit solver-ready constraints (A, b, SOCs)
  overhangPolicyMode: 'annotate',

  // Flux / Poynting-proxy related
  enableFlux: false,
  fluxMode: 'coarse',
  fluxComputeResolutionDivisor: 8,
  fluxQuantization: 'float16',
  fluxFlowMethod: 'pyrLK',
  fluxAlpha: 1.0,
  fluxBeta: 0.5,
  fluxGamma: 0.3,
  fluxSmoothingSpatialSigma: 1.0,
  fluxSmoothingTemporalWindow: 3,
  fluxFTLEIntegrationSteps: 5,
  fluxVortexThresholdStdMult: 2.0,
  fluxSampleRateWorld: 8,
  fluxDiagnosticsEnabled: false,
  fluxTelemetryEnabled: false,
  fluxPersistFullResOnDemand: true,
  fluxWorkerCount: 1,

  // Triangle / depth / overhang related
  enableOverhang: true,
  overhangCosineThresh: 0.7,
  overhangWindingThresh: 0.25,
  overhangMinGroupSize: 3,
  gravity: [0, -1, 0],                // ✅ NEW: Gravity vector for overhang detection
  depthKL: 1.0,
  depthKD: 0.5,
  depthBase: 0.1,
  depthScale: 2.0,

  // Selector / BSS tuning (new)
  bssPersistSelector: false,
  bssPullEta: 0.1,
  bssPushEta: 0.05,
  bssGamma: 1.02,
  bssIters: 8,

  // Heartbeat / recon / safety (new)
  reconTakeoverMs: 600000,           // 10 minutes
  reconBackoffOnFailMs: 300000,      // 5 minutes
  heartbeatIntervalMs: 20000,        // 20s
  maxWorkerMemoryBytes: 1 << 28,     // ~268MB safety cap
  enableDepthFallbackOnWebGLFail: true,
  reconTelemetryEnabled: true,

  // Topology tuning
  topologyPersistenceThreshold: 0.05,
  topologyLcsThresholdPct: 0.05,
  topologyUseFluxAsFiltration: false,
  topologyComputeOnDemand: true,

  // HFH (Hybrid Fresnel Harvester) controls (NEW)
  enableHFH: true,
  // When an annular-derived score exceeds this (0..1) HFH can route heavy paths
  hfhHeavyPathThreshold: 0.00,
  // Per-camera HFH cooldown (ms)
  hfhCooldownMs: 30000,
  // If true, HFH will only annotate during eviction; otherwise eviction may escalate
  hfhAnnotateOnlyDuringEviction: true,
  // Who decides escalation: 'worker' (motion.worker) or 'eviction' (frame-eviction hook)
  hfhDecisionAuthority: 'worker',

  // ── Storage layer controls (NEW) ─────────────────────────────────────────
  /**
   * storageEvictorAuthority: Which execution context may run the periodic
   * IndexedDB evictor loop (storage.js startEvictorLoop). Multiple contexts
   * each calling initStorage({startEvictor:true}) with different quota values
   * (main.js=2GB, preprocessor.worker=500MB, others default 1GB) produces
   * uncoordinated evictors racing on the same IDB counters.
   *
   * 'main' — only main.js starts/stops the evictor (recommended)
   * 'none' — no periodic evictor anywhere; eviction only via checkQuotaAndEvict
   *          triggered directly by critical-pressure writes
   *
   * Worker contexts must check this flag before passing startEvictor:true.
   */
  storageEvictorAuthority: 'main',

  /**
   * storageQuotaCheckOnWrite: putInboundArtifact currently opens an extra
   * readonly transaction after EVERY write to log/decide eviction scheduling.
   * This duplicates the periodic evictor and is the source of the
   * "NORMAL quota pressure" log spam on every frame. Default false — routine
   * maintenance is left to the periodic evictor loop; only critical-pressure
   * writes (>storageCriticalQuotaThreshold) should still check inline.
   */
  storageQuotaCheckOnWrite: false,
  storageHighQuotaThreshold: 0.85,
  storageCriticalQuotaThreshold: 0.95,

  /**
   * exposeLegacyPinRefApi: Controls whether storage.js attaches the legacy
   * pinRef/unpinRef/getPinRef counter functions to the exported storageAPI.
   * They write a `.value` field to the same `pinref:<key>` counter record that
   * the modern pinArtifact/unpinArtifact system writes as `.count` — using both
   * on the same key silently corrupts refcounting. Default false; use
   * pinArtifact/unpinArtifact/getPinRefCount instead.
   */
  exposeLegacyPinRefApi: false,

  /**
   * reconStatusMaxAgeMs / reconStatusCleanupIntervalMs: govern periodic pruning
   * of the reconStatus IndexedDB store via storage.clearOldReconStatus(). This
   * function exists but is currently never invoked anywhere — done/failed
   * records accumulate forever. main.js's existing reaper timer should call it
   * every reconStatusCleanupIntervalMs.
   */
  reconStatusMaxAgeMs: 604800000,        // 7 days
  reconStatusCleanupIntervalMs: 3600000, // 1 hour

  /**
   * enableWorkerAdvisoryTTLTimers: When true (legacy default), producer workers
   * (motion.worker, preprocessor.worker) schedule an additional JS-side
   * setTimeout per pinned artifact, duplicating the authoritative storage-level
   * pin TTL. At sustained frame rates this is 3+ live timers per frame for zero
   * correctness benefit — storage-level TTL (pinArtifact ttlMs + getPins()
   * expiry filtering) is already sufficient. Set false to eliminate the timer churn.
   */
  enableWorkerAdvisoryTTLTimers: false,

  /**
   * storageQuotaBytes: Single shared IndexedDB budget (bytes) used by whichever
   * context holds storageEvictorAuthority. Previously hardcoded inconsistently —
   * preprocessor.worker.js used 500MB while main.js used 2GB — against the SAME
   * physical IndexedDB totalBytes counter (storage.js module state is per-context,
   * but the underlying IDB data is shared). This guaranteed permanent "CRITICAL
   * quota pressure" (observed: 305%, 1525MB/500MB) once the full pipeline's
   * legitimate working set exceeded the smallest configured ceiling — the data
   * wasn't leaked, it was just being judged against the wrong number. All
   * initStorage({quota}) call sites should read this value instead of hardcoding
   * their own.
   */
  storageQuotaBytes: 2 * 1024 * 1024 * 1024, // 2GB — sized for the full pipeline, not one stage

  /**
   * storageCriticalPinOverrideMs: Under sustained CRITICAL quota pressure
   * (> storageCriticalQuotaThreshold), soft-pinned artifacts older than this
   * age (ms) become eligible for forced eviction even if their TTL has not
   * expired yet. Without this, eviction has no escape valve: a live multi-stage
   * pipeline keeps nearly everything soft-pinned at all times, so critical
   * pressure can persist indefinitely, with each pass reclaiming only scraps
   * (already-expired pins) while re-logging "CRITICAL quota pressure" and adding
   * IDB transaction contention every cycle. HARD pins (e.g. calibration.meta)
   * are never subject to this override — only soft pins age out early.
   */
  storageCriticalPinOverrideMs: 30000, // 30s grace period, only under sustained critical pressure

  /**
   * calibrationRequestTimeoutMs: Timeout for PreprocessorWorker.requestCalibration's
   * wrapper promise (previously hardcoded to 120000 in PreprocessorWorker.js).
   * On timeout, the wrapper promise rejects and removes its message listener,
   * but — without calibrationAbortOnTimeout — the worker-side computation keeps
   * running to completion and still persists 4 soft-pinned artifacts plus a
   * HARD-pinned (never auto-expiring) calibration.meta, orphaned because nothing
   * calls invalidateCalibration() on a request the caller already gave up on.
   * Raised default from 120s to 180s to tolerate transient IDB contention while
   * the underlying quota/eviction fixes take effect.
   */
  calibrationRequestTimeoutMs: 180000,

  /**
   * calibrationAbortOnTimeout: When true, a timed-out requestCalibration() call
   * posts an explicit abort message to preprocessor.worker so any in-flight (or
   * just-completed) calibration artifacts — including the hard-pinned meta — are
   * unpinned and cleaned up immediately instead of being silently orphaned,
   * preventing them from accumulating across repeated failed attempts.
   */
  calibrationAbortOnTimeout: true,

  /**
   * pauseFrameIngestDuringCalibration: While a calibration computation is in
   * flight (CALIB.busy === true), ordinary per-frame processing (thumbnail +
   * phash + manifest persistence) competes with calibration's own writes for
   * the same IndexedDB readwrite lock on [artifacts, counters, pins]. At any
   * sustained frame rate this can starve calibration's sequential persist
   * calls indefinitely — not a crash, just permanent queue starvation that
   * eventually trips calibrationRequestTimeoutMs regardless of its value.
   * When true, incoming frames are queued (not dropped) during calibration
   * and drained immediately once it completes, succeeds, fails, or aborts.
   */
  pauseFrameIngestDuringCalibration: true,

  /**
   * calibrationDeferredFrameQueueMaxSize: Ceiling on frames queued while
   * pauseFrameIngestDuringCalibration is active. Oldest frames are dropped
   * (bitmap closed) past this limit to bound memory during a slow/starved
   * calibration rather than growing unbounded.
   */
  calibrationDeferredFrameQueueMaxSize: 60,

  // Safety / scaffolding
  featureFlagsVersion: FEATURE_FLAGS_VERSION
};

// ------------------------ Internal state ------------------------
let _inMemoryFallback = null; // fallback if localStorage not available
let _flags = null;            // will be initialized synchronously in init()
const _subs = new Set();      // subscribers
const _keySubs = new Map();   // key -> Set(subscribers)

// BroadcastChannel registry and handlers
let _bc = null;
const _bcHandlers = new Map();       // originalHandler -> wrappedListener
const _pendingBcRegistrations = new Set(); // originals queued while bc is null

// persistence availability (turned off when quota exceeded)
let _persistenceAvailable = true;

/* ------------------------ Utilities ------------------------ */

function deepClone(o) {
  try {
    return JSON.parse(JSON.stringify(o));
  } catch (e) {
    // fallback shallow clone
    if (typeof o === 'object' && o !== null) return Object.assign({}, o);
    return o;
  }
}

function _hasLocalStorage() {
  try {
    if (typeof localStorage === 'undefined') return false;
    const probe = `${STORAGE_KEY}:probe`;
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * clamp(x, a, b)
 * Small helper used for coercion/range-clamping in _coerceOrWarn.
 */
function clamp(x, a, b) {
  if (typeof x !== 'number' || Number.isNaN(x)) return a;
  return Math.max(a, Math.min(b, x));
}

/* ------------------------ Sequence management ------------------------ */
/**
 * Maintain a monotonic-ish __seq that monotonically increases and resists 32-bit wrap.
 * Uses Date.now() as a seed to avoid small wrap problems and ensure forward progress.
 */
function _ensureSeqObject(obj) {
  if (!obj) return;
  if (typeof obj.__seq !== 'number') {
    obj.__seq = Date.now() & 0x7fffffff;
  }
}

function _bumpSeq() {
  // Ensure _flags exists
  if (!_flags) return;
  const now = Date.now() & 0x7fffffff;
  if (typeof _flags.__seq !== 'number') {
    _flags.__seq = now;
    return;
  }
  // next as unsigned-like increment (>>>0 for numeric behavior)
  const cand = (_flags.__seq + 1) >>> 0;
  // detect wrap or non-increasing; reseed from timestamp if needed
  if (cand <= _flags.__seq) {
    _flags.__seq = now;
  } else {
    _flags.__seq = Math.max(cand, now);
  }
}

/* ------------------------ Persistence helpers ------------------------ */

function _readFlagsFromStorage() {
  try {
    if (_hasLocalStorage()) {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        const initial = Object.assign({}, DEFAULTS);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(initial)); } catch (e) { /* best-effort */ }
        _inMemoryFallback = initial;
        const copy = deepClone(initial);
        _ensureSeqObject(copy);
        return copy;
      }
      const parsed = JSON.parse(raw || '{}') || {};
      const merged = Object.assign({}, DEFAULTS, parsed);
      if (!('featureFlagsVersion' in merged)) merged.featureFlagsVersion = FEATURE_FLAGS_VERSION;

      // When the flags version in localStorage is older than the current version,
      // any flags that are NEW in this version (didn't exist in localStorage before)
      // are correct because DEFAULTS wins for missing keys. But flags that existed
      // before with a different default need to be explicitly reset to DEFAULTS,
      // otherwise the old localStorage value permanently overrides the new default.
      // List here any flag whose default changed between versions:
      const RESET_ON_VERSION_BUMP = [
        'enableOpticalFlow'   // added in v2 as true; any stale false must be cleared
      ];
      if ((parsed.featureFlagsVersion ?? 0) < FEATURE_FLAGS_VERSION) {
        RESET_ON_VERSION_BUMP.forEach(key => {
          merged[key] = DEFAULTS[key];
        });
        merged.featureFlagsVersion = FEATURE_FLAGS_VERSION;
        console.log('[featureFlags] version bump detected — reset:', RESET_ON_VERSION_BUMP);
      }

      _ensureSeqObject(merged);
      _inMemoryFallback = merged;
      return deepClone(merged);
    } else {
      if (!_inMemoryFallback) _inMemoryFallback = Object.assign({}, DEFAULTS);
      const copy = deepClone(_inMemoryFallback);
      _ensureSeqObject(copy);
      return copy;
    }
  } catch (err) {
    console.warn('[featureFlags] read error', err);
    if (!_inMemoryFallback) _inMemoryFallback = Object.assign({}, DEFAULTS);
    const copy = deepClone(_inMemoryFallback);
    _ensureSeqObject(copy);
    return copy;
  }
}

function _writeFlagsToStorage(obj) {
  try {
    // Ensure __seq present and bumped before writing
    _ensureSeqObject(obj);
    // write to persistent storage if available
    const toStore = Object.assign({}, obj);
    if (_hasLocalStorage() && _persistenceAvailable) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
    } else {
      // fallback
      _inMemoryFallback = toStore;
    }
  } catch (err) {
    // detect quota exceeded / storage errors
    const isQuota = err && (err.name === 'QuotaExceededError' || err.code === 22 || /quota/i.test(String(err)));
    console.warn('[featureFlags] write error', err);
    if (isQuota) {
      _persistenceAvailable = false;
      console.warn('[featureFlags] localStorage quota exceeded - persistence disabled; using in-memory fallback');
      // notify subscribers that persistence was disabled
      try {
        _postUpdateEvent({ persistenceDisabled: true });
        _broadcastFlags({ persistenceDisabled: true });
      } catch (e) {}
    }
    _inMemoryFallback = Object.assign({}, obj);
  }
}

/* ------------------------ BroadcastChannel management ------------------------ */

/**
 * Create or re-initialize BroadcastChannel if possible.
 * Attach any pending handler registrations.
 */
function _initBroadcastChannel() {
  try {
    if (typeof BroadcastChannel === 'undefined') {
      _bc = null;
      return;
    }
    if (_bc && typeof _bc.close === 'function') {
      // keep existing if already created (do not re-create)
      return;
    }
    _bc = new BroadcastChannel(BC_CHANNEL);
    // attach any previously registered handlers (wrapped)
    _attachAllBcHandlers();
  } catch (err) {
    _bc = null;
    console.warn('[featureFlags] BroadcastChannel init failed', err);
  }
}

/**
 * Attach all stored handlers (in _bcHandlers and any pending) to the current _bc.
 */
function _attachAllBcHandlers() {
  if (!_bc) return;
  // Attach pending originals (if any)
  _pendingBcRegistrations.forEach(orig => {
    try {
      if (_bcHandlers.has(orig)) return; // already wrapped/attached
      const wrapped = (ev) => {
        try { orig(ev.data); } catch (e) { console.warn('[featureFlags] broadcast handler error', e); }
      };
      _bcHandlers.set(orig, wrapped);
      _bc.addEventListener('message', wrapped);
    } catch (e) {
      console.warn('[featureFlags] attach handler failed', e);
    }
  });
  _pendingBcRegistrations.clear();

  // For any pre-registered handlers that exist in _bcHandlers but were not attached yet,
  // ensure they are attached.
  _bcHandlers.forEach((wrapped, orig) => {
    try {
      // For safety, try remove then add (idempotent)
      try { _bc.removeEventListener('message', wrapped); } catch (_) {}
      _bc.addEventListener('message', wrapped);
    } catch (e) {
      console.warn('[featureFlags] attach existing handler failed', e);
    }
  });
}

/**
 * Detach all wrapped handlers from the given channel (used during replace).
 */
function _detachAllFromChannel(channel) {
  if (!channel) return;
  _bcHandlers.forEach((wrapped) => {
    try {
      channel.removeEventListener('message', wrapped);
    } catch (e) {
      // ignore
    }
  });
}

/* ------------------------ Notification helpers ------------------------ */

function _postUpdateEvent(detail = {}) {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      const ev = new CustomEvent('motionPainter:flagsChanged', { detail });
      window.dispatchEvent(ev);
    }
  } catch (e) {
    // ignore
  }
}

function _broadcastFlags(detail = {}) {
  try {
    if (_bc) {
      _bc.postMessage(Object.assign({ event: 'flagsChanged', flags: getFlags() }, detail));
    }
  } catch (e) {
    // ignore
  }
}

function _notifyLocalSubscribers(payload = {}) {
  // general subscribers
  _subs.forEach(fn => {
    try { fn(payload); } catch (e) { console.warn('[featureFlags] subscriber error', e); }
  });

  // key-specific subscribers
  if (payload && payload.key) {
    const set = _keySubs.get(payload.key);
    if (set) {
      set.forEach(fn => {
        try { fn(payload); } catch (e) { console.warn('[featureFlags] key-subscriber error', e); }
      });
    }
  }
}

/* ------------------------ Validation ------------------------ */

const _RESERVED_PREFIX = '_';
const _RESERVED_KEYS = new Set(['__seq', 'featureFlagsVersion']);

function _assertNotReservedKey(key) {
  if (typeof key !== 'string') throw new Error('featureFlags: key must be a string');
  if (key.startsWith(_RESERVED_PREFIX) || _RESERVED_KEYS.has(key)) {
    throw new Error(`featureFlags: attempt to set reserved key "${key}"`);
  }
}

/**
 * If the key exists in DEFAULTS, try to coerce simple types and warn on mismatch.
 * This is tolerant by default (warn + coerce), not strict.
 */
function _coerceOrWarn(key, value) {
  if (key in DEFAULTS) {
    const expectedType = typeof DEFAULTS[key];
    if (expectedType !== typeof value) {
      // simple coercions
      if (expectedType === 'boolean') {
        if (value === 'true' || value === '1') return true;
        if (value === 'false' || value === '0') return false;
      } else if (expectedType === 'number') {
        const n = Number(value);
        if (!Number.isNaN(n)) return n;
      }
      console.warn(`[featureFlags] type mismatch for ${key}: expected ${expectedType} got ${typeof value}`);
    }
  }

  // Lightweight domain/range clamping and extra numeric coercions for newly introduced flags.
  try {
    // Timeouts / ms values: ensure minimum 1s
    if (key === 'reconTakeoverMs' || key === 'reconBackoffOnFailMs' || key === 'heartbeatIntervalMs' || key === 'hfhCooldownMs') {
      const n = Number(value);
      if (Number.isFinite(n)) {
        return Math.max(1000, Math.floor(n));
      }
      return DEFAULTS[key];
    }

    if (key === 'maxWorkerMemoryBytes') {
      const n = Number(value);
      if (Number.isFinite(n)) {
        // minimum 1MB
        return Math.max(1 << 20, Math.floor(n));
      }
      return DEFAULTS.maxWorkerMemoryBytes;
    }

    if (key === 'exposeLegacyPinRefApi' || key === 'enableWorkerAdvisoryTTLTimers') {
      if (value === 'true' || value === true) return true;
      if (value === 'false' || value === false) return false;
      return DEFAULTS[key];
    }

    if (key === 'reconStatusMaxAgeMs' || key === 'reconStatusCleanupIntervalMs') {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return Math.max(60000, Math.floor(n)); // min 1 minute
      return DEFAULTS[key];
    }

    if (key === 'storageQuotaBytes') {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return Math.max(64 * 1024 * 1024, Math.floor(n)); // min 64MB
      return DEFAULTS.storageQuotaBytes;
    }

    if (key === 'storageCriticalPinOverrideMs') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) return Math.floor(n);
      return DEFAULTS.storageCriticalPinOverrideMs;
    }

    if (key === 'calibrationRequestTimeoutMs') {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return Math.max(10000, Math.floor(n)); // min 10s
      return DEFAULTS.calibrationRequestTimeoutMs;
    }

    if (key === 'calibrationAbortOnTimeout') {
      if (value === 'true' || value === true) return true;
      if (value === 'false' || value === false) return false;
      return DEFAULTS.calibrationAbortOnTimeout;
    }

    if (key === 'pauseFrameIngestDuringCalibration') {
      if (value === 'true' || value === true) return true;
      if (value === 'false' || value === false) return false;
      return DEFAULTS.pauseFrameIngestDuringCalibration;
    }

    if (key === 'calibrationDeferredFrameQueueMaxSize') {
      const n = Math.floor(Number(value));
      if (Number.isFinite(n) && n > 0) return Math.min(500, n);
      return DEFAULTS.calibrationDeferredFrameQueueMaxSize;
    }

    if (key === 'overhangCosineThresh') {
      const n = Number(value);
      if (Number.isFinite(n)) return clamp(n, 0.0, 1.0);
      return DEFAULTS.overhangCosineThresh;
    }

    if (key === 'storageQuotaCheckOnWrite') {
      if (value === 'true' || value === true) return true;
      if (value === 'false' || value === false) return false;
      return DEFAULTS.storageQuotaCheckOnWrite;
    }

    if (key === 'storageHighQuotaThreshold' || key === 'storageCriticalQuotaThreshold') {
      const n = Number(value);
      if (Number.isFinite(n)) return clamp(n, 0.5, 0.999);
      return DEFAULTS[key];
    }

    if (['depthKL', 'depthKD', 'depthBase', 'depthScale'].includes(key)) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
      return DEFAULTS[key];
    }

    if (['bssPullEta','bssPushEta','bssGamma'].includes(key)) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
      return DEFAULTS[key];
    }

    // ✅ NEW: Bump/normal/specular scales (0+, no upper limit)
    if (['bumpScale', 'normalScale', 'specularHpGain', 'specularChromaScale'].includes(key)) {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) return n;
      return DEFAULTS[key];
    }

    // ✅ NEW: Alpha/threshold values (0..1)
    if (['specularAlpha', 'specularThreshold'].includes(key)) {
      const n = Number(value);
      if (Number.isFinite(n)) return clamp(n, 0.0, 1.0);
      return DEFAULTS[key];
    }

    // ✅ NEW: DirectionalLifting buffer size (positive integer or null)
    if (key === 'dirLiftBufferSize') {
      if (value === null || value === 'null') return null;
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
      return DEFAULTS.dirLiftBufferSize;
    }

    if (key === 'dirLiftMaxBufferMB') {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return Math.max(1, Math.floor(n));
      return DEFAULTS.dirLiftMaxBufferMB;
    }

    // ✅ NEW: Gravity vector (array of 3 numbers)
    if (key === 'gravity') {
      if (Array.isArray(value) && value.length === 3) {
        const [x, y, z] = value.map(Number);
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
          return [x, y, z];
        }
      }
      return DEFAULTS.gravity;
    }

    // ✅ NEW: Debug flags (boolean)
    if (['calibDebug', 'tetraDebug', 'dirLiftDebug', 'heartbeatDebug', 'gpuContextDebug'].includes(key)) {
      if (value === 'true' || value === true) return true;
      if (value === 'false' || value === false) return false;
      return DEFAULTS[key];
    }

    // ============================================================================
    // ✅ NEW: Artifact persistence flags (boolean)
    // ============================================================================
    if (['persistIntermediates', 'persistDebugArtifacts', 'MOTION_UNPIN_ON_CLAIM',
         'persistInlineArtifacts', 'enableLegacyFluxManifest'].includes(key)) {
      if (value === 'true' || value === true) return true;
      if (value === 'false' || value === false) return false;
      return DEFAULTS[key];
    }

    // ✅ NEW: Pipeline toggles (boolean)
    if (['enableTetrachromacy', 'enableDirectionalLifting', 'bumpFusionMode'].includes(key)) {
      if (value === 'true' || value === true) return true;
      if (value === 'false' || value === false) return false;
      return DEFAULTS[key];
    }

    // ── Stage 1: f_map ────────────────────────────────────────────────────────

    // Boolean toggles
    if (['enableFMapRouteA', 'fMapDebug'].includes(key)) {
      if (value === 'true'  || value === true)  return true;
      if (value === 'false' || value === false) return false;
      return DEFAULTS[key];
    }

    // Threshold pair: both clamped to [0, 1].
    // Keeping direct > umbra is the caller's responsibility.
    if (key === 'fMapDirectThresh' || key === 'fMapUmbraThresh') {
      const n = Number(value);
      if (Number.isFinite(n)) return clamp(n, 0.0, 1.0);
      return DEFAULTS[key];
    }

    // Positive integer: Monte Carlo sample count, clamped [8, 512]
    if (key === 'fMapNSamples') {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return Math.max(8, Math.min(512, Math.floor(n)));
      return DEFAULTS.fMapNSamples;
    }

    // Small positive float: depth-march occlusion bias, clamped [0, 0.5]
    if (key === 'fMapOcclusionBias') {
      const n = Number(value);
      if (Number.isFinite(n)) return clamp(n, 0.0, 0.5);
      return DEFAULTS.fMapOcclusionBias;
    }

    // Positive integer: depth-march step count, clamped [2, 64]
    if (key === 'fMapMarchSteps') {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return Math.max(2, Math.min(64, Math.floor(n)));
      return DEFAULTS.fMapMarchSteps;
    }

    // ── Stage 1: DOA ──────────────────────────────────────────────────────────

    // Positive float: kappa separation threshold; typical range 1–10, no upper bound
    if (key === 'doaKappaThreshold') {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return n;
      return DEFAULTS.doaKappaThreshold;
    }

    // ── Stage 1: PenumbraAnalyzer ─────────────────────────────────────────────

    // Boolean debug toggle
    if (key === 'penumbraDebug') {
      if (value === 'true'  || value === true)  return true;
      if (value === 'false' || value === false) return false;
      return DEFAULTS.penumbraDebug;
    }

    // Odd positive integer >= 5: profile crossing-strip width (forced odd)
    if (key === 'penumbraProfileWindow') {
      const n = Math.floor(Number(value));
      if (Number.isFinite(n) && n >= 5) return (n % 2 === 0) ? n + 1 : n;
      return DEFAULTS.penumbraProfileWindow;
    }

    // [0, 1] floats
    if (['penumbraBrightnessThresh', 'penumbraMinEdgeGrad',
         'penumbraMinFitR2', 'penumbraStabilityWeight'].includes(key)) {
      const n = Number(value);
      if (Number.isFinite(n)) return clamp(n, 0.0, 1.0);
      return DEFAULTS[key];
    }

    // Positive integer: minimum edge component length (>= 2)
    if (key === 'penumbraMinEdgeLength') {
      const n = Math.floor(Number(value));
      if (Number.isFinite(n) && n >= 2) return n;
      return DEFAULTS.penumbraMinEdgeLength;
    }

    // Positive integer: max tracked light blobs, clamped [1, 32]
    if (key === 'penumbraMaxLights') {
      const n = Math.floor(Number(value));
      if (Number.isFinite(n) && n > 0) return Math.max(1, Math.min(32, n));
      return DEFAULTS.penumbraMaxLights;
    }

    // ── Stage 2: PackingSDF ───────────────────────────────────────────────────

    // Boolean toggle: skip Stage 2 entirely
    if (key === 'enablePackingSDF') {
      if (value === 'true'  || value === true)  return true;
      if (value === 'false' || value === false) return false;
      return DEFAULTS.enablePackingSDF;
    }

    // Enum: umbra handling policy — only three legal values
    if (key === 'packingUmbraPolicy') {
      if (typeof value === 'string') {
        const v = value.toLowerCase();
        if (v === 'half-weight' || v === 'include' || v === 'exclude') return v;
      }
      console.warn(`[featureFlags] invalid packingUmbraPolicy "${value}", falling back to "${DEFAULTS.packingUmbraPolicy}"`);
      return DEFAULTS.packingUmbraPolicy;
    }

    // Small positive float: narrow band base width, fraction of sdfRange, [0.001, 0.5]
    if (key === 'packingBandBase') {
      const n = Number(value);
      if (Number.isFinite(n)) return clamp(n, 0.001, 0.5);
      return DEFAULTS.packingBandBase;
    }

    // Positive float: penumbra width multiplier, [0.1, 20]
    if (key === 'packingBandScale') {
      const n = Number(value);
      if (Number.isFinite(n)) return clamp(n, 0.1, 20);
      return DEFAULTS.packingBandScale;
    }

    // Positive float: fall-off exponent, [0.5, 6]
    if (key === 'packingFalloffExp') {
      const n = Number(value);
      if (Number.isFinite(n)) return clamp(n, 0.5, 6);
      return DEFAULTS.packingFalloffExp;
    }

    // Small positive float: minimum seed radius (normalised), [0.001, 0.5]
    if (key === 'packingSeedRMin') {
      const n = Number(value);
      if (Number.isFinite(n)) return clamp(n, 0.001, 0.5);
      return DEFAULTS.packingSeedRMin;
    }

    // Small positive float: maximum seed radius (normalised), [0.01, 1.0]
    // Also enforce rMax >= rMin silently (rMin is read at compute time, not here,
    // so we just keep within the absolute range and let PackingSDF warn if inverted).
    if (key === 'packingSeedRMax') {
      const n = Number(value);
      if (Number.isFinite(n)) return clamp(n, 0.01, 1.0);
      return DEFAULTS.packingSeedRMax;
    }

    // Positive integer: MultiSampler ceiling, [64, 8192]
    if (key === 'packingMaxSeeds') {
      const n = Math.floor(Number(value));
      if (Number.isFinite(n) && n > 0) return Math.max(64, Math.min(8192, n));
      return DEFAULTS.packingMaxSeeds;
    }

    // Positive integer: box-blur radius, [1, 32]
    if (key === 'packingDensitySmooth') {
      const n = Math.floor(Number(value));
      if (Number.isFinite(n) && n > 0) return Math.max(1, Math.min(32, n));
      return DEFAULTS.packingDensitySmooth;
    }

    // Unsigned 32-bit integer: deterministic RNG seed
    // Accepts numeric literal or hex string e.g. '0xF1E2D3C4'
    if (key === 'packingSamplerSeed') {
      const n = typeof value === 'string' ? parseInt(value, 16) || Number(value) : Number(value);
      if (Number.isFinite(n) && n >= 0) return (n >>> 0); // coerce to uint32
      return DEFAULTS.packingSamplerSeed;
    }

    // Boolean toggle: persist diagnostic artifacts
    if (key === 'packingDebug') {
      if (value === 'true'  || value === true)  return true;
      if (value === 'false' || value === false) return false;
      return DEFAULTS.packingDebug;
    }

    // ── Stage 3: Horn-Schunck optical flow ───────────────────────────────────

    // Boolean toggle: gate entire H-S pass
    if (key === 'enableOpticalFlow') {
      if (value === 'true'  || value === true)  return true;
      if (value === 'false' || value === false) return false;
      return DEFAULTS.enableOpticalFlow;
    }

    // Positive float: smoothness weight α², clamped [0.1, 10]
    if (key === 'opticalFlowAlpha') {
      const n = parseFloat(value);
      if (!Number.isFinite(n)) {
        console.warn(`[featureFlags] opticalFlowAlpha invalid (${value}), using default 1.0`);
        return DEFAULTS.opticalFlowAlpha;
      }
      return clamp(n, 0.1, 10);
    }

    // Positive integer: ping-pong pass count, clamped [10, 100]
    if (key === 'opticalFlowIterations') {
      const n = Math.floor(Number(value));
      if (!Number.isFinite(n)) {
        console.warn(`[featureFlags] opticalFlowIterations invalid (${value}), using default 30`);
        return DEFAULTS.opticalFlowIterations;
      }
      return Math.max(10, Math.min(100, n));
    }

    // ── Stage 4A ──────────────────────────────────────────────────────────────
    if (key === 'enablePrimeEnds' || key === 'enableLQE') {
      return typeof value === 'string' ? value === 'true' : !!value;
    }

    if (key === 'topoMaxResolution') {
      const n = Math.floor(Number(value));
      if (Number.isFinite(n) && n >= 64) return Math.min(2048, n);
      return DEFAULTS.topoMaxResolution;
    }

    if (key === 'persistTopologyArtifacts') {
      if (value === 'true'  || value === true)  return true;
      if (value === 'false' || value === false) return false;
      return DEFAULTS.persistTopologyArtifacts;
    }

    // ── Stage 4B ──────────────────────────────────────────────────────────────
    if (key === 'minimizerMaxIter') {
      const n = Math.floor(Number(value));
      if (Number.isFinite(n) && n >= 1) return Math.min(2000, n);
      return DEFAULTS.minimizerMaxIter;
    }

    if (key === 'minimizerTolArea' || key === 'minimizerTolPhi') {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return clamp(n, 1e-6, 1.0);
      return DEFAULTS[key];
    }

    if (key === 'minimizerReinitFreq') {
      const n = Math.floor(Number(value));
      if (Number.isFinite(n) && n >= 1) return Math.min(100, n);
      return DEFAULTS.minimizerReinitFreq;
    }

    if (key === 'minimizerContactAlpha') {
      const n = Number(value);
      if (Number.isFinite(n)) return clamp(n, 0.0, 1.0);
      return DEFAULTS.minimizerContactAlpha;
    }

    if (key === 'minimizerBandWidth') {
      const n = Math.floor(Number(value));
      if (Number.isFinite(n) && n >= 1) return Math.min(64, n);
      return DEFAULTS.minimizerBandWidth;
    }

    if (key === 'minimizerDt') {
      if (value === null || value === 'null') return null;
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return n;
      return DEFAULTS.minimizerDt;
    }

    if (key === 'ambiDebug') {
      if (value === 'true'  || value === true)  return true;
      if (value === 'false' || value === false) return false;
      return DEFAULTS.ambiDebug;
    }

    if (key === 'strictInlineOnlyWorkers') {
      if (value === 'true'  || value === true)  return true;
      if (value === 'false' || value === false) return false;
      return DEFAULTS.strictInlineOnlyWorkers;
    }

    if ([
      'topoLambda',
      'topoGradWeightDir',
      'topoGradWeightKH',
      'topoGradWeightCurl',
      'topoNestThresh',
      'topoAreaThresh',
      'topoVertexBiasGamma',
      'topoCurvPeakSigmaFactor',
      'topoMinEndAreaFrac',
      'topoChainIoUThresh',
      'lqeQuantizationScale',
      'lqeNormThreshMin',
      'lqeNormThreshMax',
      'lqeHysteresisMargin',
      'lqeMaxAspectRatio',
      'lqeMaxEccentricity',
      'lqeTrimmedMeanFrac'
    ].includes(key)) {
      const n = parseFloat(value);
      if (!Number.isFinite(n)) {
        console.warn(`[featureFlags] ${key} invalid (${value}), using default`);
        return DEFAULTS[key];
      }
      return n;
    }

    if (key === 'topoBudgetS0' || key === 'topoBudgetSMax' || key === 'lqeMinSeedSize') {
      const n = Math.floor(Number(value));
      if (!Number.isFinite(n) || n < 1) {
        console.warn(`[featureFlags] ${key} invalid (${value}), using default`);
        return DEFAULTS[key];
      }
      return n;
    }

    if (key === 'topoBudgetAlpha' || key === 'topoBudgetBeta') {
      const n = parseFloat(value);
      return Number.isFinite(n) ? Math.max(0, n) : DEFAULTS[key];
    }

    // ── Stage 6: KEM ──────────────────────────────────────────────────────

    if (key === 'kemSplitThreshold') {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return clamp(n, 1.0, 10.0);
      return DEFAULTS.kemSplitThreshold;
    }

    if (key === 'kemEdgeAlignmentThresh') {
      const n = Number(value);
      if (Number.isFinite(n)) return clamp(n, 0.0, 1.0);
      return DEFAULTS.kemEdgeAlignmentThresh;
    }

    if (key === 'viewManifoldKEMScale') {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return clamp(n, 1, 10000);
      return DEFAULTS.viewManifoldKEMScale;
    }

    // ── Stage 7: Correspondence ───────────────────────────────────────────

    if (key === 'symmetryAxisFallbackVertical') {
      if (value === 'true'  || value === true)  return true;
      if (value === 'false' || value === false) return false;
      return DEFAULTS.symmetryAxisFallbackVertical;
    }

    if (key === 'correspondenceConfidenceSigma') {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return clamp(n, 0.01, 1.0);
      return DEFAULTS.correspondenceConfidenceSigma;
    }

    if (key === 'correspondenceMinConfidence') {
      const n = Number(value);
      if (Number.isFinite(n)) return clamp(n, 0.0, 1.0);
      return DEFAULTS.correspondenceMinConfidence;
    }

    if (key === 'symmetryMismatchAlpha' || key === 'symmetryMismatchBeta') {
      const n = Number(value);
      if (Number.isFinite(n)) return clamp(n, 0.0, 1.0);
      return DEFAULTS[key];
    }

    // ── Stage 5: AmbiAnamorph ─────────────────────────────────────────────

    // Positive integer bins
    if (key === 'ambiRBins') {
      const n = Math.floor(Number(value));
      if (Number.isFinite(n) && n >= 4) return Math.min(512, n);
      return DEFAULTS.ambiRBins;
    }
    if (key === 'ambiThetaBins') {
      const n = Math.floor(Number(value));
      if (Number.isFinite(n) && n >= 8) return Math.min(1024, n);
      return DEFAULTS.ambiThetaBins;
    }

    // Boolean toggles
    if (key === 'ambiSeamBlend' || key === 'ambiDebug') {
      if (value === 'true'  || value === true)  return true;
      if (value === 'false' || value === false) return false;
      return DEFAULTS[key];
    }

    // Positive integer: session lock threshold [1, 30]
    if (key === 'structureIdLockThreshold') {
      const n = Math.floor(Number(value));
      if (Number.isFinite(n) && n >= 1) return Math.min(30, n);
      return DEFAULTS.structureIdLockThreshold;
    }

    // Positive number: frame rate [1, 240]
    if (key === 'ambiFrameRate') {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return clamp(n, 1, 240);
      return DEFAULTS.ambiFrameRate;
    }

    // [0,1] threshold: view manifold compatibility
    if (key === 'viewManifoldCompatibilityThresh') {
      const n = Number(value);
      if (Number.isFinite(n)) return clamp(n, 0.0, 1.0);
      return DEFAULTS.viewManifoldCompatibilityThresh;
    }

    // [0,1] exponents: integration weight formula
    if ([
      'ambiCoherenceExponent',
      'ambiFMapExponent',
      'ambiGeomConfExponent',
      'ambiTopoStabExponent'
    ].includes(key)) {
      const n = Number(value);
      if (Number.isFinite(n)) return clamp(n, 0.0, 1.0);
      return DEFAULTS[key];
    }

    // [0,1] threshold: legibility weight floor
    if (key === 'ambiLegibilityWeightThresh') {
      const n = Number(value);
      if (Number.isFinite(n)) return clamp(n, 0.0, 1.0);
      return DEFAULTS.ambiLegibilityWeightThresh;
    }

    // boolean-ish values that might arrive as strings
    if (typeof DEFAULTS[key] === 'boolean') {
      if (value === 'true' || value === true) return true;
      if (value === 'false' || value === false) return false;
    }

    // ----- Existing keys coercion/validation -----

    // HFH heavy threshold (0..1)
    if (key === 'hfhHeavyPathThreshold') {
      const n = Number(value);
      if (Number.isFinite(n)) return clamp(n, 0.0, 1.0);
      return DEFAULTS.hfhHeavyPathThreshold;
    }

    if (key === 'storageEvictorAuthority') {
      if (typeof value === 'string') {
        const v = value.toLowerCase();
        if (v === 'main' || v === 'none') return v;
      }
      console.warn(`[featureFlags] invalid storageEvictorAuthority "${value}", falling back to "${DEFAULTS.storageEvictorAuthority}"`);
      return DEFAULTS.storageEvictorAuthority;
    }

    // overhangPolicyMode: allowed values 'off' | 'annotate' | 'constraints'
    if (key === 'overhangPolicyMode') {
      if (typeof value === 'string') {
        const v = value.toLowerCase();
        if (v === 'off' || v === 'annotate' || v === 'constraints') return v;
      }
      // warn and fallback
      console.warn(`[featureFlags] invalid overhangPolicyMode "${value}", falling back to "${DEFAULTS.overhangPolicyMode}"`);
      return DEFAULTS.overhangPolicyMode;
    }

    // hfhDecisionAuthority: 'worker' | 'eviction'
    if (key === 'hfhDecisionAuthority') {
      if (typeof value === 'string') {
        const v = value.toLowerCase();
        if (v === 'worker' || v === 'eviction') return v;
      }
      console.warn(`[featureFlags] invalid hfhDecisionAuthority "${value}", falling back to "${DEFAULTS.hfhDecisionAuthority}"`);
      return DEFAULTS.hfhDecisionAuthority;
    }

    // phase toggles - boolean coercion already above will handle strings; ensure default fallback
    if (key === 'enablePreprocessAnnotate' || key === 'enablePreprocessQuantize' || key === 'enableReconstructionSolve' || key === 'enableHFH' || key === 'hfhAnnotateOnlyDuringEviction') {
      if (value === 'true' || value === true) return true;
      if (value === 'false' || value === false) return false;
      // fallback to default if unknown
      return DEFAULTS[key];
    }

  } catch (e) {
    // fall back to original behavior
    console.warn('[featureFlags] coercion helper threw', e);
  }

  return value;
}

/* ------------------------ Public API ------------------------ */

/** getFlags() - shallow cloned snapshot */
export function getFlags() {
  return Object.assign({}, _flags);
}

/** getFlag(key) - raw value for a key */
export function getFlag(key) {
  return _flags ? _flags[key] : undefined;
}

/** getSeq() - convenience to read __seq */
export function getSeq() {
  return _flags ? (_flags.__seq || 0) : 0;
}

/** setFlag(key, value) - set a single flag with validation */
export function setFlag(key, value) {
  _assertNotReservedKey(key);
  const before = getFlags();
  const coerced = _coerceOrWarn(key, value);
  _flags = Object.assign({}, _flags, { [key]: coerced });

  // bump seq
  _bumpSeq();

  // persist
  _writeFlagsToStorage(_flags);

  const payload = { key, value: coerced, flags: getFlags(), prev: before };
  _postUpdateEvent(payload);
  _broadcastFlags(payload);
  _notifyLocalSubscribers(payload);

  return getFlags();
}

/** setFlags(obj) - atomically set multiple flags */
export function setFlags(obj = {}) {
  if (!obj || typeof obj !== 'object') throw new Error('setFlags requires an object');
  // validate keys
  Object.keys(obj).forEach(k => {
    if (_RESERVED_KEYS.has(k) || k.startsWith(_RESERVED_PREFIX)) {
      throw new Error(`setFlags: reserved key in payload: ${k}`);
    }
  });

  const before = getFlags();
  // coerce values where possible
  const normalized = {};
  Object.keys(obj).forEach(k => { normalized[k] = _coerceOrWarn(k, obj[k]); });

  _flags = Object.assign({}, _flags, normalized);

  // bump seq
  _bumpSeq();

  // persist
  _writeFlagsToStorage(_flags);

  const payload = { keys: Object.keys(normalized), changes: deepClone(normalized), flags: getFlags(), prev: before };
  _postUpdateEvent(payload);
  _broadcastFlags(payload);
  _notifyLocalSubscribers(payload);

  return getFlags();
}

/** toggleFlag(key) - flip boolean-ish */
export function toggleFlag(key) {
  _assertNotReservedKey(key);
  const current = getFlag(key);
  const next = !(current === true);
  return setFlag(key, next);
}

/** resetFlags() - reset to DEFAULTS */
export function resetFlags() {
  _flags = Object.assign({}, DEFAULTS);
  // fresh seq
  _ensureSeqObject(_flags);
  _bumpSeq();

  _writeFlagsToStorage(_flags);
  const payload = { reset: true, flags: getFlags() };
  _postUpdateEvent(payload);
  _broadcastFlags(payload);
  _notifyLocalSubscribers(payload);
  return getFlags();
}

/** subscribe(fn) - synchronous bootstrap + unsubscribe */
/** subscribe(fn) - synchronous register + microtask bootstrap */
export function subscribe(fn) {
  if (typeof fn !== 'function') throw new Error('subscribe requires a function');

  // Add to subscribers synchronously
  _subs.add(fn);

  // Capture snapshot once (cheap)
  const snapshot = getFlags();

  // Invoke bootstrap asynchronously but as a microtask so callers that
  // rely on immediate-return of unsubscribe are safe (avoids waitForFlag race).
  // Payload includes seq so consumers can detect staleness if they care.
  try {
    queueMicrotask(() => {
      try {
        fn({ flags: snapshot });
      } catch (e) {
        console.warn('[featureFlags] subscriber initial call error', e);
      }
    });
  } catch (e) {
    // fallback if queueMicrotask unavailable (older env)
    try {
      setTimeout(() => {
        try { fn({ flags: snapshot }); } catch (err) { console.warn('[featureFlags] subscriber initial call error', err); }
      }, 0);
    } catch (err) {
      // give up gracefully
    }
  }

  // return unsubscribe
  return () => _subs.delete(fn);
}

/** subscribeKey(key, fn) - subscribe to specific key changes */
export function subscribeKey(key, fn) {
  if (typeof key !== 'string') throw new Error('subscribeKey requires string key');
  if (typeof fn !== 'function') throw new Error('subscribeKey requires a function');

  let set = _keySubs.get(key);
  if (!set) {
    set = new Set();
    _keySubs.set(key, set);
  }
  set.add(fn);

  const snapshot = { key, value: getFlag(key), flags: getFlags() };

  try {
    queueMicrotask(() => {
      try {
        fn(snapshot);
      } catch (e) {
        console.warn('[featureFlags] key-subscriber initial call error', e);
      }
    });
  } catch (e) {
    setTimeout(() => {
      try { fn(snapshot); } catch (err) { console.warn('[featureFlags] key-subscriber initial call error', err); }
    }, 0);
  }

  return () => {
    const s = _keySubs.get(key);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) _keySubs.delete(key);
  };
}

/**
 * onBroadcastMessage(handler) - register a handler for BC messages (worker-friendly).
 * Handler will receive the message payload (ev.data). Returns an unsubscribe function.
 *
 * Handlers are stored and attached when BroadcastChannel is available. Replacing BC
 * via _replaceBroadcastChannel reattaches stored handlers to the new channel.
 */
export function onBroadcastMessage(handler) {
  if (typeof handler !== 'function') {
    console.warn('[featureFlags] onBroadcastMessage requires a function handler');
    return () => {};
  }

  // If we already have the handler registered, don't duplicate
  if (_bcHandlers.has(handler)) {
    // Already registered -> return unsubscribe
    return () => {
      const wrapped = _bcHandlers.get(handler);
      try {
        if (_bc && wrapped) _bc.removeEventListener('message', wrapped);
      } catch (e) {}
      _bcHandlers.delete(handler);
    };
  }

  // Create wrapped listener
  const wrapped = (ev) => {
    try { handler(ev.data); } catch (e) { console.warn('[featureFlags] broadcast handler error', e); }
  };

  // Record mapping
  _bcHandlers.set(handler, wrapped);

  if (_bc) {
    // attach immediately
    try {
      _bc.addEventListener('message', wrapped);
    } catch (e) {
      console.warn('[featureFlags] error adding broadcast listener', e);
    }
  } else {
    // queue for later attachment
    _pendingBcRegistrations.add(handler);
  }

  // Unsubscribe function
  return () => {
    try {
      const w = _bcHandlers.get(handler);
      if (w && _bc) {
        try { _bc.removeEventListener('message', w); } catch (e) {}
      }
    } catch (e) {}
    // Remove from pending registrations if queued
    _pendingBcRegistrations.delete(handler);
    _bcHandlers.delete(handler);
  };
}

/**
 * waitForFlag(key, desiredValue = true, timeoutMs = 10000)
 * Resolves when the flag matches the desiredValue or rejects on timeout.
 */
export function waitForFlag(key, desiredValue = true, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    // immediate check
    if (getFlag(key) === desiredValue) {
      return resolve(getFlags());
    }

    let resolved = false;
    let timeoutHandle = null;

    // subscribe and capture the unsubscribe immediately (safe: subscribe now returns unsubscribe)
    const unsub = subscribe(() => {
      if (resolved) return;
      try {
        const current = getFlag(key);
        if (current === desiredValue) {
          resolved = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          try { unsub(); } catch (_) {}
          resolve(getFlags());
        }
      } catch (e) {
        console.warn('[featureFlags] waitForFlag subscription error', e);
      }
    });

    timeoutHandle = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { unsub(); } catch (_) {}
      reject(new Error(`waitForFlag timeout waiting for ${key}===${String(desiredValue)}`));
    }, timeoutMs);
  });
}

/**
 * onFlagsChangeOnce(fn) - subscribe once (auto-unsubscribe even if handler throws)
 */
export function onFlagsChangeOnce(fn) {
  if (typeof fn !== 'function') throw new Error('onFlagsChangeOnce requires a function');

  let called = false;
  const unsub = subscribe((payload) => {
    if (called) return;
    called = true;
    try {
      fn(payload);
    } catch (e) {
      console.warn('[featureFlags] onFlagsChangeOnce handler error', e);
    } finally {
      unsub();
    }
  });

  return unsub;
}

/**
 * migrateFlags(migrationFn) - transform existing flags using a migration function
 */
export function migrateFlags(migrationFn) {
  if (typeof migrationFn !== 'function') throw new Error('migrateFlags requires a function');
  try {
    const before = getFlags();
    const next = migrationFn(deepClone(before)) || {};
    // prohibit reserved key writes
    Object.keys(next).forEach(k => {
      if (k.startsWith(_RESERVED_PREFIX) || _RESERVED_KEYS.has(k)) {
        throw new Error(`migrateFlags attempted to set reserved key ${k}`);
      }
    });
    _flags = Object.assign({}, DEFAULTS, next);
    _ensureSeqObject(_flags);
    _bumpSeq();
    _writeFlagsToStorage(_flags);
    const payload = { migrated: true, flags: getFlags(), prev: before };
    _postUpdateEvent(payload);
    _broadcastFlags(payload);
    _notifyLocalSubscribers(payload);
    return getFlags();
  } catch (err) {
    console.warn('[featureFlags] migrateFlags failed', err);
    throw err;
  }
}

/**
 * _replaceBroadcastChannel(newBc) - testing hook to replace the BC used internally.
 * Detaches all listeners from the old channel and attaches stored handlers to the new one.
 */
export function _replaceBroadcastChannel(newBc) {
  try {
    if (_bc && typeof _bc.close === 'function') {
      try { _detachAllFromChannel(_bc); } catch (e) {}
      try { _bc.close(); } catch (e) {}
    }
  } catch (e) {
    console.warn('[featureFlags] close old BC failed', e);
  }

  // set to new channel and attach existing handlers
  _bc = newBc;

  if (_bc) {
    // attach stored handlers to the new channel
    _attachAllBcHandlers();
  }
}

/**
 * broadcastCurrentFlags() - explicit helper to broadcast the current flags snapshot
 * via BroadcastChannel (or no-op if unavailable). Useful at app bootstrap.
 */
export function broadcastCurrentFlags() {
  try {
    if (!_bc) {
      _initBroadcastChannel();
    }
    if (_bc) {
      _bc.postMessage({ event: 'flagsChanged', flags: getFlags(), source: 'explicit:broadcast' });
    }
  } catch (e) {
    console.warn('[featureFlags] broadcastCurrentFlags failed', e);
  }
}

/* ------------------------ Initialization (synchronous) ------------------------ */

(function init() {
  try {
    // Read flags from storage (synchronously) and set _flags once.
    _flags = _readFlagsFromStorage();

    // Ensure __seq present
    _ensureSeqObject(_flags);

    // Initialize bc (attach any pending handlers)
    _initBroadcastChannel();

    // Persist sanitized flags back (ensures storage contains featureFlagsVersion and seq)
    _writeFlagsToStorage(_flags);
  } catch (err) {
    console.warn('[featureFlags] init error', err);
    if (!_flags) _flags = Object.assign({}, DEFAULTS);
    _ensureSeqObject(_flags);
  }
})();

/* ------------------------ Default export ------------------------ */

const featureFlags = {
  getFlags,
  getFlag,
  getSeq,
  setFlag,
  setFlags,
  toggleFlag,
  resetFlags,
  subscribe,
  subscribeKey,
  onBroadcastMessage,
  waitForFlag,
  onFlagsChangeOnce,
  migrateFlags,
  _replaceBroadcastChannel,
  broadcastCurrentFlags,
  DEFAULTS: Object.freeze(Object.assign({}, DEFAULTS))
};

export default featureFlags;