// storage.js
// IndexedDB-backed, flux & calibration support, optimistic-versioning, robust eviction.

const DB_NAME = 'motionPainterDB';
const DB_VERSION = 3; // Incremented to add reconStatus store
const ARTIFACTS_STORE = 'artifacts';
const STREAMS_STORE = 'streams';
const COUNTERS_STORE = 'counters';
const DEFAULT_QUOTA_BYTES = 200 * 1024 * 1024; // 200 MB
const BROADCAST_CHANNEL_NAME = 'motion-painter-store';
const EVICT_BATCH = 8;

const FLUX_ARTIFACT_TYPE = 'motion-painter/flux-artifact';
const FLUX_ARTIFACT_VERSION = '1.0';

let dbPromise = null;
let broadcast = null;
let evictIntervalId = null;
let evictIntervalMs = 10000;
let quotaBytes = DEFAULT_QUOTA_BYTES;

const activeObjectURLs = new Map();

console.log('storage.js: Loading storage module...');

// *Binary Serialization Helpers

const BINARY_MAGIC = new Uint8Array([0x42, 0x49, 0x4E, 0x46]); // "BINF"

// * serializeTypedArray(arr) -> Blob
const serializeTypedArray = (arr) => {
  if (!ArrayBuffer.isView(arr)) throw new Error('serializeTypedArray: input must be a typed array');

  const typeMap = {
    'Int8Array': 1, 'Uint8Array': 2, 'Uint8ClampedArray': 3,
    'Int16Array': 4, 'Uint16Array': 5,
    'Int32Array': 6, 'Uint32Array': 7,
    'Float32Array': 8, 'Float64Array': 9,
    'BigInt64Array': 10, 'BigUint64Array': 11
  };

  const typeName = arr.constructor.name;
  const typeCode = typeMap[typeName];
  if (!typeCode) throw new Error(`serializeTypedArray: unsupported type ${typeName}`);

  // header: 12 bytes: magic[4] + typeCode[1] + (length:4) + (bytesPerElement:2) + reserved[1]
  const header = new Uint8Array(12);
  header.set(BINARY_MAGIC, 0);        // bytes 0..3
  header[4] = typeCode & 0xFF;       // byte 4

  const dv = new DataView(header.buffer, 5, 7); // offset 5, length 7 bytes available
  dv.setUint32(0, arr.length, true);            // bytes 5..8 -> length (little endian)
  dv.setUint16(4, arr.BYTES_PER_ELEMENT, true); // bytes 9..10 -> bytesPerElement (LE)
  // byte 11 is reserved (set to 0)

  // Respect view offsets: create Uint8Array view of the exact bytes for this typed-array
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);

  return new Blob([header, bytes], { type: 'application/octet-stream' });
};

//  * deserializeTypedArray(blob) -> Promise<TypedArray>

