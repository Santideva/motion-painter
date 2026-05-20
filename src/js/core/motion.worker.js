// /src/js/core/motion.worker.js
// ES module worker: computes depth/normal/flux artifacts using depthTrianglePreprocessor,
// overhangPreprocessor, and MultiSampler, then persists to storage.
// Listens on BroadcastChannel 'motion-painter-store' for flags and calibration events.
// Accepts postMessage commands for targeted reconstruction jobs (RECONSTRUCT_META).
//
// UPDATED: Integrated CalibratedFieldProducer → Tetrachromacy → DirectionalLifting pipeline
// Added: Bump/Normal/Specular computation with GPU acceleration
//
// NOTE: uses absolute imports so it resolves regardless of where the worker is instantiated.

import MultiSampler from '/src/js/sampler/MultiSampler.js';
import { CalibratedFieldProducer } from '/src/js/core/CalibratedFieldProducer.js';
import { Tetrachromacy } from '/src/js/core/Tetrachromacy.js';
import { DirectionalLifting } from '/src/js/core/DirectionalLifting.js';
import { PenumbraAnalyzer } from '/src/js/core/PenumbraAnalyzer.js';  
import PackingSDF from '/src/js/core/PackingSDF.js';
import { DifferentialGeometry } from '/src/js/core/DifferentialGeometry.js';

const BC_CHANNEL = 'motion-painter-store';
const bc = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel(BC_CHANNEL) : null;

// ============================================================================
// PIN LIFECYCLE CONFIGURATION
// ============================================================================
/**
 * TTL (Time-To-Live) constants for auto-unpinning artifacts
 * 
 * DESIGN RATIONALE:
 * - Final artifacts (depth/normal/flux): 5 minutes
 *   Longer TTL because reconstruction is expensive (10-60 seconds)
 *   Consumers (solvers, renderers) may take time to discover
 * 
 * - Intermediate artifacts (tetra/directional/bump/specular): 2 minutes
 *   Shorter TTL because less reuse, primarily for debugging
 *   Conditional persistence (only if persistIntermediates flag enabled)
 * 
 * - Calibrated field: 3 minutes
 *   Medium TTL because reusable across multiple reconstructions
 *   But not as critical as final outputs
 */
const ARTIFACT_PIN_TTL_MS = 300000;        // 5 min (final artifacts)
const INTERMEDIATE_TTL_MS = 120000;        // 2 min (debug artifacts)
const CALIBRATION_FIELD_TTL_MS = 180000;   // 3 min (reusable intermediate)

/**
 * Track pinned artifacts with TTL timers
 * 
 * PURPOSE:
 * Maps metaKey to pin metadata + cancellable timer
 * When consumer claims artifact, we cancel timer to prevent premature unpin
 * 
 * STRUCTURE:
 * metaKey → {
 *   pinnedAt: timestamp,
 *   ttlMs: duration,
 *   timer: setTimeout handle,
 *   owner: 'motion.worker',
 *   expiresAt: timestamp
 * }
 * 
 * LIFECYCLE:
 * 1. _persistAndPin() creates entry and schedules timer
 * 2. BC 'artifact:claimed' event triggers _cancelTTL() → removes entry
 * 3. Timer expires → auto-unpin → removes entry
 * 4. Shutdown handler → clears all timers → removes all entries
 */
const _pinnedArtifacts = new Map();

/**
 * Feature flag for conservative vs aggressive unpin mode
 * 
 * FALSE (conservative, default):
 *   - Producer keeps pin as fallback until consumer releases
 *   - Higher pinnedBytes but safer (protects against consumer bugs)
 * 
 * TRUE (aggressive, memory-optimized):
 *   - Producer unpins immediately on consumer claim
 *   - Lower pinnedBytes (frees memory early)
 *   - Requires well-behaved consumers (always pin before use)
 */
let MOTION_UNPIN_ON_CLAIM = false;

// ---------------------------------------------------------------------------
// Message ID Generator (for deduplication in main thread)
// ---------------------------------------------------------------------------

const generateMsgId = () => `motion.worker:${Date.now()}:${Math.random().toString(36).slice(2,8)}`;

// ============================================================================
// BC EVENT LISTENERS (Consumer Claims & Releases)
// ============================================================================
/**
 * PROTOCOL EXPLANATION:
 * 
 * 1. ARTIFACT LIFECYCLE:
 *    Producer creates → pins with TTL → broadcasts 'artifact:ready'
 *    Consumer discovers → pins → broadcasts 'artifact:claimed'
 *    Producer receives claim → cancels TTL (keeps pin as fallback)
 *    Consumer finishes → unpins → broadcasts 'artifact:released'
 *    Producer receives release → checks refcount → unpins if last owner
 * 
 * 2. TIMING SAFETY:
 *    - Consumer MUST: pin BEFORE broadcasting 'claimed'
 *    - Producer cancelling TTL is OPTIMIZATION, not required for correctness
 *    - If TTL fires before consumer pins: producer unpins → consumer pins → safe
 *    - If consumer pins before TTL: consumer pin protects → TTL cancel avoids waste
 * 
 * 3. DUAL TTL MODEL:
 *    - Storage-level TTL: Authoritative, survives worker death
 *    - Worker-level TTL: Advisory optimization, faster proactive cleanup
 *    - Both use same duration for consistency
 * 
 * 4. FEATURE FLAG:
 *    MOTION_UNPIN_ON_CLAIM controls whether producer unpins on claim
 */
if (bc) {
  bc.addEventListener('message', async (ev) => {
    const data = ev.data || {};
    
    // ============================================================================
    // IGNORE SELF-POSTED MESSAGES (prevent double-handling)
    // ============================================================================
    if (data.source === 'motion.worker' || data.producer === 'motion.worker') {
      return; // Skip - we sent this message
    }
    
    // ============================================================================
    // EVENT: artifact:claimed
    // ============================================================================
    /**
     * Consumer has pinned artifact and is claiming ownership
     * 
     * FIELDS (backward compatible):
     * - metaKey: Primary artifact key
     * - claimedBy / consumer / claimant: Consumer identifier
     * - derivedKeys: Optional array of child keys also claimed
     * 
     * ACTIONS:
     * - Conservative mode (default): Cancel TTL, keep producer pin
     * - Aggressive mode (UNPIN_ON_CLAIM=true): Unpin producer, cancel TTL
     */
    if (data.event === 'artifact:claimed') {
      const metaKey = data.metaKey;
      const claimedBy = data.claimedBy || data.consumer || data.claimant || 'unknown';
      const derivedKeys = data.derivedKeys || [];
      
      if (!metaKey) {
        console.warn('[PIN] artifact:claimed event missing metaKey', data);
        return;
      }
      
      if (MOTION_UNPIN_ON_CLAIM) {
        // ✅ AGGRESSIVE MODE: Unpin immediately to free memory
        (async () => {
          try {
              const unpinFn = storageWrapper?.unpinArtifact || 
               (typeof self.unpinArtifact === 'function' ? self.unpinArtifact : null);
            
            if (typeof unpinFn === 'function') {
              await unpinFn(metaKey, { owner: 'motion.worker' });
              _cancelTTL(metaKey);
              
              // Unpin derived keys too
              for (const derivedKey of derivedKeys) {
                await unpinFn(derivedKey, { owner: 'motion.worker' });
                _cancelTTL(derivedKey);
              }
              
              console.log(`[PIN] ✓ Unpinned ${metaKey.slice(0, 20)}... on claim by ${claimedBy} (aggressive mode)`);
            }
          } catch (err) {
            console.warn(`[PIN] ✗ Aggressive unpin failed for ${metaKey.slice(0, 20)}...:`, err);
            // Fallback: at least cancel timer to prevent double-unpin
            _cancelTTL(metaKey);
            derivedKeys.forEach(dk => _cancelTTL(dk));
          }
        })();
      } else {
        // ✅ CONSERVATIVE MODE: Cancel TTL only, keep producer pin as fallback
        _cancelTTL(metaKey);
        
        // Cancel derived key TTLs
        for (const derivedKey of derivedKeys) {
          _cancelTTL(derivedKey);
        }
        
        console.log(`[PIN] 🚫 TTL cancelled for ${metaKey.slice(0, 20)}... claimed by ${claimedBy} (conservative - keeping fallback pin)${derivedKeys.length > 0 ? ` + ${derivedKeys.length} children` : ''}`);
      }
    }
    
    // ============================================================================
    // EVENT: artifact:released
    // ============================================================================
    /**
     * Consumer has finished using artifact and unpinned
     * Producer checks if it should also unpin (if no other consumers remain)
     * RESULT: Safe - reduces pinnedBytes opportunistically
     * No correctness failure even if race occurs
     */
    if (data.event === 'artifact:released') {
      const metaKey = data.metaKey;
      const releasedBy = data.releasedBy || data.consumer || 'unknown';
      
      if (!metaKey) {
        console.warn('[PIN] artifact:released event missing metaKey', data);
        return;
      }
      
      // Query current pins to decide if producer should unpin
      (async () => {
        try {
          const getPinsFn = storageWrapper?.getPins || 
                           (typeof self.getPins === 'function' ? self.getPins : null);
          
          if (typeof getPinsFn !== 'function') {
            console.warn('[PIN] getPins not available, cannot check refcount');
            return;
          }
          
          const pins = await getPinsFn(metaKey);
          
          // If only motion.worker pin remains, unpin it
          if (pins.length === 1 && pins[0].owner === 'motion.worker') {
              const unpinFn = storageWrapper?.unpinArtifact || 
               (typeof self.unpinArtifact === 'function' ? self.unpinArtifact : null);;
            
            if (typeof unpinFn === 'function') {
              await unpinFn(metaKey, { owner: 'motion.worker' });
              console.log(`[PIN] ✓ Released ${metaKey.slice(0, 20)}... (last consumer ${releasedBy} released - no pins remain)`);
              
              // Broadcast final unpin
              if (bc) {
                bc.postMessage({
                  event: 'artifact:unpinned',
                  msgId: generateMsgId(),
                  metaKey,
                  owner: 'motion.worker',
                  reason: 'all_consumers_released',
                  producer: 'motion.worker',
                  source: 'motion.worker',
                  timestamp: Date.now()
                });
              }
            }
          } else if (pins.length > 1) {
            console.log(`[PIN] ⏸️  Keeping fallback pin for ${metaKey.slice(0, 20)}... (${pins.length - 1} other consumers remain after ${releasedBy} released)`);
          } else if (pins.length === 0) {
            console.log(`[PIN] ℹ️  ${metaKey.slice(0, 20)}... already fully unpinned (no action needed)`);
          }
        } catch (err) {
          console.warn(`[PIN] ✗ Failed to check/release ${metaKey.slice(0, 20)}...:`, err);
        }
      })();
    }
  });
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let _flags = {};                    // feature flags / runtime config snapshot
let _running = true;
let _jobs = new Map();
let _inFlightMetaKeys = new Set();              // jobId -> { heartbeatTimer, createdAt, meta }
let _metrics = {
  jobsHandled: 0,
  lastError: null,
  avgProcessingMs: 0,
  totalProcessingMs: 0,
  reconstructionCount: 0,
  depthComputeCount: 0,
  fluxComputeCount: 0
};

// THREE.js renderer state (initialized lazily)
let _threeRenderer = null;
let _threeInitialized = false;
let _threeInitError = null;

// ⭐ Cache THREE.js module to avoid re-importing
let _threeModule = null;

// Preprocessor instances (created per-frame as needed)
let _trianglePreprocessor = null;
let _overhangPreprocessor = null;

// GPU resource tracking for cleanup
const _gpuResources = {
  textures: new Set(),
  renderTargets: new Set(),
  materials: new Set()
};

// ============================================================================
// CALIBRATED PIPELINE MODULE SINGLETONS (lazy initialization)
// ============================================================================

let _calibratedProducer = null;
let _tetrachromacy = null;
let _directionalLifting = null;
let _gpuCapabilities = null;

// --- Stage 0: computed once when DirectionalLifting is first instantiated ---
// Derived from bufferSize × frameInterval × geometric decay sum.
// Written by _getDirectionalLifting(), broadcast in RECON_DONE payload
// so main.js can update cameraContainer.plenopticSampling.effectiveWindowMs.
let _effectiveWindowMs = null;
let _penumbraAnalyzer  = null; 
let _packingSDF        = null;
let _diffGeo           = null;

// Configuration: integers and thresholds can be overridden via _flags
const DEFAULTS = {
  heartbeatIntervalMs:  20_000,        // worker heartbeat to storage
  takeoverMsDefault:    10 * 60_000,   // 10 minutes takeover window
  maxWorkerMemoryBytes: 1 << 28,       // ~268MB default safety cap (tunable via flags)
  defaultResolutions:   { low: 256, normal: 512, high: 1024 },

  // ── Stage 2: PackingSDF defaults ─────────────────────────────────────────
  // All keys are also valid _flags overrides so they can be changed at runtime
  // via a flagsChanged BroadcastChannel event without restarting the worker.
  packingDefaults: {
    enablePackingSDF:     true,
    packingUmbraPolicy:   'half-weight', // 'half-weight' | 'include' | 'exclude'
    packingBandBase:      0.03,          // fraction of sdfRange (GPT latent heat floor)
    packingBandScale:     3.0,           // penumbra width × this = extra band width
    packingFalloffExp:    2.0,           // narrow band smooth fall-off exponent
    packingSeedRMin:      0.01,          // minimum seed radius (normalised image coords)
    packingSeedRMax:      0.08,          // maximum seed radius (normalised image coords)
    packingMaxSeeds:      2048,          // MultiSampler ceiling across all partitions
    packingDensitySmooth: 4,             // box-blur radius for density map smoothing
    packingSamplerSeed:   0xF1E2D3C4,    // deterministic RNG seed (uint32)
    packingDebug:         false          // persist medStressMap + scaleneVariance diags
  }
};

// Merge Stage 2 defaults into _flags so they take effect immediately on first
// reconstruction (before any flagsChanged event arrives from the main thread).
// Any subsequent flagsChanged event will override these via _applyFlagsSnapshot.
Object.assign(_flags, DEFAULTS.packingDefaults);

// ── Stage 3: Horn-Schunck optical flow defaults ───────────────────────────
// enableOpticalFlow defaults to true — DirectionalLifting's derivatives.field
// provides the temporal gradient (It) that H-S requires, so the full flow
// pipeline is always available. H-S runs GPU-side (~5ms at 512²) and falls
// back to flowField=null gracefully on GPU failure. Disabling this flag
// starves DifferentialGeometry of flowCurl/flowDiv, which in turn causes
// LipschitzQuaternionEnds to hang with no convergence criterion.
Object.assign(_flags, {
  enableOpticalFlow:     true,   // H-S optical flow enabled by default
  opticalFlowAlpha:      1.0,    // smoothness weight α² [0.1, 10]
  opticalFlowIterations: 30      // ping-pong passes [10, 100]
});

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

// Validation Helpers

/**
 * Validate resolution consistency across module outputs
 * @param {number} expected - Expected resolution
 * @param {number} actual - Actual resolution from module
 * @param {string} moduleName - Module name for error messages
 * @throws {Error} if mismatch detected
 */
function validateResolution(expected, actual, moduleName) {
  if (!Number.isInteger(expected) || expected <= 0) {
    throw new Error(`[${moduleName}] Invalid expected resolution: ${expected}`);
  }
  if (!Number.isInteger(actual) || actual <= 0) {
    throw new Error(`[${moduleName}] Module returned invalid resolution: ${actual}`);
  }
  if (actual !== expected) {
    throw new Error(
      `[${moduleName}] Resolution mismatch: expected ${expected}, got ${actual}. ` +
      `This indicates a pipeline configuration error.`
    );
  }
}

/**
 * Validate array buffer dimensions
 * @param {TypedArray|Array} buffer
 * @param {number} expectedLength
 * @param {string} bufferName
 * @throws {Error} if validation fails
 */
function validateBuffer(buffer, expectedLength, bufferName) {
  if (!buffer) {
    throw new Error(`[Validation] ${bufferName} is null or undefined`);
  }
  if (!buffer.length && buffer.length !== 0) {
    throw new Error(`[Validation] ${bufferName} has no length property`);
  }
  if (buffer.length !== expectedLength) {
    throw new Error(
      `[Validation] ${bufferName} length mismatch: expected ${expectedLength}, got ${buffer.length}`
    );
  }
}

/**
 * Safely get WebGL context from THREE renderer
 * Handles different THREE.js versions and API variations
 * @param {THREE.WebGLRenderer} renderer
 * @returns {WebGLRenderingContext|WebGL2RenderingContext|null}
 */
function safeGetRendererContext(renderer) {
  if (!renderer) return null;
  
  try {
    // Modern THREE.js: renderer.getContext()
    if (typeof renderer.getContext === 'function') {
      return renderer.getContext();
    }
    
    // Older THREE.js: renderer.context
    if (renderer.context) {
      return renderer.context;
    }
    
    // Fallback: domElement.getContext()
    if (renderer.domElement && typeof renderer.domElement.getContext === 'function') {
      // Try WebGL2 first, then WebGL1
      let ctx = renderer.domElement.getContext('webgl2');
      if (ctx) return ctx;
      return renderer.domElement.getContext('webgl') || renderer.domElement.getContext('experimental-webgl');
    }
    
    return null;
  } catch (err) {
    console.warn('motion.worker: safeGetRendererContext failed', err);
    return null;
  }
}

/**
 * Validate THREE.js renderer state
 * @param {THREE.WebGLRenderer} renderer
 * @throws {Error} if renderer is invalid
 */
function validateRenderer(renderer) {
  if (!renderer) {
    throw new Error('[THREE.js] Renderer is null');
  }
  
  const ctx = safeGetRendererContext(renderer);
  if (!ctx) {
    throw new Error('[THREE.js] Renderer has no valid WebGL context');
  }
  
  if (ctx.isContextLost && ctx.isContextLost()) {
    throw new Error('[THREE.js] WebGL context is lost');
  }
}

/**
 * Safe numeric extraction with bounds checking
 * @param {any} value
 * @param {number} defaultValue
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function safeNumeric(value, defaultValue, min = -Infinity, max = Infinity) {
  const num = Number(value);
  if (!Number.isFinite(num)) return defaultValue;
  return Math.max(min, Math.min(max, num));
}

/**
 * typedMinMax(typedArray)
 * Compute min/max without spreading into function arguments (safe for large typed arrays).
 */
function typedMinMax(typed) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0, L = typed.length; i < L; i++) {
    const v = typed[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) min = 0;
  if (max === -Infinity) max = 0;
  return { min, max };
}

/**
 * safeErrSummary(err)
 * Normalize an error-like value into { message, stack } safely.
 */
function safeErrSummary(err) {
  if (!err) {
    return { message: 'Unknown error', stack: null };
  }
  try {
    const message = (typeof err === 'string') ? err : (err && err.message) ? err.message : String(err);
    const stack = (err && err.stack) ? err.stack : null;
    return { message, stack };
  } catch (e) {
    return { message: String(err), stack: null };
  }
}

// ---------------------------------------------------------------------------
// Storage adapter + retry utilities
// ---------------------------------------------------------------------------

/**
 * _wrapStorage(raw)
 * Given a storage module (various export shapes), create a wrapper with
 * canonical helpers used by this worker: getArtifact, putArtifact, removeArtifact,
 * reconStatus helpers, and optional heartbeat.
 */
function _wrapStorage(raw) {
  if (!raw) throw new Error('No storage module provided to _wrapStorage');

  console.log('[_wrapStorage] Wrapping storage module, available keys:', Object.keys(raw || {}).slice(0, 20));

  const tryFn = (names) => {
    for (const n of names) {
      if (raw && typeof raw[n] === 'function') {
        console.log('[_wrapStorage] Found function:', n);
        return raw[n].bind(raw);
      }
    }
    console.warn('[_wrapStorage] None of these functions found:', names);
    return null;
  };

  const getArtifact = tryFn(['getArtifact', 'get', 'getItem', 'readArtifact', 'fetchArtifact']);
  const putArtifact = tryFn(['putInboundArtifact', 'putArtifact', 'saveArtifact']);
  const removeArtifact = tryFn(['removeArtifact', 'deleteArtifact', 'remove', 'del']);
  const getReconStatus = tryFn(['getReconStatus']);
  const markReconRunning = tryFn(['markReconRunning']);
  const markReconDone = tryFn(['markReconDone']);
  const markReconFailed = tryFn(['markReconFailed']);
  const markReconHeartbeat = tryFn(['markReconHeartbeat', 'updateReconHeartbeat']);

  const wrapper = {
    raw,
    getArtifact,
    putArtifact,
    removeArtifact,
    getReconStatus,
    markReconRunning,
    markReconDone,
    markReconFailed,
    markReconHeartbeat
  };

  console.log('[_wrapStorage] Wrapper created with methods:', {
    getArtifact: !!getArtifact,
    putArtifact: !!putArtifact,
    removeArtifact: !!removeArtifact,
    getReconStatus: !!getReconStatus,
    markReconRunning: !!markReconRunning,
    markReconDone: !!markReconDone,
    markReconFailed: !!markReconFailed,
    markReconHeartbeat: !!markReconHeartbeat
  });

  return wrapper;
}

/**
 * _retryable(fn, attempts, baseDelay)
 * Lightweight retry wrapper for transient IndexedDB/storage errors
 */
