// preprocessor.worker.js 
// Module worker that receives ImageBitmap frames from the main thread wrapper,
// generates thumbnail + quick phash + manifest, writes artifacts to storage, and notifies main thread.

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

// Define constants first
const DEFAULT_THUMB_MAX_SIDE = 256;
const BROADCAST_CHANNEL = 'motion-painter-store';
const INIT_TIMEOUT_MS = 30000; // 30 seconds

let bc;
let storageReady = false;
let initializationStarted = false;
const pendingFrames = [];

// track per-job in-flight calibration usage (jobId -> metaKey)
const inFlightCalibMap = new Map();

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
      await storageAPI.initStorage({ quota: undefined, startEvictor: true });
      console.log('[WORKER] ✓ storageAPI.initStorage completed');
      
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
  async computeCalibration({ frames, framesNeeded = 10, resolution }) {
    if (this.busy) {
      throw new Error('Calibration computation already in progress');
    }
    
    try {
      this.busy = true;
      
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
    } finally {
      this.busy = false;
    }
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

  return storageAPI.initStorage({ quota: undefined, startEvictor: true })
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

// Main task: process incoming frame
async function processFrame({ jobId, meta = {}, imageBitmap, options = {} }) {
  const startTime = Date.now();
  let usedCalibKey = null;
  
  try {
    if (!imageBitmap) {
      throw new Error('No imageBitmap provided');
    }

    if (options.applyCalibration && CALIB.metaKey) {
      usedCalibKey = CALIB.metaKey;
      CALIB.metaRefCount = (CALIB.metaRefCount || 0) + 1;
      inFlightCalibMap.set(jobId, usedCalibKey);
      console.log(`CALIB: Incremented metaRefCount for key ${usedCalibKey} -> ${CALIB.metaRefCount}`);
    }

    postMessage({ event: 'progress', jobId, stage: 'processing_start', timestamp: startTime });

    let processedBitmap = imageBitmap;
    if (options.applyCalibration && CALIB.isCalibrated) {
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

    const srcHash = meta.srcHash || `src-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    const frameNumber = meta.frameNumber || null;
    const timestamp = meta.timestamp || Date.now();
    const producerVersion = 'preproc-v1';
    const hashVersion = 'ahash-v1';
    
    const thumbKey = `thumb:${srcHash}:${w}x${h}`;
    const phashKey = `phash:${srcHash}`;
    const manifestKey = `manifest:${srcHash}`;

    const thumbArtifact = {
      key: thumbKey,
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
        calibrationApplied: options.applyCalibration && CALIB.isCalibrated,
        calibrationKey: CALIB.metaKey || undefined
      },
      createdAt: new Date().toISOString()
    };

    const phashArtifact = {
      key: phashKey,
      type: 'phash',
      data: { phash, hashVersion, algorithm: 'aHash' },
      meta: { 
        srcHash, 
        frameNumber, 
        timestamp, 
        producerVersion,
        hashVersion,
        sizeBytes: JSON.stringify({ phash, hashVersion, algorithm: 'aHash' }).length,
        calibrationKey: CALIB.metaKey || undefined
      },
      createdAt: new Date().toISOString()
    };

    const manifestArtifact = {
      key: manifestKey,
      type: 'manifest',
      data: { 
        keys: [thumbKey, phashKey], 
        frameNumber, 
        timestamp, 
        meta,
        versions: {
          thumbnail: producerVersion,
          phash: hashVersion,
          sdf: null,
          pose: null
        },
        processingMode: mode,
        downsampleScale: downsampleScale !== 1.0 ? downsampleScale : undefined,
        calibrationApplied: options.applyCalibration && CALIB.isCalibrated,
        calibrationKey: CALIB.metaKey || undefined
      },
      meta: { 
        srcHash, 
        frameNumber, 
        timestamp, 
        producerVersion,
        sizeBytes: JSON.stringify({
          keys: [thumbKey, phashKey],
          frameNumber,
          timestamp,
          meta
        }).length
      },
      createdAt: new Date().toISOString()
    };

    postMessage({ event: 'progress', jobId, stage: 'writing_storage' });
    
    if (typeof self.putInboundArtifact !== 'function') {
      throw new Error('putInboundArtifact function not available');
    }
    
    await self.putInboundArtifact(thumbArtifact);
    await self.putInboundArtifact(phashArtifact);
    await self.putInboundArtifact(manifestArtifact);

    const durationMs = Date.now() - startTime;

    const readyData = { 
      event: 'artifact:ready', 
      jobId, 
      keys: [thumbKey, phashKey, manifestKey], 
      meta: { srcHash, frameNumber, timestamp, producerVersion, hashVersion },
      durationMs,
      processingMode: mode,
      downsampleScale: downsampleScale !== 1.0 ? downsampleScale : undefined,
      calibrationApplied: options.applyCalibration && CALIB.isCalibrated
    };
    
    postMessage(readyData);
    if (bc) {
      try {
        bc.postMessage(readyData);
      } catch (bcErr) {
        console.warn('preprocessor.worker: broadcast artifact:ready failed', bcErr);
      }
    }

    try { processedBitmap.close(); } catch (e) {}
    
  } catch (err) {
    console.error('preprocessor.worker: processing failed', err);
    const errorData = { 
      event: 'artifact:error', 
      jobId, 
      error: String(err), 
      stack: err.stack,
      phase: 'processing'
    };
    postMessage(errorData);
    if (bc) {
      try {
        bc.postMessage(errorData);
      } catch (bcErr) {
        console.warn('preprocessor.worker: broadcast artifact:error failed', bcErr);
      }
    }
    try { imageBitmap.close(); } catch (e) {}
  } finally {
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
              if (bc) {
                try {
                  bc.postMessage({ event: 'calibration:unpin', metaKey: toUnpin, producer: 'preprocessor', timestamp: Date.now() });
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
  
  try {
    postMessage({ event: 'progress', jobId, stage: 'calibration_start', frameCount: frames.length });
    
    const result = await CALIB.computeCalibration({ frames, framesNeeded, resolution });

    // CRITICAL: Clone result bitmaps IMMEDIATELY before they might be closed/transferred
    postMessage({ event: 'progress', jobId, stage: 'cloning_calibration_bitmaps' });
    
    darkBitmapClone = await _safeBitmapClone(result.darkFrame);
    flatBitmapClone = await _safeBitmapClone(result.flatFrame);
    
    if (!darkBitmapClone || !flatBitmapClone) {
      throw new Error('Failed to clone calibration bitmaps - source frames may be closed');
    }

    postMessage({ event: 'progress', jobId, stage: 'creating_calibrated_reference' });

    // Create calibrated reference frame by applying calibration to flat frame
    calibratedBitmap = await CALIB.applyCalibrationToBitmap(
      flatBitmapClone,
      { outW: flatBitmapClone.width, outH: flatBitmapClone.height }
    );
    
    if (!calibratedBitmap) {
      throw new Error('Failed to create calibrated reference bitmap');
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

    // Persist child artifacts sequentially with retry
    for (const artifact of artifactsToPersist) {
      if (!artifact.blob) continue;
      
      await _retryStoragePut(async () => {
        const putFn = self.putInboundArtifact || 
                      (typeof storageAPI !== 'undefined' && storageAPI.putInboundArtifact);
        
        if (typeof putFn !== 'function') {
          throw new Error('putInboundArtifact not available in worker context');
        }
        
        await putFn({
          key: artifact.key,
          type: artifact.type,
          blob: artifact.blob,
          meta: artifact.meta,
          createdAt: new Date().toISOString()
        });
      });
    }

    // Persist meta manifest LAST (atomic commit point)
    await _retryStoragePut(async () => {
      const putFn = self.putInboundArtifact || 
                    (typeof storageAPI !== 'undefined' && storageAPI.putInboundArtifact);
      
      if (typeof putFn !== 'function') {
        throw new Error('putInboundArtifact not available for manifest');
      }
      
      await putFn({
        key: metaKey,
        type: 'calibration.meta',
        data: manifestData,
        meta: {
          producer: 'preprocessor',
          calibVersion: 'calib-v1',
          artifactKeys: [darkKey, flatKey, biasKey, calibratedKey],
          createdAt: new Date().toISOString()
        },
        createdAt: new Date().toISOString()
      });
    });

    postMessage({ event: 'progress', jobId, stage: 'finalization' });

    // Update CALIB state
    CALIB.metaKey = metaKey;
    CALIB.meta = manifestData;
    CALIB.metaRefCount = 1;
    
    console.log(`CALIB: Calibration persisted successfully. metaKey=${metaKey}, calibratedFrameKey=${calibratedKey}`);

    // Pin meta artifact (prevents premature eviction)
    try {
      const pinFn = self.pinArtifact || 
                    (typeof storageAPI !== 'undefined' && storageAPI.pinArtifact);
      if (typeof pinFn === 'function') {
        await pinFn(metaKey, { owner: 'preprocessor', type: 'soft' });
      }
    } catch (pinErr) {
      console.warn('handleComputeCalibration: pinArtifact failed (non-fatal)', pinErr);
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
          timestamp: Date.now() 
        });
      } catch (bcErr) {}
    }
    
  } finally {
    // Cleanup: Close all bitmap clones we created
    try {
      if (darkBitmapClone) darkBitmapClone.close();
      if (flatBitmapClone) flatBitmapClone.close();
      if (calibratedBitmap) calibratedBitmap.close();
    } catch (cleanupErr) {
      console.warn('Bitmap cleanup error (non-fatal):', cleanupErr);
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
                  bc.postMessage({ event: 'calibration:unpin', metaKey: toUnpin, producer: 'preprocessor', timestamp: Date.now() });
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
            bc.postMessage({ event: 'calibration:released', token, metaKey: key, producer: 'preprocessor', timestamp: Date.now() });
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
            bc.postMessage({ event: 'calibration:release_error', token: msg.token, error: String(err), producer: 'preprocessor', timestamp: Date.now() });
          } catch (bcErr) {
            console.warn('preprocessor.worker: failed to broadcast calibration:release_error', bcErr);
          }
        }
      }

    } else if (msg.op === 'invalidateCalibration') {
      const oldMetaKey = CALIB.metaKey;
      if (oldMetaKey) {
        if (CALIB.metaRefCount && CALIB.metaRefCount > 0) {
          CALIB.pendingUnpinKey = oldMetaKey;
          console.log(`invalidateCalibration: deferring unpin of ${oldMetaKey} until metaRefCount reaches 0 (currently ${CALIB.metaRefCount})`);
        } else {
          try {
            await self.unpinArtifact(oldMetaKey);
            console.log(`invalidateCalibration: unpinned ${oldMetaKey}`);
            if (bc) {
              try {
                bc.postMessage({ event: 'calibration:unpin', metaKey: oldMetaKey, producer: 'preprocessor', timestamp: Date.now() });
              } catch (bcErr) {
                console.warn('preprocessor.worker: broadcast calibration:unpin failed', bcErr);
              }
            }
          } catch (unpErr) {
            console.warn('invalidateCalibration: unpinArtifact failed', unpErr);
          }
        }
      }

      CALIB.invalidateCalibration();

      CALIB.metaKey = null;
      CALIB.meta = null;

      postMessage({ 
        event: 'calibration:invalidated',
        timestamp: Date.now()
      });

      try {
        if (bc) {
          bc.postMessage({ event: 'calibration:invalidated', metaKey: oldMetaKey || null, producer: 'preprocessor', timestamp: Date.now() });
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
      pendingFrames.forEach(({ imageBitmap }) => {
        try { imageBitmap.close(); } catch (e) {}
      });
      pendingFrames.length = 0;
      
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
        bc.postMessage({ event: 'worker:error', error: String(err), stack: err.stack, producer: 'preprocessor', timestamp: Date.now() });
      } catch (bcErr) {
        console.warn('preprocessor.worker: broadcast worker:error failed', bcErr);
      }
    }
  }
};