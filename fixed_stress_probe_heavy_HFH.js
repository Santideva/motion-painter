/* FULL HFH HEAVY-PATH STRESS PROBE (COMPREHENSIVE)
   - Paste into browser console and run
   - Creates manifests + thumbs, triggers recon, collects RECON_DONE,
     fetches each derivedKey via storageAPI.getArtifact and fallback IndexedDB scan,
     attempts to inspect any blob/typed-array metadata and prints sizes.
   - Writes summary to window.E2E_HEAVY_PATH_TEST_FULL
*/

(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const now = () => Date.now();
  const safe = fn => { try { return fn(); } catch (e) { return undefined; } };
  const LOG = (...args) => console.log('[E2E]', ...args);
  const WARN = (...args) => console.warn('[E2E]', ...args);
  const ERR = (...args) => console.error('[E2E]', ...args);

  // ---------- 0) Lightweight console filter (non-destructive) ----------
  (function installFilter() {
    try {
      const ALLOW = ['[E2E]', '[HFH]', '[FrameEvictionHook]', '[ENSURE]', '[RECON]', '[TEST]'];
      const orig = { log: console.log.bind(console), warn: console.warn.bind(console), debug: console.debug ? console.debug.bind(console) : console.log.bind(console), error: console.error.bind(console) };
      function should(args) {
        try { return args.some(a => typeof a === 'string' && ALLOW.some(t => a.includes(t))); } catch(e) { return false; }
      }
      ['log','warn','debug'].forEach(k => console[k] = (...args) => { try { if (should(args) || (args[0] && typeof args[0] === 'string' && args[0].startsWith('[E2E]'))) orig[k](...args); } catch(e){ orig.log(...args); } });
      console.error = (...args) => orig.error(...args);
      orig.log('[E2E] ✓ Log filter installed');
    } catch (e) { console.error('[E2E] Console filter failure', e); }
  })();

  // ---------- 1) Gather components ----------
  LOG('━ Step 1: gather components');
  const app = safe(() => window.MotionPainter);
  const storageAPI = safe(() => window.storageAPI);
  const fb = safe(() => app && app.frameBuffer);
  const eh = safe(() => app && app.evictionHook);
  const md = safe(() => app && app.motionDetector);
  const pre = safe(() => app && app.preprocessor);
  const featureFlags = safe(() => window.featureFlags || (window.__featureFlags && window.__featureFlags.default) || null);

  const ctx = {
    appPresent: !!app,
    storageAPI: !!storageAPI,
    frameBuffer: !!fb,
    evictionHook: !!eh,
    motionDetector: !!md,
    preprocessor: !!pre,
    featureFlags: !!featureFlags
  };
  LOG('context:', ctx);

  if (!app || !fb || !eh || !md) {
    ERR('❌ Core components missing (app/frameBuffer/evictionHook/motionDetector required). Aborting.');
    window.E2E_HEAVY_PATH_TEST_FULL = { ok: false, reason: 'missing_core', ctx };
    return window.E2E_HEAVY_PATH_TEST_FULL;
  }

  // ---------- 2) Safe feature-flag dance: capture, set, restore ----------
  const FLAGS_WE_NEED = {
    enableHFH: true,
    enableReconstructionSolve: true,
    enableFlux: true,
    enablePreprocessQuantize: true,
    enablePreprocessAnnotate: true,
    fluxPersistFullResOnDemand: true,
    bssPersistSelector: true,
    reconTelemetryEnabled: true
  };

  let origFlags = null;
  let flagged = false;
  if (featureFlags && typeof featureFlags.getFlags === 'function' && typeof featureFlags.setFlags === 'function') {
    try {
      origFlags = featureFlags.getFlags();
      // capture only keys we plan to override
      const snapshot = {};
      Object.keys(FLAGS_WE_NEED).forEach(k => { snapshot[k] = origFlags[k]; });
      // Set desired flags (persisted) - we will restore later
      featureFlags.setFlags(FLAGS_WE_NEED);
      // broadcast explicitly if helper available
      if (typeof featureFlags.broadcastCurrentFlags === 'function') featureFlags.broadcastCurrentFlags();
      flagged = true;
      LOG('Temporary featureFlags set for heavy-path probe (will restore after probe).');
    } catch (e) {
      WARN('Could not safely set featureFlags:', e);
    }
  } else {
    WARN('featureFlags API not present - continuing without toggling flags (probe may be blocked by flags).');
  }

  // ---------- 3) Ensure MotionWorker exists ----------
  LOG('━ Step 2: ensure motion worker (non-invasive attempt)');
  async function ensureWorker(timeoutMs = 10000) {
    try {
      try { app._heavyPathRequested = true; } catch (e) {}
      if (typeof app._ensureMotionWorker === 'function') {
        try { app._ensureMotionWorker(); } catch (e) { WARN('app._ensureMotionWorker threw', e); }
      } else {
        WARN('app._ensureMotionWorker not found');
      }
      const start = now();
      while (now() - start < timeoutMs) {
        if (app.motionWorker) {
          const mw = app.motionWorker;
          const ready = mw.workerReady === true || (typeof mw.isReady === 'function' && mw.isReady());
          if (ready) return { ok: true, worker: mw };
          if (typeof mw.onReady === 'function') {
            let resolved = false;
            await new Promise(res => {
              const to = setTimeout(() => { if (!resolved) { resolved = true; res(); } }, Math.min(1000, timeoutMs - (now() - start)));
              try { mw.onReady(() => { if (!resolved) { resolved = true; clearTimeout(to); res(); } }); } catch (e) { resolved = true; clearTimeout(to); res(); }
            });
          } else {
            await sleep(200);
          }
        } else {
          await sleep(200);
        }
      }
      return { ok: false, reason: 'timeout_waiting_worker' };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  const workerEnsure = await ensureWorker(10000);
  LOG('workerEnsure ->', workerEnsure);

  // Attach raw worker listener if we can (to capture raw RECON_DONE messages)
  let rawWorkerListenerRemover = null;
  if (workerEnsure.ok && workerEnsure.worker && workerEnsure.worker.worker instanceof Worker) {
    try {
      const rawWorker = workerEnsure.worker.worker;
      const h = (ev) => { try { LOG('[WORKER MSG]', ev.data); } catch (e) { LOG('[WORKER MSG] (failed to print)', e); } };
      rawWorker.addEventListener('message', h);
      rawWorkerListenerRemover = () => { try { rawWorker.removeEventListener('message', h); } catch (e) {} };
      LOG('Attached temporary raw worker message listener (will remove at end).');
    } catch (e) { WARN('Could not attach raw worker listener', e); rawWorkerListenerRemover = null; }
  }

  // ---------- 4) Helpers: create thumbnail + persist artifact (storageAPI preferred) ----------
  LOG('━ Step 3: helpers');

  async function createSyntheticThumbnail(width = 512, height = 512, label = '') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx2 = canvas.getContext('2d');
    const gradient = ctx2.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#1a1a2e'); gradient.addColorStop(0.5, '#16213e'); gradient.addColorStop(1, '#0f3460');
    ctx2.fillStyle = gradient; ctx2.fillRect(0, 0, width, height);
    for (let i = 0; i < 120; i++) {
      const x = Math.random() * width, y = Math.random() * height, s = Math.random() * 4, a = Math.random() * 0.45;
      ctx2.fillStyle = `rgba(255,255,255,${a})`; ctx2.fillRect(x, y, s, s);
    }
    if (label) {
      ctx2.fillStyle = '#fff'; ctx2.font = '14px monospace';
      ctx2.fillText(label, 10, 20);
      ctx2.fillText(`${width}x${height}`, 10, 40);
      ctx2.fillText(`E2E Test Frame`, 10, height - 10);
    }
    return canvas.convertToBlob({ type: 'image/png', quality: 0.82 });
  }

  async function putArtifactViaStorageAPI(artifact) {
    if (!storageAPI) return { ok: false, reason: 'no_storageAPI' };
    // prefer putInboundArtifact (existing API shape)
    const fn = storageAPI.putInboundArtifact || storageAPI.putArtifact || storageAPI.put;
    if (typeof fn !== 'function') return { ok: false, reason: 'no_put_fn' };
    try {
      // storageAPI may expect the artifact shape you provide; wrap in try/catch
      const res = await fn(artifact);
      return { ok: true, method: 'storageAPI', res };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  async function persistArtifactFallbackIndexedDB(artifact) {
    // Try multiple DB names heuristically
    const dbNames = ['motionPainterDB','motion-painter-store','motionPainterStore','motion-painter','motion-painter-db'];
    try {
      if (typeof indexedDB.databases === 'function') {
        const dbs = await indexedDB.databases();
        dbs.forEach(d => d && d.name && dbNames.push(d.name));
      }
    } catch (e) {}
    const uniq = Array.from(new Set(dbNames));
    for (const name of uniq) {
      try {
        const openReq = indexedDB.open(name);
        const db = await new Promise((res, rej) => {
          openReq.onsuccess = () => res(openReq.result);
          openReq.onerror = () => rej(openReq.error);
        });
        if (!db || !db.objectStoreNames.contains('artifacts')) { if (db) db.close(); continue; }
        const tx = db.transaction('artifacts','readwrite');
        const store = tx.objectStore('artifacts');
        const putReq = store.put ? store.put(artifact) : store.add(artifact);
        await new Promise((res, rej) => {
          putReq.onsuccess = () => res();
          putReq.onerror = () => rej(putReq.error);
        });
        db.close();
        return { ok: true, method: `indexedDB:${name}` };
      } catch (e) {
        // try next
      }
    }
    return { ok: false, reason: 'no_persist_method' };
  }

  async function persistArtifact(artifact) {
    // prefer storageAPI
    try {
      if (storageAPI && typeof storageAPI.putInboundArtifact === 'function') {
        const r = await putArtifactViaStorageAPI(artifact);
        if (r.ok) return r;
      }
    } catch (e) { WARN('storageAPI.putInboundArtifact failed', e); }
    // fallback
    return await persistArtifactFallbackIndexedDB(artifact);
  }

  // ---------- 5) Build manifests + thumbnails and persist them ----------
  LOG('━ Step 4: create manifests with thumbnails');

  const attempts = 6;
  const manifestData = [];

  for (let i = 0; i < attempts; i++) {
    const t = Date.now() + i;
    const manifestKey = `artifact:manifest:e2e_force:${t}:${Math.floor(Math.random()*1e6)}`;
    const thumbKey = `artifact:thumb:e2e_force:${t}:${Math.floor(Math.random()*1e6)}`;

    LOG(`Creating manifest ${i+1}/${attempts}: ${manifestKey}`);

    // thumbnail blob
    let thumbBlob = null;
    try {
      thumbBlob = await createSyntheticThumbnail(512, 512, `E2E #${i+1}`);
    } catch (e) {
      ERR('Thumbnail creation failed', e);
      continue;
    }

    // persist thumbnail as frame artifact
    const thumbArtifact = {
      key: thumbKey,
      type: 'frame',
      blob: thumbBlob,
      meta: {
        timestamp: t,
        cameraId: app.cameraContainer?.cameraId || `e2e_camera_${i}`,
        width: 512,
        height: 512,
        source: 'e2e_synthetic',
        sizeBytes: thumbBlob.size || null
      },
      createdAt: new Date(t).toISOString()
    };

    const thumbPersist = await persistArtifact(thumbArtifact);
    if (!thumbPersist.ok) {
      WARN('Failed to persist thumbnail', thumbKey, thumbPersist);
      continue;
    }
    LOG('✓ Thumbnail persisted:', thumbKey, 'via', thumbPersist.method || thumbPersist.res?.metaKey || 'unknown');

    // create annular data
    const annLen = 12;
    const ann = new Float32Array(annLen);
    for (let j = 0; j < annLen; j++) ann[j] = Math.random() * 0.05;
    ann[2] = 0.98 + (i / 1000);

    const manifestArtifact = {
      key: manifestKey,
      type: 'manifest',
      meta: {
        timestamp: t,
        cameraId: app.cameraContainer?.cameraId || `e2e_camera_${i}`,
        source: 'e2e_force',
        sizeBytes: 2048
      },
      data: {
        keys: [thumbKey],
        cameraId: app.cameraContainer?.cameraId || `e2e_camera_${i}`,
        cameraContainer: app.cameraContainer || null,
        width: 512,
        height: 512,
        timestamp: t,
        createdAt: new Date(t).toISOString(),
        hfh: {
          annular: ann,                 // typed array retained for storage adapters that support it
          annularArray: Array.from(ann),
          annularCounts: Array.from(new Uint32Array(annLen).fill(1)),
          annularStats: {
            mean: 0.05, stddev: 0.25, min: 0, max: 1,
            spikeDetected: true, spikeIndex: 2, spikeValue: ann[2]
          }
        },
        hfhDecision: {
          shouldRun: true,
          reason: 'e2e_forced_spike',
          severity: 0.99,
          suggestedResolution: 512,
          suggestedMode: 'heavy',
          confidence: 0.95
        },
        calibrationKey: null,
        source: 'e2e_stress_test',
        syntheticFrame: true
      },
      createdAt: new Date(t).toISOString()
    };

    const manifestPersist = await persistArtifact(manifestArtifact);
    if (!manifestPersist.ok) {
      WARN('Failed to persist manifest', manifestKey, manifestPersist);
      continue;
    }
    LOG('✓ Manifest persisted:', manifestKey, 'via', manifestPersist.method || manifestPersist.res?.metaKey || 'unknown');

    manifestData.push({ manifestKey, thumbKey, timestamp: t });
    await sleep(120);
  }

  LOG('Created manifests:', manifestData.length);

  // ---------- 6) Broadcast artifact:ready events ----------
  LOG('━ Step 5: broadcast artifact:ready events');

  const bc = ('BroadcastChannel' in window) ? new BroadcastChannel('motion-painter-store') : null;
  const bcPost = (m) => {
    try {
      if (bc) bc.postMessage(m);
      try { window.postMessage && window.postMessage(m, '*'); } catch(e) {}
    } catch (e) { WARN('BC post failed', e); }
  };

  for (const item of manifestData) {
    bcPost({
      event: 'artifact:ready',
      metaKey: item.manifestKey,
      type: 'manifest',
      meta: { cameraId: app.cameraContainer?.cameraId, timestamp: item.timestamp }
    });

    bcPost({
      op: 'artifact:ready',
      artifact: { key: item.manifestKey, type: 'manifest' }
    });

    LOG('Broadcast artifact:ready for', item.manifestKey);
    await sleep(80);
  }

  // ---------- 7) Create MotionDetector intents and pass metaKey ----------
  LOG('━ Step 6: create intents and notify MotionDetector');

  const createdIntents = [];
  for (const item of manifestData) {
    try {
      const jobId = `e2ejob:${Math.floor(Math.random()*1e9)}`;
      if (typeof md._createIntent === 'function') {
        md._createIntent({
          jobId,
          cameraId: app.cameraContainer?.cameraId || 'e2e_camera',
          reason: 'e2e_force',
          priority: 99,
          meta: { width: 512, height: 512 },
          annular: new Float32Array(12).fill(0.5),
          avgLuma: 0.5
        });
        const intentId = md._intentsByJobId ? md._intentsByJobId.get(jobId) : null;
        createdIntents.push({ jobId, intentId, metaKey: item.manifestKey });
        LOG('Created intent', jobId, '->', intentId);
      } else {
        WARN('md._createIntent not available');
      }

      const payload = { metaKey: item.manifestKey, jobId, meta: { type: 'manifest', cameraId: app.cameraContainer?.cameraId } };
      bcPost({ event: 'artifact:ready', ...payload });

      if (typeof md.onArtifactReady === 'function') {
        try { md.onArtifactReady(payload); LOG('md.onArtifactReady called for', jobId); } catch(e) { WARN('md.onArtifactReady failed', e); }
      }

      await sleep(140);
    } catch (e) {
      WARN('Intent creation error', e);
    }
  }

  // ---------- 8) Listen for RECON_DONE (BC + raw worker) ----------
  LOG('━ Step 7: listen for RECON_DONE (60s watch)');

  const reconEvents = [];
  const bcListener = (ev) => {
    try {
      const d = ev && ev.data ? ev.data : ev;
      if (!d) return;
      if (d.event === 'RECON_DONE' || d.op === 'RECON_DONE' || d.type === 'RECON_DONE' || d.event === 'artifact:ready:recon_done') {
        LOG('[BC] RECON_DONE', d);
        reconEvents.push({ source: 'BC', payload: d, ts: Date.now() });
      } else if (d.event === 'RECON_FAIL' || d.op === 'RECON_FAIL') {
        LOG('[BC] RECON_FAIL', d);
        reconEvents.push({ source: 'BC', payload: d, ts: Date.now() });
      } else if (d.event === 'artifact:ready') {
        // ignore
      } else {
        // ignore other BC events
      }
    } catch (e) { WARN('bcListener err', e); }
  };

  if (bc) {
    try { bc.addEventListener('message', bcListener); } catch (e) { try { bc.onmessage = (ev) => bcListener(ev); } catch (e2) { WARN('Failed to attach bc listener', e2); } }
  } else {
    LOG('BroadcastChannel not available in this environment, relying on raw worker messages only.');
  }

  // Also capture raw worker messages already attached above printed to console; reconEvents can be filled if needed by listening to app.motionWorker wrapper:
  if (app.motionWorker && typeof app.motionWorker.onMessage === 'function') {
    try {
      app.motionWorker.onMessage((m) => {
        try {
          if (m && (m.event === 'RECON_DONE' || m.event === 'RECON_FAIL')) {
            reconEvents.push({ source: 'wrapper', payload: m, ts: Date.now() });
            LOG('[wrapper] RECON event', m);
          }
        } catch (e) {}
      });
    } catch (e) {}
  }

  // wait for recon events (timeout)
  const watchStart = now();
  const watchTimeout = 60000;
  let lastRecon = null;

  while (now() - watchStart < watchTimeout) {
    // attempt to also inspect raw worker message queue via the wrapper if available
    if (reconEvents.length > 0) {
      lastRecon = reconEvents[reconEvents.length - 1];
      break;
    }
    await sleep(500);
  }

  if (!lastRecon) {
    WARN('No RECON_DONE observed within timeout. Dumping reconEvents array (may contain RECON_FAIL):', reconEvents.slice(-5));
  } else {
    LOG('Captured RECON event:', lastRecon);
  }

  // ---------- 9) Determine derivedKeys to inspect ----------
  let derivedKeys = [];
  try {
    if (lastRecon && lastRecon.payload) {
      const p = lastRecon.payload;
      // payload shape variations: {derivedKeys: []} or {result:{derivedKeys:[]}} or op/reply wrapper
      if (Array.isArray(p.derivedKeys)) derivedKeys = p.derivedKeys.slice();
      else if (p.result && Array.isArray(p.result.derivedKeys)) derivedKeys = p.result.derivedKeys.slice();
      else if (p.payload && Array.isArray(p.payload.derivedKeys)) derivedKeys = p.payload.derivedKeys.slice();
      else if (p.meta && Array.isArray(p.meta.derivedKeys)) derivedKeys = p.meta.derivedKeys.slice();
    }
  } catch (e) { WARN('Could not extract derivedKeys from recon payload', e); }

  // If none found, attempt to read reconStatus table to find recent finished entry with our manifest keys
  if (!derivedKeys.length) {
    try {
      // try storageAPI.getReconStatus if available
      if (storageAPI && typeof storageAPI.getReconStatus === 'function') {
        // scan last few manifests for reconStatus entries
        for (const m of manifestData) {
          try {
            const st = await storageAPI.getReconStatus(m.manifestKey);
            if (st && Array.isArray(st.derivedKeys) && st.derivedKeys.length) {
              derivedKeys.push(...st.derivedKeys);
            }
          } catch (e) {}
        }
      } else {
        // fallback: scan IndexedDB reconStatus store
        try {
          const dbReq = indexedDB.open('motionPainterDB');
          const db = await new Promise((res, rej) => { dbReq.onsuccess = () => res(dbReq.result); dbReq.onerror = () => rej(dbReq.error); });
          if (db && db.objectStoreNames.contains('reconStatus')) {
            const tx = db.transaction('reconStatus','readonly');
            const store = tx.objectStore('reconStatus');
            const req = store.getAll();
            const all = await new Promise((res, rej) => { req.onsuccess = () => res(req.result || []); req.onerror = () => rej(req.error); });
            db.close();
            for (const r of (all||[])) {
              if (r && Array.isArray(r.derivedKeys) && r.derivedKeys.length) {
                // filter by our manifest keys
                if (manifestData.some(m => m.manifestKey === r.metaKey) || (r.metaKey && typeof r.metaKey === 'string' && r.metaKey.includes('e2e_force'))) {
                  derivedKeys.push(...r.derivedKeys);
                }
              }
            }
          }
        } catch (e) { /* ignore */ }
      }
    } catch (e) { WARN('reconStatus scan failed', e); }
  }

  // unique
  derivedKeys = Array.from(new Set(derivedKeys));
  LOG('Derived keys to inspect:', derivedKeys);

  // ---------- 10) For each derivedKey, attempt to fetch and inspect artifact ----------
  async function fetchArtifactViaStorageAPI(metaKey) {
    if (!storageAPI) return { ok: false, reason: 'no_storageAPI' };
    if (typeof storageAPI.getArtifact !== 'function') return { ok: false, reason: 'no_getArtifact' };
    try {
      // many storage APIs accept options like {denormalize:true}
      const art = await storageAPI.getArtifact(metaKey, { denormalize: true }).catch(async (e) => {
        // some adapters expose getArtifact(metaKey) only
        try { return await storageAPI.getArtifact(metaKey); } catch (e2) { throw e; }
      });
      if (!art) return { ok: false, reason: 'null' };
      return { ok: true, method: 'storageAPI', artifact: art };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  async function scanIndexedDBForKey(metaKey) {
    const hits = [];
    try {
      // candidate DB names
      const dbNames = ['motionPainterDB','motion-painter-store','motionPainterStore','motion-painter','motion-painter-db'];
      try {
        if (typeof indexedDB.databases === 'function') {
          const dbs = await indexedDB.databases();
          dbs.forEach(d => d && d.name && dbNames.push(d.name));
        }
      } catch (e) {}
      const uniq = Array.from(new Set(dbNames));
      for (const name of uniq) {
        try {
          const openReq = indexedDB.open(name);
          const db = await new Promise((res, rej) => { openReq.onsuccess = () => res(openReq.result); openReq.onerror = () => rej(openReq.error); });
          if (!db) continue;
          for (let i=0;i<db.objectStoreNames.length;i++) {
            const storeName = db.objectStoreNames[i];
            try {
              const tx = db.transaction(storeName,'readonly');
              const store = tx.objectStore(storeName);
              // try get by key
              const req = store.get(metaKey);
              const rec = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
              if (rec) {
                hits.push({ db: name, store: storeName, record: rec });
              } else {
                // sometimes key is in .key or .metaKey property - scan all (careful)
                // we will only scan small stores to avoid blocking — but we must be thorough for artifacts
                if (store.getAll) {
                  const allReq = store.getAll();
                  const all = await new Promise((res, rej) => { allReq.onsuccess = () => res(allReq.result || []); allReq.onerror = () => rej(allReq.error); });
                  const match = (all || []).find(x => (x && (x.key === metaKey || x.metaKey === metaKey || x?.meta?.metaKey === metaKey || x?.metaKey === metaKey)));
                  if (match) hits.push({ db: name, store: storeName, record: match });
                }
              }
            } catch (e) {
              // continue to next store
            }
          }
          db.close();
        } catch (e) {
          // continue to next db
        }
      }
    } catch (e) {
      WARN('IndexedDB exhaustive scan failed', e);
    }
    return hits;
  }

  async function inspectRecord(record) {
    // record shape: { key, type, blob, data, meta, createdAt, ... }
    const info = { hasBlob: false, blobSize: null, typedArrayMeta: null, dataKeys: null, raw: record };
    try {
      if (!record) return info;
      if ('blob' in record && record.blob) {
        info.hasBlob = true;
        try { info.blobSize = record.blob.size; } catch (e) { info.blobSize = null; }
        // try to make typed array if meta indicates
        const taType = record.meta && record.meta.typedArrayType;
        if (taType && typeof record.blob.arrayBuffer === 'function') {
          try {
            const ab = await record.blob.arrayBuffer();
            // don't assume float32 always; but if typedArrayType === 'Float32Array' try to reconstruct
            if (taType === 'Float32Array') {
              info.typedArrayMeta = { typedArrayType: taType, length: Math.floor(ab.byteLength / 4) };
              info.typedArraySample = (new Float32Array(ab.slice(0, Math.min(ab.byteLength, 256)))) .slice(0,10);
            } else if (taType === 'Uint8Array' || taType === 'Uint8ClampedArray') {
              info.typedArrayMeta = { typedArrayType: taType, length: ab.byteLength };
            } else {
              info.typedArrayMeta = { typedArrayType: taType, bytes: ab.byteLength };
            }
          } catch (e) {
            info._blobReadError = String(e);
          }
        }
      } else {
        // no blob - inspect data for typed arrays or serialized forms
        if (record.data && typeof record.data === 'object') {
          info.dataKeys = Object.keys(record.data).slice(0, 12);
          // detect arrays
          for (const k of Object.keys(record.data)) {
            const v = record.data[k];
            if (v && typeof v === 'object' && (Array.isArray(v) || (v.buffer instanceof ArrayBuffer))) {
              // array-like
              info.typedArrayMeta = info.typedArrayMeta || {};
              info.typedArrayMeta[k] = { type: (v.constructor && v.constructor.name) || typeof v, length: v.length || null };
            }
          }
        }
      }
    } catch (e) {
      info._inspectError = String(e);
    }
    return info;
  }

  const inspectionResults = [];

  for (const metaKey of derivedKeys) {
    LOG('Inspecting derivedKey:', metaKey);
    const result = { metaKey, found: false, locations: [], hasBlob: false, blobSize: null, rehydrated: false, notes: [] };

    // 1) try storageAPI.getArtifact
    if (storageAPI && typeof storageAPI.getArtifact === 'function') {
      try {
        const art = await storageAPI.getArtifact(metaKey, { denormalize: true }).catch(() => storageAPI.getArtifact(metaKey));
        if (art) {
          result.found = true;
          result.locations.push('storageAPI');
          try {
            const info = await inspectRecord(art);
            result.hasBlob = info.hasBlob;
            result.blobSize = info.blobSize;
            result.rehydrated = !!(info.typedArrayMeta);
            result.raw = art;
            if (info._blobReadError) result.notes.push('blob-read-error:' + info._blobReadError);
            if (info.dataKeys) result.notes.push('dataKeys:' + info.dataKeys.join(','));
          } catch (e) {
            result.notes.push('inspect-via-storageAPI-failed:' + String(e));
          }
        } else {
          result.notes.push('storageAPI.getArtifact returned null');
        }
      } catch (e) {
        result.notes.push('storageAPI.getArtifact error:' + String(e));
      }
    } else {
      result.notes.push('no storageAPI.getArtifact');
    }

    // 2) If not found, exhaustive IndexedDB scan
    if (!result.found) {
      const hits = await scanIndexedDBForKey(metaKey);
      if (hits && hits.length) {
        result.found = true;
        for (const h of hits) {
          result.locations.push(`${h.db} (${h.store})`);
          try {
            const info = await inspectRecord(h.record);
            if (info.hasBlob) {
              result.hasBlob = true;
              result.blobSize = info.blobSize || result.blobSize;
            }
            if (info.typedArrayMeta) result.rehydrated = true;
            result.raw = h.record;
          } catch (e) {
            result.notes.push('inspect-indexeddb-record-failed:' + String(e));
          }
        }
      } else {
        result.notes.push('IndexedDB scan: no hits');
      }
    }

    // 3) If found but no blob, check if storageAPI.serialize/deserialize helpers available (rare)
    if (result.found && !result.hasBlob) {
      try {
        if (storageAPI && typeof storageAPI.deserializeTypedArray === 'function' && result.raw && result.raw.blob) {
          // attempt safe call (may throw)
          try {
            const des = await storageAPI.deserializeTypedArray(result.raw.blob);
            result.rehydrated = !!des;
            result.notes.push('deserializeTypedArray succeeded');
          } catch (e) {
            result.notes.push('deserializeTypedArray failed:' + String(e));
          }
        }
      } catch (e) {}
    }

    inspectionResults.push(result);
    LOG('→ Inspect result for', metaKey, result);
  }

  // ---------- 11) Final summary ----------
  const summary = {
    timestamp: new Date().toISOString(),
    manifestsCreated: manifestData.length,
    manifestKeys: manifestData.map(m => m.manifestKey),
    thumbnailKeys: manifestData.map(m => m.thumbKey),
    workerEnsured: !!workerEnsure.ok,
    dispatcherConnected: !!(md && md._dispatcher),
    intentsCreated: createdIntents.length,
    reconCaptured: !!lastRecon,
    reconEventsSample: reconEvents.slice(-5),
    derivedKeys,
    inspectionResults
  };

  // restore feature flags if we changed them
  if (flagged && featureFlags && origFlags) {
    try {
      // restore the keys we overwrote
      const restore = {};
      Object.keys(FLAGS_WE_NEED).forEach(k => { restore[k] = origFlags[k]; });
      featureFlags.setFlags(restore);
      if (typeof featureFlags.broadcastCurrentFlags === 'function') featureFlags.broadcastCurrentFlags();
      LOG('Feature flags restored to original snapshot.');
    } catch (e) {
      WARN('Failed to restore feature flags automatically', e);
    }
  }

  // cleanup listeners
  try {
    if (bc) {
      try { bc.removeEventListener('message', bcListener); } catch (e) { try { bc.onmessage = null; } catch (e2) {} }
      try { bc.close(); } catch (e) {}
    }
    if (rawWorkerListenerRemover) rawWorkerListenerRemover();
    LOG('Cleaned up temporary listeners.');
  } catch (e) { WARN('cleanup listeners error', e); }

  // print compact human summary
  LOG('════════ E2E HEAVY-PATH PROBE SUMMARY ═════════');
  LOG('Manifests created:', summary.manifestsCreated);
  LOG('Worker ensured:', summary.workerEnsured ? '✓' : '✗');
  LOG('Dispatcher present:', summary.dispatcherConnected ? '✓' : '✗');
  LOG('Intents created:', summary.intentsCreated);
  LOG('RECON observed:', summary.reconCaptured ? '✓' : '✗');
  LOG('Derived keys discovered:', summary.derivedKeys.length ? summary.derivedKeys : 'none');
  LOG('Inspection results (per derivedKey):', summary.inspectionResults);
  LOG('══════════════════════════════════════════════');

  // attach machine-readable summary
  window.E2E_HEAVY_PATH_TEST_FULL = summary;
  return summary;
})();
