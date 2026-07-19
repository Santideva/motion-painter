// preprocessor.worker.js 
// Module worker that receives ImageBitmap frames from the main thread wrapper,
// generates thumbnail + quick phash + manifest, writes artifacts to storage, and notifies main thread.

// featureFlags: shared quota sizing / evictor authority so this worker's storage
// config no longer diverges from main.js's (previously hardcoded 500MB here vs
// 2GB in main.js against the SAME underlying IndexedDB counters, which guaranteed
// permanent false "CRITICAL quota pressure" once the full pipeline was running).
import featureFlags from '/src/config/featureFlags.js';
import StorageActivityCoordinator from '/src/config/StorageActivityCoordinator.js';

// ============================================================================
// CRITICAL: Enhanced Error Catching for Debugging
// ============================================================================
console.log('[WORKER] Script file loaded and parsing started');
console.log('[WORKER] Location:', self.location.href);
console.log('[WORKER] Is secure context:', self.isSecureContext);
console.log('[WORKER] Cross-origin isolated:', self.crossOriginIsolated);

// Catch ALL uncaught errors
self.addEventListener('error', (e) => {
  console.error('[WORKER GLOBAL ERROR]', {
    message: e.message || 'no message',
    filename: e.filename || 'no filename',
    lineno: e.lineno || 'no lineno',
    colno: e.colno || 'no colno',
    error: e.error ? {
      name: e.error.name,
      message: e.error.message,
      stack: e.error.stack
    } : 'no error object'
  });
  
  try {
    postMessage({
      event: 'worker:fatal_error',
      phase: 'global_error',
      message: e.message,
      filename: e.filename,
      lineno: e.lineno,
      stack: e.error?.stack
    });
  } catch (postErr) {
    console.error('[WORKER] Could not post error to main:', postErr);
  }
  
  e.preventDefault();
});

// Catch unhandled promise rejections
self.addEventListener('unhandledrejection', (e) => {
  console.error('[WORKER UNHANDLED REJECTION]', {
    reason: String(e.reason),
    stack: e.reason?.stack
  });
  
  try {
    postMessage({
      event: 'worker:fatal_error',
      phase: 'promise_rejection',
      reason: String(e.reason),
      stack: e.reason?.stack
    });
  } catch (postErr) {
    console.error('[WORKER] Could not post rejection:', postErr);
  }
  
  e.preventDefault();
});

console.log('[WORKER] Error handlers installed');

// ── Log filter ───────────────────────────────────────────────────────────
// Silences the high-frequency per-frame PIN lifecycle noise (claim/schedule/
// expire/unpin — one triplet per frame at whatever fps the camera runs) so
// calibration progress and any real warnings/errors are actually readable.
// Anything mentioning calibration/CALIB/abort, or any console.error, is never
// suppressed. self.restoreConsole() removes the filter at any time.
function _installPreprocessorLogFilter() {
  const _origLog   = console.log.bind(console);
  const _origWarn  = console.warn.bind(console);
  const _origDebug = (console.debug || console.log).bind(console);

  self.restoreConsole = () => {
    console.log = _origLog; console.warn = _origWarn; console.debug = _origDebug;
    _origLog('[preprocessor.worker] Log filter removed');
  };

  const ALWAYS_ALLOW = ['CALIB', 'calibration', 'Calibration', 'abort', 'Abort'];

  const LOG_BLOCK = [
    '[PIN] ✓ Claimed artifact:thumbnail',
    '[PIN] ✓ Claimed artifact:phash',
    '[PIN] ✓ Claimed artifact:manifest',
    '[PIN] ⏱️  Scheduled TTL for artifact:thumbnail',
    '[PIN] ⏱️  Scheduled TTL for artifact:phash',
    '[PIN] ⏱️  Scheduled TTL for artifact:manifest',
    '[PIN] ⏰ TTL expired for artifact:thumbnail',
    '[PIN] ⏰ TTL expired for artifact:phash',
    '[PIN] ⏰ TTL expired for artifact:manifest',
    '[PIN] ✓ Auto-unpinned artifact:thumbnail',
    '[PIN] ✓ Auto-unpinned artifact:phash',
    '[PIN] ✓ Auto-unpinned artifact:manifest',
    '[PIN] 🚫 Cancelled TTL',
    '[PIN] 🚫 TTL cancelled',
  ];

  const blocked = (list, args) => {
    const s = typeof args[0] === 'string' ? args[0] : '';
    if (ALWAYS_ALLOW.some(p => s.includes(p))) return false;
    return list.some(p => s.includes(p));
  };

  console.log   = (...a) => { if (!blocked(LOG_BLOCK, a)) _origLog(...a);   };
  console.debug = (...a) => { if (!blocked(LOG_BLOCK, a)) _origDebug(...a); };
  // Warnings are never suppressed here — only routine per-frame logs are noisy;
  // anything reaching console.warn already indicates something worth seeing.
  console.warn  = (...a) => { _origWarn(...a); };
  // console.error is never filtered.

  _origLog('[preprocessor.worker] Log filter active — self.restoreConsole() to remove');
}
_installPreprocessorLogFilter();

// ============================================================================
// Original Worker Code with Enhanced Logging
// ============================================================================

try {
  console.log('preprocessor.worker: (top) module evaluation starting...');
} catch (e) {
  // console may be unavailable in some edge cases; silence
}

// --- worker-side global error/rejection handlers (diagnostic helpers) ---
self.addEventListener('error', (e) => {
  try {
    postMessage({
      event: 'worker:error',
      phase: 'uncaught_exception',
      message: e?.message ?? null,
      filename: e?.filename ?? null,
      lineno: e?.lineno ?? null,
      colno: e?.colno ?? null,
      error: e?.error ? (e.error.message || String(e.error)) : null,
      stack: e?.error && e.error.stack ? e.error.stack : null,
      timestamp: Date.now()
    });
  } catch (_) { /* silent fallback */ }
});

self.addEventListener('unhandledrejection', (e) => {
  try {
    postMessage({
      event: 'worker:error',
      phase: 'unhandledrejection',
      reason: String(e.reason),
      stack: e.reason && e.reason.stack ? e.reason.stack : null,
      timestamp: Date.now()
    });
  } catch (_) {}
});

const DEFAULT_THUMB_MAX_SIDE = 256;
const BROADCAST_CHANNEL = 'motion-painter-store';
const INIT_TIMEOUT_MS = 30000; // 30 seconds

// ============================================================================
// PIN LIFECYCLE CONFIGURATION
// ============================================================================
/**
 * TTL (Time-To-Live) constants for auto-unpinning artifacts
 * 
 * DESIGN RATIONALE:
 * - Frame artifacts (thumbnail/phash/manifest): 2 minutes
 *   Short TTL because consumers typically claim within seconds
 *   If unclaimed after 2min, likely orphaned/unwanted
 * 
 * - Calibration artifacts (dark/flat/bias/calibrated): 5 minutes
 *   Longer TTL because:
 *   1. Expensive to compute (5-10 seconds)
 *   2. Consumers may take longer to discover (accumulate frames, start reconstruction)
 *   3. Shared across many frames (higher reuse value)
 * 
 * - Calibration meta: 0 (no auto-unpin)
 *   Never auto-unpin because:
 *   1. Tiny size (~1KB) - doesn't contribute to memory pressure
 *   2. Long-lived - valid until user invalidates calibration
 *   3. Critical - losing it orphans expensive child artifacts
 *   4. Manual lifecycle - only unpinned via invalidateCalibration()
 */
const ARTIFACT_PIN_TTL_MS = 120000; // 2 minutes for frame artifacts
const CALIBRATION_PIN_TTL_MS = 300000; // 5 minutes for calibration children
const CALIBRATION_META_TTL_MS = 0; // No auto-unpin for meta (manual only)

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
 *   owner: 'preprocessor',
 *   expiresAt: timestamp
 * }
 * 
 * LIFECYCLE:
 * 1. _persistAndPin() creates entry and schedules timer
 * 2. BC 'artifact:claimed' event triggers _cancelTTL() → removes entry
 * 3. Timer expires → auto-unpin → removes entry
 * 4. invalidateCalibration() → _cancelTTL() all children → removes entries
 */
const _pinnedArtifacts = new Map();

let bc;
let storageReady = false;
let initializationStarted = false;
const pendingFrames = [];

// Frames arriving while CALIB.busy is true (a calibration computation is
// in flight) are queued here instead of persisted immediately, when
// pauseFrameIngestDuringCalibration is enabled. This prevents ordinary
// per-frame thumbnail/phash/manifest writes from starving calibration's own
// sequential IndexedDB writes on the same [artifacts, counters, pins] store
// set — the root cause of calibration timing out under sustained frame rates
// even when storage quota itself is healthy. Drained by
// _drainCalibrationDeferredFrames() once calibration finishes.
const calibrationDeferredFrames = [];

// track per-job in-flight calibration usage (jobId -> metaKey)
const inFlightCalibMap = new Map();

// jobIds whose calibration request was abandoned by the caller (timeout).
// Checked at the end of handleComputeCalibration so an orphaned hard-pinned
// calibration.meta (no TTL, never auto-evicted) isn't left behind indefinitely
// if the wrapper already gave up before the worker finished persisting.
const abortedCalibrationJobs = new Set();

// -- DYNAMIC IMPORT: ensures the worker's top-level logs run even if storage import fails --
let storageAPI = null;

console.log('[WORKER] About to start dynamic import IIFE');

(async () => {
  try {
    console.log('[WORKER] === Storage Import Starting ===');
    console.log('[WORKER] Attempting dynamic import of storage.js');
    console.log('[WORKER] Will try absolute path: /src/js/core/storage.js');
    
    let mod;
    try {
      console.log('[WORKER] Trying absolute path import...');
      mod = await import('/src/js/core/storage.js');
      console.log('[WORKER] ✓ Absolute path import succeeded');
    } catch (absErr) {
      console.error('[WORKER] ✗ Absolute path import failed:', {
        name: absErr.name,
        message: absErr.message,
        stack: absErr.stack
      });
      
      console.log('[WORKER] Trying relative path: ./storage.js');
      try {
        mod = await import('./storage.js');
        console.log('[WORKER] ✓ Relative path import succeeded');
      } catch (relErr) {
        console.error('[WORKER] ✗ Relative path import also failed:', {
          name: relErr.name,
          message: relErr.message,
          stack: relErr.stack
        });
        
        throw new Error(`Both import attempts failed. Abs: ${absErr.message}, Rel: ${relErr.message}`);
      }
    }
    
    console.log('[WORKER] Storage module object received, type:', typeof mod);
    console.log('[WORKER] Module keys:', Object.keys(mod || {}));
    
    storageAPI = mod?.default || mod?.storageAPI || mod;
    
    if (!storageAPI) {
      throw new Error('storage module imported but storageAPI is null/undefined');
    }
    
    console.log('[WORKER] storageAPI extracted, type:', typeof storageAPI);
    console.log('[WORKER] Has initStorage?', typeof storageAPI.initStorage);
    
    // NOW initialize - storageAPI is available
    if (typeof storageAPI.initStorage === 'function') {
      console.log('[WORKER] calling storageAPI.initStorage...');
      // Quota now comes from shared featureFlags rather than a hardcoded 500MB.
      // startEvictor is always false here: main.js is the sole evictor authority
      // (see storageEvictorAuthority flag) — this worker never runs a competing loop.
      let _quota = 2 * 1024 * 1024 * 1024;
      try {
        _quota = featureFlags.getFlag('storageQuotaBytes') ?? _quota;
      } catch (e) { /* featureFlags unavailable — use default shared quota */ }
      await storageAPI.initStorage({ quota: _quota, startEvictor: false });
      console.log('[WORKER] ✓ storageAPI.initStorage completed (quota=' + _quota + ')');
      
      // Bind methods to self
      console.log('[WORKER] binding storageAPI methods to self...');
      self.putInboundArtifact = storageAPI.putInboundArtifact.bind(storageAPI);
      self.getArtifact = storageAPI.getArtifact.bind(storageAPI);
      self.pinArtifact = storageAPI.pinArtifact.bind(storageAPI);
      self.unpinArtifact = storageAPI.unpinArtifact.bind(storageAPI);
      self.getReadHandle = storageAPI.getReadHandle.bind(storageAPI);
      self.promoteToWork = storageAPI.promoteToWork.bind(storageAPI);
      self.reserveArtifact = storageAPI.reserveArtifact.bind(storageAPI);
      self.releaseReservation = storageAPI.releaseReservation.bind(storageAPI);
      self.checkQuotaAndEvict = storageAPI.checkQuotaAndEvict.bind(storageAPI);
      self.getStorageStats = storageAPI.getStorageStats.bind(storageAPI);
      
      // ============================================================================
      // ✅ NEW: Bind pin lifecycle storage APIs
      // ============================================================================
      // CRITICAL: These must be bound for _persistAndPin and BC handlers to work
      // Without these, self.getPins will be undefined → BC handlers will fail
      self.getPins = storageAPI.getPins.bind(storageAPI);
      self.getPinRefCount = storageAPI.getPinRefCount.bind(storageAPI);
      self.touchArtifact = storageAPI.touchArtifact.bind(storageAPI);
      self.unpinAll = storageAPI.unpinAll.bind(storageAPI); // Admin only (optional)
      self.getPinnedArtifacts = storageAPI.getPinnedArtifacts.bind(storageAPI); // Diagnostics
      self.fetchPartByKey = storageAPI.fetchPartByKey.bind(storageAPI); // Parts support
      
      console.log('[WORKER] ✓ All storage APIs bound (including pin lifecycle methods)');
      
      storageReady = true;
      console.log('[WORKER] ✓ Storage initialized successfully, sending worker:ready');
      postMessage({ event: 'worker:ready' });
      
    } else {
      throw new Error('storageAPI.initStorage is not a function');
    }
    
  } catch (err) {
    console.error('[WORKER] FATAL - Dynamic import or init failed:', {
      name: err?.name,
      message: err?.message,
      stack: err?.stack,
      toString: String(err)
    });
    postMessage({
      event: 'worker:error',
      error: 'dynamic-import-or-init-failed',
      details: { message: err?.message, stack: err?.stack, name: err?.name }
    });
  }
})();

