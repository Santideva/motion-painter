// preprocessor.worker.js
// Module worker that receives ImageBitmap frames from the main thread wrapper,
// generates thumbnail + quick phash + manifest, writes artifacts to storage, and notifies main thread.

// VERY top-level sanity log (must run as soon as the worker file is parsed)
try {
  console.log('preprocessor.worker: (top) module evaluation starting...');
} catch (e) {
  // console may be unavailable in some edge cases; silence
}

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

try {
  console.log('preprocessor.worker: (top) module evaluation starting...');
} catch (e) { /* quiet fallback if console is weird */ }

(async () => {
  try {
    console.log('preprocessor.worker: Attempting dynamic import of ./storage.js ...');
    const mod = await import('/src/js/core/storage.js'); // absolute path from server root
    storageAPI = mod?.default || mod?.storageAPI || mod;
    console.log('preprocessor.worker: storage module imported (dynamic)');

    // Delegate to compatibility shim (below) to bind functions and init storage.
    // initializeStorage() returns the promise from storageAPI.initStorage.
    // If the shim isn't present for some reason, call storageAPI.initStorage directly.
    if (typeof initializeStorage === 'function') {
      try {
        await initializeStorage(); // shim will call storageAPI.initStorage and bind methods
      } catch (err) {
        // initializeStorage will already post worker:error -- do an extra log
        console.error('preprocessor.worker: initializeStorage (shim) failed:', err);
        throw err;
      }
    } else if (storageAPI && typeof storageAPI.initStorage === 'function') {
      await storageAPI.initStorage({ quota: undefined, startEvictor: true });
      // bind commonly referenced functions onto self for backwards compatibility
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
      storageReady = true;
      console.log('preprocessor.worker: Storage initialized successfully (direct dynamic import path)');
      postMessage({ event: 'worker:ready' });
    } else {
      throw new Error('storageAPI missing initStorage after import');
    }
  } catch (err) {
    console.error('preprocessor.worker: Dynamic import or init failed:', err);
    try {
      postMessage({
        event: 'worker:error',
        error: 'dynamic-import-or-init-failed',
        details: { message: err?.message, stack: err?.stack }
      });
    } catch (e) {
      console.error('preprocessor.worker: failed to post worker:error after dynamic import failure', e);
    }
  }
})();

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
  // Incremented when a frame referencing calibration is processed, decremented when finished.
  metaRefCount: 0,
  // If an invalidate/unpin was requested while refcount > 0, we will hold this key here and attempt unpin later
  pendingUnpinKey: null,
  
  // Utility: Compute luminance statistics for frame classification
  async _computeFrameLuminance(imageBitmap) {
    try {
      // Use smaller sample for speed - downsample to 64x64 for statistics
      const sampleSize = 64;
      const canvas = new OffscreenCanvas(sampleSize, sampleSize);
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.drawImage(imageBitmap, 0, 0, sampleSize, sampleSize);
      const imageData = ctx.getImageData(0, 0, sampleSize, sampleSize);
      const data = imageData.data;
      
      let sum = 0;
      let count = 0;
      const values = [];
      
      // Compute luminance for each pixel
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
      
      // Compute median for more robust statistics
      values.sort((a, b) => a - b);
      const median = values[Math.floor(values.length / 2)];
      
      return { mean, median, min: values[0], max: values[values.length - 1] };
      
    } catch (err) {
      console.error('CALIB: _computeFrameLuminance failed:', err);
      return { mean: 128, median: 128, min: 0, max: 255 }; // Fallback
    }
  },
  
  // Classify frames as dark or flat based on luminance
  async _classifyFrames(frames) {
    console.log('CALIB: Computing frame luminance statistics...');
    
    const frameStats = [];
    
    // Compute luminance for all frames
    for (let i = 0; i < frames.length; i++) {
      const stats = await this._computeFrameLuminance(frames[i]);
      frameStats.push({ index: i, ...stats });
    }
    
    // Sort by median luminance
    frameStats.sort((a, b) => a.median - b.median);
    
    // Split: bottom 40% as dark, top 60% as flat (more flexible than 50/50)
    const darkCount = Math.max(1, Math.floor(frames.length * 0.4));
    const flatCount = Math.max(1, frames.length - darkCount);
    
    // CRITICAL: Ensure no index overlap by using strict separation
    const darkIndices = frameStats.slice(0, darkCount).map(s => s.index);
    const flatIndices = frameStats.slice(darkCount).map(s => s.index); // Start from darkCount, not -flatCount
    
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
    
  // Use downsampling for faster calibration computation
    const maxCalibrationSize = 512;
    const scale = Math.min(1, maxCalibrationSize / Math.max(width, height));
    const calibW = Math.max(1, Math.floor(width * scale));
    const calibH = Math.max(1, Math.floor(height * scale));
    
    if (scale < 1) {
      console.log(`CALIB: Downsampling calibration frames from ${width}x${height} to ${calibW}x${calibH}`);
    }
    
    // Use Float32Arrays for accumulation to avoid precision loss
    const channelSize = calibW * calibH;
    const rSum = new Float32Array(channelSize);
    const gSum = new Float32Array(channelSize);
    const bSum = new Float32Array(channelSize);
    
    // Temporary canvas for reading frame data
    const tempCanvas = new OffscreenCanvas(calibW, calibH);
    const tempCtx = tempCanvas.getContext('2d', { alpha: false });
    
    try {
      // Accumulate pixel values across frames
      for (let frameIdx = 0; frameIdx < indices.length; frameIdx++) {
        const frame = frames[indices[frameIdx]];
        
        tempCtx.drawImage(frame, 0, 0, calibW, calibH);
        const imageData = tempCtx.getImageData(0, 0, calibW, calibH); // FIXED: Use downsampled dimensions
        const data = imageData.data;
        
        for (let pixelIdx = 0; pixelIdx < channelSize; pixelIdx++) {
          const dataIdx = pixelIdx * 4;
          rSum[pixelIdx] += data[dataIdx];     // R
          gSum[pixelIdx] += data[dataIdx + 1]; // G
          bSum[pixelIdx] += data[dataIdx + 2]; // B
          // Skip alpha channel
        }
        
        // Close the frame immediately after processing
        try {
          frame.close();
          console.log(`CALIB: Closed frame ${indices[frameIdx]} after processing`);
        } catch (e) {
          console.warn(`CALIB: Error closing frame ${indices[frameIdx]}:`, e);
        }
      }
      
      // Compute averages and create final ImageData
      const avgData = new Uint8ClampedArray(calibW * calibH * 4);
      const frameCount = indices.length;
      
      for (let pixelIdx = 0; pixelIdx < channelSize; pixelIdx++) {
        const dataIdx = pixelIdx * 4;
        avgData[dataIdx]     = Math.round(rSum[pixelIdx] / frameCount); // R
        avgData[dataIdx + 1] = Math.round(gSum[pixelIdx] / frameCount); // G
        avgData[dataIdx + 2] = Math.round(bSum[pixelIdx] / frameCount); // B
        avgData[dataIdx + 3] = 255; // Alpha
      }
      
      const avgImageData = new ImageData(avgData, calibW, calibH);
      
      // Create final canvas and convert to ImageBitmap
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
      // Create temporary canvases to read pixel data
      const darkCanvas = new OffscreenCanvas(width, height);
      const darkCtx = darkCanvas.getContext('2d', { alpha: false });
      darkCtx.drawImage(darkFrame, 0, 0, width, height);
      const darkData = darkCtx.getImageData(0, 0, width, height);
      
      const flatCanvas = new OffscreenCanvas(width, height);
      const flatCtx = flatCanvas.getContext('2d', { alpha: false });
      flatCtx.drawImage(flatFrame, 0, 0, width, height);
      const flatData = flatCtx.getImageData(0, 0, width, height);
      
      const biasData = new Float32Array(width * height * 3); // RGB only, no alpha
      const channelSums = [0, 0, 0]; // For computing per-channel means
      const pixelCount = width * height;
      // Use numerically-safe epsilon
      const epsilon = 1e-6;
      
      // Compute flat - dark for each pixel and channel
      for (let i = 0; i < width * height; i++) {
        const dataIdx = i * 4;
        const biasIdx = i * 3;
        
        for (let c = 0; c < 3; c++) { // RGB channels only
          const flatVal = flatData.data[dataIdx + c];
          const darkVal = darkData.data[dataIdx + c];
          const bias = Math.max(epsilon, flatVal - darkVal); // Avoid division by zero
          
          biasData[biasIdx + c] = bias;
          channelSums[c] += bias;
        }
      }
      
      // Compute per-channel means for normalization
      const channelMeans = channelSums.map(sum => Math.max(epsilon, sum / pixelCount)); // Clamp means
      console.log('CALIB: Flat bias channel means:', channelMeans.map(m => m.toFixed(6)));
      
      // Check for extremely small means and warn
      const minValidMean = 0.1;
      channelMeans.forEach((mean, c) => {
        if (mean < minValidMean) {
          console.warn(`CALIB: Channel ${c} mean (${mean.toFixed(6)}) is very small, calibration may be unreliable`);
        }
      });
      
      // Normalize bias map so each channel has mean = 1.0, with float-centered normalization
      for (let i = 0; i < pixelCount; i++) {
        const biasIdx = i * 3;
        
        for (let c = 0; c < 3; c++) {
          const normalized = biasData[biasIdx + c] / channelMeans[c];
          // Clamp to reasonable range to prevent extreme values
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
    // Guard against concurrent calibration jobs
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
      
      // Classify frames by luminance
      const { darkIndices, flatIndices } = await this._classifyFrames(frames);
      
      // Process dark frames
      console.log('CALIB: Processing dark frames...');
      const darkFrame = await this._processFrameGroup(frames, darkIndices, { width, height });
      
      // Process flat frames  
      console.log('CALIB: Processing flat frames...');
      const flatFrame = await this._processFrameGroup(frames, flatIndices, { width, height });
      
      // Compute normalized flat bias correction map
      const flatBiasNorm = this._computeFlatBiasNorm(darkFrame, flatFrame, { 
        width: darkFrame.width, 
        height: darkFrame.height 
      });
      
      // Store calibration data
      this.darkFrame = darkFrame;
      this.flatFrame = flatFrame;
      this.flatBiasNorm = flatBiasNorm;
      this.isCalibrated = true;
      this.frameCount = frames.length;
      this.resolution = { width: darkFrame.width, height: darkFrame.height }; // Use actual calibration frame size
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
      
      // Clean up any remaining frames on error
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
      return imageBitmap; // Return unchanged if not calibrated
    }
    
    try {
      const canvas = new OffscreenCanvas(outW, outH);
      const ctx = canvas.getContext('2d', { alpha: false });
      
      // Draw source image
      ctx.drawImage(imageBitmap, 0, 0, outW, outH);
      const sourceData = ctx.getImageData(0, 0, outW, outH);
      
      // Create temporary canvases for dark frame
      const darkCanvas = new OffscreenCanvas(outW, outH);
      const darkCtx = darkCanvas.getContext('2d', { alpha: false });
      darkCtx.drawImage(this.darkFrame, 0, 0, outW, outH);
      const darkData = darkCtx.getImageData(0, 0, outW, outH);
      
      // Scale flat bias normalization map to output resolution
      const scaledBiasData = this._scaleFlatBiasNorm(this.flatBiasNorm, this.resolution, { width: outW, height: outH });
      
      // Apply calibration: corrected = (source - dark) / flatBiasNorm
      const correctedData = new Uint8ClampedArray(sourceData.data.length);
      
      for (let i = 0; i < sourceData.data.length; i += 4) {
        const pixelIdx = Math.floor(i / 4);
        const biasIdx = pixelIdx * 3;
        
        for (let c = 0; c < 3; c++) { // R,G,B channels only
          const source = sourceData.data[i + c];
          const dark = darkData.data[i + c];
          const sourceDark = source - dark;
          const flatBias = scaledBiasData[biasIdx + c];
          
          const corrected = sourceDark / flatBias;
          correctedData[i + c] = Math.max(0, Math.min(255, Math.round(corrected)));
        }
        correctedData[i + 3] = sourceData.data[i + 3]; // Copy alpha unchanged
      }
      
      // Create corrected ImageData and convert to ImageBitmap
      const correctedImageData = new ImageData(correctedData, outW, outH);
      ctx.putImageData(correctedImageData, 0, 0);
      
      return await createImageBitmap(canvas);
      
    } catch (err) {
      console.error('CALIB: applyCalibrationToBitmap failed:', err);
      return imageBitmap; // Return original on error
    }
  },
  
  _scaleFlatBiasNorm(flatBiasNorm, sourceRes, targetRes) {
    const { width: srcW, height: srcH } = sourceRes;
    const { width: targetW, height: targetH } = targetRes;
    
    // If resolutions match, return as-is
    if (srcW === targetW && srcH === targetH) {
      return flatBiasNorm;
    }
    
    // Simple nearest-neighbor scaling for the bias map
    const scaledBias = new Float32Array(targetW * targetH * 3);
    const scaleX = srcW / targetW;
    const scaleY = srcH / targetH;
    
    for (let y = 0; y < targetH; y++) {
      for (let x = 0; x < targetW; x++) {
        const srcX = Math.floor(x * scaleX);
        const srcY = Math.floor(y * scaleY);
        
        const srcIdx = (srcY * srcW + srcX) * 3;
        const dstIdx = (y * targetW + x) * 3;
        
        scaledBias[dstIdx] = flatBiasNorm[srcIdx];         // R
        scaledBias[dstIdx + 1] = flatBiasNorm[srcIdx + 1]; // G  
        scaledBias[dstIdx + 2] = flatBiasNorm[srcIdx + 2]; // B
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
    this.busy = false; // Reset busy flag on invalidation
    
    // Reset refcount/pending unpin as well
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

// Helper attached to CALIB: fetch persisted calibration artifacts by metaKey.
// Returns: { darkBitmap, flatBitmap, biasArray (Float32Array), meta, metaKey }
// Uses worker-global storage API (self.getArtifact) which storage.js exposes.
CALIB.fetchPersisted = async function(metaKey = null) {
  try {
    const key = metaKey || this.metaKey;
    if (!key) throw new Error('No calibration metaKey available');

    if (typeof self.getArtifact !== 'function') {
      throw new Error('Storage API (getArtifact) not available in worker');
    }

    // fetch meta manifest
    const metaArtifact = await self.getArtifact(key);
    if (!metaArtifact || !metaArtifact.data) {
      throw new Error(`Calibration meta not found for key ${key}`);
    }

    const { darkKey, flatKey, biasKey } = metaArtifact.data;

    // fetch artifacts (may be null if absent)
    const darkArt = darkKey ? await self.getArtifact(darkKey) : null;
    const flatArt = flatKey ? await self.getArtifact(flatKey) : null;
    const biasArt = biasKey ? await self.getArtifact(biasKey) : null;

    // create ImageBitmaps for dark/flat if blobs present
    const darkBitmap = (darkArt && darkArt.blob) ? await createImageBitmap(darkArt.blob) : null;
    const flatBitmap = (flatArt && flatArt.blob) ? await createImageBitmap(flatArt.blob) : null;

    // bias blob -> Float32Array
    let biasArray = null;
    if (biasArt && biasArt.blob) {
      const ab = await biasArt.blob.arrayBuffer();
      biasArray = new Float32Array(ab);
    }

    // *** PATCH: increment worker-side refcount because we're handing out bitmaps to a remote consumer ***
    // Bump worker-side refcount since we're handing out bitmaps to requester
    this.metaRefCount = (this.metaRefCount || 0) + 1;
    console.log(`CALIB.fetchPersisted: incremented metaRefCount for ${key} => ${this.metaRefCount}`);
    // Keep a local pointer to the canonical metaKey (useful for deferred unpin)
    this.metaKey = key;
    return { darkBitmap, flatBitmap, biasArray, meta: metaArtifact.data, metaKey: key };


  } catch (err) {
    console.error('CALIB.fetchPersisted failed', err);
    throw err;
  }
};

// initializeStorage() compatibility shim
// Historically we relied on storage.js setting self.onstorage via importScripts.
// In the module-worker world we import storageAPI as an ES module and call initStorage directly.
// Keep a shim for backwards compatibility that delegates to storageAPI.initStorage.
function initializeStorage() {
  console.warn('preprocessor.worker: initializeStorage() shim called — delegating to storageAPI.initStorage (module mode)');
  initializationStarted = true;

  return storageAPI.initStorage({ quota: undefined, startEvictor: true })
    .then(() => {
      clearTimeout(initTimeout);
      storageReady = true;
      console.log('preprocessor.worker: Storage initialized successfully (via shim)');

      // Proxy commonly used functions onto self (backwards compatibility)
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

      // Process any queued frames
      const queued = [...pendingFrames];
      pendingFrames.length = 0;
      queued.forEach(frame => {
        console.log('preprocessor.worker: Processing queued frame', frame.jobId);
        processFrame(frame);
      });

      // Signal main thread that worker is ready
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
      // rethrow for callers if any expect a rejection
      throw err;
    });
}


// NOTE: initialization is now driven by the dynamic import above.
// initializeStorage() is kept as a shim function for compatibility but should not be invoked here
// because the dynamic import logic handles calling it (and reporting errors).
// initializeStorage();


// Utility: average hash (aHash) quick implementation
async function computeAHashFromBitmap(imageBitmap, hashSize = 8) {
  try {
    // We'll downscale to hashSize x hashSize, grayscale, compare to mean
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
      // convert to luminance
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      vals[j] = lum;
      sum += lum;
    }
    const mean = sum / vals.length;
    // produce bitstring as hex
    let bits = 0n;
    for (let i = 0; i < vals.length; i++) {
      if (vals[i] >= mean) bits |= (1n << BigInt(i));
    }
    // represent as hex string
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
    // Optionally handle flipY / orientation here if meta requires
    ctx.drawImage(imageBitmap, 0, 0, w, h);
    // convert to blob (png)
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
  // track whether this job incremented the calibration refcount
  let usedCalibKey = null;
  
  try {
    if (!imageBitmap) {
      throw new Error('No imageBitmap provided');
    }

    // If this job intends to apply calibration and a persisted calibration metaKey exists,
    // increment the worker-side refcount so we don't unpin while frames that rely on it are processing.
    if (options.applyCalibration && CALIB.metaKey) {
      usedCalibKey = CALIB.metaKey;
      CALIB.metaRefCount = (CALIB.metaRefCount || 0) + 1;
      inFlightCalibMap.set(jobId, usedCalibKey);
      console.log(`CALIB: Incremented metaRefCount for key ${usedCalibKey} -> ${CALIB.metaRefCount}`);
    }

    // Emit progress
    postMessage({ event: 'progress', jobId, stage: 'processing_start', timestamp: startTime });

    // Apply calibration correction if enabled and available
    let processedBitmap = imageBitmap;
    if (options.applyCalibration && CALIB.isCalibrated) {
      postMessage({ event: 'progress', jobId, stage: 'applying_calibration' });
      processedBitmap = await CALIB.applyCalibrationToBitmap(imageBitmap, {
        outW: imageBitmap.width,
        outH: imageBitmap.height
      });
      // Close original if we created a new one
      if (processedBitmap !== imageBitmap) {
        try { imageBitmap.close(); } catch (e) {}
      }
    }

    // Decide mode: preview vs final
    const mode = options.mode || meta.mode || 'preview'; // 'preview' or 'final'
    const thumbMax = mode === 'final' ? 512 : DEFAULT_THUMB_MAX_SIDE;

    // Apply downsample scale if provided in options
    const downsampleScale = options.downsampleScale || 1.0;
    const effectiveThumbMax = Math.floor(thumbMax * downsampleScale);

    // Create thumbnail
    postMessage({ event: 'progress', jobId, stage: 'creating_thumbnail' });
    const { blob: thumbBlob, w, h } = await createThumbnailBlob(processedBitmap, effectiveThumbMax);

    // compute phash (aHash here)
    // For phash we can compute from the thumbnail (fast)
    // create a small bitmap from the blob
    postMessage({ event: 'progress', jobId, stage: 'computing_phash' });
    const thumbBitmap = await createImageBitmap(thumbBlob);
    const phash = await computeAHashFromBitmap(thumbBitmap, 8);
    try { thumbBitmap.close(); } catch (e) {}

    // small manifest data
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
          calibrationKey: CALIB.metaKey || undefined   // <-- ADDED
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
        calibrationKey: CALIB.metaKey || undefined   // <- ADDED here too (useful)
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
        calibrationKey: CALIB.metaKey || undefined   // <-- ADDED
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


    // Write artifacts to storage
    postMessage({ event: 'progress', jobId, stage: 'writing_storage' });
    
    // Check if storage functions are available
    if (typeof self.putInboundArtifact !== 'function') {
      throw new Error('putInboundArtifact function not available');
    }
    
    await self.putInboundArtifact(thumbArtifact);
    await self.putInboundArtifact(phashArtifact);
    await self.putInboundArtifact(manifestArtifact);

    const durationMs = Date.now() - startTime;

    // Notify main thread and broadcast channel
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
      bc.postMessage(readyData);
    }

    // Close the processed ImageBitmap to free GPU resources
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
      bc.postMessage(errorData);
    }
    try { imageBitmap.close(); } catch (e) {}
  } finally {
    // If this job used calibration, decrement the worker-side refcount and attempt unpin if pending
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

    // Check if storage functions are available
    if (typeof self.getArtifact !== 'function') {
      throw new Error('getArtifact function not available');
    }

    // Get the original artifact
    const artifact = await self.getArtifact(key);
    if (!artifact) {
      throw new Error(`Artifact not found: ${key}`);
    }

    const results = [];
    
    for (const action of actions) {
      if (action === 'sdf') {
        // Placeholder for SDF generation
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
        // Placeholder for pose estimation
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

// Handle calibration computation requests
async function handleComputeCalibration({ jobId, frames, framesNeeded, resolution }) {
  try {
    postMessage({ event: 'progress', jobId, stage: 'calibration_start', frameCount: frames.length });
    
        const result = await CALIB.computeCalibration({ frames, framesNeeded, resolution });

    // Persist calibration artifacts: dark.png, flat.png, bias.bin, and a meta manifest
    try {
      // create PNG blobs from the ImageBitmaps
      const darkCanvas = new OffscreenCanvas(result.darkFrame.width, result.darkFrame.height);
      const darkCtx = darkCanvas.getContext('2d', { alpha: false });
      darkCtx.drawImage(result.darkFrame, 0, 0);
      const darkBlob = await darkCanvas.convertToBlob({ type: 'image/png' });

      const flatCanvas = new OffscreenCanvas(result.flatFrame.width, result.flatFrame.height);
      const flatCtx = flatCanvas.getContext('2d', { alpha: false });
      flatCtx.drawImage(result.flatFrame, 0, 0);
      const flatBlob = await flatCanvas.convertToBlob({ type: 'image/png' });

      // bias (Float32Array) is stored in CALIB.flatBiasNorm
      // serialize the Float32Array to a blob
      let biasBlob = null;
      if (CALIB.flatBiasNorm) {
        // ensure we have an ArrayBuffer
        const biasBuffer = CALIB.flatBiasNorm.buffer || new Float32Array(CALIB.flatBiasNorm).buffer;
        biasBlob = new Blob([biasBuffer], { type: 'application/octet-stream' });
      }

      // produce keys
      const ts = Date.now();
      const darkKey = `calib:dark:${ts}`;
      const flatKey = `calib:flat:${ts}`;
      const biasKey = `calib:bias:${ts}`;
      const metaKey = `calib:meta:${ts}`;

      // Build meta manifest (references keys)
      const manifest = {
        key: metaKey,
        type: 'calibration.meta',
        data: {
          darkKey,
          flatKey,
          biasKey,
          resolution: { width: result.darkFrame.width, height: result.darkFrame.height },
          frameCount: result.meta?.frameCount || null,
          createdAt: new Date().toISOString(),
          version: 'calib-v1'
        },
        meta: {
          producer: 'preprocessor',
          createdAt: new Date().toISOString()
        },
        createdAt: new Date().toISOString()
      };

      // Put artifacts into storage (idempotent - putInboundArtifact handles existing)
      if (darkBlob) {
        await self.putInboundArtifact({
          key: darkKey,
          type: 'calib-dark',
          blob: darkBlob,
          meta: { sizeBytes: darkBlob.size, resolution: { width: result.darkFrame.width, height: result.darkFrame.height } },
          createdAt: new Date().toISOString()
        });
      }
      if (flatBlob) {
        await self.putInboundArtifact({
          key: flatKey,
          type: 'calib-flat',
          blob: flatBlob,
          meta: { sizeBytes: flatBlob.size, resolution: { width: result.flatFrame.width, height: result.flatFrame.height } },
          createdAt: new Date().toISOString()
        });
      }

      if (biasBlob) {
        await self.putInboundArtifact({
          key: biasKey,
          type: 'calib-bias',
          blob: biasBlob,
          meta: { sizeBytes: biasBlob.size, dtype: 'float32', description: 'flat bias normalization map' },
          createdAt: new Date().toISOString()
        });
      }

      // persist meta manifest last (references the other keys)
      await self.putInboundArtifact({
        key: metaKey,
        type: 'calibration.meta',
        data: manifest.data,
        meta: manifest.meta,
        createdAt: manifest.createdAt
      });

      // store canonical meta key in CALIB for immediate use
      CALIB.metaKey = metaKey;
      CALIB.meta = manifest.data;

      // *** PATCH: initialize worker-side refcount so unpin logic is correct (meta owner = worker) ***
      // Set worker-side refcount to reflect that worker/pinner is an owner.
      // Prevent immediate unpinning if invalidateCalibration is requested, while consumers rely on persisted data
      CALIB.metaRefCount = 1;
      console.log(`CALIB: metaKey set to ${metaKey}, metaRefCount=${CALIB.metaRefCount}`);
      

      // Pin the calibration meta so it isn't evicted immediately (soft pin)
      try {
        await self.pinArtifact(metaKey, { owner: 'preprocessor', type: 'soft' });
      } catch (pinErr) {
        console.warn('handleComputeCalibration: pinArtifact failed', pinErr);
      }

      // Now post calibration ready to main (transfer the ImageBitmaps as before)
      postMessage({
        event: 'calibration:ready',
        jobId,
        darkFrame: result.darkFrame,
        flatFrame: result.flatFrame,
        meta: manifest.data,
        metaKey
      }, [result.darkFrame, result.flatFrame]);

    } catch (persistErr) {
      console.error('handleComputeCalibration: failed to persist calibration artifacts', persistErr);
      // fallback to sending calibration bitmaps without persistence
      postMessage({
        event: 'calibration:ready',
        jobId,
        darkFrame: result.darkFrame,
        flatFrame: result.flatFrame,
        meta: result.meta
      }, [result.darkFrame, result.flatFrame]);
    }
  
  } catch (err) {
    console.error('preprocessor.worker: calibration computation failed', err);
    postMessage({ 
      event: 'calibration:error', 
      jobId, 
      error: String(err),
      stack: err.stack 
    });
  }
}

// Worker message handler
self.onmessage = async (ev) => {
  const msg = ev.data || {};
  
  try {
    if (msg.op === 'preprocess') {
      // message should contain { jobId, meta, imageBitmap, options? }
      const { jobId, meta = {}, options = {} } = msg;
      // imageBitmap is a transferred ImageBitmap
      const imageBitmap = msg.imageBitmap || ev.data.imageBitmap || null;
      
      if (!imageBitmap) {
        postMessage({ event: 'artifact:error', jobId, error: 'No ImageBitmap received' });
        return;
      }

      if (!storageReady) {
        // Queue the frame for processing once storage is ready
        pendingFrames.push({ jobId, meta, imageBitmap, options });
        console.debug('preprocessor.worker: storage not ready, queuing frame', jobId);
        return;
      }
      
      // Process immediately if storage is ready
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
      // New: handle fetch request from main wrapper to retrieve persisted calibration artifacts
      // msg: { jobId, metaKey? }
      try {
        const metaKey = msg.metaKey || CALIB.metaKey;
        if (!metaKey) {
          throw new Error('No metaKey specified and no CALIB.metaKey available');
        }
        // Use CALIB.fetchPersisted to load bitmaps (and bias if present) from storage
        const fetched = await CALIB.fetchPersisted(metaKey);
        // Do NOT send biasArray back to main (per preference B)
        const { darkBitmap, flatBitmap, meta, metaKey: canonicalKey } = fetched;
        postMessage({
          event: 'calibration:fetched',
          jobId: msg.jobId || null,
          metaKey: canonicalKey,
          meta,
          darkFrame: darkBitmap,
          flatFrame: flatBitmap
        }, [darkBitmap, flatBitmap]);
      } catch (fErr) {
        console.error('preprocessor.worker: fetchCalibration failed', fErr);
        postMessage({
          event: 'calibration:fetch_error',
          jobId: msg.jobId || null,
          metaKey: msg.metaKey || null,
          error: String(fErr)
        });
      }

    } else if (msg.op === 'invalidateCalibration') {
      // If a persisted calibration metaKey exists, attempt to unpin it first, but only when safe
      const oldMetaKey = CALIB.metaKey;
      if (oldMetaKey) {
        if (CALIB.metaRefCount && CALIB.metaRefCount > 0) {
          // There are in-flight frames that reference the persisted meta.
          // Defer unpinning until refcount reaches zero.
          CALIB.pendingUnpinKey = oldMetaKey;
          console.log(`invalidateCalibration: deferring unpin of ${oldMetaKey} until metaRefCount reaches 0 (currently ${CALIB.metaRefCount})`);
        } else {
          try {
            await self.unpinArtifact(oldMetaKey);
            console.log(`invalidateCalibration: unpinned ${oldMetaKey}`);
          } catch (unpErr) {
            console.warn('invalidateCalibration: unpinArtifact failed', unpErr);
          }
        }
      }

      // Now invalidate in-memory calibration
      CALIB.invalidateCalibration();

      // Also clear any stored references
      CALIB.metaKey = null;
      CALIB.meta = null;

      postMessage({ 
        event: 'calibration:invalidated',
        timestamp: Date.now()
      });

      
    } else if (msg.op === 'getCalibrationMeta') {
      postMessage({ 
        event: 'calibration:meta',
        meta: CALIB.getCalibrationMeta()
      });
      
    } else if (msg.op === 'shutdown') {
      // Clean up any pending frames
      pendingFrames.forEach(({ imageBitmap }) => {
        try { imageBitmap.close(); } catch (e) {}
      });
      pendingFrames.length = 0;
      
      // Clean up calibration
      CALIB.invalidateCalibration();
      
      // Close broadcast channel
      try { if (bc) bc.close(); } catch (e) {}
      
      postMessage({ event: 'worker:shutdown' });
      close();
      
    } else {
      // other ops
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
  }
};
