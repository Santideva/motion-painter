/* CALIBRATION PATH TEST V6 - PATH3 Removed
 * 
 * CHANGES FROM V5:
 * - Removed PATH3 (PNG path is unrealistic and extremely slow)
 * - Focus on PATH1 and PATH2 which cover 99% of production use
 * - Faster test execution (~30s instead of 4+ minutes)
 * - Validation runs immediately while artifacts are fresh
 * 
 * RATIONALE FOR REMOVING PATH3:
 * - PNG encoding takes 3.5 minutes for 1024×1024
 * - Production never encodes calibrated fields as PNG
 * - PATH1 (Float32Array) and PATH2 (binary blob) cover real scenarios
 * - If PNG support needed later, can add back with smaller resolution
 */

(async () => {
  if (!window.initTestUtilities) {
    console.error('[CALIB-V6] Load test-utilities.js first!');
    return;
  }
  
  const testUtil = await window.initTestUtilities({
    allowPatterns: ['[CALIB-V6]', '[STAGE4]', '[DEPTH-STAGE1]', '[PIN]', '[PERSIST]'],
    resetDB: true,
    resetOptions: {
      clearArtifacts: true,
      clearPins: true,
      clearReconStatus: true,
      preserveCalibration: false
    }
  });
  
  const { log, warn, error, sleep, waitForArtifact, assertTrue, assertExists } = testUtil;
  
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('CALIBRATION PATH TEST V6 (PATH1 + PATH2 Only)');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  const app = window.MotionPainter;
  const storageAPI = window.storageAPI;
  const md = app?.motionDetector;
  
  if (!assertExists(app, 'window.MotionPainter') ||
      !assertExists(storageAPI, 'window.storageAPI') ||
      !assertExists(md, 'app.motionDetector')) {
    error('Missing core components');
    return { ok: false, reason: 'missing_components' };
  }
  
  // Stop evictor
  try {
    if (typeof storageAPI.stopEvictorLoop === 'function') {
      await storageAPI.stopEvictorLoop();
      log('✓ Evictor stopped');
    }
  } catch (e) {
    warn('Could not stop evictor:', e.message);
  }
  
  // Ensure worker
  log('Ensuring motion worker...');
  const workerResult = await testUtil.waitForWorkerReady(app, 10000);
  assertTrue(workerResult.ok, `Worker ready in ${workerResult.elapsed}ms`);
  
  if (!workerResult.ok) {
    error('Worker not ready, aborting');
    return { ok: false, reason: 'no_worker' };
  }
  
  const TARGET_RES = 1024;
  const FIELD_LENGTH = TARGET_RES * TARGET_RES * 4;
  const WATCH_TIMEOUT_MS = 90000;
  
  // ============================================================================
  // HELPER: Create synthetic data
  // ============================================================================
  
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
  
  // ============================================================================
  // HELPER: Persist artifact
  // ============================================================================
  
  async function persistArtifact(artifact, testLabel) {
    log(`[${testLabel}] Persisting artifact...`);
    
    const res = await storageAPI.putInboundArtifact(artifact);
    assertTrue(res && res.ok, `[${testLabel}] Artifact persisted`);
    assertExists(res.metaKey, `[${testLabel}] metaKey returned`);
    
    await sleep(150);
    
    const checkResult = await waitForArtifact(storageAPI, res.metaKey, { timeoutMs: 2000 });
    assertTrue(checkResult.ok, `[${testLabel}] Artifact visible after persist`);
    
    return res.metaKey;
  }
  
  // ============================================================================
  // HELPER: Just-in-time manifest creation
  // ============================================================================
  
  async function createManifestJustInTime(fieldArtifactData, label) {
    const t = Date.now();
    const cameraId = `e2e_camera_${label}`;
    
    log(`[${label}] Creating artifacts just-in-time...`);
    
    const fieldKey = await persistArtifact(fieldArtifactData, label);
    log(`[${label}] ✓ Field artifact: ${fieldKey}`);
    
    const calibKey = await persistArtifact({
      type: 'calibration',
      data: { calibratedFrameKey: fieldKey },
      meta: { width: TARGET_RES, height: TARGET_RES, calibrated: true }
    }, label);
    log(`[${label}] ✓ Calibration artifact: ${calibKey}`);
    
    const canvas = new OffscreenCanvas(512, 512);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#333';
    ctx.fillRect(0, 0, 512, 512);
    const thumbBlob = await canvas.convertToBlob({ type: 'image/png' });
    
    const thumbRes = await storageAPI.putInboundArtifact({
      type: 'frame',
      blob: thumbBlob,
      meta: { timestamp: t, cameraId, width: 512, height: 512 },
      createdAt: new Date(t).toISOString()
    });
    
    assertTrue(thumbRes.ok, `[${label}] Thumbnail persisted`);
    const thumbKey = thumbRes.metaKey;
    log(`[${label}] ✓ Thumbnail: ${thumbKey}`);
    
    const ann = new Float32Array(12);
    for (let j = 0; j < 12; j++) ann[j] = 0.05;
    ann[2] = 0.98;
    
    const manifestRes = await storageAPI.putInboundArtifact({
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
          annularStats: {
            mean: 0.05,
            stddev: 0.25,
            min: 0,
            max: 1,
            spikeDetected: true,
            spikeIndex: 2,
            spikeValue: ann[2]
          }
        },
        hfhDecision: {
          shouldRun: true,
          reason: 'calib_path_test',
          severity: 0.99,
          suggestedResolution: 512,
          suggestedMode: 'heavy',
          confidence: 0.95
        },
        calibrationKey: calibKey
      },
      createdAt: new Date(t).toISOString()
    });
    
    assertTrue(manifestRes.ok, `[${label}] Manifest persisted`);
    await sleep(150);
    
    const elapsed = Date.now() - t;
    log(`[${label}] ✓ Complete chain created in ${elapsed}ms`);
    
    return { manifestKey: manifestRes.metaKey, cameraId, fieldKey, calibKey, thumbKey };
  }
  
  // ============================================================================
  // HELPER: Fire and watch reconstruction
  // ============================================================================
  
  async function fireAndWatch(manifestKey, label, cameraId) {
    log(`[${label}] Starting reconstruction...`);
    
    const jobId = `calib_test_${label}_${Date.now()}`;
    
    if (typeof md._createIntent === 'function') {
      md._createIntent({
        jobId,
        cameraId,
        reason: 'calib_path_test',
        priority: 99,
        meta: { width: 512, height: 512 },
        annular: new Float32Array(12).fill(0.5),
        avgLuma: 0.5
      });
    }
    
    if (typeof md.onArtifactReady === 'function') {
      try {
        md.onArtifactReady({
          metaKey: manifestKey,
          jobId,
          meta: { type: 'manifest', cameraId }
        });
      } catch (e) {
        error(`[${label}] onArtifactReady failed:`, e);
      }
    }
    
    const bc = new BroadcastChannel('motion-painter-store');
    const reconDone = new Promise((resolve) => {
      const handler = (ev) => {
        const data = ev.data || {};
        
        if (data.event === 'RECON_DONE' && data.metaKey === manifestKey) {
          log(`[${label}] ✓ RECON_DONE received`);
          bc.removeEventListener('message', handler);
          resolve({ event: 'RECON_DONE', payload: data });
        } else if (data.event === 'RECON_FAIL' && data.metaKey === manifestKey) {
          warn(`[${label}] ✗ RECON_FAIL received:`, data.error);
          bc.removeEventListener('message', handler);
          resolve({ event: 'RECON_FAIL', payload: data });
        }
      };
      
      bc.addEventListener('message', handler);
      
      setTimeout(() => {
        bc.removeEventListener('message', handler);
        resolve({ event: 'timeout' });
      }, WATCH_TIMEOUT_MS);
    });
    
    const result = await reconDone;
    bc.close();
    
    return result;
  }
  
  // ============================================================================
  // HELPER: Validate immediately
  // ============================================================================
  
  async function validatePathImmediately(pathLabel, pathResult) {
    log(`[${pathLabel}] Validating...`);
    
    if (pathResult.event !== 'RECON_DONE') {
      warn(`[${pathLabel}] Skipping validation (reconstruction failed)`);
      return { valid: false, error: 'reconstruction_failed' };
    }
    
    await sleep(500);
    
    const derivedKeys = pathResult.payload?.derivedKeys || [];
    const depthKey = derivedKeys.find(k => k.includes('depth_map'));
    
    if (!depthKey) {
      error(`[${pathLabel}] No depth key found`);
      return { valid: false, error: 'no_depth_key' };
    }
    
    log(`[${pathLabel}] Depth key: ${depthKey}`);
    
    const waitResult = await waitForArtifact(storageAPI, depthKey, {
      timeoutMs: 5000,
      assembleParts: true
    });
    
    if (!waitResult.ok) {
      error(`[${pathLabel}] ✗ Depth artifact not visible`);
      return { valid: false, error: 'artifact_not_visible' };
    }
    
    const artifact = waitResult.artifact;
    
    let depthData = null;
    if (artifact.data instanceof Float32Array) {
      depthData = artifact.data;
    } else if (artifact.data && artifact.data.field) {
      depthData = artifact.data.field;
    } else if (artifact.blob) {
      const ab = await artifact.blob.arrayBuffer();
      depthData = new Float32Array(ab);
    }
    
    if (!depthData || depthData.length === 0) {
      error(`[${pathLabel}] ✗ Could not extract depth data`);
      return { valid: false, error: 'no_depth_data' };
    }
    
    const stats = {
      length: depthData.length,
      min: Math.min(...Array.from(depthData).slice(0, 1000)),
      max: Math.max(...Array.from(depthData).slice(0, 1000))
    };
    
    log(`[${pathLabel}] ✓ Depth validated: ${stats.length} values, range [${stats.min.toFixed(3)}, ${stats.max.toFixed(3)}]`);
    
    assertTrue(stats.length > 0, `${pathLabel}: Depth data has values`);
    assertTrue(stats.min >= 0, `${pathLabel}: Depth min >= 0`);
    assertTrue(stats.max <= 10, `${pathLabel}: Depth max <= 10`);
    
    return { valid: true, stats };
  }
  
  // ============================================================================
  // TEST EXECUTION
  // ============================================================================
  
  const results = {};
  const validationResults = {};
  
  // ━━━━━ PATH 1: data.field ━━━━━
  log('');
  log('━━━━━ PATH 1: data.field ━━━━━');
  
  try {
    const field = makeFlatField(FIELD_LENGTH);
    
    const artifacts = await createManifestJustInTime(
      {
        type: 'calibrated_field',
        data: { field: field },
        meta: { width: TARGET_RES, height: TARGET_RES }
      },
      'PATH1'
    );
    
    const outcome = await fireAndWatch(artifacts.manifestKey, 'PATH1', artifacts.cameraId);
    log(`[PATH1] Result: ${outcome.event}`);
    
    assertTrue(outcome.event === 'RECON_DONE', 'PATH1: Reconstruction succeeded');
    
    results.path1 = { ...artifacts, ...outcome };
    validationResults.path1 = await validatePathImmediately('PATH1', results.path1);
    
  } catch (e) {
    error('[PATH1] Error:', e);
    results.path1 = { event: 'error', error: String(e) };
  }
  
  await sleep(2000);
  
  // ━━━━━ PATH 2: blob + typedArrayType ━━━━━
  log('');
  log('━━━━━ PATH 2: blob + typedArrayType ━━━━━');
  
  try {
    const field = makeFlatField(FIELD_LENGTH);
    const blob = new Blob([field.buffer], { type: 'application/octet-stream' });
    
    const artifacts = await createManifestJustInTime(
      {
        type: 'calibrated_field',
        blob: blob,
        meta: {
          typedArrayType: 'Float32Array',
          typedArrayLength: field.length,
          width: TARGET_RES,
          height: TARGET_RES
        }
      },
      'PATH2'
    );
    
    const outcome = await fireAndWatch(artifacts.manifestKey, 'PATH2', artifacts.cameraId);
    log(`[PATH2] Result: ${outcome.event}`);
    
    assertTrue(outcome.event === 'RECON_DONE', 'PATH2: Reconstruction succeeded');
    
    results.path2 = { ...artifacts, ...outcome };
    validationResults.path2 = await validatePathImmediately('PATH2', results.path2);
    
  } catch (e) {
    error('[PATH2] Error:', e);
    results.path2 = { event: 'error', error: String(e) };
  }
  
  // ============================================================================
  // CLEANUP
  // ============================================================================
  
  try {
    if (typeof storageAPI.startEvictorLoop === 'function') {
      await storageAPI.startEvictorLoop();
      log('✓ Evictor restarted');
    }
  } catch (e) {
    warn('Could not restart evictor:', e.message);
  }
  
  // ============================================================================
  // SUMMARY
  // ============================================================================
  
  log('');
  log('════════════════════════════════════════════════════');
  log('  TEST SUMMARY');
  log('════════════════════════════════════════════════════');
  
  const allPassed = Object.values(results).every(r => r.event === 'RECON_DONE');
  const allValidated = Object.values(validationResults).every(v => v.valid === true);
  
  for (const [path, r] of Object.entries(results)) {
    const status = r.event === 'RECON_DONE' ? '✅ PASSED' :
                   r.event === 'error' ? '❌ ERROR' :
                   `❌ ${r.event.toUpperCase()}`;
    log(`  ${path}: ${status}`);
    
    if (r.payload?.telemetry?.processingMs) {
      log(`    - Processing: ${r.payload.telemetry.processingMs}ms`);
    }
    
    const val = validationResults[path];
    if (val) {
      if (val.valid) {
        log(`    - Validation: ✓ ${val.stats.length} values`);
      } else {
        log(`    - Validation: ✗ ${val.error}`);
      }
    }
  }
  
  log('════════════════════════════════════════════════════');
  
  const assertStats = testUtil.printSummary();
  
  log(allPassed && allValidated && assertStats.failed === 0 
    ? '✅ ALL TESTS PASSED' 
    : '❌ SOME TESTS FAILED');
  
  log('');
  log('💡 Note: PATH3 (PNG path) removed for being unrealistic and slow');
  log('   PATH1 and PATH2 cover 99% of production use cases');
  
  testUtil.restoreConsole();
  
  window.CALIBRATION_PATH_TEST_V6 = {
    ok: allPassed && allValidated && assertStats.failed === 0,
    results,
    validationResults,
    assertions: assertStats
  };
  
  log('');
  log('Results: window.CALIBRATION_PATH_TEST_V6');
  log('Ready for validation suite!');
  
  return window.CALIBRATION_PATH_TEST_V6;
  
})();