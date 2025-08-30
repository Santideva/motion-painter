// storage.js
// IndexedDB-backed Storage Buffer for motion-painter artifacts.
// Enhanced for Web Worker compatibility

const DB_NAME = 'motionPainterDB';
const DB_VERSION = 1;
const ARTIFACTS_STORE = 'artifacts';
const STREAMS_STORE = 'streams';
const COUNTERS_STORE = 'counters';
const DEFAULT_QUOTA_BYTES = 200 * 1024 * 1024; // 200 MB default
const BROADCAST_CHANNEL_NAME = 'motion-painter-store';
const EVICT_BATCH = 8; // evict up to this many items per loop

let dbPromise = null;
let broadcast = null;
let evictIntervalId = null;
let evictIntervalMs = 10000; // periodic eviction run
let quotaBytes = DEFAULT_QUOTA_BYTES;

console.log('storage.js: Loading storage module...');

function openDB() {
  if (dbPromise) return dbPromise;
  
  console.log('storage.js: Opening IndexedDB...');
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    
    req.onupgradeneeded = (ev) => {
      console.log('storage.js: Upgrading database schema...');
      const db = ev.target.result;
      
      if (!db.objectStoreNames.contains(ARTIFACTS_STORE)) {
        console.log('storage.js: Creating artifacts store...');
        const s = db.createObjectStore(ARTIFACTS_STORE, { keyPath: 'key' });
        s.createIndex('srcHash', 'meta.srcHash', { unique: false });
        s.createIndex('pinned', 'meta.pinned', { unique: false });
      }
      
      if (!db.objectStoreNames.contains(STREAMS_STORE)) {
        console.log('storage.js: Creating streams store...');
        db.createObjectStore(STREAMS_STORE, { keyPath: 'seq', autoIncrement: true });
        // stream entries: { seq(auto), stream: 'inbound'|'work', key, priority, createdAt }
      }
      
      if (!db.objectStoreNames.contains(COUNTERS_STORE)) {
        console.log('storage.js: Creating counters store...');
        db.createObjectStore(COUNTERS_STORE, { keyPath: 'id' });
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
}

function ensureBroadcast() {
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
}

async function getCounter(txOrDb, id) {
  if (!txOrDb) return null;

  // If it's a transaction (has objectStore)
  if (typeof txOrDb.objectStore === 'function') {
    const tx = txOrDb;
    return new Promise((resolve) => {
      try {
        const req = tx.objectStore(COUNTERS_STORE).get(id);
        req.onsuccess = () => resolve(req.result ? req.result.value : null);
        req.onerror = () => resolve(null);
      } catch (err) {
        // defensive fallback
        console.warn('getCounter (tx) fallback', err);
        resolve(null);
      }
    });
  }

  // If it's a database (has transaction)
  if (typeof txOrDb.transaction === 'function') {
    const db = txOrDb;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(COUNTERS_STORE, 'readonly');
        const req = tx.objectStore(COUNTERS_STORE).get(id);
        req.onsuccess = () => resolve(req.result ? req.result.value : null);
        req.onerror = () => resolve(null);
      } catch (err) {
        console.warn('getCounter (db) fallback', err);
        resolve(null);
      }
    });
  }

  // unknown type
  return null;
}

