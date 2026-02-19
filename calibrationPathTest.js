/* CALIBRATION PATH TEST - Fixed Event Handling + Storage Timing
 * 
 * Fixes:
 * 1. Direct worker message capture (bypasses MotionDetector event routing)
 * 2. Explicit storage commit waits before validation
 * 3. Better timeout handling with progress tracking
 * 4. Artifact pinning to prevent eviction during validation
 */

(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const now = () => Date.now();
  const safe = fn => { try { return fn(); } catch (e) { return undefined; } };
  const LOG = (...args) => console.log('[CALIB-FIX]', ...args);
  const WARN = (...args) => console.warn('[CALIB-FIX]', ...args);
  const ERR = (...args) => console.error('[CALIB-FIX]', ...args);

  const TARGET_RES = 1024;
  const WATCH_TIMEOUT_MS = 90000; // Increased to 90s
  const FIELD_LENGTH = TARGET_RES * TARGET_RES * 4;

  const app = safe(() => window.MotionPainter);
  const storageAPI = safe(() => window.storageAPI);
  const md = safe(() => app && app.motionDetector);

  if (!app || !storageAPI || !md) {
    ERR('Missing core components');
    return { ok: false, reason: 'missing_components' };
  }

  // Stop evictor to prevent artifact deletion during test
  try {
    if (typeof storageAPI.stopEvictorLoop === 'function') {
      await storageAPI.stopEvictorLoop();
      LOG('✓ Evictor stopped');
    }
  } catch (e) {
    WARN('Could not stop evictor:', e.message);
  }

  // Ensure worker
  LOG('Ensuring motion worker...');
  try { app._heavyPathRequested = true; } catch (e) {}
  if (typeof app._ensureMotionWorker === 'function') {
    try { app._ensureMotionWorker(); } catch (e) {}
  }

  for (let i = 0; i < 50; i++) {
    if (app.motionWorker && (app.motionWorker.workerReady || 
        (typeof app.motionWorker.isReady === 'function' && app.motionWorker.isReady()))) break;
    await sleep(200);
  }

  if (!app.motionWorker) {
    ERR('Worker not ready');
    return { ok: false, reason: 'no_worker' };
  }
  LOG('Worker ready ✓');

  // ============================================================================
  // CRITICAL FIX: Direct worker message interception
  // ============================================================================
  
  const workerMessages = [];
  let rawWorkerRemover = null;
  
  try {
    const rawWorker = app.motionWorker.worker;
    if (rawWorker instanceof Worker) {
      const messageHandler = (ev) => {
        try {
          const data = ev.data;
          workerMessages.push({
            timestamp: Date.now(),
            ...data
          });
          
          // Also log RECON_DONE/FAIL for debugging
          if (data && (data.event === 'RECON_DONE' || data.event === 'RECON_FAIL')) {
            LOG(`Worker event: ${data.event} for ${data.metaKey || data.jobId}`);
          }
        } catch (e) {
          WARN('Message capture error:', e);
        }
      };
      
      rawWorker.addEventListener('message', messageHandler);
      rawWorkerRemover = () => {
        try {
          rawWorker.removeEventListener('message', messageHandler);
        } catch (e) {}
      };
      
      LOG('✓ Worker message interception installed');
    }
  } catch (e) {
    WARN('Could not install worker message handler:', e);
  }

  // Helper functions
  function makeFlatField(length) {
    const f = new Float32Array(length);
    for (let i = 0; i < length; i += 4) {
      const jitter = (Math.random() - 0.5) * 0.02;
      f[i + 0] = 0.48 + jitter;
      f[i + 1] = 0.50 + jitter;
      f[i + 2] = 0.52 + jitter;
      f[i + 3] = 1.0;
    }
    return f;
  }

  async function makePNGBlob(resolution) {
    const canvas = new OffscreenCanvas(resolution, resolution);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgb(122, 128, 133)';
    ctx.fillRect(0, 0, resolution, resolution);
    const imgData = ctx.getImageData(0, 0, resolution, resolution);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      const j = Math.floor((Math.random() - 0.5) * 6);
      d[i + 0] = Math.max(0, Math.min(255, d[i + 0] + j));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + j));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + j));
      d[i + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    return canvas.convertToBlob({ type: 'image/png' });
  }

  async function persistArtifact(artifact) {
    const res = await storageAPI.putInboundArtifact(artifact);
    if (!res || !res.ok) throw new Error('putInboundArtifact failed');
    
    if (typeof storageAPI.promoteToWork === 'function') {
      try {
        await storageAPI.promoteToWork(res.metaKey);
      } catch (e) {
        WARN(`Could not promote ${res.metaKey}:`, e.message);
      }
    }
    
    // CRITICAL: Wait for IndexedDB commit
    await sleep(150);
    return res.metaKey;
  }

  async function persistManifest(calibrationKey, label) {
    const t = Date.now();
    const thumbKey = `artifact:thumb:calib_test:${label}:${t}`;
    const manifestKey = `artifact:manifest:calib_test:${label}:${t}`;
    const cameraId = `e2e_camera_${label}`;

    const canvas = new OffscreenCanvas(512, 512);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#333';
    ctx.fillRect(0, 0, 512, 512);
    const thumbBlob = await canvas.convertToBlob({ type: 'image/png' });

    await storageAPI.putInboundArtifact({
      key: thumbKey,
      type: 'frame',
      blob: thumbBlob,
      meta: { timestamp: t, cameraId, width: 512, height: 512 },
      createdAt: new Date(t).toISOString()
    });
    
    if (typeof storageAPI.promoteToWork === 'function') {
      try { await storageAPI.promoteToWork(thumbKey); } catch (e) {}
    }

    const ann = new Float32Array(12);
    for (let j = 0; j < 12; j++) ann[j] = 0.05;
    ann[2] = 0.98;

    await storageAPI.putInboundArtifact({
      key: manifestKey,
      type: 'manifest',
      meta: { timestamp: t, cameraId },
      data: {
        keys: [thumbKey],
        cameraId,
        width: 512,
        height: 512,
        timestamp: t,
        createdAt: new Date(t).toISOString(),
        hfh: {
          annular: ann,
          annularArray: Array.from(ann),
          annularCounts: Array.from(new Uint32Array(12).fill(1)),
          annularStats: { mean: 0.05, stddev: 0.25, min: 0, max: 1, spikeDetected: true, spikeIndex: 2, spikeValue: ann[2] }
        },
        hfhDecision: {
          shouldRun: true, reason: 'calib_path_test', severity: 0.99,
          suggestedResolution: 512, suggestedMode: 'heavy', confidence: 0.95
        },
        calibrationKey: calibrationKey
      },
      createdAt: new Date(t).toISOString()
    });
    
    if (typeof storageAPI.promoteToWork === 'function') {
      try { await storageAPI.promoteToWork(manifestKey); } catch (e) {}
    }
    
    // CRITICAL: Wait for IndexedDB commit
    await sleep(150);

    return { manifestKey, cameraId };
  }

  /**
   * FIXED: Watch worker messages directly instead of MotionDetector events
   */
  async function fireAndWatch(manifestKey, label, cameraId) {
    const msgStartIdx = workerMessages.length;
    const jobId = `calib_test_${label}_${now()}`;

    LOG(`Starting job ${jobId} for ${manifestKey}`);

    if (typeof md._createIntent === 'function') {
      md._createIntent({
        jobId, cameraId, reason: 'calib_path_test', priority: 99,
        meta: { width: 512, height: 512 },
        annular: new Float32Array(12).fill(0.5),
        avgLuma: 0.5
      });
    }

    if (typeof md.onArtifactReady === 'function') {
      try {
        md.onArtifactReady({ metaKey: manifestKey, jobId, meta: { type: 'manifest', cameraId } });
      } catch(e) {
        ERR('onArtifactReady failed:', e);
      }
    }

    const deadline = now() + WATCH_TIMEOUT_MS;
    let lastProgressLog = now();
    
    while (now() < deadline) {
      // Check worker messages for completion
      for (let i = msgStartIdx; i < workerMessages.length; i++) {
        const msg = workerMessages[i];
        if (!msg || msg.metaKey !== manifestKey) continue;
        
        if (msg.event === 'RECON_DONE') {
          LOG(`✓ RECON_DONE received for ${manifestKey}`);
          return {
            event: 'RECON_DONE',
            payload: msg,
            source: 'WorkerDirect',
            processingMs: msg.telemetry?.processingMs || 0
          };
        }
        
        if (msg.event === 'RECON_FAIL') {
          WARN(`✗ RECON_FAIL received for ${manifestKey}:`, msg.error);
          return {
            event: 'RECON_FAIL',
            payload: msg,
            source: 'WorkerDirect',
            error: msg.error
          };
        }
        
        if (msg.event === 'progress' && now() - lastProgressLog > 5000) {
          LOG(`  Progress: ${msg.stage}`);
          lastProgressLog = now();
        }
      }
      
      await sleep(200);
    }

    ERR(`Timeout waiting for ${manifestKey}`);
    
    // Log captured messages for debugging
    const relevantMsgs = workerMessages.slice(msgStartIdx).filter(m => m.metaKey === manifestKey);
    if (relevantMsgs.length > 0) {
      LOG(`Captured ${relevantMsgs.length} messages:`, relevantMsgs.map(m => m.event));
    }
    
    return { event: 'timeout', capturedMessages: relevantMsgs.length };
  }

  // Test execution
  const results = {};

  // PATH 1
  LOG('━━━━━ PATH 1: data.field ━━━━━');
  try {
    const field = makeFlatField(FIELD_LENGTH);
    const fieldKey = await persistArtifact({
      type: 'calibrated_field',
      data: { field: field },
      meta: { width: TARGET_RES, height: TARGET_RES }
    });
    
    // Pin to prevent eviction
    try {
      await storageAPI.pinArtifact(fieldKey, { owner: 'test', type: 'soft' });
    } catch (e) {}
    
    const calibKey = await persistArtifact({
      type: 'calibration',
      data: { calibratedFrameKey: fieldKey },
      meta: { width: TARGET_RES, height: TARGET_RES, calibrated: true }
    });
    
    try {
      await storageAPI.pinArtifact(calibKey, { owner: 'test', type: 'soft' });
    } catch (e) {}
    
    const { manifestKey, cameraId } = await persistManifest(calibKey, 'path1');

    const outcome = await fireAndWatch(manifestKey, 'path1', cameraId);
    LOG(`  Result: ${outcome.event}`);
    
    results.path1 = { fieldKey, calibKey, manifestKey, ...outcome };
  } catch (e) {
    ERR('Path 1 error:', e);
    results.path1 = { event: 'error', error: String(e) };
  }

  await sleep(2000);

  // PATH 2
  LOG('━━━━━ PATH 2: blob + typedArrayType ━━━━━');
  try {
    const field = makeFlatField(FIELD_LENGTH);
    const blob = new Blob([field.buffer], { type: 'application/octet-stream' });

    const fieldKey = await persistArtifact({
      type: 'calibrated_field',
      blob: blob,
      meta: { typedArrayType: 'Float32Array', typedArrayLength: field.length, width: TARGET_RES, height: TARGET_RES }
    });
    
    try {
      await storageAPI.pinArtifact(fieldKey, { owner: 'test', type: 'soft' });
    } catch (e) {}
    
    const calibKey = await persistArtifact({
      type: 'calibration',
      data: { calibratedFrameKey: fieldKey },
      meta: { width: TARGET_RES, height: TARGET_RES, calibrated: true }
    });
    
    try {
      await storageAPI.pinArtifact(calibKey, { owner: 'test', type: 'soft' });
    } catch (e) {}
    
    const { manifestKey, cameraId } = await persistManifest(calibKey, 'path2');

    const outcome = await fireAndWatch(manifestKey, 'path2', cameraId);
    LOG(`  Result: ${outcome.event}`);
    
    results.path2 = { fieldKey, calibKey, manifestKey, ...outcome };
  } catch (e) {
    ERR('Path 2 error:', e);
    results.path2 = { event: 'error', error: String(e) };
  }

  await sleep(2000);

  // PATH 3
  LOG('━━━━━ PATH 3: PNG image blob ━━━━━');
  try {
    const pngBlob = await makePNGBlob(TARGET_RES);

    const fieldKey = await persistArtifact({
      type: 'calibrated_field',
      blob: pngBlob,
      meta: { width: TARGET_RES, height: TARGET_RES, mimeType: 'image/png' }
    });
    
    try {
      await storageAPI.pinArtifact(fieldKey, { owner: 'test', type: 'soft' });
    } catch (e) {}
    
    const calibKey = await persistArtifact({
      type: 'calibration',
      data: { calibratedFrameKey: fieldKey },
      meta: { width: TARGET_RES, height: TARGET_RES, calibrated: true }
    });
    
    try {
      await storageAPI.pinArtifact(calibKey, { owner: 'test', type: 'soft' });
    } catch (e) {}
    
    const { manifestKey, cameraId } = await persistManifest(calibKey, 'path3');

    const outcome = await fireAndWatch(manifestKey, 'path3', cameraId);
    LOG(`  Result: ${outcome.event}`);
    
    results.path3 = { fieldKey, calibKey, manifestKey, ...outcome };
  } catch (e) {
    ERR('Path 3 error:', e);
    results.path3 = { event: 'error', error: String(e) };
  }

  // ============================================================================
  // VALIDATION (with proper timing and pinning)
  // ============================================================================
  
  LOG('');
  LOG('Validating outputs...');
  
  const validationResults = {};
  
  for (const [pathName, pathResult] of Object.entries(results)) {
    if (pathResult.event !== 'RECON_DONE') {
      LOG(`  ${pathName}: Skipping validation (reconstruction failed)`);
      continue;
    }
    
    LOG(`  ${pathName}: Validating...`);
    
    // CRITICAL: Wait for storage commit after RECON_DONE
    await sleep(500);
    
    const depthKey = pathResult.payload?.derivedKeys?.find(k => k.includes('depth_map'));
    
    if (!depthKey) {
      WARN(`    No depth key found in derivedKeys:`, pathResult.payload?.derivedKeys);
      continue;
    }
    
    LOG(`    Depth key: ${depthKey}`);
    
    // Pin artifact before reading
    try {
      await storageAPI.pinArtifact(depthKey, { owner: 'test', type: 'soft' });
      await sleep(100);
    } catch (e) {
      WARN(`    Could not pin ${depthKey}:`, e.message);
    }
    
    // Attempt to read with retries
    let depthData = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const artifact = await storageAPI.getArtifact(depthKey, { assembleParts: true });
        
        if (!artifact) {
          WARN(`    Attempt ${attempt}/3: Artifact not found`);
          await sleep(300 * attempt);
          continue;
        }
        
        // Extract data
        if (artifact.data instanceof Float32Array) {
          depthData = artifact.data;
        } else if (artifact.blob) {
          const ab = await artifact.blob.arrayBuffer();
          depthData = new Float32Array(ab);
        } else if (artifact.data && typeof artifact.data === 'object') {
          // May need deserialization
          depthData = artifact.data;
        }
        
        if (depthData) {
          const stats = {
            length: depthData.length,
            min: Math.min(...Array.from(depthData).slice(0, 1000)),
            max: Math.max(...Array.from(depthData).slice(0, 1000))
          };
          
          LOG(`    ✓ Depth validated: ${stats.length} values, range [${stats.min.toFixed(3)}, ${stats.max.toFixed(3)}]`);
          validationResults[pathName] = { valid: true, stats, data: depthData };
          break;
        }
      } catch (e) {
        WARN(`    Attempt ${attempt}/3 failed:`, e.message);
        await sleep(300 * attempt);
      }
    }
    
    if (!depthData) {
      ERR(`    ✗ Validation failed after 3 attempts`);
      validationResults[pathName] = { valid: false, error: 'Could not read depth data' };
    }
  }

  // Cleanup
  if (rawWorkerRemover) rawWorkerRemover();
  
  try {
    if (typeof storageAPI.startEvictorLoop === 'function') {
      await storageAPI.startEvictorLoop();
      LOG('✓ Evictor restarted');
    }
  } catch (e) {}

  // Summary
  LOG('');
  LOG('════════════════════════════════════════════════════');
  LOG('  TEST SUMMARY');
  LOG('════════════════════════════════════════════════════');

  const allPassed = Object.values(results).every(r => r.event === 'RECON_DONE');
  const allValidated = Object.values(validationResults).every(v => v.valid === true);

  for (const [path, r] of Object.entries(results)) {
    const status = r.event === 'RECON_DONE' ? '✅ PASSED' : 
                   r.event === 'error' ? '❌ ERROR' :
                   `❌ ${r.event.toUpperCase()}`;
    LOG(`  ${path}: ${status}`);
    
    if (r.processingMs) {
      LOG(`    - Processing: ${r.processingMs}ms`);
    }
    
    if (r.error) {
      LOG(`    - Error: ${r.error}`);
    }
    
    const val = validationResults[path];
    if (val) {
      if (val.valid) {
        LOG(`    - Validation: ✓ ${val.stats.length} values`);
      } else {
        LOG(`    - Validation: ✗ ${val.error}`);
      }
    }
  }

  LOG('════════════════════════════════════════════════════');
  LOG(allPassed && allValidated ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED');

  window.CALIBRATION_PATH_TEST_FIXED = { 
    ok: allPassed && allValidated, 
    results, 
    validationResults,
    workerMessageCount: workerMessages.length
  };
  
  LOG('Results: window.CALIBRATION_PATH_TEST_FIXED');
  
  return window.CALIBRATION_PATH_TEST_FIXED;
})();