async function _retryable(fn, attempts = 4, baseDelay = 120) {
  let lastErr = null;
  for (let i = 0; i < attempts; ++i) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = (err && ((err.name || '') + ' ' + (err.message || ''))).toString().toLowerCase();
      const isTransient = /invalidstateerror|database connection is closing|locked|quotaexceeded|timeout|networkerror|not allowed/i.test(msg);
      if (!isTransient) throw err;
      const delay = baseDelay * (i + 1);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * _loadStorageAPI()
 * Robust dynamic storage loader. Returns the wrapped storage adapter.
 */
async function _loadStorageAPI() {
  try {
    const mod = await import('/src/js/core/storage.js').catch(() => null);
    if (!mod) throw new Error('storage module not available');
    const raw = mod.default || mod.storageAPI || mod;
    return _wrapStorage(raw);
  } catch (err) {
    console.error('motion.worker: failed to import storage.js', err);
    throw err;
  }
}

/**
 * _persistArtifact - Simple persistence without pinning
 * Used for non-critical artifacts like telemetry and selectors
 * 
 * @param {Object} storageWrapper - Storage API wrapper
 * @param {ImageBitmap|null} bitmap - Optional bitmap (unused, for signature compatibility)
 * @param {Object} data - Artifact data payload
 * @param {Object} meta - Artifact metadata (type, sourceMetaKey, etc)
 * @returns {Promise<{ok, metaKey}>} Storage result
 */
async function _persistArtifact(storageWrapper, bitmap, data, meta) {
  const artifact = {
    type: meta.type || 'unknown',
    data: data,
    meta: meta || {},
    createdAt: new Date().toISOString()
  };
  
  const putFn = storageWrapper?.putArtifact || 
                (typeof self.putInboundArtifact === 'function' ? self.putInboundArtifact : null);
  
  if (typeof putFn !== 'function') {
    throw new Error('putInboundArtifact not available in worker context');
  }
  
  const result = await _retryable(async () => await putFn(artifact));
  
  if (!result?.ok || !result.metaKey) {
    throw new Error('Artifact persistence failed - no metaKey returned');
  }
  
  return result;
}

// PERSIST + PIN HELPER (Atomic Ownership Pattern)
/**
 * Persist artifact to storage and immediately claim ownership with a pin.
 * Implements the "producer pins on create" lifecycle pattern.
 * 
 * CRITICAL WORKFLOW:
 * 1. Persist artifact to IndexedDB via putInboundArtifact
 * 2. Immediately pin with producer ownership (prevents eviction)
 * 3. Schedule TTL auto-unpin timer (allows cleanup if unclaimed)
 * 4. Broadcast pin event (allows consumers to discover and claim)
 * 
 * Artifacts are protected until:
 *   - Consumer claims them (cancels TTL), OR
 *   - TTL expires and no consumer claimed (auto-cleanup)
 * 
 * DUAL TTL MODEL:
 * - Storage-level TTL (via pinArtifact ttlMs): Authoritative, survives worker death
 * - Worker-level TTL (via setTimeout): Advisory optimization, faster cleanup
 * - Both use same duration for consistency
 * 
 * ERROR HANDLING:
 * - Persistence failure → throws (artifact not created)
 * - Pin failure → warns but returns result (artifact exists but unprotected)
 * 
 * @param {Object} artifact - Artifact object to persist
 * @param {Object} options - Pin configuration
 * @param {string} options.owner - Pin owner identifier (default: 'motion.worker')
 * @param {number} options.ttlMs - Time-to-live in ms (0 = no expiration)
 * @param {string} options.pinType - 'soft' (evictable under pressure) or 'hard' (never evict)
 * @returns {Promise<{ok, metaKey}>} Storage result with canonical metaKey
 * @throws {Error} If persistence fails
 */
async function _persistAndPin(storageWrapper, artifact, {
  owner = 'motion.worker',
  ttlMs = ARTIFACT_PIN_TTL_MS,
  pinType = 'soft'
} = {}) {

  // STEP 1: Persist artifact to IndexedDB (with retry on transient errors)
  const putResult = await _retryable(async () => {
  const putFn = storageWrapper?.putArtifact || 
              (typeof self.putInboundArtifact === 'function' ? self.putInboundArtifact : null);
        if (typeof putFn !== 'function') {
      throw new Error('putInboundArtifact not available in worker context');
    }
    
    return await putFn(artifact);
  });
  
  // Validate storage returned a canonical metaKey
  if (!putResult?.ok || !putResult.metaKey) {
    throw new Error('Artifact persistence failed - no metaKey returned');
  }
  
  const metaKey = putResult.metaKey;
  
  // STEP 2: Immediately claim ownership with pin
  try {
      const pinFn = storageWrapper?.pinArtifact || 
              (typeof self.pinArtifact === 'function' ? self.pinArtifact : null);
    
    if (typeof pinFn !== 'function') {
      console.warn(`[PIN] ⚠️  pinArtifact not available for ${metaKey.slice(0, 20)}... - ARTIFACT UNPROTECTED (will be immediately evictable)`);
      return putResult;
    }
    
    // CRITICAL: Pin with explicit owner to establish refcount
    // ttlMs is passed to storage for authoritative TTL enforcement
    await pinFn(metaKey, {
      owner,
      type: pinType,
      ttlMs: ttlMs > 0 ? ttlMs : null // null = no storage-level expiration
    });
    
    console.log(`[PIN] ✓ Claimed ${metaKey.slice(0, 20)}... (owner=${owner}, ttl=${ttlMs}ms, type=${pinType})`);
    
    // STEP 3: Schedule worker-level TTL auto-unpin (if ttlMs > 0)
    if (ttlMs > 0) {
      _scheduleTTLUnpin(metaKey, owner, ttlMs, storageWrapper);
    }
    
    // STEP 4: Broadcast pin event for consumer discovery
    if (bc) {
      try {
        bc.postMessage({
          event: 'artifact:pinned',
          msgId: generateMsgId(),
          metaKey,
          owner,
          claimedBy: owner, // BC protocol consistency
          type: pinType,
          ttlMs,
          expiresAt: ttlMs > 0 ? Date.now() + ttlMs : null,
          producer: 'motion.worker',
          source: 'motion.worker', // For self-message filtering
          timestamp: Date.now()
        });
      } catch (bcErr) {
        console.warn('[PIN] BC broadcast failed (non-fatal):', bcErr);
      }
    }
    
  } catch (pinErr) {
    console.error(`[PIN] ✗ Failed to pin ${metaKey.slice(0, 20)}...:`, pinErr);
    // NON-FATAL: Artifact exists but unpinned (will be evictable immediately)
    // We don't throw here because the artifact was successfully persisted.
    // Consumers can still discover it via BC artifact:ready event.
    // However, it may be evicted before they can claim it (race condition).
  }
  
  return putResult;
}

// ============================================================================
// TTL TIMER MANAGEMENT (Worker-Level Advisory Timers)
// ============================================================================
/**
 * Schedule auto-unpin after TTL expires (cancellable by consumer claim)
 * 
 * @param {string} metaKey - Artifact key to schedule unpin for
 * @param {string} owner - Pin owner (must match for unpin)
 * @param {number} ttlMs - Time-to-live in milliseconds
 * @param {Object} storageWrapper - Storage API wrapper (REQUIRED for unpinning)
 */
function _scheduleTTLUnpin(metaKey, owner, ttlMs, storageWrapper) {
   
  _cancelTTL(metaKey);
  
  const timer = setTimeout(async () => {
    try {
      console.log(`[PIN] ⏰ TTL expired for ${metaKey.slice(0, 20)}..., auto-unpinning...`);
      
      // storageWrapper in scope from parameter
      const unpinFn = storageWrapper?.unpinArtifact || 
               (typeof self.unpinArtifact === 'function' ? self.unpinArtifact : null);
      
      if (typeof unpinFn === 'function') {
        await unpinFn(metaKey, { owner });
        console.log(`[PIN] ✓ Auto-unpinned ${metaKey.slice(0, 20)}... (TTL expired, unclaimed by consumers)`);
        
        if (bc) {
          let finalRefCount = null;
          try {
            const getPinRefCountFn = storageWrapper?.getPinRefCount || 
                                     (typeof self.getPinRefCount === 'function' ? self.getPinRefCount : null);
            if (typeof getPinRefCountFn === 'function') {
              finalRefCount = await getPinRefCountFn(metaKey);
            }
          } catch (refErr) {
            // Non-fatal
          }
          
          bc.postMessage({
            event: 'artifact:ttl_unpinned',
            msgId: generateMsgId(),
            metaKey,
            owner,
            reason: 'ttl_expired',
            producer: 'motion.worker',
            source: 'motion.worker',
            timestamp: Date.now(),
            finalRefCount,
            wasUnclaimed: true
          });
        }
      } else {
        console.warn(`[PIN] ⚠️  unpinArtifact not available, cannot auto-unpin ${metaKey.slice(0, 20)}...`);
      }
      
      _pinnedArtifacts.delete(metaKey);
      
    } catch (err) {
      console.error(`[PIN] ✗ Auto-unpin failed for ${metaKey.slice(0, 20)}...:`, err);
      _pinnedArtifacts.delete(metaKey);
    }
  }, ttlMs);
  
  _pinnedArtifacts.set(metaKey, {
    pinnedAt: Date.now(),
    ttlMs,
    timer,
    owner,
    expiresAt: Date.now() + ttlMs,
    storageWrapper  // Store for potential future use
  });
  
  console.log(`[PIN] ⏱️  Scheduled TTL for ${metaKey.slice(0, 20)}... (expires in ${(ttlMs / 1000).toFixed(1)}s)`);
}

/**
 * Cancel TTL timer when consumer claims artifact
 * 
 * SAFE PROTOCOL:
 * Consumer should: (1) pin artifact, (2) broadcast 'artifact:claimed'
 * Producer on receiving claim: cancel TTL to avoid redundant unpin
 * 
 * WHY THIS IS SAFE (race analysis):
 * - If consumer pins BEFORE TTL fires → consumer pin protects artifact
 * - If TTL fires BEFORE consumer pins → producer unpins (refcount=0 temporarily)
 *   → consumer pins → refcount=1 → artifact protected
 * - Storage refcount is atomic; no use-after-free possible
 * 
 * OPTIMIZATION:
 * Cancelling TTL avoids unnecessary unpin operations and timer overhead.
 * Not strictly required for correctness, but recommended for efficiency.
 * 
 * @param {string} metaKey - Artifact key to cancel timer for
 */
function _cancelTTL(metaKey) {
  const entry = _pinnedArtifacts.get(metaKey);
  
  if (entry && entry.timer) {
    clearTimeout(entry.timer);
    console.log(`[PIN] 🚫 Cancelled TTL for ${metaKey.slice(0, 20)}... (claimed by consumer - avoiding redundant unpin)`);
  }
  
  _pinnedArtifacts.delete(metaKey);
}

// Flags application helper
function _applyFlagsSnapshot(flagsPayload = {}) {
    try {
      // Handle both {flags: {...}} and direct {...} payload formats
      const flags = flagsPayload.flags || flagsPayload;
      Object.assign(_flags, flags);
      
      // Update pin mode from feature flags
      if (typeof flags.MOTION_UNPIN_ON_CLAIM === 'boolean') {
        MOTION_UNPIN_ON_CLAIM = flags.MOTION_UNPIN_ON_CLAIM;
        console.log(`[PIN] Feature flag updated: MOTION_UNPIN_ON_CLAIM = ${MOTION_UNPIN_ON_CLAIM}`);
      }
      
      console.log('motion.worker: feature flags updated', _flags);
  } catch (e) {
    console.warn('motion.worker: failed to apply flags snapshot', e);
  }
}

// ---------------------------------------------------------------------------
// THREE.js Module Loader (Reusable, Cached)
// ---------------------------------------------------------------------------

/**
 * _loadThreeModule()
 * Load THREE.js module with fallback strategy
 * Caches result in _threeModule for reuse across multiple function calls
 * 
 * @returns {Promise<THREE>} THREE.js module namespace
 */
async function _loadThreeModule() {
  // Return cached module if already loaded
  if (_threeModule) {
    return _threeModule;
  }

  console.log('motion.worker: Loading THREE.js module...');

  // CRITICAL: import() must use a static string literal so webpack can detect
  // the dependency at build time and include THREE.js in the worker bundle.
  //
  // The previous approach used import(spec) where spec is a variable — webpack
  // cannot statically analyze a variable import, emits the "Critical dependency:
  // the request of a dependency is an expression" warning, and THREE.js is never
  // bundled. At runtime all three import attempts fail ("Cannot find module").
  //
  // CDN and /node_modules/ path fallbacks are removed:
  //   - CDN is blocked under COEP require-corp
  //   - /node_modules/ devServer path is unreliable in production
  // The webpack bundle is the only correct path in this architecture.
  try {
    let mod = await import('three');
    // Normalise namespace vs. default export shapes
    if (mod && mod.default && typeof mod.default.Scene === 'function') {
      mod = mod.default;
    }
    _threeModule = mod;
    console.log('motion.worker: THREE.js module loaded and cached');
    return _threeModule;
  } catch (e) {
    throw new Error(
      `Failed to import THREE.js — ensure three is in package.json and webpack ` +
      `has bundled the worker: ${e && e.message ? e.message : String(e)}`
    );
  }
}

// ---------------------------------------------------------------------------
// THREE.js Initialization (Lazy, Cached)
// ---------------------------------------------------------------------------

/**
 * _initThreeRenderer()
 * Initialize THREE.js renderer on OffscreenCanvas (WebGL2 preferred)
 * 
 * CRITICAL FIX: THREE.js WebGLRenderer expects canvas.style to exist
 * but OffscreenCanvas doesn't have this property. We need to polyfill it.
 */
async function _initThreeRenderer() {
  if (_threeInitialized) {
    if (_threeInitError) throw _threeInitError;
    return _threeRenderer;
  }

  try {
    console.log('motion.worker: Initializing THREE.js renderer...');

    // ========================================
    // STEP 1: Load THREE.js Module (CACHED)
    // ========================================
    const THREE = await _loadThreeModule();
    console.log('motion.worker: THREE.js imported successfully');

    // ========================================
    // STEP 2: Create OffscreenCanvas with Polyfill
    // ========================================
    const width = 512;
    const height = 512;
    const canvas = new OffscreenCanvas(width, height);
    
    // CRITICAL FIX: Polyfill canvas.style for THREE.js
    if (!canvas.style) {
      canvas.style = {};
    }
    
    // Additional polyfills that THREE.js might expect
    if (!canvas.clientWidth) {
      Object.defineProperty(canvas, 'clientWidth', {
        get: () => canvas.width
      });
    }
    
    if (!canvas.clientHeight) {
      Object.defineProperty(canvas, 'clientHeight', {
        get: () => canvas.height
      });
    }

    console.log('motion.worker: OffscreenCanvas created with polyfills');

    // ========================================
    // STEP 3: Create WebGL Context
    // ========================================
    let gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false
    });

    if (!gl) {
      console.warn('motion.worker: WebGL2 not available, trying WebGL1');
      gl = canvas.getContext('webgl', {
        alpha: false,
        antialias: false,
        preserveDrawingBuffer: true,
        powerPreference: 'high-performance',
        failIfMajorPerformanceCaveat: false
      });
    }

    if (!gl) {
      throw new Error('WebGL not available in worker context');
    }

    console.log('motion.worker: WebGL context created:', gl instanceof WebGL2RenderingContext ? 'WebGL2' : 'WebGL1');

    // ========================================
    // STEP 4: Create THREE.js Renderer
    // ========================================
    try {
      _threeRenderer = new THREE.WebGLRenderer({
        canvas: canvas,
        context: gl,
        alpha: false,
        antialias: false,
      });
      
      console.log('motion.worker: THREE.WebGLRenderer created');
      
      try {
        _threeRenderer.setSize(width, height, false);
        console.log('motion.worker: Renderer size set to', width, 'x', height);
      } catch (sizeErr) {
        console.warn('motion.worker: setSize failed, trying manual approach', sizeErr);
        
        _threeRenderer.domElement = canvas;
        if (_threeRenderer.domElement) {
          _threeRenderer.domElement.width = width;
          _threeRenderer.domElement.height = height;
        }
        
        if (_threeRenderer.setViewport) {
          _threeRenderer.setViewport(0, 0, width, height);
        }
      }
      
    } catch (rendererErr) {
      console.error('motion.worker: THREE.WebGLRenderer creation failed', rendererErr);
      throw rendererErr;
    }

    // ========================================
    // STEP 5: Install Context Loss Handlers
    // ========================================
    try {
      const handleContextLost = (event) => {
        event.preventDefault();
        console.error('motion.worker: WebGL context lost');
        _threeRenderer = null;
        _threeInitialized = false;
        _threeInitError = new Error('WebGL context lost');

        _bcPost({
          event: 'WEBGL_CONTEXT_LOST',
          msgId: generateMsgId(),
          timestamp: Date.now()
        });
      };

      const handleContextRestored = async () => {
        console.log('motion.worker: WebGL context restored, reinitializing');
        _threeInitialized = false;
        _threeInitError = null;
        await _initThreeRenderer();
      };

      if (canvas.addEventListener) {
        canvas.addEventListener('webglcontextlost', handleContextLost);
        canvas.addEventListener('webglcontextrestored', handleContextRestored);
        console.log('motion.worker: Context loss handlers installed');
      } else if (gl.canvas && gl.canvas.addEventListener) {
        gl.canvas.addEventListener('webglcontextlost', handleContextLost);
        gl.canvas.addEventListener('webglcontextrestored', handleContextRestored);
        console.log('motion.worker: Context loss handlers installed (via gl.canvas)');
      } else {
        console.warn('motion.worker: Cannot install context loss handlers (OffscreenCanvas limitation)');
      }
    } catch (eventErr) {
      console.warn('motion.worker: Context loss handler setup failed (non-fatal)', eventErr);
    }

    // ========================================
    // STEP 6: Verify Renderer State
    // ========================================
    console.log('motion.worker: Verifying renderer state...');
    console.log('  - Renderer exists:', !!_threeRenderer);
    console.log('  - Canvas exists:', !!(_threeRenderer && _threeRenderer.domElement));
    
    // ✅ HARDENED: Safe context retrieval
    const verifyCtx = safeGetRendererContext(_threeRenderer);
    console.log('  - Context exists:', !!verifyCtx);
    if (verifyCtx) {
      console.log('  - Context type:', verifyCtx instanceof WebGL2RenderingContext ? 'WebGL2' : 'WebGL1');
      console.log('  - Context lost:', verifyCtx.isContextLost ? verifyCtx.isContextLost() : 'unknown');
    }
    
    if (_threeRenderer && _threeRenderer.domElement) {
      console.log('  - Canvas size:', _threeRenderer.domElement.width, 'x', _threeRenderer.domElement.height);
    }

    // ✅ HARDENED: Validate renderer
    try {
      validateRenderer(_threeRenderer);
    } catch (validationErr) {
      console.error('motion.worker: Renderer validation failed', validationErr);
      throw validationErr;
    }

    _threeInitialized = true;
    _threeInitError = null;

    console.log('motion.worker: ✅ THREE.js renderer initialized successfully');
    return _threeRenderer;

  } catch (err) {
    console.error('motion.worker: ❌ THREE.js initialization failed', err);
    console.error('  Error type:', err.constructor.name);
    console.error('  Error message:', err.message);
    console.error('  Stack:', err.stack);
    
    _threeInitialized = false;
    _threeInitError = err;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// GPU Resource Management
// ---------------------------------------------------------------------------

function _trackResource(resource, type) {
  if (_gpuResources[type]) {
    _gpuResources[type].add(resource);
  }
  return resource;
}

function _disposeAllGPUResources() {
  for (const [type, set] of Object.entries(_gpuResources)) {
    for (const resource of set) {
      try {
        if (resource && typeof resource.dispose === 'function') {
          resource.dispose();
        }
      } catch (e) {
        console.warn(`motion.worker: Failed to dispose ${type}`, e);
      }
    }
    set.clear();
  }
}

function _cleanupAfterReconstruction() {
  if (_trianglePreprocessor && typeof _trianglePreprocessor.dispose === 'function') {
    try {
      _trianglePreprocessor.dispose();
    } catch (e) {
      console.warn('motion.worker: trianglePreprocessor.dispose error', e);
    }
  }
  _trianglePreprocessor = null;

  if (_overhangPreprocessor && typeof _overhangPreprocessor.dispose === 'function') {
    try {
      _overhangPreprocessor.dispose();
    } catch (e) {
      console.warn('motion.worker: overhangPreprocessor.dispose error', e);
    }
  }
  _overhangPreprocessor = null;

  _disposeAllGPUResources();
}

// ---------------------------------------------------------------------------
// Fallback CPU-Only Depth Estimation
// ---------------------------------------------------------------------------

/**
 * _fallbackDepthEstimation(frameBitmap, resolution)
 * CPU-only depth estimation using luminance-based heuristic
 * Used when THREE.js/WebGL unavailable
 */
async function _fallbackDepthEstimation(frameBitmap, resolution) {
  console.warn('motion.worker: Using CPU fallback depth estimation');

  const canvas = new OffscreenCanvas(resolution, resolution);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(frameBitmap, 0, 0, resolution, resolution);
  const imageData = ctx.getImageData(0, 0, resolution, resolution);
  const data = imageData.data;

  const count = resolution * resolution;
  const depths = new Float32Array(count);
  const normals3D = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];

    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    depths[i] = 0.1 + (1.0 - lum / 255.0) * 2.0;

    normals3D[i * 3] = 0;
    normals3D[i * 3 + 1] = 0;
    normals3D[i * 3 + 2] = 1;
  }

  return {
    depthMap: {
      resolution,
      data: depths,
      min: 0.1,
      max: 2.1,
      encoding: 'float32',
      fallback: true
    },
    normalMap: {
      resolution,
      data: normals3D,
      encoding: 'xyz-float32',
      fallback: true
    },
    fluxData: null,
    telemetry: {
      method: 'cpu_fallback',
      total_ms: 0
    }
  };
}

// ---------------------------------------------------------------------------
// Utility: choose resolution adaptively
// ---------------------------------------------------------------------------

function chooseResolutionForJob(options = {}, flags = {}, hardwareInfo = {}) {
  const p = Number.isFinite(options.priority) ? options.priority : 50;
  const hwLimited = !!(hardwareInfo && hardwareInfo.hardwareLimited);
  const defs = DEFAULTS.defaultResolutions;
  if (p >= 80 && !hwLimited) return defs.high;
  if (p >= 50 && !hwLimited) return defs.normal;
  if (p >= 50 && hwLimited) return Math.floor((defs.normal + defs.low) / 2);
  return defs.low;
}

// ============================================================================
// GPU CAPABILITY DETECTION (cached)
// ============================================================================

async function _detectGPUCapabilities() {
  if (_gpuCapabilities) return _gpuCapabilities;
  
  try {
    const renderer = await _initThreeRenderer();
    validateRenderer(renderer); // ✅ HARDENED: Validate before use
    
    const gl = safeGetRendererContext(renderer); // ✅ HARDENED: Safe context retrieval
    if (!gl) {
      throw new Error('Could not retrieve WebGL context from renderer');
    }
    
    const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;

    // Float texture support:
    // - WebGL2: float textures (RGBA32F) are core. The WebGL1 extension
    //   OES_texture_float does not exist in WebGL2 and returns null, but
    //   float DataTexture + FloatType render targets work natively.
    //   EXT_color_buffer_float must be enabled for float *render targets*
    //   (readback via readRenderTargetPixels), which Horn-Schunck requires.
    // - WebGL1: OES_texture_float extension required.
    let floatTexturesSupported = false;
    if (isWebGL2) {
      // Enable float render targets (required for readRenderTargetPixels)
      const extFloat = gl.getExtension('EXT_color_buffer_float');
      floatTexturesSupported = !!extFloat;
      if (!floatTexturesSupported) {
        console.warn('motion.worker: EXT_color_buffer_float not available — float render targets disabled, falling back to 8-bit textures');
      }
    } else {
      floatTexturesSupported = !!gl.getExtension('OES_texture_float');
    }

    _gpuCapabilities = {
      available: true,
      isWebGL2,
      maxTextureSize:       gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxTextureUnits:      gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
      floatTexturesSupported
    };
    
    console.log('motion.worker: GPU capabilities detected', _gpuCapabilities);
  } catch (err) {
    _gpuCapabilities = { 
      available: false, 
      error: err.message || String(err) 
    };
    console.warn('motion.worker: GPU detection failed', err);
  }
  
  return _gpuCapabilities;
}

// ============================================================================
// BUFFER SIZE POLICY
// ============================================================================

function _getDirectionalLiftingBufferSize(resolution) {
  if (Number.isInteger(_flags.dirLiftBufferSize) && _flags.dirLiftBufferSize > 0) {
    return _flags.dirLiftBufferSize;
  }
  
  const maxBufferMB = _flags.dirLiftMaxBufferMB || 32;
  const bytesPerField = resolution * resolution * 4 * 4;
  const maxBufferSize = Math.floor((maxBufferMB * 1024 * 1024) / bytesPerField);
  
  if (resolution <= 256) return Math.min(8, maxBufferSize || 8);
  if (resolution <= 512) return Math.min(8, maxBufferSize || 8);
  if (resolution <= 1024) return Math.min(6, maxBufferSize || 6);
  // large resolutions: prefer small buffers to limit memory
  return Math.min(4, Math.max(1, maxBufferSize || 4));
}

// ============================================================================
// LAZY MODULE GETTERS
// ============================================================================

function _getCalibratedProducer() {
  if (!_calibratedProducer) {
    _calibratedProducer = new CalibratedFieldProducer({
      resolution: 512,
      enableMultiSpectral: false,
      debug: _flags.calibDebug || false
    });
  }
  return _calibratedProducer;
}

function _getTetrachromacy() {
  if (!_tetrachromacy) {
    _tetrachromacy = new Tetrachromacy({
      enableOpponentChannels: true,
      enableChromaticity: true,
      enableTemporalStats: false,
      debug: _flags.tetraDebug || false
    });
  }
  return _tetrachromacy;
}

async function _getDirectionalLifting(resolution, frameRateHz = null) {
  if (!_directionalLifting) {
    const bufferSize = _getDirectionalLiftingBufferSize(resolution);
    const decayFactor = 0.8;
    
    _directionalLifting = new DirectionalLifting({
      bufferSize,
      weightingMode: 'exponential',
      decayFactor,
      enableDerivatives: true,
      debug: _flags.dirLiftDebug || false
    });

    // --- Stage 0: compute effectiveWindowMs ---
    // Priority order for frameRate source:
    // 1. frameRateHz argument — passed from manifest.data.plenopticContext.frameRate,
    //    which was snapshotted by FrameEvictionHook._enhanceMetadata() at capture time.
    //    This is the authoritative value: it reflects the actual camera, is available
    //    synchronously, and needs no await or flags bridge.
    // 2. _flags.frameRateHz — only present if something explicitly bridges camera
    //    metadata into feature flags (not currently done). Kept as a secondary fallback.
    // 3. 30fps — only if neither of the above is available (e.g. synthetic/file sources
    //    that genuinely have no declared frame rate).
    const resolvedFrameRateHz =
      (Number.isFinite(frameRateHz) && frameRateHz > 0) ? frameRateHz :
      (Number.isFinite(_flags.frameRateHz) && _flags.frameRateHz > 0) ? _flags.frameRateHz :
      30;
    const frameIntervalMs = 1000 / resolvedFrameRateHz;
    const geometricSum = (1 - Math.pow(decayFactor, bufferSize)) / (1 - decayFactor);
    _effectiveWindowMs = frameIntervalMs * geometricSum;
    // --- End Stage 0 ---
    
    console.log(
      `motion.worker: DirectionalLifting initialized — ` +
      `bufferSize=${bufferSize}, resolution=${resolution}, ` +
      `frameRateHz=${resolvedFrameRateHz} (source: ${
        (Number.isFinite(frameRateHz) && frameRateHz > 0) ? 'manifest.plenopticContext' :
        (Number.isFinite(_flags.frameRateHz) && _flags.frameRateHz > 0) ? '_flags' :
        'fallback-30fps'
      }), effectiveWindowMs=${_effectiveWindowMs.toFixed(1)}ms`
    );
  }
return _directionalLifting;
}