async function putCounter(tx, id, value) {
  return new Promise((resolve, reject) => {
    try {
      const req = tx.objectStore(COUNTERS_STORE).put({ id, value });
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * initStorage(options)
 * options:
 *  - quotaBytes: number (optional)
 *  - startEvictor: boolean (start periodic eviction)
 */
async function initStorage({ quota = DEFAULT_QUOTA_BYTES, startEvictor = true } = {}) {
  console.log('storage.js: Initializing storage with quota:', quota);
  
  try {
    quotaBytes = quota;
    await openDB();
    ensureBroadcast();
    
    // ensure totalBytes counter exists
    const db = await openDB();
    const tx = db.transaction(COUNTERS_STORE, 'readwrite');
    const s = tx.objectStore(COUNTERS_STORE);
    
    const getReq = s.get('totalBytes');
    getReq.onsuccess = () => {
      if (!getReq.result) {
        console.log('storage.js: Initializing totalBytes counter');
        s.put({ id: 'totalBytes', value: 0 });
      }
    };
    
    const pinnedReq = s.get('pinnedBytes');
    pinnedReq.onsuccess = () => {
      if (!pinnedReq.result) {
        console.log('storage.js: Initializing pinnedBytes counter');
        s.put({ id: 'pinnedBytes', value: 0 });
      }
    };
    
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => {
        console.log('storage.js: Storage initialization completed');
        if (startEvictor) {
          console.log('storage.js: Starting evictor loop');
          startEvictorLoop();
        }
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
}

/**
 * putInboundArtifact(artifact)
 * artifact = {
 *   key, type, blob? (Blob), data? (JSON), meta: { srcHash, frameNumber, timestamp, sizeBytes?, pinned?:false }
 * }
 * Returns: { ok:true, seq } or { ok:false, reason }
 */
async function putInboundArtifact(artifact) {
  const db = await openDB();
  const now = new Date().toISOString();
  const art = {
    key: artifact.key,
    type: artifact.type,
    blob: artifact.blob || null,
    data: artifact.data || null,
    meta: artifact.meta || {},
    createdAt: artifact.createdAt || now
  };
  if (!art.meta.sizeBytes) {
    // try to estimate size
    if (art.blob && typeof art.blob.size === 'number') art.meta.sizeBytes = art.blob.size;
    else if (art.data) art.meta.sizeBytes = JSON.stringify(art.data).length;
    else art.meta.sizeBytes = 0;
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
        // Already exists: update meta if needed but avoid duplicate FIFO entries
        existing.meta = { ...existing.meta, ...art.meta };
        if (art.blob) existing.blob = art.blob;
        if (art.data) existing.data = art.data;
        artifacts.put(existing);
        tx.oncomplete = () => {
          // find seq for existing inbound entry? We keep idempotent writes simple: broadcast ready
          const bc = ensureBroadcast();
          if (bc) bc.postMessage({ event: 'artifact:ready', key: art.key, meta: existing.meta });
          resolve({ ok: true, seq: null, reused: true });
        };
        return;
      }

      // New artifact: add artifact and stream entry (inbound)
      artifacts.put(art);
      // stream entry for inbound
      const streamEntry = { stream: 'inbound', key: art.key, priority: 0, createdAt: now };
      const streamReq = streams.add(streamEntry);
      // update totalBytes
      const totalReq = counters.get('totalBytes');
      totalReq.onsuccess = () => {
        const cur = totalReq.result ? totalReq.result.value : 0;
        const newTotal = cur + (art.meta.sizeBytes || 0);
        counters.put({ id: 'totalBytes', value: newTotal });
      };

      tx.oncomplete = () => {
        // broadcast artifact ready
        const bc = ensureBroadcast();
        if (bc) bc.postMessage({ event: 'artifact:ready', key: art.key, meta: art.meta });
        // schedule eviction check (async)
        checkQuotaAndEvict().catch(err => console.warn('evict check failed', err));
        resolve({ ok: true, seq: streamReq.result });
      };
    };
    getReq.onerror = () => {
      tx.abort();
      reject(getReq.error);
    };
  });
}

/**
 * promoteToWork(key, { consumerId, priority, leaseMs })
 * Atomically reserve the artifact and append to work stream.
 * Returns { ok:true, leaseToken, workSeq } or { ok:false, reason }
 */
async function promoteToWork(key, { consumerId = 'unknown', priority = 0, leaseMs = 5 * 60 * 1000 } = {}) {
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
        // already reserved
        return resolve({ ok: false, reason: 'ALREADY_RESERVED', reservedUntil });
      }

      // create lease token
      const leaseToken = generateToken();
      art.meta = art.meta || {};
      art.meta.reservedUntil = now + leaseMs;
      art.meta.leaseOwner = consumerId;
      art.meta.leaseToken = leaseToken;
      art.meta.status = 'reserved';
      artifacts.put(art);

      const entry = { stream: 'work', key, priority, consumerId, createdAt: new Date().toISOString() };
      const addReq = streams.add(entry);

      tx.oncomplete = () => {
        const bc = ensureBroadcast();
        if (bc) bc.postMessage({ event: 'artifact:promoted', key, consumerId, workSeq: addReq.result });
        resolve({ ok: true, leaseToken, workSeq: addReq.result });
      };
    };
    getReq.onerror = () => {
      tx.abort();
      reject(getReq.error);
    };
  });
}

