// storage.js
// IndexedDB-backed, flux & calibration support, optimistic-versioning, robust eviction.

// featureFlags provides shared configuration for quota sizing, evictor authority,
// and critical-pressure eviction overrides. Guarded with try/catch at each call site
// since storage.js runs in many worker contexts where featureFlags' own
// localStorage/BroadcastChannel bootstrap falls back to in-memory defaults —
// fine here, since these are advisory reads, not writes.
import featureFlags from '../../config/featureFlags.js';

const DB_NAME = 'motionPainterDB';
const DB_VERSION = 7; // Incremented to add reconStatus store
const ARTIFACTS_STORE = 'artifacts';
const STREAMS_STORE = 'streams';
const COUNTERS_STORE = 'counters';
const ARTIFACT_PARTS_STORE = 'artifactParts';
const DEFAULT_QUOTA_BYTES = 1024 * 1024 * 1024; // 1 GB
const BROADCAST_CHANNEL_NAME = 'motion-painter-store';
const EVICT_BATCH = 8;

const FLUX_ARTIFACT_TYPE = 'motion-painter/flux-artifact';
const FLUX_ARTIFACT_VERSION = '1.0';
const PART_SIZE_THRESHOLD = 1 * 1024 * 1024; // 1MB threshold for creating parts
const MAX_INLINE_ARRAY_LENGTH = 10000; // Max elements to store inline
const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024; // 4MB chunks

let dbPromise = null;
let broadcast = null;
let evictIntervalId = null;
let evictIntervalMs = 10000;
let quotaBytes = DEFAULT_QUOTA_BYTES;

const activeObjectURLs = new Map();

console.log('storage.js: Loading storage module...');

// Metrics tracking
const _metrics = {
  pin_success: 0,
  pin_failure: 0,
  unpin_success: 0,
  unpin_failure: 0,
  promote_success: 0,
  promote_failure: 0,
  eviction_runs: 0,
  artifacts_evicted: 0
};

// ============================================================================
// STORAGE RETRY HELPER
// ============================================================================
/**
 * Retry wrapper for storage operations (handles transient IndexedDB errors)
 * 
 * TRANSIENT ERRORS:
 * - InvalidStateError: Connection closing during operation
 * - QuotaExceededError: Temporary quota exceeded (eviction in progress)
 * - Locked: Transaction collision (another tab/worker writing)
 * - Timeout: Slow disk I/O
 * 
 * @param {Function} putFn - Async function that performs the storage operation
 * @param {number} maxAttempts - Maximum retry attempts (default: 4)
 * @param {number} baseDelayMs - Base delay in ms for exponential backoff (default: 150)
 * @returns {Promise} Result of the storage operation
 * @throws {Error} If all retries exhausted or non-transient error encountered
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
      const isTransient = /invalidstateerror|database connection is closing|locked|quotaexceeded|timeout|networkerror/i.test(errMsg);
      
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

// Helper: Increment metric counter
const _incrementMetric = (metric, amount = 1) => {
  if (_metrics[metric] !== undefined) {
    _metrics[metric] += amount;
  }
};

// Helper: Broadcast pin/unpin/eviction events
const _broadcastPinEvent = (payload) => {
  if (!broadcast) return;
  
  try {
    broadcast.postMessage({
      ...payload,
      timestamp: payload.timestamp || Date.now(),
      source: 'storage.js'
    });
  } catch (err) {
    console.warn('storage: broadcast failed:', err);
  }
};

// *Binary Serialization Helpers

const BINARY_MAGIC = new Uint8Array([0x42, 0x49, 0x4E, 0x46]); // "BINF"

//  * isTypedArray(obj) -> boolean
const isTypedArray = (obj) => ArrayBuffer.isView(obj) && !(obj instanceof DataView);

//  * isSerializedTypedArray(blob) -> Promise<boolean>
const isSerializedTypedArray = async (blob) => {
  if (!(blob instanceof Blob) || blob.size < 12) return false;
  try {
    const headerBuf = await blob.slice(0, 4).arrayBuffer();
    const header = new Uint8Array(headerBuf);
    return header[0] === BINARY_MAGIC[0] && header[1] === BINARY_MAGIC[1] &&
           header[2] === BINARY_MAGIC[2] && header[3] === BINARY_MAGIC[3];
  } catch { return false; }
};

/* float16 conversion helpers */
const float32ToFloat16 = (val) => {
  const f32 = new Float32Array(1);
  f32[0] = val;
  const u32 = new Uint32Array(f32.buffer)[0];
  const sign = (u32 >> 31) & 0x1;
  let exp = ((u32 >> 23) & 0xff) - 127;
  let mant = u32 & 0x7fffff;

  if (exp <= -15) return sign << 15;
  if (exp > 16) return (sign << 15) | (0x1f << 10);
  exp = exp + 15;
  mant = mant >> 13;
  return (sign << 15) | (exp << 10) | (mant & 0x3ff);
};

const float16ToFloat32 = (h) => {
  const s = (h & 0x8000) >> 15;
  let e = (h & 0x7C00) >> 10;
  let f = h & 0x03FF;
  if (e === 0) {
    if (f === 0) return s ? -0 : 0;
    return (s ? -1 : 1) * (f / Math.pow(2, 24)) * Math.pow(2, -14);
  } else if (e === 31) {
    return f ? NaN : (s ? -Infinity : Infinity);
  }
  return (s ? -1 : 1) * (1 + f / 1024) * Math.pow(2, e - 15);
};

// ============================================================================
// ROBUST TYPED ARRAY SERIALIZATION (Enhanced for Parts System)
// ============================================================================

const TYPE_CODES = {
  'Int8Array': 1, 'Uint8Array': 2, 'Uint8ClampedArray': 3,
  'Int16Array': 4, 'Uint16Array': 5,
  'Int32Array': 6, 'Uint32Array': 7,
  'Float32Array': 8, 'Float64Array': 9,
  'BigInt64Array': 10, 'BigUint64Array': 11
};

const CODE_TO_TYPE = Object.fromEntries(
  Object.entries(TYPE_CODES).map(([k, v]) => [v, k])
);

/**
 * Create 13-byte serialization header (version 1)
 * Format: version[1] + MAGIC[4] + typeCode[1] + length[4] + bytesPerElement[2] + reserved[1]
 */
function _createSerializationHeader(typeName, elementLength, byteLength) {
  const header = new Uint8Array(13);
  header[0] = 1; // Version 1
  header.set(BINARY_MAGIC, 1); // bytes 1-4
  
  const typeCode = TYPE_CODES[typeName] || 0;
  header[5] = typeCode & 0xFF; // byte 5
  
  const dv = new DataView(header.buffer, 6, 7);
  dv.setUint32(0, elementLength || 0, true); // bytes 6-9 (little-endian)
  
  const bytesPerElement = elementLength ? Math.floor(byteLength / elementLength) : 0;
  dv.setUint16(4, bytesPerElement, true); // bytes 10-11
  
  // byte 12 reserved (zero)
  
  return header;
}

/**
 * serializeTypedArray(input, opts) -> { descriptor, parts }
 * 
 * Accepts:
 *  - TypedArray (Int8Array, Float32Array, etc.)
 *  - ArrayBuffer
 *  - Blob (pass-through)
 * 
 * Returns:
 *  - descriptor: { typedArrayType, length, byteLength, chunkCount, ... }
 *  - parts: [{ blob, offset, length }, ...]
 */
async function serializeTypedArray(input, { chunkSize = DEFAULT_CHUNK_SIZE } = {}) {
  // Case 1: Already a Blob → return as single part (pass-through)
  if (input instanceof Blob) {
    return {
      descriptor: {
        typedArrayType: null,
        length: null,
        byteLength: input.size,
        chunkCount: 1,
        asBlob: true,
        mimeType: input.type || 'application/octet-stream',
        schemaVersion: 1
      },
      parts: [{ blob: input, offset: 0, length: input.size }]
    };
  }

  // Case 2: TypedArray view → extract underlying buffer respecting offsets
  let buffer;
  let typeName = null;
  let elementLength = null;

  if (ArrayBuffer.isView(input) && !(input instanceof DataView)) {
    // TypedArray (Int8Array, Float32Array, etc.)
    typeName = input.constructor.name;
    elementLength = input.length;
    
    // CRITICAL: Respect byteOffset and byteLength (handles views/slices)
    buffer = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  } 
  else if (input instanceof ArrayBuffer) {
    // Raw ArrayBuffer
    buffer = input;
    typeName = 'ArrayBuffer';
    elementLength = null;
  }
  else {
    throw new Error(`serializeTypedArray: unsupported input type: ${input?.constructor?.name || typeof input}`);
  }

  // Chunking
  const totalBytes = buffer.byteLength;
  const parts = [];
  let offset = 0;

  while (offset < totalBytes) {
    const end = Math.min(totalBytes, offset + chunkSize);
    const slice = buffer.slice(offset, end);
    
    // Create blob with header (13 bytes) + payload
    const header = _createSerializationHeader(typeName, elementLength, slice.byteLength);
    const blob = new Blob([header, slice], { type: 'application/octet-stream' });
    
    parts.push({ 
      blob, 
      offset, 
      length: slice.byteLength 
    });
    
    offset = end;
  }

  return {
    descriptor: {
      typedArrayType: typeName,
      length: elementLength,
      byteLength: totalBytes,
      chunkCount: parts.length,
      chunkSize,
      mimeType: 'application/octet-stream',
      schemaVersion: 1
    },
    parts
  };
}

/**
 * deserializeTypedArray(input, opts) -> Promise<TypedArray|ArrayBuffer|Blob>
 * 
 * Accepts:
 *  - Blob (with header)
 *  - { descriptor, parts } where parts are Blob[] or partKey[]
 */
async function deserializeTypedArray(input, { fetchPartByKey = null } = {}) {
  // Case 1: Direct Blob
  if (input instanceof Blob) {
    return await _deserializeSingleBlob(input);
  }

  // Case 2: Descriptor + Parts
  if (!input || typeof input !== 'object') {
    throw new Error('deserializeTypedArray: input must be Blob or {descriptor, parts}');
  }

  const { descriptor, parts } = input;
  
  if (!descriptor) {
    throw new Error('deserializeTypedArray: missing descriptor');
  }

  // Collect part blobs
  const partBlobs = await _collectPartBlobs(parts, descriptor, fetchPartByKey);
  
  if (partBlobs.length === 0) {
    throw new Error('deserializeTypedArray: no parts available');
  }

  // Read all part buffers
  const buffers = await Promise.all(
    partBlobs.map(async (blob) => {
      // Each part has header + payload
      const headerBuf = await blob.slice(0, 13).arrayBuffer();
      const payloadBuf = await blob.slice(13).arrayBuffer();
      
      // Validate header
      const header = new Uint8Array(headerBuf);
      if (!_validateMagic(header)) {
        console.warn('deserializeTypedArray: invalid magic in part, treating as raw data');
        return blob.arrayBuffer();
      }
      
      return payloadBuf;
    })
  );

  // Concatenate buffers
  const totalBytes = buffers.reduce((sum, buf) => sum + buf.byteLength, 0);
  const concatenated = new Uint8Array(totalBytes);
  
  let offset = 0;
  for (const buf of buffers) {
    concatenated.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }

  // Reconstruct TypedArray
  const typeName = descriptor.typedArrayType;
  
  if (!typeName || typeName === 'ArrayBuffer') {
    return concatenated.buffer;
  }

  const TypedArrayClass = _getTypedArrayClass(typeName);
  
  if (!TypedArrayClass) {
    console.warn(`deserializeTypedArray: unknown type ${typeName}, returning ArrayBuffer`);
    return concatenated.buffer;
  }

  return new TypedArrayClass(concatenated.buffer);
}

/**
 * Deserialize a single blob with header
 */
async function _deserializeSingleBlob(blob) {
  if (blob.size < 13) {
    return await blob.arrayBuffer();
  }

  const headerBuf = await blob.slice(0, 13).arrayBuffer();
  const header = new Uint8Array(headerBuf);

  if (!_validateMagic(header)) {
    return await blob.arrayBuffer();
  }

  const version = header[0];
  if (version !== 1) {
    console.warn(`deserializeTypedArray: unknown version ${version}, treating as raw`);
    return await blob.slice(13).arrayBuffer();
  }

  const typeCode = header[5];
  const dv = new DataView(headerBuf, 6);
  const elementLength = dv.getUint32(0, true);
  const bytesPerElement = dv.getUint16(4, true);

  const TypedArrayClass = _getTypedArrayClass(CODE_TO_TYPE[typeCode]);
  
  if (!TypedArrayClass) {
    console.warn(`deserializeTypedArray: unknown type code ${typeCode}, returning ArrayBuffer`);
    return await blob.slice(13).arrayBuffer();
  }

  const payloadBuf = await blob.slice(13).arrayBuffer();
  
  const expectedBytes = elementLength * bytesPerElement;
  if (payloadBuf.byteLength < expectedBytes) {
    throw new Error(`deserializeTypedArray: truncated payload (expected ${expectedBytes}, got ${payloadBuf.byteLength})`);
  }

  return new TypedArrayClass(payloadBuf, 0, elementLength);
}

/**
 * Collect part blobs from various input formats
 */
async function _collectPartBlobs(parts, descriptor, fetchPartByKey) {
  const blobs = [];

  if (Array.isArray(parts) && parts.length > 0) {
    for (const part of parts) {
      if (part instanceof Blob) {
        blobs.push(part);
      } 
      else if (part && part.blob instanceof Blob) {
        blobs.push(part.blob);
      }
      else if (typeof part === 'string' && typeof fetchPartByKey === 'function') {
        const fetched = await fetchPartByKey(part);
        if (fetched instanceof Blob) blobs.push(fetched);
      }
      else {
        console.warn('deserializeTypedArray: skipping unsupported part format', part);
      }
    }
  }
  else if (Array.isArray(descriptor.chunkKeys) && typeof fetchPartByKey === 'function') {
    for (const key of descriptor.chunkKeys) {
      const fetched = await fetchPartByKey(key);
      if (fetched instanceof Blob) blobs.push(fetched);
    }
  }

  return blobs;
}

/**
 * Validate magic bytes (offset by 1 due to version byte)
 */
function _validateMagic(header) {
  return header.length >= 5 &&
         header[1] === BINARY_MAGIC[0] &&
         header[2] === BINARY_MAGIC[1] &&
         header[3] === BINARY_MAGIC[2] &&
         header[4] === BINARY_MAGIC[3];
}

/**
 * Get TypedArray class from name
 */
function _getTypedArrayClass(typeName) {
  const classes = {
    'Int8Array': Int8Array,
    'Uint8Array': Uint8Array,
    'Uint8ClampedArray': Uint8ClampedArray,
    'Int16Array': Int16Array,
    'Uint16Array': Uint16Array,
    'Int32Array': Int32Array,
    'Uint32Array': Uint32Array,
    'Float32Array': Float32Array,
    'Float64Array': Float64Array,
    'BigInt64Array': BigInt64Array,
    'BigUint64Array': BigUint64Array
  };
  
  return classes[typeName] || null;
}

// ============================================================================
// ARTIFACT PARTS STORAGE HELPERS
// ============================================================================

/**
 * Store parts in artifactParts store
 * @param {IDBDatabase} db
 * @param {IDBTransaction} tx - Transaction must include 'artifactParts'
 * @param {string} metaKey - Owner artifact key
 * @param {string} fieldName - Field name (e.g., 'SOCs', '_blob')
 * @param {Array} parts - [{blob, offset, length}, ...]
 * @returns {Promise<string[]>} Array of part keys
 */
async function _storeParts(db, tx, metaKey, fieldName, parts) {
  const store = tx.objectStore(ARTIFACT_PARTS_STORE);
  const keys = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const partKey = `${metaKey}:part:${fieldName}:${i}`;
    
    const record = {
      partKey,
      owner: metaKey,
      field: fieldName,
      index: i,
      blob: part.blob,
      size: part.length,
      createdAt: Date.now()
    };

    await new Promise((resolve, reject) => {
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error || new Error(`Failed to store part ${partKey}`));
    });

    keys.push(partKey);
  }

  return keys;
}

