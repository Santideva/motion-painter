// ═══════════════════════════════════════════════════════════════════════════
// PIPELINE TEST ENVIRONMENT  v6 + markReconFailed diagnostic
// Root-cause fix: calibration completion detected from calibration:ready BC
// event, not from _handleCalibrationRequest return value. The return resolves
// when the eviction hook is set up; the BC event fires when the preprocessor
// worker actually finishes and persists the calibration artifact.
//
// Diagnostic addition: RECON_FAILED_CALLED BC event catches markReconFailed
// calls regardless of console filtering, and includes a full stack trace so
// the exact call site that is writing state:failed can be identified.
// ═══════════════════════════════════════════════════════════════════════════
(async function installPipelineTestEnv() {

  // ── Preserve originals immediately ───────────────────────────────────────
  const _L = console.log.bind(console);
  const _W = console.warn.bind(console);
  const _D = (console.debug || console.log).bind(console);

  // ── 1. Block list ─────────────────────────────────────────────────────────
  // NOTE: 'storage.js:' is intentionally NOT in this list so that storage
  // diagnostics (including [markReconFailed] called:) are visible.
  const BLOCK = [
    '[FB]', '[FB_DIAG]', '[GL]', '[GL_DIAG]', '[GL_VALIDATE]', '[CR]',
    '[GL_DIAG] renderComposite',
    'PreprocessorWorker: Frame', 'PreprocessorWorker: HFH',
    '[PIN] ✓', '[PIN] ⏱', '[PIN] ⏰', '[PIN] 🚫', '[PIN] ⚠',
    '[PIN] ⏸', '[PIN] ℹ', '[PIN] BC',
    '[_wrapStorage]',
    '[STAGE4] Loading calibration', '[STAGE4] Calibration artifact',
    '[STAGE4] Extracting calibratedFrame', '[STAGE4] Final calibData state',
    '[STAGE4.5]', '[PERSIST]',
    'cameraContainer:updated',
    'cameraContainer] main.js: propagating',
    'cameraContainer] FrameEvictionHook',
    'Buffer configuration updated', 'Reaper:',
    'panelRect', 'Canvas resized', 'HMR',
    'featureFlags: enableFlux',
    'main.js: persistIntermediates', 'main.js: Initial MotionDetector',
    'main.js: Metrics',
    'webGLRenderer.js', 'diagnostics.js',
    'FrameBuffer.js', 'CompositeRenderer.js',
    'MotionWorkerWrapper: init posted', 'MotionWorkerWrapper: feature flags',
    'MotionWorkerWrapper: RECONSTRUCT_META missing',
    'artifact:unpinned', 'artifact:ttl_unpinned',
    'artifact:pinned', 'artifact:evicted',
    'FrameEvictionHook: calibration buffer hard limit',
    // Suppress motion.worker flag spam from BC broadcast
    'motion.worker: feature flags updated',
    '[PIN] Feature flag updated',
  ];

  function _blocked(args) {
    const first = typeof args[0] === 'string' ? args[0] : '';
    return BLOCK.some(pat => first.includes(pat));
  }

  console.log   = (...a) => { if (!_blocked(a)) _L(...a); };
  console.warn  = (...a) => { if (!_blocked(a)) _W(...a); };
  console.debug = (...a) => { if (!_blocked(a)) _D(...a); };

  window.restoreConsole = () => {
    console.log = _L; console.warn = _W; console.debug = _D;
    _L('[TEST] ✓ Console filter removed');
  };
  _L('[TEST] ✓ Blocklist installed (' + BLOCK.length + ' patterns)');
  _L('[TEST]   NOTE: storage.js: logs are visible in this session for diagnostics');

  // ── 2. Clear IndexedDB ────────────────────────────────────────────────────
  _L('[TEST] Clearing IndexedDB...');
  try {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('motionPainterDB');
      req.onsuccess = () => {
        const db = req.result;
        const targets = Array.from(db.objectStoreNames)
          .filter(n => ['artifacts','artifactParts','pins','reconStatus','counters'].includes(n));
        if (!targets.length) { db.close(); return resolve(); }
        const tx = db.transaction(targets, 'readwrite');
        targets.forEach(n => { try { tx.objectStore(n).clear(); } catch(e) {} });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror    = () => { db.close(); reject(tx.error); };
      };
      req.onerror = () => reject(req.error);
    });
    _L('[TEST] ✓ IndexedDB cleared');
  } catch(e) {
    _W('[TEST] DB clear failed (non-fatal):', e.message);
  }

  // ── 3. BC monitor ─────────────────────────────────────────────────────────
  if (window._testBC) { try { window._testBC.close(); } catch(e) {} }

  const _plog = [];

  const BC_SHOW = new Set([
    // Calibration — the actual completion event from the preprocessor worker
    'calibration:ready', 'calibration:error',
    // Pipeline stages
    'RECON_DONE', 'RECON_FAIL', 'RECON_IN_PROGRESS', 'RECON_CONFLICT',
    'TOPOLOGY_DONE', 'TOPOLOGY_ERROR',
    'MINIMIZER_DONE', 'MINIMIZER_ERROR',
    'STAGE4_DONE',
    'AMBI_DONE', 'AMBI_ERROR', 'AMBI_REFINE', 'AMBI_REFINED', 'AMBI_REFINE_ERROR',
    'STAGE5_DONE',
    'KEM_DONE', 'KEM_ERROR',
    'CORRESPONDENCE_DONE', 'CORRESPONDENCE_ERROR',
    'STAGE678_DONE',
    'DIFFGEO_DONE',
    'WEBGL_CONTEXT_LOST',
    // ── Diagnostic: catches markReconFailed regardless of console filtering ──
    // Both the main-thread and worker-bundled copies of storage.js broadcast
    // this event when markReconFailed is called, so the stack trace is always
    // visible here even if console output is suppressed or filtered.
    'RECON_FAILED_CALLED',
  ]);

  const _testBC = new BroadcastChannel('motion-painter-store');
  _testBC.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || !d.event) return;
    if (!BC_SHOW.has(d.event)) return;
    const entry = { t: Date.now(), ...d };
    _plog.push(entry);

    let colour;
    if (d.event === 'calibration:ready') {
      colour = 'color:#ff0;font-weight:bold';
    } else if (d.event === 'RECON_FAILED_CALLED') {
      colour = 'color:#f90;font-weight:bold';
    } else if (d.event.includes('FAIL') || d.event.includes('ERROR')) {
      colour = 'color:#f66;font-weight:bold';
    } else {
      colour = 'color:#0f0;font-weight:bold';
    }

    _L(`%c[BC] ${d.event}`, colour,
       '|', new Date(entry.t).toISOString().slice(11, 23),
       '|', d);

    // Extra detail for the diagnostic event
    if (d.event === 'RECON_FAILED_CALLED') {
      _W('[DIAG] markReconFailed called — full details:');
      _W('  reqId :', d.reqId);
      _W('  error :', d.error);
      _W('  stack :', d.stack);
    }
  });

  window._testBC = _testBC;
  window._plog   = _plog;
  _L('[TEST] ✓ BC pipeline monitor active (includes RECON_FAILED_CALLED diagnostic)');

  // ── 4. Manifest + calibration capture ─────────────────────────────────────
  if (window._captureBC) { try { window._captureBC.close(); } catch(e) {} }

  const _manifests        = [];
  let   _calibCompletedAt = null;
  let   _calibMetaKey     = null;
  let   _calibResolve     = null;
  let   _calibReject      = null;

  const _captureBC = new BroadcastChannel('motion-painter-store');
  _captureBC.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d) return;

    if (d.event === 'calibration:ready') {
      const key = d.metaKey || d.key || null;
      if (!_calibCompletedAt) {
        _calibCompletedAt = Date.now();
        _calibMetaKey     = key;
        _L(`%c[TEST] ✓ calibration:ready received — metaKey: ${key}`,
           'color:#ff0;font-weight:bold');
        _L('[TEST]   Post-calibration manifests will have calibrationKey set.');
        _L('[TEST]   Call: await forceDirectReconstruction()');
      }
      if (_calibResolve) { _calibResolve(key); _calibResolve = null; }
      return;
    }

    if (d.event === 'calibration:error') {
      _W('[TEST] calibration:error received:', d.error);
      if (_calibReject) { _calibReject(new Error(d.error || 'calibration_error')); _calibReject = null; }
      return;
    }

    if (d.event !== 'artifact:ready') return;
    if (!d.metaKey || !d.jobId) return;
    if (!d.metaKey.includes(':manifest:')) return;
    _manifests.push({
      metaKey:    d.metaKey,
      jobId:      d.jobId,
      t:          Date.now(),
      afterCalib: !!_calibCompletedAt
    });
  });

  window._captureBC = _captureBC;
  window._manifests = _manifests;
  _L('[TEST] ✓ Manifest + calibration capture BC active');

  // ── 5. Pipeline state inspector ───────────────────────────────────────────
  window.pipelineState = function() {
    const app = window.MotionPainter;
    if (!app) { _L('[TEST] MotionPainter not found'); return; }
    const cc = app.cameraContainer;
    _L('[TEST] ════ Pipeline state ════════════════════════════');
    _L('  Workers:');
    _L('    motionWorker:         ', app.motionWorker          ? '✅' : '❌',
       app.motionWorker ? `(ready=${app.motionWorker.workerReady})` : '');
    _L('    _topologyWorker:      ', app._topologyWorker       ? '✅' : '❌');
    _L('    _minimizerWorker:     ', app._minimizerWorker      ? '✅' : '❌');
    _L('    _ambiWorker:          ', app._ambiWorker           ? '✅' : '❌');
    _L('    _kemWorker:           ', app._kemWorker            ? '✅' : '❌');
    _L('    _correspondenceWorker:', app._correspondenceWorker ? '✅' : '❌');
    _L('  MotionDetector dispatcher:',
       app.motionDetector?._dispatcher === app.motionWorker
         ? '✅ connected' : '❌ NOT connected');
    _L('  Calibration:',
       _calibCompletedAt
         ? `✅ at ${new Date(_calibCompletedAt).toISOString().slice(11,23)} metaKey=${_calibMetaKey}`
         : '⏳ not yet — run forcePipelineStart()');
    _L('  Stages:');
    _L('    stage2: ', cc?.stage2  ? '✅' : '❌',
       cc?.stage2  ? {sdfKey:    cc.stage2.sdfFieldKey?.slice(0,24)}  : '');
    _L('    stage3: ', cc?.stage3  ? '✅' : '❌',
       cc?.stage3  ? {flowKey:   cc.stage3.flowFieldKey?.slice(0,24)} : '');
    _L('    stage4a:', cc?.stage4a ? '✅' : '❌',
       cc?.stage4a ? {betti:     cc.stage4a.betti}                    : '');
    _L('    stage4b:', cc?.stage4b ? '✅' : '❌',
       cc?.stage4b ? {converged: cc.stage4b.converged}                : '');
    _L('    stage5: ', cc?.stage5  ? '✅' : '❌',
       cc?.stage5  ? {legibility: cc.ambiFrame?.legibilityScore?.toFixed(3)} : '');
    _L('    stage6: ', cc?.stage6  ? '✅' : '❌',
       cc?.stage6  ? {meanKEM:   cc.stage6.meanKEM}                   : '');
    _L('    stage7: ', cc?.stage7  ? '✅' : '❌',
       cc?.stage7  ? {mismatch:  cc.stage7.symmetryMismatchScore?.toFixed(3)} : '');
    _L('  _stage678State:', app._stage678State);
    _L('  BC events:', _plog.map(e => e.event));
    const post = _manifests.filter(m => m.afterCalib);
    _L('  Manifests:', _manifests.length, `(${post.length} post-calibration)`);
    _L('[TEST] ═════════════════════════════════════════════════');
    return {
      workers: {
        motion: !!app.motionWorker, ready: app.motionWorker?.workerReady,
        topology: !!app._topologyWorker, minimizer: !!app._minimizerWorker,
        ambi: !!app._ambiWorker, kem: !!app._kemWorker,
        corr: !!app._correspondenceWorker
      },
      calibration: { completed: !!_calibCompletedAt, metaKey: _calibMetaKey },
      stages: {
        s2: !!cc?.stage2, s3: !!cc?.stage3, s4a: !!cc?.stage4a,
        s4b: !!cc?.stage4b, s5: !!cc?.stage5, s6: !!cc?.stage6, s7: !!cc?.stage7
      },
      events:    _plog.map(e => e.event),
      manifests: { total: _manifests.length, postCalib: post.length }
    };
  };

  // ── 6. Feature flag helper ────────────────────────────────────────────────
  function _setFlag(key, value) {
    const app = window.MotionPainter;
    if (app?._currentFlags) app._currentFlags[key] = value;
    const bc = new BroadcastChannel('motion-painter-store');
    bc.postMessage({ event: 'flagsChanged', flags: { [key]: value } });
    bc.close();
    _L(`[TEST] ✓ Flag set: ${key} = ${JSON.stringify(value)}`);
  }
  window._setFlag = _setFlag;

  // ── 7. Force pipeline start ───────────────────────────────────────────────
  window.forcePipelineStart = async function() {
    const app = window.MotionPainter;
    if (!app) { _L('[TEST] MotionPainter not found'); return; }

    _L('[TEST] ══ Step 1: lower HFH threshold → 0 ══');
    _setFlag('hfhHeavyPathThreshold', 0.0);

    _L('[TEST] ══ Step 2: create motionWorker ══');
    app._heavyPathRequested = true;
    try { app._ensureMotionWorker(); } catch(e) { _W('[TEST] _ensureMotionWorker failed:', e.message); }
    _L('[TEST]   motionWorker:', app.motionWorker ? '✅' : '❌');

    _L('[TEST] ══ Step 3: waiting 4s for motionWorker.onReady() ══');
    await new Promise(r => setTimeout(r, 4000));

    _L('[TEST] ══ Step 4: worker status ══');
    _L('[TEST]   motionWorker.workerReady:', app.motionWorker?.workerReady ? '✅' : '❌');
    _L('[TEST]   Stage workers:', {
      topology:       app._topologyWorker       ? '✅' : '❌',
      minimizer:      app._minimizerWorker      ? '✅' : '❌',
      ambi:           app._ambiWorker           ? '✅' : '❌',
      kem:            app._kemWorker            ? '✅' : '❌',
      correspondence: app._correspondenceWorker ? '✅' : '❌'
    });

    const dispOk = app.motionDetector?._dispatcher === app.motionWorker;
    _L('[TEST]   MotionDetector._dispatcher:', dispOk ? '✅ connected' : '❌ NOT connected');
    if (!dispOk && app.motionDetector && app.motionWorker) {
      try { app.motionDetector.setDispatcher?.(app.motionWorker); _L('[TEST]   ✓ Dispatcher set manually'); }
      catch(e) { _W('[TEST]   setDispatcher failed:', e.message); }
    }

    _L('[TEST] ══ Step 5: calibration ══');

    const calibReadyPromise = new Promise((resolve, reject) => {
      if (_calibCompletedAt) {
        resolve(_calibMetaKey);
        return;
      }
      _calibResolve = resolve;
      _calibReject  = reject;
      setTimeout(() => {
        if (_calibReject) {
          _calibReject = null;
          reject(new Error('calibration:ready not received within 90s'));
        }
      }, 90000);
    });

    try {
      await app._handleCalibrationRequest({ count: 8, reason: 'test-force' });
      _L('[TEST]   Calibration capture started — waiting for calibration:ready BC event...');
    } catch(e) {
      _W('[TEST] ✗ _handleCalibrationRequest threw:', e.message);
    }

    let calibKey;
    try {
      calibKey = await calibReadyPromise;
      _L(`[TEST] ✅ Calibration confirmed — metaKey: ${calibKey}`);
    } catch(e) {
      _W('[TEST] ✗ Calibration failed:', e.message);
      _W('[TEST]   Cannot proceed — motion.worker cannot load calibration data without this key.');
      return;
    }

    _L('[TEST]');
    _L('[TEST] ✅ Ready. Now call:');
    _L('[TEST]   await forceDirectReconstruction()');
    _L('[TEST]');
    _L('[TEST] Expected BC sequence:');
    _L('[TEST]   RECON_DONE → TOPOLOGY_DONE + MINIMIZER_DONE → STAGE4_DONE');
    _L('[TEST]   → AMBI_DONE → STAGE5_DONE');
    _L('[TEST]   → KEM_DONE + CORRESPONDENCE_DONE + AMBI_REFINED → STAGE678_DONE');
    _L('[TEST]');
    _L('[TEST] If RECON_FAILED_CALLED appears in the BC log, the stack trace');
    _L('[TEST] will be printed above and identify the exact call site.');
  };

  // ── 8. Direct reconstruction ──────────────────────────────────────────────
  window.forceDirectReconstruction = async function() {
    const app = window.MotionPainter;
    if (!app?.motionWorker?.workerReady) {
      _W('[TEST] motionWorker not ready — call forcePipelineStart() first');
      return;
    }
    if (!_calibCompletedAt) {
      _W('[TEST] ✗ Calibration not yet confirmed.');
      _W('[TEST]   forcePipelineStart() must complete fully first.');
      return;
    }

    let postCalib = _manifests.filter(m => m.afterCalib);
    if (!postCalib.length) {
      _L('[TEST] No post-calibration manifests yet — waiting 3s for new frames...');
      await new Promise(r => setTimeout(r, 3000));
      postCalib = _manifests.filter(m => m.afterCalib);
    }

    if (!postCalib.length) {
      _W('[TEST] ✗ Still no post-calibration manifests.');
      _W('[TEST]   The eviction hook may not have processed new frames yet.');
      _W('[TEST]   Wait 5s and retry.');
      return;
    }

    postCalib.sort((a, b) => b.t - a.t);
    const { metaKey } = postCalib[0];
    _L(`[TEST] Dispatching reconstruction → ${metaKey}`);
    _L(`[TEST]   ${postCalib.length} post-calibration manifests; using most recent`);
    _L(`[TEST]   calibration metaKey: ${_calibMetaKey}`);
    _L('[TEST]   Watch for RECON_FAILED_CALLED in BC log if job fails');

    try {
      const result = await app.motionWorker.requestReconstructionByMeta(
        metaKey,
        {
          reason:   'test-force-direct',
          priority: 100,
          reqId:    'test-' + Date.now(),
          cameraId: app.cameraContainer?.cameraId ?? 'default'
        }
      );
      _L('[TEST] ✅ Reconstruction resolved:',
         result?.event, '| derivedKeys:', result?.derivedKeys?.length ?? 0);
    } catch(e) {
      _W('[TEST] ✗ Reconstruction failed:', e.message);
      if (e.message.includes('calibratedFrameKey') || e.message.includes('Calibration metadata')) {
        _W('[TEST]   ↳ Manifest has calibrationKey=null in storage.');
        _W('[TEST]   ↳ This manifest was created before the eviction hook received');
        _W('[TEST]      the calibration key. The hook stamps new manifests; wait');
        _W('[TEST]      5-10s for fresh frames, then retry.');
        const t = postCalib[0].t;
        _W('[TEST]   ↳ Manifest timestamp:', new Date(t).toISOString().slice(11,23),
           '| calib completed:', new Date(_calibCompletedAt).toISOString().slice(11,23));
        _W('[TEST]   ↳ Gap:', ((t - _calibCompletedAt)/1000).toFixed(1) + 's',
           '(positive = manifest is post-calib; negative = pre-calib)');
      } else if (e.message.includes('timeout')) {
        _W('[TEST]   ↳ Wrapper timeout — pipeline stalled inside a worker.');
        _W('[TEST]   ↳ Call pipelineState() to see which BC events fired.');
        _W('[TEST]   ↳ Check BC log for RECON_FAILED_CALLED — if present the');
        _W('[TEST]      stack trace above identifies who wrote state:failed.');
        _W('[TEST]   ↳ Open DevTools Sources → Threads to inspect the stalled worker.');
      } else if (e.message.includes('push') || e.message.includes('undefined')) {
        _W('[TEST]   ↳ Crash in motion.worker — uninitialised array/map.');
        _W('[TEST]   ↳ Open DevTools Sources → Threads → motion.worker for the stack.');
      }
    }
  };

  // ── 9. Stall detector ────────────────────────────────────────────────────
  let _lastEventT = Date.now();
  _testBC.addEventListener('message', (ev) => {
    if (ev.data?.event && BC_SHOW.has(ev.data.event)) _lastEventT = Date.now();
  });

  window._stallInterval = setInterval(() => {
    if (!_plog.length) return;
    const stallMs = Date.now() - _lastEventT;
    if (stallMs > 35000) {
      _W(`[TEST] ⚠ Stall — no pipeline events for ${(stallMs/1000).toFixed(0)}s`);
      _W('[TEST]   Last:', _plog[_plog.length-1]?.event ?? 'none');
      _W('[TEST]   → pipelineState() to diagnose');
    }
  }, 20000);

  // ── 10. Teardown ─────────────────────────────────────────────────────────
  window.teardownTestEnv = function() {
    clearInterval(window._stallInterval);
    try { window._testBC?.close(); }    catch(e) {}
    try { window._captureBC?.close(); } catch(e) {}
    window.restoreConsole();
    _L('[TEST] Test environment torn down');
  };

  // ── Done ─────────────────────────────────────────────────────────────────
  _L('[TEST] ═══════════════════════════════════════════════════════');
  _L('[TEST] Pipeline test environment v6+diag ready (DB cleared)');
  _L('[TEST]');
  _L('[TEST] Sequence:');
  _L('[TEST]   1. await forcePipelineStart()');
  _L('[TEST]      Waits for calibration:ready BC event (not just capture start).');
  _L('[TEST]      Will print ✅ and the real calib metaKey when done.');
  _L('[TEST]   2. await forceDirectReconstruction()');
  _L('[TEST]      Uses only post-calibration manifests.');
  _L('[TEST]   3. pipelineState()  — verify stages');
  _L('[TEST]');
  _L('[TEST] Diagnostic:');
  _L('[TEST]   RECON_FAILED_CALLED will appear in the BC log (orange) any time');
  _L('[TEST]   markReconFailed is called from any context — main thread or worker.');
  _L('[TEST]   The full stack trace is printed immediately after the BC entry.');
  _L('[TEST]   This identifies the exact call site that writes state:failed.');
  _L('[TEST]');
  _L('[TEST] Other:');
  _L('[TEST]   _setFlag(key, value)  — set a feature flag');
  _L('[TEST]   window._plog          — pipeline BC events');
  _L('[TEST]   window._manifests     — captured manifests');
  _L('[TEST]   restoreConsole()      — remove log filter');
  _L('[TEST]   teardownTestEnv()     — full cleanup');
  _L('[TEST] ═══════════════════════════════════════════════════════');

})();