/**
 * reserveArtifact(key, { owner, leaseMs }) - short lease
 * Returns { ok:true, leaseToken, reservedUntil } or { ok:false, reason }
 */
async function reserveArtifact(key, { owner = 'unknown', leaseMs = 5 * 60 * 1000 } = {}) {
  const db = await openDB();
  const now = Date.now();
  return new Promise((resolve) => {
    const tx = db.transaction(ARTIFACTS_STORE, 'readwrite');
    const s = tx.objectStore(ARTIFACTS_STORE);
    const req = s.get(key);
    req.onsuccess = () => {
      const art = req.result;
      if (!art) { tx.abort(); return resolve({ ok: false, reason: 'NOT_FOUND' }); }
      const reservedUntil = art.meta?.reservedUntil || 0;
      if (reservedUntil > now) {
        return resolve({ ok: false, reason: 'ALREADY_RESERVED', reservedUntil });
      }
      const leaseToken = generateToken();
      art.meta = art.meta || {};
      art.meta.reservedUntil = now + leaseMs;
      art.meta.leaseOwner = owner;
      art.meta.leaseToken = leaseToken;
      s.put(art);
      tx.oncomplete = () => {
        const bc = ensureBroadcast();
        if (bc) bc.postMessage({ event: 'artifact:reserved', key, owner, reservedUntil: art.meta.reservedUntil });
        resolve({ ok: true, leaseToken, reservedUntil: art.meta.reservedUntil });
      };
    };
    req.onerror = () => resolve({ ok: false, reason: 'ERROR' });
  });
}

/**
 * releaseReservation(key, leaseToken)
 */
async function releaseReservation(key, leaseToken) {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(ARTIFACTS_STORE, 'readwrite');
    const s = tx.objectStore(ARTIFACTS_STORE);
    const req = s.get(key);
    req.onsuccess = () => {
      const art = req.result;
      if (!art) { tx.abort(); return resolve({ ok: false, reason: 'NOT_FOUND' }); }
      if (!art.meta || art.meta.leaseToken !== leaseToken) {
        return resolve({ ok: false, reason: 'INVALID_TOKEN' });
      }
      delete art.meta.leaseToken;
      delete art.meta.leaseOwner;
      art.meta.reservedUntil = 0;
      art.meta.status = 'available';
      s.put(art);
      tx.oncomplete = () => { 
        const bc = ensureBroadcast();
        if (bc) bc.postMessage({ event: 'artifact:released', key });
        resolve({ ok: true });
      };
    };
    req.onerror = () => resolve({ ok: false, reason: 'ERROR' });
  });
}

/**
 * pinArtifact(key, { owner, type = 'soft' })
 * soft: eligible for auto-demotion under pressure; hard: not auto-evictable
 */
async function pinArtifact(key, { owner = 'user', type = 'soft' } = {}) {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction([ARTIFACTS_STORE, COUNTERS_STORE], 'readwrite');
    const artifacts = tx.objectStore(ARTIFACTS_STORE);
    const counters = tx.objectStore(COUNTERS_STORE);
    const req = artifacts.get(key);
    req.onsuccess = async () => {
      const art = req.result;
      if (!art) { tx.abort(); return resolve({ ok: false, reason: 'NOT_FOUND' }); }
      const size = art.meta?.sizeBytes || (art.blob ? art.blob.size : 0);
      // check current pinned bytes
      const pbReq = counters.get('pinnedBytes');
      pbReq.onsuccess = () => {
        const pinnedBytes = pbReq.result ? pbReq.result.value : 0;
        // pin budget enforcement: simple soft budget 30% of quota
        const softBudget = Math.floor(quotaBytes * 0.3);
        if (pinnedBytes + size > softBudget && type === 'soft') {
          // attempt to demote soft pins (not implemented here fully)
          // For simplicity, reject if pin would exceed soft budget.
          tx.abort();
          return resolve({ ok: false, reason: 'PIN_BUDGET_EXCEEDED' });
        }
        // proceed to pin
        art.meta = art.meta || {};
        art.meta.pinned = true;
        art.meta.pinType = type;
        art.meta.pinOwner = owner;
        artifacts.put(art);
        counters.put({ id: 'pinnedBytes', value: pinnedBytes + size });
        tx.oncomplete = () => { 
          const bc = ensureBroadcast();
          if (bc) bc.postMessage({ event: 'artifact:pinned', key, owner, type });
          resolve({ ok: true });
        };
      };
      pbReq.onerror = () => resolve({ ok: false, reason: 'ERROR' });
    };
    req.onerror = () => resolve({ ok: false, reason: 'ERROR' });
  });
}

