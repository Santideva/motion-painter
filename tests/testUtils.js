/* TEST UTILITIES - Console Filtering + DB Reset
 * 
 * Usage:
 *   // At start of test:
 *   const testUtil = await window.initTestUtilities();
 *   
 *   // Clean slate:
 *   await testUtil.resetDatabase();
 *   
 *   // At end of test:
 *   testUtil.restoreConsole();
 */

(function() {
  'use strict';
  
  const TEST_PREFIX = '[TEST]';
  const LOG = (...args) => console.log(TEST_PREFIX, ...args);
  const WARN = (...args) => console.warn(TEST_PREFIX, ...args);
  const ERR = (...args) => console.error(TEST_PREFIX, ...args);
  
  // ============================================================================
  // CONSOLE FILTERING (Surgical, Non-Destructive)
  // ============================================================================
  
  function createConsoleFilter(allowList = []) {
    const originalMethods = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      debug: console.debug ? console.debug.bind(console) : console.log.bind(console),
      error: console.error.bind(console)
    };
    
    // Default allow patterns (add test patterns)
    const defaultAllowPatterns = [
      '[TEST]',
      '[ASSERT]',
      '[PIN]',
      '[PERSIST]',
      '[RECON]',
      '[E2E]',
      '[CALIB',
      'RECON_DONE',
      'RECON_FAIL',
      'artifact:ready',
      'artifact:claimed',
      'artifact:released'
    ];
    
    const allowPatterns = [...defaultAllowPatterns, ...allowList];
    
    function shouldAllow(args) {
      try {
        return args.some(arg => 
          typeof arg === 'string' && 
          allowPatterns.some(pattern => arg.includes(pattern))
        );
      } catch (e) {
        return false; // Suppress on error
      }
    }
    
    // Install filtered methods
    ['log', 'warn', 'debug'].forEach(method => {
      console[method] = (...args) => {
        if (shouldAllow(args)) {
          originalMethods[method](...args);
        }
      };
    });
    
    // Always allow errors
    console.error = originalMethods.error;
    
    LOG('✓ Console filter installed (allowing:', allowPatterns.length, 'patterns)');
    
    return {
      restore: () => {
        Object.assign(console, originalMethods);
        originalMethods.log(TEST_PREFIX, '✓ Console filter removed');
      },
      originalMethods
    };
  }
  
  // ============================================================================
  // DATABASE RESET (Safe, Multi-Strategy)
  // ============================================================================
  
  async function resetDatabase(options = {}) {
    const {
      clearArtifacts = true,
      clearPins = true,
      clearReconStatus = true,
      clearCounters = true,
      preserveCalibration = false,
      dbNames = ['motionPainterDB']
    } = options;
    
    LOG('Resetting database...');
    const results = { cleared: [], errors: [], preserved: [] };
    
    for (const dbName of dbNames) {
      try {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open(dbName);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        
        LOG(`  Database: ${dbName} (version ${db.version})`);
        
        // Strategy 1: Clear specific stores
        const storeNames = Array.from(db.objectStoreNames);
        LOG(`    Stores: ${storeNames.join(', ')}`);
        
        const storesToClear = [];
        if (clearArtifacts) storesToClear.push('artifacts', 'artifactParts', 'streams');
        if (clearPins) storesToClear.push('pins');
        if (clearReconStatus) storesToClear.push('reconStatus');
        if (clearCounters) storesToClear.push('counters');
        
        const tx = db.transaction(
          storeNames.filter(name => storesToClear.includes(name)),
          'readwrite'
        );
        
        for (const storeName of storesToClear) {
          if (!storeNames.includes(storeName)) continue;
          
          try {
            const store = tx.objectStore(storeName);
            
            // Selective clearing for artifacts (preserve calibration if requested)
            if (storeName === 'artifacts' && preserveCalibration) {
              const allRequest = store.openCursor();
              let preservedCount = 0;
              let deletedCount = 0;
              
              await new Promise((resolve, reject) => {
                allRequest.onsuccess = (event) => {
                  const cursor = event.target.result;
                  if (cursor) {
                    const record = cursor.value;
                    const isCalibration = record.type?.includes('calib') || 
                                        record.meta?.calibrated === true;
                    
                    if (isCalibration) {
                      preservedCount++;
                      results.preserved.push(`${storeName}:${record.key || 'unknown'}`);
                    } else {
                      cursor.delete();
                      deletedCount++;
                    }
                    cursor.continue();
                  } else {
                    resolve();
                  }
                };
                allRequest.onerror = () => reject(allRequest.error);
              });
              
              results.cleared.push(`${storeName} (deleted: ${deletedCount}, preserved: ${preservedCount})`);
            } else {
              // Full clear
              await new Promise((resolve, reject) => {
                const clearRequest = store.clear();
                clearRequest.onsuccess = () => resolve();
                clearRequest.onerror = () => reject(clearRequest.error);
              });
              
              results.cleared.push(storeName);
            }
          } catch (e) {
            results.errors.push(`${storeName}: ${e.message}`);
          }
        }
        
        await new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        
        db.close();
        LOG(`  ✓ Cleared: ${results.cleared.join(', ')}`);
        
      } catch (e) {
        ERR(`  ✗ Failed to reset ${dbName}:`, e.message);
        results.errors.push(`${dbName}: ${e.message}`);
      }
    }
    
    // Strategy 2: Clear storage API caches if available
    if (window.storageAPI && typeof window.storageAPI.clearCache === 'function') {
      try {
        await window.storageAPI.clearCache();
        results.cleared.push('storageAPI cache');
      } catch (e) {
        results.errors.push(`storageAPI.clearCache: ${e.message}`);
      }
    }
    
    // Strategy 3: Stop/restart evictor to reset state
    if (window.storageAPI) {
      try {
        if (typeof window.storageAPI.stopEvictorLoop === 'function') {
          await window.storageAPI.stopEvictorLoop();
        }
        if (typeof window.storageAPI.startEvictorLoop === 'function') {
          await window.storageAPI.startEvictorLoop();
        }
        results.cleared.push('evictor loop reset');
      } catch (e) {
        WARN('  Evictor reset failed (non-fatal):', e.message);
      }
    }
    
    LOG('Database reset complete');
    if (results.errors.length > 0) {
      WARN('  Errors:', results.errors);
    }
    if (results.preserved.length > 0) {
      LOG('  Preserved:', results.preserved.length, 'calibration artifacts');
    }
    
    return results;
  }
  
  // ============================================================================
  // WAIT HELPERS
  // ============================================================================
  
  function createWaitHelpers() {
    return {
      sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
      
      waitForCondition: async (condition, {
        timeoutMs = 10000,
        pollMs = 100,
        description = 'condition'
      } = {}) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          try {
            if (await condition()) {
              return { ok: true, elapsed: Date.now() - start };
            }
          } catch (e) {
            // Suppress errors during polling
          }
          await new Promise(r => setTimeout(r, pollMs));
        }
        return { ok: false, elapsed: Date.now() - start, reason: 'timeout', description };
      },
      
      waitForWorkerReady: async (app, timeoutMs = 10000) => {
        const start = Date.now();
        
        // Ensure worker exists
        try {
          app._heavyPathRequested = true;
          if (typeof app._ensureMotionWorker === 'function') {
            app._ensureMotionWorker();
          }
        } catch (e) {
          WARN('Failed to ensure worker:', e.message);
        }
        
        while (Date.now() - start < timeoutMs) {
          if (app.motionWorker) {
            const ready = app.motionWorker.workerReady === true ||
                         (typeof app.motionWorker.isReady === 'function' && 
                          app.motionWorker.isReady());
            
            if (ready) {
              return { ok: true, elapsed: Date.now() - start };
            }
          }
          await new Promise(r => setTimeout(r, 200));
        }
        
        return { ok: false, reason: 'timeout', elapsed: Date.now() - start };
      },
      
      waitForArtifact: async (storageAPI, metaKey, {
        timeoutMs = 5000,
        pollMs = 100,
        assembleParts = false
      } = {}) => {
        const start = Date.now();
        
        while (Date.now() - start < timeoutMs) {
          try {
            const artifact = await storageAPI.getArtifact(metaKey, { 
              denormalize: true, 
              assembleParts 
            });
            
            if (artifact) {
              return { ok: true, artifact, elapsed: Date.now() - start };
            }
          } catch (e) {
            // Continue polling on errors
          }
          
          await new Promise(r => setTimeout(r, pollMs));
        }
        
        return { ok: false, reason: 'timeout', elapsed: Date.now() - start };
      }
    };
  }
  
  // ============================================================================
  // ASSERTION HELPERS
  // ============================================================================
  
  function createAssertHelpers() {
    let assertionCount = 0;
    let failureCount = 0;
    const failures = [];
    
    const ASSERT_LOG = (...args) => console.log('[ASSERT]', ...args);
    const ASSERT_ERR = (...args) => console.error('[ASSERT]', ...args);
    
    return {
      assertTrue: (condition, message) => {
        assertionCount++;
        if (!condition) {
          failureCount++;
          const failure = `Assertion failed: ${message}`;
          failures.push(failure);
          ASSERT_ERR('✗', failure);
          return false;
        }
        ASSERT_LOG('✓', message);
        return true;
      },
      
      assertEqual: (actual, expected, message) => {
        assertionCount++;
        if (actual !== expected) {
          failureCount++;
          const failure = `${message}\n  Expected: ${expected}\n  Actual: ${actual}`;
          failures.push(failure);
          ASSERT_ERR('✗', failure);
          return false;
        }
        ASSERT_LOG('✓', message);
        return true;
      },
      
      assertExists: (value, name) => {
        assertionCount++;
        if (value === null || value === undefined) {
          failureCount++;
          const failure = `${name} does not exist`;
          failures.push(failure);
          ASSERT_ERR('✗', failure);
          return false;
        }
        ASSERT_LOG('✓', `${name} exists`);
        return true;
      },
      
      getStats: () => ({
        total: assertionCount,
        passed: assertionCount - failureCount,
        failed: failureCount,
        failures
      }),
      
      printSummary: () => {
        const stats = {
          total: assertionCount,
          passed: assertionCount - failureCount,
          failed: failureCount
        };
        
        ASSERT_LOG('════════════════════════════════════');
        ASSERT_LOG('ASSERTION SUMMARY');
        ASSERT_LOG('════════════════════════════════════');
        ASSERT_LOG(`Total: ${stats.total}`);
        ASSERT_LOG(`Passed: ${stats.passed}`);
        ASSERT_LOG(`Failed: ${stats.failed}`);
        
        if (failures.length > 0) {
          ASSERT_ERR('Failures:');
          failures.forEach(f => ASSERT_ERR('  -', f));
        }
        
        return stats;
      }
    };
  }
  
  // ============================================================================
  // MAIN INIT FUNCTION
  // ============================================================================
  
  async function initTestUtilities(options = {}) {
    const {
      allowPatterns = [],
      resetDB = false,
      resetOptions = {}
    } = options;
    
    LOG('Initializing test utilities...');
    
    // Install console filter
    const consoleFilter = createConsoleFilter(allowPatterns);
    
    // Optionally reset database
    let resetResults = null;
    if (resetDB) {
      resetResults = await resetDatabase(resetOptions);
    }
    
    // Create helpers
    const wait = createWaitHelpers();
    const assert = createAssertHelpers();
    
    LOG('✓ Test utilities initialized');
    
    return {
      // Console control
      restoreConsole: consoleFilter.restore,
      originalConsole: consoleFilter.originalMethods,
      
      // Database control
      resetDatabase: (opts) => resetDatabase(opts || resetOptions),
      resetResults,
      
      // Wait helpers
      ...wait,
      
      // Assertion helpers
      ...assert,
      
      // Utilities
      log: LOG,
      warn: WARN,
      error: ERR
    };
  }
  
  // ============================================================================
  // GLOBAL EXPORT
  // ============================================================================
  
  window.initTestUtilities = initTestUtilities;
  
  LOG('Test utilities module loaded. Usage: const testUtil = await initTestUtilities();');
  
})();