// --- Stage 1: PenumbraAnalyzer lazy singleton ---
// Follows the same pattern as _getCalibratedProducer and _getTetrachromacy.
// Options are resolved from _flags at first call so runtime flag overrides apply.
function _getPenumbraAnalyzer() {
  if (!_penumbraAnalyzer) {
    _penumbraAnalyzer = new PenumbraAnalyzer({
      profileWindowPx:     _flags.penumbraProfileWindow   || 17,
      brightnessThreshold: _flags.penumbraBrightnessThresh || 0.75,
      minEdgeGradient:     _flags.penumbraMinEdgeGrad      || 0.05,
      minEdgeLength:       _flags.penumbraMinEdgeLength    || 8,
      maxLightSources:     _flags.penumbraMaxLights        || 8,
      minFitR2:            _flags.penumbraMinFitR2         || 0.6,
      stabilityWeight:     _flags.penumbraStabilityWeight  || 0.6,
      debug:               _flags.penumbraDebug            || false
    });
    console.log('motion.worker: PenumbraAnalyzer initialized');
  }
  return _penumbraAnalyzer;
}

/**
 * _getDifferentialGeometry
 * Lazy-initialises the DifferentialGeometry singleton.
 * The storageWrapper is passed at call time so the module stays stateless.
 */
function _getDifferentialGeometry() {
  if (!_diffGeo) {
    _diffGeo = new DifferentialGeometry({ flags: _flags });   // no storageWrapper — passed per-call
    console.log('motion.worker: DifferentialGeometry initialized');
  }
  return _diffGeo;
}

/**
 * _getPackingSDF
 *
 * Lazy-initialises the singleton PackingSDF instance.
 * Re-reads _flags on first call per worker lifetime so flag changes
 * that arrive between reconstruction jobs are honoured without restarting
 * the worker.
 *
 * @returns {PackingSDF}
 */
function _getPackingSDF() {
  if (!_packingSDF) {
    _packingSDF = new PackingSDF({
      // Narrow band
      bandBase:    safeNumeric(_flags.packingBandBase,    0.03, 0.001, 0.5),
      bandScale:   safeNumeric(_flags.packingBandScale,   3.0,  0.1,   20),
      falloffExp:  safeNumeric(_flags.packingFalloffExp,  2.0,  0.5,   6),

      // Seeding
      seedRMin:         safeNumeric(_flags.packingSeedRMin,    0.01,  0.001, 0.5),
      seedRMax:         safeNumeric(_flags.packingSeedRMax,    0.08,  0.01,  1.0),
      samplerMaxPoints: Math.max(64, Math.floor(_flags.packingMaxSeeds ?? 2048)),
      samplerMinPoints: 64,
      samplerSeed:      _flags.packingSamplerSeed ?? 0xF1E2D3C4,

      // Umbra policy: 'half-weight' | 'include' | 'exclude'
      umbraPolicy: _flags.packingUmbraPolicy ?? 'half-weight',

      // Density smoothing
      densitySmoothRadius: Math.max(1, Math.floor(_flags.packingDensitySmooth ?? 4)),

      // Debug
      enableDebug: !!_flags.packingDebug
    });
    console.log('motion.worker: PackingSDF initialized');
  }
  return _packingSDF;
}

// ============================================================================
// BUMP MAP COMPUTATION (Laplacian + Optional Stddev Fusion)
// ============================================================================

/**
 * Compute bump map from intensity using Laplacian magnitude
 */
function _computeBumpFromIntensity(intensityField, resolution, options = {}) {
  const bumpScale = options.bumpScale || _flags.bumpScale || 1.0;
  const fusionMode = options.fusionMode || _flags.bumpFusionMode || false;

  // ✅ HARDENED: Validate inputs
  validateBuffer(intensityField, resolution * resolution, 'intensityField');
  
  const count = resolution * resolution;
  const bumpField = new Float32Array(count * 4);
  
  const laplacian = (x, y) => {
    const idx = y * resolution + x;
    const center = intensityField[idx] * 8;
    
    let neighbors = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < resolution && ny >= 0 && ny < resolution) {
          neighbors += intensityField[ny * resolution + nx];
        }
      }
    }
    
    return Math.abs(center - neighbors);
  };
  
  const localStddev = fusionMode ? (x, y) => {
    let sum = 0, sum2 = 0, n = 0;
    
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < resolution && ny >= 0 && ny < resolution) {
          const v = intensityField[ny * resolution + nx];
          sum += v;
          sum2 += v * v;
          n++;
        }
      }
    }
    
    const mean = sum / n;
    const variance = (sum2 / n) - (mean * mean);
    return Math.sqrt(Math.max(0, variance));
  } : null;
  
  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const idx = y * resolution + x;
      
      let bump = laplacian(x, y) * bumpScale;
      
      if (fusionMode && localStddev) {
        const stddev = localStddev(x, y);
        bump = 0.7 * bump + 0.3 * stddev;
      }
      
      bump = Math.min(1.0, bump / 8.0);
      
      bumpField[idx * 4 + 0] = bump;
      bumpField[idx * 4 + 1] = bump;
      bumpField[idx * 4 + 2] = bump;
      bumpField[idx * 4 + 3] = 1.0;
    }
  }
  
  return bumpField;
}

// ============================================================================
// NORMAL MAP COMPUTATION (Sobel Filter)
// ============================================================================

function _computeNormalFromBump(bumpField, resolution, normalScale = 1.0) {
  const scale = normalScale || _flags.normalScale || 1.0;
  // ✅ HARDENED: Validate inputs
  validateBuffer(bumpField, resolution * resolution * 4, 'bumpField');
  const count = resolution * resolution;
  const normalField = new Float32Array(count * 4);
  
  const sobelX = (x, y) => {
    if (x < 1 || x >= resolution - 1 || y < 1 || y >= resolution - 1) return 0;
    
    const get = (dx, dy) => bumpField[((y + dy) * resolution + (x + dx)) * 4];
    
    return (
      -1 * get(-1, -1) + 1 * get(1, -1) +
      -2 * get(-1,  0) + 2 * get(1,  0) +
      -1 * get(-1,  1) + 1 * get(1,  1)
    ) / 8.0;
  };
  
  const sobelY = (x, y) => {
    if (x < 1 || x >= resolution - 1 || y < 1 || y >= resolution - 1) return 0;
    
    const get = (dx, dy) => bumpField[((y + dy) * resolution + (x + dx)) * 4];
    
    return (
      -1 * get(-1, -1) - 2 * get(0, -1) - 1 * get(1, -1) +
       1 * get(-1,  1) + 2 * get(0,  1) + 1 * get(1,  1)
    ) / 8.0;
  };
  
  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const idx = y * resolution + x;
      
      const dx = sobelX(x, y) * scale;
      const dy = sobelY(x, y) * scale;
      
      const nx = -dx;
      const ny = -dy;
      const nz = 1.0;
      
      const len = Math.sqrt(nx*nx + ny*ny + nz*nz);
      
      normalField[idx * 4 + 0] = nx / len;
      normalField[idx * 4 + 1] = ny / len;
      normalField[idx * 4 + 2] = nz / len;
      normalField[idx * 4 + 3] = 1.0;
    }
  }
  
  return normalField;
}

// ============================================================================
// SPECULAR MASK COMPUTATION
// ============================================================================

function _computeSpecularMask(intensityField, chromaticity, resolution, options = {}) {
  // ✅ HARDENED: Validate inputs
  validateBuffer(intensityField, resolution * resolution, 'intensityField');
  if (!chromaticity || !chromaticity.chromaR || !chromaticity.chromaG || !chromaticity.chromaB) {
    throw new Error('[SpecularMask] Invalid chromaticity object');
  }
  validateBuffer(chromaticity.chromaR, resolution * resolution, 'chromaticity.chromaR');
  validateBuffer(chromaticity.chromaG, resolution * resolution, 'chromaticity.chromaG');
  validateBuffer(chromaticity.chromaB, resolution * resolution, 'chromaticity.chromaB');
  
  const hpGain = safeNumeric(options.hpGain || _flags.specularHpGain, 4.0, 0, 100);
  const alpha = safeNumeric(options.alpha || _flags.specularAlpha, 0.5, 0, 1);
  const chromaScale = safeNumeric(options.chromaScale || _flags.specularChromaScale, 3.0, 0, 100);
  const threshold = safeNumeric(options.threshold || _flags.specularThreshold, 0.15, 0, 1);
  
  const count = resolution * resolution;
  const maskField = new Float32Array(count * 4);
  
  const lowpass = new Float32Array(count);
  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < resolution && ny >= 0 && ny < resolution) {
            sum += intensityField[ny * resolution + nx];
            n++;
          }
        }
      }
      lowpass[y * resolution + x] = sum / n;
    }
  }
  
  for (let i = 0; i < count; i++) {
    const L = intensityField[i];
    const low = lowpass[i];
    const HP = Math.max(0, L - low);
    
    const chromaR = chromaticity.chromaR[i];
    const chromaG = chromaticity.chromaG[i];
    const chromaB = chromaticity.chromaB[i];
    
    const dR = chromaR - (1.0 / 3.0);
    const dG = chromaG - (1.0 / 3.0);
    const dB = chromaB - (1.0 / 3.0);
    const CM = Math.sqrt(dR*dR + dG*dG + dB*dB);
    
    const chromaScore = 1.0 - Math.min(1.0, CM * chromaScale);
    
    let mask = (HP * hpGain) * (alpha + (1.0 - alpha) * chromaScore);
    mask = Math.max(0, Math.min(1.0, mask));
    
    if (mask < threshold) mask = 0;
    
    maskField[i * 4 + 0] = mask;
    maskField[i * 4 + 1] = mask;
    maskField[i * 4 + 2] = mask;
    maskField[i * 4 + 3] = 1.0;
  }
  
  return maskField;
}

 /* _computeDOAAndModal
 *
 * Computes two groups of per-pixel quantities from the already-available
 * pipeline outputs — no depth or GPU required.
 *
 * GROUP 1: Direction-of-Arrival (DOA)
 *   kappa    — angular concentration of incoming light at each pixel.
 *              High kappa (>kappaThreshold): dominant direction is tightly
 *              focused → point-like source, likely direct illumination.
 *              Low kappa (<1): broad spread → diffuse or skylight.
 *   meanDir  — unit vector (x,y in image tangent plane) pointing toward
 *              the dominant incoming direction, derived from the gradient
 *              of the directional field's primary channel.
 *
 * GROUP 2: Modal light-transport probabilities
 *   Four fields that sum to 1.0 per pixel:
 *   direct      — fraction explained by straight-line source rays
 *   diffuse     — fraction from area/skylight transport
 *   specular    — fraction from single-bounce specular reflection
 *   multiBounce — fraction from multiply-scattered indirect transport
 *
 * These feed modal_decomposition artifact (Stage 1) and the DOA histogram
 * stored in that artifact for use by Stage 7 (TopologicalCorrespondence).
 *
 * @param {Float32Array} directionalField  res²×4, from DirectionalLifting
 * @param {Float32Array} tetraField        res²×4, from Tetrachromacy
 * @param {Object}       coherence         { perPixel: Float32Array[res²] }
 * @param {Float32Array} specularMask      res²×4, from _computeSpecularMask
 * @param {Object}       chromaticity      { chromaR, chromaG, chromaB }
 * @param {number}       resolution
 * @returns {{
 *   kappa:       Float32Array,   res²
 *   meanDir:     Float32Array,   res²×2  (x,y pairs)
 *   direct:      Float32Array,   res²
 *   diffuse:     Float32Array,   res²
 *   specular:    Float32Array,   res²
 *   multiBounce: Float32Array,   res²
 *   telemetry:   Object
 * }}
 */
function _computeDOAAndModal(
  directionalField, tetraField, coherence, specularMask, chromaticity, resolution
) {
  const startTime = performance.now();
  const count     = resolution * resolution;

  const kappa        = new Float32Array(count);
  const meanDir      = new Float32Array(count * 2);
  const direct       = new Float32Array(count);
  const diffuseOut   = new Float32Array(count);   // named diffuseOut to avoid shadowing
  const specularOut  = new Float32Array(count);
  const multiBounce  = new Float32Array(count);

  // coherence.perPixel: temporal stability proxy for visible fraction f(P).
  // High coherence → pixel barely changed across DirectionalLifting's buffer
  // → geometrically stable → more likely to be direct-dominated.
  const perPixel = (coherence && coherence.perPixel instanceof Float32Array)
    ? coherence.perPixel
    : new Float32Array(count).fill(0.5);

  // kappaThreshold: the concentration value separating point-like (direct)
  // from diffuse. Above this value the incoming distribution is tight enough
  // to be modelled as a direct ray. Empirically 3.0 works for indoor scenes;
  // expose via flags for outdoor and studio scenarios.
  const kappaThreshold = Number.isFinite(_flags.doaKappaThreshold)
    ? _flags.doaKappaThreshold
    : 3.0;

  // ── Per-pixel loop ────────────────────────────────────────────────────────
  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const i    = y * resolution + x;
      const base = i * 4;

      // ── Kappa: gradient magnitude of directional field ─────────────────
      // Central differences on all three colour channels; border pixels
      // use one-sided differences (clamped indices).
      const xl = Math.max(0, x - 1);
      const xr = Math.min(resolution - 1, x + 1);
      const yu = Math.max(0, y - 1);
      const yd = Math.min(resolution - 1, y + 1);

      const df = (ch, px, py) =>
        directionalField[(py * resolution + px) * 4 + ch];

      let gradSqSum  = 0;
      let gxPrimary  = 0;
      let gyPrimary  = 0;

      for (let ch = 0; ch < 3; ch++) {
        const gx = (df(ch, xr, y) - df(ch, xl, y)) * 0.5;
        const gy = (df(ch, x, yd) - df(ch, x, yu)) * 0.5;
        gradSqSum += gx * gx + gy * gy;
        if (ch === 0) { gxPrimary = gx; gyPrimary = gy; }   // R channel for direction
      }

      // Normalise by local field magnitude so kappa is scale-independent.
      // A high gradient in a dim field means less directional change than
      // the same gradient in a bright field.
      const localMag = Math.sqrt(
        directionalField[base]   * directionalField[base]   +
        directionalField[base+1] * directionalField[base+1] +
        directionalField[base+2] * directionalField[base+2]
      ) + 1e-6;

      kappa[i] = Math.sqrt(gradSqSum) / localMag;

      // ── Mean direction ─────────────────────────────────────────────────
      const gLen = Math.sqrt(gxPrimary * gxPrimary + gyPrimary * gyPrimary) + 1e-9;
      meanDir[i * 2]     = gxPrimary / gLen;
      meanDir[i * 2 + 1] = gyPrimary / gLen;

      // ── Modal decomposition ────────────────────────────────────────────
      // f proxy: coherence (high = stable = more direct)
      const coh     = perPixel[i];
      // Specular: R channel of specularMask (already in [0,1])
      const specVal = specularMask ? specularMask[base] : 0;

      // Multi-bounce: low coherence AND low f proxy.
      // Squaring sharpens the response so only genuinely indirect pixels
      // are labelled multi-bounce rather than mildly penumbral ones.
      multiBounce[i] = Math.min(1.0, (1.0 - coh) * (1.0 - coh));

      // Specular: attenuated in multi-bounce zones because multiply-scattered
      // light cannot form the sharp highlights that specularMask detects.
      specularOut[i] = Math.min(1.0, specVal * (1.0 - multiBounce[i] * 0.5));

      // Remaining budget for direct + diffuse
      const remaining = Math.max(0.0, 1.0 - specularOut[i] - multiBounce[i]);

      // Direct: high coherence × kappa sigmoid.
      // The sigmoid smoothly gates at kappaThreshold rather than a hard step
      // so intermediate-concentration distributions are partially direct.
      const kSig    = 1.0 / (1.0 + Math.exp(-(kappa[i] - kappaThreshold)));
      direct[i]     = remaining * coh * kSig;
      diffuseOut[i] = Math.max(0.0, remaining - direct[i]);

      // Enforce exact sum = 1.0 per pixel to correct floating-point drift
      const total = direct[i] + diffuseOut[i] + specularOut[i] + multiBounce[i];
      if (total > 1e-6) {
        direct[i]      /= total;
        diffuseOut[i]  /= total;
        specularOut[i] /= total;
        multiBounce[i] /= total;
      } else {
        // Degenerate (all-dark pixel): classify as diffuse
        diffuseOut[i] = 1.0;
      }
    }
  }

  // ── Summary telemetry ─────────────────────────────────────────────────────
  let sumKappa = 0;
  let highKappaCnt = 0;   // kappa > threshold: point-like
  let lowKappaCnt  = 0;   // kappa < 1.0:       diffuse
  for (let i = 0; i < count; i++) {
    sumKappa += kappa[i];
    if (kappa[i] > kappaThreshold) highKappaCnt++;
    if (kappa[i] < 1.0)            lowKappaCnt++;
  }

  return {
    kappa,
    meanDir,
    direct:      direct,
    diffuse:     diffuseOut,
    specular:    specularOut,
    multiBounce,
    telemetry: {
      processingMs:  (performance.now() - startTime).toFixed(2),
      meanKappa:     (sumKappa / count).toFixed(4),
      pointLikeFrac: (highKappaCnt / count).toFixed(4),
      diffuseFrac:   (lowKappaCnt  / count).toFixed(4),
      kappaThreshold
    }
  };
}

// CHANGE B — _computeFMapRouteB()
/**
 * _computeFMapRouteB
 *
 * Immediate visible-fraction proxy using DirectionalLifting coherence.
 * No depth required. Executes in the CPU parallel branch while the GPU
 * pipeline computes depth.
 *
 * Rationale:
 *   coherence.perPixel measures temporal stability — how little each pixel
 *   changed across the rolling buffer window. Stable pixels are more likely
 *   to be directly illuminated (direct illumination is geometrically fixed;
 *   indirect / multi-bounce light fluctuates). Coherence is therefore a
 *   first-order proxy for f(P).
 *
 * This result is persisted immediately as the directness_field artifact.
 * When Route A completes (after depth is available), its result replaces
 * this artifact via a second persist call with the same key convention,
 * and the route field changes from 'temporal_proxy' to 'depth_mc'.
 *
 * @param {Float32Array|null} coherencePerPixel  coherence.perPixel, length res²
 * @param {number}            resolution
 * @returns {{
 *   fMap:        Float32Array,  [0,1] proxy for visible fraction, res²
 *   directness:  Float32Array,  D/(D+S) proxy, res²
 *   modalLabels: Uint8Array,    0=UMBRA 1=PENUMBRA 2=DIRECT, res²
 *   route:       'temporal_proxy',
 *   N_samples:   0
 * }}
 */
function _computeFMapRouteB(coherencePerPixel, resolution) {
  const count       = resolution * resolution;
  const fMap        = new Float32Array(count);
  const directness  = new Float32Array(count);
  const modalLabels = new Uint8Array(count);

  const directThresh = Number.isFinite(_flags.fMapDirectThresh) ? _flags.fMapDirectThresh : 0.9;
  const umbraThresh  = Number.isFinite(_flags.fMapUmbraThresh)  ? _flags.fMapUmbraThresh  : 0.1;

  for (let i = 0; i < count; i++) {
    const coh = (coherencePerPixel && coherencePerPixel[i] != null)
      ? coherencePerPixel[i]
      : 0.5;

    fMap[i]       = coh;
    directness[i] = coh;

    if      (coh >= directThresh) modalLabels[i] = 2;   // DIRECT
    else if (coh <= umbraThresh)  modalLabels[i] = 0;   // UMBRA
    else                          modalLabels[i] = 1;   // PENUMBRA
  }

  return { fMap, directness, modalLabels, route: 'temporal_proxy', N_samples: 0 };
}

// CHANGE C — _computeFMapRouteA()
/**
 * _computeFMapRouteA
 *
 * Monte Carlo visible-fraction map using screen-space depth buffer occlusion.
 * Runs AFTER depth is available (i.e. after the GPU branch of Promise.all).
 *
 * Algorithm:
 *   1. Locate the primary light source from lightTrack (PenumbraAnalyzer output).
 *      Fall back to frame centre-top if no lightTrack is available.
 *   2. Sample N source points around the source centre using stratified
 *      polar sampling. Importance-weight each sample by the Fresnel density
 *      map: Fresnel-zone boundaries coincide with penumbra edges, so this
 *      concentrates samples where the visibility transition is sharpest and
 *      where Monte Carlo variance matters most.
 *   3. For each pixel P, march from P toward each source sample S along the
 *      screen-space ray in (marchSteps) discrete steps. At each step, compare
 *      the depth buffer value against the linearly interpolated ray depth.
 *      If the buffer is shallower by more than occlusionBias, the ray is
 *      occluded and the source sample is invisible from P.
 *   4. f(P) = sum(weights of visible samples) — already normalised to [0,1]
 *      because all sample weights are normalised to sum to 1.0.
 *
 * Screen-space march limitations:
 *   Correctly handles planar and gently curved occluders.
 *   May misclassify concave geometry or silhouette edges at working resolution.
 *   Route B coherence proxy is retained as the fallback if this fails.
 *
 * @param {Object}            depthMap         { data: Float32Array, resolution, min, max }
 * @param {Float32Array}      calibratedField  res²×4
 * @param {number}            resolution
 * @param {Array}             lightTrack       [{imageXY, conf, radius, centroidI}]
 * @param {Float32Array|null} fresnelDensityMap  length res², importance prior
 * @param {Object}            samplingContext  from _buildSamplingContext()
 * @param {Object}            [options]
 * @param {number}            [options.N_samples=128]
 * @returns {{
 *   fMap:        Float32Array,
 *   directness:  Float32Array,
 *   modalLabels: Uint8Array,
 *   route:       'depth_mc',
 *   N_samples:   number
 * }}
 */
function _computeFMapRouteA(
  depthMap, calibratedField, resolution,
  lightTrack, fresnelDensityMap, samplingContext, options = {}
) {
  const t0         = performance.now();
  const count      = resolution * resolution;
  const N          = Math.max(8, Math.min(512, options.N_samples ?? 128));

  const fMap        = new Float32Array(count);
  const directness  = new Float32Array(count);
  const modalLabels = new Uint8Array(count);

  const depths     = depthMap.data;
  const depthMin   = depthMap.min ?? 0;
  const depthRange = Math.max(1e-6, (depthMap.max ?? 2) - depthMin);

  const directThresh  = Number.isFinite(_flags.fMapDirectThresh)  ? _flags.fMapDirectThresh  : 0.9;
  const umbraThresh   = Number.isFinite(_flags.fMapUmbraThresh)   ? _flags.fMapUmbraThresh   : 0.1;
  const occlusionBias = Number.isFinite(_flags.fMapOcclusionBias) ? _flags.fMapOcclusionBias : 0.04;
  const marchSteps    = Number.isInteger(_flags.fMapMarchSteps)   ? _flags.fMapMarchSteps    : 8;

  // ── Source position ───────────────────────────────────────────────────────
  // lightTrack is sorted by confidence descending (PenumbraAnalyzer contract).
  // Fallback: frame centre at 10% from top (typical ceiling fixture position).
  let srcX      = resolution * 0.5;
  let srcY      = resolution * 0.1;
  let srcRadius = Math.max(4, resolution * 0.05);

  if (lightTrack && lightTrack.length > 0) {
    const primary = lightTrack[0];
    srcX      = primary.imageXY[0];
    srcY      = primary.imageXY[1];
    // 1.5× detected radius so samples spread slightly beyond the blob boundary.
    // Prevents all N samples landing on the same pixels when the source is small.
    srcRadius = Math.max(4, primary.radius * 1.5);
  }

  // ── Source depth (average over the source region) ─────────────────────────
  // Light sources at ceiling or window are typically at maximum scene depth.
  let srcDepthSum = 0;
  let srcDepthCnt = 0;
  const srcR2     = srcRadius * srcRadius;

  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const dx = x - srcX;
      const dy = y - srcY;
      if (dx*dx + dy*dy <= srcR2) {
        srcDepthSum += depths[y * resolution + x];
        srcDepthCnt++;
      }
    }
  }
  const srcDepthNorm = srcDepthCnt > 0
    ? (srcDepthSum / srcDepthCnt - depthMin) / depthRange
    : 1.0;

  // ── Importance-sampled source points ─────────────────────────────────────
  // Stratified polar sampling (sqrt(r) for area-uniform radial distribution).
  // Each point is importance-weighted by the Fresnel density map.
  // Fresnel density is high where Fresnel-zone geometry is active, which
  // coincides with penumbra edges — exactly where visibility transitions occur.
  // Without Fresnel map, all weights are 1.0 (uniform sampling).
  const sourcePoints = [];
  let totalWeight    = 0;

  for (let si = 0; si < N; si++) {
    const angle = (si / N) * 2 * Math.PI;
    const rFrac = Math.sqrt((si + 0.5) / N);
    const spx   = srcX + rFrac * srcRadius * Math.cos(angle);
    const spy   = srcY + rFrac * srcRadius * Math.sin(angle);
    const bx    = Math.max(0, Math.min(resolution - 1, Math.round(spx)));
    const by    = Math.max(0, Math.min(resolution - 1, Math.round(spy)));

    let weight = 1.0;
    if (fresnelDensityMap) {
      const fd = fresnelDensityMap[by * resolution + bx] ?? 0;
      // Rescale to [0.1, 1.0]: floor at 0.1 so no sample has zero probability.
      weight = 0.1 + 0.9 * Math.max(0, Math.min(1, fd));
    }

    sourcePoints.push({
      nx: spx / resolution,   // normalised image coordinates
      ny: spy / resolution,
      nd: srcDepthNorm,
      weight
    });
    totalWeight += weight;
  }

  // Normalise weights to form a probability distribution summing to 1.0
  totalWeight = totalWeight || 1;
  for (const sp of sourcePoints) sp.weight /= totalWeight;

  // ── Per-pixel Monte Carlo visibility ─────────────────────────────────────
  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const i       = y * resolution + x;
      const pDepthN = (depths[i] - depthMin) / depthRange;
      const pnx     = x / resolution;
      const pny     = y / resolution;

      let visibleW = 0;

      for (const sp of sourcePoints) {
        const dx = sp.nx - pnx;
        const dy = sp.ny - pny;
        const dd = sp.nd - pDepthN;

        let occluded = false;

        // March intermediate steps (skip step 0 = pixel itself, step N = source)
        for (let step = 1; step < marchSteps && !occluded; step++) {
          const t   = step / marchSteps;
          const mx  = Math.round((pnx + t * dx) * resolution);
          const my  = Math.round((pny + t * dy) * resolution);

          // Ray exits image → source is outside frame → treat as unoccluded
          if (mx < 0 || mx >= resolution || my < 0 || my >= resolution) break;

          const sampledN = (depths[my * resolution + mx] - depthMin) / depthRange;
          const marchN   = pDepthN + t * dd;

          // Occluder: buffer shallower than march ray by more than bias.
          // The bias prevents self-occlusion from depth quantisation errors.
          if (sampledN < marchN - occlusionBias) occluded = true;
        }

        if (!occluded) visibleW += sp.weight;
      }

      fMap[i]       = visibleW;
      directness[i] = visibleW;

      if      (visibleW >= directThresh) modalLabels[i] = 2;
      else if (visibleW <= umbraThresh)  modalLabels[i] = 0;
      else                               modalLabels[i] = 1;
    }
  }

  if (_flags.fMapDebug) {
    console.log(
      `[FMAP-RouteA] N=${N} srcXY=(${srcX.toFixed(1)},${srcY.toFixed(1)}) ` +
      `srcR=${srcRadius.toFixed(1)} srcDepthN=${srcDepthNorm.toFixed(3)} ` +
      `fresnel=${!!fresnelDensityMap} ms=${(performance.now()-t0).toFixed(1)}`
    );
  }

  return { fMap, directness, modalLabels, route: 'depth_mc', N_samples: N };
}

