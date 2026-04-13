/* CALIBRATION PATH TEST V7
 *
 * CHANGES FROM V6:
 * - TARGET_RES: 1024 → 512
 *   1024×1024 = ~4MB Float32 field. 512×512 = ~1MB.
 *   The calibration path logic (guard checks, field loading, key propagation)
 *   is resolution-independent. There is no reason to pay 4x GPU cost here.
 *
 * - WATCH_TIMEOUT_MS: 90000 → 150000
 *   MotionWorkerWrapper has a hard 120s RECONSTRUCT_META timeout.
 *   The prior test fired at 90s, declared failure, and closed its BC listener
 *   before the worker finished. The worker completed at ~120s, found no listener,
 *   and the job was requeued. 150s outlasts the wrapper timeout with 30s margin.
 *
 * WHAT THIS TEST VALIDATES:
 * - PATH1: calibrated_field stored as data.field (Float32Array)
 * - PATH2: calibrated_field stored as blob + typedArrayType metadata
 * Both paths must produce a RECON_DONE with a readable depth_map artifact.
 *
 * DOES NOT TEST:
 * - PNG path (PATH3) — removed in V6; unrealistic and extremely slow
 * - plenopticContext stamping — that is a Stage 0 container test concern
 */

(async () => {
  if (!window.initTestUtilities) {
    console.error('[CALIB-V7] Load test-utilities.js first!');
    return;
  }

  const testUtil = await window.initTestUtilities({
    allowPatterns: ['[CALIB-V7]', '[STAGE4]', '[DEPTH-STAGE1]', '[PIN]', '[PERSIST]'],
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
  log('CALIBRATION PATH TEST V7 (PATH1 + PATH2 Only)');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const app        = window.MotionPainter;
  const storageAPI = window.storageAPI;
  const md         = app?.motionDetector;

  if (!assertExists(app,        'window.MotionPainter') ||
      !assertExists(storageAPI, 'window.storageAPI')    ||
      !assertExists(md,         'app.motionDetector')) {
    error('Missing core components');
    return { ok: false, reason: 'missing_components' };
  }

  // Stop evictor so it cannot race against our freshly-persisted artifacts
  try {
    if (typeof storageAPI.stopEvictorLoop === 'function') {
      await storageAPI.stopEvictorLoop();
      log('✓ Evictor stopped');
    }
  } catch (e) {
    warn('Could not stop evictor:', e.message);
  }

  log('Ensuring motion worker...');
  const workerResult = await testUtil.waitForWorkerReady(app, 10000);
  assertTrue(workerResult.ok, `Worker ready in ${workerResult.elapsed}ms`);
  if (!workerResult.ok) {
    error('Worker not ready, aborting');
    return { ok: false, reason: 'no_worker' };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RESOLUTION & TIMEOUT CONSTANTS
  //
  // TARGET_RES 512: sufficient to exercise the full pipeline; keeps GPU work
  // at 512×512 = 262,144 pixels vs 1024×1024 = 1,048,576 pixels (4× faster).
  //
  // WATCH_TIMEOUT_MS 150000: MotionWorkerWrapper declares RECONSTRUCT_META
  // failure at 120 000 ms and requeues the job. We must outlast that so our
  // BroadcastChannel listener is still open when the result arrives.
  // ─────────────────────────────────────────────────────────────────────────
  const TARGET_RES        = 512;
  const FIELD_LENGTH      = TARGET_RES * TARGET_RES * 4;
  const WATCH_TIMEOUT_MS  = 150000;  // 150s > 120s wrapper timeout

  // ============================================================================
  // HELPER: Synthetic calibration field
  // ============================================================================

  function makeFlatField(length) {
    const f = new Float32Array(length);
    for (let i = 0; i < length; i += 4) {
      const jitter = (Math.random() - 0.5) * 0.02;
      f[i]     = 0.48 + jitter;
      f[i + 1] = 0.50 + jitter;
      f[i + 2] = 0.52 + jitter;
      f[i + 3] = 1.0;
    }
    return f;
  }

  // ============================================================================
  // HELPER: Persist a single artifact and wait for visibility
  // ============================================================================

  async function persistArtifact(artifact, testLabel) {
    log(`[${testLabel}] Persisting artifact...`);

    const res = await storageAPI.putInboundArtifact(artifact);
    assertTrue(res && res.ok,   `[${testLabel}] Artifact persisted`);
    assertExists(res.metaKey,   `[${testLabel}] metaKey returned`);

    await sleep(150);

    const checkResult = await waitForArtifact(storageAPI, res.metaKey, { timeoutMs: 2000 });
    assertTrue(checkResult.ok, `[${testLabel}] Artifact visible after persist`);

    return res.metaKey;
  }

  // ============================================================================
  // HELPER: Build the full artifact chain (field → calibration → thumb → manifest)
  // ============================================================================

  async function createManifestChain(fieldArtifactData, label) {
    const t        = Date.now();
    const cameraId = `synthetic:e2e_${label.toLowerCase()}:${t}`;

    log(`[${label}] Creating artifact chain...`);

    // 1. Calibrated field
    const fieldKey = await persistArtifact(fieldArtifactData, label);
    log(`[${label}] ✓ Field: ${fieldKey}`);

    // 2. Calibration record (points at the field)
    const calibKey = await persistArtifact({
      type: 'calibration',
      data: { calibratedFrameKey: fieldKey },
      meta: { width: TARGET_RES, height: TARGET_RES, calibrated: true }
    }, label);
    log(`[${label}] ✓ Calibration: ${calibKey}`);

    // 3. Thumbnail frame
    const canvas  = new OffscreenCanvas(TARGET_RES, TARGET_RES);
    const ctx     = canvas.getContext('2d');
    ctx.fillStyle = '#444';
    ctx.fillRect(0, 0, TARGET_RES, TARGET_RES);
    const thumbBlob = await canvas.convertToBlob({ type: 'image/png' });

    const thumbRes = await storageAPI.putInboundArtifact({
      type: 'frame',
      blob: thumbBlob,
      meta: { timestamp: t, cameraId, width: TARGET_RES, height: TARGET_RES },
      createdAt: new Date(t).toISOString()
    });
    assertTrue(thumbRes.ok, `[${label}] Thumbnail persisted`);
    const thumbKey = thumbRes.metaKey;
    log(`[${label}] ✓ Thumbnail: ${thumbKey}`);

    // 4. HFH annular signal (synthetic spike at bin 2)
    const ann = new Float32Array(12);
    for (let j = 0; j < 12; j++) ann[j] = 0.05;
    ann[2] = 0.98;

    // 5. Manifest (ties everything together)
    const manifestRes = await storageAPI.putInboundArtifact({
      type: 'manifest',
      meta: { timestamp: t, cameraId },
      data: {
        keys:       [thumbKey],
        cameraId,
        width:      TARGET_RES,
        height:     TARGET_RES,
        timestamp:  t,
        createdAt:  new Date(t).toISOString(),
        hfh: {
          annular:       ann,
          annularArray:  Array.from(ann),
          annularCounts: Array.from(new Uint32Array(12).fill(1)),
          annularStats: {
            mean: 0.05, stddev: 0.25, min: 0, max: 1,
            spikeDetected: true, spikeIndex: 2, spikeValue: ann[2]
          }
        },
        hfhDecision: {
          shouldRun: true, reason: 'calib_path_test',
          severity: 0.99, suggestedResolution: TARGET_RES,
          suggestedMode: 'heavy', confidence: 0.95
        },
        calibrationKey: calibKey
      },
      createdAt: new Date(t).toISOString()
    });

    assertTrue(manifestRes.ok, `[${label}] Manifest persisted`);
    await sleep(150);

    log(`[${label}] ✓ Chain complete in ${Date.now() - t}ms`);
    return { manifestKey: manifestRes.metaKey, cameraId, fieldKey, calibKey, thumbKey };
  }

  // ============================================================================
  // HELPER: Fire reconstruction and await RECON_DONE / RECON_FAIL / timeout
  // ============================================================================

  async function fireAndWatch(manifestKey, label, cameraId) {
    log(`[${label}] Firing reconstruction (timeout: ${WATCH_TIMEOUT_MS / 1000}s)...`);

    const jobId = `calib_test_${label}_${Date.now()}`;

    // Create intent
    if (typeof md._createIntent === 'function') {
      md._createIntent({
        jobId, cameraId,
        reason:   'calib_path_test',
        priority: 99,
        meta:     { width: TARGET_RES, height: TARGET_RES },
        annular:  new Float32Array(12).fill(0.5),
        avgLuma:  0.5
      });
    }

    // Notify MotionDetector
    if (typeof md.onArtifactReady === 'function') {
      try {
        md.onArtifactReady({
          metaKey: manifestKey,
          jobId,
          meta: { type: 'manifest', cameraId }
        });
      } catch (e) {
        error(`[${label}] onArtifactReady threw:`, e);
      }
    }

    // Listen on BroadcastChannel
    const bc = new BroadcastChannel('motion-painter-store');

    const outcome = await new Promise((resolve) => {
      const handler = (ev) => {
        const data = ev.data || {};

        if (data.event === 'RECON_DONE' && data.metaKey === manifestKey) {
          log(`[${label}] ✓ RECON_DONE received`);
          bc.removeEventListener('message', handler);
          resolve({ event: 'RECON_DONE', payload: data });
          return;
        }

        if (data.event === 'RECON_FAIL' && data.metaKey === manifestKey) {
          warn(`[${label}] ✗ RECON_FAIL: ${data.error}`);
          bc.removeEventListener('message', handler);
          resolve({ event: 'RECON_FAIL', payload: data });
          return;
        }
      };

      bc.addEventListener('message', handler);

      setTimeout(() => {
        bc.removeEventListener('message', handler);
        resolve({ event: 'timeout' });
      }, WATCH_TIMEOUT_MS);
    });

    bc.close();
    return outcome;
  }

  // ============================================================================
  // HELPER: Validate depth artifact produced by reconstruction
  // ============================================================================

  async function validateDepth(pathLabel, pathResult) {
    log(`[${pathLabel}] Validating...`);

    if (pathResult.event !== 'RECON_DONE') {
      warn(`[${pathLabel}] Skipping — reconstruction did not complete (${pathResult.event})`);
      return { valid: false, error: 'reconstruction_failed' };
    }

    await sleep(500);

    const derivedKeys = pathResult.payload?.derivedKeys || [];
    const depthKey    = derivedKeys.find(k => k.includes('depth_map'));

    if (!depthKey) {
      error(`[${pathLabel}] No depth_map key in derivedKeys: [${derivedKeys.join(', ')}]`);
      return { valid: false, error: 'no_depth_key' };
    }

    log(`[${pathLabel}] Depth key: ${depthKey}`);

    const waitResult = await waitForArtifact(storageAPI, depthKey, {
      timeoutMs: 5000,
      assembleParts: true
    });

    if (!waitResult.ok) {
      error(`[${pathLabel}] ✗ Depth artifact not visible after 5s`);
      return { valid: false, error: 'artifact_not_visible' };
    }

    const artifact = waitResult.artifact;
    let depthData  = null;

    if (artifact.data instanceof Float32Array) {
      depthData = artifact.data;
    } else if (artifact.data?.field) {
      depthData = artifact.data.field;
    } else if (artifact.blob) {
      const ab  = await artifact.blob.arrayBuffer();
      depthData = new Float32Array(ab);
    }

    if (!depthData || depthData.length === 0) {
      error(`[${pathLabel}] ✗ Could not extract depth data`);
      return { valid: false, error: 'no_depth_data' };
    }

    // Sample first 1000 values to avoid spreading large arrays into Math.min/max
    const sampleLen = Math.min(1000, depthData.length);
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < sampleLen; i++) {
      if (depthData[i] < min) min = depthData[i];
      if (depthData[i] > max) max = depthData[i];
    }

    log(`[${pathLabel}] ✓ Depth: ${depthData.length} values, range [${min.toFixed(3)}, ${max.toFixed(3)}]`);

    assertTrue(depthData.length > 0, `${pathLabel}: Depth data has values`);
    assertTrue(min >= 0,             `${pathLabel}: Depth min >= 0`);
    assertTrue(max <= 10,            `${pathLabel}: Depth max <= 10`);

    return { valid: true, stats: { length: depthData.length, min, max } };
  }

  // ============================================================================
  // TEST EXECUTION
  // ============================================================================

  const results          = {};
  const validationResults = {};

  // ── PATH 1: data.field (Float32Array inline) ─────────────────────────────
  log('');
  log('━━━━━ PATH 1: data.field ━━━━━');

  try {
    const artifacts = await createManifestChain(
      {
        type: 'calibrated_field',
        data: { field: makeFlatField(FIELD_LENGTH) },
        meta: { width: TARGET_RES, height: TARGET_RES }
      },
      'PATH1'
    );

    const outcome = await fireAndWatch(artifacts.manifestKey, 'PATH1', artifacts.cameraId);
    log(`[PATH1] Result: ${outcome.event}`);
    assertTrue(outcome.event === 'RECON_DONE', 'PATH1: Reconstruction succeeded');

    results.path1          = { ...artifacts, ...outcome };
    validationResults.path1 = await validateDepth('PATH1', results.path1);

  } catch (e) {
    error('[PATH1] Unexpected error:', e);
    results.path1 = { event: 'error', error: String(e) };
  }

  await sleep(2000);

  // ── PATH 2: blob + typedArrayType ────────────────────────────────────────
  log('');
  log('━━━━━ PATH 2: blob + typedArrayType ━━━━━');

  try {
    const field = makeFlatField(FIELD_LENGTH);
    const blob  = new Blob([field.buffer], { type: 'application/octet-stream' });

    const artifacts = await createManifestChain(
      {
        type: 'calibrated_field',
        blob: blob,
        meta: {
          typedArrayType:   'Float32Array',
          typedArrayLength: field.length,
          width:            TARGET_RES,
          height:           TARGET_RES
        }
      },
      'PATH2'
    );

    const outcome = await fireAndWatch(artifacts.manifestKey, 'PATH2', artifacts.cameraId);
    log(`[PATH2] Result: ${outcome.event}`);
    assertTrue(outcome.event === 'RECON_DONE', 'PATH2: Reconstruction succeeded');

    results.path2          = { ...artifacts, ...outcome };
    validationResults.path2 = await validateDepth('PATH2', results.path2);

  } catch (e) {
    error('[PATH2] Unexpected error:', e);
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

  const allPassed    = Object.values(results).every(r => r.event === 'RECON_DONE');
  const allValidated = Object.values(validationResults).every(v => v.valid === true);

  for (const [path, r] of Object.entries(results)) {
    const status = r.event === 'RECON_DONE' ? '✅ PASSED' :
                   r.event === 'error'      ? '❌ ERROR'  :
                   `❌ ${r.event.toUpperCase()}`;
    log(`  ${path}: ${status}`);

    if (r.payload?.telemetry?.processingMs) {
      log(`    - Processing:  ${r.payload.telemetry.processingMs}ms`);
    }

    const val = validationResults[path];
    if (val?.valid) {
      log(`    - Validation: ✓ ${val.stats.length} values, range [${val.stats.min.toFixed(3)}, ${val.stats.max.toFixed(3)}]`);
    } else if (val) {
      log(`    - Validation: ✗ ${val.error}`);
    }
  }

  log('════════════════════════════════════════════════════');

  const assertStats = testUtil.printSummary();

  log(allPassed && allValidated && assertStats.failed === 0
    ? '✅ ALL TESTS PASSED'
    : '❌ SOME TESTS FAILED');

  log('');
  log('💡 Notes:');
  log('   - Resolution set to 512 (sufficient for path validation, ~4× faster than 1024)');
  log('   - Timeout set to 150s (outlasts the 120s MotionWorkerWrapper RECONSTRUCT_META timeout)');
  log('   - PATH3 (PNG) removed — unrealistic and extremely slow');

  testUtil.restoreConsole();

  window.CALIBRATION_PATH_TEST_V7 = {
    ok:               allPassed && allValidated && assertStats.failed === 0,
    results,
    validationResults,
    assertions:       assertStats,
    config:           { TARGET_RES, WATCH_TIMEOUT_MS }
  };

  log('');
  log('Results: window.CALIBRATION_PATH_TEST_V7');
  log('Run stage0ContainerTest next (it checks window.CALIBRATION_PATH_TEST_V7)');

  return window.CALIBRATION_PATH_TEST_V7;

})();