/**
 * unpinArtifact(key)
 */
async function unpinArtifact(key) {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction([ARTIFACTS_STORE, COUNTERS_STORE], 'readwrite');
    const artifacts = tx.objectStore(ARTIFACTS_STORE);
    const counters = tx.objectStore(COUNTERS_STORE);
    const req = artifacts.get(key);
    req.onsuccess = () => {
      const art = req.result;
      if (!art) { tx.abort(); return resolve({ ok: false, reason: 'NOT_FOUND' }); }
      const size = art.meta?.sizeBytes || (art.blob ? art.blob.size : 0);
      const pbReq = counters.get('pinnedBytes');
      pbReq.onsuccess = () => {
        const pinnedBytes = pbReq.result ? pbReq.result.value : 0;
        art.meta = art.meta || {};
        delete art.meta.pinned;
        delete art.meta.pinType;
        delete art.meta.pinOwner;
        artifacts.put(art);
        counters.put({ id: 'pinnedBytes', value: Math.max(0, pinnedBytes - size) });
        tx.oncomplete = () => { 
          const bc = ensureBroadcast();
          if (bc) bc.postMessage({ event: 'artifact:unpinned', key });
          resolve({ ok: true });
        };
      };
      pbReq.onerror = () => resolve({ ok: false, reason: 'ERROR' });
    };
    req.onerror = () => resolve({ ok: false, reason: 'ERROR' });
  });
}

/**
 * getArtifact(key) -> artifact object or null
 */