/**
 * _buildSamplingContext
 *
 * Assembles the samplingContext object embedded in every Stage 1 artifact.
 * Captures the Stage 0 sampling geometry so downstream stages
 * (TopologicalCorrespondence, AmbiAnamorph, UR-MD-02) can relate Stage 1
 * outputs back to the temporal window and spatial resolution they were
 * computed at.
 *
 * @param {Object|null} manifest   Full artifact from storageWrapper.getArtifact,
 *                                  or null for calls originating inside
 *                                  _computeDepthNormalsFlux where the manifest
 *                                  is passed via options.manifest.
 * @param {number}      resolution  The gridSize used for this job.
 * @returns {Object}   Frozen samplingContext.
 */
function _buildSamplingContext(manifest, resolution) {
  return Object.freeze({
    reconstructionResolution: resolution,
    effectiveWindowMs:        _effectiveWindowMs,
    plenopticContext:
      (manifest && manifest.data && manifest.data.plenopticContext)
        ? manifest.data.plenopticContext
        : null,
    builtAt: Date.now()
  });
}

// ---------------------------------------------------------------------------
// Heartbeat helpers (ensure reconStatus isn't mistaken as dead)
// ---------------------------------------------------------------------------

async function _startHeartbeat(storageWrapper, reqId, metaKey) {
  if (!storageWrapper || typeof storageWrapper.markReconHeartbeat !== 'function') {
    console.warn('_startHeartbeat: storageWrapper missing markReconHeartbeat');
    return null;
  }
  
  const interval = Number(_flags.heartbeatIntervalMs) || DEFAULTS.heartbeatIntervalMs;
  const maxConsecutiveFails = 5;
  
  let consecutiveFails = 0;
  let heartbeatCount = 0;
  
  const timer = setInterval(async () => {
    try {
      heartbeatCount++;
      
      const result = await storageWrapper.markReconHeartbeat(reqId);
      
      if (!result) {
        consecutiveFails++;
        _metrics.heartbeatMisses = (_metrics.heartbeatMisses || 0) + 1;
        
        console.warn(`Heartbeat miss #${consecutiveFails} for ${metaKey} (reqId: ${reqId})`);
        
        if (consecutiveFails >= maxConsecutiveFails) {
          // Before aborting, verify this job was genuinely displaced and not
          // just a victim of a storage race (e.g. a concurrent invocation of
          // the same manifest called markReconFailed before our first heartbeat).
          // If the reqId in storage no longer matches ours, we were displaced —
          // safe to stop. If it matches or is missing, reset and keep going.
          try {
            const currentStatus = await storageWrapper.getReconStatus(metaKey);
            if (currentStatus?.reqId && currentStatus.reqId !== reqId) {
              // Genuinely displaced by a different job — stop without marking
              // failed (the new owner is responsible for its own lifecycle).
              console.error(`Heartbeat: job ${reqId} displaced by ${currentStatus.reqId} — stopping timer`);
              clearInterval(timer);
            } else {
              // Storage inconsistency or transient failure — reset miss count
              // and keep the job alive. The computation is still running.
              console.warn(`Heartbeat: ${maxConsecutiveFails} misses but reqId still matches — resetting (storage transient?)`);
              consecutiveFails = 0;
            }
          } catch (statusErr) {
            // Can't read status — assume transient, reset and keep going.
            console.warn('Heartbeat: getReconStatus failed during abort check — resetting miss count', statusErr);
            consecutiveFails = 0;
          }
        }
      } else {
        consecutiveFails = 0;
        
        if (_flags.heartbeatDebug) {
          console.debug(`Heartbeat #${heartbeatCount} OK for ${metaKey} (reqId: ${reqId})`);
        }
      }
    } catch (err) {
      consecutiveFails++;
      _metrics.lastError = String(err);
      console.error(`Heartbeat exception (#${consecutiveFails}):`, err);
      
      if (consecutiveFails >= maxConsecutiveFails) {
        console.error(`Too many heartbeat exceptions - stopping timer for ${metaKey}`);
        clearInterval(timer);
      }
    }
  }, interval);
  
  return timer;
}

function _stopHeartbeat(timer) {
  try {
    if (timer) clearInterval(timer);
  } catch (e) {
    // ignore
  }
}

/**
 * GPU-accelerated Horn-Schunck optical flow via WebGL ping-pong iterations.
 * All GPU resources (textures, RTs, materials) are created and disposed within
 * this call — no persistent GPU state left behind.
 *
 * Cost guide (upload + 30 passes + readback):
 *   512² → ~5ms   |   1024² → ~15ms
 *
 * @param {object}       THREE       - THREE.js module namespace
 * @param {WebGLRenderer} renderer   - Existing worker renderer
 * @param {Float32Array} It          - Temporal derivative,   length w×h
 * @param {Float32Array} Ix          - Spatial derivative X,  length w×h
 * @param {Float32Array} Iy          - Spatial derivative Y,  length w×h
 * @param {number}       width
 * @param {number}       height
 * @param {number}       alpha       - Smoothness weight [0.1, 10]
 * @param {number}       iterations  - Ping-pong passes [10, 100]
 * @returns {{ u: Float32Array, v: Float32Array, width, height, processingMs }}
 */
function _runHornSchunck(THREE, renderer, It, Ix, Iy, width, height, alpha, iterations) {
  const t0    = performance.now();
  const count = width * height;

  if (It.length !== count || Ix.length !== count || Iy.length !== count) {
    throw new Error(`_runHornSchunck: field length mismatch (expected ${count})`);
  }

  const alpha2 = alpha * alpha;

  // ── Input textures (scalar → RGBA, scalar in R channel) ──────────────────
  // RGBA used throughout for maximum WebGL1/WebGL2 compatibility.
  const packScalar = (src) => {
    const rgba = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) rgba[i * 4] = src[i];
    return rgba;
  };

  const makeInputTex = (data) => {
    const tex = new THREE.DataTexture(
      packScalar(data), width, height,
      THREE.RGBAFormat, THREE.FloatType
    );
    tex.needsUpdate = true;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  };

  // ── Ping-pong render targets (RG = u,v; stored in R and G channels) ───────
  const makeRT = () => new THREE.WebGLRenderTarget(width, height, {
    format:          THREE.RGBAFormat,
    type:            THREE.FloatType,
    minFilter:       THREE.LinearFilter,
    magFilter:       THREE.LinearFilter,
    wrapS:           THREE.ClampToEdgeWrapping,
    wrapT:           THREE.ClampToEdgeWrapping,
    depthBuffer:     false,
    stencilBuffer:   false,
    generateMipmaps: false
  });

  const texIt = makeInputTex(It);
  const texIx = makeInputTex(Ix);
  const texIy = makeInputTex(Iy);
  let ping = makeRT();   // starts as zero-initialised (no flow)
  let pong = makeRT();

  // ── Shaders ───────────────────────────────────────────────────────────────
  const VS = `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `;

  // Horn-Schunck update: one Gauss-Seidel iteration using the standard
  // 3×3 Laplacian average weights (1/12 at corners, 1/6 at edges).
  const FS = `
    precision highp float;
    uniform sampler2D uFlow;
    uniform sampler2D uIt;
    uniform sampler2D uIx;
    uniform sampler2D uIy;
    uniform float     uAlpha2;
    uniform vec2      uTexel;
    varying vec2      vUv;

    void main() {
      vec2 ts = uTexel;

      vec2 avg =
        (1.0/12.0)*texture2D(uFlow, vUv+vec2(-ts.x,-ts.y)).rg +
        (1.0/ 6.0)*texture2D(uFlow, vUv+vec2( 0.0, -ts.y)).rg +
        (1.0/12.0)*texture2D(uFlow, vUv+vec2( ts.x,-ts.y)).rg +
        (1.0/ 6.0)*texture2D(uFlow, vUv+vec2(-ts.x, 0.0)).rg +
        (1.0/ 6.0)*texture2D(uFlow, vUv+vec2( ts.x, 0.0)).rg +
        (1.0/12.0)*texture2D(uFlow, vUv+vec2(-ts.x, ts.y)).rg +
        (1.0/ 6.0)*texture2D(uFlow, vUv+vec2( 0.0,  ts.y)).rg +
        (1.0/12.0)*texture2D(uFlow, vUv+vec2( ts.x, ts.y)).rg;

      float ix = texture2D(uIx, vUv).r;
      float iy = texture2D(uIy, vUv).r;
      float it = texture2D(uIt, vUv).r;

      float denom  = uAlpha2 + ix*ix + iy*iy;
      float factor = (ix*avg.x + iy*avg.y + it) / max(denom, 1.0e-7);

      gl_FragColor = vec4(avg.x - ix*factor, avg.y - iy*factor, 0.0, 1.0);
    }
  `;

  // ── Scene ─────────────────────────────────────────────────────────────────
  const material = new THREE.ShaderMaterial({
    vertexShader:   VS,
    fragmentShader: FS,
    uniforms: {
      uFlow:   { value: ping.texture },
      uIt:     { value: texIt },
      uIx:     { value: texIx },
      uIy:     { value: texIy },
      uAlpha2: { value: alpha2 },
      uTexel:  { value: new THREE.Vector2(1.0 / width, 1.0 / height) }
    }
  });

  const geo    = new THREE.PlaneGeometry(2, 2);
  const mesh   = new THREE.Mesh(geo, material);
  const scene  = new THREE.Scene();
  const cam    = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  scene.add(mesh);

  // ── Ping-pong iterations ──────────────────────────────────────────────────
  for (let i = 0; i < iterations; i++) {
    material.uniforms.uFlow.value = ping.texture;
    renderer.setRenderTarget(pong);
    renderer.render(scene, cam);
    const tmp = ping; ping = pong; pong = tmp;   // swap
  }
  renderer.setRenderTarget(null);   // restore default

  // ── Readback (ping holds the final result after last swap) ────────────────
  const rgba = new Float32Array(count * 4);
  renderer.readRenderTargetPixels(ping, 0, 0, width, height, rgba);

  const u = new Float32Array(count);
  const v = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    u[i] = rgba[i * 4];       // R → u
    v[i] = rgba[i * 4 + 1];   // G → v
  }

  // ── Dispose ───────────────────────────────────────────────────────────────
  texIt.dispose(); texIx.dispose(); texIy.dispose();
  ping.dispose(); pong.dispose();
  material.dispose(); geo.dispose();

  return { u, v, width, height, processingMs: performance.now() - t0 };
}

