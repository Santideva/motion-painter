// src/config/featureFlags.js
// Robust feature flags helper for Motion-Painter
// Implements: localStorage persistence (with quota detection), BroadcastChannel bootstrap + handler registry,
// synchronous subscribe bootstrap, monotonic __seq management, reserved-key protection, and safe BC replacement.

/* eslint-disable no-console */

const FEATURE_FLAGS_VERSION = 2; // bump when defaults change incompatibly
const STORAGE_KEY = 'motionPainter.features.v1';
const BC_CHANNEL = 'motion-painter-store';

// ------------------------ Defaults ------------------------
const DEFAULTS = {
  // Core features & pipelines
  enableFresnelEviction: false,
  enablePackingSdf: false,
  enableKeypointPipeline: false,
  enableAmbiAdapter: false,
  enablePascalQuadSdf: false,
  enableTopologyEngine: false,
  fmapGeneration: false,
  topologyTelemetry: false,
  enableMotionWorker: true,
  enableSamplerPlugins: true,
  enableDevPanels: false,

  // Flux / Poynting-proxy related
  enableFlux: false,
  fluxMode: 'coarse',
  fluxComputeResolutionDivisor: 8,
  fluxQuantization: 'float16',
  fluxFlowMethod: 'pyrLK',
  fluxAlpha: 1.0,
  fluxBeta: 0.5,
  fluxGamma: 0.3,
  fluxSmoothingSpatialSigma: 1.0,
  fluxSmoothingTemporalWindow: 3,
  fluxFTLEIntegrationSteps: 5,
  fluxVortexThresholdStdMult: 2.0,
  fluxSampleRateWorld: 8,
  fluxDiagnosticsEnabled: false,
  fluxTelemetryEnabled: false,
  fluxPersistFullResOnDemand: true,
  fluxWorkerCount: 1,

  // Topology tuning
  topologyPersistenceThreshold: 0.05,
  topologyLcsThresholdPct: 0.05,
  topologyUseFluxAsFiltration: false,
  topologyComputeOnDemand: true,

  // Safety / scaffolding
  featureFlagsVersion: FEATURE_FLAGS_VERSION
};

// ------------------------ Internal state ------------------------
let _inMemoryFallback = null; // fallback if localStorage not available
let _flags = null;            // will be initialized synchronously in init()
const _subs = new Set();      // subscribers
const _keySubs = new Map();   // key -> Set(subscribers)

// BroadcastChannel registry and handlers
let _bc = null;
const _bcHandlers = new Map();       // originalHandler -> wrappedListener
const _pendingBcRegistrations = new Set(); // originals queued while bc is null

// persistence availability (turned off when quota exceeded)
let _persistenceAvailable = true;

/* ------------------------ Utilities ------------------------ */

function deepClone(o) {
  try {
    return JSON.parse(JSON.stringify(o));
  } catch (e) {
    // fallback shallow clone
    if (typeof o === 'object' && o !== null) return Object.assign({}, o);
    return o;
  }
}

function _hasLocalStorage() {
  try {
    if (typeof localStorage === 'undefined') return false;
    const probe = `${STORAGE_KEY}:probe`;
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch (e) {
    return false;
  }
}

/* ------------------------ Sequence management ------------------------ */
/**
 * Maintain a monotonic-ish __seq that monotonically increases and resists 32-bit wrap.
 * Uses Date.now() as a seed to avoid small wrap problems and ensure forward progress.
 */
function _ensureSeqObject(obj) {
  if (!obj) return;
  if (typeof obj.__seq !== 'number') {
    obj.__seq = Date.now() & 0x7fffffff;
  }
}

function _bumpSeq() {
  // Ensure _flags exists
  if (!_flags) return;
  const now = Date.now() & 0x7fffffff;
  if (typeof _flags.__seq !== 'number') {
    _flags.__seq = now;
    return;
  }
  // next as unsigned-like increment (>>>0 for numeric behavior)
  const cand = (_flags.__seq + 1) >>> 0;
  // detect wrap or non-increasing; reseed from timestamp if needed
  if (cand <= _flags.__seq) {
    _flags.__seq = now;
  } else {
    _flags.__seq = Math.max(cand, now);
  }
}

/* ------------------------ Persistence helpers ------------------------ */

function _readFlagsFromStorage() {
  try {
    if (_hasLocalStorage()) {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        const initial = Object.assign({}, DEFAULTS);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(initial)); } catch (e) { /* best-effort */ }
        _inMemoryFallback = initial;
        const copy = deepClone(initial);
        _ensureSeqObject(copy);
        return copy;
      }
      const parsed = JSON.parse(raw || '{}') || {};
      const merged = Object.assign({}, DEFAULTS, parsed);
      if (!('featureFlagsVersion' in merged)) merged.featureFlagsVersion = FEATURE_FLAGS_VERSION;
      // ensure sequence
      _ensureSeqObject(merged);
      _inMemoryFallback = merged;
      return deepClone(merged);
    } else {
      if (!_inMemoryFallback) _inMemoryFallback = Object.assign({}, DEFAULTS);
      const copy = deepClone(_inMemoryFallback);
      _ensureSeqObject(copy);
      return copy;
    }
  } catch (err) {
    console.warn('[featureFlags] read error', err);
    if (!_inMemoryFallback) _inMemoryFallback = Object.assign({}, DEFAULTS);
    const copy = deepClone(_inMemoryFallback);
    _ensureSeqObject(copy);
    return copy;
  }
}

