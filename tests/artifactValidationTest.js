/* COMPLETE ARTIFACT VALIDATION SUITE - FIXED
 * 
 * Fixed: Handle getPinnedArtifacts() returning objects instead of strings
 */

(async () => {
  if (!window.initTestUtilities) {
    console.error('[VALIDATION] Load test-utilities.js first!');
    return;
  }
  
  const testUtil = await window.initTestUtilities({
    allowPatterns: ['[VALIDATION]', '[DEPTH]', '[NORMAL]', '[FLUX]', '[CROSS]'],
    resetDB: false
  });
  
  const { log, warn, error, assertTrue, assertExists } = testUtil;
  
  log('╔════════════════════════════════════════════════════════════════╗');
  log('║  ARTIFACT VALIDATION SUITE - DEVELOPMENT GATE                  ║');
  log('║  All tests must pass before proceeding with development        ║');
  log('╚════════════════════════════════════════════════════════════════╝');
  log('');
  
  const storageAPI = window.storageAPI;
  if (!assertExists(storageAPI, 'window.storageAPI')) {
    return { ok: false, reason: 'no_storage_api' };
  }
  
  // ============================================================================
  // HELPER: Load Artifacts
  // ============================================================================
  
  async function loadArtifact(artifactKey, label) {
    try {
      const artifact = await storageAPI.getArtifact(artifactKey, {
        denormalize: true,
        assembleParts: true
      });
      
      if (!artifact) {
        error(`[${label}] Artifact not found: ${artifactKey}`);
        return null;
      }
      
      return artifact;
    } catch (err) {
      error(`[${label}] Load failed:`, err);
      return null;
    }
  }
  
  function extractField(artifact, label) {
    if (artifact.data?.field instanceof Float32Array) {
      return artifact.data.field;
    } else if (artifact.data instanceof Float32Array) {
      return artifact.data;
    } else if (artifact.blob) {
      return 'blob';
    }
    error(`[${label}] Could not extract field from artifact`);
    return null;
  }
  
  // ============================================================================
  // TEST SUITE 1: DEPTH MAP VALIDATION
  // ============================================================================
  
  async function validateDepthMap(depthKey) {
    log('');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('TEST SUITE 1: DEPTH MAP QUALITY');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log(`[DEPTH] Testing: ${depthKey}`);
    
    const artifact = await loadArtifact(depthKey, 'DEPTH');
    if (!artifact) return { passed: false, reason: 'load_failed' };
    
    let depths = extractField(artifact, 'DEPTH');
    if (depths === 'blob') {
      const ab = await artifact.blob.arrayBuffer();
      depths = new Float32Array(ab);
    }
    if (!depths) return { passed: false, reason: 'extract_failed' };
    
    const resolution = artifact.meta?.resolution || Math.sqrt(depths.length);
    log(`[DEPTH] Resolution: ${resolution}×${resolution}, ${depths.length} values`);
    
    const results = { tests: {}, passed: true };
    
    // Test 1.1: Value Range
    log('[DEPTH] Test 1.1: Value range check...');
    let min = Infinity, max = -Infinity, sum = 0;
    for (const d of depths) {
      if (d < min) min = d;
      if (d > max) max = d;
      sum += d;
    }
    const mean = sum / depths.length;
    
    const t1 = {
      min, max, mean,
      checks: {
        non_negative: min >= 0,
        max_reasonable: max <= 10,
        has_variation: max > min,
        positive_mean: mean > 0
      }
    };
    t1.passed = Object.values(t1.checks).every(Boolean);
    results.tests.valueRange = t1;
    
    if (t1.passed) {
      log(`[DEPTH] ✅ Test 1.1 PASSED: Range [${min.toFixed(3)}, ${max.toFixed(3)}], mean ${mean.toFixed(3)}`);
    } else {
      error(`[DEPTH] ❌ Test 1.1 FAILED:`, t1.checks);
      results.passed = false;
    }
    
    // Test 1.2: No Invalid Values
    log('[DEPTH] Test 1.2: Invalid value check...');
    let nanCount = 0, infCount = 0;
    for (const d of depths) {
      if (Number.isNaN(d)) nanCount++;
      else if (!Number.isFinite(d)) infCount++;
    }
    
    const t2 = {
      nanCount, infCount,
      checks: { no_nan: nanCount === 0, no_inf: infCount === 0 }
    };
    t2.passed = t2.checks.no_nan && t2.checks.no_inf;
    results.tests.invalidValues = t2;
    
    if (t2.passed) {
      log(`[DEPTH] ✅ Test 1.2 PASSED: No NaN/Infinity`);
    } else {
      error(`[DEPTH] ❌ Test 1.2 FAILED: NaN=${nanCount}, Inf=${infCount}`);
      results.passed = false;
    }
    
    // Test 1.3: Spatial Continuity
    log('[DEPTH] Test 1.3: Spatial continuity check...');
    let totalVar = 0, edges = 0, comparisons = 0;
    for (let y = 0; y < resolution - 1; y++) {
      for (let x = 0; x < resolution - 1; x++) {
        const idx = y * resolution + x;
        const d = depths[idx];
        const dR = depths[idx + 1];
        const dD = depths[idx + resolution];
        
        const diffR = Math.abs(d - dR);
        const diffD = Math.abs(d - dD);
        
        totalVar += diffR + diffD;
        comparisons += 2;
        
        if (diffR > 0.5 || diffD > 0.5) edges++;
      }
    }
    
    const avgVar = totalVar / comparisons;
    const edgePercent = (edges / (resolution * resolution)) * 100;
    
    const t3 = {
      avgVar, edgePercent,
      checks: {
        smooth_gradients: avgVar < 0.2,
        reasonable_edges: edgePercent < 30
      }
    };
    t3.passed = Object.values(t3.checks).every(Boolean);
    results.tests.spatialContinuity = t3;
    
    if (t3.passed) {
      log(`[DEPTH] ✅ Test 1.3 PASSED: AvgVar=${avgVar.toFixed(4)}, Edges=${edgePercent.toFixed(1)}%`);
    } else {
      warn(`[DEPTH] ⚠️  Test 1.3 MARGINAL: AvgVar=${avgVar.toFixed(4)}, Edges=${edgePercent.toFixed(1)}%`);
    }
    
    // Test 1.4: Distribution
    log('[DEPTH] Test 1.4: Distribution analysis...');
    const histogram = new Array(10).fill(0);
    for (const d of depths) {
      const bin = Math.min(9, Math.floor(d));
      histogram[bin]++;
    }
    
    const middleBins = histogram.slice(1, 5).reduce((a, b) => a + b, 0);
    const middlePercent = (middleBins / depths.length) * 100;
    
    const t4 = {
      histogram, middlePercent,
      checks: {
        middle_concentration: middlePercent > 30,
        not_all_zero: histogram[0] < depths.length * 0.99,
        not_all_far: histogram[9] < depths.length * 0.99
      }
    };
    t4.passed = Object.values(t4.checks).every(Boolean);
    results.tests.distribution = t4;
    
    if (t4.passed) {
      log(`[DEPTH] ✅ Test 1.4 PASSED: Middle=${middlePercent.toFixed(1)}%`);
    } else {
      warn(`[DEPTH] ⚠️  Test 1.4 MARGINAL: Middle=${middlePercent.toFixed(1)}%`);
    }
    
    const criticalPassed = t1.passed && t2.passed;
    const marginalPassed = t3.passed && t4.passed;
    
    results.passed = criticalPassed;
    results.critical = criticalPassed;
    results.marginal = marginalPassed;
    
    if (results.passed) {
      log('[DEPTH] ✅ DEPTH MAP VALIDATION PASSED');
    } else {
      error('[DEPTH] ❌ DEPTH MAP VALIDATION FAILED');
    }
    
    return results;
  }
  
  // ============================================================================
  // TEST SUITE 2: NORMAL MAP VALIDATION
  // ============================================================================
  
  async function validateNormalMap(normalKey) {
    log('');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('TEST SUITE 2: NORMAL MAP QUALITY');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log(`[NORMAL] Testing: ${normalKey}`);
    
    const artifact = await loadArtifact(normalKey, 'NORMAL');
    if (!artifact) return { passed: false, reason: 'load_failed' };
    
    let normals = extractField(artifact, 'NORMAL');
    if (normals === 'blob') {
      const ab = await artifact.blob.arrayBuffer();
      normals = new Float32Array(ab);
    }
    if (!normals) return { passed: false, reason: 'extract_failed' };
    
    const pixelCount = normals.length / 3;
    const resolution = Math.sqrt(pixelCount);
    log(`[NORMAL] Resolution: ${resolution}×${resolution}, ${pixelCount} normals`);
    
    const results = { tests: {}, passed: true };
    
    // Test 2.1: Unit Vectors
    log('[NORMAL] Test 2.1: Unit vector check...');
    let nonUnitCount = 0;
    const tolerance = 0.05;
    
    for (let i = 0; i < normals.length; i += 3) {
      const nx = normals[i];
      const ny = normals[i + 1];
      const nz = normals[i + 2];
      const length = Math.sqrt(nx*nx + ny*ny + nz*nz);
      
      if (Math.abs(length - 1.0) > tolerance) nonUnitCount++;
    }
    
    const errorRate = (nonUnitCount / pixelCount) * 100;
    
    const t1 = {
      nonUnitCount, errorRate,
      checks: { mostly_unit: errorRate < 5 }
    };
    t1.passed = t1.checks.mostly_unit;
    results.tests.unitVectors = t1;
    
    if (t1.passed) {
      log(`[NORMAL] ✅ Test 2.1 PASSED: ${errorRate.toFixed(2)}% non-unit normals`);
    } else {
      error(`[NORMAL] ❌ Test 2.1 FAILED: ${errorRate.toFixed(2)}% non-unit normals`);
      results.passed = false;
    }
    
    // Test 2.2: Z Component Check
    log('[NORMAL] Test 2.2: Z component check...');
    let positiveZ = 0;
    for (let i = 2; i < normals.length; i += 3) {
      if (normals[i] > 0) positiveZ++;
    }
    
    const positivePercent = (positiveZ / pixelCount) * 100;
    
    const t2 = {
      positiveZ, positivePercent,
      checks: { mostly_facing_camera: positivePercent > 70 }
    };
    t2.passed = t2.checks.mostly_facing_camera;
    results.tests.zComponent = t2;
    
    if (t2.passed) {
      log(`[NORMAL] ✅ Test 2.2 PASSED: ${positivePercent.toFixed(1)}% facing camera`);
    } else {
      warn(`[NORMAL] ⚠️  Test 2.2 MARGINAL: ${positivePercent.toFixed(1)}% facing camera`);
    }
    
    // Test 2.3: No Invalid Values
    log('[NORMAL] Test 2.3: Invalid value check...');
    let invalidCount = 0;
    for (const n of normals) {
      if (!Number.isFinite(n)) invalidCount++;
    }
    
    const t3 = {
      invalidCount,
      checks: { no_invalid: invalidCount === 0 }
    };
    t3.passed = t3.checks.no_invalid;
    results.tests.invalidValues = t3;
    
    if (t3.passed) {
      log(`[NORMAL] ✅ Test 2.3 PASSED: No invalid values`);
    } else {
      error(`[NORMAL] ❌ Test 2.3 FAILED: ${invalidCount} invalid values`);
      results.passed = false;
    }
    
    const criticalPassed = t1.passed && t3.passed;
    results.passed = criticalPassed;
    results.critical = criticalPassed;
    
    if (results.passed) {
      log('[NORMAL] ✅ NORMAL MAP VALIDATION PASSED');
    } else {
      error('[NORMAL] ❌ NORMAL MAP VALIDATION FAILED');
    }
    
    return results;
  }
  
  // ============================================================================
  // TEST SUITE 3: FLUX FIELD VALIDATION
  // ============================================================================
  
  async function validateFluxField(fluxKey) {
    log('');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('TEST SUITE 3: FLUX FIELD QUALITY');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log(`[FLUX] Testing: ${fluxKey}`);
    
    const artifact = await loadArtifact(fluxKey, 'FLUX');
    if (!artifact) return { passed: false, reason: 'load_failed' };
    
    const data = artifact.data;
    if (!data) return { passed: false, reason: 'no_data' };
    
    const results = { tests: {}, passed: true };
    
    // Test 3.1: Matrix Dimensions
    log('[FLUX] Test 3.1: Matrix dimension check...');
    const A_csr = data.A_csr;
    const b = data.b;
    
    if (!A_csr || !b) {
      error('[FLUX] ❌ Test 3.1 FAILED: Missing A_csr or b');
      return { passed: false, reason: 'missing_data' };
    }
    
    const rows = A_csr.shape ? A_csr.shape[0] : 0;
    const cols = A_csr.shape ? A_csr.shape[1] : 0;
    
    const t1 = {
      rows, cols, bLength: b.length,
      checks: {
        rows_match_rhs: rows === b.length,
        has_rows: rows > 0,
        has_cols: cols > 0,
        indptr_valid: A_csr.indptr && A_csr.indptr.length === rows + 1
      }
    };
    t1.passed = Object.values(t1.checks).every(Boolean);
    results.tests.dimensions = t1;
    
    if (t1.passed) {
      log(`[FLUX] ✅ Test 3.1 PASSED: ${rows}×${cols} matrix, RHS=${b.length}`);
    } else {
      error(`[FLUX] ❌ Test 3.1 FAILED:`, t1.checks);
      results.passed = false;
    }
    
    // Test 3.2: Sparse Structure
    log('[FLUX] Test 3.2: Sparse structure check...');
    const nnz = A_csr.data ? A_csr.data.length : 0;
    const totalEntries = rows * cols;
    const sparsity = totalEntries > 0 ? (nnz / totalEntries) * 100 : 0;
    
    const t2 = {
      nnz, sparsity,
      checks: {
        is_sparse: sparsity < 20,
        has_entries: nnz > 0
      }
    };
    t2.passed = Object.values(t2.checks).every(Boolean);
    results.tests.sparsity = t2;
    
    if (t2.passed) {
      log(`[FLUX] ✅ Test 3.2 PASSED: ${sparsity.toFixed(2)}% dense (${nnz} entries)`);
    } else {
      error(`[FLUX] ❌ Test 3.2 FAILED: ${sparsity.toFixed(2)}% dense`);
      results.passed = false;
    }
    
    // Test 3.3: SOC Validity
    log('[FLUX] Test 3.3: SOC validity check...');
    const SOCs = data.SOCs || [];
    let invalidSOCs = 0;
    
    for (const soc of SOCs) {
      if (!Array.isArray(soc.indices) || soc.indices.length === 0) {
        invalidSOCs++;
        continue;
      }
      
      for (const idx of soc.indices) {
        if (idx < 0 || idx >= cols) {
          invalidSOCs++;
          break;
        }
      }
    }
    
    const t3 = {
      socCount: SOCs.length, invalidSOCs,
      checks: {
        all_valid: invalidSOCs === 0,
        has_socs: SOCs.length >= 0
      }
    };
    t3.passed = Object.values(t3.checks).every(Boolean);
    results.tests.socs = t3;
    
    if (t3.passed) {
      log(`[FLUX] ✅ Test 3.3 PASSED: ${SOCs.length} SOCs, all valid`);
    } else {
      error(`[FLUX] ❌ Test 3.3 FAILED: ${invalidSOCs} invalid SOCs`);
      results.passed = false;
    }
    
    // Test 3.4: Solver Ready Flag
    log('[FLUX] Test 3.4: Solver ready flag check...');
    const t4 = {
      solverReady: data.solverReady,
      checks: { is_ready: data.solverReady === true }
    };
    t4.passed = t4.checks.is_ready;
    results.tests.solverReady = t4;
    
    if (t4.passed) {
      log(`[FLUX] ✅ Test 3.4 PASSED: Solver ready`);
    } else {
      error(`[FLUX] ❌ Test 3.4 FAILED: Solver not ready`);
      results.passed = false;
    }
    
    if (results.passed) {
      log('[FLUX] ✅ FLUX FIELD VALIDATION PASSED');
    } else {
      error('[FLUX] ❌ FLUX FIELD VALIDATION FAILED');
    }
    
    return results;
  }
  
  // ============================================================================
  // TEST SUITE 4: CROSS-ARTIFACT CONSISTENCY
  // ============================================================================
  
  async function validateCrossArtifacts(depthKey, normalKey, fluxKey, manifestKey) {
    log('');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('TEST SUITE 4: CROSS-ARTIFACT CONSISTENCY');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    const results = { tests: {}, passed: true };
    
    const depthArt = await loadArtifact(depthKey, 'CROSS');
    const normalArt = await loadArtifact(normalKey, 'CROSS');
    const fluxArt = await loadArtifact(fluxKey, 'CROSS');
    
    if (!depthArt || !normalArt || !fluxArt) {
      error('[CROSS] ❌ Could not load all artifacts');
      return { passed: false, reason: 'load_failed' };
    }
    
    // Test 4.1: Resolution Consistency
    log('[CROSS] Test 4.1: Resolution consistency check...');
    const depthRes = depthArt.meta?.resolution;
    const normalRes = normalArt.meta?.resolution;
    
    const t1 = {
      depthRes, normalRes,
      checks: {
        resolutions_match: depthRes === normalRes,
        both_defined: depthRes > 0 && normalRes > 0
      }
    };
    t1.passed = Object.values(t1.checks).every(Boolean);
    results.tests.resolution = t1;
    
    if (t1.passed) {
      log(`[CROSS] ✅ Test 4.1 PASSED: Both ${depthRes}×${depthRes}`);
    } else {
      error(`[CROSS] ❌ Test 4.1 FAILED: Depth=${depthRes}, Normal=${normalRes}`);
      results.passed = false;
    }
    
    // Test 4.2: Timestamp Ordering
    log('[CROSS] Test 4.2: Timestamp ordering check...');
    const depthTime = new Date(depthArt.createdAt).getTime();
    const normalTime = new Date(normalArt.createdAt).getTime();
    const fluxTime = new Date(fluxArt.createdAt).getTime();
    
    const maxTime = Math.max(depthTime, normalTime, fluxTime);
    const minTime = Math.min(depthTime, normalTime, fluxTime);
    const deltaMs = maxTime - minTime;
    
    const t2 = {
      depthTime, normalTime, fluxTime, deltaMs,
      checks: { close_together: deltaMs < 60000 }
    };
    t2.passed = t2.checks.close_together;
    results.tests.timestamps = t2;
    
    if (t2.passed) {
      log(`[CROSS] ✅ Test 4.2 PASSED: All within ${(deltaMs/1000).toFixed(1)}s`);
    } else {
      warn(`[CROSS] ⚠️  Test 4.2 MARGINAL: Spread ${(deltaMs/1000).toFixed(1)}s`);
    }
    
    // Test 4.3: Metadata Links
    log('[CROSS] Test 4.3: Metadata links check...');
    const depthSource = depthArt.meta?.sourceMetaKey;
    const normalSource = normalArt.meta?.sourceMetaKey;
    const fluxSource = fluxArt.meta?.sourceMetaKey;
    
    const t3 = {
      depthSource, normalSource, fluxSource, manifestKey,
      checks: {
        all_link_to_manifest: 
          depthSource === manifestKey &&
          normalSource === manifestKey &&
          fluxSource === manifestKey
      }
    };
    t3.passed = t3.checks.all_link_to_manifest;
    results.tests.metadataLinks = t3;
    
    if (t3.passed) {
      log(`[CROSS] ✅ Test 4.3 PASSED: All link to manifest`);
    } else {
      error(`[CROSS] ❌ Test 4.3 FAILED: Metadata links incorrect`);
      results.passed = false;
    }
    
    if (results.passed) {
      log('[CROSS] ✅ CROSS-ARTIFACT VALIDATION PASSED');
    } else {
      error('[CROSS] ❌ CROSS-ARTIFACT VALIDATION FAILED');
    }
    
    return results;
  }
  
  // ============================================================================
  // MAIN EXECUTION - FIXED
  // ============================================================================
  
  log('');
  log('[VALIDATION] Searching for test artifacts...');
  
  let pinnedArtifacts = [];
  try {
    pinnedArtifacts = await storageAPI.getPinnedArtifacts();
    log(`[VALIDATION] Found ${pinnedArtifacts.length} pinned artifacts`);
    
    // ✅ FIX: Check if elements are objects or strings
    if (pinnedArtifacts.length > 0) {
      const firstItem = pinnedArtifacts[0];
      log(`[VALIDATION] First item type: ${typeof firstItem}`);
      
      if (typeof firstItem === 'object') {
        // Extract keys from objects
        log('[VALIDATION] Extracting keys from pin objects...');
        pinnedArtifacts = pinnedArtifacts.map(item => {
          if (typeof item === 'string') return item;
          if (item.metaKey) return item.metaKey;
          if (item.key) return item.key;
          return JSON.stringify(item);
        });
      }
    }
    
  } catch (err) {
    error('[VALIDATION] Could not retrieve artifacts:', err);
    return { ok: false, reason: 'no_artifacts' };
  }
  
  // Filter for artifact types
  const depthKeys = pinnedArtifacts.filter(k => typeof k === 'string' && k.includes('depth_map'));
  const normalKeys = pinnedArtifacts.filter(k => typeof k === 'string' && k.includes('normal_map'));
  const fluxKeys = pinnedArtifacts.filter(k => typeof k === 'string' && k.includes('flux_field'));
  
  log(`[VALIDATION] Found: ${depthKeys.length} depth, ${normalKeys.length} normal, ${fluxKeys.length} flux`);
  
  if (depthKeys.length === 0) {
    error('[VALIDATION] No artifacts found! Run calibration-path-test-v5.js first.');
    return { ok: false, reason: 'no_test_data' };
  }
  
  log(`[VALIDATION] Testing first reconstruction set`);
  log('');
  
  const testResults = {
    depth: null,
    normal: null,
    flux: null,
    cross: null
  };
  
  const depthKey = depthKeys[0];
  const normalKey = normalKeys[0];
  const fluxKey = fluxKeys[0];
  
  // Parse manifest key from depth key
  const parts = depthKey.split(':');
  const manifestKey = parts.length >= 3 ? `artifact:manifest:${parts[2]}:${parts[3].split(':')[0]}` : null;
  
  log(`[VALIDATION] Depth: ${depthKey}`);
  log(`[VALIDATION] Normal: ${normalKey}`);
  log(`[VALIDATION] Flux: ${fluxKey}`);
  log(`[VALIDATION] Manifest: ${manifestKey}`);
  
  // Run all test suites
  testResults.depth = await validateDepthMap(depthKey);
  testResults.normal = await validateNormalMap(normalKey);
  testResults.flux = await validateFluxField(fluxKey);
  testResults.cross = await validateCrossArtifacts(depthKey, normalKey, fluxKey, manifestKey);
  
  // ============================================================================
  // FINAL VERDICT
  // ============================================================================
  
  log('');
  log('╔════════════════════════════════════════════════════════════════╗');
  log('║  VALIDATION RESULTS - DEVELOPMENT GATE                         ║');
  log('╚════════════════════════════════════════════════════════════════╝');
  log('');
  
  const allPassed = 
    testResults.depth?.passed &&
    testResults.normal?.passed &&
    testResults.flux?.passed &&
    testResults.cross?.passed;
  
  log(`  Depth Map:     ${testResults.depth?.passed ? '✅ PASS' : '❌ FAIL'}`);
  log(`  Normal Map:    ${testResults.normal?.passed ? '✅ PASS' : '❌ FAIL'}`);
  log(`  Flux Field:    ${testResults.flux?.passed ? '✅ PASS' : '❌ FAIL'}`);
  log(`  Consistency:   ${testResults.cross?.passed ? '✅ PASS' : '❌ FAIL'}`);
  log('');
  log('─────────────────────────────────────────────────────────────────');
  
  if (allPassed) {
    log('');
    log('🎉 ALL VALIDATIONS PASSED! 🎉');
    log('');
    log('✅ Artifacts are being persisted correctly');
    log('✅ Depth values are physically plausible');
    log('✅ Normal vectors are mathematically valid');
    log('✅ Flux constraints are well-formed');
    log('✅ Artifacts are mutually consistent');
    log('');
    log('🚀 GREEN LIGHT: PROCEED WITH FURTHER DEVELOPMENT');
    log('');
  } else {
    log('');
    log('⛔ VALIDATION FAILED');
    log('');
    log('❌ One or more quality checks failed');
    log('🛑 DO NOT PROCEED - Fix issues first');
    log('');
  }
  
  log('═════════════════════════════════════════════════════════════════');
  
  testUtil.restoreConsole();
  
  window.ARTIFACT_VALIDATION_RESULTS = {
    ok: allPassed,
    testResults,
    timestamp: new Date().toISOString()
  };
  
  log('Results: window.ARTIFACT_VALIDATION_RESULTS');
  
  return window.ARTIFACT_VALIDATION_RESULTS;
  
})();