//   async function _computeDepthNormalsFlux(frameBitmap, calibData, options = {}) {
// ─────────────────────────────────────────────────────────────────────────────
async function _computeDepthNormalsFlux(frameBitmap, calibData, options = {}) {
  const startTime = performance.now();
  const telemetry = {
    stages:  {},
    errors:  [],
    warnings: [],
    success: false,
    modules: {
      calibratedProducer:    null,
      tetrachromacy:         null,
      directionalLifting:    null,
      doaModal:              null,   // Stage 1
      penumbra:              null,   // Stage 1
      trianglePreprocessor:  null,
      overhangPreprocessor:  null
    }
  };

  let depthMap         = null;
  let normalMap        = null;
  let fluxData         = null;
  let selectorArtifact = null;

  // Stage 1 outputs — populated in the parallel CPU branch and Route A.
  let fMapFinal      = null;
  let doaModalResult = null;
  let penumbraResult = null;
  let directionalFieldArtResult = null;
  let flowField      = null;   // ← must be function-scope, not try-scope

  try {
    // Identifiers passed from _handleReconstructMeta so intermediate
    // _persistAndPin calls inside this function have correct provenance.
    const metaKey  = options.metaKey  || null;
    const cameraId = options.cameraId || null;

    const resolution = options.resolution || DEFAULTS.defaultResolutions.normal;
    const gridSize   = resolution;

    if (!Number.isInteger(gridSize) || gridSize < 4 || gridSize > 4096) {
      throw new Error(`Invalid resolution: ${gridSize} (must be integer between 4 and 4096)`);
    }

    const estimateMemoryBytes = (res) =>
      res * res * (4 * 4) * 4;   // RGBA Float32 × 4 scratch buffers

    const estimatedBytes = estimateMemoryBytes(gridSize);
    const maxBytes       = Number(_flags.maxWorkerMemoryBytes) || DEFAULTS.maxWorkerMemoryBytes;

    if (estimatedBytes > maxBytes) {
      telemetry.errors.push(`memoryEstimate ${estimatedBytes} > max ${maxBytes}, reducing resolution`);
      if (gridSize > DEFAULTS.defaultResolutions.low) {
        options.resolution = Math.max(
          DEFAULTS.defaultResolutions.low,
          Math.floor(gridSize / 2)
        );
        return _computeDepthNormalsFlux(frameBitmap, calibData, options);
      } else {
        return await _fallbackDepthEstimation(frameBitmap, resolution);
      }
    }

    // =========================================================================
    // STEP 1: CalibratedFieldProducer  (unchanged)
    // =========================================================================
    telemetry.stages.calibrated_start = performance.now();

    let calibratedField = null;
    let calibResult     = null;

    console.log('[DEPTH-STAGE1] Calibration data check:', {
      calibDataExists:          !!calibData,
      calibratedFrameKeyExists: !!(calibData && calibData.calibratedFrameKey),
      calibratedFrameKeyValue:  calibData?.calibratedFrameKey
    });

    if (!calibData || !calibData.calibratedFrameKey) {
      const failureReason = !calibData
        ? 'calibData is null/undefined'
        : 'calibData exists but calibratedFrameKey is missing/undefined';
      console.error('[DEPTH-STAGE1] GUARD CHECK FAILED:', { failureReason });
      throw new Error(
        `Calibration metadata required but missing (no calibratedFrameKey). ` +
        `Reason: ${failureReason}. Reconstruction cannot proceed.`
      );
    }

    try {
      const producer = _getCalibratedProducer();

      calibResult = await producer.produce(frameBitmap, calibData, {
        resolution:     gridSize,
        storageWrapper: options.storageWrapper
      });

      calibratedField = calibResult.calibratedField;

      validateResolution(gridSize, calibResult.resolution, 'CalibratedFieldProducer');
      validateBuffer(calibratedField, gridSize * gridSize * 4, 'calibratedField');

      // ── DIAGNOSTIC: calibrated field signal check ─────────────────────
      // fieldStats from telemetry shows mean ~0.003 — nearly black input.
      // If maxR/maxG/maxB are all near zero, the camera signal is too low
      // for depth estimation and all downstream stages will be degenerate.
      try {
        let maxR = 0, maxG = 0, maxB = 0, sumR = 0, sumG = 0, sumB = 0;
        const sampleStride = Math.max(1, Math.floor(calibratedField.length / (4 * 10000)));
        let sampleCount = 0;
        for (let i = 0; i < calibratedField.length; i += 4 * sampleStride) {
          const r = calibratedField[i], g = calibratedField[i+1], b = calibratedField[i+2];
          if (r > maxR) maxR = r;
          if (g > maxG) maxG = g;
          if (b > maxB) maxB = b;
          sumR += r; sumG += g; sumB += b;
          sampleCount++;
        }
        const meanR = sumR / sampleCount;
        const meanG = sumG / sampleCount;
        const meanB = sumB / sampleCount;
        const isDegenerate = maxR < 0.01 && maxG < 0.01 && maxB < 0.01;
        console.log('[DIAG-CALIB] Calibrated field signal:', {
          maxR:  maxR.toFixed(5),
          maxG:  maxG.toFixed(5),
          maxB:  maxB.toFixed(5),
          meanR: meanR.toFixed(5),
          meanG: meanG.toFixed(5),
          meanB: meanB.toFixed(5),
          sampleCount,
          isDegenerate,
          verdict: isDegenerate
            ? '❌ NEARLY BLACK — depth will be flat, SDF will be degenerate'
            : '✅ Signal present — calibration OK'
        });
      } catch (diagErr) {
        console.warn('[DIAG-CALIB] Signal check failed:', diagErr.message);
      }
      // ── END DIAGNOSTIC ────────────────────────────────────────────────

      if (_flags.persistIntermediates || _flags.calibDebug) {
        try {
          await _persistAndPin(options.storageWrapper, {
            type: 'calibrated_field',
            data: { field: calibratedField },
            meta: {
              sourceMetaKey: metaKey, cameraId, resolution: gridSize,
              calibrationKey: calibData?.calibratedFrameKey || null,
              computedAt: Date.now()
            },
            createdAt: new Date().toISOString()
          }, { owner: 'motion.worker', ttlMs: CALIBRATION_FIELD_TTL_MS, pinType: 'hard' });
        } catch (e) {
          console.warn('[PERSIST] calibrated_field non-fatal:', e.message);
        }
      }

      telemetry.stages.calibrated_ms       = performance.now() - telemetry.stages.calibrated_start;
      telemetry.modules.calibratedProducer = calibResult.telemetry || null;

    } catch (calibErr) {
      const errMsg = `Calibration loading failed: ${calibErr.message}`;
      telemetry.errors.push(errMsg);
      throw new Error(errMsg);
    }

    // =========================================================================
    // STEP 2: Tetrachromacy  (unchanged)
    // =========================================================================
    telemetry.stages.tetrachromacy_start = performance.now();

    let tetraField   = calibratedField;
    let tetraResult  = null;
    let chromaticity = null;

    if (_flags.enableTetrachromacy !== false) {
      try {
        const tetra = _getTetrachromacy();
        tetraResult = await tetra.process(calibratedField, gridSize, {});

        tetraField   = tetraResult.tetraField;
        chromaticity = tetraResult.chromaticity;

        validateResolution(gridSize, tetraResult.resolution, 'Tetrachromacy');
        validateBuffer(tetraField, gridSize * gridSize * 4, 'tetraField');

        if (_flags.persistIntermediates) {
          try {
            await _persistAndPin(options.storageWrapper, {
              type: 'tetra_field',
              data: {
                field:            tetraField,
                opponentChannels: tetraResult.opponentChannels || null,
                chromaticity:     tetraResult.chromaticity     || null
              },
              meta: {
                sourceMetaKey: metaKey, cameraId, resolution: gridSize,
                hasOpponentChannels: !!tetraResult.opponentChannels,
                computedAt: Date.now()
              },
              createdAt: new Date().toISOString()
            }, { owner: 'motion.worker', ttlMs: INTERMEDIATE_TTL_MS, pinType: 'soft' });
          } catch (e) {
            console.warn('[PERSIST] tetra_field non-fatal:', e.message);
          }
        }

        telemetry.stages.tetrachromacy_ms = performance.now() - telemetry.stages.tetrachromacy_start;
        telemetry.modules.tetrachromacy   = tetraResult.telemetry || null;

      } catch (tetraErr) {
        telemetry.warnings.push(`Tetrachromacy failed: ${tetraErr.message}, using calibrated field`);
        console.warn('motion.worker: Tetrachromacy failed', tetraErr);
        tetraField = calibratedField;
      }
    }

    // Intensity (luminance) from tetra opponent channels or derived inline
    let intensity = null;
    if (tetraResult && tetraResult.opponentChannels && tetraResult.opponentChannels.L) {
      intensity = tetraResult.opponentChannels.L;
    } else {
      const cnt = gridSize * gridSize;
      intensity = new Float32Array(cnt);
      for (let i = 0; i < cnt; i++) {
        intensity[i] =
          0.299 * tetraField[i * 4    ] +
          0.587 * tetraField[i * 4 + 1] +
          0.114 * tetraField[i * 4 + 2];
      }
    }

    // =========================================================================
    // STEP 3: DirectionalLifting  (unchanged)
    // =========================================================================
    telemetry.stages.directional_start = performance.now();

    let directionalField = tetraField;
    let liftResult       = null;
    let coherence        = null;

    if (_flags.enableDirectionalLifting !== false) {
      try {
        const manifestFrameRate = options.plenopticContext?.frameRate ?? null;
        const dirLift = await _getDirectionalLifting(gridSize, manifestFrameRate);

        liftResult = await dirLift.process(
          tetraField, gridSize, Date.now(), { metadata: options }
        );

        directionalField = liftResult.directionalField;
        coherence        = liftResult.coherence ?? null;

        validateResolution(gridSize, liftResult.resolution, 'DirectionalLifting');
        validateBuffer(directionalField, gridSize * gridSize * 4, 'directionalField');

// Always persist directional_field — topology.worker (Stage 4A) requires it
        // unconditionally. Derivatives and coherence are packed into the same artifact
        // so topology.worker needs only one storage key.
        try {
          directionalFieldArtResult = await _persistAndPin(options.storageWrapper, {
            type: 'directional_field',
            data: {
              field:       directionalField,
              coherence:   liftResult.coherence   ?? null,
              derivatives: liftResult.derivatives
                ? { field: liftResult.derivatives.field,
                    dt:    liftResult.derivatives.dt,
                    meanAbsDerivative: liftResult.derivatives.meanAbsDerivative }
                : null
            },
            meta: {
              sourceMetaKey:  metaKey,
              cameraId,
              resolution:     gridSize,
              coherenceMean:  liftResult.coherence?.mean ?? null,
              hasDerivatives: !!(liftResult.derivatives),
              computedAt:     Date.now()
            },
            createdAt: new Date().toISOString()
          }, { owner: 'motion.worker', ttlMs: INTERMEDIATE_TTL_MS, pinType: 'soft' });
        } catch (e) {
          console.warn('[PERSIST] directional_field non-fatal:', e.message);
        }

        telemetry.stages.directional_ms      = performance.now() - telemetry.stages.directional_start;
        telemetry.coherenceMean              = liftResult.coherence?.mean;
        telemetry.modules.directionalLifting = liftResult.telemetry || null;

      } catch (liftErr) {
        telemetry.warnings.push(`DirectionalLifting failed: ${liftErr.message}, using tetra field`);
        console.warn('motion.worker: DirectionalLifting failed', liftErr);
        directionalField = tetraField;
      }
    }

    // =========================================================================
    // PARALLEL EXECUTION
    //
    // CPU BRANCH (STEPS 4–6 + Stage 1 work):
    //   bump → normal → specular → DOA/modal → PenumbraAnalyzer → Route B f_map
    //   All use calibratedField / tetraField / directionalField / coherence.
    //   No depth, no GPU.
    //
    // GPU BRANCH (THREE.js init):
    //   Load THREE module, create renderer, detect capabilities.
    //   The triangle preprocessor runs AFTER Promise.all because it needs
    //   bumpField and normalField from the CPU branch.
    //
    // Wall-clock gain: max(CPU branch, GPU branch) instead of their sum.
    // =========================================================================

    telemetry.stages.parallel_start = performance.now();

    let cpuResult = null;
    let gpuResult = null;

    [cpuResult, gpuResult] = await Promise.all([

      // ── CPU BRANCH ──────────────────────────────────────────────────────────
      (async () => {
        const cpuTel = {};

        // STEP 4: Bump Map
        cpuTel.bump_start = performance.now();
        let bumpField = null;
        if (intensity) {
          try {
            bumpField = _computeBumpFromIntensity(intensity, gridSize, {
              bumpScale:  _flags.bumpScale     || 1.0,
              fusionMode: _flags.bumpFusionMode || false
            });
            validateBuffer(bumpField, gridSize * gridSize * 4, 'bumpField');

            if (_flags.persistIntermediates) {
              try {
                await _persistAndPin(options.storageWrapper, {
                  type: 'bump_map',
                  data: { field: bumpField },
                  meta: {
                    sourceMetaKey: metaKey, cameraId, resolution: gridSize,
                    bumpScale:  _flags.bumpScale     || 1.0,
                    fusionMode: _flags.bumpFusionMode || false,
                    computedAt: Date.now()
                  },
                  createdAt: new Date().toISOString()
                }, { owner: 'motion.worker', ttlMs: INTERMEDIATE_TTL_MS, pinType: 'soft' });
              } catch (e) {
                console.warn('[PERSIST] bump_map non-fatal:', e.message);
              }
            }
          } catch (e) {
            cpuTel.bumpWarning = `Bump failed: ${e.message}`;
            console.warn('motion.worker: Bump failed', e);
          }
        }
        cpuTel.bump_ms = performance.now() - cpuTel.bump_start;

        // STEP 5: Normal Map
        cpuTel.normal_start = performance.now();
        let normalField = null;
        if (bumpField) {
          try {
            normalField = _computeNormalFromBump(bumpField, gridSize, _flags.normalScale || 1.0);
            validateBuffer(normalField, gridSize * gridSize * 4, 'normalField');
          } catch (e) {
            cpuTel.normalWarning = `Normal failed: ${e.message}`;
            console.warn('motion.worker: Normal failed', e);
          }
        }
        cpuTel.normal_ms = performance.now() - cpuTel.normal_start;

        // STEP 6: Specular Mask
        cpuTel.specular_start = performance.now();
        let specularMask = null;
        if (intensity && chromaticity) {
          try {
            specularMask = _computeSpecularMask(intensity, chromaticity, gridSize, {
              hpGain:      _flags.specularHpGain      || 4.0,
              alpha:       _flags.specularAlpha       || 0.5,
              chromaScale: _flags.specularChromaScale || 3.0,
              threshold:   _flags.specularThreshold   || 0.15
            });
            validateBuffer(specularMask, gridSize * gridSize * 4, 'specularMask');

            if (_flags.persistIntermediates) {
              try {
                await _persistAndPin(options.storageWrapper, {
                  type: 'specular_mask',
                  data: { field: specularMask },
                  meta: {
                    sourceMetaKey: metaKey, cameraId, resolution: gridSize,
                    computedAt: Date.now()
                  },
                  createdAt: new Date().toISOString()
                }, { owner: 'motion.worker', ttlMs: INTERMEDIATE_TTL_MS, pinType: 'soft' });
              } catch (e) {
                console.warn('[PERSIST] specular_mask non-fatal:', e.message);
              }
            }
          } catch (e) {
            cpuTel.specularWarning = `Specular failed: ${e.message}`;
            console.warn('motion.worker: Specular failed', e);
          }
        }
        cpuTel.specular_ms = performance.now() - cpuTel.specular_start;

        // Stage 1A: DOA + Modal decomposition
        cpuTel.doa_start = performance.now();
        let _doaResult = null;
        try {
          _doaResult = _computeDOAAndModal(
            directionalField, tetraField, coherence,
            specularMask, chromaticity, gridSize
          );
        } catch (e) {
          telemetry.warnings.push(`DOA/modal failed: ${e.message}`);
          console.warn('motion.worker: DOA/modal failed', e);
        }
        cpuTel.doa_ms = performance.now() - cpuTel.doa_start;

        // Stage 1B: PenumbraAnalyzer
        cpuTel.penumbra_start = performance.now();
        let _penumbraRes = null;
        try {
          _penumbraRes = await _getPenumbraAnalyzer().analyze(
            calibratedField,
            directionalField,
            intensity,
            gridSize,
            {
              derivatives:     liftResult?.derivatives  ?? null,
              profileWindowPx: _flags.penumbraProfileWindow || 17
            }
          );
        } catch (e) {
          telemetry.warnings.push(`PenumbraAnalyzer failed: ${e.message}`);
          console.warn('motion.worker: PenumbraAnalyzer failed', e);
        }
        cpuTel.penumbra_ms = performance.now() - cpuTel.penumbra_start;

        // Stage 1C: Route B f_map proxy (immediate, no depth needed)
        cpuTel.fmapB_start = performance.now();
        let _fMapB = null;
        try {
          _fMapB = _computeFMapRouteB(coherence?.perPixel ?? null, gridSize);
        } catch (e) {
          telemetry.warnings.push(`FMap RouteB failed: ${e.message}`);
          console.warn('motion.worker: FMap RouteB failed', e);
        }
        cpuTel.fmapB_ms = performance.now() - cpuTel.fmapB_start;

        return {
          bumpField, normalField, specularMask,
          doaModalResult: _doaResult,
          penumbraResult: _penumbraRes,
          fMapRouteB:     _fMapB,
          cpuTel
        };
      })(),

      // ── GPU BRANCH ──────────────────────────────────────────────────────────
      // THREE module load + renderer init run concurrently with the CPU branch.
      // Texture creation and the triangle preprocessor (STEPS 8–14) follow
      // AFTER Promise.all so they can use bumpField / normalField.
      (async () => {
        const gpuTel = {};
        gpuTel.init_start = performance.now();

        let renderer = null;
        let THREE    = null;
        let gpuCaps  = null;

        try {
          renderer = await _initThreeRenderer();
        } catch (e) {
          console.warn('motion.worker: THREE renderer init failed', e);
          telemetry.errors.push(`three_init: ${e.message ?? String(e)}`);
          return { fallback: true, fallbackError: e };
        }

        try {
          THREE   = await _loadThreeModule();
          gpuCaps = await _detectGPUCapabilities();
        } catch (e) {
          console.warn('motion.worker: THREE module load failed', e);
          return { fallback: true, fallbackError: e };
        }

        gpuTel.init_ms = performance.now() - gpuTel.init_start;
        return { fallback: false, renderer, THREE, gpuCaps, gpuTel };
      })()

    ]); // ── end Promise.all ──────────────────────────────────────────────────

    telemetry.stages.parallel_ms = performance.now() - telemetry.stages.parallel_start;

    if (gpuResult.fallback) {
      return await _fallbackDepthEstimation(frameBitmap, resolution);
    }

    // Unpack parallel results
    const {
      bumpField, normalField, specularMask,
      doaModalResult: _doaModal,
      penumbraResult: _penumbra,
      fMapRouteB,
      cpuTel
    } = cpuResult;

    const { renderer, THREE, gpuCaps, gpuTel } = gpuResult;

    // Promote Stage 1 outputs to function-scope so the return can include them
    doaModalResult = _doaModal;
    penumbraResult = _penumbra;

    Object.assign(telemetry.stages, cpuTel, gpuTel);
    if (doaModalResult?.telemetry) telemetry.modules.doaModal = doaModalResult.telemetry;
    if (penumbraResult?.telemetry) telemetry.modules.penumbra = penumbraResult.telemetry;

    // =========================================================================
    // STEP 7.5: Horn-Schunck optical flow   (Stage 3 prerequisite)
    // Prerequisites all coexist here — this is the ONLY window where:
    //   liftResult.derivatives  (temporal signal It)
    //   intensity               (spatial gradients Ix, Iy via inline Sobel)
    //   renderer, THREE         (GPU available for ping-pong passes)
    // are simultaneously in scope.
    // =========================================================================
    // flowField declared at function scope above
    if (_flags.enableOpticalFlow) {
      try {
        const hsT0      = performance.now();
        const hsCount   = gridSize * gridSize;
        const hsAlpha   = safeNumeric(_flags.opticalFlowAlpha,      1.0, 0.1, 10);
        const hsIters   = Math.max(10, Math.min(100,
          Math.floor(_flags.opticalFlowIterations ?? 30)));

        // ── It: temporal derivative — luminance collapse of liftResult.derivatives ──
        // liftResult.derivatives is Float32Array res²×4 (directional RGBA delta).
        // If missing (DirectionalLifting failed), It stays zero → H-S outputs zero flow.
        const It = new Float32Array(hsCount);
        if (liftResult?.derivatives) {
          const d = liftResult.derivatives;
          for (let i = 0; i < hsCount; i++) {
            It[i] = 0.299 * (d[i*4] || 0) +
                    0.587 * (d[i*4+1] || 0) +
                    0.114 * (d[i*4+2] || 0);
          }
        }

        // ── Ix, Iy: Sobel spatial derivatives of intensity field ──────────────
        const Ix = new Float32Array(hsCount);
        const Iy = new Float32Array(hsCount);
        if (intensity) {
          for (let y = 0; y < gridSize; y++) {
            for (let x = 0; x < gridSize; x++) {
              const i   = y * gridSize + x;
              const xl  = Math.max(0, x - 1);
              const xr  = Math.min(gridSize - 1, x + 1);
              const yu  = Math.max(0, y - 1);
              const yd  = Math.min(gridSize - 1, y + 1);
              const g   = (px, py) => intensity[py * gridSize + px];
              Ix[i] = (-g(xl,yu) + g(xr,yu) - 2*g(xl,y) + 2*g(xr,y) - g(xl,yd) + g(xr,yd)) / 8;
              Iy[i] = (-g(xl,yu) - 2*g(x,yu) - g(xr,yu) + g(xl,yd) + 2*g(x,yd) + g(xr,yd)) / 8;
            }
          }
        }

        // ── Guard: float textures required ───────────────────────────────────
        // WebGL2 supports floats natively; WebGL1 needs OES_texture_float.
        if (!gpuCaps.isWebGL2 && !gpuCaps.floatTexturesSupported) {
          throw new Error('float textures not supported — H-S requires FloatType RenderTarget');
        }

        // Scale iterations down at high resolution to bound GPU time.
        // 30 passes at 512² ≈ 5ms; at 1024² the same passes take ~20ms.
        // Halving iterations at 1024² keeps wall time ≤10ms with minimal
        // accuracy loss — H-S converges quickly in the first 15 passes.
        const hsItersScaled = gridSize > 512
          ? Math.max(10, Math.floor(hsIters / Math.pow(gridSize / 512, 1.5)))
          : hsIters;
        const hsResult = _runHornSchunck(
          THREE, renderer,
          It, Ix, Iy,
          gridSize, gridSize,
          hsAlpha, hsItersScaled
        );

        flowField = {
          u:      hsResult.u,
          v:      hsResult.v,
          width:  gridSize,
          height: gridSize
        };

        telemetry.stages.hornSchunck_ms = hsResult.processingMs;
        console.log(`[H-S] optical flow in ${hsResult.processingMs.toFixed(1)}ms ` +
          `(α²=${hsAlpha.toFixed(2)}, ${hsIters} passes)`);

      } catch (hsErr) {
        telemetry.warnings.push(`Horn-Schunck failed: ${hsErr.message}`);
        console.warn('motion.worker: Horn-Schunck failed (flowField=null)', hsErr);
        flowField = null;
      }
    }

    // =========================================================================
    // STEP 8: Texture creation
    // Logic identical to original; bumpField / normalField now come from
    // cpuResult rather than being computed inline.
    // =========================================================================
    telemetry.stages.texture_load_start = performance.now();

    const createTexture = (field, name) => {
      if (!field) return null;

      const useFloat  = !!(gpuCaps && gpuCaps.floatTexturesSupported);
      let arrayBuffer = field;
      let type        = useFloat ? THREE.FloatType : THREE.UnsignedByteType;

      if (!useFloat) {
        const uint8 = new Uint8ClampedArray(field.length);
        for (let i = 0; i < field.length; i++) {
          let v = Number(field[i]);
          if (!isFinite(v)) v = 0;
          uint8[i] = Math.round(Math.max(0, Math.min(1, v)) * 255);
        }
        arrayBuffer = uint8;
        type        = THREE.UnsignedByteType;
        console.warn(`motion.worker: 8-bit fallback for texture "${name}"`);
      }

      const tex = new THREE.DataTexture(
        arrayBuffer, gridSize, gridSize, THREE.RGBAFormat, type
      );
      tex.needsUpdate = true;
      tex.minFilter   = THREE.LinearFilter;
      tex.magFilter   = THREE.LinearFilter;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      _trackResource(tex, 'textures');
      return tex;
    };

    const diffuseTexture = createTexture(directionalField, 'diffuse');
    const bumpTexture    = bumpField   ? createTexture(bumpField,   'bump')   : diffuseTexture;
    const normalTexture  = normalField ? createTexture(normalField, 'normal') : diffuseTexture;
    const albedoTexture  = createTexture(directionalField, 'albedo');

    const textures = {
      diffuse:     diffuseTexture,
      bump:        bumpTexture,
      normal:      normalTexture,
      albedo:      albedoTexture,
      bumpScale:   _flags.bumpScale   || 1.0,
      normalScale: _flags.normalScale || 1.0,
      albedoScale: 1.0
    };

    telemetry.stages.texture_load_ms =
      performance.now() - telemetry.stages.texture_load_start;

    // =========================================================================
    // STEPS 9–14: unchanged from original
    // =========================================================================

    // STEP 9: UV Grid
    telemetry.stages.grid_gen_start = performance.now();

    const count     = gridSize * gridSize;
    const positions = new Float32Array(count * 2);
    const normals2D = new Float32Array(count * 2);

    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        const i = y * gridSize + x;
        positions[i * 2]     = x / (gridSize - 1);
        positions[i * 2 + 1] = y / (gridSize - 1);
        normals2D[i * 2]     = 0;
        normals2D[i * 2 + 1] = 1;
      }
    }

    telemetry.stages.grid_gen_ms = performance.now() - telemetry.stages.grid_gen_start;

    // STEP 10: Triangle Preprocessor
    telemetry.stages.triangle_start = performance.now();

    let triangleResult = null;
    try {
      const { createDepthTrianglePreprocessor } =
        await import('/src/js/core/depthTrianglePreprocessor.js');

      _trianglePreprocessor = createDepthTrianglePreprocessor({
        THREE:      THREE,
        renderer:   renderer,
        bakeSize:   Math.max(256, Math.min(1024, Math.floor(gridSize * 4))),
        gridSize,
        positions,
        normals:    normals2D,
        textures,
        kL:         safeNumeric(_flags.depthKL,    1.0, 0, 10),
        kD:         safeNumeric(_flags.depthKD,    0.5, 0, 10),
        baseDepth:  safeNumeric(_flags.depthBase,  0.1, 0, 10),
        depthScale: safeNumeric(_flags.depthScale, 2.0, 0, 100)
      });

      const initErr = _trianglePreprocessor.init();
      if (initErr) throw new Error(`Triangle preprocessor init failed: ${initErr}`);

      triangleResult = _trianglePreprocessor.compute();
      if (!triangleResult || !triangleResult.depths) {
        throw new Error('Triangle preprocessor returned invalid result');
      }

      validateBuffer(triangleResult.depths,         count, 'triangleResult.depths');
      validateBuffer(triangleResult.tilts,           count, 'triangleResult.tilts');
      validateBuffer(triangleResult.windingNumbers,  count, 'triangleResult.windingNumbers');

      // ── DIAGNOSTIC: depth field variation check ───────────────────────
      // If min ≈ max, depth is flat → SDF will have no zero crossings →
      // narrowBandPixels = 0 → seedCount = 0. This is the most common
      // cause of degenerate PackingSDF output.
      try {
        let dMin = Infinity, dMax = -Infinity, dSum = 0;
        const depths = triangleResult.depths;
        // Sample up to 10000 points for speed
        const dStride = Math.max(1, Math.floor(depths.length / 10000));
        let dCount = 0;
        for (let i = 0; i < depths.length; i += dStride) {
          const v = depths[i];
          if (v < dMin) dMin = v;
          if (v > dMax) dMax = v;
          dSum += v;
          dCount++;
        }
        const dMean   = dSum / dCount;
        const dRange  = dMax - dMin;
        const isFlat  = dRange < 0.01;
        console.log('[DIAG-DEPTH] Triangle depth field stats:', {
          min:      dMin.toFixed(6),
          max:      dMax.toFixed(6),
          mean:     dMean.toFixed(6),
          range:    dRange.toFixed(6),
          samples:  dCount,
          isFlat,
          verdict: isFlat
            ? '❌ FLAT DEPTH — SDF will be degenerate (no zero crossings)'
            : '✅ Depth has variation — SDF should be non-degenerate'
        });
        // Also log first 5 raw values for cross-checking
        console.log('[DIAG-DEPTH] First 5 depth values:',
          Array.from(depths.slice(0, 5)).map(v => v.toFixed(6)));
        console.log('[DIAG-DEPTH] Triangle preprocessor stats:', triangleResult.stats);
      } catch (diagErr) {
        console.warn('[DIAG-DEPTH] Depth check failed:', diagErr.message);
      }
      // ── END DIAGNOSTIC ──────────────────────────────────────────────── 

      if (_flags.persistIntermediates) {
        try {
          await _persistAndPin(options.storageWrapper, {
            type: 'triangle_output',
            data: {
              depths:         triangleResult.depths,
              tilts:          triangleResult.tilts,
              windingNumbers: triangleResult.windingNumbers
            },
            meta: {
              sourceMetaKey: metaKey, cameraId, resolution: gridSize,
              sampleCount:   triangleResult.depths.length,
              stats:         triangleResult.stats || {},
              computedAt:    Date.now()
            },
            createdAt: new Date().toISOString()
          }, { owner: 'motion.worker', ttlMs: INTERMEDIATE_TTL_MS, pinType: 'soft' });
        } catch (e) {
          console.warn('[PERSIST] triangle_output non-fatal:', e.message);
        }
      }

      telemetry.stages.triangle_ms           = performance.now() - telemetry.stages.triangle_start;
      telemetry.stages.triangle_samples      = triangleResult.depths.length;
      telemetry.modules.trianglePreprocessor = triangleResult.stats || null;

    } catch (triangleErr) {
      const se = safeErrSummary(triangleErr);
      console.error('motion.worker: Triangle preprocessor failed', triangleErr);
      telemetry.errors.push(`triangle: ${se.message}`);
      throw triangleErr;
    }

    // STEP 11: Normal conversion
    telemetry.stages.normal_convert_start = performance.now();

    const depths         = triangleResult.depths;
    const tilts          = triangleResult.tilts;
    const windingNumbers = triangleResult.windingNumbers;

    const normals3D = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const theta = tilts[i];
      const nx    = Math.cos(theta);
      const ny    = Math.sin(theta);
      const nz    = 0.5;
      const len   = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1.0;
      normals3D[i*3]     = nx / len;
      normals3D[i*3 + 1] = ny / len;
      normals3D[i*3 + 2] = nz / len;
    }

    telemetry.stages.normal_convert_ms =
      performance.now() - telemetry.stages.normal_convert_start;

    // STEP 12: Overhang Preprocessor
    telemetry.stages.overhang_start = performance.now();

    let overhangResult  = null;
    const enableOverhang = _flags.enableOverhang !== false;

    if (enableOverhang) {
      try {
        if (!_overhangPreprocessor) {
          const { createOverhangPreprocessor } = await import('./overhangPreprocessor.js');
          _overhangPreprocessor = createOverhangPreprocessor({
            gridW:            gridSize,
            gridH:            gridSize,
            gravity:          _flags.gravity               || [0, -1, 0],
            cosineThreshold:  safeNumeric(_flags.overhangCosineThresh,  0.7, -1, 1),
            windingThreshold: safeNumeric(_flags.overhangWindingThresh, 0.25,  0, 10),
            minGroupSize:     Math.max(1, Math.floor(_flags.overhangMinGroupSize || 3))
          });
        }

        overhangResult = _overhangPreprocessor.run({
          depths, normals: normals3D, windingNumbers, positions
        });

        if (!overhangResult.A_coo || !overhangResult.A_csr || !overhangResult.b) {
          throw new Error('Overhang preprocessor returned incomplete constraint system');
        }

        const expectedRows = overhangResult.A_csr.shape
          ? overhangResult.A_csr.shape[0]
          : overhangResult.b.length;
        if (overhangResult.A_csr.indptr.length !== expectedRows + 1) {
          telemetry.warnings.push(
            `Overhang CSR indptr length mismatch: expected ${expectedRows + 1}, ` +
            `got ${overhangResult.A_csr.indptr.length}`
          );
        }

        telemetry.stages.overhang_ms           = performance.now() - telemetry.stages.overhang_start;
        telemetry.stages.overhang_constraints  = overhangResult.diagnostics.constraintCount;
        telemetry.stages.overhang_socs         = overhangResult.diagnostics.socCount;
        telemetry.modules.overhangPreprocessor = overhangResult.diagnostics || null;

      } catch (overhangErr) {
        const se = safeErrSummary(overhangErr);
        console.warn('motion.worker: Overhang preprocessor failed', overhangErr);
        telemetry.errors.push(`overhang: ${se.message}`);
        overhangResult = null;
      }
    }

    // STEP 13: Selector (BSS seed)
    try {
      if (_flags.bssPersistSelector) {
        const selector = new Float32Array(count);
        for (let i = 0; i < count; i++) {
          let score = Math.abs(windingNumbers[i] || 0);
          score    += Math.abs(triangleResult.tilts[i] || 0) * 0.1;
          selector[i] = score;
        }
        let maxS = 0;
        for (let i = 0; i < count; i++) if (selector[i] > maxS) maxS = selector[i];
        if (maxS > 0) for (let i = 0; i < count; i++) selector[i] /= maxS;

        selectorArtifact = {
          pointsCount: count,
          selector:    Array.from(selector),
          gateParams: {
            eta_pull: safeNumeric(_flags.bssPullEta, 0.1,  0, 1),
            eta_push: safeNumeric(_flags.bssPushEta, 0.05, 0, 1),
            gamma:    safeNumeric(_flags.bssGamma,   1.02, 1, 2),
            iters:    Math.max(1, Math.floor(_flags.bssIters || 8))
          }
        };
      }
    } catch (selErr) {
      const se = safeErrSummary(selErr);
      console.warn('motion.worker: selector build failed', selErr);
      telemetry.errors.push(`selector: ${se.message}`);
      selectorArtifact = null;
    }

    // STEP 14: Package results
    const depthStats = typedMinMax(depths);

    depthMap = {
      resolution: gridSize,
      data:       depths,
      min:        depthStats.min,
      max:        depthStats.max,
      encoding:   'float32',
      stats:      triangleResult.stats || {}
    };

    normalMap = {
      resolution: gridSize,
      data:       normals3D,
      encoding:   'xyz-float32'
    };

    fluxData = overhangResult ? {
      A_coo: overhangResult.A_coo,
      A_csr: {
        indptr:  Array.from(overhangResult.A_csr.indptr),
        indices: Array.from(overhangResult.A_csr.indices),
        data:    Array.from(overhangResult.A_csr.data),
        shape:   overhangResult.A_csr.shape
      },
      b:            Array.from(overhangResult.b),
      SOCs:         overhangResult.SOCs,
      groups:       overhangResult.groups,
      supports:     overhangResult.supports,
      init_h:       Array.from(overhangResult.init_h),
      diagnostics:  overhangResult.diagnostics,
      solverReady:  true,
      sampleSummary: overhangResult.sampleSummary || null
    } : null;

    // =========================================================================
    // STEP 14.5: Route A f_map — depth now available (Stage 1)
    // Default to Route B; upgrade when depth is present and flag allows.
    // =========================================================================
    telemetry.stages.fmapA_start = performance.now();

    fMapFinal = fMapRouteB;   // always have a Route B fallback

    fMapFinal = _computeFMapRouteB(coherence?.perPixel ?? null, gridSize);