/**
 * Cleanup all parts for an artifact (used on error or delete)
 */
async function _cleanupPartsForArtifact(db, metaKey) {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(ARTIFACT_PARTS_STORE, 'readwrite');
      const store = tx.objectStore(ARTIFACT_PARTS_STORE);
      const index = store.index('owner');
      
      const range = IDBKeyRange.only(metaKey);
      const req = index.openCursor(range);
      
      let deleted = 0;
      
      req.onsuccess = (ev) => {
        const cursor = ev.target.result;
        if (cursor) {
          cursor.delete();
          deleted++;
          cursor.continue();
        } else {
          console.log(`_cleanupPartsForArtifact: deleted ${deleted} parts for ${metaKey}`);
          resolve(deleted);
        }
      };
      
      req.onerror = () => {
        console.warn('_cleanupPartsForArtifact: cursor error', req.error);
        reject(req.error);
      };
    } catch (err) {
      console.warn('_cleanupPartsForArtifact error', err);
      reject(err);
    }
  });
}

/**
 * Assemble a single field from parts
 */
async function _assembleSingleField(db, partRef) {
  if (!partRef || !partRef._partsRef) return partRef;

  const { descriptor, partKeys } = partRef;

  // Fetch part blobs
  const tx = db.transaction(ARTIFACT_PARTS_STORE, 'readonly');
  const store = tx.objectStore(ARTIFACT_PARTS_STORE);

  const partBlobs = await Promise.all(
    partKeys.map(async (partKey) => {
      return new Promise((resolve, reject) => {
        const req = store.get(partKey);
        req.onsuccess = () => resolve(req.result?.blob || null);
        req.onerror = () => reject(req.error);
      });
    })
  );

  // Filter out nulls (missing parts)
  const validBlobs = partBlobs.filter(b => b !== null);

  if (validBlobs.length === 0) {
    throw new Error('No valid parts found for field');
  }
  
  if (validBlobs.length < partKeys.length) {
    console.warn(`_assembleSingleField: ${partKeys.length - validBlobs.length} parts missing`);
  }

  // Deserialize
  return await deserializeTypedArray({ descriptor, parts: validBlobs });
}

/**
 * Assemble all fields with parts (used in getArtifact with assembleParts=true)
 */
async function _assembleAllParts(db, data) {
  if (!data || typeof data !== 'object') return data;

  const assembled = { ...data };

  for (const [fieldName, fieldValue] of Object.entries(data)) {
    if (fieldValue && fieldValue._partsRef) {
      try {
        assembled[fieldName] = await _assembleSingleField(db, fieldValue);
      } catch (err) {
        console.error(`Failed to assemble field ${fieldName}:`, err);
        // Keep part reference on error
        assembled[fieldName] = fieldValue;
      }
    }
  }

  return assembled;
}

//  Size Calculation Utilities
//  * calculateDataSize(data) -> number

const calculateDataSize = (data) => {
  if (data === null || data === undefined) return 0;
  if (typeof data === 'string') return data.length * 2; // UTF-16
  if (typeof data === 'number') return 8;
  if (typeof data === 'boolean') return 1;
  if (isTypedArray(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (data instanceof Blob) return data.size;
  if (Array.isArray(data)) return data.reduce((sum, item) => sum + calculateDataSize(item), 0);
  if (typeof data === 'object') {
    return Object.entries(data).reduce((sum, [key, value]) => 
      sum + key.length * 2 + calculateDataSize(value), 0);
  }
  return JSON.stringify(data).length * 2;
};

//  * calculateArtifactSize(artifact) -> number

const calculateArtifactSize = (artifact) => {
  let size = 0;
  if (artifact.blob) size += artifact.blob.size;
  if (artifact.data) size += calculateDataSize(artifact.data);
  if (artifact.meta) size += calculateDataSize(artifact.meta);
  size += (artifact.key?.length || 0) * 2;
  size += (artifact.type?.length || 0) * 2;
  size += (artifact.createdAt?.length || 0) * 2;
  return size;
};

// Data Normalization
//  * normalizeArtifactData(artifact, { blobThreshold = 10000 } = {})
//  * Returns the (possibly modified) artifact.

const normalizeArtifactData = async (artifact, { blobThreshold = 10000 } = {}) => {
  if (!artifact || !artifact.data) return artifact;

  try {
    // --- Case A: artifact.data is a typed array itself (top-level) ---
    if (isTypedArray(artifact.data)) {
      const ta = artifact.data;
      // If small, leave as-is
      if (ta.length < blobThreshold) {
        return artifact;
      }

      // Large: serialize typed-array (serializeTypedArray respects view offsets)
      try {
        const blob = serializeTypedArray(ta);
        artifact.blob = blob;
        artifact.meta = artifact.meta || {};
        artifact.meta.dataAsBlob = true;
        artifact.meta.originalDataType = ta.constructor.name;
        // store lightweight shape info if useful (caller may set width/height separately)
        artifact.meta.typedArrayLength = ta.length;
        // clear in-memory data to reduce memory usage
        artifact.data = null;
      } catch (err) {
        // If serialization fails, keep data in place and annotate
        artifact.meta = artifact.meta || {};
        artifact.meta.dataAsBlob = false;
        artifact.meta.normalizationError = `serialize-top-level-ta-failed:${err?.message || String(err)}`;
      }
      return artifact;
    }

    // --- Case B: artifact.data is an object (possibly containing typed arrays) ---
    if (typeof artifact.data === 'object' && artifact.data !== null) {
      const entries = Object.entries(artifact.data);
      // Detect large typed arrays
      const largeFields = [];
      for (const [key, val] of entries) {
        if (isTypedArray(val) && val.length >= blobThreshold) {
          largeFields.push({ key, ta: val });
        }
      }

      // If no large typed arrays, do nothing
      if (largeFields.length === 0) return artifact;

      // Build serialized parts for each large typed array (respecting view offsets)
      const parts = [];
      const structureDescriptor = {}; // describes where each field lives in blob (or inline)
      const boundaries = []; // cumulative end offsets

      // We'll also support leaving non-large fields inline in structureDescriptor as-is
      // First: copy current artifact.data keys to structureDescriptor (default)
      for (const [k, v] of entries) {
        structureDescriptor[k] = v;
      }

      // Serialize each large field and replace descriptor entry with __blobIndex metadata
      for (const { key, ta } of largeFields) {
        try {
          const partBlob = serializeTypedArray(ta);
          const idx = parts.length;
          parts.push(partBlob);

          // mark this field in structure descriptor as stored in the combined blob at index idx
          structureDescriptor[key] = {
            __blobIndex: idx,
            __type: ta.constructor.name,
            __length: ta.length,
            __bytesPerElement: ta.BYTES_PER_ELEMENT
          };
        } catch (err) {
          // On failure to serialize one field: leave it inline, record an error on meta
          artifact.meta = artifact.meta || {};
          artifact.meta.normalizationErrors = artifact.meta.normalizationErrors || [];
          artifact.meta.normalizationErrors.push({ field: key, error: err?.message || String(err) });
          // keep original value in structureDescriptor
          structureDescriptor[key] = ta;
        }
      }

      // If nothing serialized (all failed), do nothing
      if (parts.length === 0) return artifact;

      // Concatenate parts into a single blob and compute cumulative boundaries
      const concatenated = new Blob(parts, { type: 'application/octet-stream' });
      let offset = 0;
      for (const p of parts) {
        offset += p.size;
        boundaries.push(offset); // cumulative end offset for part i
      }

      // Store concatenated blob + metadata describing structure and boundaries
      artifact.blob = concatenated;
      artifact.meta = artifact.meta || {};
      artifact.meta.dataAsBlob = true;
      artifact.meta.blobStructure = structureDescriptor; // map of field -> descriptor or inline value
      artifact.meta.blobBoundaries = boundaries;         // [end1, end2, ...] indexes in concatenated blob
      artifact.meta.blobPartCount = parts.length;
      // Optionally record original top-level keys for convenience
      artifact.meta.dataKeys = Object.keys(artifact.data);

      // Drop in-memory large arrays to free memory and avoid duplication
      for (const { key } of largeFields) {
        try { delete artifact.data[key]; } catch (e) { artifact.data[key] = null; }
      }

      // If the remaining artifact.data has no useful entries left, null it out
      const leftoverKeys = Object.keys(artifact.data).filter(k => artifact.data[k] !== undefined && artifact.data[k] !== null);
      if (leftoverKeys.length === 0) {
        artifact.data = null;
      } else {
        // keep remaining inline fields in artifact.data (small typed arrays or other fields)
        artifact.data = artifact.data;
      }

      return artifact;
    }

    // Otherwise, nothing to normalize
    return artifact;
  } catch (err) {
    // Defensive: on unexpected error, annotate and return artifact unchanged
    artifact.meta = artifact.meta || {};
    artifact.meta.normalizationException = err?.message || String(err);
    return artifact;
  }
};

// * denormalizeArtifactData(artifact) -> Promise<artifact
// * Returns the artifact (possibly mutated with artifact.data restored). Does not remove blob/meta.

const denormalizeArtifactData = async (artifact) => {
  if (!artifact || !artifact.blob || !artifact.meta?.dataAsBlob) return artifact;

  try {
    // Helper to attempt to deserialize a blob slice into a typed array (safe)
    const tryDeserialize = async (b) => {
      try {
        // If the slice looks like our serialized typed-array format, deserialize
        if (await isSerializedTypedArray(b)) {
          return await deserializeTypedArray(b);
        }
        // Not in our format — return raw Uint8Array fallback
        const ab = await b.arrayBuffer();
        return new Uint8Array(ab);
      } catch (err) {
        console.warn('tryDeserialize: failed to deserialize part', err);
        return null;
      }
    };

    // Case A: simple top-level typed array serialized into the entire blob
    if (artifact.meta.originalDataType && !artifact.meta.blobStructure) {
      try {
        if (await isSerializedTypedArray(artifact.blob)) {
          artifact.data = await deserializeTypedArray(artifact.blob);
        } else {
          // Best-effort: return raw bytes as Uint8Array
          const ab = await artifact.blob.arrayBuffer();
          artifact.data = new Uint8Array(ab);
        }
      } catch (err) {
        console.warn('denormalizeArtifactData: failed to restore top-level typed array', err);
      }
      return artifact;
    }

    // Case B: structured blob with explicit boundaries + blobStructure descriptor
    if (artifact.meta.blobStructure && Array.isArray(artifact.meta.blobBoundaries) && typeof artifact.meta.blobPartCount === 'number') {
      const structure = artifact.meta.blobStructure;
      const boundaries = artifact.meta.blobBoundaries;
      const partCount = Math.max(0, Math.min(boundaries.length, artifact.meta.blobPartCount || boundaries.length));

      // Defensive: ensure boundaries monotonic and within blob size
      let last = 0;
      const blobSize = artifact.blob.size;
      const sanitizedBoundaries = [];
      for (let i = 0; i < partCount; i++) {
        let b = Number(boundaries[i]) || 0;
        if (b <= last) b = last; // clamp
        if (b > blobSize) b = blobSize;
        sanitizedBoundaries.push(b);
        last = b;
      }

      // Build slices for each part
      const parts = [];
      let start = 0;
      for (let i = 0; i < sanitizedBoundaries.length; i++) {
        const end = sanitizedBoundaries[i];
        parts.push(artifact.blob.slice(start, end));
        start = end;
      }

      // If there are more parts expected than boundaries provided, try to capture trailing remainder
      if (artifact.meta.blobPartCount && parts.length < artifact.meta.blobPartCount) {
        // capture remainder
        parts.push(artifact.blob.slice(start));
      }

      // Reconstruct data object
      const restored = {};
      for (const [key, desc] of Object.entries(structure)) {
        if (desc && typeof desc === 'object' && ('__blobIndex' in desc)) {
          const idx = Number(desc.__blobIndex);
          if (!Number.isNaN(idx) && idx >= 0 && idx < parts.length) {
            const partBlob = parts[idx];
            restored[key] = await tryDeserialize(partBlob);
            // Optionally attach shape meta for consumer convenience
            if (restored[key] && desc.__type) {
              restored[key].__restoredType = desc.__type;
              if (desc.__length) restored[key].__length = desc.__length;
            }
          } else {
            console.warn(`denormalizeArtifactData: invalid __blobIndex for key=${key} idx=${desc.__blobIndex}`);
            restored[key] = null;
          }
        } else {
          // Inline value (kept in meta.blobStructure) — copy it
          restored[key] = desc;
        }
      }

      artifact.data = restored;
      return artifact;
    }

    // Case C: fallback — no explicit boundaries, try to heuristically split concatenated blob
    // Look for the BINF magic header repeated inside the blob
    try {
      // Read the whole blob and search for magic markers
      const ab = await artifact.blob.arrayBuffer();
      const view = new Uint8Array(ab);
      const magic = BINARY_MAGIC; // [0x42, 0x49, 0x4E, 0x46]
      const indices = [];

      // Find all occurrences of the magic sequence
      for (let i = 0; i <= view.length - magic.length; i++) {
        let match = true;
        for (let j = 0; j < magic.length; j++) {
          if (view[i + j] !== magic[j]) { match = false; break; }
        }
        if (match) indices.push(i);
      }

      if (indices.length > 0) {
        // Build slices from indices (each index marks start of a serialized part)
        const slices = [];
        for (let k = 0; k < indices.length; k++) {
          const start = indices[k];
          const end = (k + 1 < indices.length) ? indices[k + 1] : view.length;
          const partBuf = ab.slice(start, end);
          const blobPart = new Blob([partBuf], { type: 'application/octet-stream' });
          slices.push(blobPart);
        }

        // If meta.blobStructure exists, map parts to keys by __blobIndex; otherwise create numbered fields
        if (artifact.meta.blobStructure && typeof artifact.meta.blobStructure === 'object') {
          const structure = artifact.meta.blobStructure;
          const restored = {};
          for (const [key, desc] of Object.entries(structure)) {
            if (desc && typeof desc === 'object' && ('__blobIndex' in desc)) {
              const idx = Number(desc.__blobIndex);
              if (!Number.isNaN(idx) && idx >= 0 && idx < slices.length) {
                restored[key] = await tryDeserialize(slices[idx]);
              } else {
                restored[key] = null;
              }
            } else {
              restored[key] = desc;
            }
          }
          artifact.data = restored;
          return artifact;
        } else {
          // No structure info — put parts into numeric keys
          const restored = {};
          for (let i = 0; i < slices.length; i++) {
            restored[`part_${i}`] = await tryDeserialize(slices[i]);
          }
          artifact.data = restored;
          return artifact;
        }
      }
    } catch (err) {
      // If heuristic fails, fall through to final fallback
      console.warn('denormalizeArtifactData: heuristic split failed', err);
    }

    // Final fallback: if blob itself looks like a serialized typed array, return that; otherwise return raw bytes
    try {
      if (await isSerializedTypedArray(artifact.blob)) {
        artifact.data = await deserializeTypedArray(artifact.blob);
      } else {
        const rawAb = await artifact.blob.arrayBuffer();
        artifact.data = new Uint8Array(rawAb);
      }
    } catch (err) {
      console.warn('denormalizeArtifactData: final fallback failed', err);
      // leave artifact.data untouched
    }

    return artifact;
  } catch (err) {
    console.warn('denormalizeArtifactData: unexpected error', err);
    return artifact;
  }
};

// Flux artifact helpers

const createFluxArtifact = ({ frameIndex = null, source = 'preprocessor', metadata = {}, payload = {} } = {}) => ({
  __type: FLUX_ARTIFACT_TYPE,
  __version: FLUX_ARTIFACT_VERSION,
  ts: Date.now(),
  frameIndex,
  source,
  metadata: metadata || {},
  payload: payload || {}
});

const isFluxArtifact = (obj) => 
  obj && typeof obj === 'object' &&
  obj.__type === FLUX_ARTIFACT_TYPE &&
  typeof obj.__version === 'string' &&
  typeof obj.ts === 'number' &&
  (!('metadata' in obj) || typeof obj.metadata === 'object') &&
  (!('payload' in obj) || typeof obj.payload === 'object') &&
  (!('frameIndex' in obj) || obj.frameIndex === null || typeof obj.frameIndex === 'number');

const serializeFluxArtifact = (obj) => {
  if (!isFluxArtifact(obj)) throw new Error('serializeFluxArtifact: not a valid flux artifact');
  return JSON.stringify(obj);
};

const deserializeFluxArtifact = (str) => {
  if (typeof str !== 'string') throw new Error('deserializeFluxArtifact: input must be string');
  let parsed;
  try { parsed = JSON.parse(str); } 
  catch (e) { throw new Error('deserializeFluxArtifact: parse error - ' + e.message); }
  if (!isFluxArtifact(parsed)) throw new Error('deserializeFluxArtifact: invalid flux artifact structure');
  return parsed;
};

// *readFluxFloat32(key, { denormalize = true })

const readFluxFloat32 = async (key, { denormalize = false } = {}) => {
  try {
    const art = await getArtifact(key, { denormalize });
    if (!art) return { ok: false, reason: 'NOT_FOUND' };

    const meta = art.meta || {};
    const w = Number(meta.width) || null;
    const h = Number(meta.height) || null;

    // Prefer blob if present
    if (art.blob) {
      // try to detect our serialized typed-array format
      if (await isSerializedTypedArray(art.blob)) {
        const ta = await deserializeTypedArray(art.blob);
        // Expect flux to be Float32Array (u,v interleaved) or Float32Array of length w*h*2
        if (!(ta instanceof Float32Array)) return { ok: false, reason: 'UNEXPECTED_TYPED_ARRAY', type: ta.constructor.name };
        if (w && h && ta.length !== w * h * 2) return { ok: false, reason: 'DIM_MISMATCH', details: { expected: w*h*2, got: ta.length } };
        return { ok: true, flux: ta, width: w, height: h, meta };
      }

      // If blob is not serialized typed array, we fallback to reading buffer and constructing Float32View
      const ab = await art.blob.arrayBuffer();
      const possible = new Float32Array(ab);
      if (w && h && possible.length !== w * h * 2) {
        // Could be float16 quantized packed as Uint16 — caller should set meta.quantized
        if (meta.quantized === 'f16' || meta.quantized === true) {
          // convert uint16 -> float32
          const view16 = new Uint16Array(ab);
          const out = new Float32Array(view16.length);
          for (let i = 0; i < view16.length; i++) out[i] = float16ToFloat32(view16[i]);
          if (out.length !== w * h * 2) return { ok: false, reason: 'DIM_MISMATCH_AFTER_DEQUANT', details: { expected: w*h*2, got: out.length } };
          return { ok: true, flux: out, width: w, height: h, meta };
        }
        return { ok: false, reason: 'DIM_MISMATCH', details: { expected: w*h*2, got: possible.length } };
      }
      return { ok: true, flux: possible, width: w, height: h, meta };
    }

    // If blob absent but data exists and payload contains typed array
    if (art.data && art.data.payload && ArrayBuffer.isView(art.data.payload)) {
      const ta = art.data.payload;
      if (!(ta instanceof Float32Array)) {
        // allow view to be convertible
        const out = new Float32Array(ta.buffer, ta.byteOffset, ta.byteLength / 4);
        return { ok: true, flux: out, width: w, height: h, meta };
      }
      if (w && h && ta.length !== w * h * 2) return { ok: false, reason: 'DIM_MISMATCH', details: { expected: w*h*2, got: ta.length } };
      return { ok: true, flux: ta, width: w, height: h, meta };
    }

    return { ok: false, reason: 'NO_PAYLOAD' };
  } catch (err) {
    return { ok: false, reason: 'EXCEPTION', error: err?.message ?? String(err) };
  }
};

// Calibration helpers

const normalizeTimestamp = (ts) => {
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    return isNaN(parsed) ? null : parsed;
  }
  return null;
};

const attachCalibrationMetaToArtifact = (artifact, calibMeta = {}) => {
  artifact.meta = artifact.meta || {};
  const now = Date.now();
  if (typeof calibMeta.calibrated === 'boolean') artifact.meta.calibrated = !!calibMeta.calibrated;
  if (calibMeta.ts) artifact.meta.calibTs = calibMeta.ts;
  else if (!artifact.meta.calibTs && artifact.createdAt) {
    artifact.meta.calibTs = normalizeTimestamp(artifact.createdAt) || now;
  } else if (!artifact.meta.calibTs) {
    artifact.meta.calibTs = now;
  }
  if (calibMeta.provider) artifact.meta.calibProvider = calibMeta.provider;
  if (calibMeta.params) artifact.meta.calibParams = calibMeta.params;
  if (!artifact.meta.calibNote) artifact.meta.calibNote = 'calib-meta-attached-by-storage';
  return artifact;
};

const isArtifactCalibrated = async (keyOrArtifact, { checkReferencedFrames = true, maxFrameChecks = 4 } = {}) => {
  let artifact = null;
  if (typeof keyOrArtifact === 'string') {
    artifact = await getArtifact(keyOrArtifact);
    if (!artifact) return { calibrated: false, reason: 'artifact-not-found', details: { key: keyOrArtifact } };
  } else if (typeof keyOrArtifact === 'object' && keyOrArtifact !== null) {
    artifact = keyOrArtifact;
  } else {
    return { calibrated: false, reason: 'invalid-arg' };
  }

  if (artifact.meta?.calibrated === true) {
    return { calibrated: true, reason: 'meta-calibrated-flag', 
             details: { calibTs: artifact.meta.calibTs, provider: artifact.meta.calibProvider } };
  }

  if (artifact.type === 'frame') {
    return { calibrated: false, reason: 'frame-no-calib-stamp', details: { key: artifact.key } };
  }

  if (artifact.type === FLUX_ARTIFACT_TYPE && checkReferencedFrames) {
    const refs = Array.isArray(artifact.meta?.frameRefs) ? artifact.meta.frameRefs.slice(0, maxFrameChecks) : [];
    if (refs.length === 0) return { calibrated: false, reason: 'flux-no-frameRefs' };

    const checks = await Promise.all(refs.map(async (k) => {
      const f = await getArtifact(k);
      if (!f) return { key: k, calibrated: false, reason: 'frame-missing' };
      if (f.meta?.calibrated === true) return { key: k, calibrated: true, reason: 'frame-calibrated' };
      return { key: k, calibrated: false, reason: 'frame-not-calibrated' };
    }));

    const allCalibrated = checks.every(c => c.calibrated === true);
    return allCalibrated 
      ? { calibrated: true, reason: 'flux-frames-all-calibrated', details: { frameChecks: checks } }
      : { calibrated: false, reason: 'flux-frames-not-all-calibrated', details: { frameChecks: checks } };
  }

  return { calibrated: false, reason: 'unknown-artifact-type-or-missing-meta' };
};

// IndexedDB: open + utils

const openDB = () => {
  if (dbPromise) return dbPromise;

  console.log('storage.js: Opening IndexedDB...');
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (ev) => {
      console.log('storage.js: Upgrading database schema...');
      const db = ev.target.result;
      const oldVersion = ev.oldVersion || 0;

      if (!db.objectStoreNames.contains(ARTIFACTS_STORE)) {
        const s = db.createObjectStore(ARTIFACTS_STORE, { keyPath: 'key' });
        s.createIndex('srcHash', 'meta.srcHash', { unique: false });
        s.createIndex('pinned', 'meta.pinned', { unique: false });
        s.createIndex('timestamp', 'meta.timestamp', { unique: false });
        s.createIndex('version', 'meta.version', { unique: false });
      } else if (oldVersion < 2) {
        const tx = ev.target.transaction;
        const s = tx.objectStore(ARTIFACTS_STORE);
        if (!s.indexNames.contains('timestamp')) s.createIndex('timestamp', 'meta.timestamp', { unique: false });
        if (!s.indexNames.contains('version')) s.createIndex('version', 'meta.version', { unique: false });
      }

      // When creating STREAMS_STORE (inside openDB onupgradeneeded)
      if (!db.objectStoreNames.contains(STREAMS_STORE)) {
        const s = db.createObjectStore(STREAMS_STORE, { keyPath: 'seq', autoIncrement: true });
        // Add indexes to allow efficient lookup
        try {
          s.createIndex('stream', 'stream', { unique: false });
          s.createIndex('createdAt', 'createdAt', { unique: false });
        } catch (e) {
          console.warn('storage.js: failed to create streams indexes', e);
        }
      } else if (oldVersion < 3) {
        // If streams existed but indexes not present, create them via existing transaction's objectStore
        const tx = ev.target.transaction;
        const s = tx.objectStore(STREAMS_STORE);
        if (!s.indexNames.contains('stream')) s.createIndex('stream', 'stream', { unique: false });
        if (!s.indexNames.contains('createdAt')) s.createIndex('createdAt', 'createdAt', { unique: false });
      }

      if (!db.objectStoreNames.contains(COUNTERS_STORE)) {
        db.createObjectStore(COUNTERS_STORE, { keyPath: 'id' });
      }
      // Version 3: Add reconStatus store (UPDATED: use reqId as primary key)
      if (oldVersion < 3) {
        if (!db.objectStoreNames.contains('reconStatus')) {
          const reconStore = db.createObjectStore('reconStatus', { keyPath: 'reqId' });
          reconStore.createIndex('metaKey', 'metaKey', { unique: false });
          reconStore.createIndex('state', 'state', { unique: false });
          reconStore.createIndex('startedAt', 'startedAt', { unique: false });
          console.log('storage.js: created reconStatus store (v3, reqId primary key)');
        }
      }
      
      // Version 4: Add artifactParts store
      if (oldVersion < 4) {
        if (!db.objectStoreNames.contains('artifactParts')) {
          const partsStore = db.createObjectStore('artifactParts', { keyPath: 'partKey' });
          partsStore.createIndex('owner', 'owner', { unique: false });
          partsStore.createIndex('createdAt', 'createdAt', { unique: false });
          partsStore.createIndex('field', 'field', { unique: false });
          console.log('storage.js: created artifactParts store (v4)');
        }
      }
      // Version 7: Add pins store (owner-based pin tracking)
      if (oldVersion < 7) {
        if (!db.objectStoreNames.contains('pins')) {
          const pinStore = db.createObjectStore('pins', { keyPath: 'id' });
          pinStore.createIndex('metaKey', 'metaKey', { unique: false });
          pinStore.createIndex('owner', 'owner', { unique: false });
          pinStore.createIndex('metaKeyOwner', ['metaKey', 'owner'], { unique: true });
          console.log('storage.js: created pins store (v7)');
        }
        
        if (!db.objectStoreNames.contains('work_queue')) {
          const workStore = db.createObjectStore('work_queue', { keyPath: 'metaKey' });
          workStore.createIndex('priority', 'priority', { unique: false });
          workStore.createIndex('status', 'status', { unique: false });
          workStore.createIndex('promotedAt', 'promotedAt', { unique: false });
          console.log('storage.js: created work_queue store (v7)');
        }
      }
    };

    req.onsuccess = () => {
      console.log('storage.js: Database opened successfully');
      resolve(req.result);
    };

    req.onerror = () => {
      console.error('storage.js: Database open failed:', req.error);
      reject(req.error);
    };
  });

  return dbPromise;
};

