// /src/js/core/motion.worker.js
// ES module worker: computes depth/normal/flux artifacts using depthTrianglePreprocessor,
// overhangPreprocessor, and MultiSampler, then persists to storage.
// Listens on BroadcastChannel 'motion-painter-store' for flags and calibration events.
// Accepts postMessage commands for targeted reconstruction jobs (RECONSTRUCT_META).
//
// NOTE: uses absolute imports so it resolves regardless of where the worker is instantiated.

import MultiSampler from '/src/js/sampler/MultiSampler.js';

const BC_CHANNEL = 'motion-painter-store';
const bc = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel(BC_CHANNEL) : null;

// ---------------------------------------------------------------------------
// Message ID Generator (for deduplication in main thread)
// ---------------------------------------------------------------------------

const generateMsgId = () => `motion.worker:${Date.now()}:${Math.random().toString(36).slice(2,8)}`;

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

// ⭐ NEW: Cache THREE.js module to avoid re-importing
let _threeModule = null;  // Cache for THREE.js module

// Preprocessor instances (created per-frame as needed)
let _trianglePreprocessor = null;
let _overhangPreprocessor = null;

// GPU resource tracking for cleanup
const _gpuResources = {
  textures: new Set(),
  renderTargets: new Set(),
  materials: new Set()
};

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

// ============================================================================
// FIX 2: Improved _persistArtifact with Better Error Handling
// ============================================================================

/**
 * _persistArtifact(storageWrapper, keyOrNull, blobOrBody, meta)
 * Persist an artifact using the storage adapter with automatic key generation support
 * Returns {ok: boolean, metaKey?: string, error?: string}
 *
 * ✅ FIXES:
 * - Explicit TypedArray detection and conversion to Blob
 * - Clear return value validation
 * - Better error messages
 */
async function _persistArtifact(storageWrapper, keyOrNull, blobOrBody, meta = {}) {
  if (!storageWrapper) throw new Error('Storage wrapper required');

  console.log('[_persistArtifact] Starting persistence:', {
    type: meta.type,
    hasKey: !!keyOrNull,
    bodyType: blobOrBody?.constructor?.name,
    isTypedArray: ArrayBuffer.isView(blobOrBody),
    wrapperHasPut: !!storageWrapper.putArtifact
  });

  // Extract type from meta and place it at top-level
  const artifactType = meta.type || 'artifact';
  const cleanMeta = { ...meta };
  delete cleanMeta.type;

  // Build the complete artifact payload
  const payload = {
    key: keyOrNull || undefined,
    type: artifactType,
    blob: null,
    data: null,
    meta: cleanMeta,
    createdAt: new Date().toISOString()
  };

  try {
    // ✅ FIX: Explicit TypedArray handling FIRST
    if (ArrayBuffer.isView(blobOrBody) && !(blobOrBody instanceof DataView)) {
      // TypedArray → Convert to Blob for efficient storage
      const blob = new Blob([blobOrBody.buffer.slice(blobOrBody.byteOffset, blobOrBody.byteOffset + blobOrBody.byteLength)]);
      payload.blob = blob;
      
      // Store metadata about the typed array for reconstruction
      payload.meta.typedArrayType = blobOrBody.constructor.name;
      payload.meta.typedArrayLength = blobOrBody.length;
      payload.meta.typedArrayByteLength = blobOrBody.byteLength;
      
      console.log('[_persistArtifact] Converted TypedArray to blob:', {
        type: blobOrBody.constructor.name,
        length: blobOrBody.length,
        blobSize: blob.size
      });
    } 
    else if (blobOrBody instanceof Blob) {
      payload.blob = blobOrBody;
      console.log('[_persistArtifact] Using blob field, size:', blobOrBody.size);
    } 
    else if (blobOrBody && typeof blobOrBody === 'object') {
      // Plain object or structured data
      payload.data = blobOrBody;
      const dataKeys = Object.keys(blobOrBody);
      console.log('[_persistArtifact] Using data field, keys:', dataKeys.slice(0, 5));
    } 
    else {
      payload.data = blobOrBody;
      console.log('[_persistArtifact] Using data field (primitive):', typeof blobOrBody);
    }

    // ✅ FIX: Use putArtifact (which should resolve to putInboundArtifact)
    let result = null;
    
    if (typeof storageWrapper.putArtifact === 'function') {
      console.log('[_persistArtifact] Calling storageWrapper.putArtifact');
      result = await _retryable(() => storageWrapper.putArtifact(payload));
      console.log('[_persistArtifact] putArtifact returned:', result);
    } else {
      throw new Error('No putArtifact method on storageWrapper');
    }

    // ✅ FIX: Validate return value
    if (!result) {
      throw new Error('Storage returned null/undefined result');
    }

    if (!result.ok) {
      throw new Error(`Storage returned ok: false, reason: ${result.reason || 'unknown'}`);
    }

    if (!result.metaKey) {
      throw new Error('Storage did not return metaKey');
    }

    console.log('[_persistArtifact] ✅ SUCCESS:', {
      type: artifactType,
      metaKey: result.metaKey,
      reused: result.reused || false
    });

    return result;

  } catch (err) {
    console.error('[_persistArtifact] ❌ FAILED:', {
      type: meta.type,
      error: err.message,
      stack: err.stack
    });
    throw err;
  }
}
// ---------------------------------------------------------------------------
// Flags application helper
// ---------------------------------------------------------------------------