if (depthMap && _flags.enableFMapRouteA !== false) {
  try {
    // Scale sample count down quadratically with resolution to keep
    // wall time roughly constant. At 512²: N=128 (~5s). At 1024²: N=32 (~13s).
    // Route B (coherence proxy) is retained as fallback if Route A is too slow.
    const _fMapBaseN = _flags.fMapNSamples ?? 128;
    const _fMapResScale = Math.pow(Math.min(1, 512 / gridSize), 2);
    const _fMapN = Math.max(4, Math.round(_fMapBaseN * _fMapResScale));

    if (_fMapN < _fMapBaseN) {
      console.log(
        `[FMap-RouteA] N scaled ${_fMapBaseN}→${_fMapN} for resolution ${gridSize}²`
      );
    }

    fMapFinal = _computeFMapRouteA(
      depthMap,
      calibratedField,
      gridSize,
      penumbraResult?.lightTrack ?? [],
      options.fresnelDensityMap ?? null,
      _buildSamplingContext(options.manifest ?? null, gridSize),
      { N_samples: _fMapN }
    );
  } catch (e) {
    telemetry.warnings.push(`FMap RouteA failed: ${e.message} — keeping Route B`);
    console.warn('motion.worker: FMap RouteA failed, retaining Route B', e);
  }
}

    telemetry.stages.fmapA_ms = performance.now() - telemetry.stages.fmapA_start;

    // Finalise pipeline telemetry
    telemetry.calibratedPipeline = {
      producer:           calibResult?.telemetry,
      tetrachromacy:      tetraResult?.telemetry,
      directionalLifting: liftResult?.telemetry,
      hasBump:            !!bumpField,
      hasNormal:          !!normalField,
      hasSpecular:        !!specularMask
    };

    telemetry.success              = true;
    telemetry.estimatedMemoryBytes = estimatedBytes;
    telemetry.selector             = selectorArtifact
      ? { pointsCount: selectorArtifact.pointsCount }
      : null;

  } catch (err) {
    const se = safeErrSummary(err);
    console.error('motion.worker: computeDepthNormalsFlux failed', err);

    telemetry.success = false;
    telemetry.error   = String(se.message);
    telemetry.stack   = se.stack;
    telemetry.errors.push(`fatal: ${se.message}`);

    try {
      return await _fallbackDepthEstimation(
        frameBitmap,
        options.resolution || DEFAULTS.defaultResolutions.normal
      );
    } catch (fallbackErr) {
      const fallbackSe = safeErrSummary(fallbackErr);
      console.warn('motion.worker: fallbackDepthEstimation also failed', fallbackSe.message);

      const res             = options.resolution || DEFAULTS.defaultResolutions.normal;
      const fallbackDepths  = new Float32Array(res * res).fill(1.0);
      const fallbackNormals = new Float32Array(res * res * 3);
      for (let i = 0; i < fallbackNormals.length; i++) {
        fallbackNormals[i] = (i % 3 === 2) ? 1.0 : 0.0;
      }

      depthMap = {
        resolution: res, data: fallbackDepths,
        min: 1.0, max: 1.0, encoding: 'float32',
        fallback: true, error: se.message
      };
      normalMap = {
        resolution: res, data: fallbackNormals,
        encoding: 'xyz-float32', fallback: true
      };
      fluxData = null;
    }
  } finally {
    telemetry.stages.cleanup_start = performance.now();
    _cleanupAfterReconstruction();
    telemetry.stages.cleanup_ms =
      performance.now() - telemetry.stages.cleanup_start;
  }

  telemetry.total_ms = performance.now() - startTime;

  // Stage 1 outputs travel with the return so _handleReconstructMeta can
  // persist them alongside the existing depth/normal/flux artifacts.
  return {
    depthMap,
    normalMap,
    fluxData,
    telemetry,
    selectorArtifact: selectorArtifact || null,
    // Stage 1
    fMapFinal,
    doaModalResult,
    penumbraResult,
    // Stage 3 prerequisite
    flowField,
    // Stage 4A prerequisite
    directionalFieldArtResult
  };
}

// ---------------------------------------------------------------------------
// Helper: wait for artifact visibility across IndexedDB connections
// ---------------------------------------------------------------------------
async function _waitForArtifactVisibility(storageWrapper, metaKey, { timeoutMs = 5000, pollMs = 100 } = {}) {
  // Conservative, best-effort check: poll storageWrapper.getArtifact and verify
  // that the record exists (and for part-backed fields optionally check a part).
  const start = Date.now();

  // Try quick BroadcastChannel hint (best-effort) — listen briefly for an 'artifact:ready'
  let bcResolved = false;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        const bc = new BroadcastChannel('motion-painter-store');
        const onMsg = (ev) => {
          try {
            const d = ev.data || {};
            if (d && d.event === 'artifact:ready' && (d.key === metaKey || d.metaKey === metaKey)) {
              bcResolved = true;
              bc.removeEventListener('message', onMsg);
              try { bc.close(); } catch (e) {}
            }
          } catch (e) { /* ignore */ }
        };
        bc.addEventListener('message', onMsg);
        // stop listening after small grace window
        setTimeout(() => {
          try { bc.removeEventListener('message', onMsg); bc.close(); } catch (e) {}
        }, Math.min(1000, timeoutMs));
      } catch (e) {
        /* ignore bc creation errors */
      }
    }
  } catch (e) { /* ignore */ }

  // Poll storage API
  while (Date.now() - start < timeoutMs) {
    try {
      // Prefer storageWrapper.getArtifact if available
      let art = null;
      if (storageWrapper && typeof storageWrapper.getArtifact === 'function') {
        art = await storageWrapper.getArtifact(metaKey, { denormalize: false, assembleParts: false }).catch(() => null);
      } else if (typeof getArtifact === 'function') {
        // fallback to global/getArtifact if present
        art = await getArtifact(metaKey, { denormalize: false, assembleParts: false }).catch(() => null);
      }

      if (art) {
        // If artifact claims hasParts, optionally verify first stored part exists (best-effort)
        if (art.meta?.hasParts && art.data && typeof storageWrapper.fetchPartByKey === 'function') {
          let ok = true;
          for (const [fieldName, fieldVal] of Object.entries(art.data || {})) {
            if (fieldVal && fieldVal._partsRef && Array.isArray(fieldVal.partKeys) && fieldVal.partKeys.length > 0) {
              const partKey = fieldVal.partKeys[0];
              const blob = await storageWrapper.fetchPartByKey(partKey).catch(() => null);
              if (!blob) { ok = false; break; }
            }
          }
          if (ok) return true;
          // else continue polling
        } else {
          // no parts or no fetchPartByKey — treat artifact presence as success
          return true;
        }
      }
    } catch (e) {
      // ignore and retry
    }

    // If we saw an artifact:ready via BroadcastChannel earlier, return early
    if (bcResolved) return true;

    // Wait a bit and try again
    await new Promise(r => setTimeout(r, pollMs));
  }

  return false;
}

// ---------------------------------------------------------------------------
// RECONSTRUCT_META Handler (Main Entry Point)
// ---------------------------------------------------------------------------