const deserializeTypedArray = async (blob) => {
  if (!(blob instanceof Blob)) throw new Error('deserializeTypedArray: input must be a Blob');

  const headerBuf = await blob.slice(0, 12).arrayBuffer();
  const header = new Uint8Array(headerBuf);

  if (header[0] !== BINARY_MAGIC[0] || header[1] !== BINARY_MAGIC[1] ||
      header[2] !== BINARY_MAGIC[2] || header[3] !== BINARY_MAGIC[3]) {
    throw new Error('deserializeTypedArray: invalid magic bytes');
  }

  const typeCode = header[4];
  const view = new DataView(headerBuf, 5);
  const length = view.getUint32(0, true);
  const bytesPerElement = view.getUint16(4, true);

  const typeMap = {
    1: Int8Array, 2: Uint8Array, 3: Uint8ClampedArray,
    4: Int16Array, 5: Uint16Array,
    6: Int32Array, 7: Uint32Array,
    8: Float32Array, 9: Float64Array,
    10: BigInt64Array, 11: BigUint64Array
  };

  const TypedArrayClass = typeMap[typeCode];
  if (!TypedArrayClass) throw new Error(`deserializeTypedArray: unknown type code ${typeCode}`);

  // read payload buffer
  const dataBuf = await blob.slice(12).arrayBuffer();
  const expectedBytes = length * bytesPerElement;

  // If buffer is larger than expected, slice to expected size to avoid trailing garbage.
  let payloadBuffer = dataBuf;
  if (dataBuf.byteLength !== expectedBytes) {
    if (dataBuf.byteLength < expectedBytes) {
      // truncated — fail early for data integrity
      throw new Error(`deserializeTypedArray: truncated payload (expected ${expectedBytes} bytes, got ${dataBuf.byteLength})`);
    }
    // larger than expected — create a slice with exactly the expected bytes
    payloadBuffer = dataBuf.slice(0, expectedBytes);
  }

  return new TypedArrayClass(payloadBuffer);
};

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
      // Version 3: Add reconStatus store
      if (oldVersion < 3) {
        if (!db.objectStoreNames.contains('reconStatus')) {
          const reconStore = db.createObjectStore('reconStatus', { keyPath: 'metaKey' });
          reconStore.createIndex('state', 'state', { unique: false });
          reconStore.createIndex('startedAt', 'startedAt', { unique: false });
          console.log('storage.js: created reconStatus store (v3)');
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

const initStorage = async ({ quota = DEFAULT_QUOTA_BYTES, startEvictor = true } = {}) => {
  console.log('storage.js: Initializing storage with quota:', quota);
  try {
    quotaBytes = quota;
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
        if (startEvictor) startEvictorLoop();
        resolve();
      };
      tx.onerror = () => {
        console.warn('storage.js: Counters init tx failed:', tx.error);
        if (startEvictor) startEvictorLoop();
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

// Core artifact APIs

const putInboundArtifact = async (artifact) => {
  const db = await openDB();
  const nowMs = Date.now();
  const nowISO = new Date(nowMs).toISOString();

  // ===== NEW: Generate canonical metaKey if not provided =====
  let metaKey = artifact.key;
  
  if (!metaKey) {
    const timestamp = Date.now();
    const sourceHash = artifact.meta?.sourceMetaKey 
      ? artifact.meta.sourceMetaKey.split(':').pop() 
      : timestamp.toString(36);
    
    metaKey = `artifact:${artifact.type}:${sourceHash}:${timestamp}`;
  }
  // ===== END NEW =====

  let art = {
    key: metaKey, // CHANGED: Use generated/provided metaKey
    type: artifact.type,
    blob: artifact.blob || null,
    data: artifact.data || null,
    meta: artifact.meta || {},
    createdAt: artifact.createdAt || nowISO
  };

  // Normalize data for efficient storage
  art = await normalizeArtifactData(art);

  // Calculate accurate size
  art.meta.timestamp = normalizeTimestamp(art.meta.timestamp) || nowMs;
  art.meta.sizeBytes = calculateArtifactSize(art);

  // Type-specific normalization and calibration hints
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
    const tx = db.transaction([ARTIFACTS_STORE, STREAMS_STORE, COUNTERS_STORE], 'readwrite');
    const artifacts = tx.objectStore(ARTIFACTS_STORE);
    const streams = tx.objectStore(STREAMS_STORE);
    const counters = tx.objectStore(COUNTERS_STORE);

    const getReq = artifacts.get(art.key);

    getReq.onsuccess = () => {
      const existing = getReq.result;

      if (existing) {
        if (!validateVersion(existing, art)) {
          tx.abort();
          return resolve({ ok: false, reason: 'VERSION_CONFLICT' });
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
          totalReq.onerror = () => console.warn('Failed to update totalBytes on artifact update');

          if (existing.meta?.pinned) {
            const pinnedReq = counters.get('pinnedBytes');
            pinnedReq.onsuccess = () => {
              const curPinned = pinnedReq.result?.value || 0;
              counters.put({ id: 'pinnedBytes', value: Math.max(0, curPinned + sizeDelta) });
            };
            pinnedReq.onerror = () => console.warn('Failed to update pinnedBytes on artifact update');
          }
        };
        putReq.onerror = () => { tx.abort(); reject(new Error('Failed to update existing artifact: ' + putReq.error)); };

        tx.oncomplete = () => {
          ensureBroadcast()?.postMessage({ event: 'artifact:ready', key: art.key, meta: existing.meta });

          if (existing.type === FLUX_ARTIFACT_TYPE && Array.isArray(existing.meta.frameRefs) && existing.meta.frameRefs.length > 0) {
            isArtifactCalibrated(existing, { checkReferencedFrames: true, maxFrameChecks: 8 })
              .then(check => updateCalibrationAsync(existing.key, check))
              .catch(err => console.warn('Flux calib verification failed (async):', err));
          }

          // CHANGED: Return metaKey instead of seq
          resolve({ ok: true, metaKey: art.key, reused: true });
        };

        tx.onerror = () => {
          console.warn('Transaction error during artifact update:', tx.error);
          reject(tx.error);
        };

        return;
      }

      // Insert case
      incrementVersion(art);
      let createdStreamSeq = null;

      const putReq = artifacts.put(art);
      putReq.onsuccess = () => {
        const streamReq = streams.add({ stream: 'inbound', key: art.key, priority: 0, createdAt: nowISO });
        streamReq.onsuccess = () => { createdStreamSeq = streamReq.result; };
        streamReq.onerror = () => console.warn('Failed to create stream entry for new artifact:', streamReq.error);

        const totalReq = counters.get('totalBytes');
        totalReq.onsuccess = () => {
          const cur = totalReq.result?.value || 0;
          counters.put({ id: 'totalBytes', value: cur + (art.meta.sizeBytes || 0) });
        };
        totalReq.onerror = () => console.warn('Failed to update totalBytes on new artifact');
      };

      putReq.onerror = () => { tx.abort(); reject(new Error('Failed to store new artifact: ' + putReq.error)); };

      tx.oncomplete = () => {
        ensureBroadcast()?.postMessage({ event: 'artifact:ready', key: art.key, meta: art.meta });
        checkQuotaAndEvict().catch(err => console.warn('Evict check failed:', err));

        if (art.type === FLUX_ARTIFACT_TYPE && Array.isArray(art.meta.frameRefs) && art.meta.frameRefs.length > 0) {
          isArtifactCalibrated(art, { checkReferencedFrames: true, maxFrameChecks: 8 })
            .then(check => updateCalibrationAsync(art.key, check))
            .catch(err => console.warn('Flux calib verification failed (async):', err));
        }

        // CHANGED: Return metaKey instead of seq
        resolve({ ok: true, metaKey: art.key, seq: createdStreamSeq });
      };

      tx.onerror = () => {
        console.warn('Transaction error during artifact creation:', tx.error);
        reject(tx.error);
      };
    };

    getReq.onerror = () => {
      tx.abort();
      reject(new Error('Failed to check for existing artifact: ' + getReq.error));
    };
  });
};

const promoteToWork = async (key, { consumerId = 'unknown', priority = 0, leaseMs = 5 * 60 * 1000 } = {}) => {
  const db = await openDB();
  const now = Date.now();

  return new Promise((resolve, reject) => {
    const tx = db.transaction([ARTIFACTS_STORE, STREAMS_STORE], 'readwrite');
    const artifacts = tx.objectStore(ARTIFACTS_STORE);
    const streams = tx.objectStore(STREAMS_STORE);

    const getReq = artifacts.get(key);
    getReq.onsuccess = () => {
      const art = getReq.result;
      if (!art) {
        tx.abort();
        return resolve({ ok: false, reason: 'NOT_FOUND' });
      }

      const reservedUntil = art.meta?.reservedUntil || 0;
      if (reservedUntil > now) {
        tx.abort();
        return resolve({ ok: false, reason: 'ALREADY_RESERVED', reservedUntil });
      }

      const leaseToken = generateToken();
      incrementVersion(art);

      art.meta = art.meta || {};
      Object.assign(art.meta, { reservedUntil: now + leaseMs, leaseOwner: consumerId, leaseToken, status: 'reserved' });

      const putReq = artifacts.put(art);
      let workSeq = null;

      putReq.onsuccess = () => {
        const addReq = streams.add({ stream: 'work', key, priority, consumerId, createdAt: new Date().toISOString() });
        addReq.onsuccess = () => { workSeq = addReq.result; };
        addReq.onerror = () => console.warn('Failed to add work stream entry:', addReq.error);
      };

      putReq.onerror = () => { tx.abort(); reject(new Error('Failed to update artifact for promotion: ' + putReq.error)); };

      tx.oncomplete = () => {
        ensureBroadcast()?.postMessage({ event: 'artifact:promoted', key, consumerId, workSeq });
        resolve({ ok: true, leaseToken, workSeq });
      };

      tx.onerror = () => {
        console.warn('Transaction error during promotion:', tx.error);
        reject(tx.error);
      };
    };

    getReq.onerror = () => {
      tx.abort();
      reject(new Error('Failed to get artifact for promotion: ' + getReq.error));
    };
  });
};

const reserveArtifact = async (key, { owner = 'unknown', leaseMs = 5 * 60 * 1000 } = {}) => {
  const db = await openDB();
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

const pinArtifact = async (key, { owner = 'user', type = 'soft' } = {}) => {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction([ARTIFACTS_STORE, COUNTERS_STORE], 'readwrite');
    const artifacts = tx.objectStore(ARTIFACTS_STORE);
    const counters = tx.objectStore(COUNTERS_STORE);
    const req = artifacts.get(key);

    req.onsuccess = () => {
      const art = req.result;
      if (!art) { tx.abort(); return resolve({ ok: false, reason: 'NOT_FOUND' }); }

      const size = art.meta?.sizeBytes || 0;
      const pbReq = counters.get('pinnedBytes');

      pbReq.onsuccess = () => {
        const pinnedBytes = pbReq.result?.value || 0;
        const softBudget = Math.floor(quotaBytes * 0.3);
        const pinRefId = `pinref:${key}`;

        // If artifact already marked pinned, we still increment the per-key refcount,
        // but DO NOT double-count pinnedBytes.
        if (art.meta?.pinned) {
          // Read current pinref (may be absent -> default 0) and increment it
          const getPinReq = counters.get(pinRefId);
          getPinReq.onsuccess = () => {
            const cur = getPinReq.result?.value || 0;
            const next = cur + 1;
            counters.put({ id: pinRefId, value: next });

            // Update metadata (keep pinned true) and store artifact
            try {
              incrementVersion(art);
              Object.assign(art.meta, { pinType: type, pinOwner: owner });
              const putReq = artifacts.put(art);
              putReq.onerror = () => { tx.abort(); reject(new Error('Failed to update pinned artifact metadata: ' + putReq.error)); };
              tx.oncomplete = () => {
                ensureBroadcast()?.postMessage({ event: 'artifact:pinned', key, owner, type, reused: true });
                resolve({ ok: true, reused: true });
              };
              tx.onerror = () => reject(tx.error);
            } catch (err) {
              tx.abort();
              reject(err);
            }
          };
          getPinReq.onerror = () => {
            // Best-effort: still update artifact metadata if we couldn't read counters
            try {
              incrementVersion(art);
              Object.assign(art.meta, { pinType: type, pinOwner: owner });
              const putReq = artifacts.put(art);
              putReq.onerror = () => { tx.abort(); reject(new Error('Failed to update pinned artifact metadata: ' + putReq.error)); };
              tx.oncomplete = () => {
                ensureBroadcast()?.postMessage({ event: 'artifact:pinned', key, owner, type, reused: true });
                resolve({ ok: true, reused: true });
              };
              tx.onerror = () => reject(tx.error);
            } catch (err) {
              tx.abort();
              reject(err);
            }
          };
          return;
        }

        // If this would exceed soft budget for 'soft' pin, reject early
        if (pinnedBytes + size > softBudget && type === 'soft') {
          tx.abort();
          return resolve({ ok: false, reason: 'PIN_BUDGET_EXCEEDED' });
        }

        // Normal "first pin" path: increment pinref (from 0->1), set art.meta.pinned, and bump pinnedBytes
        try {
          const getPinReq2 = counters.get(pinRefId);
          getPinReq2.onsuccess = () => {
            const cur = getPinReq2.result?.value || 0;
            const next = cur + 1;
            counters.put({ id: pinRefId, value: next });

            // mark artifact pinned and update pinnedBytes in same tx
            incrementVersion(art);
            art.meta = art.meta || {};
            Object.assign(art.meta, { pinned: true, pinType: type, pinOwner: owner });

            const putReq = artifacts.put(art);
            putReq.onsuccess = () => counters.put({ id: 'pinnedBytes', value: pinnedBytes + size });
            putReq.onerror = () => { tx.abort(); reject(new Error('Failed to pin artifact: ' + putReq.error)); };

            tx.oncomplete = () => {
              ensureBroadcast()?.postMessage({ event: 'artifact:pinned', key, owner, type });
              resolve({ ok: true });
            };
            tx.onerror = () => reject(tx.error);
          };

          getPinReq2.onerror = () => {
            // Fallback: if counters.get fails, still attempt to mark artifact pinned and update pinnedBytes
            incrementVersion(art);
            art.meta = art.meta || {};
            Object.assign(art.meta, { pinned: true, pinType: type, pinOwner: owner });

            const putReq = artifacts.put(art);
            putReq.onsuccess = () => counters.put({ id: 'pinnedBytes', value: pinnedBytes + size });
            putReq.onerror = () => { tx.abort(); reject(new Error('Failed to pin artifact (fallback): ' + putReq.error)); };

            tx.oncomplete = () => {
              ensureBroadcast()?.postMessage({ event: 'artifact:pinned', key, owner, type });
              resolve({ ok: true });
            };
            tx.onerror = () => reject(tx.error);
          };
        } catch (err) {
          tx.abort();
          reject(err);
        }
      };

      pbReq.onerror = () => { tx.abort(); reject(new Error('Failed to get pinnedBytes counter: ' + pbReq.error)); };
    };

    req.onerror = () => { tx.abort(); reject(new Error('Failed to get artifact for pinning: ' + req.error)); };
  });
};


const unpinArtifact = async (key) => {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction([ARTIFACTS_STORE, COUNTERS_STORE], 'readwrite');
    const artifacts = tx.objectStore(ARTIFACTS_STORE);
    const counters = tx.objectStore(COUNTERS_STORE);
    const req = artifacts.get(key);

    req.onsuccess = () => {
      const art = req.result;
      if (!art) { tx.abort(); return resolve({ ok: false, reason: 'NOT_FOUND' }); }

      const size = art.meta?.sizeBytes || 0;
      const pbReq = counters.get('pinnedBytes');
      const pinRefId = `pinref:${key}`;

      pbReq.onsuccess = () => {
        let pinnedBytes = pbReq.result?.value || 0;
        art.meta = art.meta || {};

        // Read current pinref and decrement it (we will decide whether to remove 'pinned' based on resulting refcount)
        try {
          const getPinReq = counters.get(pinRefId);
          getPinReq.onsuccess = () => {
            const cur = getPinReq.result?.value || 0;
            const next = Math.max(0, cur - 1);
            counters.put({ id: pinRefId, value: next });

            // Case A: artifact is not marked pinned — just clear pin metadata (if any) and keep pinnedBytes unchanged.
            if (!art.meta.pinned) {
              try {
                incrementVersion(art);
                delete art.meta.pinType;
                delete art.meta.pinOwner;
                const putReq = artifacts.put(art);
                putReq.onerror = () => { tx.abort(); reject(new Error('Failed to update unpinned artifact: ' + putReq.error)); };
                tx.oncomplete = () => {
                  ensureBroadcast()?.postMessage({ event: 'artifact:unpinned', key, reused: true });
                  resolve({ ok: true, reused: true });
                };
                tx.onerror = () => reject(tx.error);
              } catch (err) {
                tx.abort();
                reject(err);
              }
              return;
            }

            // Case B: artifact was pinned. We should only decrement pinnedBytes when refcount reached zero.
            if (art.meta.pinned) {
              if (next === 0) {
                // last unpin -> remove pinned flag and subtract pinnedBytes
                try {
                  incrementVersion(art);
                  delete art.meta.pinned;
                  delete art.meta.pinType;
                  delete art.meta.pinOwner;

                  const putReq = artifacts.put(art);
                  putReq.onsuccess = () => {
                    pinnedBytes = Math.max(0, pinnedBytes - size);
                    counters.put({ id: 'pinnedBytes', value: pinnedBytes });
                  };
                  putReq.onerror = () => { tx.abort(); reject(new Error('Failed to unpin artifact: ' + putReq.error)); };

                  tx.oncomplete = () => {
                    ensureBroadcast()?.postMessage({ event: 'artifact:unpinned', key });
                    resolve({ ok: true });
                  };
                  tx.onerror = () => reject(tx.error);
                } catch (err) {
                  tx.abort();
                  reject(err);
                }
              } else {
                // still other refs -> keep pinned flag, only update per-key refcount
                try {
                  incrementVersion(art);
                  // keep art.meta.pinned true; optionally update pinOwner/pinType metadata if you want to reflect latest caller
                  delete art.meta.pinOwner; // optional: clear single-owner field to avoid confusion
                  delete art.meta.pinType;
                  const putReq = artifacts.put(art);
                  putReq.onerror = () => { tx.abort(); reject(new Error('Failed to update artifact after unpin (refcount>0): ' + putReq.error)); };
                  tx.oncomplete = () => {
                    ensureBroadcast()?.postMessage({ event: 'artifact:partial-unpin', key, remainingRefCount: next });
                    resolve({ ok: true, remainingRefCount: next });
                  };
                  tx.onerror = () => reject(tx.error);
                } catch (err) {
                  tx.abort();
                  reject(err);
                }
              }
            }
          };

          getPinReq.onerror = () => {
            // If we couldn't read pinref, fall back to previous behavior:
            try {
              if (!art.meta.pinned) {
                incrementVersion(art);
                delete art.meta.pinType;
                delete art.meta.pinOwner;
                const putReq = artifacts.put(art);
                putReq.onerror = () => { tx.abort(); reject(new Error('Failed to update unpinned artifact (fallback): ' + putReq.error)); };
                tx.oncomplete = () => {
                  ensureBroadcast()?.postMessage({ event: 'artifact:unpinned', key, reused: true });
                  resolve({ ok: true, reused: true });
                };
                tx.onerror = () => reject(tx.error);
                return;
              }

              // If pinned and we can't read counters, attempt to unpin and decrement pinnedBytes conservatively
              incrementVersion(art);
              delete art.meta.pinned;
              delete art.meta.pinType;
              delete art.meta.pinOwner;
              const putReq2 = artifacts.put(art);
              putReq2.onsuccess = () => {
                pinnedBytes = Math.max(0, pinnedBytes - size);
                counters.put({ id: 'pinnedBytes', value: pinnedBytes });
              };
              putReq2.onerror = () => { tx.abort(); reject(new Error('Failed to unpin artifact (fallback): ' + putReq2.error)); };
              tx.oncomplete = () => {
                ensureBroadcast()?.postMessage({ event: 'artifact:unpinned', key, fallback: true });
                resolve({ ok: true, fallback: true });
              };
              tx.onerror = () => reject(tx.error);
            } catch (err) {
              tx.abort();
              reject(err);
            }
          };
        } catch (err) {
          tx.abort();
          reject(err);
        }
      };

      pbReq.onerror = () => { tx.abort(); reject(new Error('Failed to get pinnedBytes counter: ' + pbReq.error)); };
    };

    req.onerror = () => { tx.abort(); reject(new Error('Failed to get artifact for unpinning: ' + req.error)); };
  });
};