const ensureBroadcast = () => {
  if (!broadcast) {
    try {
      broadcast = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
      console.log('storage.js: BroadcastChannel created');
    } catch (err) {
      console.warn('storage.js: BroadcastChannel creation failed:', err);
      broadcast = null;
    }
  }
  return broadcast;
};

/* Counter helpers */

const getCounter = async (txOrDb, id) => {
  if (!txOrDb) return null;
  return new Promise((resolve) => {
    try {
      if (typeof txOrDb.objectStore === 'function') {
        const req = txOrDb.objectStore(COUNTERS_STORE).get(id);
        req.onsuccess = () => resolve(req.result?.value ?? null);
        req.onerror = () => resolve(null);
      } else if (typeof txOrDb.transaction === 'function') {
        const tx = txOrDb.transaction(COUNTERS_STORE, 'readonly');
        const req = tx.objectStore(COUNTERS_STORE).get(id);
        req.onsuccess = () => resolve(req.result?.value ?? null);
        req.onerror = () => resolve(null);
      } else {
        resolve(null);
      }
    } catch (err) {
      console.warn('getCounter fallback error', err);
      resolve(null);
    }
  });
};

const putCounter = async (tx, id, value) => new Promise((resolve, reject) => {
  try {
    const req = tx.objectStore(COUNTERS_STORE).put({ id, value });
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  } catch (err) {
    reject(err);
  }
});

// --------------------- pinRef / unpinRef helpers ---------------------
async function pinRef(txOrDb, key) {
  const id = `pinref:${key}`;
  // Helper to perform put inside a transaction objectstore
  const doPut = (store) => new Promise((resolve, reject) => {
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const cur = (getReq.result && getReq.result.value) || 0;
      const next = cur + 1;
      const putReq = store.put({ id, value: next });
      putReq.onsuccess = () => resolve(next);
      putReq.onerror = () => reject(putReq.error || new Error('pinRef put failed'));
    };
    getReq.onerror = () => reject(getReq.error || new Error('pinRef get failed'));
  });

  // If caller passed a transaction-like object (or db), handle accordingly
  if (!txOrDb) {
    // Open a temporary transaction
    const db = await openDB(); // assumes openDB() helper exists in storage.js
    const tx = db.transaction(COUNTERS_STORE, 'readwrite');
    const result = await doPut(tx.objectStore(COUNTERS_STORE));
    return result;
  }

  if (typeof txOrDb.transaction === 'function') {
    const tx = txOrDb.transaction(COUNTERS_STORE, 'readwrite');
    return await doPut(tx.objectStore(COUNTERS_STORE));
  }

  // Otherwise assume txOrDb is an object store already
  return await doPut(txOrDb);
}

async function unpinRef(txOrDb, key) {
  const id = `pinref:${key}`;
  const doGet = (store) => new Promise((resolve, reject) => {
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const cur = (getReq.result && getReq.result.value) || 0;
      const next = Math.max(0, cur - 1);
      const putReq = store.put({ id, value: next });
      putReq.onsuccess = () => resolve(next);
      putReq.onerror = () => reject(putReq.error || new Error('unpinRef put failed'));
    };
    getReq.onerror = () => reject(getReq.error || new Error('unpinRef get failed'));
  });

  if (!txOrDb) {
    const db = await openDB();
    const tx = db.transaction(COUNTERS_STORE, 'readwrite');
    const result = await doGet(tx.objectStore(COUNTERS_STORE));
    return result;
  }

  if (typeof txOrDb.transaction === 'function') {
    const tx = txOrDb.transaction(COUNTERS_STORE, 'readwrite');
    return await doGet(tx.objectStore(COUNTERS_STORE));
  }

  return await doGet(txOrDb);
}

// Optional utility: read current refcount (for diagnostics)
async function getPinRef(key) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(COUNTERS_STORE, 'readonly');
      const store = tx.objectStore(COUNTERS_STORE);
      const req = store.get(`pinref:${key}`);
      req.onsuccess = () => resolve((req.result && req.result.value) || 0);
      req.onerror = () => reject(req.error || new Error('getPinRef failed'));
    });
  } catch (err) {
    console.warn('getPinRef failed', err);
    return 0;
  }
}

// Initialization