async function _handleReconstructMeta({ jobId, metaKey, options = {} }) {
  const startTime = Date.now();
  let heartbeatTimer = null;
  let storageWrapper = null;
  let frameBitmap = null;
  let manifest = null;

  try {
    if (!metaKey) {
      throw new Error('metaKey required for reconstruction');
    }
    storageWrapper = await _loadStorageAPI();

    // ========================================
    // STAGE 1: Check reconStatus (Deduplication)
    // ========================================
    self.postMessage({
      event: 'progress',
      msgId: generateMsgId(),
      jobId,
      stage: 'checking_status'
    });

    if (storageWrapper.getReconStatus) {
      const status = await storageWrapper.getReconStatus(metaKey);

      if (status?.state === 'done') {
        self.postMessage({
          event: 'RECON_DONE',
          msgId: generateMsgId(),
          jobId,
          metaKey,
          cached: true,
          derivedKeys: status.derivedKeys || []
        });
        return;
      }

      if (status?.state === 'running') {
        self.postMessage({
          event: 'RECON_IN_PROGRESS',
          msgId: generateMsgId(),
          jobId,
          metaKey,
          startedAt: status.startedAt,
          existingReqId: status.reqId
        });
        return;
      }
    }

    // ========================================
    // STAGE 2: Mark Running (Atomic)
    // ========================================
    if (storageWrapper.markReconRunning) {
      const takeoverMs = Number(options.takeoverMs) || Number(_flags.reconTakeoverMs) || DEFAULTS.takeoverMsDefault;

      console.log('[RECON] calling markReconRunning:', {
        metaKey,
        jobId,
        takeoverMs,
        expectedDeadline: new Date(Date.now() + takeoverMs).toISOString()
      });

      const markResult = await storageWrapper.markReconRunning(metaKey, jobId, takeoverMs);

      console.log('[RECON] markReconRunning result:', markResult);

      if (storageWrapper.getReconStatus) {
        const storedStatus = await storageWrapper.getReconStatus(metaKey);
        console.log('[RECON] Stored reconStatus after markReconRunning:', {
          state:         storedStatus?.state,
          reqId:         storedStatus?.reqId,
          deadline:      storedStatus?.deadline,
          deadlineISO:   storedStatus?.deadline ? new Date(storedStatus.deadline).toISOString() : null,
          deadlineInPast: storedStatus?.deadline ? storedStatus.deadline < Date.now() : null
        });
      }

      if (!markResult || !markResult.ok) {
        self.postMessage({
          event: 'RECON_IN_PROGRESS',
          msgId: generateMsgId(),
          jobId,
          metaKey,
          reason: markResult?.reason || 'unknown',
          runtime: markResult?.runtime || null,
          existingReqId: markResult && markResult.existing ? markResult.existing.reqId : null
        });
        return;
      }
    }

    try {
      heartbeatTimer = await _startHeartbeat(storageWrapper, jobId, metaKey);
      _jobs.set(jobId, { heartbeatTimer, createdAt: Date.now(), meta: { metaKey } });
    } catch (hbErr) {
      console.warn('motion.worker: failed to start heartbeat', hbErr);
    }

    // ========================================
    // STAGE 3: Load Manifest
    // ========================================
    self.postMessage({
      event: 'progress',
      msgId: generateMsgId(),
      jobId,
      stage: 'loading_manifest'
    });

    manifest = await storageWrapper.getArtifact(metaKey, { denormalize: true });
    if (!manifest || !manifest.data) {
      throw new Error(`Manifest not found: ${metaKey}`);
    }

    const cameraContainer = manifest.data.cameraContainer || null;
    const cameraId =
      cameraContainer?.cameraId ||
      manifest.data.cameraId ||
      manifest.meta?.cameraId ||
      null;

// ========================================
// STAGE 4: Load Calibration (Optional)
// ========================================
self.postMessage({
  event: 'progress',
  msgId: generateMsgId(),
  jobId,
  stage: 'loading_calibration'
});

let calibData = null;
if (manifest.data.calibrationKey) {
  try {
    // ✅ DIAGNOSTIC: Log what we're loading
    console.log('[STAGE4] Loading calibration artifact:', {
      manifestKey: metaKey,
      calibrationKey: manifest.data.calibrationKey,
      timestamp: Date.now()
    });

    const calibMeta = await storageWrapper.getArtifact(
      manifest.data.calibrationKey,
      { denormalize: true }
    );

    // ✅ DIAGNOSTIC: Log what we got back
    console.log('[STAGE4] Calibration artifact loaded:', {
      calibrationKey: manifest.data.calibrationKey,
      artifactExists: !!calibMeta,
      hasData: !!(calibMeta && calibMeta.data),
      hasMeta: !!(calibMeta && calibMeta.meta),
      dataKeys: calibMeta?.data ? Object.keys(calibMeta.data) : [],
      metaKeys: calibMeta?.meta ? Object.keys(calibMeta.meta) : []
    });

    if (calibMeta && calibMeta.data) {
      const calibratedFrameKey = calibMeta.data.calibratedFrameKey;

      // ✅ DIAGNOSTIC: Log the critical calibratedFrameKey extraction
      console.log('[STAGE4] Extracting calibratedFrameKey:', {
        calibratedFrameKey,
        calibratedFrameKeyType: typeof calibratedFrameKey,
        calibratedFrameKeyDefined: calibratedFrameKey !== undefined,
        calibratedFrameKeyTruthy: !!calibratedFrameKey,
        darkKey: calibMeta.data.darkKey,
        flatKey: calibMeta.data.flatKey,
        biasKey: calibMeta.data.biasKey,
        fullDataObject: JSON.stringify(calibMeta.data).slice(0, 500)  // First 500 chars
      });

      // ⚠️ DIAGNOSTIC: Explicit warning if key is missing
      if (!calibratedFrameKey) {
        console.error('[STAGE4] ❌ CRITICAL: calibratedFrameKey is undefined/null even after denormalize!', {
          calibrationKey: manifest.data.calibrationKey,
          dataKeys: Object.keys(calibMeta.data),
          metaKeys: Object.keys(calibMeta.meta || {}),
          dataStringified: JSON.stringify(calibMeta.data),
          metaType: calibMeta.meta?.type,
          metaHasParts: calibMeta.meta?.hasParts
        });
      }

      calibData = {
        calibratedFrameKey,
        darkKey: calibMeta.data.darkKey,
        flatKey: calibMeta.data.flatKey,
        biasKey: calibMeta.data.biasKey,
        meta: calibMeta.data
      };

      // ✅ DIAGNOSTIC: Log final calibData structure
      console.log('[STAGE4] calibData constructed:', {
        hasCalibData: !!calibData,
        hasFrameKey: !!calibData.calibratedFrameKey,
        frameKey: calibData.calibratedFrameKey,
        hasDarkKey: !!calibData.darkKey,
        hasFlatKey: !!calibData.flatKey,
        hasBiasKey: !!calibData.biasKey
      });

    } else {
      // ✅ DIAGNOSTIC: Log why we couldn't construct calibData
      console.warn('[STAGE4] Cannot construct calibData:', {
        calibMetaExists: !!calibMeta,
        calibMetaHasData: !!(calibMeta && calibMeta.data),
        calibMetaType: typeof calibMeta,
        calibMetaKeys: calibMeta ? Object.keys(calibMeta) : []
      });
    }
  } catch (calibErr) {
    // ✅ DIAGNOSTIC: Enhanced error logging
    console.error('[STAGE4] Calibration load failed:', {
      calibrationKey: manifest.data.calibrationKey,
      errorMessage: calibErr.message,
      errorStack: calibErr.stack,
      errorType: calibErr.constructor.name
    });
    console.warn('motion.worker: Calibration load failed', calibErr);
    calibData = null;
  }
} else {
  // ✅ DIAGNOSTIC: Log when no calibration key present
  console.log('[STAGE4] No calibration key in manifest:', {
    manifestKey: metaKey,
    manifestDataKeys: Object.keys(manifest.data || {}),
    hasCalibrationKey: 'calibrationKey' in (manifest.data || {})
  });
}

// ✅ DIAGNOSTIC: Final sanity check before proceeding
console.log('[STAGE4] Final calibData state before depth computation:', {
  calibDataNull: calibData === null,
  calibDataUndefined: calibData === undefined,
  calibDataTruthy: !!calibData,
  calibratedFrameKeyPresent: !!(calibData && calibData.calibratedFrameKey),
  calibratedFrameKeyValue: calibData?.calibratedFrameKey || 'MISSING',
  willPassGuardCheck: !!(calibData && calibData.calibratedFrameKey)
});

    // ── STAGE 4.5: Load Fresnel density map ────────────────────────────────
    // HFH MotionDetection persists this before motion.worker runs.
    // Loading here (alongside calibration) makes it available to Route A with
    // zero additional latency — no extra round-trip at compute time.
    //
    // Key lookup order:
    //   1. manifest.data.fresnelKey         (canonical)
    //   2. manifest.data.fresnel_key        (underscore variant)
    //   3. manifest.data.fresnelArtifactKey (legacy)
    //
    // Graceful fallback: null → Route A uses uniform importance sampling.
    let fresnelDensityMap = null;

    const fresnelKey =
      manifest.data.fresnelKey        ??
      manifest.data.fresnel_key        ??
      manifest.data.fresnelArtifactKey ??
      null;

    if (fresnelKey) {
      try {
        console.log('[STAGE4.5] Loading Fresnel density map:', { fresnelKey });
        const fresnelArtifact = await storageWrapper.getArtifact(
          fresnelKey, { denormalize: true }
        );
        if (fresnelArtifact?.data?.densityMap) {
          fresnelDensityMap = fresnelArtifact.data.densityMap;
          console.log('[STAGE4.5] ✓ Fresnel density map loaded:',
            { length: fresnelDensityMap.length, fresnelKey });
        } else {
          console.warn('[STAGE4.5] Fresnel artifact has no densityMap:', {
            fresnelKey,
            dataKeys: fresnelArtifact?.data ? Object.keys(fresnelArtifact.data) : []
          });
        }
      } catch (e) {
        // Non-fatal
        console.warn('[STAGE4.5] Fresnel load failed (uniform sampling fallback):',
          { fresnelKey, error: e.message });
      }
    } else {
      console.log('[STAGE4.5] No fresnelKey in manifest — Route A using uniform sampling');
    }

    // ========================================
    // STAGE 5: Load Frame Bitmap
    // ========================================
    self.postMessage({
      event: 'progress',
      msgId: generateMsgId(),
      jobId,
      stage: 'loading_frame'
    });

    const thumbKey = manifest.data.keys ? manifest.data.keys[0] : null;
    if (!thumbKey) {
      throw new Error('No thumbnail key in manifest');
    }

    const thumbArtifact = await storageWrapper.getArtifact(thumbKey);
    if (!thumbArtifact?.blob) {
      throw new Error(`Frame artifact not found: ${thumbKey}`);
    }

    frameBitmap = await createImageBitmap(thumbArtifact.blob);

    // ========================================
    // STAGE 6: Compute Depth/Normals/Flux
    // ========================================
    self.postMessage({
      event: 'progress',
      msgId: generateMsgId(),
      jobId,
      stage: 'computing_depth'
    });

    const chosenRes = chooseResolutionForJob(options, _flags, options.hardwareInfo || {});
    options.resolution = chosenRes;

    const computeResult = await _computeDepthNormalsFlux(
      frameBitmap,
      calibData,
      {
        resolution:        options.resolution || chosenRes,
        quality:           options.priority > 50 ? 'high' : 'medium',
        priority:          options.priority,
        storageWrapper:    storageWrapper,
        plenopticContext:  manifest.data.plenopticContext ?? null,
        // Stage 1 additions
        fresnelDensityMap: fresnelDensityMap,
        manifest:          manifest,           // used by _buildSamplingContext inside
        // Scope fix: pass identifiers so intermediate persist calls inside the
        // function have correct sourceMetaKey / cameraId in their meta blocks.
        metaKey:           metaKey,
        cameraId:          cameraId
      }
    );

    const {
      depthMap, normalMap, fluxData, telemetry, selectorArtifact,
      // Stage 1
      fMapFinal, doaModalResult, penumbraResult,
      // Stage 3 prerequisite
      flowField,
      // Stage 4A prerequisite
      directionalFieldArtResult
    } = computeResult;

    // Normalise telemetry — _fallbackDepthEstimation returns a minimal stub
    // { method, total_ms } without errors/warnings/stages/modules arrays.
    // Any downstream .push() or Object.assign() call will crash without this.
    telemetry.errors   = telemetry.errors   || [];
    telemetry.warnings = telemetry.warnings || [];
    telemetry.stages   = telemetry.stages   || {};
    telemetry.modules  = telemetry.modules  || {};

    console.log('motion.worker: depth/normal/flux telemetry', telemetry);
    console.log('[CHECKPOINT] Stage 7 starting — persisting depth_map');

    // ========================================
    // STAGE 7: Persist Derived Artifacts
    // ========================================

    // Build plenopticContext stub for worker-produced artifacts.
    // _enhanceMetadata (FrameEvictionHook) only runs on live-camera paths and
    // never sees artifacts produced directly by the worker.  We build an
    // equivalent stub here so every depth_map / normal_map artifact carries a
    // non-null plenopticContext regardless of whether a live camera was present.
    //
    // Priority rules:
    //   - Prefer values already stamped in the manifest by _enhanceMetadata
    //     (live-camera path will have these; synthetic/file paths will not)
    //   - Fill gaps from what the worker computed:
    //       effectiveWindowMs  → available after _getDirectionalLifting() runs
    //       temporalEpochUTC   → startTime captures when this reconstruction began
    const _manifestCtx = manifest.data.plenopticContext ?? {};
    const plenopticStub = Object.freeze({
      spectralModel:          _manifestCtx.spectralModel          ?? 'rgb',
      frameRate:              _manifestCtx.frameRate              ?? null,
      effectiveWindowMs:      _manifestCtx.effectiveWindowMs      ?? _effectiveWindowMs,
      temporalEpochUTC:       _manifestCtx.temporalEpochUTC       ?? startTime,
      tetrachromaticExpanded: _manifestCtx.tetrachromaticExpanded ?? false,
      angularApertureSr:      _manifestCtx.angularApertureSr      ?? null
    });

    self.postMessage({
      event: 'progress',
      msgId: generateMsgId(),
      jobId,
      stage: 'persisting_results'
    });

    const depthResult = await _persistAndPin(
      storageWrapper,
      {
      type: 'depth_map',
      data: { field: depthMap.data },
      meta: {
        sourceMetaKey: metaKey,
        cameraId: cameraId,
        plenopticContext: plenopticStub,
        resolution: depthMap.resolution,
        min: depthMap.min,
        max: depthMap.max,
        encoding: depthMap.encoding,
        fallback: depthMap.fallback || false,
        stats: depthMap.stats || {},
        computedAt: Date.now(),
        telemetry: telemetry
      },
      createdAt: new Date().toISOString()
    }, {
      owner: 'motion.worker',
      ttlMs: ARTIFACT_PIN_TTL_MS,  // 5 minutes
      pinType: 'soft'
    });

    if (!depthResult?.metaKey) {
      throw new Error('Depth persistence failed');
    }
    console.log('[CHECKPOINT] persisting normal_map');
    // normal_map — bypasses IDB entirely.
    // topology.worker reads normalMap.data for gradient/curvature computation.
    // The field travels inline in RECON_DONE as normalInline.
    // normalResult is null — cc.normalMapKey will be null everywhere.
    const normalResult = null;
    console.log('[NORMAL] Bypassing IDB — normal_map forwarded inline:', {
      resolution:  normalMap?.resolution,
      fieldLength: normalMap?.data?.length ?? 0,
      encoding:    normalMap?.encoding,
      fallback:    normalMap?.fallback ?? false
    });
    console.log('[CHECKPOINT] persisting flux_field');
    // flux_field — entirely bypasses IDB.
    // All components (A_coo, A_csr, b, SOCs, groups, supports, init_h,
    // diagnostics) are passed inline in the RECON_DONE payload as fluxInline.
    //
    // Rationale for skipping IDB completely:
    //   - flux_field is a per-frame derived artifact — meaningless across sessions
    //   - IDB write cost is proportional to data size and was causing stalls
    //   - All downstream consumers can receive the data directly via msg.fluxInline
    //   - If a future consumer needs IDB durability, reinstate persistence here
    //
    // fluxResult stays null — cc.fluxFieldKey will be null everywhere.
    // Consumers must read from msg.fluxInline / cc.fluxInline.
    let fluxResult = null;
    if (fluxData) {
      console.log('[FLUX] flux_field bypassing IDB — full data inline:', {
        hasACoo:         !!fluxData.A_coo,
        hasAcsr:         !!fluxData.A_csr,
        hasB:            !!fluxData.b,
        hasSOCs:         !!fluxData.SOCs,
        hasGroups:       !!fluxData.groups,
        hasSupports:     !!fluxData.supports,
        hasInitH:        !!fluxData.init_h,
        hasDiagnostics:  !!fluxData.diagnostics,
        solverReady:     fluxData.solverReady ?? false,
        acoRowLength:    fluxData.A_coo?.row?.length  ?? 0,
        socCount:        Array.isArray(fluxData.SOCs)
                           ? fluxData.SOCs.length
                           : (fluxData.SOCs?.length ?? 0)
      });
    } else {
      console.log('[FLUX] fluxData is null — no flux inline data to forward');
    }

    // ── Stage 1 artifact persistence ────────────────────────────────────────
    const stage1SamplingContext = _buildSamplingContext(manifest, chosenRes);
    console.log('[CHECKPOINT] persisting Stage 1 artifacts');
    let directnessResult  = null;
    let modalResult       = null;
    let penumbraArtResult = null;

    // Stage 1 artifacts — NOT persisted to IDB.
    // directness_field, modal_decomposition, and penumbra_field are passed
    // inline in the RECON_DONE payload as stage1Inline.
    // This avoids ~200MB of sequential IDB serialization (80-120s wall time).
    // main.js receives them and forwards to consumer workers directly.

    // ── STAGE 2: PackingSDF ──────────────────────────────────────────────────
    // All inputs are in scope at this point:
    //   depthMap.data        Float32Array  res²          (triangle preprocessor depths)
    //   normalMap.data       Float32Array  res²×3        (xyz-float32 normals)
    //   fMapFinal            Object        {fMap, directness, modalLabels, ...}
    //   penumbraResult       Object        {widthMap, edgeMask, lightTrack, ...}
    //   fresnelDensityMap    Float32Array|null  res²     (loaded at STAGE 4.5)
    //   stage1SamplingContext Object       (built just above this block)
    //
    // Artifacts persisted:
    //   sdf_field        signedSdf + narrowBandMask + densityMap + surfaceMask
    //   disk_seeds       compact binary (PackingSDF.serialize) consumed by Stage 4B
    //   sdf_diagnostics  medStressMap + scaleneVariance (only when packingDebug=true)

    let sdfResult         = null;   // raw PackingSDF.compute() output
    let sdfFieldArtResult = null;   // persisted sdf_field artifact handle
    let diskSeedsResult   = null;   // persisted disk_seeds artifact handle
    let sdfDiagsResult    = null;   // persisted sdf_diagnostics handle (debug only)

    if (_flags.enablePackingSDF !== false && depthMap && normalMap) {
      const stage2Start = performance.now();
      console.log('[CHECKPOINT] Stage 2 — entering PackingSDF block');
      try {
        const directnessField =
          fMapFinal?.directness    instanceof Float32Array ? fMapFinal.directness    : null;
        const penumbraField   =
          penumbraResult?.widthMap instanceof Float32Array ? penumbraResult.widthMap : null;

        console.log('[STAGE2-SDF] starting PackingSDF.compute()', {
          resolution:    chosenRes,
          hasDirectness: !!directnessField,
          hasPenumbra:   !!penumbraField,
          umbraPolicy:   _flags.packingUmbraPolicy ?? 'half-weight'
        });

        // ── DIAGNOSTIC: SDF inputs check ─────────────────────────────────
        // Verify depth and normal maps are non-degenerate before passing to SDF.
        try {
          const depthData = depthMap.data;
          let sdfDMin = Infinity, sdfDMax = -Infinity;
          const sdfStride = Math.max(1, Math.floor(depthData.length / 5000));
          for (let i = 0; i < depthData.length; i += sdfStride) {
            if (depthData[i] < sdfDMin) sdfDMin = depthData[i];
            if (depthData[i] > sdfDMax) sdfDMax = depthData[i];
          }
          console.log('[DIAG-SDF-INPUT] depth range entering PackingSDF:', {
            min:   sdfDMin.toFixed(6),
            max:   sdfDMax.toFixed(6),
            range: (sdfDMax - sdfDMin).toFixed(6),
            isFlat: (sdfDMax - sdfDMin) < 0.01
          });
        } catch (diagErr) {
          console.warn('[DIAG-SDF-INPUT] Input check failed:', diagErr.message);
        }
        // ── END DIAGNOSTIC ────────────────────────────────────────────────

        // Normalize depth to [0,1] — PackingSDF's depthDiscontinuityThreshold
        // and GPT σ² scalene variance assume this range. Raw triangle preprocessor
        // output is in physical units (~0.8–2.5), causing almost no edges to be
        // detected and the EDT to fill with sentinel values (1e9).
        const { min: _dMin, max: _dMax } = typedMinMax(depthMap.data);
        const _dRange = Math.max(1e-6, _dMax - _dMin);
        const _normalizedDepth = new Float32Array(depthMap.data.length);
        for (let i = 0; i < depthMap.data.length; i++) {
          _normalizedDepth[i] = (depthMap.data[i] - _dMin) / _dRange;
        }

        sdfResult = await _getPackingSDF().compute(
          _normalizedDepth,
          normalMap.data,
          directnessField,
          penumbraField,
          {
            width:  chosenRes,
            height: chosenRes,
            // Modal labels from Stage 1 DOA — drive per-partition seed placement.
            modalLabels: fMapFinal?.modalLabels instanceof Uint8Array
              ? fMapFinal.modalLabels
              : null,
            // Fresnel density: biases seed concentration toward penumbra edges.
            fresnelDensity: fresnelDensityMap instanceof Float32Array
              ? fresnelDensityMap
              : null,
            metaKey,
            cameraId
          }
        );

        console.log('[STAGE2-SDF] compute() done in',
          (performance.now() - stage2Start).toFixed(1), 'ms', {
            seedCount:        sdfResult.diskSeeds?.length ?? 0,
            narrowBandPixels: sdfResult.meta?.narrowBandPixels ?? 'n/a',
            sdfRange:         sdfResult.meta?.sdfRange         ?? 'n/a'
          });

          // ── DIAGNOSTIC: SDF output quality check ─────────────────────────
        try {
          const narrowBandPx  = sdfResult.meta?.narrowBandPixels ?? 0;
          const seedCount     = sdfResult.diskSeeds?.length ?? 0;
          const sdfRange      = sdfResult.meta?.sdfRange ?? [null, null];
          const sentinelMin   = sdfRange[0] > 1e8;  // uninitialized sentinel
          const sentinelMax   = sdfRange[1] > 1e8;
          const isDegenerate  = narrowBandPx === 0 || seedCount === 0 || sentinelMin || sentinelMax;

          console.log('[DIAG-SDF-OUTPUT] PackingSDF result quality:', {
            narrowBandPixels: narrowBandPx,
            seedCount,
            sdfRangeMin:      sdfRange[0],
            sdfRangeMax:      sdfRange[1],
            hasSentinelValues: sentinelMin || sentinelMax,
            isDegenerate,
            verdict: isDegenerate
              ? '❌ DEGENERATE SDF — minimizer will receive empty constraint system'
              : '✅ SDF looks valid'
          });

          if (isDegenerate) {
            // Sample the signedSdf buffer directly to see what PackingSDF produced
            if (sdfResult.signedSdf) {
              let sMin = Infinity, sMax = -Infinity;
              const s = sdfResult.signedSdf;
              const stride = Math.max(1, Math.floor(s.length / 5000));
              for (let i = 0; i < s.length; i += stride) {
                if (s[i] < sMin) sMin = s[i];
                if (s[i] > sMax) sMax = s[i];
              }
              console.log('[DIAG-SDF-OUTPUT] signedSdf buffer range:', {
                min:    sMin,
                max:    sMax,
                first5: Array.from(s.slice(0, 5))
              });
            }
          }
        } catch (diagErr) {
          console.warn('[DIAG-SDF-OUTPUT] Output check failed:', diagErr.message);
        }
        // ── END DIAGNOSTIC ────────────────────────────────────────────────

      } catch (sdfErr) {
        console.warn('[STAGE2-SDF] compute() failed (non-fatal):', sdfErr.message);
        telemetry.warnings.push(`packingSDF: ${sdfErr.message}`);
        sdfResult = null;
      }

      if (sdfResult) {

        // ── Persist sdf_field (scalar metadata only) ───────────────────────
        // signedSdf, narrowBandMask, densityMap, surfaceMask are NOT written
        // to IDB — they are passed inline in the RECON_DONE payload (sdfInline).
        // This eliminates a ~13MB sequential IDB write that caused 900s+ stalls.
        //
        // What IS persisted: scalar metadata only (ranges, counts, policy params)
        // for durability/debugging. This record has a metaKey that downstream
        // code can use to check whether Stage 2 ran, but contains no TypedArrays.
        //
        // Consumers (topology.worker, minimizer.worker) receive the actual arrays
        // via msg.sdfInline — no getArtifact call needed for these fields.
        try {
          sdfFieldArtResult = await _persistAndPin(
            storageWrapper,
            {
              type: 'sdf_field',
              data: {
                // Scalar summary only — no TypedArrays
                sdfRange:         sdfResult.meta?.sdfRange         ?? null,
                narrowBandPixels: sdfResult.meta?.narrowBandPixels ?? null,
                seedCount:        sdfResult.diskSeeds?.length      ?? 0,
                modalBreakdown:   sdfResult.meta?.modalBreakdown   ?? null,
                // Flag so consumers know the real data is inline, not here
                dataInline:       true
              },
              meta: {
                sourceMetaKey:   metaKey,
                cameraId,
                resolution:      chosenRes,
                sdfRange:        sdfResult.meta?.sdfRange         ?? null,
                narrowBandPx:    sdfResult.meta?.narrowBandPixels ?? null,
                umbraPolicy:     _flags.packingUmbraPolicy         ?? 'half-weight',
                bandBase:        _flags.packingBandBase             ?? 0.03,
                bandScale:       _flags.packingBandScale            ?? 3.0,
                samplingContext: stage1SamplingContext,
                computedAt:      Date.now()
              },
              createdAt: new Date().toISOString()
            },
            { owner: 'motion.worker', ttlMs: ARTIFACT_PIN_TTL_MS, pinType: 'soft' }
          );
          console.log('[PERSIST] ✓ sdf_field (scalar metadata only, arrays are inline):', {
            metaKey:          sdfFieldArtResult?.metaKey?.slice(0, 32),
            narrowBandPixels: sdfResult.meta?.narrowBandPixels ?? 0,
            seedCount:        sdfResult.diskSeeds?.length ?? 0,
            sdfRange:         sdfResult.meta?.sdfRange ?? null
          });
        } catch (e) {
          console.warn('[PERSIST] ✗ sdf_field scalar metadata failed (non-fatal):', e.message);
        }

        // ── Persist disk_seeds ─────────────────────────────────────────────
        // Serialised via PackingSDF.serialize() for compact binary transfer.
        // Stage 4B (ConstrainedMinimizer) reads this via PackingSDF.deserialize().
        try {
          const { header: seedHeader, payload: seedPayload } =
            _getPackingSDF().serialize(sdfResult, { includeMetStress: false });

          diskSeedsResult = await _persistAndPin(
            storageWrapper,
            {
              type: 'disk_seeds',
              data: {
                header:  seedHeader,
                payload: seedPayload   // ArrayBuffer — compact binary
              },
              meta: {
                sourceMetaKey:   metaKey,
                cameraId,
                resolution:      chosenRes,
                seedCount:       sdfResult.diskSeeds?.length   ?? 0,
                modalBreakdown:  sdfResult.meta?.modalBreakdown ?? null,
                samplerSeed:     _flags.packingSamplerSeed       ?? 0xF1E2D3C4,
                samplingContext: stage1SamplingContext,
                computedAt:      Date.now()
              },
              createdAt: new Date().toISOString()
            },
            { owner: 'motion.worker', ttlMs: ARTIFACT_PIN_TTL_MS, pinType: 'soft' }
          );
          console.log('[PERSIST] disk_seeds:', diskSeedsResult?.metaKey?.slice(0, 32),
            '(', sdfResult.diskSeeds?.length ?? 0, 'seeds)');
        } catch (e) {
          console.warn('[PERSIST] disk_seeds failed (non-fatal):', e.message);
        }

        // ── Persist sdf_diagnostics (packingDebug only) ────────────────────
        if (_flags.packingDebug && sdfResult.medStressMap) {
          try {
            sdfDiagsResult = await _persistAndPin(
              storageWrapper,
              {
                type: 'sdf_diagnostics',
                data: {
                  medStressMap:    sdfResult.medStressMap,
                  scaleneVariance: sdfResult.scaleneVariance
                },
                meta: {
                  sourceMetaKey: metaKey,
                  cameraId,
                  resolution:    chosenRes,
                  computedAt:    Date.now()
                },
                createdAt: new Date().toISOString()
              },
              { owner: 'motion.worker', ttlMs: INTERMEDIATE_TTL_MS, pinType: 'soft' }
            );
            console.log('[PERSIST] sdf_diagnostics:', sdfDiagsResult?.metaKey?.slice(0, 32));
          } catch (e) {
            console.warn('[PERSIST] sdf_diagnostics failed (non-fatal):', e.message);
          }
        }

      } // end if (sdfResult)

    } else if (_flags.enablePackingSDF === false) {
      console.log('[STAGE2-SDF] skipped (enablePackingSDF=false)');
    } else {
      console.warn('[STAGE2-SDF] skipped — depthMap or normalMap unavailable');
    }
    // ── END STAGE 2 ──────────────────────────────────────────────────────────

    // ── STAGE 3 PREREQUISITE: persist flow_field ─────────────────────────────
    // Produced by Horn-Schunck in _computeDepthNormalsFlux.
    // null when enableOpticalFlow=false OR when H-S failed.
    // DifferentialGeometry reads this key and computes flow_divergence / flow_curl.
    let flowFieldResult = null;
    if (flowField) {
      try {
        flowFieldResult = await _persistAndPin(
          storageWrapper,
          {
            type: 'flow_field',
            data: {
              u:      flowField.u,
              v:      flowField.v,
              width:  flowField.width,
              height: flowField.height
            },
            meta: {
              sourceMetaKey:   metaKey,
              cameraId,
              resolution:      chosenRes,
              alpha:           _flags.opticalFlowAlpha      ?? 1.0,
              iterations:      _flags.opticalFlowIterations ?? 30,
              method:          'horn_schunck',
              samplingContext: stage1SamplingContext,
              computedAt:      Date.now()
            },
            createdAt: new Date().toISOString()
          },
          { owner: 'motion.worker', ttlMs: ARTIFACT_PIN_TTL_MS, pinType: 'soft' }
        );
        console.log('[PERSIST] flow_field:', flowFieldResult?.metaKey?.slice(0, 32));
      } catch (e) {
        console.warn('[PERSIST] flow_field failed (non-fatal):', e.message);
      }
    }    

    let selectorResult = null;
    if (selectorArtifact && _flags.bssPersistSelector) {
      try {
        selectorResult = await _persistArtifact(
          storageWrapper,
          null,
          selectorArtifact,
          {
            type: 'selector',
            sourceMetaKey: metaKey,
            computedAt: Date.now()
          }
        );
      } catch (selErr) {
        console.warn('motion.worker: Selector persistence failed', selErr);
      }
    }

    // ── STAGE 4: DifferentialGeometry ────────────────────────────────────────
    let diffGeoResult = null;

    if (sdfFieldArtResult?.metaKey && normalMap?.data) {
      console.log('[CHECKPOINT] Stage 4 — starting DifferentialGeometry.compute()');
      // Diagnose seed format so we can normalize correctly for DG
      if (sdfResult?.diskSeeds?.length > 0) {
        const s0 = sdfResult.diskSeeds[0];
        console.log('[DG-SEED-FORMAT] First seed keys:', Object.keys(s0 ?? {}));
        console.log('[DG-SEED-FORMAT] First seed values:', JSON.stringify(s0));
      }
      try {
      const dg = _getDifferentialGeometry();
      diffGeoResult = await dg.compute({
        storageWrapper,
        sdfFieldKey:   sdfFieldArtResult?.metaKey  ?? null,
        diskSeedsKey:  diskSeedsResult?.metaKey    ?? null,
        normalMapKey:  null,
        flowFieldKey:  flowFieldResult?.metaKey    ?? null,
        fluxFieldKey:  null,
        // Pass flow inline — avoids the IDB round-trip that sdfInline/normalInline
        // already eliminated. flowFieldKey is kept as a durability fallback.
        flowInline: flowField
          ? { u: flowField.u, v: flowField.v }
          : null,
        sourceMetaKey: metaKey,
        cameraId,
        resolution:    chosenRes,
        samplingContext: stage1SamplingContext,
        sdfInline: sdfResult ? {
          signedSdf:      sdfResult.signedSdf,
          narrowBandMask: sdfResult.narrowBandMask
        } : null,
        normalInline: normalMap ? {
          field:      normalMap.data,
          resolution: normalMap.resolution
        } : null,
        fluxInline: fluxData ? {
          A_coo: fluxData.A_coo ?? null
        } : null,
        diskSeedsInline: sdfResult?.diskSeeds?.length > 0
          ? sdfResult.diskSeeds.map(s => ({
              x: s.xNorm,
              y: s.yNorm,
              r: s.radius ?? 0
            }))
          : null
      });

        // Broadcast DIFFGEO_DONE on BroadcastChannel
        _bcPost({
          event:     'DIFFGEO_DONE',
          msgId:     generateMsgId(),
          metaKey,
          stage4: {
            curvatureKey:       diffGeoResult.curvatureKey,
            principalFrameKey:  diffGeoResult.principalFrameKey,
            sdfDivKey:          diffGeoResult.sdfDivKey,
            sdfCurlKey:         diffGeoResult.sdfCurlKey,
            normalCurlKey:      diffGeoResult.normalCurlKey,
            flowDivKey:         diffGeoResult.flowDivKey    ?? null,
            flowCurlKey:        diffGeoResult.flowCurlKey   ?? null,
            overhangCurlKey:    diffGeoResult.overhangCurlKey ?? null
          },
          processingMs: diffGeoResult.telemetry?.processingMs ?? null,
          producer: 'motion.worker',
          source:   'motion.worker',
          timestamp: Date.now()
        });

        console.log('[STAGE4-DG] DifferentialGeometry complete in',
          diffGeoResult.telemetry?.processingMs?.toFixed(1), 'ms');
      } catch (dgErr) {
        console.warn('[STAGE4-DG] DifferentialGeometry failed (non-fatal):', dgErr.message);
        diffGeoResult = null;
      }
    } else {
      console.log('[STAGE4-DG] skipped — sdfFieldKey or normalMapKey unavailable');
    }
    console.log('[CHECKPOINT] assembling derivedKeys');
      const derivedKeys = [
      depthResult       && depthResult.metaKey,
      directionalFieldArtResult && directionalFieldArtResult.metaKey,
      normalResult      && normalResult.metaKey,
      fluxResult        && fluxResult.metaKey,
      selectorResult    && selectorResult.metaKey,
      // Stage 1
      directnessResult  && directnessResult.metaKey,
      modalResult       && modalResult.metaKey,
      penumbraArtResult && penumbraArtResult.metaKey,
      // Stage 2
      sdfFieldArtResult && sdfFieldArtResult.metaKey,
      diskSeedsResult   && diskSeedsResult.metaKey,
      sdfDiagsResult    && sdfDiagsResult.metaKey,
      // Stage 3 prerequisite
      flowFieldResult   && flowFieldResult.metaKey,
      // Stage 4
      diffGeoResult?.curvatureKey,
      diffGeoResult?.principalFrameKey,
      diffGeoResult?.sdfDivKey,
      diffGeoResult?.sdfCurlKey,
      diffGeoResult?.normalCurlKey,
      diffGeoResult?.flowDivKey,
      diffGeoResult?.flowCurlKey,
      diffGeoResult?.overhangCurlKey
    ].filter(Boolean);

    // --------------------------------------------------------------------
    // NEW: Wait for derived artifacts to become visible to other connections.
    // This avoids a race where worker sees put success but other contexts
    // (main thread / test harness) cannot immediately read the artifact.
    // We keep this short so worker doesn't stall forever.
    // --------------------------------------------------------------------
    // Visibility wait removed — artifacts are committed to IDB before this
    // point and the BC broadcast provides sufficient ordering guarantee.
    // The previous per-artifact polling loop (5s × N keys) was causing
    // multi-minute stalls under quota pressure where the evictor was
    // immediately removing artifacts after write.
    telemetry.derivedVisible = derivedKeys;

    // ========================================
    // STAGE 8: compute processingMs, update _metrics
    // ========================================
    const processingMs = Date.now() - startTime;

    _metrics.reconstructionCount = (_metrics.reconstructionCount || 0) + 1;
    _metrics.jobsHandled = (_metrics.jobsHandled || 0) + 1;
    _metrics.totalProcessingMs = (_metrics.totalProcessingMs || 0) + processingMs;
    _metrics.avgProcessingMs = _metrics.jobsHandled > 0 ? (_metrics.totalProcessingMs / _metrics.jobsHandled) : 0;
    if (depthMap && !depthMap.fallback) _metrics.depthComputeCount = (_metrics.depthComputeCount || 0) + 1;
    if (fluxData) _metrics.fluxComputeCount = (_metrics.fluxComputeCount || 0) + 1;

    // ========================================
    // STAGE 9: Persist telemetry artifact
    // ========================================
    console.log('[CHECKPOINT] Stage 9 — persisting telemetry (fire-and-forget)');
    // Not awaited — telemetry is debug-only, no downstream consumer reads it.
    // Removing the await lets RECON_DONE broadcast immediately after Stage 10.
    (async () => {
      try {
        const telemetryPayload = {
          jobId,
          metaKey,
          cameraId:        cameraId,
          cameraContainer: cameraContainer || undefined,
          priority:        options.priority || 50,
          resolution:      options.resolution,

          // Stage 0
          reconstructionResolution: depthMap ? depthMap.resolution : (options.resolution || null),
          effectiveWindowMs:        _effectiveWindowMs,

          // Stage 1
          stage1: {
            directnessKey:   directnessResult?.metaKey    ?? null,
            modalKey:        modalResult?.metaKey          ?? null,
            penumbraKey:     penumbraArtResult?.metaKey    ?? null,
            fMapRoute:       fMapFinal?.route              ?? null,
            fMapNSamples:    fMapFinal?.N_samples          ?? 0,
            lightCount:      penumbraResult?.telemetry?.lightCount  ?? 0,
            edgeCount:       penumbraResult?.telemetry?.edgeCount   ?? 0,
            meanWidth:       penumbraResult?.telemetry?.meanWidth   ?? null,
            meanKappa:       doaModalResult?.telemetry?.meanKappa   ?? null,
            samplingContext: stage1SamplingContext
          },

          // Stage 2
          stage2: {
            sdfFieldKey:    sdfFieldArtResult?.metaKey  ?? null,
            diskSeedsKey:   diskSeedsResult?.metaKey    ?? null,
            sdfDiagsKey:    sdfDiagsResult?.metaKey     ?? null,
            seedCount:      sdfResult?.diskSeeds?.length ?? 0,
            narrowBandPx:   sdfResult?.meta?.narrowBandPixels ?? null,
            sdfRange:       sdfResult?.meta?.sdfRange         ?? null,
            modalBreakdown: sdfResult?.meta?.modalBreakdown   ?? null,
            umbraPolicy:    _flags.packingUmbraPolicy          ?? 'half-weight',
            timings:        sdfResult?.meta?.timings           ?? null
          },

          // Stage 3 prerequisite
          stage3: {
            flowFieldKey:   flowFieldResult?.metaKey   ?? null,
            method:         'horn_schunck',
            alpha:          _flags.opticalFlowAlpha      ?? 1.0,
            iterations:     _flags.opticalFlowIterations ?? 30
          },

          // Stage 4
          stage4: {
            curvatureKey:      diffGeoResult?.curvatureKey      ?? null,
            principalFrameKey: diffGeoResult?.principalFrameKey ?? null,
            sdfDivKey:         diffGeoResult?.sdfDivKey         ?? null,
            sdfCurlKey:        diffGeoResult?.sdfCurlKey        ?? null,
            normalCurlKey:     diffGeoResult?.normalCurlKey     ?? null,
            flowDivKey:        diffGeoResult?.flowDivKey        ?? null,
            flowCurlKey:       diffGeoResult?.flowCurlKey       ?? null,
            overhangCurlKey:   diffGeoResult?.overhangCurlKey   ?? null
          },

          stages:               telemetry.stages,
          modules:              telemetry.modules,
          processingMs:         processingMs,
          estimatedMemoryBytes: telemetry.estimatedMemoryBytes || null,
          depthStats:           depthMap ? { min: depthMap.min, max: depthMap.max } : null,
          depthFallback:        !!(depthMap && depthMap.fallback),
          fluxPoints:           fluxData ? (fluxData.sampleSummary?.points || null) : null,
          flags:                _flags,
          errors:               telemetry.errors   || [],
          warnings:             telemetry.warnings || []
        };

        const telemetryRes = await _persistArtifact(storageWrapper, null, telemetryPayload, {
          type: 'recon_telemetry',
          sourceMetaKey: metaKey,
          jobId
        });

        if (telemetryRes && telemetryRes.metaKey) {
          _bcPost({
            event: 'artifact:ready',
            msgId: generateMsgId(),
            metaKey: telemetryRes.metaKey,
            meta: { type: 'recon_telemetry', jobId }
          });
        }
      } catch (tErr) {
        console.warn('motion.worker: telemetry persistence failed', tErr);
      }
    })();

    // ========================================
    // STAGE 10: Verify Ownership & Mark Done
    // ========================================
    self.postMessage({
      event: 'progress',
      msgId: generateMsgId(),
      jobId,
      stage: 'verifying_ownership'
    });

    console.log('[CHECKPOINT] Stage 10 — calling markReconDone');
    if (storageWrapper.getReconStatus && storageWrapper.markReconDone) {
      try {
        const finalStatus = await storageWrapper.getReconStatus(metaKey);

        if (finalStatus && finalStatus.reqId !== jobId) {
          console.warn(`motion.worker: reqId mismatch (expected ${jobId}, found ${finalStatus.reqId})`);
          self.postMessage({
            event: 'RECON_CONFLICT',
            msgId: generateMsgId(),
            jobId,
            metaKey,
            reason: 'reqId mismatch - another worker took over',
            existingReqId: finalStatus.reqId
          });
          return;
        }

        await storageWrapper.markReconDone(jobId, derivedKeys);

        // Stop heartbeat immediately after markReconDone — the finally block
        // will also attempt this, but stopping here prevents the race where
        // the interval fires between markReconDone and finally cleanup,
        // producing a spurious "not running (state: done)" miss log.
        try {
          const jobEntry = _jobs.get(jobId);
          if (jobEntry?.heartbeatTimer) {
            _stopHeartbeat(jobEntry.heartbeatTimer);
            jobEntry.heartbeatTimer = null;
          }
        } catch (_) {}

      } catch (mdErr) {
        console.warn('motion.worker: markReconDone verification/update failed', mdErr);
        try {
          await storageWrapper.markReconDone(jobId, derivedKeys);
        } catch (retryErr) {
          console.error('motion.worker: markReconDone retry failed', retryErr);
        }
      }
    }

    // ========================================
    // STAGE 11: Cleanup Bitmaps
    // ========================================
    try {
      if (frameBitmap && typeof frameBitmap.close === 'function') frameBitmap.close();
    } catch (cleanupErr) {
      console.warn('motion.worker: Bitmap cleanup error', cleanupErr);
    }

    // ========================================
    // STAGE 12: Reply & Broadcast RECON_DONE
    // ========================================

    // ── Precompute cosThetaSoc before building replyPayload ───────────────
    // fluxData.SOCs is an array of up to 1M+ objects. Structured-cloning 1M
    // objects via _bcPost(replyPayload) allocates 50–200MB extra and kills
    // the renderer process (OOM). cosThetaSoc (4MB Float32Array) carries
    // exactly the same per-pixel information.
    let _cosThetaSoc = null;
    if (fluxData?.SOCs?.length > 0) {
      const _pxN = chosenRes * chosenRes;
      _cosThetaSoc = new Float32Array(_pxN); // default 0 = 90° contact angle
      for (const soc of fluxData.SOCs) {
        const px = soc.pixelIdx;
        if (typeof px === 'number' && px >= 0 && px < _pxN) {
          _cosThetaSoc[px] = Math.cos(soc.halfAngle ?? 0);
        }
      }
      console.log('[FLUX] cosThetaSoc precomputed from SOCs:', {
        pixelCount:  _pxN,
        socCount:    fluxData.SOCs.length,
        nonZeroApprox: fluxData.SOCs.length
      });
    }

    const replyPayload = {
      event:    'RECON_DONE',
      msgId:    generateMsgId(),
      jobId,
      metaKey,
      derivedKeys,
      cached:   false,

      // Stage 0 container writeback (unchanged)
      cameraId:                 cameraId || null,
      reconstructionResolution: depthMap ? depthMap.resolution : (options.resolution || null),
      effectiveWindowMs:        _effectiveWindowMs,

      // Stage 1 keys — null because these are passed inline, not via IDB
      stage1: {
        directnessKey: null,
        modalKey:      null,
        penumbraKey:   null,
        fMapRoute:     fMapFinal?.route              ?? null,
        lightCount:    penumbraResult?.telemetry?.lightCount ?? 0,
        edgeCount:     penumbraResult?.telemetry?.edgeCount  ?? 0,
        meanWidth:     penumbraResult?.telemetry?.meanWidth  ?? null
      },

      // Stage 1 inline data — transferred directly to avoid IDB serialization.
      // main.js forwards each field to the consumer worker that needs it.
      // TypedArrays are structured-cloned here (one copy); main.js then
      // transfers ownership to the consumer (zero additional copy).
      stage1Inline: {
        fMapFinal: fMapFinal ? {
          fMap:        fMapFinal.fMap,        // Float32Array res²
          directness:  fMapFinal.directness,  // Float32Array res²
          modalLabels: fMapFinal.modalLabels, // Uint8Array   res²
          route:       fMapFinal.route,
          N_samples:   fMapFinal.N_samples
        } : null,
        doaModal: null, // 6×4MB Float32Arrays — no consumer in topology/minimizer/ambi
        penumbra: penumbraResult ? {
          widthMap:   penumbraResult.widthMap,   // Float32Array res²
          edgeMask:   penumbraResult.edgeMask,   // Uint8Array   res²
          lightTrack: penumbraResult.lightTrack, // small array of light positions
          telemetry:  penumbraResult.telemetry
        } : null
      },

      // Stage 2 keys + summary.
      // sdfFieldKey points to the scalar-metadata-only IDB record (no arrays).
      // Actual SDF arrays travel in sdfInline below.
      // diskSeedsKey points to the full binary seeds artifact in IDB (small, kept).
      stage2: {
        sdfFieldKey:  sdfFieldArtResult?.metaKey ?? null,
        diskSeedsKey: diskSeedsResult?.metaKey   ?? null,
        seedCount:    sdfResult?.diskSeeds?.length ?? 0,
        sdfRange:     sdfResult?.meta?.sdfRange   ?? null
      },

      // Disk seeds for minimizer.worker — normalized {x,y,r} in [0,1].
      // Eliminates the IDB read inside minimizer.worker for disk_seeds.
      // Seeds are tiny (~35 objects × ~24 bytes = <1KB), negligible clone cost.
      diskSeedsForMinimizer: sdfResult?.diskSeeds?.length > 0
        ? sdfResult.diskSeeds.map(s => ({
            x: s.xNorm,
            y: s.yNorm,
            r: s.radius ?? 0
          }))
        : null,

      // ── sdfInline: SDF TypedArrays transferred directly, no IDB round-trip ──
      // signedSdf + narrowBandMask: consumed by topology.worker and minimizer.worker.
      // densityMap + surfaceMask:   no confirmed consumer yet — included so
      //   cameraContainer.sdfInline has the full picture for future consumers.
      //   If a future stage needs them, main.js already has them in cc.sdfInline
      //   and can forward without any IDB read.
      //
      // All four fields are excluded from IDB to eliminate the ~13MB write stall.
      // Any consumer that needs them reads from msg.sdfInline (worker dispatch) or
      // cc.sdfInline (cameraContainer lookup in main.js).
      sdfInline: sdfResult ? {
        signedSdf:      sdfResult.signedSdf,
        narrowBandMask: sdfResult.narrowBandMask
        // densityMap and surfaceMask: no confirmed consumer
      } : null,

      // normal_map inline — xyz-float32 normals forwarded directly.
      // DifferentialGeometry and topology.worker read from msg.normalInline.
      // No IDB write — eliminates the 12MB sequential serialization stall.
      // normalInline removed from BC payload — DG consumed it and produced
      // dgInline.normalCurl. No downstream worker reads normalInline.field.
      // The 12MB Float32Array was cloned 3+ times for no purpose.
      normalInline: null,

      // Stage 3 prerequisite
      stage3: {
        flowFieldKey:         flowFieldResult?.metaKey            ?? null,
        directionalFieldKey:  directionalFieldArtResult?.metaKey  ?? null
      },

      // Stage 4 — IDB keys (persisted for durability)
      stage4: {
        curvatureKey:      diffGeoResult?.curvatureKey      ?? null,
        principalFrameKey: diffGeoResult?.principalFrameKey ?? null,
        sdfDivKey:         diffGeoResult?.sdfDivKey         ?? null,
        sdfCurlKey:        diffGeoResult?.sdfCurlKey        ?? null,
        normalCurlKey:     diffGeoResult?.normalCurlKey     ?? null,
        flowDivKey:        diffGeoResult?.flowDivKey        ?? null,
        flowCurlKey:       diffGeoResult?.flowCurlKey       ?? null,
        overhangCurlKey:   diffGeoResult?.overhangCurlKey   ?? null
      },

      // ── dgInline: DG arrays forwarded directly, no IDB round-trip ─────
      // kH consumed by topology, minimizer, ambi.
      // principalE1/E2 consumed by ambi only.
      // normalCurl, flowCurl, flowDiv consumed by topology only.
      // All are structured-cloned on postMessage — each consumer gets
      // its own independent copy, no ownership conflict.
      dgInline: diffGeoResult?.dgInline ? {
        kH:          diffGeoResult.dgInline.kH,
        principalE1: diffGeoResult.dgInline.principalE1,
        principalE2: diffGeoResult.dgInline.principalE2,
        normalCurl:  diffGeoResult.dgInline.normalCurl  ?? null,
        flowCurl:    diffGeoResult.dgInline.flowCurl    ?? null,
        flowDiv:     diffGeoResult.dgInline.flowDiv     ?? null
      } : null,

      // fluxFieldKey is null — flux_field is entirely bypassed for IDB.
      fluxFieldKey: null,

      // ── fluxInline: complete flux_field data, no IDB involved ─────────────
      // Components:
      //   A_coo        — sparse constraint matrix (COO format) — used by extractSOCs()
      //   A_csr        — sparse constraint matrix (CSR format) — used by solver
      //   b            — right-hand side vector
      //   cosThetaSoc  — Float32Array res² replacing SOCs (1M objects → 4MB TypedArray)
      //   groups       — constraint group assignments
      //   supports     — support region masks
      //   init_h       — warm-start vector (Float32Array)
      //   diagnostics  — solver telemetry
      //   solverReady  — flag indicating constraint system is valid
      //
      // SOCs deliberately excluded: 1M JavaScript objects × structured-clone overhead
      // = 50–200MB extra allocation → OOM renderer crash. cosThetaSoc carries the
      // same per-pixel cos(halfAngle) data as a 4MB Float32Array.
      // init_h forced to Float32Array: plain JS arrays of 1M numbers are also
      // expensive to clone (~32MB vs 4MB for TypedArray).
      fluxInline: fluxData ? {
        A_coo:       fluxData.A_coo        ?? null,
        A_csr:       fluxData.A_csr        ?? null,
        b:           fluxData.b            ?? null,
        SOCs:        null,          // removed — replaced by cosThetaSoc below
        cosThetaSoc: _cosThetaSoc,  // Float32Array res² — cos(halfAngle) per pixel
        groups:      fluxData.groups       ?? null,
        supports:    fluxData.supports     ?? null,
        init_h:      fluxData.init_h instanceof Float32Array
                       ? fluxData.init_h
                       : (fluxData.init_h ? new Float32Array(fluxData.init_h) : null),
        diagnostics:  fluxData.diagnostics  ?? null,
        solverReady:  fluxData.solverReady  ?? false,
        sampleSummary: fluxData.sampleSummary ?? null
      } : null,

      telemetry: {
        processingMs,
        depthResolution:  depthMap  ? depthMap.resolution  : null,
        normalResolution: normalMap ? normalMap.resolution : null,
        hasFlux:          !!fluxData,
        hasSdf:           !!sdfResult,
        seedCount:        sdfResult?.diskSeeds?.length ?? 0,
        fallback:         depthMap  ? depthMap.fallback || false : true,
        stages:           telemetry.stages,
        modules:          telemetry.modules,
        errors:           telemetry.errors,
        warnings:         telemetry.warnings
      }
    };

    console.log('[CHECKPOINT] Stage 12 — broadcasting RECON_DONE');

    // ── Traceability log before RECON_DONE dispatch ────────────────────────
    console.log('[RECON_DONE] Broadcasting payload summary:', {
      // sdfInline
      hasSdfInline:         !!replyPayload.sdfInline,
      signedSdfLength:      replyPayload.sdfInline?.signedSdf?.length      ?? 0,
      narrowBandMaskLength: replyPayload.sdfInline?.narrowBandMask?.length ?? 0,
      densityMapLength:     replyPayload.sdfInline?.densityMap?.length     ?? 0,
      surfaceMaskLength:    replyPayload.sdfInline?.surfaceMask?.length    ?? 0,
      // fluxInline — now carries full flux_field, not just A_coo
      hasFluxInline:        !!replyPayload.fluxInline,
      fluxHasACoo:          !!replyPayload.fluxInline?.A_coo,
      fluxHasAcsr:          !!replyPayload.fluxInline?.A_csr,
      fluxHasSOCs:          !!replyPayload.fluxInline?.SOCs,
      fluxHasInitH:         !!replyPayload.fluxInline?.init_h,
      fluxSolverReady:      replyPayload.fluxInline?.solverReady ?? false,
      acoRowLength:         replyPayload.fluxInline?.A_coo?.row?.length    ?? 0,
      // stage1Inline
      hasStage1Inline:      !!replyPayload.stage1Inline,
      // normalInline
      hasNormalInline:      !!replyPayload.normalInline,
      normalFieldLength:    replyPayload.normalInline?.field?.length ?? 0,
      // dgInline
      hasDgInline:          !!replyPayload.dgInline,
      hasKH:                !!replyPayload.dgInline?.kH,
      hasPrincipalE1:       !!replyPayload.dgInline?.principalE1,
      kHLength:             replyPayload.dgInline?.kH?.length ?? 0,
      // IDB keys — flux is null (inline), sdf is scalar only
      sdfFieldKey:          replyPayload.stage2?.sdfFieldKey               ?? null,
      diskSeedsKey:         replyPayload.stage2?.diskSeedsKey              ?? null,
      fluxFieldKey:         null,
      derivedKeyCount:      replyPayload.derivedKeys?.length               ?? 0
    });

    // MotionWorkerWrapper only needs job metadata — strip the inline arrays.
    // Sending the full replyPayload here clones ~140MB that is immediately discarded.
    self.postMessage({
      event:       'RECON_DONE',
      msgId:       replyPayload.msgId,
      jobId:       replyPayload.jobId,
      metaKey:     replyPayload.metaKey,
      derivedKeys: replyPayload.derivedKeys,
      cached:      false
    });
    _bcPost(replyPayload);

  } catch (err) {
    const se = safeErrSummary(err);
    console.error('motion.worker: RECONSTRUCT_META failed', err);
    
    try {
      const storageWrapper2 = storageWrapper || await _loadStorageAPI();
      if (storageWrapper2.markReconFailed) {
        await storageWrapper2.markReconFailed(jobId, String(se.message), 300000);
      }
    } catch (statusErr) {
      console.warn('motion.worker: markReconFailed error', statusErr);
    }

    _metrics.lastError = String(se.message);

    const errorPayload = {
      event: 'RECON_FAIL',
      msgId: generateMsgId(),
      jobId,
      metaKey,
      error: String(se.message),
      stack: se.stack || null,
      telemetry: {
        processingMs: Date.now() - startTime,
        failedAt: 'unknown'
      }
    };

    self.postMessage(errorPayload);

    _bcPost({
      event: 'RECON_FAIL',
      msgId: generateMsgId(),
      metaKey,
      error: String(se.message),
      producer: 'motion.worker',
      timestamp: Date.now()
    });
  } finally {
    try {
      const jobEntry = _jobs.get(jobId);
      if (jobEntry && jobEntry.heartbeatTimer) {
        _stopHeartbeat(jobEntry.heartbeatTimer);
      }
    } catch (e) {
      // ignore
    }
    _jobs.delete(jobId);
    
    try {
      if (frameBitmap && typeof frameBitmap.close === 'function') frameBitmap.close();
    } catch (e) {}
    
    _cleanupAfterReconstruction();
  }
}