function _writeFlagsToStorage(obj) {
  try {
    // Ensure __seq present and bumped before writing
    _ensureSeqObject(obj);
    // write to persistent storage if available
    const toStore = Object.assign({}, obj);
    if (_hasLocalStorage() && _persistenceAvailable) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
    } else {
      // fallback
      _inMemoryFallback = toStore;
    }
  } catch (err) {
    // detect quota exceeded / storage errors
    const isQuota = err && (err.name === 'QuotaExceededError' || err.code === 22 || /quota/i.test(String(err)));
    console.warn('[featureFlags] write error', err);
    if (isQuota) {
      _persistenceAvailable = false;
      console.warn('[featureFlags] localStorage quota exceeded - persistence disabled; using in-memory fallback');
      // notify subscribers that persistence was disabled
      try {
        _postUpdateEvent({ persistenceDisabled: true });
        _broadcastFlags({ persistenceDisabled: true });
      } catch (e) {}
    }
    _inMemoryFallback = Object.assign({}, obj);
  }
}

/* ------------------------ BroadcastChannel management ------------------------ */

/**
 * Create or re-initialize BroadcastChannel if possible.
 * Attach any pending handler registrations.
 */
function _initBroadcastChannel() {
  try {
    if (typeof BroadcastChannel === 'undefined') {
      _bc = null;
      return;
    }
    if (_bc && typeof _bc.close === 'function') {
      // keep existing if already created (do not re-create)
      return;
    }
    _bc = new BroadcastChannel(BC_CHANNEL);
    // attach any previously registered handlers (wrapped)
    _attachAllBcHandlers();
  } catch (err) {
    _bc = null;
    console.warn('[featureFlags] BroadcastChannel init failed', err);
  }
}

/**
 * Attach all stored handlers (in _bcHandlers and any pending) to the current _bc.
 */
function _attachAllBcHandlers() {
  if (!_bc) return;
  // Attach pending originals (if any)
  _pendingBcRegistrations.forEach(orig => {
    try {
      if (_bcHandlers.has(orig)) return; // already wrapped/attached
      const wrapped = (ev) => {
        try { orig(ev.data); } catch (e) { console.warn('[featureFlags] broadcast handler error', e); }
      };
      _bcHandlers.set(orig, wrapped);
      _bc.addEventListener('message', wrapped);
    } catch (e) {
      console.warn('[featureFlags] attach handler failed', e);
    }
  });
  _pendingBcRegistrations.clear();

  // For any pre-registered handlers that exist in _bcHandlers but were not attached yet,
  // ensure they are attached.
  _bcHandlers.forEach((wrapped, orig) => {
    try {
      // For safety, try remove then add (idempotent)
      try { _bc.removeEventListener('message', wrapped); } catch (_) {}
      _bc.addEventListener('message', wrapped);
    } catch (e) {
      console.warn('[featureFlags] attach existing handler failed', e);
    }
  });
}

/**
 * Detach all wrapped handlers from the given channel (used during replace).
 */
function _detachAllFromChannel(channel) {
  if (!channel) return;
  _bcHandlers.forEach((wrapped) => {
    try {
      channel.removeEventListener('message', wrapped);
    } catch (e) {
      // ignore
    }
  });
}

/* ------------------------ Notification helpers ------------------------ */

function _postUpdateEvent(detail = {}) {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      const ev = new CustomEvent('motionPainter:flagsChanged', { detail });
      window.dispatchEvent(ev);
    }
  } catch (e) {
    // ignore
  }
}

