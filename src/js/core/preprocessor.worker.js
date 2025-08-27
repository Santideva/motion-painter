// preprocessor.worker.js
// Module worker that receives ImageBitmap frames from the main thread wrapper,
// generates thumbnail + quick phash + manifest, writes artifacts to storage, and notifies main thread.
// Expects storage.js to be next to this file.

importScripts(); // no-op but keeps worker style clear; module workers support import()

// Import storage functions (works because this is a module worker and webpack bundles it)
import {
  initStorage,
  putInboundArtifact,
  // getArtifact,
  // other exports if needed...
} from './storage.js';

const BROADCAST_CHANNEL = 'motion-painter-store';
const bc = new BroadcastChannel(BROADCAST_CHANNEL);

// Worker config
const DEFAULT_THUMB_MAX_SIDE = 256;

// Initialize storage from worker side (safe; on first call this will open db)
initStorage({ quota: undefined, startEvictor: true }).catch(err => {
  console.warn('preprocessor.worker: storage init failed', err);
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
  try {
    // Decide mode: preview vs final
    const mode = options.mode || meta.mode || 'preview'; // 'preview' or 'final'
    const thumbMax = mode === 'final' ? 512 : DEFAULT_THUMB_MAX_SIDE;

    // Create thumbnail
    const { blob: thumbBlob, w, h } = await createThumbnailBlob(imageBitmap, thumbMax);

    // compute phash (aHash here)
    // For phash we can compute from the thumbnail (fast)
    // create a small bitmap from the blob
    const thumbBitmap = await createImageBitmap(thumbBlob);
    const phash = await computeAHashFromBitmap(thumbBitmap, 8);
    try { thumbBitmap.close(); } catch (e) {}

    // small manifest data
    const srcHash = meta.srcHash || `src-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    const frameNumber = meta.frameNumber || null;
    const timestamp = meta.timestamp || Date.now();
    const thumbKey = `thumb:${srcHash}:${w}x${h}`;
    const phashKey = `phash:${srcHash}`;
    const manifestKey = `manifest:${srcHash}`;

    const thumbArtifact = {
      key: thumbKey,
      type: 'thumbnail',
      blob: thumbBlob,
      meta: { srcHash, frameNumber, timestamp, sizeBytes: thumbBlob.size, origin: 'preprocessor', producer: 'preproc-v1' },
      createdAt: new Date().toISOString()
    };

    const phashArtifact = {
      key: phashKey,
      type: 'phash',
      data: { phash },
      meta: { srcHash, frameNumber, timestamp, producer: 'preproc-v1' },
      createdAt: new Date().toISOString()
    };

    const manifestArtifact = {
      key: manifestKey,
      type: 'manifest',
      data: { keys: [thumbKey, phashKey], frameNumber, timestamp, meta },
      meta: { srcHash, frameNumber, timestamp, producer: 'preproc-v1' },
      createdAt: new Date().toISOString()
    };

    // Write artifacts to storage
    await putInboundArtifact(thumbArtifact);
    await putInboundArtifact(phashArtifact);
    await putInboundArtifact(manifestArtifact);

    // Notify main thread and broadcast channel
    postMessage({ event: 'artifact:ready', jobId, keys: [thumbKey, phashKey, manifestKey], meta: { srcHash, frameNumber, timestamp } });
    bc.postMessage({ event: 'artifact:ready', jobId, keys: [thumbKey, phashKey, manifestKey], meta: { srcHash, frameNumber, timestamp } });

    // Close the incoming ImageBitmap to free GPU resources
    try { imageBitmap.close(); } catch (e) {}
  } catch (err) {
    console.error('preprocessor.worker: processing failed', err);
    postMessage({ event: 'artifact:error', jobId, error: String(err) });
    bc.postMessage({ event: 'artifact:error', jobId, error: String(err) });
    try { imageBitmap.close(); } catch (e) {}
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
    // Enqueue work (we process inline sequentially to avoid heavy concurrency)
    // For more concurrency, implement a queue and limit active tasks.
    processFrame({ jobId, meta, imageBitmap, options });
  } else if (msg.op === 'shutdown') {
    postMessage({ event: 'worker:shutdown' });
    close();
  } else {
    // other ops
    console.debug('preprocessor.worker: unknown op', msg.op);
  }
};