const getArtifact = async (key, { denormalize = false } = {}) => {
  const db = await openDB();
  return new Promise((resolve) => {
    try {
      const req = db.transaction(ARTIFACTS_STORE, 'readonly').objectStore(ARTIFACTS_STORE).get(key);
      req.onsuccess = async () => {
        let artifact = req.result || null;
        if (artifact && denormalize) {
          artifact = await denormalizeArtifactData(artifact);
        }
        resolve(artifact);
      };
      req.onerror = () => {
        console.warn('Failed to get artifact:', req.error);
        resolve(null);
      };
    } catch (err) {
      console.warn('getArtifact error', err);
      resolve(null);
    }
  });
};
 
/**
 * Get reconstruction status for metaKey
 * @param {string} metaKey - Artifact key
 * @returns {Promise<Object|null>} Status object or null if not found
 */
const getReconStatus = async (metaKey) => {
  const db = await openDB();
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(['reconStatus'], 'readonly');
      const store = tx.objectStore('reconStatus');
      const req = store.get(metaKey);
      
      req.onsuccess = () => {
        resolve(req.result || null);
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
      const getReq = store.get(metaKey);
      
      getReq.onsuccess = () => {
        const existing = getReq.result;
        const now = Date.now();
        
        // Check if already running
        if (existing && existing.state === 'running') {
          const runtime = now - existing.startedAt;
          
          // Stale-job takeover: if running too long, allow takeover
          if (runtime < maxRuntimeMs) {
            // Still fresh, reject
            resolve({ 
              ok: false, 
              reason: 'running', 
              existing,
              runtime 
            });
            return;
          } else {
            // Stale job, allow takeover
            console.warn(`storage: taking over stale job ${metaKey} (runtime: ${runtime}ms)`);
          }
        }
        
        // Create or update record
        const rec = {
          metaKey,
          state: 'running',
          reqId,
          attempts: (existing?.attempts || 0) + 1,
          startedAt: now,
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
 * Atomically mark reconstruction as done
 * @param {string} metaKey
 * @param {string[]} derivedKeys - Array of derived artifact keys
 * @returns {Promise<Object>} Updated status
 */
const markReconDone = async (metaKey, derivedKeys) => {
  const db = await openDB();
  
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(['reconStatus'], 'readwrite');
      const store = tx.objectStore('reconStatus');
      
      const getReq = store.get(metaKey);
      
      getReq.onsuccess = () => {
        const existing = getReq.result;
        
        const status = {
          ...(existing || {}),
          metaKey,
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
const markReconFailed = async (metaKey, error, backoffMs = 300000) => {
  const db = await openDB();
  
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(['reconStatus'], 'readwrite');
      const store = tx.objectStore('reconStatus');
      
      const getReq = store.get(metaKey);
      
      getReq.onsuccess = () => {
        const existing = getReq.result;
        const now = Date.now();
        
        // Exponential backoff based on attempts
        const attempts = (existing?.attempts || 0);
        const adjustedBackoff = backoffMs * Math.pow(2, Math.min(attempts, 5));
        
        const status = {
          ...(existing || {}),
          metaKey,
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
          const runtime = now - record.startedAt;
          
          if (runtime > maxRuntimeMs) {
            // Mark as failed with stale indicator
            const updated = {
              ...record,
              state: 'failed',
              lastError: `Stale job (runtime: ${runtime}ms)`,
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
          const pinned = art.meta?.pinned;
          const reservedUntil = art.meta?.reservedUntil || 0;
          if (!pinned && (reservedUntil <= now)) {
            const size = art.meta?.sizeBytes || 0;
            toEvict.push({ key: entry.key, seq: entry.seq, size, artifactExists: true });
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

    const evictTx = db.transaction([STREAMS_STORE, ARTIFACTS_STORE, COUNTERS_STORE], 'readwrite');
    const evictStreams = evictTx.objectStore(STREAMS_STORE);
    const evictArtifacts = evictTx.objectStore(ARTIFACTS_STORE);
    const evictCounters = evictTx.objectStore(COUNTERS_STORE);

    let totalFreedWrite = 0;
    let processed = 0;
    const nowLocal = Date.now();

    // iterate items and do final checks inside write tx
    for (const item of toEvict) {
      const seq = item.seq;
      if (item.artifactExists) {
        // re-get artifact in this write transaction
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

          const pinned = art.meta?.pinned;
          const reservedUntil = art.meta?.reservedUntil || 0;
          // small safety margin for reservations - 1000ms
          if (pinned || reservedUntil > (nowLocal + 1000)) {
            // skip eviction, but remove the stream entry if you want? We'll keep stream entry for now
            processed++;
            checkComplete();
            return;
          }

          // perform deletion
          try {
            evictArtifacts.delete(item.key);
            revokeArtifactURLs(item.key);
          } catch (e) { console.warn('evict: delete artifact failed', e); }

          try { evictStreams.delete(seq); } catch (e) { console.warn('evict: delete stream failed', e); }

          // compute accurate freed bytes from art.meta.sizeBytes if available
          const freedBytes = art.meta?.sizeBytes || item.size || 0;
          totalFreedWrite += freedBytes;
          processed++;
          checkComplete();
        };
        getA.onerror = () => {
          // on error, skip deletion for safety: remove stream entry to avoid loop?
          try { evictStreams.delete(seq); } catch(e) { /* ignore */ }
          processed++;
          checkComplete();
        };
      } else {
        // artifact didn't exist at scan; remove stream entry
        try { evictStreams.delete(seq); } catch (e) { console.warn('evict: delete stream failed', e); }
        processed++;
        checkComplete();
      }
    }

    function checkComplete() {
      if (processed === toEvict.length) {
        // update totalBytes counter
        const totalReq = evictCounters.get('totalBytes');
        totalReq.onsuccess = () => {
          const cur = totalReq.result?.value || 0;
          evictCounters.put({ id: 'totalBytes', value: Math.max(0, cur - totalFreedWrite) });
        };
        totalReq.onerror = () => console.warn('Failed to update totalBytes during eviction');

        evictTx.oncomplete = () => {
          const bc = ensureBroadcast();
          if (bc) {
            for (const item of toEvict) {
              if (item.artifactExists) bc.postMessage({ event: 'artifact:evicted', key: item.key, freedBytes: item.size });
            }
          }
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

  // reconStatus APIs (Phase 1)
  getReconStatus,
  markReconRunning,
  markReconDone,
  markReconFailed,
  clearOldReconStatus,
  reapStaleRunning
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