// ---------------------------------------------------------------------------
// Legacy Flux Computation (Preserved for BC Calibration Events)
// ---------------------------------------------------------------------------

async function _computeFluxFromCalibration(metaKey, options = {}) {
  const t0 = performance.now();
  if (!metaKey) throw new Error(`metaKey required for computeFlux`);

  const storageWrapper = await _loadStorageAPI();
  const manifest = await storageWrapper.getArtifact(metaKey);
  if (!manifest || !manifest.data) {
    throw new Error(`Calibration manifest missing or invalid for key ${metaKey}`);
  }
  
  const meta = manifest.data || {};
  const calibratedFrameKey = meta.calibratedFrameKey || meta.calibratedKey || null;
  let calibratedBlob = null;
  
  if (calibratedFrameKey) {
    const calArt = await storageWrapper.getArtifact(calibratedFrameKey);
    calibratedBlob = calArt && calArt.blob ? calArt.blob : null;
  }
  
  if (!calibratedBlob) {
    throw new Error('No calibrated frame artifact found in manifest');
  }
  
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(calibratedBlob);
  } catch (e) {
    throw new Error('createImageBitmap failed for calibrated blob: ' + String(e));
  }
  
  const samplerConfig = {
    seed: options.seed || _flags.fluxSeed || Date.now(),
    timeBudgetMs: options.timeBudgetMs || _flags.fluxTimeBudgetMs || 200,
    maxSamplePoints: options.maxSamplePoints || _flags.fluxMaxSamplePoints || 2048,
    minSamplePoints: options.minSamplePoints || 128,
    enableDebugOutput: !!_flags.fluxDiagnosticsEnabled,
    varianceStride: options.varianceStride || _flags.fluxVarianceStride || 1,
    enableAdaptiveBlending: true
  };
  
  const sampler = MultiSampler.createHighPerformance(samplerConfig);
  let sampleResult = null;
  
  try {
    sampleResult = await sampler.sample(bitmap, { temporalMode: 'single' });
  } catch (err) {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    throw new Error('MultiSampler.sample failed: ' + String(err));
  }
  
  const fluxMeta = {
    type: 'flux-manifest',
    derivedFrom: metaKey,
    samplerConfig,
    sampleManifestSummary: {
      totalPoints: sampleResult.samplePoints?.length || 0,
      processingTime: sampleResult.metadata?.processingTime || null
    },
    timestamp: Date.now()
  };
  
  let fluxResult = null;
  try {
    fluxResult = await _persistAndPin(
      storageWrapper,
      {
        type:      fluxMeta.type,          // 'flux-manifest'
        data: {
          manifest: sampleResult,
          config:   samplerConfig,
          summary:  fluxMeta.sampleManifestSummary
        },
        meta:      fluxMeta,
        createdAt: new Date().toISOString()
      },
      {
        owner:   'motion.worker',
        ttlMs:   ARTIFACT_PIN_TTL_MS,
        pinType: 'soft'
      }
    );
    
    const fluxKey = fluxResult.metaKey;

    try {
      const thumbCanvas = new OffscreenCanvas(Math.min(256, bitmap.width), Math.min(256, bitmap.height));
      const ctx = thumbCanvas.getContext('2d');
      const scale = Math.min(thumbCanvas.width / bitmap.width, thumbCanvas.height / bitmap.height);
      const dw = Math.floor(bitmap.width * scale);
      const dh = Math.floor(bitmap.height * scale);
      ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, dw, dh);
      const thumbBlob = await thumbCanvas.convertToBlob({ type: 'image/webp', quality: 0.6 });

      const thumbResult = await _persistArtifact(storageWrapper, null, thumbBlob, {
        type: 'flux-thumbnail',
        parent: fluxKey,
        dimensions: { width: dw, height: dh }
      });

      fluxMeta.thumbKey = thumbResult.metaKey;
    } catch (thumbErr) {
      console.warn('motion.worker: thumbnail creation failed', thumbErr);
    }
  } catch (persistErr) {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    throw new Error('Failed to persist flux artifact: ' + String(persistErr));
  }
  
  if (bitmap && typeof bitmap.close === 'function') bitmap.close();
  
  const t1 = performance.now();
  const elapsed = t1 - t0;
  
  _metrics.jobsHandled++;
  _metrics.totalProcessingMs += elapsed;
  _metrics.avgProcessingMs = _metrics.totalProcessingMs / _metrics.jobsHandled;
  _metrics.fluxComputeCount++;
  
  _bcPost({
    event: 'flux:ready',
    msgId: generateMsgId(),
    fluxKey: fluxResult.metaKey,
    derivedFrom: metaKey,
    telemetry: {
      processingMs: elapsed,
      points: sampleResult.samplePoints ? sampleResult.samplePoints.length : 0
    }
  });
  
  if (meta && meta.releaseToken) {
    _bcPost({
      event: 'calibration:release_request',
      msgId: generateMsgId(),
      releaseToken: meta.releaseToken,
      reason: 'flux-complete'
    });
  }
  
  return {
    fluxKey: fluxResult.metaKey,
    meta: fluxMeta,
    telemetry: { processingMs: elapsed },
    sampleSummary: { points: sampleResult.samplePoints?.length || 0 }
  };
}

// ============================================================================
// SHUTDOWN: Cleanup calibrated pipeline modules
// ============================================================================

function _shutdownCalibratedPipeline() {
  if (_calibratedProducer) {
    try { _calibratedProducer.dispose(); } catch (e) {}
    _calibratedProducer = null;
  }

  if (_tetrachromacy) {
    try { _tetrachromacy.dispose(); } catch (e) {}
    _tetrachromacy = null;
  }

if (_directionalLifting) {
    try { _directionalLifting.dispose(); } catch (e) {}
    _directionalLifting = null;
  }

  // --- Stage 1 ---
  if (_penumbraAnalyzer) {
    try { _penumbraAnalyzer.dispose(); } catch (e) {}
    _penumbraAnalyzer = null;
  }
  // --- Stage 2 ---
  if (_packingSDF) {
    try { _packingSDF.dispose?.(); } catch (e) {}
    _packingSDF = null;
  }
  // --- End Stage 2 ---
  // --- Stage 3/4 ---
  if (_diffGeo) {
    try { _diffGeo.dispose?.(); } catch (e) {}
    _diffGeo = null;
  }

  _gpuCapabilities = null;

  console.log('motion.worker: Calibrated pipeline modules disposed');
}

// ---------------------------------------------------------------------------
// BroadcastChannel Handling
// ---------------------------------------------------------------------------

if (bc) {
  bc.onmessage = (ev) => {
    const data = ev.data || {};
    if (data.event === 'flagsChanged') {
      _applyFlagsSnapshot(data);
      return;
    }
    if (data.event === 'calibration:ready' || data.type === 'calibration:ready') {
      const metaKey = data.metaKey || data.key || null;
      if (metaKey) {
        _computeFluxFromCalibration(metaKey).catch(err => {
          console.error('motion.worker: background computeFlux error', err);
          _metrics.lastError = String(err);
        });
      }
      return;
    }

    if (data.event === 'calibration:release_request') {
      return;
    }
  };
}

function _bcPost(obj = {}) {
  try {
    if (bc) bc.postMessage(obj);
  } catch (e) {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Message Handling (postMessage Interface)
// ---------------------------------------------------------------------------

self.onmessage = async (ev) => {
  const data = ev.data || {};
  const op = data.op || data.type || null;
  
  try {
    if (op === 'init') {
      if (data.flags) _applyFlagsSnapshot({ flags: data.flags });
      self.postMessage({ op: 'inited', ok: true });
      return;
    }
    
    if (op === 'RECONSTRUCT_META') {
      const inFlightKey = data.metaKey;
      if (_inFlightMetaKeys.has(inFlightKey)) {
        // A reconstruction for this manifest is already running in this worker.
        // Reject the duplicate — two concurrent async jobs interleave at every
        // await and race on the reconStatus record, causing the first job's
        // markReconFailed (from an error in the second) to corrupt the first's
        // state before its first heartbeat fires.
        self.postMessage({
          event:  'RECON_IN_PROGRESS',
          msgId:  generateMsgId(),
          jobId:  data.jobId || data.reqId || 'dup',
          metaKey: inFlightKey,
          reason: 'duplicate_in_flight'
        });
        return;
      }
      _inFlightMetaKeys.add(inFlightKey);
      _handleReconstructMeta(data).finally(() => {
        _inFlightMetaKeys.delete(inFlightKey);
      });
      return;
    }
    
    if (op === 'computeFlux') {
      const { jobId, calibratedFrameKey, metaKey, options = {} } = data;
      try {
        const res = await _computeFluxFromCalibration(metaKey || calibratedFrameKey, options);
        self.postMessage({ op: 'computeFlux:done', jobId: jobId || null, result: res });
      } catch (err) {
        self.postMessage({ op: 'computeFlux:error', jobId: jobId || null, error: String(err) });
      }
      return;
    }

    if (op === 'getMetrics') {
      self.postMessage({ op: 'metrics', metrics: _metrics });
      return;
    }

    if (op === 'shutdown' || op === 'terminate') {
    _running = false;
    _cleanupAfterReconstruction();
    _shutdownCalibratedPipeline();
    
    // ============================================================================
    // ✅ NEW: Clear all TTL timers before shutdown
    // ============================================================================
    // CRITICAL: Worker shutdown doesn't automatically clear setTimeout timers
    // If worker stays alive (rare but possible), timers would leak
    console.log(`[PIN] 🧹 Clearing ${_pinnedArtifacts.size} TTL timers on shutdown...`);
    
    for (const [metaKey, entry] of _pinnedArtifacts.entries()) {
      if (entry.timer) {
        try {
          clearTimeout(entry.timer);
        } catch (e) {
          console.warn(`[PIN] Failed to clear timer for ${metaKey.slice(0, 20)}...`, e);
        }
      }
    }
    _pinnedArtifacts.clear();
    
    if (_threeRenderer) {
      try {
        _threeRenderer.dispose();
      } catch (e) {}
      _threeRenderer = null;
    }
    
    try { if (bc) bc.close(); } catch (e) {}
    self.postMessage({ op: 'shutdown:ack' });
    self.close();
    return;
  }

    self.postMessage({ op: 'unknown', received: data });
  } catch (err) {
    console.error('motion.worker: onmessage handler error', err);
    self.postMessage({ op: 'internalError', error: String(err) });
  }
};

console.log('motion.worker: initialized and ready');