function _applyFlagsSnapshot(flagsPayload = {}) {
  try {
    if (flagsPayload && flagsPayload.flags) {
      _flags = Object.assign({}, _flags, flagsPayload.flags);
    } else if (typeof flagsPayload === 'object' && Object.keys(flagsPayload).length > 0 && !flagsPayload.flags) {
      _flags = Object.assign({}, _flags, flagsPayload);
    }
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

// motion.worker.js - FIXED THREE.js initialization

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
    // THREE.js's WebGLRenderer.setSize() tries to access canvas.style
    // which doesn't exist on OffscreenCanvas
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
    // Try WebGL2 first, fallback to WebGL1
    let gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false  // Allow software rendering if needed
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
        // Don't let THREE.js try to manage the canvas size
        // We'll handle it manually
      });
      
      console.log('motion.worker: THREE.WebGLRenderer created');
      
      // CRITICAL: Set size AFTER renderer creation
      // Use the manual setSize that doesn't touch canvas.style
      try {
        _threeRenderer.setSize(width, height, false);  // false = don't update style
        console.log('motion.worker: Renderer size set to', width, 'x', height);
      } catch (sizeErr) {
        console.warn('motion.worker: setSize failed, trying manual approach', sizeErr);
        
        // Fallback: Set size properties directly
        _threeRenderer.domElement = canvas;
        if (_threeRenderer.domElement) {
          _threeRenderer.domElement.width = width;
          _threeRenderer.domElement.height = height;
        }
        
        // Update THREE.js internal state
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

      // Try to add event listeners (may not work on all OffscreenCanvas implementations)
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
    console.log('  - Context exists:', !!(_threeRenderer && _threeRenderer.getContext()));
    
    if (_threeRenderer && _threeRenderer.domElement) {
      console.log('  - Canvas size:', _threeRenderer.domElement.width, 'x', _threeRenderer.domElement.height);
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
    
    _threeInitialized = true; // Mark attempted
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
  // Dispose triangle preprocessor
  if (_trianglePreprocessor && typeof _trianglePreprocessor.dispose === 'function') {
    try {
      _trianglePreprocessor.dispose();
    } catch (e) {
      console.warn('motion.worker: trianglePreprocessor.dispose error', e);
    }
  }
  _trianglePreprocessor = null;

  // Dispose overhang preprocessor
  if (_overhangPreprocessor && typeof _overhangPreprocessor.dispose === 'function') {
    try {
      _overhangPreprocessor.dispose();
    } catch (e) {
      console.warn('motion.worker: overhangPreprocessor.dispose error', e);
    }
  }
  _overhangPreprocessor = null;

  // Dispose tracked GPU resources
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

    // Simple luminance-based depth (inverted)
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    depths[i] = 0.1 + (1.0 - lum / 255.0) * 2.0;

    // Default normal pointing up
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

// ---------------------------------------------------------------------------
// Heartbeat helpers (ensure reconStatus isn't mistaken as dead)
// ---------------------------------------------------------------------------

async function _startHeartbeat(storageWrapper, metaKey, jobId) {
  if (!storageWrapper || !storageWrapper.markReconHeartbeat) return null;
  const interval = Number(_flags.heartbeatIntervalMs) || DEFAULTS.heartbeatIntervalMs;
  const timer = setInterval(async () => {
    try {
      await storageWrapper.markReconHeartbeat(metaKey, jobId).catch(() => null);
    } catch (e) {
      // ignore heartbeat failures (non-fatal)
      // but log to metrics
      _metrics.lastError = String(e);
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
// Main Depth/Normal/Flux Computation Pipeline
// ---------------------------------------------------------------------------

/**
 * _computeDepthNormalsFlux(frameBitmap, calibData, options)
 * Core pipeline: Triangle → Overhang → Package results
 *
 * @param {ImageBitmap} frameBitmap - Source frame
 * @param {Object} calibData - Optional { dark, flat, bias }
 * @param {Object} options - { resolution, quality, priority }
 * @returns {Promise<{ depthMap, normalMap, fluxData, telemetry, selectorArtifact }>}
 */
async function _computeDepthNormalsFlux(frameBitmap, calibData, options = {}) {
  const startTime = performance.now();
  const telemetry = {
    stages: {},
    errors: [],
    success: false
  };

  let depthMap = null;
  let normalMap = null;
  let fluxData = null;
  let selectorArtifact = null;

  try {
    const resolution = options.resolution || DEFAULTS.defaultResolutions.normal;
    const gridSize = resolution;

    // Memory estimation guard
    const estimateMemoryBytes = (res) => {
      const pixels = res * res;
      const bytesPerPixel = 4; // RGBA texture (heuristic)
      const extraBuffers = 4;  // rough count
      return pixels * bytesPerPixel * extraBuffers;
    };

    const estimatedBytes = estimateMemoryBytes(gridSize);
    const maxBytes = Number(_flags.maxWorkerMemoryBytes) || DEFAULTS.maxWorkerMemoryBytes;
    if (estimatedBytes > maxBytes) {
      telemetry.errors.push(`memoryEstimate ${estimatedBytes} > max ${maxBytes}, reducing resolution`);
      // downgrade resolution conservatively
      if (gridSize > DEFAULTS.defaultResolutions.low) {
        const reduced = Math.max(DEFAULTS.defaultResolutions.low, Math.floor(gridSize / 2));
        options.resolution = reduced;
        return _computeDepthNormalsFlux(frameBitmap, calibData, options); // retry with reduced resolution
      } else {
        // fall back to CPU heuristic if still too large
        return await _fallbackDepthEstimation(frameBitmap, resolution);
      }
    }

    // ========================================
    // STAGE 1: Ensure THREE.js Renderer Ready
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
    // STAGE 2: Load THREE.js and Create Textures
    // ========================================
    telemetry.stages.texture_load_start = performance.now();

    // CRITICAL FIX: Use cached THREE module instead of re-importing
    const THREE = await _loadThreeModule();

    // Create texture from frameBitmap
    const texture = _trackResource(new THREE.Texture(frameBitmap), 'textures');
    texture.needsUpdate = true;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;

    // Create placeholder textures for bump/normal/albedo
    // TODO: In production, extract these from calibration data or multi-view analysis
    const bumpTexture = _trackResource(texture.clone(), 'textures');
    const normalTexture = _trackResource(texture.clone(), 'textures');
    const albedoTexture = _trackResource(texture.clone(), 'textures');

    const textures = {
      diffuse: texture,
      bump: bumpTexture,
      normal: normalTexture,
      albedo: albedoTexture,
      bumpScale: 1.0,
      normalScale: 1.0,
      albedoScale: 1.0
    };

    telemetry.stages.texture_load_end = performance.now();
    telemetry.stages.texture_load_ms = telemetry.stages.texture_load_end - telemetry.stages.texture_load_start;

    // ========================================
    // STAGE 3: Generate UV Grid (Positions/Normals)
    // ========================================
    telemetry.stages.grid_gen_start = performance.now();

    const count = gridSize * gridSize;
    const positions = new Float32Array(count * 2);
    const normals2D = new Float32Array(count * 2);

    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        const i = y * gridSize + x;
        positions[i * 2] = x / (gridSize - 1); // u
        positions[i * 2 + 1] = y / (gridSize - 1); // v
        normals2D[i * 2] = 0; // placeholder nx
        normals2D[i * 2 + 1] = 1; // placeholder ny (up)
      }
    }

    telemetry.stages.grid_gen_end = performance.now();
    telemetry.stages.grid_gen_ms = telemetry.stages.grid_gen_end - telemetry.stages.grid_gen_start;

    // ========================================
    // STAGE 4: Run Triangle Preprocessor
    // ========================================
    telemetry.stages.triangle_start = performance.now();

    let triangleResult = null;
    try {
      const { createDepthTrianglePreprocessor } = await import('./depthTrianglePreprocessor.js');

      _trianglePreprocessor = createDepthTrianglePreprocessor({
        THREE: THREE,
        renderer: renderer,
        bakeSize: Math.max(256, Math.min(1024, Math.floor(gridSize * 4))), // bake size heuristic
        gridSize: gridSize,
        positions: positions,
        normals: normals2D,
        textures: textures,
        kL: _flags.depthKL || 1.0,
        kD: _flags.depthKD || 0.5,
        baseDepth: _flags.depthBase || 0.1,
        depthScale: _flags.depthScale || 2.0
      });

      // Initialize GPU targets
      const initErr = _trianglePreprocessor.init();
      if (initErr) {
        throw new Error(`Triangle preprocessor init failed: ${initErr}`);
      }

      // Compute depths/tilts/winding
      triangleResult = _trianglePreprocessor.compute();

      if (!triangleResult || !triangleResult.depths) {
        throw new Error('Triangle preprocessor returned invalid result');
      }

      telemetry.stages.triangle_end = performance.now();
      telemetry.stages.triangle_ms = telemetry.stages.triangle_end - telemetry.stages.triangle_start;
      telemetry.stages.triangle_samples = triangleResult.depths.length;

    } catch (triangleErr) {
      const se = safeErrSummary(triangleErr);
      console.error('motion.worker: Triangle preprocessor failed', triangleErr);
      telemetry.errors.push(`triangle: ${se.message}`);
      throw triangleErr; // Fatal - depth/normals required
    }

    // ========================================
    // STAGE 5: Convert Triangle Output to 3D Normals
    // ========================================
    telemetry.stages.normal_convert_start = performance.now();

    const depths = triangleResult.depths;
    const tilts = triangleResult.tilts;
    const windingNumbers = triangleResult.windingNumbers;

    // Convert 2D tilts to 3D normals
    const normals3D = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const theta = tilts[i];
      const nx = Math.cos(theta);
      const ny = Math.sin(theta);
      const nz = 0.5; // Conservative Z component

      // Normalize
      const len = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1.0;
      normals3D[i*3] = nx / len;
      normals3D[i*3 + 1] = ny / len;
      normals3D[i*3 + 2] = nz / len;
    }

    telemetry.stages.normal_convert_end = performance.now();
    telemetry.stages.normal_convert_ms = telemetry.stages.normal_convert_end - telemetry.stages.normal_convert_start;

    // ========================================
    // STAGE 6: Run Overhang Preprocessor (Optional)
    // ========================================
    telemetry.stages.overhang_start = performance.now();

    let overhangResult = null;
    const enableOverhang = _flags.enableOverhang !== false; // Default true

    if (enableOverhang) {
      try {
        // Lazy-create overhang preprocessor if not exists
        if (!_overhangPreprocessor) {
          const { createOverhangPreprocessor } = await import('./overhangPreprocessor.js');
          _overhangPreprocessor = createOverhangPreprocessor({
            gridW: gridSize,
            gridH: gridSize,
            gravity: _flags.gravity || [0, -1, 0],
            cosineThreshold: _flags.overhangCosineThresh || 0.7,
            windingThreshold: _flags.overhangWindingThresh || 0.25,
            minGroupSize: _flags.overhangMinGroupSize || 3
          });
        }

        overhangResult = _overhangPreprocessor.run({
          depths: depths,
          normals: normals3D,
          windingNumbers: windingNumbers,
          positions: positions
        });

        telemetry.stages.overhang_end = performance.now();
        telemetry.stages.overhang_ms = telemetry.stages.overhang_end - telemetry.stages.overhang_start;
        telemetry.stages.overhang_constraints = overhangResult.diagnostics.constraintCount;
        telemetry.stages.overhang_socs = overhangResult.diagnostics.socCount;

      } catch (overhangErr) {
        // NON-FATAL: Overhang is optional enhancement
        const se = safeErrSummary(overhangErr);
        console.warn('motion.worker: Overhang preprocessor failed', overhangErr);
        telemetry.errors.push(`overhang: ${se.message}`);
        overhangResult = null;
      }
    }

    // ========================================
    // STAGE 7: Build selector (BSS seed) if enabled
    // ========================================
    try {
      if (_flags.bssPersistSelector) {
        // Build a simple selector seeded by winding magnitude + optional overhang importance
        const selector = new Float32Array(count);
        for (let i = 0; i < count; i++) {
          const w = Math.abs(windingNumbers[i] || 0);
          let score = w;
          // If overhang flagged for this index, bump score (we don't have per-index overhang mask; use group coverage)
          // fallback: use local gradient magnitude as small heuristic
          score += Math.abs(triangleResult.tilts[i] || 0) * 0.1;
          selector[i] = score;
        }
        // Normalize to [0,1]
        let maxS = 0;
        for (let i = 0; i < count; i++) if (selector[i] > maxS) maxS = selector[i];
        if (maxS > 0) for (let i = 0; i < count; i++) selector[i] = selector[i] / maxS;

        // Persist selector artifact (compact)
        selectorArtifact = {
          pointsCount: count,
          selector: Array.from(selector), // can be trimmed later to cap size
          gateParams: {
            eta_pull: _flags.bssPullEta || 0.1,
            eta_push: _flags.bssPushEta || 0.05,
            gamma: _flags.bssGamma || 1.02,
            iters: _flags.bssIters || 8
          }
        };
        // Not persisted here; caller can persist later (we persist higher-level telemetry artifact below)
      }
    } catch (selErr) {
      const se = safeErrSummary(selErr);
      console.warn('motion.worker: selector build failed', selErr);
      telemetry.errors.push(`selector: ${se.message}`);
      selectorArtifact = null;
    }

    // ========================================
    // STAGE 8: Package Results
    // ========================================

    const depthStats = typedMinMax(depths);

    depthMap = {
      resolution: gridSize,
      data: depths, // Float32Array
      min: depthStats.min,
      max: depthStats.max,
      encoding: 'float32',
      stats: triangleResult.stats || {}
    };

    normalMap = {
      resolution: gridSize,
      data: normals3D, // Float32Array
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

    // Attempt graceful fallback (your original logic)
    try {
      return await _fallbackDepthEstimation(frameBitmap, options.resolution || DEFAULTS.defaultResolutions.normal);
    } catch (fallbackErr) {
      const fallbackSe = safeErrSummary(fallbackErr);
      console.warn('motion.worker: fallbackDepthEstimation also failed', fallbackSe.message);

      // Total failure - return mock data
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
    // ========================================
    // STAGE 9: Cleanup GPU Resources
    // ========================================
    telemetry.stages.cleanup_start = performance.now();
    _cleanupAfterReconstruction();
    telemetry.stages.cleanup_end = performance.now();
    telemetry.stages.cleanup_ms = telemetry.stages.cleanup_end - telemetry.stages.cleanup_start;
  }
  // Final telemetry
  const endTime = performance.now();
  telemetry.total_ms = endTime - startTime;
  return { depthMap, normalMap, fluxData, telemetry, selectorArtifact: (selectorArtifact || null) };
}

// ---------------------------------------------------------------------------
// RECONSTRUCT_META Handler (Main Entry Point)
// ---------------------------------------------------------------------------

/**
 * _handleReconstructMeta({ jobId, metaKey, options })
 * Full reconstruction pipeline:
 * 1. Check reconStatus (deduplication)
 * 2. Load manifest + frame + calibration
 * 3. Compute depth/normals/flux
 * 4. Persist derived artifacts
 * 5. Mark reconStatus done
 * 6. Broadcast RECON_DONE
 */
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

    // Start heartbeat to indicate liveness (if storage supports it)
    try {
      heartbeatTimer = await _startHeartbeat(storageWrapper, metaKey, jobId);
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

    // IMPORTANT:
    // Request denormalized artifact so HFH typed arrays (annular, annularCounts)
    // are rehydrated as Float32Array / Int32Array rather than JSON arrays.
    manifest = await storageWrapper.getArtifact(metaKey, { denormalize: true });
    if (!manifest || !manifest.data) {
      throw new Error(`Manifest not found: ${metaKey}`);
    }

    // Preserve camera container metadata if present (from FrameEvictionHook / MediaInput)
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
        const calibMeta = await storageWrapper.getArtifact(manifest.data.calibrationKey);
        if (calibMeta && calibMeta.data) {
          const darkArt = calibMeta.data.darkKey ? await storageWrapper.getArtifact(calibMeta.data.darkKey) : null;
          const flatArt = calibMeta.data.flatKey ? await storageWrapper.getArtifact(calibMeta.data.flatKey) : null;
          const biasArt = calibMeta.data.biasKey ? await storageWrapper.getArtifact(calibMeta.data.biasKey) : null;

          calibData = {
            dark: darkArt?.blob ? await createImageBitmap(darkArt.blob) : null,
            flat: flatArt?.blob ? await createImageBitmap(flatArt.blob) : null,
            bias: biasArt?.blob ? new Float32Array(await biasArt.blob.arrayBuffer()) : null,
            meta: calibMeta.data
          };
        }
      } catch (calibErr) {
        console.warn('motion.worker: Calibration load failed', calibErr);
        calibData = null;
      }
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

    // Choose adaptive resolution
    const chosenRes = chooseResolutionForJob(options, _flags, options.hardwareInfo || {});
    options.resolution = chosenRes;

    const computeResult = await _computeDepthNormalsFlux(
      frameBitmap,
      calibData,
      {
        resolution: options.resolution || chosenRes,
        quality: options.priority > 50 ? 'high' : 'medium',
        priority: options.priority
      }
    );

    const { depthMap, normalMap, fluxData, telemetry, selectorArtifact } = computeResult;

    // Log telemetry
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

    // Depth map - pass TypedArray directly
    const depthResult = await _persistArtifact(
      storageWrapper,
      null,
      depthMap.data, // ✅ Pass Float32Array directly
      {
        type: 'depth_map',
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
      }
    );

    if (!depthResult?.metaKey) {
      throw new Error('Depth persistence failed');
    }

// Normal map - pass TypedArray directly
    const normalResult = await _persistArtifact(
      storageWrapper,
      null,
      normalMap.data, // ✅ Pass Float32Array directly
      {
        type: 'normal_map',
        sourceMetaKey: metaKey,
        cameraId: cameraId,
        resolution: normalMap.resolution,
        encoding: normalMap.encoding,
        fallback: normalMap.fallback || false,
        computedAt: Date.now()
      }
    );

    if (!normalResult?.metaKey) {
      throw new Error('Normal persistence failed');
    }

    // Flux/constraints (if available) (storage generates key)
    let fluxResult = null;
    if (fluxData) {
      try {
        fluxResult = await _persistArtifact(
          storageWrapper,
          null,
          fluxData,
          {
            type: 'flux_field',
            sourceMetaKey: metaKey,
            computedAt: Date.now(),
            solverReady: true
          }
        );
      } catch (fluxErr) {
        console.warn('motion.worker: Flux persistence failed', fluxErr);
      }
    }

    // Persist selector artifact if produced and requested (storage generates key)
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

    // ========================================
    // STAGE 8: compute processingMs, update _metrics (before telemetry persist)
    // ========================================
    const processingMs = Date.now() - startTime;

    // Update metrics now that we've measured processing time
    _metrics.reconstructionCount = (_metrics.reconstructionCount || 0) + 1;
    _metrics.jobsHandled = (_metrics.jobsHandled || 0) + 1;
    _metrics.totalProcessingMs = (_metrics.totalProcessingMs || 0) + processingMs;
    _metrics.avgProcessingMs = _metrics.jobsHandled > 0 ? (_metrics.totalProcessingMs / _metrics.jobsHandled) : 0;
    if (depthMap && !depthMap.fallback) _metrics.depthComputeCount = (_metrics.depthComputeCount || 0) + 1;
    if (fluxData) _metrics.fluxComputeCount = (_metrics.fluxComputeCount || 0) + 1;

    // ========================================
    // STAGE 9: Persist telemetry artifact (storage generates key)
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
        processingMs: processingMs,
        estimatedMemoryBytes: telemetry.estimatedMemoryBytes || null,
        depthStats: depthMap ? { min: depthMap.min, max: depthMap.max } : null,
        depthFallback: !!(depthMap && depthMap.fallback),
        fluxPoints: fluxData ? (fluxData.sampleSummary?.points || null) : null,
        flags: _flags,
        errors: telemetry.errors || []
      };

      const telemetryRes = await _persistArtifact(storageWrapper, null, telemetryPayload, {
        type: 'recon_telemetry',
        sourceMetaKey: metaKey,
        jobId
      });

      // Broadcast telemetry ready (so MotionDetector or main can adapt)
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

    // CRITICAL: Re-read reconStatus to verify we still own this job
    if (storageWrapper.getReconStatus && storageWrapper.markReconDone) {
      try {
        const finalStatus = await storageWrapper.getReconStatus(metaKey);

        if (finalStatus && finalStatus.reqId !== jobId) {
          // Another worker took over - don't overwrite their work
          console.warn(`motion.worker: reqId mismatch (expected ${jobId}, found ${finalStatus.reqId})`);
          self.postMessage({
            event: 'RECON_CONFLICT',
            msgId: generateMsgId(),
            jobId,
            metaKey,
            reason: 'reqId mismatch - another worker took over',
            existingReqId: finalStatus.reqId
          });

          // Exit without marking done - another worker owns this now
          return;
        }

        // We still own it - proceed with marking done
        await storageWrapper.markReconDone(metaKey, derivedKeys);

      } catch (mdErr) {
        console.warn('motion.worker: markReconDone verification/update failed', mdErr);
        // Continue anyway - best effort
        // Still try to mark done even if verification failed
        try {
          await storageWrapper.markReconDone(metaKey, derivedKeys);
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
      if (calibData) {
        if (calibData.dark && typeof calibData.dark.close === 'function') calibData.dark.close();
        if (calibData.flat && typeof calibData.flat.close === 'function') calibData.flat.close();
      }
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
        errors: telemetry.errors
      }
    };

    // Reply to requester
    self.postMessage(replyPayload);

    // Broadcast on BC
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
    // Mark failed in reconStatus
    try {
      const storageWrapper2 = storageWrapper || await _loadStorageAPI();
      if (storageWrapper2.markReconFailed) {
        await storageWrapper2.markReconFailed(metaKey, String(se.message), 300000); // 5 min backoff
      }
    } catch (statusErr) {
      console.warn('motion.worker: markReconFailed error', statusErr);
    }

    _metrics.lastError = String(se.message);

    // Reply with error
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

    // Broadcast on BC
    _bcPost({
      event: 'RECON_FAIL',
      msgId: generateMsgId(),
      metaKey,
      error: String(se.message),
      producer: 'motion.worker',
      timestamp: Date.now()
    });
  } finally {
    // Clean up heartbeat and job map
    try {
      const jobEntry = _jobs.get(jobId);
      if (jobEntry && jobEntry.heartbeatTimer) {
        _stopHeartbeat(jobEntry.heartbeatTimer);
      }
    } catch (e) {
      // ignore
    }
    _jobs.delete(jobId);
    // Ensure frameBitmap closed in case of early failure
    try {
      if (frameBitmap && typeof frameBitmap.close === 'function') frameBitmap.close();
    } catch (e) {}
    // Ensure GPU resources cleaned
    _cleanupAfterReconstruction();
  }
}

// ---------------------------------------------------------------------------
// Legacy Flux Computation (Preserved for BC Calibration Events)
// ---------------------------------------------------------------------------

/**
 * _computeFluxFromCalibration(metaKey, options)
 * Legacy flux computation using MultiSampler (preserved for backward compatibility)
 */
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
  // Let storage generate key for flux artifact
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
    fluxResult = await _persistArtifact(
      storageWrapper,
      null, // Let storage generate key
      {
        manifest: sampleResult,
        config: samplerConfig,
        summary: fluxMeta.sampleManifestSummary
      },
      fluxMeta
    );
    const fluxKey = fluxResult.metaKey;

    // Save thumbnail
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
      // No-op here; main may handle releasing calibration tokens
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
      // Important: do not impose a wrapper timeout here; reconstruction jobs are long-running and critical.
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