function _broadcastFlags(detail = {}) {
  try {
    if (_bc) {
      _bc.postMessage(Object.assign({ event: 'flagsChanged', flags: getFlags() }, detail));
    }
  } catch (e) {
    // ignore
  }
}

function _notifyLocalSubscribers(payload = {}) {
  // general subscribers
  _subs.forEach(fn => {
    try { fn(payload); } catch (e) { console.warn('[featureFlags] subscriber error', e); }
  });

  // key-specific subscribers
  if (payload && payload.key) {
    const set = _keySubs.get(payload.key);
    if (set) {
      set.forEach(fn => {
        try { fn(payload); } catch (e) { console.warn('[featureFlags] key-subscriber error', e); }
      });
    }
  }
}

/* ------------------------ Validation ------------------------ */

const _RESERVED_PREFIX = '_';
const _RESERVED_KEYS = new Set(['__seq', 'featureFlagsVersion']);

function _assertNotReservedKey(key) {
  if (typeof key !== 'string') throw new Error('featureFlags: key must be a string');
  if (key.startsWith(_RESERVED_PREFIX) || _RESERVED_KEYS.has(key)) {
    throw new Error(`featureFlags: attempt to set reserved key "${key}"`);
  }
}

/**
 * If the key exists in DEFAULTS, try to coerce simple types and warn on mismatch.
 * This is tolerant by default (warn + coerce), not strict.
 */
function _coerceOrWarn(key, value) {
  if (key in DEFAULTS) {
    const expectedType = typeof DEFAULTS[key];
    if (expectedType !== typeof value) {
      // simple coercions
      if (expectedType === 'boolean') {
        if (value === 'true' || value === '1') return true;
        if (value === 'false' || value === '0') return false;
      } else if (expectedType === 'number') {
        const n = Number(value);
        if (!Number.isNaN(n)) return n;
      }
      console.warn(`[featureFlags] type mismatch for ${key}: expected ${expectedType} got ${typeof value}`);
    }
  }
  return value;
}

/* ------------------------ Public API ------------------------ */

/** getFlags() - shallow cloned snapshot */
export function getFlags() {
  return Object.assign({}, _flags);
}

/** getFlag(key) - raw value for a key */
export function getFlag(key) {
  return _flags ? _flags[key] : undefined;
}

/** getSeq() - convenience to read __seq */
export function getSeq() {
  return _flags ? (_flags.__seq || 0) : 0;
}

/** setFlag(key, value) - set a single flag with validation */
export function setFlag(key, value) {
  _assertNotReservedKey(key);
  const before = getFlags();
  const coerced = _coerceOrWarn(key, value);
  _flags = Object.assign({}, _flags, { [key]: coerced });

  // bump seq
  _bumpSeq();

  // persist
  _writeFlagsToStorage(_flags);

  const payload = { key, value: coerced, flags: getFlags(), prev: before };
  _postUpdateEvent(payload);
  _broadcastFlags(payload);
  _notifyLocalSubscribers(payload);

  return getFlags();
}

/** setFlags(obj) - atomically set multiple flags */
export function setFlags(obj = {}) {
  if (!obj || typeof obj !== 'object') throw new Error('setFlags requires an object');
  // validate keys
  Object.keys(obj).forEach(k => {
    if (_RESERVED_KEYS.has(k) || k.startsWith(_RESERVED_PREFIX)) {
      throw new Error(`setFlags: reserved key in payload: ${k}`);
    }
  });

  const before = getFlags();
  // coerce values where possible
  const normalized = {};
  Object.keys(obj).forEach(k => { normalized[k] = _coerceOrWarn(k, obj[k]); });

  _flags = Object.assign({}, _flags, normalized);

  // bump seq
  _bumpSeq();

  // persist
  _writeFlagsToStorage(_flags);

  const payload = { keys: Object.keys(normalized), changes: deepClone(normalized), flags: getFlags(), prev: before };
  _postUpdateEvent(payload);
  _broadcastFlags(payload);
  _notifyLocalSubscribers(payload);

  return getFlags();
}

/** toggleFlag(key) - flip boolean-ish */
export function toggleFlag(key) {
  _assertNotReservedKey(key);
  const current = getFlag(key);
  const next = !(current === true);
  return setFlag(key, next);
}

/** resetFlags() - reset to DEFAULTS */
export function resetFlags() {
  _flags = Object.assign({}, DEFAULTS);
  // fresh seq
  _ensureSeqObject(_flags);
  _bumpSeq();

  _writeFlagsToStorage(_flags);
  const payload = { reset: true, flags: getFlags() };
  _postUpdateEvent(payload);
  _broadcastFlags(payload);
  _notifyLocalSubscribers(payload);
  return getFlags();
}