console.log('[WORKER] Dynamic import IIFE scheduled (execution is async)')

// Enhanced broadcast channel creation with error handling
try {
  bc = new BroadcastChannel(BROADCAST_CHANNEL);
  console.log('preprocessor.worker: BroadcastChannel created');
  
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
   * 2. TIMING SAFETY (addressing correctness observation):
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
   * 4. FEATURE FLAG (optional):
   *    PREPROCESSOR_UNPIN_ON_CLAIM controls whether producer unpins on claim
   *    (see Change 7 for flag definition)
   */
  bc.addEventListener('message', async (ev) => {
    const data = ev.data || {};
    
    // ============================================================================
    // IGNORE SELF-POSTED MESSAGES (prevent double-handling)
    // ============================================================================
    // BroadcastChannel delivers messages to sender too
    // Check both 'source' and 'producer' fields for compatibility
    if (data.source === 'preprocessor' || data.producer === 'preprocessor') {
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
      
      // Check if UNPIN_ON_CLAIM flag is enabled (see Change 7)
      const unpinOnClaim = typeof PREPROCESSOR_UNPIN_ON_CLAIM !== 'undefined' 
        ? PREPROCESSOR_UNPIN_ON_CLAIM 
        : false;
      
      if (unpinOnClaim) {
        // ✅ AGGRESSIVE MODE: Unpin immediately to free memory
        (async () => {
          try {
            const unpinFn = self.unpinArtifact || 
                           (typeof storageAPI !== 'undefined' && storageAPI.unpinArtifact);
            
            if (typeof unpinFn === 'function') {
              await unpinFn(metaKey, { owner: 'preprocessor' });
              _cancelTTL(metaKey); // Cancel timer after successful unpin
              
              // Unpin derived keys too
              for (const derivedKey of derivedKeys) {
                await unpinFn(derivedKey, { owner: 'preprocessor' });
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
     * 
     * RACE CONDITION ANALYSIS (safe):
     * Between getPins() check and unpinArtifact() call, another consumer might pin.
     * OUTCOME: We still unpin preprocessor (refcount decrements by 1)
     *          New consumer's pin keeps artifact protected (refcount still > 0)
     * RESULT: Safe - reduces pinnedBytes opportunistically
     *         No correctness failure even if race occurs
     * 
     * NOTE: Storage doesn't provide transaction-level check-then-unpin
     *       This is acceptable - unpinning preprocessor early is optimization
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
          const getPinsFn = self.getPins || 
                           (typeof storageAPI !== 'undefined' && storageAPI.getPins);
          
          if (typeof getPinsFn !== 'function') {
            console.warn('[PIN] getPins not available, cannot check refcount');
            return;
          }
          
          const pins = await getPinsFn(metaKey);
          
          // If only preprocessor pin remains, unpin it
          if (pins.length === 1 && pins[0].owner === 'preprocessor') {
            const unpinFn = self.unpinArtifact || 
                           (typeof storageAPI !== 'undefined' && storageAPI.unpinArtifact);
            
            if (typeof unpinFn === 'function') {
              await unpinFn(metaKey, { owner: 'preprocessor' });
              console.log(`[PIN] ✓ Released ${metaKey.slice(0, 20)}... (last consumer ${releasedBy} released - no pins remain)`);
              
              // Broadcast final unpin
              if (bc) {
                bc.postMessage({
                  event: 'artifact:unpinned',
                  metaKey,
                  owner: 'preprocessor',
                  reason: 'all_consumers_released',
                  producer: 'preprocessor',
                  source: 'preprocessor',
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
    
    // ============================================================================
    // FUTURE: Additional BC events
    // ============================================================================
    // - pin:heartbeat: Consumer signals continued usage (extend TTL)
    // - artifact:promote: Consumer requests work queue promotion
    // - calibration:* events: Already handled below
  });
  
} catch (err) {
  console.error('preprocessor.worker: Failed to create BroadcastChannel', err);
  bc = null;
}

// Add timeout for storage initialization
const initTimeout = setTimeout(() => {
  if (!storageReady) {
    console.error('preprocessor.worker: Storage initialization timed out after 30 seconds');
    postMessage({ 
      event: 'worker:error', 
      error: 'Storage initialization timeout',
      timeout: INIT_TIMEOUT_MS
    });
  }
}, INIT_TIMEOUT_MS);

// ==================== UTILITY: Retry wrapper for storage operations ====================
// CHANGE 1: NEW FUNCTION
// PURPOSE: Handle transient IndexedDB errors with exponential backoff
/**
 * Retry wrapper for storage operations (handles transient IndexedDB errors)
 * @param {Function} putFn - Async function that performs the storage operation
 * @param {number} maxAttempts - Maximum retry attempts (default: 4)
 * @param {number} baseDelayMs - Base delay in ms for exponential backoff (default: 150)
 * @returns {Promise} Result of the storage operation
 */
async function _retryStoragePut(putFn, maxAttempts = 4, baseDelayMs = 150) {
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await putFn();
    } catch (err) {
      lastErr = err;
      const errMsg = String(err?.message || err).toLowerCase();
      // Retry on transient errors only
      const isTransient = /invalidstateerror|database connection is closing|locked|quotaexceeded|timeout/i.test(errMsg);
      
      if (!isTransient || attempt === maxAttempts - 1) {
        throw err; // Non-transient or final attempt - rethrow
      }
      
      const delay = baseDelayMs * (attempt + 1);
      console.warn(`_retryStoragePut: attempt ${attempt + 1}/${maxAttempts} failed, retrying in ${delay}ms...`, err.message);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

// ============================================================================
// HELPER: Persist + Auto-Pin with TTL Management
// ============================================================================
/**
 * Persist artifact to storage and immediately claim ownership with a pin.
 * Implements the "producer pins on create" lifecycle pattern.
 * 
 * EXPLANATION:
 * This is the CRITICAL helper that enforces ownership semantics:
 * 
 * 1. Persist artifact to IndexedDB via putInboundArtifact
 * 2. Immediately pin with producer ownership (prevents eviction)
 * 3. Schedule TTL auto-unpin timer (allows cleanup if unclaimed)
 * 4. Broadcast pin event (allows consumers to discover and claim)
 * 
 * WHY THIS MATTERS:
 * Without this, artifacts are created unpinned → immediately evictable → race condition.
 * With this, artifacts are protected until:
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
 * @param {string} options.owner - Pin owner identifier (default: 'preprocessor')
 * @param {number} options.ttlMs - Time-to-live in ms (0 = no expiration)
 * @param {string} options.pinType - 'soft' (evictable under pressure) or 'hard' (never evict)
 * @returns {Promise<{ok, metaKey}>} Storage result with canonical metaKey
 * @throws {Error} If persistence fails
 */
async function _persistAndPin(artifact, {
  owner = 'preprocessor',
  ttlMs = ARTIFACT_PIN_TTL_MS,
  pinType = 'soft'
} = {}) {
  
  // ============================================================================
  // STEP 1: Persist artifact to IndexedDB (with retry on transient errors)
  // ============================================================================
  const putResult = await _retryStoragePut(async () => {
    const putFn = self.putInboundArtifact || 
                  (typeof storageAPI !== 'undefined' && storageAPI.putInboundArtifact);
    
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
  
  // ============================================================================
  // STEP 2: Immediately claim ownership with pin
  // ============================================================================
  try {
    const pinFn = self.pinArtifact || 
                  (typeof storageAPI !== 'undefined' && storageAPI.pinArtifact);
    
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
    
    // ============================================================================
    // STEP 3: Schedule worker-level TTL auto-unpin (if ttlMs > 0)
    // ============================================================================
    // EXPLANATION: This is separate from storage pin TTL.
    // - Storage pin TTL: Prevents eviction (authoritative)
    // - Worker TTL: Schedules proactive cleanup (advisory optimization)
    // 
    // Worker timer can be cancelled by consumer claim → avoids redundant unpin
    if (ttlMs > 0) {
      _scheduleTTLUnpin(metaKey, owner, ttlMs);
    }
    
    // ============================================================================
    // STEP 4: Broadcast pin event for consumer discovery
    // ============================================================================
    if (bc) {
      try {
        bc.postMessage({
          event: 'artifact:pinned',
          metaKey,
          owner,
          claimedBy: owner, // BC protocol consistency
          type: pinType,
          ttlMs,
          expiresAt: ttlMs > 0 ? Date.now() + ttlMs : null,
          producer: 'preprocessor',
          source: 'preprocessor', // For self-message filtering
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
 * DUAL TTL MODEL EXPLANATION:
 * 
 * 1. STORAGE-LEVEL TTL (via pinArtifact ttlMs parameter):
 *    - Stored in IndexedDB pins table with expiresAt timestamp
 *    - Enforced by storage.js getPins() filtering expired pins
 *    - Enforced by storage.js reaper (reapStaleRunning, eviction checks)
 *    - AUTHORITATIVE for correctness (survives worker death)
 * 
 * 2. WORKER-LEVEL TTL (via setTimeout in _scheduleTTLUnpin):
 *    - Stored in _pinnedArtifacts Map with timer handle
 *    - ADVISORY optimization to avoid storage polling
 *    - Allows producer to proactively unpin before storage GC
 *    - Lost on worker crash (storage TTL takes over)
 * 
 * CONSISTENCY:
 * Both TTLs use same duration (ARTIFACT_PIN_TTL_MS, CALIBRATION_PIN_TTL_MS)
 * 
 * FAILURE MODES:
 * - Worker dies → worker timers lost → storage TTL still protects
 * - Storage dies → worker timer fires but unpin fails → safe (idempotent)
 * 
 * WHY DUAL TIMERS:
 * - Worker timers = fast proactive cleanup (reduces pinnedBytes early)
 * - Storage TTL = guaranteed cleanup (correctness even if worker crashes)
 */

/**
 * Schedule auto-unpin after TTL expires (cancellable by consumer claim)
 * 
 * LIFECYCLE:
 * 1. Producer creates artifact → schedules TTL unpin
 * 2. Consumer discovers artifact via BC → claims by pinning with own owner
 * 3. Consumer sends 'artifact:claimed' BC event → producer cancels TTL
 * 4. Consumer processes artifact → unpins when done
 * 
 * TIMEOUT SCENARIOS:
 * - If consumer claims: Timer cancelled, producer keeps pin until consumer releases
 * - If TTL expires unclaimed: Producer auto-unpins, artifact becomes evictable
 * 
 * @param {string} metaKey - Artifact key to schedule unpin for
 * @param {string} owner - Pin owner (must match for unpin)
 * @param {number} ttlMs - Time-to-live in milliseconds
 */
function _scheduleTTLUnpin(metaKey, owner, ttlMs) {
  // Cancel existing timer if present (defensive - shouldn't happen normally)
  _cancelTTL(metaKey);
  
  const timer = setTimeout(async () => {
    try {
      console.log(`[PIN] ⏰ TTL expired for ${metaKey.slice(0, 20)}..., auto-unpinning...`);
      
      const unpinFn = self.unpinArtifact || 
                      (typeof storageAPI !== 'undefined' && storageAPI.unpinArtifact);
      
      if (typeof unpinFn === 'function') {
        // CRITICAL: Must specify owner to decrement correct refcount
        // If owner doesn't match, storage will return error (safe)
        await unpinFn(metaKey, { owner });
        console.log(`[PIN] ✓ Auto-unpinned ${metaKey.slice(0, 20)}... (TTL expired, unclaimed by consumers)`);
        
        // Broadcast enhanced unpin event with diagnostics
        if (bc) {
          // Query final refcount for diagnostics (optional)
          let finalRefCount = null;
          try {
            const getPinRefCountFn = self.getPinRefCount || 
                                     (typeof storageAPI !== 'undefined' && storageAPI.getPinRefCount);
            if (typeof getPinRefCountFn === 'function') {
              finalRefCount = await getPinRefCountFn(metaKey);
            }
          } catch (refErr) {
            // Non-fatal - diagnostics only
          }
          
          bc.postMessage({
            event: 'artifact:ttl_unpinned', // Specific event name for TTL expiration
            metaKey,
            owner,
            reason: 'ttl_expired',
            producer: 'preprocessor',
            source: 'preprocessor',
            timestamp: Date.now(),
            finalRefCount, // How many pins remain (should be 0)
            wasUnclaimed: true // No consumer claimed before expiration
          });
        }
      } else {
        console.warn(`[PIN] ⚠️  unpinArtifact not available, cannot auto-unpin ${metaKey.slice(0, 20)}...`);
      }
      
      // Remove from tracking map
      _pinnedArtifacts.delete(metaKey);
      
    } catch (err) {
      console.error(`[PIN] ✗ Auto-unpin failed for ${metaKey.slice(0, 20)}...:`, err);
      // Non-fatal: Pin may have already been removed by consumer
      // or storage may have garbage-collected it via its own TTL
      // Ensure we still remove from tracking map to prevent leak
      _pinnedArtifacts.delete(metaKey);
    }
  }, ttlMs);
  
  // Store timer handle for cancellation
  _pinnedArtifacts.set(metaKey, {
    pinnedAt: Date.now(),
    ttlMs,
    timer,
    owner,
    expiresAt: Date.now() + ttlMs
  });
  
  console.log(`[PIN] ⏱️  Scheduled TTL for ${metaKey.slice(0, 20)}... (expires in ${(ttlMs / 1000).toFixed(1)}s)`);
}

/**
 * Cancel TTL timer when consumer claims artifact
 * 
 * SAFE PROTOCOL (addressing correctness observation):
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
 * REAL RISK:
 * Consumer broadcasting 'claimed' AFTER unpinning (consumer bug).
 * Correct sequence: pin → claim → use → release → unpin
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

// ============================================================================
// FEATURE FLAGS (Runtime Configuration)
// ============================================================================
/**
 * PREPROCESSOR_UNPIN_ON_CLAIM:
 * 
 * Controls producer pin behavior when consumer claims artifact:
 * 
 * FALSE (conservative, default):
 *   - Producer keeps pin as fallback until consumer releases
 *   - Higher pinnedBytes but safer (protects against consumer bugs)
 *   - Good for debugging and early deployment
 *   - Recommended for development environments
 * 
 * TRUE (aggressive, memory-optimized):
 *   - Producer unpins immediately on consumer claim
 *   - Lower pinnedBytes (frees memory early)
 *   - Requires consumers to be well-behaved (always pin before use)
 *   - Can reduce memory pressure 
 * 
 * SETTING OPTIONS:
 * 1. featureFlags BC message (dynamic, preferred)
 * 2. Storage config (persistent)
 * 3. Hardcoded for testing (below)
 * 
 * COMPATIBILITY:
 * Works with both modes - consumers don't need to change behavior
 */
let PREPROCESSOR_UNPIN_ON_CLAIM = false;

// Listen for feature flag updates via BC 
// Listen for feature flag updates via BC
if (bc) {
  // Handler already added in BC listener - this is just for flag updates
  const originalBCHandler = bc.onmessage;
  bc.addEventListener('message', (ev) => {
    const data = ev.data || {};
    if (data.event === 'featureFlags:update' && data.flags) {
      if (typeof data.flags.PREPROCESSOR_UNPIN_ON_CLAIM === 'boolean') {
        PREPROCESSOR_UNPIN_ON_CLAIM = data.flags.PREPROCESSOR_UNPIN_ON_CLAIM;
        console.log(`[CONFIG] PREPROCESSOR_UNPIN_ON_CLAIM = ${PREPROCESSOR_UNPIN_ON_CLAIM}`);
      }
    }
    // Drain frames that were deferred purely because a reconstruction was
    // active (not because CALIB.busy was true) as soon as that clears —
    // otherwise they'd sit queued until the next unrelated calibration run.
    if (data.event === 'coordinator:end' && data.kind === 'reconstruction') {
      if (!CALIB.busy && calibrationDeferredFrames.length > 0) {
        console.debug('preprocessor.worker: reconstruction cleared — draining deferred frames');
        _drainCalibrationDeferredFrames();
      }
    }
  });
}
// ==================== UTILITY: Safe bitmap cloning ====================
// CHANGE 2: NEW FUNCTION
// PURPOSE: Safely clone ImageBitmaps that might be closed/transferred
/**
 * Safely create ImageBitmap from existing bitmap (clones via canvas if needed)
 * Returns null if source is closed/invalid
 * @param {ImageBitmap} sourceBitmap - Source bitmap to clone
 * @returns {Promise<ImageBitmap|null>} Cloned bitmap or null
 */
async function _safeBitmapClone(sourceBitmap) {
  if (!sourceBitmap || sourceBitmap.width === 0 || sourceBitmap.height === 0) {
    return null;
  }
  
  try {
    // Test if bitmap is still valid by accessing dimensions
    const w = sourceBitmap.width;
    const h = sourceBitmap.height;
    
    // Create canvas and draw (this works even if source is already transferred/closed in some browsers)
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.drawImage(sourceBitmap, 0, 0);
    
    // Create new bitmap from canvas
    return await createImageBitmap(canvas);
  } catch (err) {
    console.warn('_safeBitmapClone failed (source likely closed):', err.message);
    return null;
  }
}

// ==================== CALIBRATION SUBSYSTEM (CALIB) ====================

const CALIB = {
  darkFrame: null,     // ImageBitmap of averaged dark frame
  flatFrame: null,     // ImageBitmap of averaged flat frame  
  flatBiasNorm: null,  // Normalized flat bias map (Float32Array)
  isCalibrated: false,
  frameCount: 0,
  resolution: null,    // { width, height } of calibration frames
  createdAt: null,
  busy: false,         // Guard against concurrent calibration jobs
  metaKey: false,
  meta: false,

  // Worker-side refcount for frames that reference persisted calibration metaKey
  metaRefCount: 0,
  pendingUnpinKey: null,
  
  // Utility: Compute luminance statistics for frame classification
  async _computeFrameLuminance(imageBitmap) {
    try {
      const sampleSize = 64;
      const canvas = new OffscreenCanvas(sampleSize, sampleSize);
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.drawImage(imageBitmap, 0, 0, sampleSize, sampleSize);
      const imageData = ctx.getImageData(0, 0, sampleSize, sampleSize);
      const data = imageData.data;
      
      let sum = 0;
      let count = 0;
      const values = [];
      
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        values.push(lum);
        sum += lum;
        count++;
      }
      
      const mean = sum / count;
      values.sort((a, b) => a - b);
      const median = values[Math.floor(values.length / 2)];
      
      return { mean, median, min: values[0], max: values[values.length - 1] };
      
    } catch (err) {
      console.error('CALIB: _computeFrameLuminance failed:', err);
      return { mean: 128, median: 128, min: 0, max: 255 };
    }
  },
  
  // Classify frames as dark or flat based on luminance
  async _classifyFrames(frames) {
    console.log('CALIB: Computing frame luminance statistics...');
    
    const frameStats = [];
    
    for (let i = 0; i < frames.length; i++) {
      const stats = await this._computeFrameLuminance(frames[i]);
      frameStats.push({ index: i, ...stats });
    }
    
    frameStats.sort((a, b) => a.median - b.median);
    
    const darkCount = Math.max(1, Math.floor(frames.length * 0.4));
    const flatCount = Math.max(1, frames.length - darkCount);
    
    const darkIndices = frameStats.slice(0, darkCount).map(s => s.index);
    const flatIndices = frameStats.slice(darkCount).map(s => s.index);
    
    console.log(`CALIB: Classified ${darkCount} dark frames, ${flatCount} flat frames`);
    console.log('CALIB: Dark frame luminance range:', 
      frameStats.slice(0, darkCount).map(s => s.median.toFixed(1)).join(', '));
    console.log('CALIB: Flat frame luminance range:', 
      frameStats.slice(darkCount).map(s => s.median.toFixed(1)).join(', '));
    
    return { darkIndices, flatIndices };
  },
  
  // Process frames with proper averaging and float precision
  async _processFrameGroup(frames, indices, { width, height }) {
    console.log(`CALIB: Processing ${indices.length} frames at ${width}x${height}`);
    
    const maxCalibrationSize = 512;
    const scale = Math.min(1, maxCalibrationSize / Math.max(width, height));
    const calibW = Math.max(1, Math.floor(width * scale));
    const calibH = Math.max(1, Math.floor(height * scale));
    
    if (scale < 1) {
      console.log(`CALIB: Downsampling calibration frames from ${width}x${height} to ${calibW}x${calibH}`);
    }
    
    const channelSize = calibW * calibH;
    const rSum = new Float32Array(channelSize);
    const gSum = new Float32Array(channelSize);
    const bSum = new Float32Array(channelSize);
    
    const tempCanvas = new OffscreenCanvas(calibW, calibH);
    const tempCtx = tempCanvas.getContext('2d', { alpha: false });
    
    try {
      for (let frameIdx = 0; frameIdx < indices.length; frameIdx++) {
        const frame = frames[indices[frameIdx]];
        
        tempCtx.drawImage(frame, 0, 0, calibW, calibH);
        const imageData = tempCtx.getImageData(0, 0, calibW, calibH);
        const data = imageData.data;
        
        for (let pixelIdx = 0; pixelIdx < channelSize; pixelIdx++) {
          const dataIdx = pixelIdx * 4;
          rSum[pixelIdx] += data[dataIdx];
          gSum[pixelIdx] += data[dataIdx + 1];
          bSum[pixelIdx] += data[dataIdx + 2];
        }
        
        try {
          frame.close();
          console.log(`CALIB: Closed frame ${indices[frameIdx]} after processing`);
        } catch (e) {
          console.warn(`CALIB: Error closing frame ${indices[frameIdx]}:`, e);
        }
      }
      
      const avgData = new Uint8ClampedArray(calibW * calibH * 4);
      const frameCount = indices.length;
      
      for (let pixelIdx = 0; pixelIdx < channelSize; pixelIdx++) {
        const dataIdx = pixelIdx * 4;
        avgData[dataIdx]     = Math.round(rSum[pixelIdx] / frameCount);
        avgData[dataIdx + 1] = Math.round(gSum[pixelIdx] / frameCount);
        avgData[dataIdx + 2] = Math.round(bSum[pixelIdx] / frameCount);
        avgData[dataIdx + 3] = 255;
      }
      
      const avgImageData = new ImageData(avgData, calibW, calibH);
      
      const resultCanvas = new OffscreenCanvas(calibW, calibH);
      const resultCtx = resultCanvas.getContext('2d', { alpha: false });
      resultCtx.putImageData(avgImageData, 0, 0);
      
      const resultBitmap = await createImageBitmap(resultCanvas);
      
      return resultBitmap;
      
    } catch (err) {
      console.error('CALIB: _processFrameGroup failed:', err);
      throw err;
    }
  },
  
  // Compute normalized flat bias correction map
  _computeFlatBiasNorm(darkFrame, flatFrame, { width, height }) {
    console.log('CALIB: Computing normalized flat bias correction map');
    
    try {
      const darkCanvas = new OffscreenCanvas(width, height);
      const darkCtx = darkCanvas.getContext('2d', { alpha: false });
      darkCtx.drawImage(darkFrame, 0, 0, width, height);
      const darkData = darkCtx.getImageData(0, 0, width, height);
      
      const flatCanvas = new OffscreenCanvas(width, height);
      const flatCtx = flatCanvas.getContext('2d', { alpha: false });
      flatCtx.drawImage(flatFrame, 0, 0, width, height);
      const flatData = flatCtx.getImageData(0, 0, width, height);
      
      const biasData = new Float32Array(width * height * 3);
      const channelSums = [0, 0, 0];
      const pixelCount = width * height;
      const epsilon = 1e-6;
      
      for (let i = 0; i < width * height; i++) {
        const dataIdx = i * 4;
        const biasIdx = i * 3;
        
        for (let c = 0; c < 3; c++) {
          const flatVal = flatData.data[dataIdx + c];
          const darkVal = darkData.data[dataIdx + c];
          const bias = Math.max(epsilon, flatVal - darkVal);
          
          biasData[biasIdx + c] = bias;
          channelSums[c] += bias;
        }
      }
      
      const channelMeans = channelSums.map(sum => Math.max(epsilon, sum / pixelCount));
      console.log('CALIB: Flat bias channel means:', channelMeans.map(m => m.toFixed(6)));
      
      const minValidMean = 0.1;
      channelMeans.forEach((mean, c) => {
        if (mean < minValidMean) {
          console.warn(`CALIB: Channel ${c} mean (${mean.toFixed(6)}) is very small, calibration may be unreliable`);
        }
      });
      
      for (let i = 0; i < pixelCount; i++) {
        const biasIdx = i * 3;
        
        for (let c = 0; c < 3; c++) {
          const normalized = biasData[biasIdx + c] / channelMeans[c];
          biasData[biasIdx + c] = Math.max(0.01, Math.min(100.0, normalized));
        }
      }
      
      return biasData;
      
    } catch (err) {
      console.error('CALIB: _computeFlatBiasNorm failed:', err);
      throw err;
    }
  },

  // Compute calibration from multiple frames
  //
  // NOTE: this.busy is now set/cleared entirely by the CALLER
  // (handleComputeCalibration), spanning the whole calibration attempt —
  // frame averaging AND the subsequent persisting_artifacts phase. Setting
  // it only around the averaging step (as this method previously did) let
  // busy drop back to false before the 5 sequential dark/flat/bias/
  // calibrated/meta persists even began — exactly the window where ordinary
  // per-frame writes (thumbnail/phash/manifest, ~30/s) would then compete
  // with calibration's writes for the same IDB transaction lock, causing
  // calibration to stall past its timeout.
  async computeCalibration({ frames, framesNeeded = 10, resolution }) {
    try {
      console.log(`CALIB: Computing calibration from ${frames.length}/${framesNeeded} frames`);
      
      if (frames.length < Math.min(3, framesNeeded)) {
        throw new Error(`Insufficient frames: need at least 3, got ${frames.length}`);
      }
      
      const { width, height } = resolution;
      
      const { darkIndices, flatIndices } = await this._classifyFrames(frames);
      
      console.log('CALIB: Processing dark frames...');
      const darkFrame = await this._processFrameGroup(frames, darkIndices, { width, height });

      console.log('CALIB: Processing flat frames...');
      const flatFrame = await this._processFrameGroup(frames, flatIndices, { width, height });
      
      const flatBiasNorm = this._computeFlatBiasNorm(darkFrame, flatFrame, { 
        width: darkFrame.width, 
        height: darkFrame.height 
      });
      
      this.darkFrame = darkFrame;
      this.flatFrame = flatFrame;
      this.flatBiasNorm = flatBiasNorm;
      this.isCalibrated = true;
      this.frameCount = frames.length;
      this.resolution = { width: darkFrame.width, height: darkFrame.height };
      this.createdAt = Date.now();
      
      console.log(`CALIB: Calibration computed successfully (${this.frameCount} frames, ${this.resolution.width}x${this.resolution.height})`);
      
      return {
        darkFrame: this.darkFrame,
        flatFrame: this.flatFrame,
        meta: this.getCalibrationMeta()
      };
      
    } catch (err) {
      console.error('CALIB: computeCalibration failed:', err);
      this.invalidateCalibration();
      
      frames.forEach((frame, index) => {
        try {
          frame.close();
          console.log(`CALIB: Closed frame ${index} during error cleanup`);
        } catch (e) {
          console.warn(`CALIB: Error closing frame ${index} during cleanup:`, e);
        }
      });
      
      throw err;
    }
    // busy is cleared by the caller (handleComputeCalibration), not here —
    // see note above. On the error path, invalidateCalibration() (called
    // just above) already resets this.busy = false.
  },
  
  // Apply calibration correction to an ImageBitmap
  async applyCalibrationToBitmap(imageBitmap, { outW, outH }) {
    if (!this.isCalibrated || !this.darkFrame || !this.flatFrame || !this.flatBiasNorm) {
      return imageBitmap;
    }
    
    try {
      const canvas = new OffscreenCanvas(outW, outH);
      const ctx = canvas.getContext('2d', { alpha: false });
      
      ctx.drawImage(imageBitmap, 0, 0, outW, outH);
      const sourceData = ctx.getImageData(0, 0, outW, outH);
      
      const darkCanvas = new OffscreenCanvas(outW, outH);
      const darkCtx = darkCanvas.getContext('2d', { alpha: false });
      darkCtx.drawImage(this.darkFrame, 0, 0, outW, outH);
      const darkData = darkCtx.getImageData(0, 0, outW, outH);
      
      const scaledBiasData = this._scaleFlatBiasNorm(this.flatBiasNorm, this.resolution, { width: outW, height: outH });
      
      const correctedData = new Uint8ClampedArray(sourceData.data.length);
      
      for (let i = 0; i < sourceData.data.length; i += 4) {
        const pixelIdx = Math.floor(i / 4);
        const biasIdx = pixelIdx * 3;
        
        for (let c = 0; c < 3; c++) {
          const source = sourceData.data[i + c];
          const dark = darkData.data[i + c];
          const sourceDark = source - dark;
          const flatBias = scaledBiasData[biasIdx + c];
          
          const corrected = sourceDark / flatBias;
          correctedData[i + c] = Math.max(0, Math.min(255, Math.round(corrected)));
        }
        correctedData[i + 3] = sourceData.data[i + 3];
      }
      
      const correctedImageData = new ImageData(correctedData, outW, outH);
      ctx.putImageData(correctedImageData, 0, 0);
      
      return await createImageBitmap(canvas);
      
    } catch (err) {
      console.error('CALIB: applyCalibrationToBitmap failed:', err);
      return imageBitmap;
    }
  },
  
  _scaleFlatBiasNorm(flatBiasNorm, sourceRes, targetRes) {
    const { width: srcW, height: srcH } = sourceRes;
    const { width: targetW, height: targetH } = targetRes;
    
    if (srcW === targetW && srcH === targetH) {
      return flatBiasNorm;
    }
    
    const scaledBias = new Float32Array(targetW * targetH * 3);
    const scaleX = srcW / targetW;
    const scaleY = srcH / targetH;
    
    for (let y = 0; y < targetH; y++) {
      for (let x = 0; x < targetW; x++) {
        const srcX = Math.floor(x * scaleX);
        const srcY = Math.floor(y * scaleY);
        
        const srcIdx = (srcY * srcW + srcX) * 3;
        const dstIdx = (y * targetW + x) * 3;
        
        scaledBias[dstIdx] = flatBiasNorm[srcIdx];
        scaledBias[dstIdx + 1] = flatBiasNorm[srcIdx + 1];
        scaledBias[dstIdx + 2] = flatBiasNorm[srcIdx + 2];
      }
    }
    
    return scaledBias;
  },
  
  // Invalidate current calibration
  invalidateCalibration() {
    try {
      if (this.darkFrame) {
        this.darkFrame.close();
        console.log('CALIB: Closed dark frame during invalidation');
      }
      if (this.flatFrame) {
        this.flatFrame.close();
        console.log('CALIB: Closed flat frame during invalidation');
      }
    } catch (e) {
      console.warn('CALIB: Error closing calibration frames:', e);
    }
    
    this.darkFrame = null;
    this.flatFrame = null;
    this.flatBiasNorm = null;
    this.isCalibrated = false;
    this.frameCount = 0;
    this.resolution = null;
    this.createdAt = null;
    this.busy = false;
    
    this.metaRefCount = 0;
    this.pendingUnpinKey = null;
    
    console.log('CALIB: Calibration invalidated');
  },
  
  // Get calibration metadata
  getCalibrationMeta() {
    return {
      isCalibrated: this.isCalibrated,
      frameCount: this.frameCount,
      resolution: this.resolution,
      createdAt: this.createdAt,
      age: this.createdAt ? Date.now() - this.createdAt : null
    };
  }
};

// Helper attached to CALIB: fetch persisted calibration artifacts by metaKey
CALIB.fetchPersisted = async function(metaKey = null) {
  try {
    const key = metaKey || this.metaKey;
    if (!key) throw new Error('No calibration metaKey available');

    if (typeof self.getArtifact !== 'function') {
      throw new Error('Storage API (getArtifact) not available in worker');
    }

    const metaArtifact = await self.getArtifact(key);
    if (!metaArtifact || !metaArtifact.data) {
      throw new Error(`Calibration meta not found for key ${key}`);
    }

    const { darkKey, flatKey, biasKey } = metaArtifact.data;

    const darkArt = darkKey ? await self.getArtifact(darkKey) : null;
    const flatArt = flatKey ? await self.getArtifact(flatKey) : null;
    const biasArt = biasKey ? await self.getArtifact(biasKey) : null;

    const darkBitmap = (darkArt && darkArt.blob) ? await createImageBitmap(darkArt.blob) : null;
    const flatBitmap = (flatArt && flatArt.blob) ? await createImageBitmap(flatArt.blob) : null;

    let biasArray = null;
    if (biasArt && biasArt.blob) {
      const ab = await biasArt.blob.arrayBuffer();
      biasArray = new Float32Array(ab);
    }

    if (!this._releaseTokens) this._releaseTokens = new Map();
    const token = `calrel-${Date.now()}-${Math.random().toString(36).slice(2,9)}`;
    this._releaseTokens.set(token, key);

    this.metaRefCount = (this.metaRefCount || 0) + 1;
    console.log(`CALIB.fetchPersisted: created token=${token} metaKey=${key} metaRefCount=${this.metaRefCount}`);

    this.metaKey = key;

    return { darkBitmap, flatBitmap, biasArray, meta: metaArtifact.data, metaKey: key, releaseToken: token };
  } catch (err) {
    console.error('CALIB.fetchPersisted failed', err);
    throw err;
  }
};

// initializeStorage() compatibility shim
function initializeStorage() {
  console.warn('preprocessor.worker: initializeStorage() shim called — delegating to storageAPI.initStorage (module mode)');
  initializationStarted = true;

  // Same shared-quota / no-local-evictor rationale as the primary init path above.
  let _shimQuota = 2 * 1024 * 1024 * 1024;
  try {
    _shimQuota = featureFlags.getFlag('storageQuotaBytes') ?? _shimQuota;
  } catch (e) { /* featureFlags unavailable — use default shared quota */ }

  return storageAPI.initStorage({ quota: _shimQuota, startEvictor: false })
    .then(() => {
      clearTimeout(initTimeout);
      storageReady = true;
      console.log('preprocessor.worker: Storage initialized successfully (via shim)');

  try {
        self.putInboundArtifact = storageAPI.putInboundArtifact.bind(storageAPI);
        self.getArtifact = storageAPI.getArtifact.bind(storageAPI);
        self.pinArtifact = storageAPI.pinArtifact.bind(storageAPI);
        self.unpinArtifact = storageAPI.unpinArtifact.bind(storageAPI);
        self.getReadHandle = storageAPI.getReadHandle.bind(storageAPI);
        self.promoteToWork = storageAPI.promoteToWork.bind(storageAPI);
        self.reserveArtifact = storageAPI.reserveArtifact.bind(storageAPI);
        self.releaseReservation = storageAPI.releaseReservation.bind(storageAPI);
        self.checkQuotaAndEvict = storageAPI.checkQuotaAndEvict.bind(storageAPI);
        self.getStorageStats = storageAPI.getStorageStats.bind(storageAPI);
        
        // ============================================================================
        // ✅ NEW: Bind pin lifecycle APIs (shim path)
        // ============================================================================
        self.getPins = storageAPI.getPins.bind(storageAPI);
        self.getPinRefCount = storageAPI.getPinRefCount.bind(storageAPI);
        self.touchArtifact = storageAPI.touchArtifact.bind(storageAPI);
        self.fetchPartByKey = storageAPI.fetchPartByKey.bind(storageAPI);
        
        console.log('preprocessor.worker: ✓ Storage APIs bound (shim path, including pin lifecycle)');
        
      } catch (bindErr) {
        console.warn('preprocessor.worker: failed to bind storageAPI methods to self', bindErr);
      }

      const queued = [...pendingFrames];
      pendingFrames.length = 0;
      queued.forEach(frame => {
        console.log('preprocessor.worker: Processing queued frame', frame.jobId);
        processFrame(frame);
      });

      console.log('preprocessor.worker: Sending worker:ready message');
      postMessage({ event: 'worker:ready' });
    })
    .catch(err => {
      clearTimeout(initTimeout);
      console.error('preprocessor.worker: Storage initialization failed (shim):', err);
      postMessage({
        event: 'worker:error',
        error: String(err),
        details: { phase: 'storage_init', name: err && err.name, stack: err && err.stack }
      });
      throw err;
    });
}

// Utility: average hash (aHash) quick implementation
async function computeAHashFromBitmap(imageBitmap, hashSize = 8) {
  try {
    const w = hashSize;
    const h = hashSize;
    const off = new OffscreenCanvas(w, h);
    const ctx = off.getContext('2d');
    ctx.drawImage(imageBitmap, 0, 0, w, h);
    const id = ctx.getImageData(0, 0, w, h);
    const data = id.data;
    let sum = 0;
    const vals = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      vals[j] = lum;
      sum += lum;
    }
    const mean = sum / vals.length;
    let bits = 0n;
    for (let i = 0; i < vals.length; i++) {
      if (vals[i] >= mean) bits |= (1n << BigInt(i));
    }
    const hex = bits.toString(16);
    return hex;
  } catch (err) {
    console.error('preprocessor.worker: computeAHashFromBitmap failed', err);
    return 'hash-error';
  }
}

// Create thumbnail (returns Blob and width/height)
async function createThumbnailBlob(imageBitmap, maxSide = DEFAULT_THUMB_MAX_SIDE) {
  try {
    const srcW = imageBitmap.width;
    const srcH = imageBitmap.height;
    const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
    const w = Math.max(1, Math.floor(srcW * scale));
    const h = Math.max(1, Math.floor(srcH * scale));
    const off = new OffscreenCanvas(w, h);
    const ctx = off.getContext('2d');
    ctx.drawImage(imageBitmap, 0, 0, w, h);
    const blob = await off.convertToBlob({ type: 'image/png' });
    return { blob, w, h };
  } catch (err) {
    console.error('preprocessor.worker: createThumbnailBlob failed', err);
    throw err;
  }
}

/**
 * _drainCalibrationDeferredFrames()
 *
 * Called once a calibration computation finishes (success, error, or abort).
 * Processes every frame that was queued while CALIB.busy was true, in
 * original arrival order, staggered slightly so the drain itself doesn't
 * immediately re-create the same contention it was designed to avoid.
 */
function _drainCalibrationDeferredFrames() {
  if (calibrationDeferredFrames.length === 0) return;

  const queued = calibrationDeferredFrames.splice(0, calibrationDeferredFrames.length);
  console.log(`preprocessor.worker: draining ${queued.length} frame(s) deferred during calibration`);

  queued.forEach((frameMsg, index) => {
    setTimeout(() => {
      processFrame(frameMsg).catch(err => {
        console.warn('preprocessor.worker: deferred frame processing failed', frameMsg.jobId, err);
      });
    }, index * 15); // small stagger — avoid re-flooding IDB the instant calibration frees up
  });
}

/**
 * processFrame({ jobId, meta = {}, imageBitmap, options = {} })
 * - Performs thumbnail + phash creation, preserves HFH metadata and cameraContainer,
 * - Persists artifacts via self.putInboundArtifact and uses returned canonical metaKey(s),
 * - Emits worker postMessage artifact:ready with canonical metaKey,
 * - Keeps calibration refcount semantics (usedCalibKey + inFlightCalibMap).
 */
async function processFrame({ jobId, meta = {}, imageBitmap, options = {} }) {
  const startTime = Date.now();
  let usedCalibKey = null;

  // Helpers / constants local to function
  const MAX_ANNULAR_LEN = 512; // safety cap (tuneable)
  const ensureTypedFloat32 = (arr, maxLen = MAX_ANNULAR_LEN) => {
    if (!arr) return null;
    // Accept already-typed arrays
    if (ArrayBuffer.isView(arr) && !(arr instanceof DataView)) {
      if (arr instanceof Float32Array) {
        return (arr.length > maxLen) ? arr.slice(0, maxLen) : arr;
      }
      // Convert other typed arrays to Float32Array
      const sliced = (arr.length > maxLen) ? arr.slice(0, maxLen) : arr;
      return new Float32Array(sliced.buffer, sliced.byteOffset, Math.floor(sliced.byteLength / 4));
    }
    // If plain Array -> convert and cap
    if (Array.isArray(arr)) {
      const a = arr.length > maxLen ? arr.slice(0, maxLen) : arr;
      return new Float32Array(a);
    }
    // Unknown shape -> null
    return null;
  };

  const ensureTypedInt32 = (arr, maxLen = MAX_ANNULAR_LEN) => {
    if (!arr) return null;
    if (ArrayBuffer.isView(arr) && !(arr instanceof DataView)) {
      if (arr instanceof Int32Array) {
        return (arr.length > maxLen) ? arr.slice(0, maxLen) : arr;
      }
      const sliced = (arr.length > maxLen) ? arr.slice(0, maxLen) : arr;
      return new Int32Array(sliced.buffer, sliced.byteOffset, Math.floor(sliced.byteLength / 4));
    }
    if (Array.isArray(arr)) {
      const a = arr.length > maxLen ? arr.slice(0, maxLen) : arr;
      return new Int32Array(a);
    }
    return null;
  };

  try {
    if (!imageBitmap) {
      throw new Error('No imageBitmap provided');
    }

    // Calibration refcount handling (if applyCalibration requested and CALIB.metaKey present)
    if (options.applyCalibration && CALIB && CALIB.metaKey) {
      usedCalibKey = CALIB.metaKey;
      CALIB.metaRefCount = (CALIB.metaRefCount || 0) + 1;
      inFlightCalibMap.set(jobId, usedCalibKey);
      console.log(`CALIB: Incremented metaRefCount for key ${usedCalibKey} -> ${CALIB.metaRefCount}`);
    }

    postMessage({ event: 'progress', jobId, stage: 'processing_start', timestamp: startTime });

    // Apply calibration inside worker if requested
    let processedBitmap = imageBitmap;
    if (options.applyCalibration && CALIB && CALIB.isCalibrated) {
      postMessage({ event: 'progress', jobId, stage: 'applying_calibration' });
      processedBitmap = await CALIB.applyCalibrationToBitmap(imageBitmap, {
        outW: imageBitmap.width,
        outH: imageBitmap.height
      });
      if (processedBitmap !== imageBitmap) {
        try { imageBitmap.close(); } catch (e) {}
      }
    }

    const mode = options.mode || meta.mode || 'preview';
    const thumbMax = mode === 'final' ? 512 : DEFAULT_THUMB_MAX_SIDE;
    const downsampleScale = options.downsampleScale || 1.0;
    const effectiveThumbMax = Math.floor(thumbMax * downsampleScale);

    postMessage({ event: 'progress', jobId, stage: 'creating_thumbnail' });
    const { blob: thumbBlob, w, h } = await createThumbnailBlob(processedBitmap, effectiveThumbMax);

    postMessage({ event: 'progress', jobId, stage: 'computing_phash' });
    const thumbBitmap = await createImageBitmap(thumbBlob);
    const phash = await computeAHashFromBitmap(thumbBitmap, 8);
    try { thumbBitmap.close(); } catch (e) {}

    // Compose a stable source id/hash
    const srcHash = meta.srcHash || `src-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    const frameNumber = meta.frameNumber || null;
    const timestamp = meta.timestamp || Date.now();
    const producerVersion = 'preproc-v1';
    const hashVersion = 'ahash-v1';

    // Build initial artifact objects (keys left undefined to let storage generate canonical metaKey)
    const thumbArtifact = {
      // key: omitted -> let storage generate canonical key
      type: 'thumbnail',
      blob: thumbBlob,
      meta: {
        srcHash,
        frameNumber,
        timestamp,
        sizeBytes: thumbBlob.size,
        origin: 'preprocessor',
        producerVersion,
        dimensions: { width: w, height: h },
        downsampleScale: downsampleScale !== 1.0 ? downsampleScale : undefined,
        calibrationApplied: options.applyCalibration && CALIB && CALIB.isCalibrated,
        calibrationKey: CALIB && CALIB.metaKey ? CALIB.metaKey : undefined,
        cameraId: (meta.cameraContainer && meta.cameraContainer.cameraId) || meta.cameraId || 'unknown'
      },
      createdAt: new Date().toISOString()
    };

    const phashArtifact = {
      type: 'phash',
      data: { phash, hashVersion, algorithm: 'aHash' },
      meta: {
        srcHash,
        frameNumber,
        timestamp,
        producerVersion,
        hashVersion,
        sizeBytes: JSON.stringify({ phash, hashVersion, algorithm: 'aHash' }).length,
        calibrationKey: CALIB && CALIB.metaKey ? CALIB.metaKey : undefined,
        cameraId: (meta.cameraContainer && meta.cameraContainer.cameraId) || meta.cameraId || 'unknown'
      },
      createdAt: new Date().toISOString()
    };

    // Extract HFH info from incoming meta, convert arrays to typed arrays (compact)
    const hfhData = {};
    if (meta.annular) {
      const ann = ensureTypedFloat32(meta.annular, 512);
      if (ann && ann.length > 0) hfhData.annular = ann;
    }
    if (meta.annularCounts) {
      const ac = ensureTypedInt32(meta.annularCounts, 512);
      if (ac && ac.length > 0) hfhData.annularCounts = ac;
    }
    if (meta.annularStats) {
      // Copy stats as-is (small object)
      hfhData.annularStats = {
        mean: Number(meta.annularStats.mean) || 0,
        stddev: Number(meta.annularStats.stddev) || 0,
        min: Number(meta.annularStats.min) || 0,
        max: Number(meta.annularStats.max) || 0,
        samples: Number(meta.annularStats.samples) || (hfhData.annular ? hfhData.annular.length : 0)
      };
    }

    let hfhDecision = null;
    if (meta.hfhDecision) {
      // Normalize fields
      hfhDecision = {
        shouldRun: !!meta.hfhDecision.shouldRun,
        reason: meta.hfhDecision.reason || 'unknown',
        severity: Number(meta.hfhDecision.severity) || 0,
        suggestedResolution: Number(meta.hfhDecision.suggestedResolution) || 256,
        suggestedMode: meta.hfhDecision.suggestedMode || 'light',
        diagnostics: meta.hfhDecision.diagnostics ? {
          spike: !!meta.hfhDecision.diagnostics.spike,
          spikeBin: meta.hfhDecision.diagnostics.spikeBin,
          spikeThreshold: meta.hfhDecision.diagnostics.spikeThreshold,
          cv: meta.hfhDecision.diagnostics.cv,
          vignettingRatio: meta.hfhDecision.diagnostics.vignettingRatio,
          exposureChange: !!meta.hfhDecision.diagnostics.exposureChange,
          reasons: Array.isArray(meta.hfhDecision.diagnostics.reasons) ? meta.hfhDecision.diagnostics.reasons : []
        } : {}
      };
    }

    // Camera container (preserve full structure)
    let cameraContainer = null;
    if (meta.cameraContainer) {
      cameraContainer = {
        cameraId: meta.cameraContainer.cameraId || 'unknown',
        deviceId: meta.cameraContainer.deviceId,
        label: meta.cameraContainer.label,
        facing: meta.cameraContainer.facing,
        width: meta.cameraContainer.width,
        height: meta.cameraContainer.height,
        ...meta.cameraContainer
      };
    } else if (meta.cameraId) {
      cameraContainer = { cameraId: meta.cameraId };
    }

    // Build manifest (initial, keys will be updated with canonical keys returned by storage)
    const manifestArtifact = {
      type: 'manifest',
      data: {
        keys: [], // will be filled with canonical keys returned by storage
        frameNumber,
        timestamp,
        cameraContainer: cameraContainer || undefined,
        cameraId: cameraContainer?.cameraId || meta.cameraId || 'unknown',
        hfh: Object.keys(hfhData).length > 0 ? hfhData : null,
        hfhDecision: hfhDecision,
        meta: meta, // preserve original meta for compatibility
        versions: {
          thumbnail: producerVersion,
          phash: hashVersion,
          sdf: null,
          pose: null
        },
        processingMode: mode,
        downsampleScale: downsampleScale !== 1.0 ? downsampleScale : undefined,
        calibrationApplied: options.applyCalibration && CALIB && CALIB.isCalibrated,
        calibrationKey: CALIB && CALIB.metaKey ? CALIB.metaKey : undefined
      },
      meta: {
        srcHash,
        frameNumber,
        timestamp,
        producerVersion,
        cameraId: cameraContainer?.cameraId || meta.cameraId || 'unknown',
        sizeBytes: 0
      },
      createdAt: new Date().toISOString()
    };

// ============================================================================
    // ✅ CHANGE: Persist + Pin thumbnail (claim ownership with TTL)
    // ============================================================================
    postMessage({ event: 'progress', jobId, stage: 'writing_thumb' });
    
    // EXPLANATION: Use _persistAndPin instead of raw putInboundArtifact
    // This ensures thumbnail is protected from eviction for ARTIFACT_PIN_TTL_MS (2 min)
    // Consumers (MotionDetector, motion.worker) have 2 minutes to discover and claim
    // 
    // WHY THUMBNAIL IS CRITICAL:
    // - Primary artifact consumers need for frame processing
    // - Motion detection analyzes thumbnail for movement
    // - HFH uses thumbnail dimensions for reconstruction
    // - If evicted before consumption → frame processing fails
    const thumbRes = await _persistAndPin({
      type: 'thumbnail',
      blob: thumbBlob,
      meta: {
        srcHash,
        frameNumber,
        timestamp,
        sizeBytes: thumbBlob.size,
        origin: 'preprocessor',
        producerVersion,
        dimensions: { width: w, height: h },
        downsampleScale: downsampleScale !== 1.0 ? downsampleScale : undefined,
        calibrationApplied: options.applyCalibration && CALIB && CALIB.isCalibrated,
        calibrationKey: CALIB && CALIB.metaKey ? CALIB.metaKey : undefined,
        cameraId: (meta.cameraContainer && meta.cameraContainer.cameraId) || meta.cameraId || 'unknown'
      },
      createdAt: new Date().toISOString()
    }, {
      owner: 'preprocessor',
      ttlMs: ARTIFACT_PIN_TTL_MS, // 2 minutes
      pinType: 'soft' // Evictable under extreme memory pressure
    }).catch(e => { 
      throw new Error('thumb persist+pin failed: ' + (e && e.message ? e.message : String(e))); 
    });

    const thumbKeyStored = thumbRes?.metaKey || null;
    
    if (!thumbKeyStored) {
      throw new Error('Thumbnail persist returned no metaKey');
    }

// ============================================================================
    // ✅ CHANGE: Persist + Pin phash
    // ============================================================================
    postMessage({ event: 'progress', jobId, stage: 'writing_phash' });
    
    // EXPLANATION: Phash is used by motion detection and similarity search
    // Must be protected while consumers query it for motion analysis
    // 
    // WHY PHASH IS CRITICAL:
    // - Motion detector compares phash across frames to detect movement
    // - Similarity search uses phash for frame deduplication
    // - Small size (~100 bytes) but high reuse value
    const phashRes = await _persistAndPin({
      type: 'phash',
      data: { phash, hashVersion, algorithm: 'aHash' },
      meta: {
        srcHash,
        frameNumber,
        timestamp,
        producerVersion,
        hashVersion,
        sizeBytes: JSON.stringify({ phash, hashVersion, algorithm: 'aHash' }).length,
        calibrationKey: CALIB && CALIB.metaKey ? CALIB.metaKey : undefined,
        cameraId: (meta.cameraContainer && meta.cameraContainer.cameraId) || meta.cameraId || 'unknown'
      },
      createdAt: new Date().toISOString()
    }, {
      owner: 'preprocessor',
      ttlMs: ARTIFACT_PIN_TTL_MS, // 2 minutes
      pinType: 'soft'
    }).catch(e => { 
      throw new Error('phash persist+pin failed: ' + (e && e.message ? e.message : String(e))); 
    });

    const phashKeyStored = phashRes?.metaKey || null;
    
    if (!phashKeyStored) {
      throw new Error('Phash persist returned no metaKey');
    }

    // Update manifest keys with canonical keys reported by storage
    manifestArtifact.data.keys = [thumbKeyStored, phashKeyStored].filter(Boolean);

    // Update manifest meta size estimate before writing (best-effort)
    try {
      manifestArtifact.meta.sizeBytes = JSON.stringify(manifestArtifact.data).length;
    } catch (e) {
      manifestArtifact.meta.sizeBytes = 0;
    }

    // ── Refresh calibrationKey immediately before manifest persist ──────────
    // Race condition: processFrame and handleComputeCalibration are both async
    // and interleave at await points. The manifestArtifact object was built
    // earlier when CALIB.metaKey may have been false. By the time we reach
    // this point (after thumb+phash awaits), any interleaved
    // handleComputeCalibration will have completed and set CALIB.metaKey.
    // Re-reading here ensures the IDB record and readyData.meta both carry
    // the correct calibration reference. Without this, motion.worker receives
    // calibrationKey: undefined and falls back to CPU depth estimation.
    if (CALIB && CALIB.metaKey) {
      manifestArtifact.data.calibrationKey     = CALIB.metaKey;
      manifestArtifact.data.calibrationApplied = CALIB.isCalibrated;
      manifestArtifact.meta.calibrationKey     = CALIB.metaKey;
    }

// ============================================================================
    // ✅ CHANGE: Persist + Pin manifest (canonical frame metadata)
    // ============================================================================
    postMessage({ event: 'progress', jobId, stage: 'writing_manifest' });
    
    // EXPLANATION: Manifest is the CANONICAL artifact that ties everything together
    // It contains keys to thumbnail, phash, and HFH data
    // This is what consumers (MotionDetector, motion.worker) pin when claiming a frame
    // 
    // WHY MANIFEST IS CRITICAL:
    // - Entry point for all frame processing
    // - Contains references to all child artifacts
    // - If evicted, consumers lose access to entire frame
    // - Small size but highest importance in the artifact graph
    const manifestRes = await _persistAndPin(manifestArtifact, {
      owner: 'preprocessor',
      ttlMs: ARTIFACT_PIN_TTL_MS, // 2 minutes
      pinType: 'soft'
    }).catch(e => { 
      throw new Error('manifest persist+pin failed: ' + (e && e.message ? e.message : String(e))); 
    });

    const canonicalMetaKey = manifestRes?.metaKey || null;
    
    if (!canonicalMetaKey) {
      throw new Error('Manifest persist returned no metaKey');
    }

    const durationMs = Date.now() - startTime;

    // Broadcast artifact:ready using canonicalMetaKey
    const readyData = {
      event: 'artifact:ready',
      jobId,
      keys: manifestArtifact.data.keys.slice(0),
      metaKey: canonicalMetaKey,
      meta: {
        srcHash,
        frameNumber,
        timestamp,
        producerVersion,
        hashVersion,
        cameraId: cameraContainer?.cameraId || meta.cameraId || 'unknown',
        hfhDecision: hfhDecision,
        type: 'frame-manifest',

        // ── Annular luminance profile ──────────────────────────────────────
        // hfhData.annular is the Float32Array from HFH.computeAnnular().
        // main.js passes this to MotionDetector.handleAnnularEvent which runs
        // spike detection, exposure-change detection, and the calibration
        // stable-scene gate. Without it, handleAnnularEvent is never called,
        // no reconstruction intents are created, and the intent system is
        // permanently dead.
        annular:     hfhData.annular ?? null,
        avgLuma:     (hfhData.annularStats && typeof hfhData.annularStats.mean === 'number')
                       ? hfhData.annularStats.mean
                       : (typeof meta.avgLuma === 'number' ? meta.avgLuma : 0),
        width:       imageBitmap.width,
        height:      imageBitmap.height,
        captureTime: meta.captureTime || meta.timestamp || timestamp,

        // ── Calibration key ────────────────────────────────────────────────
        // Refreshed immediately before manifest persist (Change A2) so this
        // correctly reflects CALIB.metaKey even when handleComputeCalibration
        // completed during one of the preceding awaits.
        // main.js native dispatch reads this to guard against stale manifests
        // that pre-date calibration completion.
        calibrationKey: (CALIB && CALIB.metaKey) ? CALIB.metaKey : null
      },
      durationMs,
      processingMode: mode,
      downsampleScale: downsampleScale !== 1.0 ? downsampleScale : undefined,
      calibrationApplied: options.applyCalibration && CALIB && CALIB.isCalibrated
    };

    // Post to main thread
    postMessage(readyData);

    // Broadcast on BroadcastChannel for cross-worker listeners (MotionDetector / motion.worker)
    if (typeof bc !== 'undefined' && bc) {
      try {
        // Use the canonicalMetaKey from storage as the single source of truth
        bc.postMessage(readyData);
      } catch (bcErr) {
        console.warn('preprocessor.worker: broadcast artifact:ready failed', bcErr);
      }
    }

    // Clean up processed bitmap
    try { processedBitmap.close(); } catch (e) {}

  } catch (err) {
    console.error('preprocessor.worker: processing failed', err);
    const errorData = {
      event: 'artifact:error',
      jobId,
      error: String(err),
      stack: err && err.stack ? err.stack : null,
      phase: 'processing'
    };
    postMessage(errorData);
    if (typeof bc !== 'undefined' && bc) {
      try {
        bc.postMessage(errorData);
      } catch (bcErr) {
        console.warn('preprocessor.worker: broadcast artifact:error failed', bcErr);
      }
    }
    try { imageBitmap.close(); } catch (e) {}
  } finally {
    // Calibration refcount decrement (if we incremented at the top)
    try {
      if (usedCalibKey) {
        inFlightCalibMap.delete(jobId);
        CALIB.metaRefCount = Math.max(0, (CALIB.metaRefCount || 0) - 1);
        console.log(`CALIB: Decremented metaRefCount for key ${usedCalibKey} -> ${CALIB.metaRefCount}`);

        if (CALIB.metaRefCount === 0 && CALIB.pendingUnpinKey) {
          const toUnpin = CALIB.pendingUnpinKey;
          CALIB.pendingUnpinKey = null;
          try {
            if (typeof self.unpinArtifact === 'function') {
              await self.unpinArtifact(toUnpin);
              console.log(`CALIB: Unpinned pending key ${toUnpin} after refcount reached zero`);
              if (typeof bc !== 'undefined' && bc) {
                try {
                  bc.postMessage({
                    event: 'calibration:unpin',
                    metaKey: toUnpin,
                    producer: 'preprocessor',
                    source: 'preprocessor',
                    timestamp: Date.now()
                  });
                } catch (bcErr) {
                  console.warn('preprocessor.worker: broadcast calibration:unpin failed', bcErr);
                }
              }
            } else {
              console.warn('CALIB: unpinArtifact not available when trying deferred unpin');
            }
          } catch (uErr) {
            console.warn('CALIB: deferred unpin failed', uErr);
          }
        }
      }
    } catch (finalErr) {
      console.warn('CALIB: error in finalization refcount handling', finalErr);
    }
  }
} 

// Handle reprocess requests (for future SDF/pose generation)
async function handleReprocess({ jobId, key, actions = [], priority = 0 }) {
  try {
    postMessage({ event: 'progress', jobId, stage: 'reprocess_start', key, actions });

    if (typeof self.getArtifact !== 'function') {
      throw new Error('getArtifact function not available');
    }

    const artifact = await self.getArtifact(key);
    if (!artifact) {
      throw new Error(`Artifact not found: ${key}`);
    }

    const results = [];
    
    for (const action of actions) {
      if (action === 'sdf') {
        const sdfKey = `sdf:${artifact.meta.srcHash}`;
        const sdfArtifact = {
          key: sdfKey,
          type: 'sdf',
          data: { placeholder: true, message: 'SDF generation not yet implemented' },
          meta: {
            ...artifact.meta,
            producerVersion: 'sdf-v1',
            reprocessedFrom: key,
            reprocessedAt: new Date().toISOString()
          },
          createdAt: new Date().toISOString()
        };
        await self.putInboundArtifact(sdfArtifact);
        results.push(sdfKey);
        
      } else if (action === 'pose') {
        const poseKey = `pose:${artifact.meta.srcHash}`;
        const poseArtifact = {
          key: poseKey,
          type: 'pose',
          data: { placeholder: true, message: 'Pose estimation not yet implemented' },
          meta: {
            ...artifact.meta,
            producerVersion: 'pose-v1',
            reprocessedFrom: key,
            reprocessedAt: new Date().toISOString()
          },
          createdAt: new Date().toISOString()
        };
        await self.putInboundArtifact(poseArtifact);
        results.push(poseKey);
      }
    }

    postMessage({ 
      event: 'reprocess:complete', 
      jobId, 
      originalKey: key, 
      newKeys: results 
    });

  } catch (err) {
    console.error('preprocessor.worker: reprocess failed', err);
    postMessage({ 
      event: 'reprocess:error', 
      jobId, 
      key, 
      error: String(err),
      stack: err.stack 
    });
  }
}

// ==================== MAJOR CHANGE: handleComputeCalibration ====================
// CHANGE 3: COMPLETE REWRITE
// PURPOSE: Create and persist calibrated frame artifact with robust error handling
/**
 * Handle calibration computation requests
 * CHANGES:
 * 1. Uses _safeBitmapClone to avoid closed bitmap errors
 * 2. Creates calibratedFrameKey artifact (required by motion.worker)
 * 3. Uses _retryStoragePut for transient IndexedDB error handling
 * 4. Persists artifacts in atomic order (children first, manifest last)
 * 5. Does NOT transfer bitmaps to main (sends metadata only)
 * 6. Proper cleanup in finally block
 */
async function handleComputeCalibration({ jobId, frames, framesNeeded, resolution }) {
  // Track bitmaps we create so we can clean them up properly
  let darkBitmapClone = null;
  let flatBitmapClone = null;
  let calibratedBitmap = null;

  // CALIB.busy now spans the ENTIRE calibration attempt (averaging +
  // persisting_artifacts), not just the averaging step inside
  // CALIB.computeCalibration(). This is what pauseFrameIngestDuringCalibration
  // actually checks before deferring incoming camera frames — previously it
  // was false during the whole persist phase, so frames were never deferred
  // when it mattered.
  if (CALIB.busy) {
    postMessage({ event: 'calibration:error', jobId, error: 'Calibration already in progress', phase: 'busy_guard' });
    return;
  }
  CALIB.busy = true;

  // Cross-worker coordination: motion.worker may already be mid-reconstruction,
  // running its own long sequence of IDB reads/writes against the same
  // artifacts/pins/counters stores. Give it a window to finish before starting
  // our own exclusive IDB campaign on top of it.
  let _coordActivityId = null;
  try {
    const _waitResult = await StorageActivityCoordinator.waitForClear('reconstruction', { timeoutMs: 60000 });
    if (!_waitResult.cleared) {
      console.warn(`CALIB: proceeding without reconstruction clearing after ${_waitResult.waitedMs}ms wait — contention possible`);
    } else if (_waitResult.waitedMs > 0) {
      console.log(`CALIB: waited ${_waitResult.waitedMs}ms for in-flight reconstruction to clear before starting`);
    }
  } catch (e) {
    console.warn('CALIB: StorageActivityCoordinator.waitForClear failed (non-fatal)', e);
  }
  _coordActivityId = StorageActivityCoordinator.begin('calibration', 'preprocessor.worker', { priority: 10 });

  try {
    postMessage({ event: 'progress', jobId, stage: 'calibration_start', frameCount: frames.length });

    // ── Compute frame mean BEFORE CALIB.computeCalibration closes the frames ──
    // CALIB.computeCalibration calls _processFrameGroup which calls frame.close()
    // on every frame. After it returns, all frames in the array are closed.
    // We compute the calibrated reference (temporal mean) here while frames
    // are still valid and open.
    postMessage({ event: 'progress', jobId, stage: 'creating_calibrated_reference' });

    let precomputedMeanBitmap = null;
    {
      const calibW = Math.min(512, resolution.width);
      const calibH = Math.min(512, Math.round(resolution.height * calibW / resolution.width));
      const rSum   = new Float32Array(calibW * calibH);
      const gSum   = new Float32Array(calibW * calibH);
      const bSum   = new Float32Array(calibW * calibH);
      let framesCounted = 0;

      const sumCanvas = new OffscreenCanvas(calibW, calibH);
      const sumCtx    = sumCanvas.getContext('2d', { alpha: false });

      for (const frame of frames) {
        try {
          sumCtx.drawImage(frame, 0, 0, calibW, calibH);
          const px = sumCtx.getImageData(0, 0, calibW, calibH).data;
          for (let i = 0; i < calibW * calibH; i++) {
            rSum[i] += px[i * 4];
            gSum[i] += px[i * 4 + 1];
            bSum[i] += px[i * 4 + 2];
          }
          framesCounted++;
        } catch (e) {
          console.warn('CALIB: skipping frame during mean computation:', e.message);
        }
      }

      if (framesCounted === 0) {
        throw new Error('No frames available for calibrated reference computation');
      }

      const meanData = new Uint8ClampedArray(calibW * calibH * 4);
      let maxLum = 0;
      for (let i = 0; i < calibW * calibH; i++) {
        const r = Math.round(rSum[i] / framesCounted);
        const g = Math.round(gSum[i] / framesCounted);
        const b = Math.round(bSum[i] / framesCounted);
        meanData[i * 4]     = r;
        meanData[i * 4 + 1] = g;
        meanData[i * 4 + 2] = b;
        meanData[i * 4 + 3] = 255;
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum > maxLum) maxLum = lum;
      }

      console.log('CALIB: calibrated reference (frame mean):', {
        framesCounted,
        calibW,
        calibH,
        maxLuminance: maxLum.toFixed(2) + ' / 255',
        verdict: maxLum > 10
          ? '✅ Signal present — depth estimation will work'
          : '⚠️ Low signal — dark scene, histogram stretch will apply'
      });

      sumCtx.putImageData(new ImageData(meanData, calibW, calibH), 0, 0);
      precomputedMeanBitmap = await createImageBitmap(sumCanvas);
    }

    // Now call CALIB.computeCalibration — this will close all frames internally
    const result = await CALIB.computeCalibration({ frames, framesNeeded, resolution });

    // CRITICAL: Clone result bitmaps IMMEDIATELY before they might be closed/transferred
    postMessage({ event: 'progress', jobId, stage: 'cloning_calibration_bitmaps' });
    
    darkBitmapClone = await _safeBitmapClone(result.darkFrame);
    flatBitmapClone = await _safeBitmapClone(result.flatFrame);
    
    if (!darkBitmapClone || !flatBitmapClone) {
      throw new Error('Failed to clone calibration bitmaps - source frames may be closed');
    }

    // calibratedBitmap was precomputed before CALIB.computeCalibration closed the frames
    calibratedBitmap = precomputedMeanBitmap;
    precomputedMeanBitmap = null;

    if (!calibratedBitmap) {
      throw new Error('Failed to create calibrated reference bitmap — precomputation failed');
    }

    postMessage({ event: 'progress', jobId, stage: 'serializing_artifacts' });

    // Generate artifact keys with timestamp
    const ts = Date.now();
    const darkKey = `calib:dark:${ts}`;
    const flatKey = `calib:flat:${ts}`;
    const biasKey = `calib:bias:${ts}`;
    const calibratedKey = `calib:calibrated:${ts}`; // NEW: Required by motion.worker
    const metaKey = `calib:meta:${ts}`;

    // Convert bitmaps to PNG blobs
    const darkCanvas = new OffscreenCanvas(darkBitmapClone.width, darkBitmapClone.height);
    const darkCtx = darkCanvas.getContext('2d', { alpha: false });
    darkCtx.drawImage(darkBitmapClone, 0, 0);
    const darkBlob = await darkCanvas.convertToBlob({ type: 'image/png' });

    const flatCanvas = new OffscreenCanvas(flatBitmapClone.width, flatBitmapClone.height);
    const flatCtx = flatCanvas.getContext('2d', { alpha: false });
    flatCtx.drawImage(flatBitmapClone, 0, 0);
    const flatBlob = await flatCanvas.convertToBlob({ type: 'image/png' });

    // NEW: Calibrated frame -> PNG
    const calibCanvas = new OffscreenCanvas(calibratedBitmap.width, calibratedBitmap.height);
    const calibCtx = calibCanvas.getContext('2d', { alpha: false });
    calibCtx.drawImage(calibratedBitmap, 0, 0);
    const calibratedBlob = await calibCanvas.convertToBlob({ type: 'image/png' });

    // Bias map -> binary blob
    let biasBlob = null;
    if (CALIB.flatBiasNorm) {
      const biasBuffer = CALIB.flatBiasNorm.buffer || new Float32Array(CALIB.flatBiasNorm).buffer;
      biasBlob = new Blob([biasBuffer], { type: 'application/octet-stream' });
    }

    postMessage({ event: 'progress', jobId, stage: 'persisting_artifacts' });

    // Build manifest with calibratedFrameKey (CRITICAL FIELD)
    const manifestData = {
      darkKey,
      flatKey,
      biasKey,
      calibratedFrameKey: calibratedKey, // Required by motion.worker
      resolution: { 
        width: darkBitmapClone.width, 
        height: darkBitmapClone.height 
      },
      frameCount: result.meta?.frameCount || null,
      createdAt: new Date().toISOString(),
      version: 'calib-v1',
      producer: 'preprocessor.worker',
      producerVersion: '1.0'
    };

    // Persist artifacts with retry logic (atomic order: children first, manifest last)
    const artifactsToPersist = [
      { key: darkKey, type: 'calib-dark', blob: darkBlob, 
        meta: { sizeBytes: darkBlob.size, resolution: manifestData.resolution } },
      { key: flatKey, type: 'calib-flat', blob: flatBlob,
        meta: { sizeBytes: flatBlob.size, resolution: manifestData.resolution } },
      { key: biasKey, type: 'calib-bias', blob: biasBlob,
        meta: { sizeBytes: biasBlob.size, dtype: 'float32', 
                description: 'Flat bias normalization map (Float32Array)' } },
      { key: calibratedKey, type: 'calib-calibrated', blob: calibratedBlob,
        meta: { 
          sizeBytes: calibratedBlob.size, 
          resolution: { width: calibCanvas.width, height: calibCanvas.height },
          description: 'Calibrated reference frame (flat with dark/bias corrections)',
          appliedCorrections: { darkSubtraction: true, flatFieldCorrection: true }
        } 
      }
    ];

// ============================================================================
    // ✅ CHANGE: Persist + Pin calibration child artifacts with LONGER TTL
    // ============================================================================
    // EXPLANATION:
    // Calibration artifacts are expensive to compute (5-10 seconds)
    // and shared across many frames (reused until invalidated).
    // 
    // We use CALIBRATION_PIN_TTL_MS (5 minutes) instead of ARTIFACT_PIN_TTL_MS (2 min)
    // because consumers may take longer to discover calibration:
    // 1. MotionDetector must accumulate frames (10-30 frames @ 30fps = 0.3-1 sec)
    // 2. motion.worker must start reconstruction job (queue + worker spawn = 1-2 sec)
    // 3. Reconstruction worker must fetch calibration (storage lookup = 0.1 sec)
    // 
    // This longer TTL prevents premature eviction during discovery phase.
    // Still uses 'soft' pin type → evictable under extreme memory pressure
    
    for (const artifact of artifactsToPersist) {
      if (!artifact.blob) continue;
      
      await _persistAndPin({
        key: artifact.key,
        type: artifact.type,
        blob: artifact.blob,
        meta: artifact.meta,
        createdAt: new Date().toISOString()
      }, {
        owner: 'preprocessor',
        ttlMs: CALIBRATION_PIN_TTL_MS, // 5 minutes (longer for expensive calibration)
        pinType: 'soft' // Still evictable under extreme pressure
      });
    }

    // ============================================================================
    // ✅ CHANGE: Persist + Pin meta with HARD pin (NO auto-unpin)
    // ============================================================================
    // EXPLANATION:
    // calibration.meta is the CANONICAL entry point for calibration data.
    // It's tiny (~1KB) but CRITICAL - without it, all calibration children are orphaned.
    // 
    // We use HARD pin (never evict) + ttlMs=0 (no auto-unpin) because:
    // 1. It's small - doesn't contribute to memory pressure (~1KB)
    // 2. It's long-lived - valid until user invalidates calibration
    // 3. It's critical - losing it orphans expensive child artifacts
    // 4. Manual lifecycle - only unpinned via invalidateCalibration()
    // 
    // HARD PIN BEHAVIOR:
    // - Storage will NEVER evict this artifact, even under extreme memory pressure
    // - Only removable via explicit unpinArtifact(metaKey, {owner: 'preprocessor'})
    // - Ensures calibration metadata survives for entire session
    // 
    // TTL=0 BEHAVIOR:
    // - No worker-level timer scheduled (no auto-unpin)
    // - No storage-level expiration (ttlMs: null)
    // - Pin persists until manual cleanup
    
    await _persistAndPin({
      key: metaKey,
      type: 'calibration.meta',
      data: manifestData,
      meta: {
        producer: 'preprocessor',
        source: 'preprocessor',
        calibVersion: 'calib-v1',
        artifactKeys: [darkKey, flatKey, biasKey, calibratedKey],
        createdAt: new Date().toISOString()
      },
      createdAt: new Date().toISOString()
    }, {
      owner: 'preprocessor',
      pinType: 'hard', // ✅ HARD pin - NEVER evict (even under memory pressure)
      ttlMs: CALIBRATION_META_TTL_MS // ✅ 0 = NO auto-unpin (manual lifecycle only)
    });

    postMessage({ event: 'progress', jobId, stage: 'finalization' });

    // Update CALIB state
    CALIB.metaKey = metaKey;
    CALIB.meta = manifestData;
    CALIB.metaRefCount = 1;
    
    // ============================================================================
    // ✅ NEW: Store child keys for cleanup on invalidate
    // ============================================================================
    // EXPLANATION:
    // When invalidateCalibration() is called, we need to:
    // 1. Cancel TTL timers for all children (prevent orphaned timers)
    // 2. Unpin all children (free memory)
    // 
    // Without this array, we'd have to parse manifestData.artifactKeys every time
    // Storing here makes cleanup code simpler and more robust
    CALIB.childKeys = [darkKey, flatKey, biasKey, calibratedKey];
    
    console.log(`CALIB: Calibration persisted successfully. metaKey=${metaKey}, calibratedFrameKey=${calibratedKey}, childKeys=${CALIB.childKeys.length}`);

    // ── Abort check ──────────────────────────────────────────────────────────
    if (abortedCalibrationJobs.has(jobId)) {
      abortedCalibrationJobs.delete(jobId);
      console.warn(`CALIB: jobId ${jobId} was aborted by caller (timeout) — cleaning up freshly persisted calibration artifacts`);
      try {
        const unpinFn = self.unpinArtifact ||
                       (typeof storageAPI !== 'undefined' && storageAPI.unpinArtifact);
        if (typeof unpinFn === 'function') {
          for (const childKey of CALIB.childKeys) {
            try { await unpinFn(childKey, { owner: 'preprocessor' }); } catch (e) {}
          }
          try { await unpinFn(metaKey, { owner: 'preprocessor' }); } catch (e) {}
        }
      } catch (cleanupErr) {
        console.warn('CALIB: abort cleanup failed (non-fatal):', cleanupErr);
      }
      CALIB.invalidateCalibration();
      CALIB.metaKey = null;
      CALIB.meta = null;
      CALIB.childKeys = null;
      postMessage({ event: 'calibration:aborted', jobId, metaKey });
      return;
    }

    // ── Abort check ──────────────────────────────────────────────────────────
    // If the requesting caller (PreprocessorWorker.requestCalibration) already
    // timed out and gave up on this jobId, don't leave a hard-pinned, never-
    // auto-expiring calibration.meta plus 4 soft-pinned children orphaned.
    if (abortedCalibrationJobs.has(jobId)) {
      abortedCalibrationJobs.delete(jobId);
      console.warn(`CALIB: jobId ${jobId} was aborted by caller (timeout) — cleaning up freshly persisted calibration artifacts`);
      try {
        const unpinFn = self.unpinArtifact ||
                       (typeof storageAPI !== 'undefined' && storageAPI.unpinArtifact);
        if (typeof unpinFn === 'function') {
          for (const childKey of CALIB.childKeys) {
            try { await unpinFn(childKey, { owner: 'preprocessor' }); } catch (e) {}
          }
          try { await unpinFn(metaKey, { owner: 'preprocessor' }); } catch (e) {}
        }
      } catch (cleanupErr) {
        console.warn('CALIB: abort cleanup failed (non-fatal):', cleanupErr);
      }
      CALIB.invalidateCalibration();
      CALIB.metaKey = null;
      CALIB.meta = null;
      CALIB.childKeys = null;
      postMessage({ event: 'calibration:aborted', jobId, metaKey });
      return;
    }

    // Generate release token
    let releaseToken = null;
    try {
      releaseToken = `calrel-${ts}-${Math.random().toString(36).slice(2,9)}`;
      if (!CALIB._releaseTokens) CALIB._releaseTokens = new Map();
      CALIB._releaseTokens.set(releaseToken, metaKey);
      CALIB.metaRefCount = (CALIB.metaRefCount || 0) + 1;
      console.log(`CALIB: releaseToken created: ${releaseToken} (metaRefCount=${CALIB.metaRefCount})`);
    } catch (tokErr) {
      console.warn('handleComputeCalibration: releaseToken generation failed', tokErr);
    }

    // CHANGE: Do NOT transfer bitmaps (avoid ownership issues)
    // Send metadata only - main thread can fetch from storage if needed
    postMessage({
      event: 'calibration:ready',
      jobId,
      metaKey,
      meta: manifestData,
      releaseToken,
      darkFrameInfo: { width: darkBitmapClone.width, height: darkBitmapClone.height },
      flatFrameInfo: { width: flatBitmapClone.width, height: flatBitmapClone.height }
    }); // No transferables

    // Broadcast to other workers (metadata only)
    try {
      if (bc) {
        bc.postMessage({
          event: 'calibration:ready',
          metaKey,
          meta: manifestData,
          releaseToken,
          producer: 'preprocessor',
          source: 'preprocessor',
          timestamp: Date.now()
        });
        console.log('preprocessor.worker: Broadcasted calibration:ready with calibratedFrameKey');
      }
    } catch (bcErr) {
      console.warn('preprocessor.worker: BroadcastChannel failed (non-fatal)', bcErr);
    }

  } catch (err) {
    console.error('preprocessor.worker: calibration computation/persistence failed', err);
    
    postMessage({ 
      event: 'calibration:error', 
      jobId, 
      error: String(err),
      stack: err.stack,
      phase: 'computation_or_persistence'
    });
    
    if (bc) {
      try {
        bc.postMessage({ 
          event: 'calibration:error', 
          jobId, 
          error: String(err), 
          producer: 'preprocessor', 
          source: 'preprocessor',
          timestamp: Date.now() 
        });
      } catch (bcErr) {}
    }
    
  } finally {
    // Calibration attempt is over (success, error, or abort) — clear busy
    // BEFORE draining, so any newly-arriving frames during/after drain are
    // no longer deferred.
    CALIB.busy = false;

    // Release the cross-worker lock — motion.worker (or anything else waiting
    // on StorageActivityCoordinator.waitForClear('calibration')) is unblocked
    // immediately, regardless of how this attempt ended.
    if (_coordActivityId) {
      try { StorageActivityCoordinator.end(_coordActivityId); } catch (e) { /* ignore */ }
      _coordActivityId = null;
    }

    // Cleanup: Close all bitmap clones we created
    try {
      if (darkBitmapClone) darkBitmapClone.close();
      if (flatBitmapClone) flatBitmapClone.close();
      if (calibratedBitmap) calibratedBitmap.close();
    } catch (cleanupErr) {
      console.warn('Bitmap cleanup error (non-fatal):', cleanupErr);
    }

    // Always drain deferred frames here — this runs on success, on any thrown
    // error, and after an abort — so frame ingestion never stays paused longer
    // than the calibration attempt actually takes.
    try {
      _drainCalibrationDeferredFrames();
    } catch (drainErr) {
      console.warn('preprocessor.worker: failed to drain calibration-deferred frames', drainErr);
    }
  }
}

// Worker message handler
self.onmessage = async (ev) => {
  const msg = ev.data || {};
  
  try {

    if (msg.op === '__request_diagnostics') {
      try {
        postMessage({
          event: 'worker:diag',
          ts: msg.ts || Date.now(),
          storageReady: !!storageReady,
          initializationStarted: !!initializationStarted,
          pendingFrames: pendingFrames ? pendingFrames.length : 0,
          queuedFrameSamples: pendingFrames.slice(0,3).map(p => ({ jobId: p.jobId, meta: p.meta })),
          CALIB: {
            isCalibrated: !!CALIB.isCalibrated,
            metaKey: CALIB.metaKey || null,
            metaRefCount: CALIB.metaRefCount || 0,
            busy: !!CALIB.busy
          },
          env: {
            hasOffscreenCanvas: typeof OffscreenCanvas !== 'undefined',
            hasCreateImageBitmap: typeof createImageBitmap !== 'undefined'
          }
        });
      } catch (e) {
        postMessage({ event: 'worker:diag', error: String(e), ts: Date.now() });
      }
      return;
    }

    if (msg.op === 'preprocess') {
      const { jobId, meta = {}, options = {} } = msg;
      const imageBitmap = msg.imageBitmap || ev.data.imageBitmap || null;
      
      if (!imageBitmap) {
        postMessage({ event: 'artifact:error', jobId, error: 'No ImageBitmap received' });
        return;
      }

      if (!storageReady) {
        pendingFrames.push({ jobId, meta, imageBitmap, options });
        console.debug('preprocessor.worker: storage not ready, queuing frame', jobId);
        return;
      }

      // Defer ordinary frame persistence while a calibration computation is
      // in flight, so calibration's own sequential IndexedDB writes aren't
      // starved by the continuous stream of per-frame thumbnail/phash/manifest
      // transactions on the same object stores. ALSO defer while a
      // reconstruction job is active in motion.worker — confirmed via
      // telemetry that a single calib:calibrated blob read there took ~50s
      // with the evictor/reaper both already paused, meaning the remaining
      // competing writes were ordinary steady-state frame ingestion here
      // (~90 write transactions/sec at 30fps), which StorageActivityCoordinator
      // was not previously asked to account for.
      let _pauseForCalib = true;
      try {
        _pauseForCalib = featureFlags.getFlag('pauseFrameIngestDuringCalibration') ?? true;
      } catch (e) { /* featureFlags unavailable — default to pausing (safer) */ }

      const _reconstructionActive = StorageActivityCoordinator.isActive('reconstruction');
      const _shouldDefer = (_pauseForCalib && CALIB.busy) || _reconstructionActive;

      if (_shouldDefer) {
        let _maxQueue = 60;
        try {
          _maxQueue = featureFlags.getFlag('calibrationDeferredFrameQueueMaxSize') ?? 60;
        } catch (e) { /* use default */ }

        if (calibrationDeferredFrames.length >= _maxQueue) {
          const victim = calibrationDeferredFrames.shift();
          try { victim.imageBitmap.close(); } catch (e) {}
          console.warn('preprocessor.worker: deferred frame queue full — dropped oldest frame', victim.jobId);
        }

        calibrationDeferredFrames.push({ jobId, meta, imageBitmap, options });
        console.debug(
          `preprocessor.worker: deferring frame ${jobId} ` +
          `(calibBusy=${CALIB.busy}, reconstructionActive=${_reconstructionActive})`
        );
        return;
      }
      
      await processFrame({ jobId, meta, imageBitmap, options });
      
    } else if (msg.op === 'reprocess') {
      const { jobId, key, actions, priority } = msg;
      if (!storageReady) {
        postMessage({ event: 'reprocess:error', jobId, key, error: 'Storage not ready' });
        return;
      }
      await handleReprocess({ jobId, key, actions, priority });
      
    } else if (msg.op === 'computeCalibration') {
      const { jobId, frames, framesNeeded, resolution } = msg;
      await handleComputeCalibration({ jobId, frames, framesNeeded, resolution });
      
    } else if (msg.op === 'abortCalibration') {
      // Best-effort abort: the in-flight computeCalibration async function cannot
      // be forcibly interrupted, but recording the jobId here means that when it
      // does finish, handleComputeCalibration immediately unpins/invalidates
      // whatever it just persisted instead of leaving it orphaned.
      const { jobId: abortJobId } = msg;
      if (abortJobId) {
        abortedCalibrationJobs.add(abortJobId);
        console.warn(`preprocessor.worker: marked jobId ${abortJobId} as aborted`);
      }
      
    } else if (msg.op === 'fetchCalibration') {
      try {
        const metaKey = msg.metaKey || CALIB.metaKey;
        if (!metaKey) {
          throw new Error('No metaKey specified and no CALIB.metaKey available');
        }
        const fetched = await CALIB.fetchPersisted(metaKey);
        const { darkBitmap, flatBitmap, meta, metaKey: canonicalKey, releaseToken } = fetched;
        postMessage({
          event: 'calibration:fetched',
          jobId: msg.jobId || null,
          metaKey: canonicalKey,
          meta,
          darkFrame: darkBitmap,
          flatFrame: flatBitmap,
          releaseToken
        }, [darkBitmap, flatBitmap]);

        try {
          if (bc) {
            bc.postMessage({
              event: 'calibration:fetched',
              metaKey: canonicalKey,
              meta,
              releaseToken,
              producer: 'preprocessor',
              source: 'preprocessor',
              timestamp: Date.now()
            });
            console.log('preprocessor.worker: broadcasted calibration:fetched', canonicalKey);
          }
        } catch (bcErr) {
          console.warn('preprocessor.worker: failed to broadcast calibration:fetched', bcErr);
        }

      } catch (fErr) {
        console.error('preprocessor.worker: fetchCalibration failed', fErr);
        postMessage({
          event: 'calibration:fetch_error',
          jobId: msg.jobId || null,
          metaKey: msg.metaKey || null,
          error: String(fErr)
        });
        if (bc) {
          try {
            bc.postMessage({
              event: 'calibration:fetch_error',
              metaKey: msg.metaKey || null,
              error: String(fErr),
              producer: 'preprocessor',
              source: 'preprocessor',
              timestamp: Date.now()
            });
          } catch (bcErr) {
            console.warn('preprocessor.worker: failed to broadcast calibration:fetch_error', bcErr);
          }
        }
      }
      
    } else if (msg.op === 'releaseCalibration') {
      try {
        const token = msg.token;
        if (!token) {
          postMessage({ event: 'calibration:release_error', token: null, error: 'missing_token' });
          return;
        }
        if (!CALIB._releaseTokens || !CALIB._releaseTokens.has(token)) {
          console.warn('preprocessor.worker: releaseCalibration received unknown token', token);
          postMessage({ event: 'calibration:release_error', token, error: 'invalid_token' });
          return;
        }

        const key = CALIB._releaseTokens.get(token);
        CALIB._releaseTokens.delete(token);
        CALIB.metaRefCount = Math.max(0, (CALIB.metaRefCount || 0) - 1);
        console.log(`CALIB: release token ${token} for ${key}, metaRefCount -> ${CALIB.metaRefCount}`);

        if (CALIB.metaRefCount === 0 && CALIB.pendingUnpinKey) {
          const toUnpin = CALIB.pendingUnpinKey;
          CALIB.pendingUnpinKey = null;
          try {
            if (typeof self.unpinArtifact === 'function') {
              await self.unpinArtifact(toUnpin);
              console.log(`CALIB: Unpinned pending key ${toUnpin} after release`);
              if (bc) {
                try {
                  bc.postMessage({ event: 'calibration:unpin', metaKey: toUnpin, producer: 'preprocessor', source: 'preprocessor', timestamp: Date.now() });
                } catch (bcErr) {
                  console.warn('preprocessor.worker: broadcast calibration:unpin failed', bcErr);
                }
              }
            } else {
              console.warn('CALIB: unpinArtifact not available when attempting deferred unpin');
            }
          } catch (uErr) {
            console.warn('CALIB: deferred unpin failed', uErr);
          }
        }

        postMessage({ event: 'calibration:released', token, metaKey: key });

        try {
          if (bc) {
            bc.postMessage({ event: 'calibration:released', token, metaKey: key, producer: 'preprocessor', source: 'preprocessor', timestamp: Date.now() });
            console.log('preprocessor.worker: broadcasted calibration:released', key);
          }
        } catch (bcErr) {
          console.warn('preprocessor.worker: failed to broadcast calibration:released', bcErr);
        }

      } catch (err) {
        console.error('preprocessor.worker: releaseCalibration handler failed', err);
        postMessage({ event: 'calibration:release_error', token: msg.token, error: String(err) });
        if (bc) {
          try {
            bc.postMessage({ event: 'calibration:release_error', token: msg.token, error: String(err), producer: 'preprocessor', source: 'preprocessor', timestamp: Date.now() });
          } catch (bcErr) {
            console.warn('preprocessor.worker: failed to broadcast calibration:release_error', bcErr);
          }
        }
      }

    } else if (msg.op === 'invalidateCalibration') {
      const oldMetaKey = CALIB.metaKey;
      const oldMeta = CALIB.meta;
      const childKeys = CALIB.childKeys || []; // Use stored child keys
      
      // ============================================================================
      // ✅ FIX: Cancel TTL for meta AND all children
      // ============================================================================
      // EXPLANATION: Calibration creates 5 artifacts:
      // - calibration.meta (no TTL - hard pin, but still track for consistency)
      // - calib-dark, calib-flat, calib-bias, calib-calibrated (5min TTL each)
      // 
      // CRITICAL: Must cancel timers for ALL to prevent orphaned unpins
      
      if (oldMetaKey) {
        _cancelTTL(oldMetaKey); // Cancel meta timer (if any - shouldn't exist for hard pins)
        
        // Cancel child timers using stored keys
        if (childKeys.length > 0) {
          for (const childKey of childKeys) {
            _cancelTTL(childKey);
            console.log(`[PIN] 🗑️  Cancelled TTL for calibration child: ${childKey.slice(0, 20)}...`);
          }
        } else if (oldMeta && Array.isArray(oldMeta.artifactKeys)) {
          // Fallback: use meta.artifactKeys if childKeys not stored
          for (const childKey of oldMeta.artifactKeys) {
            _cancelTTL(childKey);
            console.log(`[PIN] 🗑️  Cancelled TTL for calibration child (fallback): ${childKey.slice(0, 20)}...`);
          }
        }
        
        // ============================================================================
        // Unpin preprocessor ownership (deferred if in-flight usage)
        // ============================================================================
        if (CALIB.metaRefCount && CALIB.metaRefCount > 0) {
          CALIB.pendingUnpinKey = oldMetaKey;
          console.log(`invalidateCalibration: deferring unpin of ${oldMetaKey.slice(0, 20)}... until metaRefCount reaches 0 (currently ${CALIB.metaRefCount})`);
        } else {
          // Unpin meta immediately
          try {
            const unpinFn = self.unpinArtifact || 
                           (typeof storageAPI !== 'undefined' && storageAPI.unpinArtifact);
            
            if (typeof unpinFn === 'function') {
              await unpinFn(oldMetaKey, { owner: 'preprocessor' });
              console.log(`[PIN] ✓ Unpinned calibration meta ${oldMetaKey.slice(0, 20)}... (invalidated)`);
            }
          } catch (unpErr) {
            console.warn('invalidateCalibration: meta unpin failed (may already be unpinned)', unpErr);
          }
          
          // Unpin children (consumers may still hold pins - only removes preprocessor pin)
          const unpinFn = self.unpinArtifact || 
                         (typeof storageAPI !== 'undefined' && storageAPI.unpinArtifact);
          
          if (typeof unpinFn === 'function') {
            const keysToUnpin = childKeys.length > 0 
              ? childKeys 
              : (oldMeta && Array.isArray(oldMeta.artifactKeys) ? oldMeta.artifactKeys : []);
            
            for (const childKey of keysToUnpin) {
              try {
                await unpinFn(childKey, { owner: 'preprocessor' });
                console.log(`[PIN] ✓ Unpinned calibration child ${childKey.slice(0, 20)}...`);
              } catch (childErr) {
                console.warn(`invalidateCalibration: child unpin failed for ${childKey.slice(0, 20)}...`, childErr);
              }
            }
          }
          
          // Broadcast unpin event
          if (bc) {
            try {
              bc.postMessage({ 
                event: 'calibration:invalidated', 
                metaKey: oldMetaKey, 
                childKeys: childKeys.length > 0 ? childKeys : (oldMeta?.artifactKeys || []),
                producer: 'preprocessor', 
                source: 'preprocessor',
                timestamp: Date.now() 
              });
            } catch (bcErr) {
              console.warn('preprocessor.worker: broadcast calibration:invalidated failed', bcErr);
            }
          }
        }
      }

      CALIB.invalidateCalibration();

      CALIB.metaKey = null;
      CALIB.meta = null;
      CALIB.childKeys = null; // ✅ Clear stored child keys

      postMessage({ 
        event: 'calibration:invalidated',
        timestamp: Date.now()
      });

      try {
        if (bc) {
          bc.postMessage({ event: 'calibration:invalidated', metaKey: oldMetaKey || null, producer: 'preprocessor', source: 'preprocessor', timestamp: Date.now() });
          console.log('preprocessor.worker: broadcasted calibration:invalidated', oldMetaKey);
        }
      } catch (bcErr) {
        console.warn('preprocessor.worker: failed to broadcast calibration:invalidated', bcErr);
      }

      
    } else if (msg.op === 'getCalibrationMeta') {
      postMessage({ 
        event: 'calibration:meta',
        meta: CALIB.getCalibrationMeta()
      });
      
    } else if (msg.op === 'shutdown') {
      // Clean up queued frames
      pendingFrames.forEach(({ imageBitmap }) => {
        try { imageBitmap.close(); } catch (e) {}
      });
      pendingFrames.length = 0;
      
      // ============================================================================
      // ✅ FIX: Clear all TTL timers before shutdown
      // ============================================================================
      // EXPLANATION: Worker shutdown doesn't automatically clear setTimeout timers
      // If worker stays alive (rare but possible in some environments), timers would leak  
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
      
      // Invalidate calibration (includes its own timer cleanup now from Change 14)
      CALIB.invalidateCalibration();
      
      try { if (bc) bc.close(); } catch (e) {}
      
      postMessage({ event: 'worker:shutdown' });
      close();
      
    } else {
      console.debug('preprocessor.worker: unknown op', msg.op);
    }
  } catch (err) {
    console.error('preprocessor.worker: onmessage error', err);
    postMessage({
      event: 'worker:error',
      error: String(err),
      stack: err.stack,
      phase: 'message_handling'
    });
    if (bc) {
      try {
        bc.postMessage({ event: 'worker:error', error: String(err), stack: err.stack, producer: 'preprocessor', source: 'preprocessor', timestamp: Date.now() });
      } catch (bcErr) {
        console.warn('preprocessor.worker: broadcast worker:error failed', bcErr);
      }
    }
  }
};