const initStorage = async ({ quota, startEvictor = true } = {}) => {
  // Resolve quota from explicit param → shared featureFlags value → hardcoded default.
  // Previously each call site (main.js: 2GB, preprocessor.worker.js: 500MB) hardcoded
  // its own value while writing to the SAME underlying IndexedDB totalBytes counter,
  // guaranteeing a permanent false "CRITICAL quota pressure" once the full pipeline's
  // legitimate working set exceeded the smallest configured ceiling.
  let resolvedQuota = quota;
  if (!Number.isFinite(resolvedQuota)) {
    try {
      resolvedQuota = featureFlags.getFlag('storageQuotaBytes') || DEFAULT_QUOTA_BYTES;
    } catch (e) {
      resolvedQuota = DEFAULT_QUOTA_BYTES;
    }
  }

  // Respect storageEvictorAuthority: only the designated context (default 'main')
  // runs the periodic evictor loop. Contexts that still pass startEvictor:true are
  // silently downgraded to avoid uncoordinated evictors racing on shared IDB state.
  let resolvedStartEvictor = startEvictor;
  try {
    const authority = featureFlags.getFlag('storageEvictorAuthority') ?? 'main';
    if (authority === 'none') resolvedStartEvictor = false;
  } catch (e) {
    // featureFlags unavailable — fall back to caller's explicit value
  }

  console.log('storage.js: Initializing storage with quota:', resolvedQuota, 'startEvictor:', resolvedStartEvictor);
  try {
    quotaBytes = resolvedQuota;
    await openDB();
    ensureBroadcast();

    const db = await openDB();
    const tx = db.transaction(COUNTERS_STORE, 'readwrite');
    const s = tx.objectStore(COUNTERS_STORE);

    const getReq = s.get('totalBytes');
    getReq.onsuccess = () => { if (!getReq.result) s.put({ id: 'totalBytes', value: 0 }); };
    
    const pinnedReq = s.get('pinnedBytes');
    pinnedReq.onsuccess = () => { if (!pinnedReq.result) s.put({ id: 'pinnedBytes', value: 0 }); };

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => {
        console.log('storage.js: Storage initialization completed');
        if (resolvedStartEvictor) startEvictorLoop();
        resolve();
      };
      tx.onerror = () => {
        console.warn('storage.js: Counters init tx failed:', tx.error);
        if (resolvedStartEvictor) startEvictorLoop();
        reject(tx.error);
      };
    });
  } catch (err) {
    console.error('storage.js: Storage initialization failed:', err);
    throw err;
  }
};

// Versioning / optimistic locking


const incrementVersion = (artifact) => {
  artifact.meta = artifact.meta || {};
  artifact.meta.version = (artifact.meta.version || 0) + 1;
  artifact.meta.lastModified = Date.now();
  return artifact;
};

const validateVersion = (existing, incoming) => {
  if (!existing?.meta || !incoming?.meta) return true;
  if (typeof existing.meta.version !== 'number' || typeof incoming.meta.version !== 'number') return true;
  return existing.meta.version === incoming.meta.version;
};

// Calibration update (async helper)

const updateCalibrationAsync = async (key, calibResult) => {
  if (!calibResult || typeof calibResult.calibrated !== 'boolean') {
    console.warn('updateCalibrationAsync: invalid calibResult', calibResult);
    return { ok: false, reason: 'invalid-args' };
  }

  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(ARTIFACTS_STORE, 'readwrite');
      const store = tx.objectStore(ARTIFACTS_STORE);
      const getReq = store.get(key);

      getReq.onsuccess = () => {
        const stored = getReq.result;
        if (!stored) return resolve({ ok: false, reason: 'not-found' });

        const currentCalib = stored.meta?.calibrated === true;
        if (currentCalib === calibResult.calibrated) return resolve({ ok: true, noChange: true });

        incrementVersion(stored);
        stored.meta = stored.meta || {};
        stored.meta.calibrated = calibResult.calibrated;
        stored.meta.calibVerifiedAt = Date.now();
        stored.meta.calibReason = calibResult.reason;
        if (calibResult.details) stored.meta.calibDetails = calibResult.details;

        const putReq = store.put(stored);
        putReq.onsuccess = () => resolve({ ok: true, updated: true });
        putReq.onerror = () => {
          console.warn('updateCalibrationAsync: put failed', putReq.error);
          resolve({ ok: false, reason: 'put-error' });
        };
      };

      getReq.onerror = () => resolve({ ok: false, reason: 'get-error' });

      tx.oncomplete = () => {
        const bc = ensureBroadcast();
        if (bc) {
          bc.postMessage({
            event: 'artifact:calib-verified',
            key,
            meta: { verified: calibResult.calibrated, reason: calibResult.reason, details: calibResult.details }
          });
        }
      };

      tx.onerror = () => console.warn('updateCalibrationAsync: transaction error', tx.error);
    });
  } catch (err) {
    console.warn('updateCalibrationAsync: exception', err);
    return { ok: false, reason: 'exception', error: err };
  }
};

// Core artifact APIs

const putInboundArtifact = async (artifact) => {
  const db = await openDB();
  const timestamp = Date.now();
  const timestampISO = new Date(timestamp).toISOString();

  // Generate metaKey if not provided
  let metaKey = artifact.key;
  if (!metaKey) {
    const sourceHash = artifact.meta?.sourceMetaKey 
      ? artifact.meta.sourceMetaKey.split(':').pop() 
      : timestamp.toString(36);
    metaKey = `artifact:${artifact.type}:${sourceHash}:${timestamp}`;
  }

  let art = {
    key: metaKey,
    type: artifact.type,
    blob: artifact.blob || null,
    data: artifact.data || null,
    meta: artifact.meta || {},
    createdAt: artifact.createdAt || timestampISO
  };

  // PART ANALYSIS & SPLITTING
    const partsSummary = {
    created: 0,
    totalBytes: 0,
    fields: []
  };

  let partsToStore = []; // Collect all parts to store in transaction

  try {
    // Analyze artifact.blob (top-level TypedArray)
    if (isTypedArray(artifact.blob)) {
      const ta = artifact.blob;
      
      if (ta.byteLength > PART_SIZE_THRESHOLD || ta.length > MAX_INLINE_ARRAY_LENGTH) {
        console.log(`[parts] Serializing top-level typed array: ${ta.constructor.name} (${ta.byteLength} bytes)`);
        
        const { descriptor, parts } = await serializeTypedArray(ta);
        
        // Queue parts for storage
        partsToStore.push({ fieldName: '_blob', parts });
        
        // Replace blob with part reference
        art.blob = null;
        art.data = art.data || {};
        art.data._blob = {
          _partsRef: true,
          descriptor,
          partKeys: [] // Will be filled after storage
        };
        
        partsSummary.created += parts.length;
        partsSummary.totalBytes += ta.byteLength;
        partsSummary.fields.push('_blob');
      }
    }

    // Analyze artifact.data (object with potential TypedArray fields)
    if (art.data && typeof art.data === 'object') {
      for (const [fieldName, fieldValue] of Object.entries(art.data)) {
        if (isTypedArray(fieldValue)) {
          const ta = fieldValue;
          
          // Decision: split if large
          if (ta.byteLength > PART_SIZE_THRESHOLD || ta.length > MAX_INLINE_ARRAY_LENGTH) {
            console.log(`[parts] Serializing field '${fieldName}': ${ta.constructor.name} (${ta.byteLength} bytes)`);
            
            const { descriptor, parts } = await serializeTypedArray(ta);
            
            // Queue parts for storage
            partsToStore.push({ fieldName, parts });
            
            // Replace field with part reference (partKeys filled later)
            art.data[fieldName] = {
              _partsRef: true,
              descriptor,
              partKeys: []
            };
            
            partsSummary.created += parts.length;
            partsSummary.totalBytes += ta.byteLength;
            partsSummary.fields.push(fieldName);
          }
        }
      }
    }

  } catch (serializeErr) {
    console.error('[parts] Serialization failed', serializeErr);
    throw new Error(`Artifact serialization failed: ${serializeErr.message}`);
  }

  // STORE ARTIFACT RECORD + PARTS (Single Transaction)
  // Calculate metadata
  incrementVersion(art);
  art.meta.timestamp = timestamp;
  art.meta.reservedUntil = timestamp + 30000;
  art.meta.sizeBytes = calculateArtifactSize(art);
  
  if (partsSummary.created > 0) {
    art.meta.hasParts = true;
    art.meta.partsSummary = partsSummary;
    art.meta.partsSchemaVersion = 1;
  }

  // Type-specific normalization
  try {
    if (art.type === 'frame') {
      if (art.meta.calibTs || art.meta.calibProvider || art.meta.calibrated) {
        attachCalibrationMetaToArtifact(art, {
          calibrated: !!art.meta.calibrated,
          ts: art.meta.calibTs || art.meta.calibratedAt || null,
          provider: art.meta.calibProvider || art.meta.calibSource || null,
          params: art.meta.calibParams || null
        });
      } else {
        art.meta.calibrated = !!art.meta.calibrated;
      }
    }

    if (art.type === FLUX_ARTIFACT_TYPE) {
      art.meta = art.meta || {};
      art.meta.isFluxArtifact = true;
      art.meta.requiresCalibration = true;

      let normalized = null;
      if (typeof art.data === 'string') {
        try {
          normalized = deserializeFluxArtifact(art.data);
        } catch (e) {
          art.meta.validationError = (art.meta.validationError || []).concat([`deserialize-error:${e.message}`]);
        }
      } else if (art.data && typeof art.data === 'object') {
        normalized = isFluxArtifact(art.data) ? art.data : createFluxArtifact({
          frameIndex: art.meta.frameNumber || art.meta.frameIndex || null,
          source: art.meta.source || 'inbound',
          metadata: { ...(art.meta || {}) },
          payload: art.data.payload || art.data
        });
      } else {
        normalized = createFluxArtifact({
          frameIndex: art.meta.frameNumber || art.meta.frameIndex || null,
          source: art.meta.source || 'inbound',
          metadata: { ...(art.meta || {}) },
          payload: {}
        });
        art.meta.validationNote = 'auto-created-empty-flux-payload';
      }

      if (normalized && isFluxArtifact(normalized)) {
        art.data = normalized;
        art.meta.calibrated = !!art.meta.calibrated;
        if (!Array.isArray(art.meta.frameRefs)) art.meta.frameRefs = normalized.metadata?.frameRefs || [];
      } else {
        art.meta.calibrated = false;
        art.meta.validationError = art.meta.validationError || ['invalid-flux-artifact'];
      }
    }
  } catch (err) {
    art.meta.validationError = (art.meta.validationError || [])
      .concat([`normalization-exception:${err?.message ?? String(err)}`]);
  }

  return new Promise((resolve, reject) => {
    // Transaction includes both stores
    const storeNames = partsToStore.length > 0 
      ? [ARTIFACTS_STORE, ARTIFACT_PARTS_STORE, STREAMS_STORE, COUNTERS_STORE]
      : [ARTIFACTS_STORE, STREAMS_STORE, COUNTERS_STORE];
    
    const tx = db.transaction(storeNames, 'readwrite');
    const artifacts = tx.objectStore(ARTIFACTS_STORE);
    const streams = tx.objectStore(STREAMS_STORE);
    const counters = tx.objectStore(COUNTERS_STORE);

    const getReq = artifacts.get(art.key);

    getReq.onsuccess = async () => {
      const existing = getReq.result;

      if (existing) {
        // UPDATE PATH
        if (existing.meta?.hasParts || art.meta?.hasParts) {
          tx.abort();
          return resolve({ 
            ok: false, 
            reason: 'PARTS_UPDATE_NOT_SUPPORTED',
            hint: 'Delete artifact and recreate to change parts'
          });
        }

        const oldSize = existing.meta?.sizeBytes || 0;
        const newSize = art.meta.sizeBytes;
        const sizeDelta = newSize - oldSize;

        incrementVersion(existing);
        existing.meta = { ...existing.meta, ...art.meta };
        if (art.blob) existing.blob = art.blob;
        if (art.data) existing.data = art.data;
        existing.meta.sizeBytes = newSize;

        const putReq = artifacts.put(existing);
        
        putReq.onsuccess = () => {
          const totalReq = counters.get('totalBytes');
          totalReq.onsuccess = () => {
            const cur = totalReq.result?.value || 0;
            counters.put({ id: 'totalBytes', value: Math.max(0, cur + sizeDelta) });
          };
        };
        
        putReq.onerror = () => { 
          tx.abort(); 
          reject(new Error('Failed to update artifact: ' + putReq.error)); 
        };

        tx.oncomplete = () => {
          ensureBroadcast()?.postMessage({ event: 'artifact:ready', key: art.key, meta: existing.meta });
          resolve({ ok: true, metaKey: art.key, reused: true, partsCreated: 0 });
        };

        tx.onerror = () => reject(tx.error);
        return;
      }

    // CREATE PATH
    try {
    // Store parts FIRST (before artifact record)
      for (const { fieldName, parts } of partsToStore) {
      const partKeys = await _storeParts(db, tx, metaKey, fieldName, parts);
      // Update part references with actual keys
      if (fieldName === '_blob') {
        art.data._blob.partKeys = partKeys;
      } else {
        art.data[fieldName].partKeys = partKeys;
      }
    }

    // Now store artifact record
    incrementVersion(art);
    let createdStreamSeq = null;

    const putReq = artifacts.put(art);
    
    putReq.onsuccess = () => {
      const streamReq = streams.add({ 
        stream: 'inbound', 
        key: art.key, 
        priority: 0, 
        createdAt: timestampISO 
      });
      
      streamReq.onsuccess = () => { createdStreamSeq = streamReq.result; };
      streamReq.onerror = () => console.warn('Failed to create stream entry:', streamReq.error);

      // Update totalBytes counter (include parts size)
      const totalReq = counters.get('totalBytes');
      totalReq.onsuccess = () => {
        const cur = totalReq.result?.value || 0;
        const totalSize = art.meta.sizeBytes + partsSummary.totalBytes;
        counters.put({ id: 'totalBytes', value: cur + totalSize });
      };
    };

    putReq.onerror = () => { 
      tx.abort(); 
      reject(new Error('Failed to store artifact: ' + putReq.error)); 
    };

    tx.oncomplete = () => {
      // Broadcast artifact:ready event (unchanged)
      ensureBroadcast()?.postMessage({ 
        event: 'artifact:ready', 
        key: art.key, 
        meta: art.meta 
      });
      
      // ============================================================================
      // CONDITIONAL EVICTION BASED ON QUOTA UTILIZATION
      // ============================================================================
      // Strategy:
      // - NORMAL (<85%):   Skip immediate eviction, rely on periodic (every 10s)
      // - HIGH (85-95%):   Delayed eviction (100ms) - gives consumers time to claim
      // - CRITICAL (>95%): Immediate eviction - prevents quota overflow
      //
      // Gated behind storageQuotaCheckOnWrite (default false) — this check
      // previously ran on EVERY artifact write (3 writes/frame in preprocessor.worker),
      // opening an extra readonly transaction each time purely to log/decide, which
      // duplicated the periodic evictor and was the source of the repeated
      // "NORMAL quota pressure" log spam. Routine maintenance is left to the
      // periodic evictor loop.
      // ============================================================================
      let _quotaCheckOnWrite = false;
      try {
        _quotaCheckOnWrite = !!featureFlags.getFlag('storageQuotaCheckOnWrite');
      } catch (e) { /* featureFlags unavailable — default false, skip immediate check */ }

      if (_quotaCheckOnWrite) (async () => {
        try {
          // Read current quota utilization (requires new read-only transaction)
          const readTx = db.transaction(['counters'], 'readonly');
          const countersStore = readTx.objectStore('counters');
          
          const totalBytesEntry = await new Promise((resolve, reject) => {
            const req = countersStore.get('totalBytes');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          
          const totalBytes = totalBytesEntry?.value || 0;
          const utilization = totalBytes / quotaBytes;
          
          if (utilization > 0.95) {
            // CRITICAL PRESSURE (>95%): delay eviction to allow pending IDB reads
            // (topology.worker, ambi.worker etc.) to acquire their readonly
            // transactions before the eviction readwrite lock blocks them.
            // RECON_DONE dispatches topology immediately after the last artifact
            // write — without this delay, the eviction readwrite transaction
            // starts before topology.worker can open IDB, causing a 20s hang.
            console.warn(
              `storage: CRITICAL quota pressure (${(utilization * 100).toFixed(1)}%), ` +
              `scheduling eviction in 5s (${(totalBytes / (1024 * 1024)).toFixed(1)}MB / ${(quotaBytes / (1024 * 1024)).toFixed(1)}MB)`
            );
            setTimeout(() => {
              checkQuotaAndEvict().catch(err =>
                console.error('storage: critical eviction failed', err)
              );
            }, 5_000);

          } else if (utilization > 0.85) {
            // HIGH PRESSURE (85-95%): same delay — fixes the duplicate else-if
            // bug where this branch was previously unreachable.
            console.log(
              `storage: HIGH quota pressure (${(utilization * 100).toFixed(1)}%), ` +
              `scheduling eviction in 5s`
            );
            setTimeout(() => {
              checkQuotaAndEvict().catch(err =>
                console.warn('storage: delayed eviction failed', err)
              );
            }, 5_000);
            
          } else {
            // ========================================
            // NORMAL PRESSURE (<85%)
            // ========================================
            // Risk: Low, plenty of headroom
            // Action: No immediate eviction
            // Benefit: Zero race condition risk
            // Cleanup: Periodic evictor (every 10s) handles maintenance
            // ========================================
            if (totalBytes > 50 * 1024 * 1024) { // Only log if >50MB (reduce noise)
              console.debug(
                `storage: NORMAL quota pressure (${(utilization * 100).toFixed(1)}%), ` +
                `skipping immediate eviction (${(totalBytes / (1024 * 1024)).toFixed(1)}MB / ${(quotaBytes / (1024 * 1024)).toFixed(1)}MB)`
              );
            }
            // No action - rely on periodic eviction (startEvictorLoop runs every 10s)
          }
          
        } catch (err) {
          // ========================================
          // ERROR HANDLING
          // ========================================
          // If quota check fails, default to safe behavior:
          // Run immediate eviction (conservative, prevents overflow)
          // ========================================
          console.warn('storage: quota utilization check failed, running immediate eviction as fallback', err);
          
          checkQuotaAndEvict().catch(evictErr => 
            console.error('storage: fallback eviction also failed', evictErr)
          );
        }
      })();
      
      // Resolve the putInboundArtifact promise (unchanged)
      resolve({ ok: true, metaKey: art.key, partsCreated: partsSummary.created });
    };

    tx.onerror = () => {
      console.error('Transaction error during artifact creation:', tx.error);
      reject(tx.error);
    };

  } catch (partsErr) {
    tx.abort();
    console.error('[parts] Failed to store parts:', partsErr);
    reject(new Error(`Failed to store parts: ${partsErr.message}`));
  }
};

getReq.onerror = () => {
  tx.abort();
  reject(new Error('Failed to check existing artifact: ' + getReq.error));
};
});
};

const reserveArtifact = async (key, { owner = 'unknown', leaseMs = 5 * 60 * 1000 } = {}) => {
  const now = Date.now();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(ARTIFACTS_STORE, 'readwrite');
    const s = tx.objectStore(ARTIFACTS_STORE);
    const req = s.get(key);

    req.onsuccess = () => {
      const art = req.result;
      if (!art) { tx.abort(); return resolve({ ok: false, reason: 'NOT_FOUND' }); }

      const reservedUntil = art.meta?.reservedUntil || 0;
      if (reservedUntil > now) { tx.abort(); return resolve({ ok: false, reason: 'ALREADY_RESERVED', reservedUntil }); }

      const leaseToken = generateToken();
      incrementVersion(art);

      art.meta = art.meta || {};
      Object.assign(art.meta, { reservedUntil: now + leaseMs, leaseOwner: owner, leaseToken });

      const putReq = s.put(art);
      putReq.onerror = () => { tx.abort(); reject(new Error('Failed to reserve artifact: ' + putReq.error)); };

      tx.oncomplete = () => {
        ensureBroadcast()?.postMessage({ event: 'artifact:reserved', key, owner, reservedUntil: art.meta.reservedUntil });
        resolve({ ok: true, leaseToken, reservedUntil: art.meta.reservedUntil });
      };

      tx.onerror = () => reject(tx.error);
    };

    req.onerror = () => { tx.abort(); reject(new Error('Failed to get artifact for reservation: ' + req.error)); };
  });
};