/** subscribe(fn) - synchronous bootstrap + unsubscribe */
/** subscribe(fn) - synchronous register + microtask bootstrap */
export function subscribe(fn) {
  if (typeof fn !== 'function') throw new Error('subscribe requires a function');

  // Add to subscribers synchronously
  _subs.add(fn);

  // Capture snapshot once (cheap)
  const snapshot = getFlags();

  // Invoke bootstrap asynchronously but as a microtask so callers that
  // rely on immediate-return of unsubscribe are safe (avoids waitForFlag race).
  // Payload includes seq so consumers can detect staleness if they care.
  try {
    queueMicrotask(() => {
      try {
        fn({ flags: snapshot });
      } catch (e) {
        console.warn('[featureFlags] subscriber initial call error', e);
      }
    });
  } catch (e) {
    // fallback if queueMicrotask unavailable (older env)
    try {
      setTimeout(() => {
        try { fn({ flags: snapshot }); } catch (err) { console.warn('[featureFlags] subscriber initial call error', err); }
      }, 0);
    } catch (err) {
      // give up gracefully
    }
  }

  // return unsubscribe
  return () => _subs.delete(fn);
}

/** subscribeKey(key, fn) - subscribe to specific key changes */
export function subscribeKey(key, fn) {
  if (typeof key !== 'string') throw new Error('subscribeKey requires string key');
  if (typeof fn !== 'function') throw new Error('subscribeKey requires a function');

  let set = _keySubs.get(key);
  if (!set) {
    set = new Set();
    _keySubs.set(key, set);
  }
  set.add(fn);

  const snapshot = { key, value: getFlag(key), flags: getFlags() };

  try {
    queueMicrotask(() => {
      try {
        fn(snapshot);
      } catch (e) {
        console.warn('[featureFlags] key-subscriber initial call error', e);
      }
    });
  } catch (e) {
    setTimeout(() => {
      try { fn(snapshot); } catch (err) { console.warn('[featureFlags] key-subscriber initial call error', err); }
    }, 0);
  }

  return () => {
    const s = _keySubs.get(key);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) _keySubs.delete(key);
  };
}

/**
 * onBroadcastMessage(handler) - register a handler for BC messages (worker-friendly).
 * Handler will receive the message payload (ev.data). Returns an unsubscribe function.
 *
 * Handlers are stored and attached when BroadcastChannel is available. Replacing BC
 * via _replaceBroadcastChannel reattaches stored handlers to the new channel.
 */
export function onBroadcastMessage(handler) {
  if (typeof handler !== 'function') {
    console.warn('[featureFlags] onBroadcastMessage requires a function handler');
    return () => {};
  }

  // If we already have the handler registered, don't duplicate
  if (_bcHandlers.has(handler)) {
    // Already registered -> return unsubscribe
    return () => {
      const wrapped = _bcHandlers.get(handler);
      try {
        if (_bc && wrapped) _bc.removeEventListener('message', wrapped);
      } catch (e) {}
      _bcHandlers.delete(handler);
    };
  }

  // Create wrapped listener
  const wrapped = (ev) => {
    try { handler(ev.data); } catch (e) { console.warn('[featureFlags] broadcast handler error', e); }
  };

  // Record mapping
  _bcHandlers.set(handler, wrapped);

  if (_bc) {
    // attach immediately
    try {
      _bc.addEventListener('message', wrapped);
    } catch (e) {
      console.warn('[featureFlags] error adding broadcast listener', e);
    }
  } else {
    // queue for later attachment
    _pendingBcRegistrations.add(handler);
  }

  // Unsubscribe function
  return () => {
    try {
      const w = _bcHandlers.get(handler);
      if (w && _bc) {
        try { _bc.removeEventListener('message', w); } catch (e) {}
      }
    } catch (e) {}
    // Remove from pending registrations if queued
    _pendingBcRegistrations.delete(handler);
    _bcHandlers.delete(handler);
  };
}

/**
 * waitForFlag(key, desiredValue = true, timeoutMs = 10000)
 * Resolves when the flag matches the desiredValue or rejects on timeout.
 */