async function getArtifact(key) {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(ARTIFACTS_STORE, 'readonly');
    const s = tx.objectStore(ARTIFACTS_STORE);
    const req = s.get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

/**
 * getReadHandle(key, { mode = 'ref' }) - returns a lightweight read handle
 * mode = 'ref' => return blobUrl for reading
 * mode = 'clone' => returns logical clone (metadata-only)
 * mode = 'deepcopy' => makes deep copy of blob and returns new artifact key (costly)
 */
async function getReadHandle(key, { mode = 'ref', owner = 'unknown' } = {}) {
  const art = await getArtifact(key);
  if (!art) return { ok: false, reason: 'NOT_FOUND' };

  if (mode === 'ref') {
    // create an objectURL for the blob if present
    if (art.blob) {
      const url = URL.createObjectURL(art.blob);
      return { ok: true, handle: { type: 'ref', key, url }, release: () => { try { URL.revokeObjectURL(url); } catch (e) {} } };
    } else {
      return { ok: true, handle: { type: 'ref', key, url: null }, release: () => {} };
    }
  }

  if (mode === 'clone') {
    // logical clone: just create a new artifact metadata pointing to same blob reference
    const cloneKey = `${key}:clone:${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    const clone = { ...art, key: cloneKey, meta: { ...(art.meta||{}), clonedFrom: key, cloneOwner: owner, clonedAt: new Date().toISOString() } };
    // do not duplicate blob bytes (reuse same blob reference)
    // store clone metadata in DB
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(ARTIFACTS_STORE, 'readwrite');
      tx.objectStore(ARTIFACTS_STORE).put(clone);
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
      blob: art.blob.slice ? art.blob.slice(0, art.blob.size) : art.blob, // best-effort copy
      data: art.data,
      meta: { ...(art.meta||{}), copiedFrom: key, copyOwner: owner, copiedAt: new Date().toISOString() },
      createdAt: new Date().toISOString()
    };
    // write new artifact and return handle
    await putInboundArtifact(copyArtifact);
    return { ok: true, handle: { type: 'copy', key: copyKey } };
  }

  return { ok: false, reason: 'INVALID_MODE' };
}

/**
 * getSimilar(srcMeta, { timeWindow, phashThreshold }) - fallback lookup
 */
async function getSimilar(srcMeta, { timeWindow = 5000, phashThreshold = 0.85 } = {}) {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(ARTIFACTS_STORE, 'readonly');
    const store = tx.objectStore(ARTIFACTS_STORE);
    const results = [];
    
    // Simple similarity search - in production you'd want more sophisticated indexing
    const req = store.openCursor();
    req.onsuccess = (ev) => {
      const cursor = ev.target.result;
      if (!cursor) {
        resolve(results);
        return;
      }
      
      const art = cursor.value;
      if (art.meta?.srcHash === srcMeta.srcHash) {
        results.push(art);
      } else if (srcMeta.timestamp && art.meta?.timestamp) {
        const timeDiff = Math.abs(art.meta.timestamp - srcMeta.timestamp);
        if (timeDiff <= timeWindow) {
          results.push(art);
        }
      }
      
      cursor.continue();
    };
    req.onerror = () => resolve([]);
  });
}

/**
 * acquireForProcessing(key, { allowFallback }) - atomic promote with fallback
 */
async function acquireForProcessing(key, { allowFallback = true, consumerId = 'processor' } = {}) {
  // Try atomic promotion first
  const promoteResult = await promoteToWork(key, { consumerId });
  if (promoteResult.ok) {
    return { ok: true, type: 'promoted', ...promoteResult };
  }
  
  if (!allowFallback) {
    return { ok: false, reason: 'PROMOTION_FAILED', details: promoteResult };
  }
  
  // Fallback to similarity search
  const artifact = await getArtifact(key);
  if (!artifact) {
    return { ok: false, reason: 'NOT_FOUND' };
  }
  
  const similar = await getSimilar(artifact.meta);
  if (similar.length > 0) {
    // Try to promote the first similar artifact
    for (const candidate of similar) {
      const fallbackPromote = await promoteToWork(candidate.key, { consumerId });
      if (fallbackPromote.ok) {
        return { ok: true, type: 'fallback', originalKey: key, ...fallbackPromote };
      }
    }
  }
  
  return { ok: false, reason: 'NO_ALTERNATIVES' };
}

/**
 * checkQuotaAndEvict()
 * Evict oldest inbound items until totalBytes <= quotaBytes (or nothing evictable).
 */
async function checkQuotaAndEvict() {
  const db = await openDB();
  // read totalBytes
  const total = await getCounter(db, 'totalBytes') || 0;
  if (total <= quotaBytes) return { ok: true, freed: 0 };

  let freed = 0;
  const now = Date.now();
  // We'll iterate over oldest inbound streams
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STREAMS_STORE, ARTIFACTS_STORE, COUNTERS_STORE], 'readwrite');
    const streams = tx.objectStore(STREAMS_STORE);
    const artifacts = tx.objectStore(ARTIFACTS_STORE);
    const counters = tx.objectStore(COUNTERS_STORE);

    const cursorReq = streams.openCursor(null, 'next'); // oldest-first
    cursorReq.onsuccess = async (ev) => {
      const cursor = ev.target.result;
      if (!cursor) {
        // done scanning
        const finalTotalReq = counters.get('totalBytes');
        finalTotalReq.onsuccess = () => resolve({ ok: true, freed });
        finalTotalReq.onerror = () => resolve({ ok: false, freed });
        return;
      }
      const entry = cursor.value;
      // only evict inbound stream entries (do not evict 'work' stream)
      if (entry.stream !== 'inbound') {
        cursor.continue();
        return;
      }
      try {
        const artReq = artifacts.get(entry.key);
        artReq.onsuccess = () => {
          const art = artReq.result;
          if (!art) {
            // nothing to delete, remove stream entry
            cursor.delete();
            cursor.continue();
            return;
          }
          const pinned = art.meta?.pinned;
          const reservedUntil = art.meta?.reservedUntil || 0;
          if (pinned || (reservedUntil && reservedUntil > now)) {
            // skip
            cursor.continue();
            return;
          }
          // Evict artifact and stream entry
          const size = art.meta?.sizeBytes || (art.blob ? art.blob.size : 0);
          artifacts.delete(art.key);
          cursor.delete();
          freed += size;
          // decrement counter
          const totalReq = counters.get('totalBytes');
          totalReq.onsuccess = () => {
            const cur = totalReq.result ? totalReq.result.value : 0;
            const newTotal = Math.max(0, cur - size);
            counters.put({ id: 'totalBytes', value: newTotal });
          };
          const bc = ensureBroadcast();
          if (bc) bc.postMessage({ event: 'artifact:evicted', key: art.key, freedBytes: size });
          // Stop early if we freed enough
          if ((total - freed) <= quotaBytes || freed >= EVICT_BATCH * 1024 * 1024) {
            const finalTotalReq = counters.get('totalBytes');
            finalTotalReq.onsuccess = () => resolve({ ok: true, freed });
            finalTotalReq.onerror = () => resolve({ ok: false, freed });
            return;
          }
          cursor.continue();
        };
        artReq.onerror = () => cursor.continue();
      } catch (err) {
        console.warn('evict cursor error', err);
        cursor.continue();
      }
    };
    cursorReq.onerror = () => resolve({ ok: false, freed });
  });
}

/**
 * getStorageStats() - get current storage statistics
 */
async function getStorageStats() {
  const db = await openDB();
  const totalBytes = await getCounter(db, 'totalBytes') || 0;
  const pinnedBytes = await getCounter(db, 'pinnedBytes') || 0;
  
  // Count artifacts and streams
  const tx = db.transaction([ARTIFACTS_STORE, STREAMS_STORE], 'readonly');
  const artifacts = tx.objectStore(ARTIFACTS_STORE);
  const streams = tx.objectStore(STREAMS_STORE);
  
  return new Promise((resolve) => {
    let artifactCount = 0;
    let inboundCount = 0;
    let workCount = 0;
    
    const artifactReq = artifacts.count();
    artifactReq.onsuccess = () => {
      artifactCount = artifactReq.result;
      
      const streamReq = streams.openCursor();
      streamReq.onsuccess = (ev) => {
        const cursor = ev.target.result;
        if (!cursor) {
          resolve({
            totalBytes,
            pinnedBytes,
            quotaBytes,
            utilization: totalBytes / quotaBytes,
            artifactCount,
            inboundCount,
            workCount,
            freeBytes: Math.max(0, quotaBytes - totalBytes)
          });
          return;
        }
        
        const entry = cursor.value;
        if (entry.stream === 'inbound') inboundCount++;
        else if (entry.stream === 'work') workCount++;
        
        cursor.continue();
      };
    };
  });
}

function startEvictorLoop(ms = evictIntervalMs) {
  if (evictIntervalId) clearInterval(evictIntervalId);
  evictIntervalId = setInterval(() => {
    checkQuotaAndEvict().catch(err => console.warn('evict loop error', err));
  }, ms);
  return evictIntervalId;
}

function stopEvictorLoop() {
  if (evictIntervalId) clearInterval(evictIntervalId);
  evictIntervalId = null;
}

function generateToken() {
  // simple token; replace with crypto random if desired
  return `${Date.now()}-${Math.random().toString(36).slice(2,9)}`;
}

console.log('storage.js: All functions defined, setting up exports...');

// Export functions for ES6 modules
const storageAPI = {
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
  quotaBytes: () => quotaBytes
};

// Export for ES6 modules if available
if (typeof module !== 'undefined' && module.exports) {
  module.exports = storageAPI;
}

// Export functions for classic workers (global scope)
if (typeof self !== 'undefined' && typeof importScripts === 'function') {
  console.log('storage.js: Setting up worker globals...');
  self.onstorage = initStorage;
  self.putInboundArtifact = putInboundArtifact;
  self.promoteToWork = promoteToWork;
  self.reserveArtifact = reserveArtifact;
  self.releaseReservation = releaseReservation;
  self.pinArtifact = pinArtifact;
  self.unpinArtifact = unpinArtifact;
  self.getArtifact = getArtifact;
  self.getReadHandle = getReadHandle;
  self.getSimilar = getSimilar;
  self.acquireForProcessing = acquireForProcessing;
  self.checkQuotaAndEvict = checkQuotaAndEvict;
  self.getStorageStats = getStorageStats;
  self.startEvictorLoop = startEvictorLoop;
  self.stopEvictorLoop = stopEvictorLoop;
  console.log('storage.js: Worker globals set up successfully');
}

console.log('storage.js: Module loaded successfully');