const releaseReservation = async (key, leaseToken) => {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(ARTIFACTS_STORE, 'readwrite');
    const s = tx.objectStore(ARTIFACTS_STORE);
    const req = s.get(key);

    req.onsuccess = () => {
      const art = req.result;
      if (!art) { tx.abort(); return resolve({ ok: false, reason: 'NOT_FOUND' }); }
      if (!art.meta || art.meta.leaseToken !== leaseToken) { 
        tx.abort(); 
        return resolve({ ok: false, reason: 'INVALID_TOKEN' }); 
      }

      incrementVersion(art);
      delete art.meta.leaseToken;
      delete art.meta.leaseOwner;
      art.meta.reservedUntil = 0;
      art.meta.status = 'available';

      const putReq = s.put(art);
      putReq.onerror = () => { tx.abort(); reject(new Error('Failed to release reservation: ' + putReq.error)); };

      tx.oncomplete = () => {
        ensureBroadcast()?.postMessage({ event: 'artifact:released', key });
        resolve({ ok: true });
      };

      tx.onerror = () => reject(tx.error);
    };

    req.onerror = () => { tx.abort(); reject(new Error('Failed to get artifact for release: ' + req.error)); };
  });
};

const pinArtifact = async (key, { owner = 'unknown', type = 'soft', ttlMs = null } = {}) => {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction([ARTIFACTS_STORE, COUNTERS_STORE, 'pins'], 'readwrite');
    const artifacts = tx.objectStore(ARTIFACTS_STORE);
    const counters = tx.objectStore(COUNTERS_STORE);
    const pinStore = tx.objectStore('pins');

    const getReq = artifacts.get(key);

    getReq.onsuccess = () => {
      const artifact = getReq.result;

      if (!artifact) {
        tx.abort();
        resolve({ ok: false, reason: 'artifact_not_found', metaKey: key });
        return;
      }

      // Calculate expiration time
      const now = Date.now();
      const expiresAt = ttlMs ? (now + ttlMs) : null;

      // Check if this owner already has a pin
      const pinId = `pin:${key}:${owner}`;
      const existingPinReq = pinStore.get(pinId);

      existingPinReq.onsuccess = () => {
        const existingPin = existingPinReq.result;

        if (existingPin) {
          // Owner already has a pin - refresh it (extend TTL)
          existingPin.type = type;
          existingPin.pinnedAt = now;
          existingPin.expiresAt = expiresAt; // Extend TTL on refresh
          
          const updateReq = pinStore.put(existingPin);
          
          updateReq.onsuccess = () => {
            _broadcastPinEvent({
              event: 'artifact:pinned',
              metaKey: key,
              owner,
              type,
              ttlMs,
              expiresAt,
              refreshed: true
            });

            _incrementMetric('pin_success');
            resolve({ ok: true, metaKey: key, owner, type, refreshed: true, expiresAt });
          };
          
          updateReq.onerror = () => {
            tx.abort();
            _incrementMetric('pin_failure');
            reject(new Error('Failed to update pin: ' + updateReq.error));
          };
          
          return;
        }

        // Create new pin entry
        const pinEntry = {
          id: pinId,
          metaKey: key,
          owner,
          type,
          pinnedAt: now,
          expiresAt,
          producer: owner,
          reason: `pinned_by_${owner}`,
          artifactSize: artifact.meta?.sizeBytes || 0
        };

        const pinPutReq = pinStore.put(pinEntry);

        pinPutReq.onsuccess = () => {
          // Increment global refcount
          const refCountId = `pinref:${key}`;
          const refReq = counters.get(refCountId);

          refReq.onsuccess = () => {
            const currentCount = refReq.result?.count || 0;
            const newCount = currentCount + 1;

            const putCountReq = counters.put({
              id: refCountId,
              count: newCount,
              lastUpdated: now
            });

            putCountReq.onsuccess = () => {
              // Mark artifact as pinned (first pin only)
              if (newCount === 1 && !artifact.meta.pinned) {
                artifact.meta.pinned = true;
                artifact.meta.pinnedAt = now;

                const pbReq = counters.get('pinnedBytes');
                pbReq.onsuccess = () => {
                  const pinnedBytes = pbReq.result?.value || 0;
                  counters.put({ id: 'pinnedBytes', value: pinnedBytes + (artifact.meta?.sizeBytes || 0) });
                };

                artifacts.put(artifact);
              }

              _broadcastPinEvent({
                event: 'artifact:pinned',
                metaKey: key,
                owner,
                type,
                ttlMs,
                expiresAt,
                newPin: true
              });

              _incrementMetric('pin_success');
              resolve({ ok: true, metaKey: key, owner, type, newPin: true, refCount: newCount, expiresAt });
            };

            putCountReq.onerror = () => {
              tx.abort();
              _incrementMetric('pin_failure');
              reject(new Error('Failed to update refcount: ' + putCountReq.error));
            };
          };

          refReq.onerror = () => {
            tx.abort();
            _incrementMetric('pin_failure');
            reject(new Error('Failed to get refcount: ' + refReq.error));
          };
        };

        pinPutReq.onerror = () => {
          tx.abort();
          _incrementMetric('pin_failure');
          reject(new Error('Failed to create pin: ' + pinPutReq.error));
        };
      };

      existingPinReq.onerror = () => {
        tx.abort();
        _incrementMetric('pin_failure');
        reject(new Error('Failed to check existing pin: ' + existingPinReq.error));
      };
    };

    getReq.onerror = () => {
      tx.abort();
      _incrementMetric('pin_failure');
      reject(new Error('Failed to get artifact: ' + getReq.error));
    };

    tx.onerror = () => {
      _incrementMetric('pin_failure');
      reject(new Error('Transaction failed: ' + tx.error));
    };
  });
};


const unpinArtifact = async (key, { owner = null } = {}) => {
  const db = await openDB();

  // IMPORTANT: Require owner parameter for safety
  if (!owner) {
    console.error('storage.unpinArtifact: owner parameter required');
    _incrementMetric('unpin_failure');
    return { ok: false, reason: 'owner_required', metaKey: key };
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction([ARTIFACTS_STORE, COUNTERS_STORE, 'pins'], 'readwrite');
    const artifacts = tx.objectStore(ARTIFACTS_STORE);
    const counters = tx.objectStore(COUNTERS_STORE);
    const pinStore = tx.objectStore('pins');

    const pinId = `pin:${key}:${owner}`;
    const getPinReq = pinStore.get(pinId);

    getPinReq.onsuccess = () => {
      const pinEntry = getPinReq.result;

      if (!pinEntry) {
        tx.abort();
        _incrementMetric('unpin_failure');
        resolve({ ok: false, reason: 'pin_not_found', metaKey: key, owner });
        return;
      }

      // Delete this owner's pin
      const deletePinReq = pinStore.delete(pinId);

      deletePinReq.onsuccess = () => {
        // Decrement global refcount
        const refCountId = `pinref:${key}`;
        const refReq = counters.get(refCountId);

        refReq.onsuccess = () => {
          const currentCount = refReq.result?.count || 0;
          const newCount = Math.max(0, currentCount - 1);

          const putCountReq = counters.put({
            id: refCountId,
            count: newCount,
            lastUpdated: Date.now()
          });

          putCountReq.onsuccess = () => {
            // If refcount reaches zero, unpin artifact
            if (newCount === 0) {
              const getArtReq = artifacts.get(key);

              getArtReq.onsuccess = () => {
                const artifact = getArtReq.result;

                if (artifact && artifact.meta.pinned) {
                  artifact.meta.pinned = false;
                  delete artifact.meta.pinnedAt;

                  const pbReq = counters.get('pinnedBytes');
                  pbReq.onsuccess = () => {
                    const pinnedBytes = pbReq.result?.value || 0;
                    counters.put({ id: 'pinnedBytes', value: Math.max(0, pinnedBytes - (artifact.meta?.sizeBytes || 0)) });
                  };

                  artifacts.put(artifact);
                }

                _broadcastPinEvent({
                  event: 'artifact:unpinned',
                  metaKey: key,
                  owner,
                  reason: 'manual'
                });

                _incrementMetric('unpin_success');
                resolve({ ok: true, metaKey: key, owner, refCount: newCount, fullyUnpinned: true });
              };

              getArtReq.onerror = () => {
                _incrementMetric('unpin_success');
                resolve({ ok: true, metaKey: key, owner, refCount: newCount, artifactFetchFailed: true });
              };
            } else {
              _incrementMetric('unpin_success');
              resolve({ ok: true, metaKey: key, owner, refCount: newCount, fullyUnpinned: false });
            }
          };

          putCountReq.onerror = () => {
            tx.abort();
            _incrementMetric('unpin_failure');
            reject(new Error('Failed to update refcount: ' + putCountReq.error));
          };
        };

        refReq.onerror = () => {
          tx.abort();
          _incrementMetric('unpin_failure');
          reject(new Error('Failed to get refcount: ' + refReq.error));
        };
      };

      deletePinReq.onerror = () => {
        tx.abort();
        _incrementMetric('unpin_failure');
        reject(new Error('Failed to delete pin: ' + deletePinReq.error));
      };
    };

    getPinReq.onerror = () => {
      tx.abort();
      _incrementMetric('unpin_failure');
      reject(new Error('Failed to get pin: ' + getPinReq.error));
    };

    tx.onerror = () => {
      _incrementMetric('unpin_failure');
      reject(new Error('Transaction failed: ' + tx.error));
    };
  });
};

/**
 * Get all LIVE (non-expired) pins for a metaKey
 * Automatically garbage-collects expired pins IN SAME TRANSACTION
 */
const getPins = async (metaKey) => {
  const db = await openDB();

  try {
    const tx = db.transaction(['pins', COUNTERS_STORE, ARTIFACTS_STORE], 'readwrite');
    const pinStore = tx.objectStore('pins');
    const counterStore = tx.objectStore(COUNTERS_STORE);
    const artifactStore = tx.objectStore(ARTIFACTS_STORE);
    const index = pinStore.index('metaKey');

    return new Promise((resolve, reject) => {
      const req = index.getAll(metaKey);

      req.onsuccess = () => {
        const allPins = req.result || [];
        const now = Date.now();
        const livePins = [];
        let expiredCount = 0;

        // Separate live vs expired pins and delete expired ones
        for (const pin of allPins) {
          if (pin.expiresAt && pin.expiresAt < now) {
            // Expired - delete in same transaction
            pinStore.delete(pin.id);
            expiredCount++;
          } else {
            // Live - include in results
            livePins.push({
              owner: pin.owner,
              type: pin.type,
              pinnedAt: pin.pinnedAt,
              expiresAt: pin.expiresAt,
              producer: pin.producer,
              reason: pin.reason
            });
          }
        }

        // Decrement refcount and update artifact if expired pins were found
        if (expiredCount > 0) {
          console.log(`storage: garbage-collected ${expiredCount} expired pins for ${metaKey}`);

          const refCountId = `pinref:${metaKey}`;
          const refReq = counterStore.get(refCountId);

          refReq.onsuccess = () => {
            const currentCount = refReq.result?.count || 0;
            const newCount = Math.max(0, currentCount - expiredCount);

            counterStore.put({
              id: refCountId,
              count: newCount,
              lastUpdated: now
            });

            // If refcount reaches zero, unpin artifact
            if (newCount === 0) {
              const getArtReq = artifactStore.get(metaKey);

              getArtReq.onsuccess = () => {
                const artifact = getArtReq.result;

                if (artifact && artifact.meta.pinned) {
                  artifact.meta.pinned = false;
                  delete artifact.meta.pinnedAt;

                  const pbReq = counterStore.get('pinnedBytes');
                  pbReq.onsuccess = () => {
                    const pinnedBytes = pbReq.result?.value || 0;
                    counterStore.put({ id: 'pinnedBytes', value: Math.max(0, pinnedBytes - (artifact.meta?.sizeBytes || 0)) });
                  };

                  artifactStore.put(artifact);
                }
              };
            }
          };
        }

        tx.oncomplete = () => {
          resolve(livePins);
        };
      };

      req.onerror = () => {
        reject(new Error('Failed to get pins: ' + req.error));
      };

      tx.onerror = () => {
        reject(new Error('Transaction failed: ' + tx.error));
      };
    });

  } catch (err) {
    console.error('storage.getPins error:', err);
    return [];
  }
};

