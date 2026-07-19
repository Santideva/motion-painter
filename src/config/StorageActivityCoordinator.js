// /src/config/StorageActivityCoordinator.js
//
// Lightweight cross-worker/tab coordination for exclusive IndexedDB "campaigns"
// (long sequences of readwrite transactions against the shared artifacts/pins/
// counters/reconStatus stores) that otherwise silently serialize against each
// other and blow the timeout of whichever side started second.
//
// Transport: BroadcastChannel('motion-painter-store') — the same channel
// already used throughout the pipeline, so no extra connections are opened.

const CHANNEL_NAME = 'motion-painter-store';
const ANNOUNCE_INTERVAL_MS = 15000;

let _bc = null;
const _active = new Map();
const _announceTimers = new Map();
const _waiters = new Map();

function _ensureChannel() {
  if (_bc) return _bc;
  try {
    _bc = new BroadcastChannel(CHANNEL_NAME);
    _bc.addEventListener('message', _onMessage);
  } catch (e) {
    console.warn('[StorageActivityCoordinator] BroadcastChannel unavailable', e);
    _bc = null;
  }
  return _bc;
}

function _onMessage(ev) {
  const data = ev.data || {};
  switch (data.event) {
    case 'coordinator:begin':
    case 'coordinator:announce':
      if (data.activityId) {
        _active.set(data.activityId, {
          kind: data.kind, owner: data.owner,
          startedAt: data.startedAt, priority: data.priority ?? 0
        });
      }
      break;
    case 'coordinator:end':
      if (data.activityId) {
        _active.delete(data.activityId);
        _wake(data.kind);
      }
      break;
    case 'coordinator:queryState':
      for (const [activityId, rec] of _active.entries()) {
        if (_announceTimers.has(activityId)) {
          _post('coordinator:announce', { activityId, ...rec });
        }
      }
      break;
  }
}

function _post(event, payload) {
  const bc = _ensureChannel();
  if (!bc) return;
  try { bc.postMessage({ event, source: 'StorageActivityCoordinator', ...payload }); }
  catch (e) { /* ignore */ }
}

function _wake(kind) {
  const set = _waiters.get(kind);
  if (!set) return;
  for (const fn of set) { try { fn(); } catch (e) {} }
}

function _genId() {
  return `act:${Date.now()}:${Math.random().toString(36).slice(2, 9)}`;
}

export function isActive(kind) {
  for (const rec of _active.values()) if (rec.kind === kind) return true;
  return false;
}

export function listActive(kind) {
  const out = [];
  for (const [activityId, rec] of _active.entries()) {
    if (!kind || rec.kind === kind) out.push({ activityId, ...rec });
  }
  return out;
}

export function begin(kind, owner = 'unknown', { priority = 0 } = {}) {
  _ensureChannel();
  const activityId = _genId();
  const rec = { kind, owner, startedAt: Date.now(), priority };
  _active.set(activityId, rec);
  _post('coordinator:begin', { activityId, ...rec });

  const timer = setInterval(() => {
    _post('coordinator:announce', { activityId, ...rec });
  }, ANNOUNCE_INTERVAL_MS);
  _announceTimers.set(activityId, timer);

  return activityId;
}

export function end(activityId) {
  const rec = _active.get(activityId);
  _active.delete(activityId);
  const timer = _announceTimers.get(activityId);
  if (timer) { clearInterval(timer); _announceTimers.delete(activityId); }
  _post('coordinator:end', { activityId, kind: rec?.kind });
}

export function waitForClear(kind, { timeoutMs = 30000, pollMs = 250 } = {}) {
  _ensureChannel();
  if (!isActive(kind)) return Promise.resolve({ cleared: true, waitedMs: 0 });

  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    let pollHandle = null;
    let timeoutHandle = null;

    const cleanup = () => {
      if (pollHandle) clearInterval(pollHandle);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const set = _waiters.get(kind);
      if (set) set.delete(wake);
    };

    const finish = (cleared) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ cleared, waitedMs: Date.now() - t0 });
    };

    const wake = () => { if (!isActive(kind)) finish(true); };

    if (!_waiters.has(kind)) _waiters.set(kind, new Set());
    _waiters.get(kind).add(wake);

    pollHandle = setInterval(() => { if (!isActive(kind)) finish(true); }, pollMs);
    timeoutHandle = setTimeout(() => finish(false), timeoutMs);
  });
}

_ensureChannel();
_post('coordinator:queryState', {});

const StorageActivityCoordinator = { begin, end, isActive, listActive, waitForClear };
export default StorageActivityCoordinator;