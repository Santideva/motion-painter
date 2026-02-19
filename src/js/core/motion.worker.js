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
let _jobs = new Map();              // jobId -> { heartbeatTimer, createdAt, meta }
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

// Configuration: integers and thresholds can be overridden via _flags
const DEFAULTS = {
  heartbeatIntervalMs: 20_000,     // worker heartbeat to storage
  takeoverMsDefault: 10 * 60_000, // 10 minutes takeover window
  maxWorkerMemoryBytes: 1 << 28,   // ~268MB default safety cap (tunable via flags)
  defaultResolutions: { low: 256, normal: 512, high: 1024 }
};

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

  const threeErrs = [];
  const tryImport = async (spec) => {
    try {
      const mod = await import(spec);
      return mod;
    } catch (e) {
      threeErrs.push(`${spec}: ${e && e.message ? e.message : String(e)}`);
      return null;
    }
  };

  // Try multiple import strategies (bare specifier, absolute path, CDN)
  let THREE = await tryImport('three');
  if (!THREE) THREE = await tryImport('/node_modules/three/build/three.module.js');
  if (!THREE) THREE = await tryImport('https://cdn.jsdelivr.net/npm/three@0.158.0/build/three.module.js');

  if (!THREE) {
    throw new Error(`Failed to import THREE.js (tried multiple locations): ${threeErrs.join(' | ')}`);
  }

  // Handle namespace/default export variations
  if (THREE && THREE.default) THREE = THREE.default;

  // Cache for future calls
  _threeModule = THREE;

  console.log('motion.worker: THREE.js module loaded and cached');
  return _threeModule;
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
    
    _gpuCapabilities = {
      available: true,
      isWebGL2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxTextureUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
      floatTexturesSupported: !!gl.getExtension('OES_texture_float')
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

async function _getDirectionalLifting(resolution) {
  if (!_directionalLifting) {
    const bufferSize = _getDirectionalLiftingBufferSize(resolution);
    
    _directionalLifting = new DirectionalLifting({
      bufferSize,
      weightingMode: 'exponential',
      decayFactor: 0.8,
      enableDerivatives: true,
      debug: _flags.dirLiftDebug || false
    });
    
    console.log(`motion.worker: DirectionalLifting initialized with bufferSize=${bufferSize}, resolution=${resolution}`);
  }
  return _directionalLifting;
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
          console.error(`Heartbeat failed ${maxConsecutiveFails} times - aborting job ${metaKey}`);
          
          try {
            await storageWrapper.markReconFailed(reqId, 'heartbeat_timeout');
          } catch (err) {
            console.error('Failed to mark job as failed:', err);
          }
          
          clearInterval(timer);
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

// ---------------------------------------------------------------------------
// Main Depth/Normal/Flux Computation Pipeline (UPDATED WITH CALIBRATED PIPELINE)
// ---------------------------------------------------------------------------

async function _computeDepthNormalsFlux(frameBitmap, calibData, options = {}) {
  const startTime = performance.now();
  const telemetry = {
    stages: {},
    errors: [],
    warnings: [],  // ✅ KEPT: warnings array
    success: false,
    // Module-specific telemetry containers
    modules: {
      calibratedProducer: null,
      tetrachromacy: null,
      directionalLifting: null,
      trianglePreprocessor: null,
      overhangPreprocessor: null
    }
  };

  let depthMap = null;
  let normalMap = null;
  let fluxData = null;
  let selectorArtifact = null;

  try {
    const resolution = options.resolution || DEFAULTS.defaultResolutions.normal;
    const gridSize = resolution;

    // ✅ HARDENED: Validate resolution bounds
    if (!Number.isInteger(gridSize) || gridSize < 4 || gridSize > 4096) {
      throw new Error(`Invalid resolution: ${gridSize} (must be integer between 4 and 4096)`);
    }

    // Memory safety check
    const estimateMemoryBytes = (res) => {
      const pixels = res * res;
      const bytesPerPixel = 4 * 4; // RGBA Float32 = 4 channels * 4 bytes
      const extraBuffers = 4;      // calibrated, tetra, directional, scratch
      return pixels * bytesPerPixel * extraBuffers;
    };

    const estimatedBytes = estimateMemoryBytes(gridSize);
    const maxBytes = Number(_flags.maxWorkerMemoryBytes) || DEFAULTS.maxWorkerMemoryBytes;
    
    if (estimatedBytes > maxBytes) {
      telemetry.errors.push(`memoryEstimate ${estimatedBytes} > max ${maxBytes}, reducing resolution`);
      if (gridSize > DEFAULTS.defaultResolutions.low) {
        const reduced = Math.max(DEFAULTS.defaultResolutions.low, Math.floor(gridSize / 2));
        options.resolution = reduced;
        return _computeDepthNormalsFlux(frameBitmap, calibData, options);
      } else {
        return await _fallbackDepthEstimation(frameBitmap, resolution);
      }
    }

    // ========================================
    // STAGE 1: Load Calibrated Field
    // ========================================
    telemetry.stages.calibrated_start = performance.now();

    let calibratedField = null;
    let calibResult = null;

    // ✅ DIAGNOSTIC: Log what calibData we received from Stage 4
    console.log('[DEPTH-STAGE1] Calibration data check:', {
      calibDataExists: !!calibData,
      calibDataType: typeof calibData,
      calibDataNull: calibData === null,
      calibDataUndefined: calibData === undefined,
      calibDataKeys: calibData ? Object.keys(calibData) : [],
      calibratedFrameKeyExists: !!(calibData && calibData.calibratedFrameKey),
      calibratedFrameKeyValue: calibData?.calibratedFrameKey,
      calibratedFrameKeyType: typeof calibData?.calibratedFrameKey,
      calibratedFrameKeyLength: typeof calibData?.calibratedFrameKey === 'string' ? calibData.calibratedFrameKey.length : 'N/A',
      hasMetaKey: !!(calibData && calibData.meta),
      metaKeys: calibData?.meta ? Object.keys(calibData.meta) : [],
      hasDarkKey: !!(calibData && calibData.darkKey),
      hasFlatKey: !!(calibData && calibData.flatKey),
      hasBiasKey: !!(calibData && calibData.biasKey)
    });

    // GUARD CHECK: Ensure calibration metadata is present
    if (!calibData || !calibData.calibratedFrameKey) {
      // ✅ DIAGNOSTIC: Log exactly why we're failing
      const failureReason = !calibData 
        ? 'calibData is null/undefined' 
        : 'calibData exists but calibratedFrameKey is missing/undefined';
      
      console.error('[DEPTH-STAGE1] ❌ GUARD CHECK FAILED:', {
        reason: failureReason,
        calibDataNull: calibData === null,
        calibDataUndefined: calibData === undefined,
        calibDataTruthy: !!calibData,
        calibratedFrameKey: calibData?.calibratedFrameKey,
        calibratedFrameKeyType: typeof calibData?.calibratedFrameKey,
        calibDataKeys: calibData ? Object.keys(calibData) : [],
        calibDataStringified: calibData ? JSON.stringify(calibData).slice(0, 500) : 'null',
        metaKey: metaKey,
        cameraId: cameraId,
        resolution: gridSize
      });

      throw new Error(
        `Calibration metadata required but missing (no calibratedFrameKey). ` +
        `Reason: ${failureReason}. ` +
        `calibData=${calibData ? 'exists' : 'null'}, ` +
        `calibratedFrameKey=${calibData?.calibratedFrameKey || 'undefined'}. ` +
        `Reconstruction cannot proceed.`
      );
    }

    // ✅ DIAGNOSTIC: Log guard check success
    console.log('[DEPTH-STAGE1] ✅ Guard check passed, proceeding with calibrated field loading:', {
      calibratedFrameKey: calibData.calibratedFrameKey,
      calibratedFrameKeyLength: calibData.calibratedFrameKey.length,
      resolution: gridSize,
      hasStorageWrapper: !!options.storageWrapper
    });

    try {
      const producer = _getCalibratedProducer();
      
      // ✅ DIAGNOSTIC: Log before calling producer
      console.log('[DEPTH-STAGE1] Calling CalibratedFieldProducer.produce:', {
        calibratedFrameKey: calibData.calibratedFrameKey,
        frameBitmapExists: !!frameBitmap,
        frameBitmapWidth: frameBitmap?.width,
        frameBitmapHeight: frameBitmap?.height,
        targetResolution: gridSize,
        hasStorageWrapper: !!options.storageWrapper,
        storageWrapperType: options.storageWrapper?.constructor?.name || 'unknown',
        calibDataKeys: Object.keys(calibData)
      });

      const produceStartTime = performance.now();
      
      calibResult = await producer.produce(
        frameBitmap,
        calibData,
        { 
          resolution: gridSize, 
          storageWrapper: options.storageWrapper
        }
      );

      const produceEndTime = performance.now();
      const produceMs = produceEndTime - produceStartTime;

      calibratedField = calibResult.calibratedField;

      // ✅ DIAGNOSTIC: Log producer result
      console.log('[DEPTH-STAGE1] CalibratedFieldProducer.produce succeeded:', {
        produceMs: produceMs.toFixed(2),
        resultResolution: calibResult.resolution,
        fieldExists: !!calibratedField,
        fieldType: calibratedField?.constructor?.name || 'unknown',
        fieldLength: calibratedField?.length,
        expectedLength: gridSize * gridSize * 4,
        lengthMatch: calibratedField?.length === gridSize * gridSize * 4,
        source: calibResult.telemetry?.source,
        channels: calibResult.channels,
        encoding: calibResult.encoding,
        spectralModel: calibResult.spectralModel,
        telemetrySuccess: calibResult.telemetry?.success,
        telemetryWarnings: calibResult.telemetry?.warnings?.length || 0,
        telemetryErrors: calibResult.telemetry?.errors?.length || 0
      });

      // ✅ DIAGNOSTIC: Log field statistics (sample first few values)
      if (calibratedField && calibratedField.length > 0) {
        const sampleSize = Math.min(12, calibratedField.length);
        const sample = Array.from(calibratedField.slice(0, sampleSize));
        console.log('[DEPTH-STAGE1] Calibrated field sample (first 12 values):', {
          values: sample.map(v => v.toFixed(4)),
          min: Math.min(...sample),
          max: Math.max(...sample),
          avg: sample.reduce((a, b) => a + b, 0) / sample.length
        });
      }

      // ✅ HARDENED: Validate resolution consistency
      console.log('[DEPTH-STAGE1] Validating resolution consistency...');
      validateResolution(gridSize, calibResult.resolution, 'CalibratedFieldProducer');
      console.log('[DEPTH-STAGE1] ✓ Resolution validation passed');
      
      // ✅ HARDENED: Validate field dimensions
      console.log('[DEPTH-STAGE1] Validating field buffer dimensions...');
      validateBuffer(calibratedField, gridSize * gridSize * 4, 'calibratedField');
      console.log('[DEPTH-STAGE1] ✓ Buffer validation passed');

      telemetry.stages.calibrated_end = performance.now();
      
      // ✅ CONDITIONAL: Only persist if debug flag enabled
      if (_flags.persistIntermediates || _flags.calibDebug) {
        console.log('[DEPTH-STAGE1] Debug mode: persisting calibrated field as intermediate artifact...');
        try {
          await _persistAndPin(
            options.storageWrapper,
            {
              type: 'calibrated_field',
              data: { field: calibratedField },
              meta: {
                sourceMetaKey: metaKey,
                cameraId: cameraId,
                resolution: gridSize,
                calibrationKey: calibData?.calibratedFrameKey || null,
                computedAt: Date.now()
              },
              createdAt: new Date().toISOString()
            }, 
            {
              owner: 'motion.worker',
              ttlMs: CALIBRATION_FIELD_TTL_MS,  // 3 minutes
              pinType: 'hard'
            }
          );
          
          console.log('[PERSIST] ✓ Calibrated field persisted (debug mode)');
        } catch (err) {
          console.warn('[PERSIST] ✗ Calibrated field persistence failed (non-fatal):', err);
        }
      } else {
        console.log('[DEPTH-STAGE1] Skipping calibrated field persistence (debug mode disabled)');
      }
      
      telemetry.stages.calibrated_ms = telemetry.stages.calibrated_end - telemetry.stages.calibrated_start;
      
      // ✅ NEW: Attach module telemetry
      telemetry.modules.calibratedProducer = calibResult.telemetry || null;

      // ✅ DIAGNOSTIC: Log Stage 1 completion
      console.log('[DEPTH-STAGE1] ✅ Stage 1 completed successfully:', {
        totalMs: telemetry.stages.calibrated_ms.toFixed(2),
        fieldReady: !!calibratedField,
        fieldLength: calibratedField?.length,
        resolution: gridSize,
        telemetryAttached: !!telemetry.modules.calibratedProducer
      });

    } catch (calibErr) {
      // ✅ DIAGNOSTIC: Enhanced error logging
      console.error('[DEPTH-STAGE1] ❌ Calibrated field loading/production failed:', {
        errorMessage: calibErr.message,
        errorType: calibErr.constructor.name,
        errorStack: calibErr.stack,
        calibratedFrameKey: calibData?.calibratedFrameKey,
        hasStorageWrapper: !!options.storageWrapper,
        resolution: gridSize,
        metaKey: metaKey,
        cameraId: cameraId
      });
      
      const errMsg = `Calibration loading failed: ${calibErr.message}`;
      telemetry.errors.push(errMsg);
      throw new Error(errMsg);
    }

    // STEP 2: Tetrachromacy (Spectral Decomposition)
    telemetry.stages.tetrachromacy_start = performance.now();

    let tetraField = calibratedField;
    let tetraResult = null;
    let chromaticity = null;

    if (_flags.enableTetrachromacy !== false) {
      try {
        const tetra = _getTetrachromacy();
        tetraResult = await tetra.process(calibratedField, gridSize, {});

        tetraField = tetraResult.tetraField;
        chromaticity = tetraResult.chromaticity;

        validateResolution(gridSize, tetraResult.resolution, 'Tetrachromacy');
        validateBuffer(tetraField, gridSize * gridSize * 4, 'tetraField');

        // ============================================================================
        // ✅ NEW: Persist tetrachromacy output (conditional on flag)
        // ============================================================================
        if (_flags.persistIntermediates) {
          try {
            await _persistAndPin(
              options.storageWrapper,
              {
              type: 'tetra_field',
              data: {
                field: tetraField,
                opponentChannels: tetraResult.opponentChannels || null,
                chromaticity: tetraResult.chromaticity || null
              },
              meta: {
                sourceMetaKey: metaKey,
                cameraId: cameraId,
                resolution: gridSize,
                hasOpponentChannels: !!tetraResult.opponentChannels,
                computedAt: Date.now()
              },
              createdAt: new Date().toISOString()
            }, {
              owner: 'motion.worker',
              ttlMs: INTERMEDIATE_TTL_MS, // 2 minutes (debug artifact)
              pinType: 'soft'
            });
            
            console.log('[PERSIST] ✓ Tetrachromacy field persisted (intermediate artifact)');
          } catch (tetraPersistErr) {
            console.warn('[PERSIST] ✗ Tetrachromacy persistence failed (non-fatal):', tetraPersistErr);
          }
        }

        telemetry.stages.tetrachromacy_end = performance.now();
        telemetry.stages.tetrachromacy_ms = telemetry.stages.tetrachromacy_end - telemetry.stages.tetrachromacy_start;
        telemetry.modules.tetrachromacy = tetraResult.telemetry || null;

      } catch (tetraErr) {
        telemetry.warnings.push(`Tetrachromacy failed: ${tetraErr.message}, using calibrated field`);
        console.warn('motion.worker: Tetrachromacy failed', tetraErr);
        tetraField = calibratedField;
      }
    }

    // Compute intensity for bump/specular (from tetraResult or compute from tetraField)
    let intensity = null;
    if (tetraResult && tetraResult.opponentChannels && tetraResult.opponentChannels.L) {
      intensity = tetraResult.opponentChannels.L;
    } else {
      const count = gridSize * gridSize;
      intensity = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        const r = tetraField[i * 4 + 0];
        const g = tetraField[i * 4 + 1];
        const b = tetraField[i * 4 + 2];
        intensity[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      }
    }

    // STEP 3: DirectionalLifting (Temporal Aggregation)
    telemetry.stages.directional_start = performance.now();

    let directionalField = tetraField;
    let liftResult = null;

    if (_flags.enableDirectionalLifting !== false) {
      try {
        const dirLift = await _getDirectionalLifting(gridSize);
        
        liftResult = await dirLift.process(
          tetraField,
          gridSize,
          Date.now(),
          { metadata: options }
        );

        directionalField = liftResult.directionalField;

        validateResolution(gridSize, liftResult.resolution, 'DirectionalLifting');
        validateBuffer(directionalField, gridSize * gridSize * 4, 'directionalField');

        // ============================================================================
        // ✅ NEW: Persist directional lifting output (conditional on flag)
        // ============================================================================
        if (_flags.persistIntermediates) {
          try {
            await _persistAndPin(
              options.storageWrapper,
              {
              type: 'directional_field',
              data: {
                field: directionalField,
                coherence: liftResult.coherence || null
              },
              meta: {
                sourceMetaKey: metaKey,
                cameraId: cameraId,
                resolution: gridSize,
                coherenceMean: liftResult.coherence?.mean || null,
                computedAt: Date.now()
              },
              createdAt: new Date().toISOString()
            }, {
              owner: 'motion.worker',
              ttlMs: INTERMEDIATE_TTL_MS, // 2 minutes
              pinType: 'soft'
            });
            
            console.log('[PERSIST] ✓ Directional field persisted (intermediate artifact)');
          } catch (dirPersistErr) {
            console.warn('[PERSIST] ✗ DirectionalLifting persistence failed (non-fatal):', dirPersistErr);
          }
        }

        telemetry.stages.directional_end = performance.now();
        telemetry.stages.directional_ms = telemetry.stages.directional_end - telemetry.stages.directional_start;
        telemetry.coherenceMean = liftResult.coherence?.mean;
        telemetry.modules.directionalLifting = liftResult.telemetry || null;

      } catch (liftErr) {
        telemetry.warnings.push(`DirectionalLifting failed: ${liftErr.message}, using tetra field`);
        console.warn('motion.worker: DirectionalLifting failed', liftErr);
        directionalField = tetraField;
      }
    }

    // STEP 4: Compute Bump Map
    telemetry.stages.bump_start = performance.now();

    let bumpField = null;

    if (intensity) {
      try {
        bumpField = _computeBumpFromIntensity(intensity, gridSize, {
          bumpScale: _flags.bumpScale || 1.0,
          fusionMode: _flags.bumpFusionMode || false
        });

        validateBuffer(bumpField, gridSize * gridSize * 4, 'bumpField');

        // ============================================================================
        // ✅ NEW: Persist bump map (conditional on flag)
        // ============================================================================
        if (_flags.persistIntermediates && bumpField) {
          try {
            await _persistAndPin(
              options.storageWrapper,
              {
              type: 'bump_map',
              data: { field: bumpField },
              meta: {
                sourceMetaKey: metaKey,
                cameraId: cameraId,
                resolution: gridSize,
                bumpScale: _flags.bumpScale || 1.0,
                fusionMode: _flags.bumpFusionMode || false,
                computedAt: Date.now()
              },
              createdAt: new Date().toISOString()
            }, {
              owner: 'motion.worker',
              ttlMs: INTERMEDIATE_TTL_MS, // 2 minutes
              pinType: 'soft'
            });
            
            console.log('[PERSIST] ✓ Bump map persisted (intermediate artifact)');
          } catch (bumpPersistErr) {
            console.warn('[PERSIST] ✗ Bump map persistence failed (non-fatal):', bumpPersistErr);
          }
        }

        telemetry.stages.bump_end = performance.now();
        telemetry.stages.bump_ms = telemetry.stages.bump_end - telemetry.stages.bump_start;

      } catch (bumpErr) {
        telemetry.warnings.push(`Bump computation failed: ${bumpErr.message}`);
        console.warn('motion.worker: Bump computation failed', bumpErr);
      }
    }

    // ========================================
    // STAGE 5: Compute Normal Map
    // ========================================
    telemetry.stages.normal_start = performance.now();

    let normalField = null;

    if (bumpField) {
      try {
        normalField = _computeNormalFromBump(bumpField, gridSize, _flags.normalScale || 1.0);
        // ✅ HARDENED: Validate output
        validateBuffer(normalField, gridSize * gridSize * 4, 'normalField');
        telemetry.stages.normal_end = performance.now();
        telemetry.stages.normal_ms = telemetry.stages.normal_end - telemetry.stages.normal_start;

      } catch (normalErr) {
        telemetry.warnings.push(`Normal computation failed: ${normalErr.message}`);
        console.warn('motion.worker: Normal computation failed', normalErr);
      }
    }

    // STEP 6: Compute Specular Mask
    telemetry.stages.specular_start = performance.now();

    let specularMask = null;

    if (intensity && chromaticity) {
      try {
        specularMask = _computeSpecularMask(intensity, chromaticity, gridSize, {
          hpGain: _flags.specularHpGain || 4.0,
          alpha: _flags.specularAlpha || 0.5,
          chromaScale: _flags.specularChromaScale || 3.0,
          threshold: _flags.specularThreshold || 0.15
        });
        
        validateBuffer(specularMask, gridSize * gridSize * 4, 'specularMask');

        // ============================================================================
        // ✅ NEW: Persist specular mask (conditional on flag)
        // ============================================================================
        if (_flags.persistIntermediates && specularMask) {
          try {
            await _persistAndPin(
              options.storageWrapper,
              {
              type: 'specular_mask',
              data: { field: specularMask },
              meta: {
                sourceMetaKey: metaKey,
                cameraId: cameraId,
                resolution: gridSize,
                hpGain: _flags.specularHpGain || 4.0,
                alpha: _flags.specularAlpha || 0.5,
                chromaScale: _flags.specularChromaScale || 3.0,
                threshold: _flags.specularThreshold || 0.15,
                computedAt: Date.now()
              },
              createdAt: new Date().toISOString()
            }, {
              owner: 'motion.worker',
              ttlMs: INTERMEDIATE_TTL_MS, // 2 minutes
              pinType: 'soft'
            });
            
            console.log('[PERSIST] ✓ Specular mask persisted (intermediate artifact)');
          } catch (specPersistErr) {
            console.warn('[PERSIST] ✗ Specular mask persistence failed (non-fatal):', specPersistErr);
          }
        }

        telemetry.stages.specular_end = performance.now();
        telemetry.stages.specular_ms = telemetry.stages.specular_end - telemetry.stages.specular_start;

      } catch (specErr) {
        telemetry.warnings.push(`Specular computation failed: ${specErr.message}`);
        console.warn('motion.worker: Specular computation failed', specErr);
      }
    }

    // ========================================
    // STAGE 7: Ensure THREE.js Renderer Ready
    // ========================================
    telemetry.stages.init_start = performance.now();

    let renderer = null;
    try {
      renderer = await _initThreeRenderer();
    } catch (initErr) {
      console.warn('motion.worker: THREE.js init failed, using CPU fallback', initErr);
      telemetry.errors.push(`three_init: ${initErr.message || String(initErr)}`);
      return await _fallbackDepthEstimation(frameBitmap, resolution);
    }

    telemetry.stages.init_end = performance.now();
    telemetry.stages.init_ms = telemetry.stages.init_end - telemetry.stages.init_start;

    // ========================================
    // STAGE 8: Load THREE.js and Create Textures
    // ========================================
    telemetry.stages.texture_load_start = performance.now();

    const THREE = await _loadThreeModule();

    // Ensure GPU capability info is available
    const gpuCaps = await _detectGPUCapabilities();

    const createTexture = (field, name) => {
      if (!field) return null;

      // Decide whether float textures are supported
      const useFloat = gpuCaps && gpuCaps.floatTexturesSupported;

      let data = field;
      let type = useFloat ? THREE.FloatType : THREE.UnsignedByteType;
      let arrayBuffer = field;

      if (!useFloat) {
        // Convert Float32 normalized [0,1] -> Uint8Clamped (0..255)
        const uint8 = new Uint8ClampedArray(field.length);
        for (let i = 0; i < field.length; i++) {
          // clamp and scale
          let v = Number(field[i]);
          if (!isFinite(v)) v = 0;
          let s = Math.max(0, Math.min(1, v)) * 255;
          uint8[i] = Math.round(s);
        }
        arrayBuffer = uint8;
        type = THREE.UnsignedByteType;
        console.warn(`motion.worker: GPU float textures not supported — using 8-bit fallback for texture "${name}"`);
      }

      const tex = new THREE.DataTexture(
        arrayBuffer,
        gridSize,
        gridSize,
        THREE.RGBAFormat,
        type
      );
      tex.needsUpdate = true;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;

      _trackResource(tex, 'textures');
      return tex;
    };

    const diffuseTexture = createTexture(directionalField, 'diffuse');
    const bumpTexture = bumpField ? createTexture(bumpField, 'bump') : diffuseTexture;
    const normalTexture = normalField ? createTexture(normalField, 'normal') : diffuseTexture;
    const albedoTexture = createTexture(directionalField, 'albedo');

    const textures = {
      diffuse: diffuseTexture,
      bump: bumpTexture,
      normal: normalTexture,
      albedo: albedoTexture,
      bumpScale: _flags.bumpScale || 1.0,
      normalScale: _flags.normalScale || 1.0,
      albedoScale: 1.0
    };

    telemetry.stages.texture_load_end = performance.now();
    telemetry.stages.texture_load_ms = telemetry.stages.texture_load_end - telemetry.stages.texture_load_start;

    // ========================================
    // STAGE 9: Generate UV Grid
    // ========================================
    telemetry.stages.grid_gen_start = performance.now();

    const count = gridSize * gridSize;
    const positions = new Float32Array(count * 2);
    const normals2D = new Float32Array(count * 2);

    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        const i = y * gridSize + x;
        positions[i * 2] = x / (gridSize - 1);
        positions[i * 2 + 1] = y / (gridSize - 1);
        normals2D[i * 2] = 0;
        normals2D[i * 2 + 1] = 1;
      }
    }

    telemetry.stages.grid_gen_end = performance.now();
    telemetry.stages.grid_gen_ms = telemetry.stages.grid_gen_end - telemetry.stages.grid_gen_start;

    // STEP 10: Run Triangle Preprocessor
    telemetry.stages.triangle_start = performance.now();

    let triangleResult = null;
    try {
      const { createDepthTrianglePreprocessor } = await import('/src/js/core/depthTrianglePreprocessor.js');

      _trianglePreprocessor = createDepthTrianglePreprocessor({
        THREE: THREE,
        renderer: renderer,
        bakeSize: Math.max(256, Math.min(1024, Math.floor(gridSize * 4))),
        gridSize: gridSize,
        positions: positions,
        normals: normals2D,
        textures: textures,
        kL: safeNumeric(_flags.depthKL, 1.0, 0, 10),
        kD: safeNumeric(_flags.depthKD, 0.5, 0, 10),
        baseDepth: safeNumeric(_flags.depthBase, 0.1, 0, 10),
        depthScale: safeNumeric(_flags.depthScale, 2.0, 0, 100)
      });

      const initErr = _trianglePreprocessor.init();
      if (initErr) {
        throw new Error(`Triangle preprocessor init failed: ${initErr}`);
      }

      triangleResult = _trianglePreprocessor.compute();

      if (!triangleResult || !triangleResult.depths) {
        throw new Error('Triangle preprocessor returned invalid result');
      }

      validateBuffer(triangleResult.depths, count, 'triangleResult.depths');
      validateBuffer(triangleResult.tilts, count, 'triangleResult.tilts');
      validateBuffer(triangleResult.windingNumbers, count, 'triangleResult.windingNumbers');

      // ============================================================================
      // ✅ NEW: Persist triangle preprocessor output (conditional on flag)
      // ============================================================================
      if (_flags.persistIntermediates) {
        try {
          await _persistAndPin(
            options.storageWrapper,
            {
            type: 'triangle_output',
            data: {
              depths: triangleResult.depths,
              tilts: triangleResult.tilts,
              windingNumbers: triangleResult.windingNumbers
            },
            meta: {
              sourceMetaKey: metaKey,
              cameraId: cameraId,
              resolution: gridSize,
              bakeSize: triangleResult.stats?.bakeSize || null,
              sampleCount: triangleResult.depths.length,
              stats: triangleResult.stats || {},
              computedAt: Date.now()
            },
            createdAt: new Date().toISOString()
          }, {
            owner: 'motion.worker',
            ttlMs: INTERMEDIATE_TTL_MS, // 2 minutes
            pinType: 'soft'
          });
          
          console.log('[PERSIST] ✓ Triangle preprocessor output persisted (intermediate artifact)');
        } catch (triPersistErr) {
          console.warn('[PERSIST] ✗ Triangle output persistence failed (non-fatal):', triPersistErr);
        }
      }

      telemetry.stages.triangle_end = performance.now();
      telemetry.stages.triangle_ms = telemetry.stages.triangle_end - telemetry.stages.triangle_start;
      telemetry.stages.triangle_samples = triangleResult.depths.length;
      telemetry.modules.trianglePreprocessor = triangleResult.stats || null;

    } catch (triangleErr) {
      const se = safeErrSummary(triangleErr);
      console.error('motion.worker: Triangle preprocessor failed', triangleErr);
      telemetry.errors.push(`triangle: ${se.message}`);
      throw triangleErr;
    }

    // ========================================
    // STAGE 11: Convert Triangle Output to 3D Normals
    // ========================================
    telemetry.stages.normal_convert_start = performance.now();

    const depths = triangleResult.depths;
    const tilts = triangleResult.tilts;
    const windingNumbers = triangleResult.windingNumbers;

    const normals3D = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const theta = tilts[i];
      const nx = Math.cos(theta);
      const ny = Math.sin(theta);
      const nz = 0.5;

      const len = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1.0;
      normals3D[i*3] = nx / len;
      normals3D[i*3 + 1] = ny / len;
      normals3D[i*3 + 2] = nz / len;
    }

    telemetry.stages.normal_convert_end = performance.now();
    telemetry.stages.normal_convert_ms = telemetry.stages.normal_convert_end - telemetry.stages.normal_convert_start;

    // ========================================
    // STAGE 12: Run Overhang Preprocessor
    // ========================================
    telemetry.stages.overhang_start = performance.now();

    let overhangResult = null;
    const enableOverhang = _flags.enableOverhang !== false;

    if (enableOverhang) {
      try {
        if (!_overhangPreprocessor) {
          const { createOverhangPreprocessor } = await import('./overhangPreprocessor.js');
            _overhangPreprocessor = createOverhangPreprocessor({
            gridW: gridSize,
            gridH: gridSize,
            gravity: _flags.gravity || [0, -1, 0],
            cosineThreshold: safeNumeric(_flags.overhangCosineThresh, 0.7, -1, 1),
            windingThreshold: safeNumeric(_flags.overhangWindingThresh, 0.25, 0, 10),
            minGroupSize: Math.max(1, Math.floor(_flags.overhangMinGroupSize || 3))
          });
        }

        overhangResult = _overhangPreprocessor.run({
          depths: depths,
          normals: normals3D,
          windingNumbers: windingNumbers,
          positions: positions
        });
        // ✅ HARDENED: Validate overhang output structure
        if (!overhangResult.A_coo || !overhangResult.A_csr || !overhangResult.b) {
          throw new Error('Overhang preprocessor returned incomplete constraint system');
        }
        
        // ✅ HARDENED: Validate CSR format dimensions
        const expectedRows = overhangResult.A_csr.shape ? overhangResult.A_csr.shape[0] : overhangResult.b.length;
        if (overhangResult.A_csr.indptr.length !== expectedRows + 1) {
          telemetry.warnings.push(
            `Overhang CSR indptr length mismatch: expected ${expectedRows + 1}, got ${overhangResult.A_csr.indptr.length}`
          );
        }

        telemetry.stages.overhang_end = performance.now();
        telemetry.stages.overhang_ms = telemetry.stages.overhang_end - telemetry.stages.overhang_start;
        telemetry.stages.overhang_constraints = overhangResult.diagnostics.constraintCount;
        telemetry.stages.overhang_socs = overhangResult.diagnostics.socCount;

        // ✅ Attach module telemetry
        telemetry.modules.overhangPreprocessor = overhangResult.diagnostics || null;

      } catch (overhangErr) {
        const se = safeErrSummary(overhangErr);
        console.warn('motion.worker: Overhang preprocessor failed', overhangErr);
        telemetry.errors.push(`overhang: ${se.message}`);
        overhangResult = null;
      }
    }

    // ========================================
    // STAGE 13: Build selector (BSS seed)
    // ========================================
    try {
      if (_flags.bssPersistSelector) {
        const selector = new Float32Array(count);
        for (let i = 0; i < count; i++) {
          const w = Math.abs(windingNumbers[i] || 0);
          let score = w;
          score += Math.abs(triangleResult.tilts[i] || 0) * 0.1;
          selector[i] = score;
        }
        
        let maxS = 0;
        for (let i = 0; i < count; i++) if (selector[i] > maxS) maxS = selector[i];
        if (maxS > 0) for (let i = 0; i < count; i++) selector[i] = selector[i] / maxS;

        selectorArtifact = {
          pointsCount: count,
          selector: Array.from(selector),
          gateParams: {
            eta_pull: safeNumeric(_flags.bssPullEta, 0.1, 0, 1),
            eta_push: safeNumeric(_flags.bssPushEta, 0.05, 0, 1),
            gamma: safeNumeric(_flags.bssGamma, 1.02, 1, 2),
            iters: Math.max(1, Math.floor(_flags.bssIters || 8))
          }
        };
      }
    } catch (selErr) {
      const se = safeErrSummary(selErr);
      console.warn('motion.worker: selector build failed', selErr);
      telemetry.errors.push(`selector: ${se.message}`);
      selectorArtifact = null;
    }

    // ========================================
    // STAGE 14: Package Results
    // ========================================

    const depthStats = typedMinMax(depths);

    depthMap = {
      resolution: gridSize,
      data: depths,
      min: depthStats.min,
      max: depthStats.max,
      encoding: 'float32',
      stats: triangleResult.stats || {}
    };

    normalMap = {
      resolution: gridSize,
      data: normals3D,
      encoding: 'xyz-float32'
    };

    fluxData = overhangResult ? {
      A_coo: overhangResult.A_coo,
      A_csr: {
        indptr: Array.from(overhangResult.A_csr.indptr),
        indices: Array.from(overhangResult.A_csr.indices),
        data: Array.from(overhangResult.A_csr.data),
        shape: overhangResult.A_csr.shape
      },
      b: Array.from(overhangResult.b),
      SOCs: overhangResult.SOCs,
      groups: overhangResult.groups,
      supports: overhangResult.supports,
      init_h: Array.from(overhangResult.init_h),
      diagnostics: overhangResult.diagnostics,
      solverReady: true,
      sampleSummary: overhangResult.sampleSummary || null
    } : null;

    telemetry.calibratedPipeline = {
      producer: calibResult?.telemetry,
      tetrachromacy: tetraResult?.telemetry,
      directionalLifting: liftResult?.telemetry,
      hasBump: !!bumpField,
      hasNormal: !!normalField,
      hasSpecular: !!specularMask
    };

    telemetry.success = true;
    telemetry.estimatedMemoryBytes = estimatedBytes;
    telemetry.selector = selectorArtifact ? { pointsCount: selectorArtifact.pointsCount } : null;

  } catch (err) {
    const se = safeErrSummary(err);
    console.error('motion.worker: computeDepthNormalsFlux failed', err);

    telemetry.success = false;
    telemetry.error = String(se.message);
    telemetry.stack = se.stack;
    telemetry.errors = Array.isArray(telemetry.errors) ? telemetry.errors : [];
    telemetry.errors.push(`fatal: ${se.message}`);

    try {
      return await _fallbackDepthEstimation(frameBitmap, options.resolution || DEFAULTS.defaultResolutions.normal);
    } catch (fallbackErr) {
      const fallbackSe = safeErrSummary(fallbackErr);
      console.warn('motion.worker: fallbackDepthEstimation also failed', fallbackSe.message);

      const res = options.resolution || DEFAULTS.defaultResolutions.normal;
      const fallbackDepths = new Float32Array(res * res).fill(1.0);
      const fallbackNormals = new Float32Array(res * res * 3);
      for (let i = 0; i < fallbackNormals.length; i++) fallbackNormals[i] = (i % 3 === 2) ? 1.0 : 0.0;

      depthMap = {
        resolution: res,
        data: fallbackDepths,
        min: 1.0,
        max: 1.0,
        encoding: 'float32',
        fallback: true,
        error: se.message
      };

      normalMap = {
        resolution: res,
        data: fallbackNormals,
        encoding: 'xyz-float32',
        fallback: true
      };

      fluxData = null;
    }
  } finally {
    telemetry.stages.cleanup_start = performance.now();
    _cleanupAfterReconstruction();
    telemetry.stages.cleanup_end = performance.now();
    telemetry.stages.cleanup_ms = telemetry.stages.cleanup_end - telemetry.stages.cleanup_start;
  }

  const endTime = performance.now();
  telemetry.total_ms = endTime - startTime;
  return { depthMap, normalMap, fluxData, telemetry, selectorArtifact: (selectorArtifact || null) };
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
      const markResult = await storageWrapper.markReconRunning(metaKey, jobId, takeoverMs);

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
        resolution: options.resolution || chosenRes,
        quality: options.priority > 50 ? 'high' : 'medium',
        priority: options.priority,
        storageWrapper: storageWrapper
      }
    );

    const { depthMap, normalMap, fluxData, telemetry, selectorArtifact } = computeResult;

    console.log('motion.worker: depth/normal/flux telemetry', telemetry);

    // ========================================
    // STAGE 7: Persist Derived Artifacts
    // ========================================
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

    const normalResult = await _persistAndPin(
      storageWrapper, 
      {
        type: 'normal_map',
        data: { field: normalMap.data },
        meta: {
          sourceMetaKey: metaKey,
          cameraId: cameraId,
          resolution: normalMap.resolution,
          encoding: normalMap.encoding,
          fallback: normalMap.fallback || false,
          computedAt: Date.now()
        },
        createdAt: new Date().toISOString()
      },
      {
        owner: 'motion.worker',
        ttlMs: ARTIFACT_PIN_TTL_MS,
        pinType: 'soft'
      }
    );

    if (!normalResult?.metaKey) {
      throw new Error('Normal persistence failed');
    }

    let fluxResult = null;
    if (fluxData) {
      try {
        fluxResult = await _persistAndPin(
          storageWrapper,
          {
          type: 'flux_field',
          data: fluxData, // Includes A_coo, A_csr, b, SOCs, groups (storage.js handles parts)
          meta: {
            sourceMetaKey: metaKey,
            computedAt: Date.now(),
            solverReady: true
          },
          createdAt: new Date().toISOString()
        }, {
          owner: 'motion.worker',
          ttlMs: ARTIFACT_PIN_TTL_MS, // 5 minutes
          pinType: 'soft'
        });
      } catch (fluxErr) {
        console.warn('motion.worker: Flux persistence failed', fluxErr);
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

    const derivedKeys = [
      depthResult && depthResult.metaKey,
      normalResult && normalResult.metaKey,
      fluxResult && fluxResult.metaKey,
      selectorResult && selectorResult.metaKey
    ].filter(Boolean);

    // --------------------------------------------------------------------
    // NEW: Wait for derived artifacts to become visible to other connections.
    // This avoids a race where worker sees put success but other contexts
    // (main thread / test harness) cannot immediately read the artifact.
    // We keep this short so worker doesn't stall forever.
    // --------------------------------------------------------------------
    try {
      const visibleKeys = [];
      for (const k of derivedKeys) {
        if (!k) continue;
        // Wait up to 5s per artifact (adjust timeoutMs for debugging)
        const ok = await _waitForArtifactVisibility(storageWrapper, k, { timeoutMs: 5000, pollMs: 120 });
        if (!ok) {
          // record a warning but continue — don't fail the job
          console.warn('motion.worker: artifact did not become visible in time', k);
          telemetry.warnings = telemetry.warnings || [];
          telemetry.warnings.push(`artifact_visibility_timeout:${k}`);
        } else {
          visibleKeys.push(k);
        }
      }
      telemetry.derivedVisible = visibleKeys;
    } catch (waitErr) {
      console.warn('motion.worker: waiting for derived artifacts visibility failed', waitErr);
      // fall through — don't let wait failure kill reconstruction
      telemetry.warnings = telemetry.warnings || [];
      telemetry.warnings.push(`derived_visibility_check_failed:${String(waitErr?.message || waitErr)}`);
    }

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
    try {
      const telemetryPayload = {
        jobId,
        metaKey,
        cameraId: cameraId,
        cameraContainer: cameraContainer || undefined,
        priority: options.priority || 50,
        resolution: options.resolution,
        stages: telemetry.stages,
        modules: telemetry.modules, // Include per-module telemetry
        processingMs: processingMs,
        estimatedMemoryBytes: telemetry.estimatedMemoryBytes || null,
        depthStats: depthMap ? { min: depthMap.min, max: depthMap.max } : null,
        depthFallback: !!(depthMap && depthMap.fallback),
        fluxPoints: fluxData ? (fluxData.sampleSummary?.points || null) : null,
        flags: _flags,
        errors: telemetry.errors || [],
        warnings: telemetry.warnings || [] // ✅ Include warnings
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

    // ========================================
    // STAGE 10: Verify Ownership & Mark Done
    // ========================================
    self.postMessage({
      event: 'progress',
      msgId: generateMsgId(),
      jobId,
      stage: 'verifying_ownership'
    });

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
    const replyPayload = {
      event: 'RECON_DONE',
      msgId: generateMsgId(),
      jobId,
      metaKey,
      derivedKeys,
      cached: false,
      telemetry: {
        processingMs,
        depthResolution: depthMap ? depthMap.resolution : null,
        normalResolution: normalMap ? normalMap.resolution : null,
        hasFlux: !!fluxData,
        fallback: depthMap ? depthMap.fallback || false : true,
        stages: telemetry.stages,
        modules: telemetry.modules, // ✅ Include module-level telemetry
        errors: telemetry.errors,
        warnings: telemetry.warnings // ✅ Include warnings
      }
    };

    self.postMessage(replyPayload);

    _bcPost({
      event: 'RECON_DONE',
      msgId: generateMsgId(),
      metaKey,
      derivedKeys,
      producer: 'motion.worker',
      timestamp: Date.now()
    });

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
      null,
      {
        manifest: sampleResult,
        config: samplerConfig,
        summary: fluxMeta.sampleManifestSummary
      },
      fluxMeta
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
      await _handleReconstructMeta(data);
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