/**
 * Get pin refcount for a metaKey
 */
const getPinRefCount = async (metaKey) => {
  const db = await openDB();

  try {
    const tx = db.transaction([COUNTERS_STORE], 'readonly');
    const counterStore = tx.objectStore(COUNTERS_STORE);

    return new Promise((resolve, reject) => {
      const refCountId = `pinref:${metaKey}`;
      const req = counterStore.get(refCountId);

      req.onsuccess = () => {
        const count = req.result?.count || 0;
        resolve(count);
      };

      req.onerror = () => {
        reject(new Error('Failed to get refcount: ' + req.error));
      };
    });

  } catch (err) {
    console.error('storage.getPinRefCount error:', err);
    return 0;
  }
};

/**
 * Promote multi-part artifact to work queue (prevents eviction)
 */
const promoteToWork = async (key, { consumerId = 'unknown', priority = 0 } = {}) => {
  const db = await openDB();

  try {
    const tx = db.transaction([ARTIFACTS_STORE, 'work_queue'], 'readwrite');
    const artifactStore = tx.objectStore(ARTIFACTS_STORE);
    const workStore = tx.objectStore('work_queue');

    return new Promise((resolve, reject) => {
      const getReq = artifactStore.get(key);

      getReq.onsuccess = () => {
        const artifact = getReq.result;

        if (!artifact) {
          tx.abort();
          resolve({ ok: false, reason: 'artifact_not_found', metaKey: key });
          return;
        }

        // Mark artifact as promoted
        artifact.meta.promoted = true;
        artifact.meta.promotedAt = Date.now();
        artifact.meta.promotedBy = consumerId;

        const putArtReq = artifactStore.put(artifact);

        putArtReq.onsuccess = () => {
          // Add to work queue
          const workEntry = {
            metaKey: key,
            priority,
            promotedAt: Date.now(),
            consumerId,
            status: 'pending',
            partsCount: artifact.meta.hasParts ? (artifact.meta.partsSummary?.created || 0) : 0
          };

          const putWorkReq = workStore.put(workEntry);

          putWorkReq.onsuccess = () => {
            console.log(`storage: ⬆️ Promoted ${key} to work queue (priority=${priority})`);
            
            _broadcastPinEvent({
              event: 'artifact:promoted',
              metaKey: key,
              consumerId,
              priority
            });

            _incrementMetric('promote_success');
            resolve({ ok: true, metaKey: key, priority });
          };

          putWorkReq.onerror = () => {
            tx.abort();
            _incrementMetric('promote_failure');
            reject(new Error('Failed to add to work queue: ' + putWorkReq.error));
          };
        };

        putArtReq.onerror = () => {
          tx.abort();
          _incrementMetric('promote_failure');
          reject(new Error('Failed to mark artifact as promoted: ' + putArtReq.error));
        };
      };

      getReq.onerror = () => {
        tx.abort();
        _incrementMetric('promote_failure');
        reject(new Error('Failed to get artifact: ' + getReq.error));
      };

      tx.onerror = () => {
        _incrementMetric('promote_failure');
        reject(new Error('Transaction failed: ' + tx.error));
      };
    });

  } catch (err) {
    console.error('storage.promoteToWork error:', err);
    _incrementMetric('promote_failure');
    return { ok: false, reason: err.message, metaKey: key };
  }
};

/**
 * Complete work and demote artifact from work queue
 */
const completeWork = async (metaKey, { success = true } = {}) => {
  const db = await openDB();

  try {
    const tx = db.transaction([ARTIFACTS_STORE, 'work_queue'], 'readwrite');
    const artifactStore = tx.objectStore(ARTIFACTS_STORE);
    const workStore = tx.objectStore('work_queue');

    return new Promise((resolve, reject) => {
      const deleteWorkReq = workStore.delete(metaKey);

      deleteWorkReq.onsuccess = () => {
        const getArtReq = artifactStore.get(metaKey);

        getArtReq.onsuccess = () => {
          const artifact = getArtReq.result;

          if (artifact && artifact.meta.promoted) {
            artifact.meta.promoted = false;
            artifact.meta.completedAt = Date.now();
            artifact.meta.completedSuccess = success;
            delete artifact.meta.promotedAt;
            delete artifact.meta.promotedBy;

            artifactStore.put(artifact);
          }

          console.log(`storage: completed work for ${metaKey} (success=${success})`);
          resolve({ ok: true, metaKey, success });
        };

        getArtReq.onerror = () => {
          resolve({ ok: true, metaKey, artifactUpdateFailed: true });
        };
      };

      deleteWorkReq.onerror = () => {
        tx.abort();
        reject(new Error('Failed to remove from work queue: ' + deleteWorkReq.error));
      };

      tx.onerror = () => {
        reject(new Error('Transaction failed: ' + tx.error));
      };
    });

  } catch (err) {
    console.error('storage.completeWork error:', err);
    return { ok: false, reason: err.message, metaKey };
  }
};

/**
 * Alias for completeWork
 */
const demoteFromWork = async (metaKey, options = {}) => {
  return completeWork(metaKey, options);
};

/**
 * ADMIN ONLY: Force unpin all owners (for recovery/debugging)
 */
const unpinAll = async (metaKey, { force = false } = {}) => {
  if (!force) {
    console.error('storage.unpinAll: force flag required for safety');
    return { ok: false, reason: 'force_flag_required', metaKey };
  }

  try {
    const livePins = await getPins(metaKey);

    if (livePins.length === 0) {
      return { ok: true, metaKey, unpinned: 0 };
    }

    console.warn(`storage: ADMIN unpinAll for ${metaKey}, removing ${livePins.length} pins`);

    let unpinned = 0;
    for (const pin of livePins) {
      try {
        const result = await unpinArtifact(metaKey, { owner: pin.owner });
        if (result.ok) unpinned++;
      } catch (err) {
        console.warn(`storage: failed to unpin owner ${pin.owner}:`, err);
      }
    }

    _broadcastPinEvent({
      event: 'artifact:force_unpinned',
      metaKey,
      unpinned,
      timestamp: Date.now()
    });

    return { ok: true, metaKey, unpinned };

  } catch (err) {
    console.error('storage.unpinAll error:', err);
    return { ok: false, reason: err.message, metaKey };
  }
};

/**
 * Explicitly bump artifact recency without fetching
 */
const touchArtifact = async (metaKey) => {
  const db = await openDB();

  try {
    const tx = db.transaction([ARTIFACTS_STORE], 'readwrite');
    const store = tx.objectStore(ARTIFACTS_STORE);

    return new Promise((resolve, reject) => {
      const req = store.get(metaKey);

      req.onsuccess = () => {
        const artifact = req.result;

        if (!artifact) {
          tx.abort();
          resolve({ ok: false, reason: 'not_found', metaKey });
          return;
        }

        artifact.meta.lastAccessed = Date.now();
        store.put(artifact);

        tx.oncomplete = () => {
          resolve({ ok: true, metaKey });
        };
      };

      req.onerror = () => {
        tx.abort();
        reject(req.error);
      };

      tx.onerror = () => {
        reject(tx.error);
      };
    });

  } catch (err) {
    console.error('storage.touchArtifact error:', err);
    return { ok: false, reason: err.message, metaKey };
  }
};

/**
 * ADMIN: Get all pinned artifacts
 */
const getPinnedArtifacts = async () => {
  const db = await openDB();

  try {
    const tx = db.transaction(['pins', ARTIFACTS_STORE], 'readonly');
    const pinStore = tx.objectStore('pins');
    const artifactStore = tx.objectStore(ARTIFACTS_STORE);

    return new Promise((resolve, reject) => {
      const getAllReq = pinStore.getAll();

      getAllReq.onsuccess = async () => {
        const allPins = getAllReq.result || [];
        const now = Date.now();
        
        const pinsByArtifact = new Map();
        
        for (const pin of allPins) {
          if (pin.expiresAt && pin.expiresAt < now) continue;
          
          if (!pinsByArtifact.has(pin.metaKey)) {
            pinsByArtifact.set(pin.metaKey, []);
          }
          pinsByArtifact.get(pin.metaKey).push({
            owner: pin.owner,
            type: pin.type,
            pinnedAt: pin.pinnedAt,
            expiresAt: pin.expiresAt
          });
        }

        const result = [];
        for (const [metaKey, pins] of pinsByArtifact.entries()) {
          const artifact = await new Promise((res) => {
            const getReq = artifactStore.get(metaKey);
            getReq.onsuccess = () => res(getReq.result);
            getReq.onerror = () => res(null);
          });

          result.push({
            metaKey,
            type: artifact?.type,
            sizeBytes: artifact?.sizeBytes,
            pinCount: pins.length,
            pins
          });
        }

        resolve(result);
      };

      getAllReq.onerror = () => {
        reject(new Error('Failed to get pinned artifacts'));
      };
    });

  } catch (err) {
    console.error('storage.getPinnedArtifacts error:', err);
    return [];
  }
};

/**
 * ADMIN: Get current work queue
 */
const getWorkQueue = async () => {
  const db = await openDB();

  try {
    const tx = db.transaction(['work_queue'], 'readonly');
    const workStore = tx.objectStore('work_queue');
    const priorityIndex = workStore.index('priority');

    return new Promise((resolve, reject) => {
      const req = priorityIndex.getAll();

      req.onsuccess = () => {
        const queue = req.result || [];
        resolve(queue.sort((a, b) => b.priority - a.priority));
      };

      req.onerror = () => {
        reject(new Error('Failed to get work queue'));
      };
    });

  } catch (err) {
    console.error('storage.getWorkQueue error:', err);
    return [];
  }
};

/**
 * Get metrics snapshot
 */
const getMetrics = () => {
  return { ..._metrics };
};

const getArtifact = async (key, { denormalize = false, assembleParts = true } = {}) => {
  const db = await openDB();
  
  const artifact = await new Promise((resolve) => {
    try {
      const req = db.transaction(ARTIFACTS_STORE, 'readonly')
        .objectStore(ARTIFACTS_STORE)
        .get(key);
      
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => {
        console.warn('Failed to get artifact:', req.error);
        resolve(null);
      };
    } catch (err) {
      console.warn('getArtifact error', err);
      resolve(null);
    }
  });

  if (!artifact) return null;

  // ============================================================================
  // AUTO-ASSEMBLY OF PARTS (if present and requested)
  // ============================================================================
  
  if (artifact.meta?.hasParts && assembleParts) {
    try {
      artifact.data = await _assembleAllParts(db, artifact.data);
      console.log(`[parts] Assembled artifact ${key} (${artifact.meta.partsSummary?.created || 0} parts)`);
    } catch (assemblyErr) {
      console.error(`[parts] Failed to assemble parts for ${key}:`, assemblyErr);
      // Return artifact with part references intact
    }
  }

  // Legacy denormalize behavior (for backward compatibility)
  if (denormalize && !artifact.meta?.hasParts) {
    return await denormalizeArtifactData(artifact);
  }

  return artifact;
};

/**
 * fetchPartByKey (PUBLIC API)
 * 
 * Fetch a single part blob by key
 * 
 * @param {string} partKey - Part key (e.g., 'flux:123:part:SOCs:0')
 * @returns {Promise<Blob|null>}
 */
const fetchPartByKey = async (partKey) => {
  const db = await openDB();
  
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(ARTIFACT_PARTS_STORE, 'readonly');
      const store = tx.objectStore(ARTIFACT_PARTS_STORE);
      const req = store.get(partKey);
      
      req.onsuccess = () => {
        const record = req.result;
        resolve(record?.blob || null);
      };
      
      req.onerror = () => {
        console.warn('fetchPartByKey failed:', req.error);
        resolve(null);
      };
    } catch (err) {
      console.warn('fetchPartByKey error:', err);
      resolve(null);
    }
  });
};
 
/**
 * Get reconstruction status for metaKey
 * 
 * Priority logic:
 * 1. If any 'running' job exists → return it (deduplication)
 * 2. If only 'done' jobs exist → return most recent (cache check)
 * 3. If only 'failed' jobs exist → return most recent (retry decision)
 * 
 * @param {string} metaKey - Artifact key
 * @returns {Promise<Object|null>} Status object or null if not found
 */
const getReconStatus = async (metaKey) => {
  const db = await openDB();
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(['reconStatus'], 'readonly');
      const store = tx.objectStore('reconStatus');
      
      // Query all records for this metaKey
      const index = store.index('metaKey');
      const req = index.getAll(metaKey);
      
      req.onsuccess = () => {
        const records = req.result || [];
        
        if (records.length === 0) {
          resolve(null);
          return;
        }
        
        // PRIORITY 1: Return any running job (deduplication)
        const runningJobs = records.filter(r => r.state === 'running');
        if (runningJobs.length > 0) {
          // If multiple running jobs (shouldn't happen but defensive), return most recent
          const mostRecentRunning = runningJobs.reduce((latest, current) => {
            return (current.startedAt > latest.startedAt) ? current : latest;
          });
          resolve(mostRecentRunning);
          return;
        }
        
        // PRIORITY 2: Return most recent 'done' job (cache hit)
        const doneJobs = records.filter(r => r.state === 'done');
        if (doneJobs.length > 0) {
          const mostRecentDone = doneJobs.reduce((latest, current) => {
            return (current.finishedAt > latest.finishedAt) ? current : latest;
          });
          resolve(mostRecentDone);
          return;
        }
        
        // PRIORITY 3: Return most recent 'failed' job (retry decision)
        const failedJobs = records.filter(r => r.state === 'failed');
        if (failedJobs.length > 0) {
          const mostRecentFailed = failedJobs.reduce((latest, current) => {
            return (current.finishedAt > latest.finishedAt) ? current : latest;
          });
          resolve(mostRecentFailed);
          return;
        }
        
        // FALLBACK: Return most recent of any state
        const mostRecent = records.reduce((latest, current) => {
          const latestTime = latest.finishedAt || latest.startedAt;
          const currentTime = current.finishedAt || current.startedAt;
          return (currentTime > latestTime) ? current : latest;
        });
        resolve(mostRecent);
      };
      
      req.onerror = () => {
        console.warn('getReconStatus: failed to get status', req.error);
        resolve(null);
      };
    } catch (err) {
      console.warn('getReconStatus error', err);
      resolve(null);
    }
  });
};

/**
 * Atomically mark reconstruction as running
 * Handles race conditions and stale-job takeover
 * @param {string} metaKey - Artifact key
 * @param {string} reqId - Request ID (worker owner)
 * @param {number} maxRuntimeMs - Max runtime before considering stale (default 10 min)
 * @returns {Promise<{ok: boolean, rec?: Object, reason?: string, existing?: Object, runtime?: number}>}
 */
const markReconRunning = async (metaKey, reqId, maxRuntimeMs = 600000) => {
  const db = await openDB();
  
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(['reconStatus'], 'readwrite');
      const store = tx.objectStore('reconStatus');
      
      // Query by metaKey index (not primary key anymore)
      const index = store.index('metaKey');
      const getReq = index.get(metaKey);
      
      getReq.onsuccess = () => {
        const existing = getReq.result;
        const now = Date.now();
        
        // Check if already running
        if (existing && existing.state === 'running') {
          const runtime = now - existing.startedAt;
          
          // Stale-job takeover
          if (runtime < maxRuntimeMs) {
            resolve({ 
              ok: false, 
              reason: 'running', 
              existing,
              runtime 
            });
            return;
          } else {
            console.warn(`storage: taking over stale job ${metaKey} (runtime: ${runtime}ms)`);
          }
        }
        
        // Remove any stale prior records for this metaKey so the reaper
        // doesn't find old 'running' entries and cause heartbeat-restore churn.
        // IDBIndex.openCursor iterates all records for this metaKey.
        const cleanupCursor = index.openCursor(IDBKeyRange.only(metaKey));
        cleanupCursor.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            const old = cursor.value;
            // Delete any prior record that isn't this new reqId and isn't 'done'
            if (old.reqId !== reqId && old.state !== 'done') {
              cursor.delete();
            }
            cursor.continue();
          }
        };
        // Create or update record (use reqId as primary key)
        const rec = {
          reqId,                                    // PRIMARY KEY
          metaKey,                                  // Indexed field
          state: 'running',
          attempts: (existing?.attempts || 0) + 1,
          startedAt: now,
          lastHeartbeat: now,                       // INITIALIZE heartbeat
          deadline: now + maxRuntimeMs,             // REAPER GUARD — without this,
                                                    // deadline is undefined and the
                                                    // reaper kills the job immediately
                                                    // every 60s, causing constant
                                                    // heartbeat-restore IDB churn
          finishedAt: null,
          lastError: null,
          nextRetryAt: null,
          derivedKeys: existing?.derivedKeys || []
        };
        
        const putReq = store.put(rec);
        
        putReq.onsuccess = () => {
          resolve({ ok: true, rec });
        };
        
        putReq.onerror = () => {
          reject(putReq.error || new Error('markReconRunning: put failed'));
        };
      };
      
      getReq.onerror = () => {
        reject(getReq.error || new Error('markReconRunning: get failed'));
      };
    } catch (err) {
      console.warn('markReconRunning error', err);
      reject(err);
    }
  });
};

