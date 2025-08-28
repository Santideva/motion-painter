// preprocessor.worker.js
// Module worker that receives ImageBitmap frames from the main thread wrapper,
// generates thumbnail + quick phash + manifest, writes artifacts to storage, and notifies main thread.

importScripts('./storage.js');

const BROADCAST_CHANNEL = 'motion-painter-store';
const bc = new BroadcastChannel(BROADCAST_CHANNEL);

// Worker config
const DEFAULT_THUMB_MAX_SIDE = 256;

// Worker initialization state
let storageReady = false;
const pendingFrames = [];

// Initialize storage from worker side (safe; on first call this will open db)
self.initStorage({ quota: undefined, startEvictor: true })
  .then(() => {
    storageReady = true;
    console.log('preprocessor.worker: storage initialized, processing pending frames');
    
    // Process any queued frames
    const queued = [...pendingFrames];
    pendingFrames.length = 0;
    queued.forEach(frame => processFrame(frame));
    
    // Signal main thread that worker is ready
    postMessage({ event: 'worker:ready' });
  })
  .catch(err => {
    console.error('preprocessor.worker: storage init failed', err);
    postMessage({ event: 'worker:error', error: err.message });
  });

// Utility: average hash (aHash) quick implementation
async function computeAHashFromBitmap(imageBitmap, hashSize = 8) {
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
}

// Create thumbnail (returns Blob and width/height)
async function createThumbnailBlob(imageBitmap, maxSide = DEFAULT_THUMB_MAX_SIDE) {
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
}

// Utility: compute a small motion map if meta provides motion info (not implemented heavy)
function computeMotionMapPlaceholder(imageBitmap) {
  // placeholder: return null or very cheap representation
  return null;
}

// Main task: process incoming frame
async function processFrame({ jobId, meta = {}, imageBitmap, options = {} }) {
  const startTime = Date.now();
  
  try {
    // Emit progress
    postMessage({ event: 'progress', jobId, stage: 'processing_start', timestamp: startTime });

    // Decide mode: preview vs final
    const mode = options.mode || meta.mode || 'preview'; // 'preview' or 'final'
    const thumbMax = mode === 'final' ? 512 : DEFAULT_THUMB_MAX_SIDE;

    // Apply downsample scale if provided in options
    const downsampleScale = options.downsampleScale || 1.0;
    const effectiveThumbMax = Math.floor(thumbMax * downsampleScale);

    // Create thumbnail
    postMessage({ event: 'progress', jobId, stage: 'creating_thumbnail' });
    const { blob: thumbBlob, w, h } = await createThumbnailBlob(imageBitmap, effectiveThumbMax);

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
        downsampleScale: downsampleScale !== 1.0 ? downsampleScale : undefined
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
        sizeBytes: JSON.stringify({ phash, hashVersion, algorithm: 'aHash' }).length
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
        downsampleScale: downsampleScale !== 1.0 ? downsampleScale : undefined
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
      downsampleScale: downsampleScale !== 1.0 ? downsampleScale : undefined
    };
    
    postMessage(readyData);
    bc.postMessage(readyData);

    // Close the incoming ImageBitmap to free GPU resources
    try { imageBitmap.close(); } catch (e) {}
    
  } catch (err) {
    console.error('preprocessor.worker: processing failed', err);
    const errorData = { event: 'artifact:error', jobId, error: String(err), stack: err.stack };
    postMessage(errorData);
    bc.postMessage(errorData);
    try { imageBitmap.close(); } catch (e) {}
  }
}

// Handle reprocess requests (for future SDF/pose generation)
async function handleReprocess({ jobId, key, actions = [], priority = 0 }) {
  try {
    postMessage({ event: 'progress', jobId, stage: 'reprocess_start', key, actions });

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
      error: String(err) 
    });
  }
}

// Worker message handler
self.onmessage = async (ev) => {
  const msg = ev.data || {};
  
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
    processFrame({ jobId, meta, imageBitmap, options });
    
  } else if (msg.op === 'reprocess') {
    const { jobId, key, actions, priority } = msg;
    if (!storageReady) {
      postMessage({ event: 'reprocess:error', jobId, key, error: 'Storage not ready' });
      return;
    }
    handleReprocess({ jobId, key, actions, priority });
    
  } else if (msg.op === 'shutdown') {
    // Clean up any pending frames
    pendingFrames.forEach(({ imageBitmap }) => {
      try { imageBitmap.close(); } catch (e) {}
    });
    pendingFrames.length = 0;
    
    // Close broadcast channel
    try { bc.close(); } catch (e) {}
    
    postMessage({ event: 'worker:shutdown' });
    close();
    
  } else {
    // other ops
    console.debug('preprocessor.worker: unknown op', msg.op);
  }
};