export function waitForFlag(key, desiredValue = true, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    // immediate check
    if (getFlag(key) === desiredValue) {
      return resolve(getFlags());
    }

    let resolved = false;
    let timeoutHandle = null;

    // subscribe and capture the unsubscribe immediately (safe: subscribe now returns unsubscribe)
    const unsub = subscribe(() => {
      if (resolved) return;
      try {
        const current = getFlag(key);
        if (current === desiredValue) {
          resolved = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          try { unsub(); } catch (_) {}
          resolve(getFlags());
        }
      } catch (e) {
        console.warn('[featureFlags] waitForFlag subscription error', e);
      }
    });

    timeoutHandle = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { unsub(); } catch (_) {}
      reject(new Error(`waitForFlag timeout waiting for ${key}===${String(desiredValue)}`));
    }, timeoutMs);
  });
}

/**
 * onFlagsChangeOnce(fn) - subscribe once (auto-unsubscribe even if handler throws)
 */
export function onFlagsChangeOnce(fn) {
  if (typeof fn !== 'function') throw new Error('onFlagsChangeOnce requires a function');

  let called = false;
  const unsub = subscribe((payload) => {
    if (called) return;
    called = true;
    try {
      fn(payload);
    } catch (e) {
      console.warn('[featureFlags] onFlagsChangeOnce handler error', e);
    } finally {
      unsub();
    }
  });

  return unsub;
}

/**
 * migrateFlags(migrationFn) - transform existing flags using a migration function
 */
export function migrateFlags(migrationFn) {
  if (typeof migrationFn !== 'function') throw new Error('migrateFlags requires a function');
  try {
    const before = getFlags();
    const next = migrationFn(deepClone(before)) || {};
    // prohibit reserved key writes
    Object.keys(next).forEach(k => {
      if (k.startsWith(_RESERVED_PREFIX) || _RESERVED_KEYS.has(k)) {
        throw new Error(`migrateFlags attempted to set reserved key ${k}`);
      }
    });
    _flags = Object.assign({}, DEFAULTS, next);
    _ensureSeqObject(_flags);
    _bumpSeq();
    _writeFlagsToStorage(_flags);
    const payload = { migrated: true, flags: getFlags(), prev: before };
    _postUpdateEvent(payload);
    _broadcastFlags(payload);
    _notifyLocalSubscribers(payload);
    return getFlags();
  } catch (err) {
    console.warn('[featureFlags] migrateFlags failed', err);
    throw err;
  }
}

/**
 * _replaceBroadcastChannel(newBc) - testing hook to replace the BC used internally.
 * Detaches all listeners from the old channel and attaches stored handlers to the new one.
 */
export function _replaceBroadcastChannel(newBc) {
  try {
    if (_bc && typeof _bc.close === 'function') {
      try { _detachAllFromChannel(_bc); } catch (e) {}
      try { _bc.close(); } catch (e) {}
    }
  } catch (e) {
    console.warn('[featureFlags] close old BC failed', e);
  }

  // set to new channel and attach existing handlers
  _bc = newBc;

  if (_bc) {
    // attach stored handlers to the new channel
    _attachAllBcHandlers();
  }
}

/**
 * broadcastCurrentFlags() - explicit helper to broadcast the current flags snapshot
 * via BroadcastChannel (or no-op if unavailable). Useful at app bootstrap.
 */
export function broadcastCurrentFlags() {
  try {
    if (!_bc) {
      _initBroadcastChannel();
    }
    if (_bc) {
      _bc.postMessage({ event: 'flagsChanged', flags: getFlags(), source: 'explicit:broadcast' });
    }
  } catch (e) {
    console.warn('[featureFlags] broadcastCurrentFlags failed', e);
  }
}

/* ------------------------ Initialization (synchronous) ------------------------ */

(function init() {
  try {
    // Read flags from storage (synchronously) and set _flags once.
    _flags = _readFlagsFromStorage();

    // Ensure __seq present
    _ensureSeqObject(_flags);

    // Initialize bc (attach any pending handlers)
    _initBroadcastChannel();

    // Persist sanitized flags back (ensures storage contains featureFlagsVersion and seq)
    _writeFlagsToStorage(_flags);
  } catch (err) {
    console.warn('[featureFlags] init error', err);
    if (!_flags) _flags = Object.assign({}, DEFAULTS);
    _ensureSeqObject(_flags);
  }
})();

/* ------------------------ Default export ------------------------ */

const featureFlags = {
  getFlags,
  getFlag,
  getSeq,
  setFlag,
  setFlags,
  toggleFlag,
  resetFlags,
  subscribe,
  subscribeKey,
  onBroadcastMessage,
  waitForFlag,
  onFlagsChangeOnce,
  migrateFlags,
  _replaceBroadcastChannel,
  broadcastCurrentFlags,
  DEFAULTS: Object.freeze(Object.assign({}, DEFAULTS))
};

export default featureFlags;