/**
 * Update heartbeat timestamp for running reconstruction
 * @param {string} reqId - Request ID (primary key)
 * @returns {Promise<Object|null>} Updated status or null if not found/running
 */
const markReconHeartbeat = async (reqId) => {
  const db = await openDB();
  
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(['reconStatus'], 'readwrite');
      const store = tx.objectStore('reconStatus');
      const getReq = store.get(reqId);
      
      getReq.onsuccess = () => {
        const rec = getReq.result;
        
        // Validation: must exist and be running
        if (!rec) {
          console.warn(`markReconHeartbeat: no record found for reqId ${reqId}`);
          resolve(null);
          return;
        }
        
        if (rec.state !== 'running') {
        if (rec.state === 'failed') {
          // Restore to running — this record was reaped while the worker was
          // still computing. The reaper fired after 10+ minutes of accumulated
          // runtime. The worker is alive and should continue.
          console.warn(`markReconHeartbeat: restoring reaped-but-alive job ${reqId} to running`);
          rec.state = 'running';
          rec.lastHeartbeat = Date.now();
          const putReq = store.put(rec);
          putReq.onsuccess = () => resolve(rec);
          putReq.onerror = () => reject(putReq.error);
          return;
        }
        console.warn(`markReconHeartbeat: job ${reqId} not running (state: ${rec.state})`);
        resolve(null);
        return;
      }
        
        // Update heartbeat timestamp
        rec.lastHeartbeat = Date.now();
        
        const putReq = store.put(rec);
        
        putReq.onsuccess = () => {
          resolve(rec);
        };
        
        putReq.onerror = () => {
          reject(putReq.error || new Error('markReconHeartbeat: put failed'));
        };
      };
      
      getReq.onerror = () => {
        reject(getReq.error || new Error('markReconHeartbeat: get failed'));
      };
    } catch (err) {
      console.warn('markReconHeartbeat error', err);
      resolve(null); // Non-fatal - return null on error
    }
  });
};

/**
 * Atomically mark reconstruction as done
 * @param {string} metaKey
 * @param {string[]} derivedKeys - Array of derived artifact keys
 * @returns {Promise<Object>} Updated status
 */
const markReconDone = async (reqId, derivedKeys = []) => {
  const db = await openDB();
  
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(['reconStatus'], 'readwrite');
      const store = tx.objectStore('reconStatus');
      
      const getReq = store.get(reqId);
      
      getReq.onsuccess = () => {
        const existing = getReq.result;
        
        // ✅ FIX: Ensure metaKey is preserved
        if (!existing) {
          reject(new Error(`markReconDone: no record found for reqId ${reqId}`));
          return;
        }
        
        const status = {
          ...existing,  // ✅ Spread existing to preserve all fields
          state: 'done',
          derivedKeys: derivedKeys || [],
          finishedAt: Date.now(),
          lastError: null,
          nextRetryAt: null
        };
        
        const putReq = store.put(status);
        
        putReq.onsuccess = () => {
          resolve(status);
        };
        
        putReq.onerror = () => {
          reject(putReq.error || new Error('markReconDone: put failed'));
        };
      };
      
      getReq.onerror = () => {
        reject(getReq.error || new Error('markReconDone: get failed'));
      };
    } catch (err) {
      console.warn('markReconDone error', err);
      reject(err);
    }
  });
};
/**
 * Atomically mark reconstruction as failed with exponential backoff
 * @param {string} metaKey
 * @param {string} error - Error message
 * @param {number} backoffMs - Backoff delay (default 5 min)
 * @returns {Promise<Object>} Updated status
 */
const markReconFailed = async (reqId, error, backoffMs = 300000) => {
  console.warn('[markReconFailed] called:', {
    reqId,
    error,
    backoffMs,
    stack: new Error().stack
  });
  const db = await openDB();
  
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(['reconStatus'], 'readwrite');
      const store = tx.objectStore('reconStatus');
      
      const getReq = store.get(reqId);
      
      getReq.onsuccess = () => {
        const existing = getReq.result;
        
        // ✅ FIX: Ensure record exists
        if (!existing) {
          reject(new Error(`markReconFailed: no record found for reqId ${reqId}`));
          return;
        }
        
        const now = Date.now();
        const attempts = existing.attempts || 0;
        const adjustedBackoff = backoffMs * Math.pow(2, Math.min(attempts, 5));
        
        const status = {
          ...existing,  // ✅ Spread existing to preserve all fields
          state: 'failed',
          lastError: String(error),
          nextRetryAt: now + adjustedBackoff,
          finishedAt: now
        };
        
        const putReq = store.put(status);
        
        putReq.onsuccess = () => {
          resolve(status);
        };
        
        putReq.onerror = () => {
          reject(putReq.error || new Error('markReconFailed: put failed'));
        };
      };
      
      getReq.onerror = () => {
        reject(getReq.error || new Error('markReconFailed: get failed'));
      };
    } catch (err) {
      console.warn('markReconFailed error', err);
      reject(err);
    }
  });
};

/**
 * Maintenance: Purge old reconstruction statuses
 * @param {number} ageMs - Age threshold (default 7 days)
 * @returns {Promise<number>} Number of deleted records
 */
const clearOldReconStatus = async (ageMs = 604800000) => {
  const db = await openDB();
  
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(['reconStatus'], 'readwrite');
      const store = tx.objectStore('reconStatus');
      const index = store.index('startedAt');
      
      const cutoff = Date.now() - ageMs;
      const range = IDBKeyRange.upperBound(cutoff);
      
      const cursorReq = index.openCursor(range);
      let deleted = 0;
      
      cursorReq.onsuccess = (event) => {
        const cursor = event.target.result;
        
        if (cursor) {
          // Only delete if state is 'done' or 'failed'
          if (cursor.value.state === 'done' || cursor.value.state === 'failed') {
            cursor.delete();
            deleted++;
          }
          cursor.continue();
        } else {
          // Cursor exhausted
          console.log(`storage: cleared ${deleted} old reconStatus records`);
          resolve(deleted);
        }
      };
      
      cursorReq.onerror = () => {
        console.warn('clearOldReconStatus: cursor error', cursorReq.error);
        resolve(0);
      };
    } catch (err) {
      console.warn('clearOldReconStatus error', err);
      resolve(0);
    }
  });
};

/**
 * Reaper: Find stale 'running' entries and mark as failed
 * Handles worker death without manual intervention
 * @param {number} maxRuntimeMs - Max runtime before considering stale (default 10 min)
 * @returns {Promise<number>} Number of reaped records
 */
const reapStaleRunning = async (maxRuntimeMs = 600000) => {
  const db = await openDB();
  
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(['reconStatus'], 'readwrite');
      const store = tx.objectStore('reconStatus');
      const index = store.index('state');
      
      const range = IDBKeyRange.only('running');
      const cursorReq = index.openCursor(range);
      
      let reaped = 0;
      const now = Date.now();
      
      cursorReq.onsuccess = (event) => {
        const cursor = event.target.result;
        
        if (cursor) {
          const record = cursor.value;
          // Honour explicit deadline set by markReconRunning when present.
          // Falls back to startedAt + maxRuntimeMs for legacy records without deadline.
          // This prevents the reaper from killing a live job that markReconRunning
          // protected with a deadline, even if startedAt is old.
          const isStale = record.deadline
            ? now > record.deadline
            : (now - record.startedAt) > maxRuntimeMs;

          if (isStale) {
            // runtime was never declared in this scope — calculate it here.
            const _stalledRuntimeMs = now - (record.startedAt || now);
            const updated = {
              ...record,
              state: 'failed',
              lastError: `Stale job (runtime: ${_stalledRuntimeMs}ms)`,
              finishedAt: now,
              nextRetryAt: now + 300000 // 5 min backoff
            };
            
            cursor.update(updated);
            reaped++;
            console.warn(`storage: reaped stale job ${record.metaKey}`);
          }
          
          cursor.continue();
        } else {
          // Cursor exhausted
          if (reaped > 0) {
            console.log(`storage: reaped ${reaped} stale running jobs`);
          }
          resolve(reaped);
        }
      };
      
      cursorReq.onerror = () => {
        console.warn('reapStaleRunning: cursor error', cursorReq.error);
        resolve(0);
      };
    } catch (err) {
      console.warn('reapStaleRunning error', err);
      resolve(0);
    }
  });
};

//  Read handles & clones

const getReadHandle = async (key, { mode = 'ref', owner = 'unknown' } = {}) => {
  const art = await getArtifact(key);
  if (!art) return { ok: false, reason: 'NOT_FOUND' };

  if (mode === 'ref') {
    if (art.blob) {
      const url = URL.createObjectURL(art.blob);
      if (!activeObjectURLs.has(key)) activeObjectURLs.set(key, new Set());
      activeObjectURLs.get(key).add(url);
      const release = () => {
        try {
          URL.revokeObjectURL(url);
          const urlSet = activeObjectURLs.get(key);
          if (urlSet) {
            urlSet.delete(url);
            if (!urlSet.size) activeObjectURLs.delete(key);
          }
        } catch (e) { /* best-effort */ }
      };
      return { ok: true, handle: { type: 'ref', key, url }, release };
    }
    return { ok: true, handle: { type: 'ref', key, url: null }, release: () => {} };
  }

  if (mode === 'clone') {
    const cloneKey = `${key}:clone:${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    const clone = {
      ...art,
      key: cloneKey,
      meta: { ...(art.meta || {}), clonedFrom: key, cloneOwner: owner, clonedAt: new Date().toISOString(), version: 1 }
    };

    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(ARTIFACTS_STORE, 'readwrite');
      const putReq = tx.objectStore(ARTIFACTS_STORE).put(clone);
      putReq.onerror = () => { tx.abort(); reject(new Error('Failed to create clone: ' + putReq.error)); };
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });

    return { ok: true, handle: { type: 'clone', key: cloneKey } };
  }

  if (mode === 'deepcopy') {
    if (!art.blob) return { ok: false, reason: 'NO_BLOB' };
    const copyKey = `${key}:copy:${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    const copyArtifact = {
      key: copyKey,
      type: art.type,
      blob: art.blob.slice ? art.blob.slice(0, art.blob.size) : art.blob,
      data: art.data,
      meta: { ...(art.meta || {}), copiedFrom: key, copyOwner: owner, copiedAt: new Date().toISOString(), version: 1 },
      createdAt: new Date().toISOString()
    };
    await putInboundArtifact(copyArtifact);
    return { ok: true, handle: { type: 'copy', key: copyKey } };
  }

  return { ok: false, reason: 'INVALID_MODE' };
};

const revokeArtifactURLs = (key) => {
  const urlSet = activeObjectURLs.get(key);
  if (urlSet) {
    for (const url of urlSet) {
      try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
    }
    activeObjectURLs.delete(key);
  }
};

//  Similarity & lookup

const getSimilar = async (srcMeta, { timeWindow = 5000, phashThreshold = 0.85 } = {}) => {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(ARTIFACTS_STORE, 'readonly');
    const store = tx.objectStore(ARTIFACTS_STORE);
    const results = [];

    if (srcMeta?.srcHash && store.indexNames?.contains?.('srcHash')) {
      const req = store.index('srcHash').getAll(srcMeta.srcHash);
      req.onsuccess = () => {
        if (req.result?.length > 0) {
          resolve(req.result);
          return;
        }
        performTimestampSearch();
      };
      req.onerror = () => performTimestampSearch();
    } else {
      performTimestampSearch();
    }

    function performTimestampSearch() {
      if (!srcMeta?.timestamp) {
        performFullScan();
        return;
      }
      const targetTime = normalizeTimestamp(srcMeta.timestamp);
      if (!targetTime) {
        performFullScan();
        return;
      }

      if (store.indexNames?.contains?.('timestamp')) {
        const range = IDBKeyRange.bound(targetTime - timeWindow, targetTime + timeWindow);
        const req = store.index('timestamp').openCursor(range);
        req.onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (!cursor) {
            resolve(results);
            return;
          }
          results.push(cursor.value);
          cursor.continue();
        };
        req.onerror = () => resolve(results);
      } else {
        performFullScan();
      }
    }

    function performFullScan() {
      const req = store.openCursor();
      req.onsuccess = (ev) => {
        const cursor = ev.target.result;
        if (!cursor) {
          resolve(results);
          return;
        }
        const art = cursor.value;
        if (art.meta?.srcHash === srcMeta?.srcHash) results.push(art);
        else if (srcMeta?.timestamp && art.meta?.timestamp) {
          const tA = normalizeTimestamp(art.meta.timestamp);
          const tB = normalizeTimestamp(srcMeta.timestamp);
          if (tA && tB && Math.abs(tA - tB) <= timeWindow) results.push(art);
        }
        cursor.continue();
      };
      req.onerror = () => resolve([]);
    }
  });
};

/* ----------------------------
   Acquire for processing
   ---------------------------- */

const acquireForProcessing = async (key, { allowFallback = true, consumerId = 'processor' } = {}) => {
  const promoteResult = await promoteToWork(key, { consumerId });
  if (promoteResult.ok) return { ok: true, type: 'promoted', ...promoteResult };

  if (!allowFallback) return { ok: false, reason: 'PROMOTION_FAILED', details: promoteResult };

  const artifact = await getArtifact(key);
  if (!artifact) return { ok: false, reason: 'NOT_FOUND' };

  const similar = await getSimilar(artifact.meta);
  if (similar?.length > 0) {
    for (const candidate of similar) {
      const fallbackPromote = await promoteToWork(candidate.key, { consumerId });
      if (fallbackPromote.ok) return { ok: true, type: 'fallback', originalKey: key, ...fallbackPromote };
    }
  }

  return { ok: false, reason: 'NO_ALTERNATIVES' };
};

/* ----------------------------
   Eviction: checkQuotaAndEvict
   ---------------------------- */

