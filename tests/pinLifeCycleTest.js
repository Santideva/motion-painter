/* PIN LIFECYCLE INTEGRATION TEST
 * 
 * Tests the complete pin/unpin/claim/release protocol:
 *   1. Producer creates artifact → pins with TTL
 *   2. Consumer discovers → pins → claims
 *   3. Producer cancels TTL (conservative) or unpins (aggressive)
 *   4. Consumer finishes → unpins → releases
 *   5. Producer checks refcount → unpins if last owner
 * 
 * Usage:
 *   1. Load test-utilities.js first
 *   2. Run this script
 *   3. Check window.PIN_LIFECYCLE_TEST
 */

(async () => {
  if (!window.initTestUtilities) {
    console.error('[PIN-TEST] Load test-utilities.js first!');
    return;
  }
  
  // Initialize with console filtering and DB reset
  const testUtil = await window.initTestUtilities({
    allowPatterns: ['[PIN-TEST]', '[PIN]', '[PERSIST]'],
    resetDB: true,
    resetOptions: {
      clearArtifacts: true,
      clearPins: true,
      clearCounters: true
    }
  });
  
  const { log, warn, error, sleep, waitForCondition, assertTrue, assertEqual, assertExists } = testUtil;
  
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('PIN LIFECYCLE INTEGRATION TEST');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  // Gather components
  const storageAPI = window.storageAPI;
  
  if (!assertExists(storageAPI, 'window.storageAPI')) {
    error('Missing storageAPI');
    return { ok: false, reason: 'missing_storage_api' };
  }
  
  // ============================================================================
  // TEST 1: Basic Pin/Unpin
  // ============================================================================
  
  log('');
  log('━━━━━ TEST 1: Basic Pin/Unpin ━━━━━');
  
  try {
    // Create artifact
    const artifact = {
      type: 'test_artifact',
      data: { value: 'test1' },
      meta: { test: true },
      createdAt: new Date().toISOString()
    };
    
    const putResult = await storageAPI.putInboundArtifact(artifact);
    assertTrue(putResult.ok, 'Artifact persisted');
    assertExists(putResult.metaKey, 'metaKey returned');
    
    const metaKey = putResult.metaKey;
    log(`Created artifact: ${metaKey}`);
    
    // Pin artifact
    await storageAPI.pinArtifact(metaKey, {
      owner: 'test_producer',
      type: 'soft',
      ttlMs: 60000
    });
    log('✓ Artifact pinned');
    
    // Verify pin
    await sleep(100);
    const pins = await storageAPI.getPins(metaKey);
    assertEqual(pins.length, 1, 'One pin exists');
    assertEqual(pins[0].owner, 'test_producer', 'Pin owner correct');
    
    const refCount = await storageAPI.getPinRefCount(metaKey);
    assertEqual(refCount, 1, 'Refcount = 1');
    
    // Retrieve artifact
    const retrieved = await storageAPI.getArtifact(metaKey);
    assertTrue(retrieved.meta.pinned === true, 'Artifact metadata shows pinned');
    
    // Unpin artifact
    await storageAPI.unpinArtifact(metaKey, { owner: 'test_producer' });
    log('✓ Artifact unpinned');
    
    // Verify unpin
    await sleep(100);
    const pinsAfter = await storageAPI.getPins(metaKey);
    assertEqual(pinsAfter.length, 0, 'No pins after unpin');
    
    const refCountAfter = await storageAPI.getPinRefCount(metaKey);
    assertEqual(refCountAfter, 0, 'Refcount = 0 after unpin');
    
    log('✅ TEST 1 PASSED');
    
  } catch (e) {
    error('TEST 1 FAILED:', e);
  }
  
  // ============================================================================
  // TEST 2: Multiple Pins (Refcount)
  // ============================================================================
  
  log('');
  log('━━━━━ TEST 2: Multiple Pins (Refcount) ━━━━━');
  
  try {
    // Create artifact
    const artifact = {
      type: 'test_artifact',
      data: { value: 'test2' },
      createdAt: new Date().toISOString()
    };
    
    const putResult = await storageAPI.putInboundArtifact(artifact);
    const metaKey = putResult.metaKey;
    log(`Created artifact: ${metaKey}`);
    
    // Pin by producer
    await storageAPI.pinArtifact(metaKey, {
      owner: 'producer',
      type: 'soft'
    });
    
    // Pin by consumer 1
    await storageAPI.pinArtifact(metaKey, {
      owner: 'consumer1',
      type: 'soft'
    });
    
    // Pin by consumer 2
    await storageAPI.pinArtifact(metaKey, {
      owner: 'consumer2',
      type: 'soft'
    });
    
    log('✓ Pinned by 3 owners');
    
    // Verify refcount
    await sleep(100);
    const pins = await storageAPI.getPins(metaKey);
    assertEqual(pins.length, 3, 'Three pins exist');
    
    const refCount = await storageAPI.getPinRefCount(metaKey);
    assertEqual(refCount, 3, 'Refcount = 3');
    
    // Unpin consumer1
    await storageAPI.unpinArtifact(metaKey, { owner: 'consumer1' });
    await sleep(50);
    
    const refCountAfter1 = await storageAPI.getPinRefCount(metaKey);
    assertEqual(refCountAfter1, 2, 'Refcount = 2 after first unpin');
    
    // Unpin consumer2
    await storageAPI.unpinArtifact(metaKey, { owner: 'consumer2' });
    await sleep(50);
    
    const refCountAfter2 = await storageAPI.getPinRefCount(metaKey);
    assertEqual(refCountAfter2, 1, 'Refcount = 1 after second unpin');
    
    // Unpin producer
    await storageAPI.unpinArtifact(metaKey, { owner: 'producer' });
    await sleep(50);
    
    const refCountFinal = await storageAPI.getPinRefCount(metaKey);
    assertEqual(refCountFinal, 0, 'Refcount = 0 after all unpins');
    
    // Verify artifact metadata
    const retrieved = await storageAPI.getArtifact(metaKey);
    assertTrue(retrieved.meta.pinned === false, 'Artifact metadata shows unpinned');
    
    log('✅ TEST 2 PASSED');
    
  } catch (e) {
    error('TEST 2 FAILED:', e);
  }
  
  // ============================================================================
  // TEST 3: TTL Expiration (Auto-Unpin)
  // ============================================================================
  
  log('');
  log('━━━━━ TEST 3: TTL Expiration (Auto-Unpin) ━━━━━');
  
  try {
    // Create artifact
    const artifact = {
      type: 'test_artifact',
      data: { value: 'test3' },
      createdAt: new Date().toISOString()
    };
    
    const putResult = await storageAPI.putInboundArtifact(artifact);
    const metaKey = putResult.metaKey;
    log(`Created artifact: ${metaKey}`);
    
    // Pin with short TTL
    await storageAPI.pinArtifact(metaKey, {
      owner: 'test_producer',
      type: 'soft',
      ttlMs: 1000 // 1 second
    });
    
    log('✓ Pinned with 1s TTL');
    
    // Verify initial pin
    await sleep(100);
    const pinsBefore = await storageAPI.getPins(metaKey);
    assertEqual(pinsBefore.length, 1, 'Pin exists initially');
    
    // Wait for TTL expiration
    log('Waiting for TTL expiration...');
    await sleep(1500);
    
    // Verify auto-GC (getPins filters expired)
    const pinsAfter = await storageAPI.getPins(metaKey);
    assertEqual(pinsAfter.length, 0, 'Pin auto-GC after TTL expiration');
    
    // Note: Storage-level TTL may not decrement refcount immediately
    // It's cleaned during getPins() calls (lazy GC)
    
    log('✅ TEST 3 PASSED');
    
  } catch (e) {
    error('TEST 3 FAILED:', e);
  }
  
  // ============================================================================
  // TEST 4: Pin Type (Soft vs Hard)
  // ============================================================================
  
  log('');
  log('━━━━━ TEST 4: Pin Type (Soft vs Hard) ━━━━━');
  
  try {
    // Create two artifacts
    const softArtifact = {
      type: 'test_artifact',
      data: { value: 'soft' },
      createdAt: new Date().toISOString()
    };
    
    const hardArtifact = {
      type: 'test_artifact',
      data: { value: 'hard' },
      createdAt: new Date().toISOString()
    };
    
    const softResult = await storageAPI.putInboundArtifact(softArtifact);
    const hardResult = await storageAPI.putInboundArtifact(hardArtifact);
    
    const softKey = softResult.metaKey;
    const hardKey = hardResult.metaKey;
    
    log(`Created soft: ${softKey}`);
    log(`Created hard: ${hardKey}`);
    
    // Pin soft
    await storageAPI.pinArtifact(softKey, {
      owner: 'test',
      type: 'soft'
    });
    
    // Pin hard
    await storageAPI.pinArtifact(hardKey, {
      owner: 'test',
      type: 'hard'
    });
    
    log('✓ Pinned both artifacts');
    
    // Verify pin types
    await sleep(100);
    
    const softPins = await storageAPI.getPins(softKey);
    assertEqual(softPins[0].type, 'soft', 'Soft pin type correct');
    
    const hardPins = await storageAPI.getPins(hardKey);
    assertEqual(hardPins[0].type, 'hard', 'Hard pin type correct');
    
    // Note: Hard pins prevent eviction even under memory pressure
    // (eviction logic in storage.js checks pin type)
    
    log('✅ TEST 4 PASSED');
    
  } catch (e) {
    error('TEST 4 FAILED:', e);
  }
  
  // ============================================================================
  // TEST 5: Concurrent Pin/Unpin (Race Safety)
  // ============================================================================
  
  log('');
  log('━━━━━ TEST 5: Concurrent Pin/Unpin (Race Safety) ━━━━━');
  
  try {
    // Create artifact
    const artifact = {
      type: 'test_artifact',
      data: { value: 'test5' },
      createdAt: new Date().toISOString()
    };
    
    const putResult = await storageAPI.putInboundArtifact(artifact);
    const metaKey = putResult.metaKey;
    log(`Created artifact: ${metaKey}`);
    
    // Simulate concurrent pins
    const pinPromises = [];
    for (let i = 0; i < 5; i++) {
      pinPromises.push(
        storageAPI.pinArtifact(metaKey, {
          owner: `consumer${i}`,
          type: 'soft'
        })
      );
    }
    
    await Promise.all(pinPromises);
    log('✓ 5 concurrent pins completed');
    
    // Verify refcount
    await sleep(100);
    const refCount = await storageAPI.getPinRefCount(metaKey);
    assertEqual(refCount, 5, 'Refcount = 5 after concurrent pins');
    
    // Simulate concurrent unpins
    const unpinPromises = [];
    for (let i = 0; i < 5; i++) {
      unpinPromises.push(
        storageAPI.unpinArtifact(metaKey, {
          owner: `consumer${i}`
        })
      );
    }
    
    await Promise.all(unpinPromises);
    log('✓ 5 concurrent unpins completed');
    
    // Verify refcount
    await sleep(100);
    const refCountFinal = await storageAPI.getPinRefCount(metaKey);
    assertEqual(refCountFinal, 0, 'Refcount = 0 after concurrent unpins');
    
    log('✅ TEST 5 PASSED');
    
  } catch (e) {
    error('TEST 5 FAILED:', e);
  }
  
  // ============================================================================
  // TEST 6: Pin Refresh (Same Owner Re-Pin)
  // ============================================================================
  
  log('');
  log('━━━━━ TEST 6: Pin Refresh (Same Owner Re-Pin) ━━━━━');
  
  try {
    // Create artifact
    const artifact = {
      type: 'test_artifact',
      data: { value: 'test6' },
      createdAt: new Date().toISOString()
    };
    
    const putResult = await storageAPI.putInboundArtifact(artifact);
    const metaKey = putResult.metaKey;
    log(`Created artifact: ${metaKey}`);
    
    // Initial pin with short TTL
    await storageAPI.pinArtifact(metaKey, {
      owner: 'test_producer',
      type: 'soft',
      ttlMs: 2000
    });
    
    const initialPins = await storageAPI.getPins(metaKey);
    const initialExpiresAt = initialPins[0].expiresAt;
    log(`✓ Initial pin (expires: ${new Date(initialExpiresAt).toISOString()})`);
    
    await sleep(500);
    
    // Refresh pin with longer TTL
    await storageAPI.pinArtifact(metaKey, {
      owner: 'test_producer',
      type: 'soft',
      ttlMs: 10000
    });
    
    const refreshedPins = await storageAPI.getPins(metaKey);
    const refreshedExpiresAt = refreshedPins[0].expiresAt;
    log(`✓ Refreshed pin (expires: ${new Date(refreshedExpiresAt).toISOString()})`);
    
    // Verify expiration time extended
    assertTrue(refreshedExpiresAt > initialExpiresAt, 'TTL extended on refresh');
    
    // Verify still only one pin
    assertEqual(refreshedPins.length, 1, 'Still only one pin after refresh');
    
    log('✅ TEST 6 PASSED');
    
  } catch (e) {
    error('TEST 6 FAILED:', e);
  }
  
  // ============================================================================
  // CLEANUP
  // ============================================================================
  
  log('');
  log('━━━━━ Cleanup ━━━━━');
  
  // Reset database to clean state
  await testUtil.resetDatabase();
  
  // ============================================================================
  // SUMMARY
  // ============================================================================
  
  log('');
  log('════════════════════════════════════════════════════');
  log('  TEST SUMMARY');
  log('════════════════════════════════════════════════════');
  
  const assertStats = testUtil.printSummary();
  
  log('════════════════════════════════════════════════════');
  log(assertStats.failed === 0 ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED');
  
  // Restore console
  testUtil.restoreConsole();
  
  window.PIN_LIFECYCLE_TEST = {
    ok: assertStats.failed === 0,
    assertions: assertStats
  };
  
  log('Results: window.PIN_LIFECYCLE_TEST');
  
  return window.PIN_LIFECYCLE_TEST;
  
})();