const checkQuotaAndEvict = async () => {
  const db = await openDB();
  const total = await getCounter(db, 'totalBytes') || 0;
  if (total <= quotaBytes) return { ok: true, freed: 0 };

  let freed = 0;
  let evictedCount = 0;
  const now = Date.now();
  const toEvict = [];
  let candidateFreed = 0;

  // Critical-pressure override: a live multi-stage pipeline keeps nearly everything
  // soft-pinned at all times, so eviction previously had no escape valve under
  // sustained critical pressure — it could only reclaim already-expired pins
  // (scraps) while re-logging "CRITICAL quota pressure" every cycle. Above
  // storageCriticalQuotaThreshold, soft-pinned artifacts older than
  // storageCriticalPinOverrideMs become eligible for forced eviction. HARD pins
  // (e.g. calibration.meta) are never subject to this override.
  const utilization = total / quotaBytes;
  let criticalOverride = false;
  let overrideAgeMs = 30000;
  try {
    const criticalThresh = featureFlags.getFlag('storageCriticalQuotaThreshold') ?? 0.95;
    overrideAgeMs = featureFlags.getFlag('storageCriticalPinOverrideMs') ?? 30000;
    criticalOverride = utilization > criticalThresh;
  } catch (e) {
    // featureFlags unavailable — no override, preserves prior conservative behavior
  }
  if (criticalOverride) {
    console.warn(
      `storage: critical-pressure pin override active (utilization=${(utilization * 100).toFixed(1)}%) — ` +
      `soft pins older than ${(overrideAgeMs / 1000).toFixed(0)}s are now evictable`
    );
  }

  return new Promise((resolve) => {
    const scanTx = db.transaction([STREAMS_STORE, ARTIFACTS_STORE], 'readonly');
    const streams = scanTx.objectStore(STREAMS_STORE);
    const artifacts = scanTx.objectStore(ARTIFACTS_STORE);

    const cursorReq = streams.openCursor(null, 'next');

    cursorReq.onsuccess = (ev) => {
      const cursor = ev.target.result;
      if (!cursor) {
        performEviction();
        return;
      }

      const entry = cursor.value;
      if (entry.stream !== 'inbound') {
        cursor.continue();
        return;
      }

      const artReq = artifacts.get(entry.key);
      artReq.onsuccess = () => {
        const art = artReq.result;
        if (!art) {
          toEvict.push({ key: entry.key, seq: entry.seq, size: 0, artifactExists: false });
        } else {
          // Check pinned flag, promoted status, and reservations
          // Note: Eviction phase will double-check live pins to handle race conditions
          const pinned = art.meta?.pinned || false;
          const promoted = art.meta?.promoted || false;
          const reservedUntil = art.meta?.reservedUntil || 0;

          // Under critical-pressure override, aged soft-pinned artifacts are also
          // scan-eligible. The eviction phase still re-checks live pins and pin
          // TYPE (hard vs soft) before actually deleting anything.
          const artAgeMs = now - (art.meta?.timestamp || 0);
          const overrideEligible = criticalOverride && pinned && artAgeMs >= overrideAgeMs;

          if ((!pinned && !promoted && (reservedUntil <= now)) || overrideEligible) {
            const size = art.meta?.sizeBytes || 0;
            toEvict.push({
              key: entry.key, seq: entry.seq, size, artifactExists: true,
              overrideCandidate: overrideEligible
            });
            candidateFreed += size;
          }
        }

        if (toEvict.length >= EVICT_BATCH || candidateFreed >= (total - quotaBytes)) {
          performEviction();
          return;
        }

        cursor.continue();
      };

      artReq.onerror = () => {
        console.warn('Failed to get artifact during eviction scan:', artReq.error);
        cursor.continue();
      };
    };

    cursorReq.onerror = () => {
      console.warn('Eviction cursor error:', cursorReq.error);
      resolve({ ok: false, freed: 0 });
    };

    scanTx.onerror = () => {
      console.warn('Eviction scan transaction error:', scanTx.error);
      resolve({ ok: false, freed: 0 });
    };

    function performEviction() {
      if (!toEvict.length) return resolve({ ok: true, freed: 0 });

      // UPDATED: Include 'pins' store to re-check live pins during eviction
      const evictTx = db.transaction([STREAMS_STORE, ARTIFACTS_STORE, COUNTERS_STORE, 'pins'], 'readwrite');
      const evictStreams = evictTx.objectStore(STREAMS_STORE);
      const evictArtifacts = evictTx.objectStore(ARTIFACTS_STORE);
      const evictCounters = evictTx.objectStore(COUNTERS_STORE);
      const evictPins = evictTx.objectStore('pins');

      let totalFreedWrite = 0;
      let processed = 0;
      const nowLocal = Date.now();

      // Iterate items and do final checks inside write transaction
      for (const item of toEvict) {
        const seq = item.seq;
        if (item.artifactExists) {
          // Re-get artifact in this write transaction
          const getA = evictArtifacts.get(item.key);
          getA.onsuccess = () => {
            const art = getA.result;
            
            // If artifact missing, just remove stream entry
            if (!art) {
              try { evictStreams.delete(seq); } catch (e) { console.warn('evict: delete stream failed', e); }
              processed++;
              checkComplete();
              return;
            }

            // CRITICAL: Re-check live pins in eviction transaction (race condition protection)
            const pinIndex = evictPins.index('metaKey');
            const pinCheckReq = pinIndex.getAll(item.key);
            
            pinCheckReq.onsuccess = () => {
              const pins = pinCheckReq.result || [];
              const nowCheck = Date.now();
              
              // Check for any non-expired pins
              const hasLivePins = pins.some(pin => !pin.expiresAt || pin.expiresAt > nowCheck);
              // Hard pins are NEVER subject to the critical-pressure override —
              // e.g. calibration.meta must survive regardless of quota pressure.
              const hasHardPin = pins.some(pin => pin.type === 'hard');
              
              const promoted = art.meta?.promoted;
              const reservedUntil = art.meta?.reservedUntil || 0;

              const overrideAllowsEviction = item.overrideCandidate && hasLivePins && !hasHardPin;
              
              // Skip eviction if any protection exists (small safety margin for reservations - 1000ms)
              // unless the critical-pressure override explicitly permits overriding a soft pin.
              if ((hasLivePins && !overrideAllowsEviction) || promoted || reservedUntil > (nowLocal + 1000)) {
                // Skip eviction - artifact is protected
                processed++;
                checkComplete();
                return;
              }

              if (overrideAllowsEviction) {
                console.warn(`storage: critical-pressure override evicting aged soft-pinned artifact ${item.key}`);
              }

              // Safe to evict - perform deletion
              try {
                evictArtifacts.delete(item.key);
                revokeArtifactURLs(item.key);
              } catch (e) { 
                console.warn('evict: delete artifact failed', e); 
              }

              try { 
                evictStreams.delete(seq); 
              } catch (e) { 
                console.warn('evict: delete stream failed', e); 
              }

              // Compute accurate freed bytes from art.meta.sizeBytes if available
              const freedBytes = art.meta?.sizeBytes || item.size || 0;
              totalFreedWrite += freedBytes;
              processed++;
              
              // Broadcast eviction event
              _broadcastPinEvent({
                event: 'artifact:evicted',
                metaKey: item.key,
                type: art.type,
                reason: 'quota_pressure',
                freedBytes
              });
              
              _incrementMetric('artifacts_evicted');
              
              checkComplete();
            };
            
            pinCheckReq.onerror = () => {
              // On error checking pins, skip eviction for safety
              console.warn('evict: pin check failed for', item.key, '- skipping eviction');
              processed++;
              checkComplete();
            };
          };
          
          getA.onerror = () => {
            // On error, skip deletion for safety: remove stream entry to avoid loop
            try { evictStreams.delete(seq); } catch(e) { /* ignore */ }
            processed++;
            checkComplete();
          };
        } else {
          // Artifact didn't exist at scan; remove stream entry
          try { evictStreams.delete(seq); } catch (e) { console.warn('evict: delete stream failed', e); }
          processed++;
          checkComplete();
        }
      }

      function checkComplete() {
        if (processed === toEvict.length) {
          // Update totalBytes counter
          const totalReq = evictCounters.get('totalBytes');
          totalReq.onsuccess = () => {
            const cur = totalReq.result?.value || 0;
            evictCounters.put({ id: 'totalBytes', value: Math.max(0, cur - totalFreedWrite) });
          };
          totalReq.onerror = () => console.warn('Failed to update totalBytes during eviction');

          evictTx.oncomplete = () => {
            console.log(`storage: evicted ${toEvict.length} artifacts, freed ${(totalFreedWrite / 1024 / 1024).toFixed(2)} MB`);
            _incrementMetric('eviction_runs');
            resolve({ ok: true, freed: totalFreedWrite, evictedCount: toEvict.length });
          };

          evictTx.onerror = () => {
            console.warn('Eviction transaction error:', evictTx.error);
            resolve({ ok: false, freed: 0 });
          };
        }
      }
    }
  });
};

//  *Stats, evictor loop, maintenance

const getStorageStats = async () => {
  const db = await openDB();
  const totalBytes = await getCounter(db, 'totalBytes') || 0;
  const pinnedBytes = await getCounter(db, 'pinnedBytes') || 0;

  const tx = db.transaction([ARTIFACTS_STORE, STREAMS_STORE], 'readonly');
  const artifacts = tx.objectStore(ARTIFACTS_STORE);
  const streams = tx.objectStore(STREAMS_STORE);

  return new Promise((resolve) => {
    let artifactCount = 0, inboundCount = 0, workCount = 0, reservedCount = 0, pinnedCount = 0;

    const artifactReq = artifacts.count();
    artifactReq.onsuccess = () => {
      artifactCount = artifactReq.result;

      const artCursorReq = artifacts.openCursor();
      artCursorReq.onsuccess = (ev) => {
        const cursor = ev.target.result;
        if (!cursor) {
          countStreams();
          return;
        }
        const art = cursor.value;
        if (art.meta) {
          if ((art.meta.reservedUntil || 0) > Date.now()) reservedCount++;
          if (art.meta.pinned) pinnedCount++;
        }
        cursor.continue();
      };
      artCursorReq.onerror = () => countStreams();
    };

    artifactReq.onerror = () => {
      resolve({
        totalBytes, pinnedBytes, quotaBytes,
        utilization: totalBytes / quotaBytes,
        artifactCount: 0, inboundCount: 0, workCount: 0,
        reservedCount: 0, pinnedCount: 0,
        freeBytes: Math.max(0, quotaBytes - totalBytes)
      });
    };

    function countStreams() {
      const streamReq = streams.openCursor();
      streamReq.onsuccess = (ev) => {
        const cursor = ev.target.result;
        if (!cursor) {
          resolve({
            totalBytes, pinnedBytes, quotaBytes,
            utilization: totalBytes / quotaBytes,
            artifactCount, inboundCount, workCount,
            reservedCount, pinnedCount,
            freeBytes: Math.max(0, quotaBytes - totalBytes),
            activeObjectURLs: activeObjectURLs.size
          });
          return;
        }
        const entry = cursor.value;
        if (entry.stream === 'inbound') inboundCount++;
        else if (entry.stream === 'work') workCount++;
        cursor.continue();
      };
      streamReq.onerror = () => {
        resolve({
          totalBytes, pinnedBytes, quotaBytes,
          utilization: totalBytes / quotaBytes,
          artifactCount, inboundCount: 0, workCount: 0,
          reservedCount, pinnedCount,
          freeBytes: Math.max(0, quotaBytes - totalBytes),
          activeObjectURLs: activeObjectURLs.size
        });
      };
    }
  });
};

const startEvictorLoop = (ms = evictIntervalMs) => {
  if (evictIntervalId) clearInterval(evictIntervalId);
  evictIntervalId = setInterval(() => {
    checkQuotaAndEvict().catch(err => console.warn('Evict loop error:', err));
  }, ms);
  console.log('storage.js: Evictor loop started with interval:', ms);
  return evictIntervalId;
};

const stopEvictorLoop = () => {
  if (evictIntervalId) {
    clearInterval(evictIntervalId);
    evictIntervalId = null;
    console.log('storage.js: Evictor loop stopped');
  }
};

//  *Cleanup & repair

const cleanup = async () => {
  console.log('storage.js: Starting cleanup...');
  stopEvictorLoop();

  for (const [key, urlSet] of activeObjectURLs.entries()) {
    for (const url of urlSet) {
      try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
    }
  }
  activeObjectURLs.clear();

  if (broadcast) {
    try { broadcast.close(); broadcast = null; } catch (e) { /* ignore */ }
  }

  if (dbPromise) {
    try {
      const db = await dbPromise;
      db.close();
      dbPromise = null;
      console.log('storage.js: Database closed');
    } catch (e) {
      console.warn('storage.js: Failed to close database:', e);
    }
  }
  console.log('storage.js: Cleanup completed');
};

const repairCounters = async () => {
  console.log('storage.js: Starting counter repair...');
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction([ARTIFACTS_STORE, COUNTERS_STORE], 'readwrite');
    const artifacts = tx.objectStore(ARTIFACTS_STORE);
    const counters = tx.objectStore(COUNTERS_STORE);

    let totalBytes = 0;
    let pinnedBytes = 0;
    let artifactCount = 0;
    let pinnedCount = 0;

    const cursorReq = artifacts.openCursor();
    cursorReq.onsuccess = (ev) => {
      const cursor = ev.target.result;
      if (!cursor) {
        counters.put({ id: 'totalBytes', value: totalBytes });
        counters.put({ id: 'pinnedBytes', value: pinnedBytes });
        tx.oncomplete = () => {
          console.log('storage.js: Counter repair completed', { totalBytes, pinnedBytes, artifactCount, pinnedCount });
          resolve({ ok: true, totalBytes, pinnedBytes, artifactCount, pinnedCount });
        };
        tx.onerror = () => {
          console.warn('storage.js: Counter repair transaction error:', tx.error);
          reject(tx.error);
        };
        return;
      }

      const art = cursor.value;
      const size = art.meta?.sizeBytes || calculateArtifactSize(art);
      totalBytes += size;
      artifactCount++;
      if (art.meta?.pinned) {
        pinnedBytes += size;
        pinnedCount++;
      }

      cursor.continue();
    };

    cursorReq.onerror = () => {
      console.warn('storage.js: Counter repair cursor error:', cursorReq.error);
      reject(cursorReq.error);
    };
  });
};

// *Utilities

const generateToken = () => 
  typeof crypto !== 'undefined' && crypto.randomUUID 
    ? crypto.randomUUID() 
    : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

//  *Exports & worker globals
console.log('storage.js: All functions defined, setting up exports...');

const storageAPI = {
  // core
  initStorage,
  putInboundArtifact,
  promoteToWork,
  reserveArtifact,
  releaseReservation,
  pinArtifact,
  unpinArtifact,
  getArtifact,
  getPins,
  getPinRefCount,
  unpinAll,
  completeWork,
  demoteFromWork,
  touchArtifact,
  getPinnedArtifacts,
  getWorkQueue,
  getMetrics,
  getReadHandle,
  getSimilar,
  acquireForProcessing,
  checkQuotaAndEvict,
  getStorageStats,
  startEvictorLoop,
  stopEvictorLoop,
  getCounter,
  getPinRef,
  pinRef,
  unpinRef,
  quotaBytes: () => quotaBytes,

  // maintenance
  cleanup,
  repairCounters,
  revokeArtifactURLs,
  incrementVersion,
  validateVersion,
  normalizeTimestamp,
  updateCalibrationAsync,

  // flux helpers
  FLUX_ARTIFACT_TYPE,
  FLUX_ARTIFACT_VERSION,
  createFluxArtifact,
  isFluxArtifact,
  serializeFluxArtifact,
  deserializeFluxArtifact,
  readFluxFloat32,

  // calibration helpers
  attachCalibrationMetaToArtifact,
  isArtifactCalibrated,

  // binary serialization
  serializeTypedArray,
  deserializeTypedArray,
  isTypedArray,
  isSerializedTypedArray,
  float32ToFloat16,
  float16ToFloat32,

  // size calculation
  calculateDataSize,
  calculateArtifactSize,

  // data normalization
  normalizeArtifactData,
  denormalizeArtifactData,

  // reconStatus APIs
  getReconStatus,
  markReconRunning,
  markReconHeartbeat,  // NEW
  markReconDone,
  markReconFailed,
  clearOldReconStatus,
  reapStaleRunning,
  
  // artifact parts APIs
  fetchPartByKey  // NEW
};
// CommonJS export (Node-like bundlers)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = storageAPI;
}

// Worker / classic global export
if (typeof self !== 'undefined' && typeof importScripts === 'function') {
  console.log('storage.js: Setting up worker globals...');
  Object.entries(storageAPI).forEach(([k, v]) => { self[k] = v; });
  console.log('storage.js: Worker globals set up successfully');
}

// Attach to window for debugging if present
try {
  if (typeof window !== 'undefined') {
    window.storageAPI = storageAPI;
    console.log('storage.js: storageAPI attached to window');
  }
} catch (e) { /* ignore */ }

// ES Module exports
export default storageAPI;
export { storageAPI };