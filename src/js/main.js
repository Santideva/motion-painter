// Import styles 
import '../styles/main.css';
import '../styles/controls.css';
import '../styles/layout.css';

// Import core modules
import featureFlags from '../config/featureFlags.js';
import { addFrameBufferDiagnostics, addWebGLRendererDiagnostics } from './core/diagnostics.js';
import HybridFresnelHarvester from './core/HybridFresnelHarvester.js';
import { WebGLRenderer } from './core/webGLRenderer.js';
import { FrameBuffer } from './core/FrameBuffer.js';
import { MotionDetector } from './core/MotionDetector.js';
import { CompositeRenderer } from './core/CompositeRenderer.js';
import { FrameEvictionHook } from './core/FrameEvictionHook.js';
import { PreprocessorWorker } from './core/PreProcessorWorker.js';

// MotionWorkerWrapper (wraps /src/js/core/motion.worker.js)
import MotionWorkerWrapper from './core/MotionWorkerWrapper.js';

// Import UI modules
import { Controls } from './ui/Controls.js';
import { MediaInput } from './ui/MediaInput.js';

// Import utilities
import { CONFIG, validateBufferSize } from './utils/MathUtils.js';

// Artifact visualization system (standalone — no pipeline dependencies)
import ArtifactRenderer from './core/ArtifactRenderer.js';
import ArtifactPanel    from './ui/ArtifactPanel.js';

// Import storage API (main may still use storageAPI for other needs)
import storageAPI from './core/storage.js';
import StorageActivityCoordinator from '/src/config/StorageActivityCoordinator.js';

class MotionPainter {
  constructor() {
    this.canvas = null;
    this.video = null;
    this.webglRenderer = null;
    this.frameBuffer = null;
    this.motionDetector = null;
    this.compositeRenderer = null;
    this.controls = null;
    this.mediaInput = null;
    
    // Preprocessor + evictionHook will be created in init() once frameBuffer exists
    this.preprocessor = null;
    this.evictionHook = null;
    
    // MotionWorker (wrapper instance) - created on demand when calibration is requested
    this.motionWorker        = null;
    this._topologyWorker     = null;   // Stage 4A worker — wired when topology pipeline is ready
    this._minimizerWorker    = null;   // Stage 4B worker — wired alongside topology worker
    this._ambiWorker           = null;   // Stage 5 worker — wired alongside Stage 4 workers
    this._kemWorker            = null;   // Stage 6 worker — wired after motionWorker is ready
    this._correspondenceWorker = null;   // Stage 7 worker — wired after motionWorker is ready
    this._stage678State        = null;   // { metaKey, kemDone, correspondenceDone, ambiRefined }
    this._currentFlags         = {};     // Flags snapshot kept current for worker dispatch
    this._heavyPathRequested = false;
    this.cameraContainer     = null;
    // Transient Stage 4 payloads — held only until ambi.worker is dispatched, then nulled.
    // Never stored on cameraContainer; typed arrays must not outlive the dispatch call.
    this._pendingTopoInline      = null;
    this._pendingMinimizerInline = null;
    // BroadcastChannel used for cross-worker signaling (listen for release_request etc.)
    this._bc = null;

    // Artifact visualization system
    this.artifactRenderer = null;
    this.artifactPanel    = null;

    // ── Native continuous pipeline state ─────────────────────────────────
    // These mirror what the test script manages manually via forcePipelineStart
    // and forceDirectReconstruction. The native path automates the same logic
    // that runs on every camera session without console intervention.
    //
    // _nativeCalibComplete:       set true when calibration:ready BC fires.
    //   Before this, reconstruction cannot be dispatched (motion.worker has no
    //   calibration data and would fail with calibratedFrameKey missing).
    //
    // _nativeReconInFlight:       prevents concurrent dispatches. One job at a
    //   time. Cleared in .then() or .catch() of requestReconstructionByMeta.
    //
    // _nativeLastReconAt:         timestamp of last dispatch. Cooldown of 15s
    //   prevents flooding motion.worker with jobs while one is still running.
    //
    // _lastCalibrationCompletedAt + _calibrationLockoutMs:
    //   Post-calibration lockout. MotionDetector emits flat_field_degradation
    //   immediately after calibration:ready fires because the fresh calibration
    //   statistics differ from what was seen during capture. Without a lockout,
    //   a second calibration starts before the first reconstruction completes.
    //   90s is sufficient for one full reconstruction cycle (30-60s) plus buffer.
    this._nativeCalibComplete        = false;
    this._nativeReconInFlight        = false;
    this._nativeLastReconAt          = 0;
    this._nativeReconCooldownMs      = 15000;
    this._lastCalibrationCompletedAt = 0;
    this._calibrationLockoutMs       = 90000;

    // IMPORTANT: main no longer keeps calibration artifacts or bias arrays.
    // The canonical persisted metaKey and tokens are owned/pinned by the preprocessor.worker.
    // Main's role: detect the need for calibration and instruct preprocessor to compute it.
    
    // Track unsubscribers for MotionDetector listeners so we can clean them up on destroy()
    this._motionDetectorUnsubs = [];

    // Guards the periodic stale-job reaper (see init()) so it doesn't compete
    // with calibration's own sequential IndexedDB writes for the same
    // [artifacts, counters, pins] lock scope. This is a SEPARATE setInterval
    // from the main evictor loop (storageAPI.stopEvictorLoop/startEvictorLoop).
    // Now driven generically by StorageActivityCoordinator (see init()) rather
    // than being set/cleared by hand inside _handleCalibrationRequest.
    this._pauseReaper = false;

    // Kinds of StorageActivityCoordinator activity that should pause the
    // evictor/reaper while active. Add new kinds here as new exclusive IDB
    // campaigns are introduced — no other changes to main.js are needed.
    this._coordPauseKinds = ['calibration', 'reconstruction'];
    this._evictorPausedByCoord = false;
    this._coordCheckInterval = null;

    this.isRendering = false;
    this.isPaused = false;
    this.animationId = null;
    this.hardwareLimitations = null; // Track hardware constraints
  }
  
  async init() {
    // Silence high-frequency renderer/storage noise before anything else runs.
    this._installLogFilter();

    try {
      // Get DOM elements
      this.canvas = document.getElementById('glcanvas');
      this.video = document.getElementById('sourceVideo');
      
      if (!this.canvas || !this.video) {
        throw new Error('Required DOM elements not found');
      }
      
      // Initialize core components with enhanced buffer support
      this.webglRenderer = new WebGLRenderer(this.canvas);

      // Diagnostics: attach renderer-level diagnostics (dev only)
      addWebGLRendererDiagnostics(this.webglRenderer, {devMode: true});

      // Check hardware capabilities immediately after WebGL initialization
      this.hardwareLimitations = this.webglRenderer.getCapabilities();
      
      // Validate and adjust initial buffer size based on hardware
      const validation = validateBufferSize(CONFIG.DEFAULT_BUFFER_SIZE);
      const initialBufferSize = validation.clampedSize;
      
      this.frameBuffer = new FrameBuffer(this.webglRenderer.gl, initialBufferSize);

      // DIAGNOSTICS: attach FrameBuffer diagnostics (wrap upload + validation)
      addFrameBufferDiagnostics(this.frameBuffer, { devMode: true });

      // ── Artifact renderer ─────────────────────────────────────────────
      // Shares the WebGL2 context. Must be created before ArtifactPanel so
      // the panel's list() call has a valid registry to query.
      try {
        this.artifactRenderer = new ArtifactRenderer(this.webglRenderer.gl);
        console.log('[ArtifactRenderer] Initialized');
      } catch (arErr) {
        console.warn('[ArtifactRenderer] Initialization failed (non-fatal):', arErr);
        this.artifactRenderer = null;
      }

      // ── Artifact panel ────────────────────────────────────────────────
      if (this.artifactRenderer) {
        try {
          this.artifactPanel = new ArtifactPanel({
            artifactRenderer: this.artifactRenderer,
            onActivate: (name, mode, params) => {
              if (this.artifactRenderer) {
                this.artifactRenderer.setActive(name, mode, params);
              }
            },
            onClear: () => {
              if (this.artifactRenderer) {
                this.artifactRenderer.clearActive();
              }
            }
          });
          console.log('[ArtifactPanel] Initialized');
        } catch (panelErr) {
          console.warn('[ArtifactPanel] Initialization failed (non-fatal):', panelErr);
          this.artifactPanel = null;
        }
      }

      // ── Composite drawer toggle ───────────────────────────────────────
      // Wires the top-bar "⊞ Composite" button to the temporal composite
      // settings drawer (the slide-in panel with the old sidebar controls).
      // Amber accent (⊞ Composite) vs Blue accent (⬡ Scene Analysis) —
      // the two systems are visually and semantically separate.
      try {
        const compositeToggle = document.getElementById('compositeToggle');
        const compositeDrawer = document.getElementById('compositeDrawer');
        const compositeClose  = document.getElementById('compositeClose');

        if (compositeToggle && compositeDrawer) {
          compositeToggle.addEventListener('click', () => {
            const isOpen = compositeDrawer.getAttribute('aria-hidden') === 'false';
            compositeDrawer.setAttribute('aria-hidden', isOpen ? 'true' : 'false');
            compositeToggle.classList.toggle('active', !isOpen);
          });
        }

        if (compositeClose && compositeDrawer) {
          compositeClose.addEventListener('click', () => {
            compositeDrawer.setAttribute('aria-hidden', 'true');
            const btn = document.getElementById('compositeToggle');
            if (btn) btn.classList.remove('active');
          });
        }

        // Mirror the top-bar status text into the drawer status span
        const statusEl  = document.getElementById('status');
        const status2El = document.getElementById('status2');
        if (statusEl && status2El) {
          new MutationObserver(() => {
            status2El.textContent = statusEl.textContent;
          }).observe(statusEl, { childList: true, characterData: true, subtree: true });
        }

        console.log('[CompositeDrawer] Toggle wired');
      } catch (drawerErr) {
        console.warn('[CompositeDrawer] Wire failed (non-fatal):', drawerErr);
      }

      // --- set up preprocessor + eviction hook AFTER FrameBuffer exists ---
      try {
        // create wrapper; the wrapper implementation resolves promises on calibration ready.
        this.preprocessor = new PreprocessorWorker();

        // Broadcast initial flags snapshot only after the wrapper indicates the worker is ready.
        // This avoids races where worker hasn't attached its BC listener yet and misses the initial snapshot.
        try {
          // Prefer wrapper readiness callback if available
          if (this.preprocessor && typeof this.preprocessor.onReady === 'function') {
            this.preprocessor.onReady(() => {
              try {
                featureFlags.broadcastCurrentFlags();
              } catch (e) {
                console.warn('featureFlags.broadcastCurrentFlags failed (onReady)', e);
              }
            });
          } else {
            // Fallback: try an immediate broadcast (keeps behavior compatible with older wrappers)
            try {
              featureFlags.broadcastCurrentFlags();
            } catch (e) {
              console.warn('featureFlags.broadcastCurrentFlags failed (fallback)', e);
            }
          }
        } catch (e) {
          console.warn('Failed to schedule initial featureFlags broadcast', e);
          try { featureFlags.broadcastCurrentFlags(); } catch (err) { console.warn('featureFlags.broadcastCurrentFlags failed (fallback2)', err); }
        }
        

        const hfh = new HybridFresnelHarvester({
          mode: 'annular primary',
          normalized: true
        });

        // create and attach the eviction hook (FrameEvictionHook is defensive if frameBuffer is null)
        this.evictionHook = new FrameEvictionHook(this.preprocessor, {
          hfh,
          enableHFH: true
        });

        // If camera container already known, bind immediately
        if (this.cameraContainer && typeof this.evictionHook.setCameraContainer === 'function') {
          this.evictionHook.setCameraContainer(this.cameraContainer);
        }
        this.evictionHook.attach(this.frameBuffer);
        console.log('Eviction hook attached to FrameBuffer');
      } catch (err) {
        console.error('Failed to initialize preprocessor/eviction hook:', err);
        // keep app running — preprocessor is optional for rendering
        this.preprocessor = null;
        this.evictionHook = null;
      }

      // ========================================================================
      // STORAGE INITIALIZATION & REAPER
      // ========================================================================
      try {
        await storageAPI.initStorage({
          quota: featureFlags.getFlag('storageQuotaBytes') ?? (2 * 1024 * 1024 * 1024),
          // main.js is the designated evictor authority (see storageEvictorAuthority flag).
          startEvictor: (featureFlags.getFlag('storageEvictorAuthority') ?? 'main') !== 'none'
        });
        
        // Start periodic reaper for stale reconstruction jobs
        this._reaperInterval = setInterval(async () => {
          if (this._pauseReaper) return;   // paused during calibration's persist phase — see _handleCalibrationRequest
          try {
            const reaped = await storageAPI.reapStaleRunning(10 * 60 * 1000); // 10 min timeout
            
            if (reaped > 0) {
              console.log(`Reaper: cleaned up ${reaped} stale reconstruction job(s)`);
              
              if (this.controls) {
                this.controls.updateStatus(`Cleaned up ${reaped} stale job(s)`);
              }
            }
          } catch (reaperErr) {
            console.warn('Reaper execution failed:', reaperErr);
          }
        }, 60000); // Every 60 seconds
        
        console.log('Storage initialized with periodic reaper (60s interval)');

        // ── reconStatus cleanup ──────────────────────────────────────────────
        // storageAPI.clearOldReconStatus() existed but was never invoked anywhere,
        // so done/failed reconStatus records accumulated in IndexedDB indefinitely
        // (observed: a 7-day-old stale record cleaned up only incidentally by the
        // reaper above on next page load). Purges records older than reconStatusMaxAgeMs
        // every reconStatusCleanupIntervalMs.
        const _reconCleanupIntervalMs = featureFlags.getFlag('reconStatusCleanupIntervalMs') ?? 3600000;
        const _reconMaxAgeMs = featureFlags.getFlag('reconStatusMaxAgeMs') ?? 604800000;
        this._reconStatusCleanupInterval = setInterval(async () => {
          try {
            const deleted = await storageAPI.clearOldReconStatus(_reconMaxAgeMs);
            if (deleted > 0) {
              console.log(`reconStatus cleanup: purged ${deleted} old record(s)`);
            }
          } catch (cleanupErr) {
            console.warn('reconStatus cleanup failed:', cleanupErr);
          }
        }, _reconCleanupIntervalMs);

        // ── Generic evictor/reaper pause driven by StorageActivityCoordinator ──
        // Replaces the earlier calibration-only stopEvictorLoop()/startEvictorLoop()
        // calls that lived directly inside _handleCalibrationRequest. main.js no
        // longer needs to know which specific worker is doing what — it just asks
        // the coordinator whether any registered exclusive activity is in flight.
        this._coordCheckInterval = setInterval(() => {
          const anyActive = this._coordPauseKinds.some(k => StorageActivityCoordinator.isActive(k));
          if (anyActive && !this._evictorPausedByCoord) {
            try { storageAPI.stopEvictorLoop(); } catch (e) {}
            this._pauseReaper = true;
            this._evictorPausedByCoord = true;
          } else if (!anyActive && this._evictorPausedByCoord) {
            try { storageAPI.startEvictorLoop(); } catch (e) {}
            this._pauseReaper = false;
            this._evictorPausedByCoord = false;
          }
        }, 1000);
      } catch (storageErr) {
        console.error('Storage initialization failed:', storageErr);
        // Non-fatal - continue without reaper
      }
      
      this.motionDetector = new MotionDetector();
      
      // ============================================================================
      // ✅ NEW: Bind storage API to MotionDetector
      // ============================================================================
      /**
       * CRITICAL: MotionDetector requires storage API for artifact persistence
       * 
       * Artifacts persisted by MotionDetector:
       * - annular_analysis (ALWAYS - 30fps)
       * - calibration_decision (ALWAYS - every calibration trigger)
       * - reconstruction_intent (ALWAYS - every reconstruction intent)
       * - motion_analysis (DEBUG - controlled by persistDebugArtifacts flag)
       * - motion_detector_metrics (DEBUG - every 10s)
       * 
       * Without storage binding, MotionDetector will silently skip persistence.
       */
      try {
        if (typeof storageAPI !== 'undefined' && storageAPI) {
          this.motionDetector.setStorageAPI(storageAPI);
          console.log('✅ main.js: Storage API bound to MotionDetector');
        } else {
          console.warn('⚠️ main.js: storageAPI not available for MotionDetector - artifact persistence disabled');
        }
      } catch (storageBindErr) {
        console.error('❌ main.js: Failed to bind storage to MotionDetector', storageBindErr);
        // Non-fatal - MotionDetector can operate without persistence
      }
      
      this.compositeRenderer = new CompositeRenderer(
        this.webglRenderer, 
        this.frameBuffer, 
        this.motionDetector
      );
      
      // Initialize UI components
      this.controls = new Controls();
      this.controls.init();

      // store unsubscribe callbacks so we can clean up on destroy()
      this._flagUnsubs = [];

      // 1) dev panels visibility
      try {
        const unsubDev = featureFlags.subscribeKey('enableDevPanels', ({ key, value }) => {
          try {
            const devPanel = document.querySelector('.dev-panel');
            if (devPanel) devPanel.style.display = value ? 'block' : 'none';
            // also toggle renderer/diagnostics panel state if your components support it
            if (this.webglRenderer && typeof this.webglRenderer.setDebugVisible === 'function') {
              this.webglRenderer.setDebugVisible(!!value);
            }
          } catch (err) {
            console.warn('Dev panel toggle handler failed', err);
          }
        });
        this._flagUnsubs.push(unsubDev);
      } catch (e) { console.warn('subscribeKey enableDevPanels failed', e); }

      // 2) enableFlux — when on/off we update an internal flag; the worker(s) will learn via BC.
      //    We also add a small console log and status update.
      try {
        this._fluxEnabled = !!featureFlags.getFlag('enableFlux');
        const unsubFlux = featureFlags.subscribeKey('enableFlux', ({ key, value }) => {
          this._fluxEnabled = !!value;
          console.log('featureFlags: enableFlux ->', this._fluxEnabled);
          if (this.controls) {
            this.controls.updateStatus(`Flux ${this._fluxEnabled ? 'enabled' : 'disabled'}`);
          }
          // Optional: nudge preprocessor to recompute flux if wrapper exposes such API
          if (this._fluxEnabled && this.preprocessor && typeof this.preprocessor.triggerFluxOnNextFrame === 'function') {
            try { this.preprocessor.triggerFluxOnNextFrame(); } catch (e) {}
          }
        });
        this._flagUnsubs.push(unsubFlux);
      } catch (e) { console.warn('subscribeKey enableFlux failed', e); }

      // 3) fluxMode / other flux parameters — update an internal config snapshot
      try {
        this._fluxConfig = {
          fluxMode: featureFlags.getFlag('fluxMode'),
          fluxDivisor: featureFlags.getFlag('fluxComputeResolutionDivisor'),
          fluxQuant: featureFlags.getFlag('fluxQuantization')
        };
        const unsubFluxConfig = featureFlags.subscribe((payload) => {
          // Keep topology.worker dispatch flags current
          this._currentFlags = featureFlags.getFlags();
          // refresh config snapshot (cheap)
          this._fluxConfig = {
            fluxMode: featureFlags.getFlag('fluxMode'),
            fluxDivisor: featureFlags.getFlag('fluxComputeResolutionDivisor'),
            fluxQuant: featureFlags.getFlag('fluxQuantization'),
            enableFlux: featureFlags.getFlag('enableFlux')
          };
          // You might surface this to the controls UI so users see current flux settings
          if (this.controls && typeof this.controls.updateFluxSettings === 'function') {
            try { this.controls.updateFluxSettings(this._fluxConfig); } catch (e) {}
          }
        });
        this._flagUnsubs.push(unsubFluxConfig);
      } catch (e) { console.warn('subscribe flux config failed', e); }

      // ============================================================================
      // ✅ NEW: Subscribe to persistDebugArtifacts feature flag
      // ============================================================================
      /**
       * CRITICAL: This flag controls high-frequency debug artifact persistence
       * 
       * Impact when enabled:
       * - motion_analysis: ~240KB/s at 30fps (HIGH FREQUENCY)
       * - motion_detector_metrics: ~15KB per 10s (LOW FREQUENCY)
       * 
       * Subscribers:
       * - MotionDetector._persistDebugArtifacts (updated synchronously)
       * - Metrics timer (started/stopped based on flag state)
       * 
       * Performance recommendation:
       * - Enable ONLY for short debugging sessions (<5 minutes)
       * - Always disable in production environments
       */
      try {
        // Apply initial flag value
        const initialDebugFlag = featureFlags.getFlag('persistDebugArtifacts');
        if (this.motionDetector) {
          this.motionDetector._persistDebugArtifacts = !!initialDebugFlag;
          console.log(`main.js: Initial MotionDetector.persistDebugArtifacts = ${this.motionDetector._persistDebugArtifacts}`);
        }
        
        // Subscribe to flag changes
          const unsubDebugArtifacts = featureFlags.subscribeKey('persistDebugArtifacts', ({ key, value }) => {
          const newValue = !!value;
          
          if (this.motionDetector) {
            const oldValue = this.motionDetector._persistDebugArtifacts;
            
            // Only update if value actually changed
            if (oldValue !== newValue) {
              this.motionDetector._persistDebugArtifacts = newValue;
              console.log(`main.js: MotionDetector.persistDebugArtifacts changed: ${oldValue} → ${newValue}`);
              
              // ============================================================================
              // ✅ NEW: Control metrics timer based on flag state
              // ============================================================================
              if (newValue) {
                // Flag enabled - start metrics timer
                if (this._startMetricsTimer) {
                  try {
                    this._startMetricsTimer();
                  } catch (err) {
                    console.warn('main.js: Failed to start metrics timer', err);
                  }
                }
              } else {
                // Flag disabled - stop metrics timer
                if (this._stopMetricsTimer) {
                  try {
                    this._stopMetricsTimer();
                  } catch (err) {
                    console.warn('main.js: Failed to stop metrics timer', err);
                  }
                }
              }
              
              // Update UI status
              if (this.controls) {
                const status = newValue 
                  ? '⚠️ Debug artifact persistence ENABLED (high storage usage - metrics every 10s)'
                  : '✅ Debug artifact persistence disabled (metrics timer stopped)';
                this.controls.updateStatus(status);
              }
              
              // If disabling, optionally trigger cleanup
              if (!newValue && oldValue) {
                console.log('main.js: Debug artifacts disabled - consider clearing old debug artifacts from storage');
                
                // Optional: Provide storage cleanup helper
                if (typeof storageAPI !== 'undefined' && storageAPI) {
                  console.log('main.js: To clean up debug artifacts, run in console:');
                  console.log('  await storageAPI.deleteArtifactsByType("motion_analysis")');
                  console.log('  await storageAPI.deleteArtifactsByType("motion_detector_metrics")');
                }
              }
            }
          }
        });
        
        this._flagUnsubs.push(unsubDebugArtifacts);
        
      } catch (e) {
        console.warn('main.js: persistDebugArtifacts subscription failed', e);
      }

      // ============================================================================
      // ✅ NEW: Subscribe to persistIntermediates flag (informational only)
      // ============================================================================
      /**
       * NOTE: This flag is handled by motion.worker directly via BC
       * Main.js subscription is for UI/logging purposes only
       */
      try {
        const unsubIntermediates = featureFlags.subscribeKey('persistIntermediates', ({ key, value }) => {
          const enabled = !!value;
          console.log(`main.js: persistIntermediates flag changed: ${enabled}`);
          
          if (this.controls) {
            const status = enabled
              ? 'Motion worker: intermediate artifacts enabled (~5MB per reconstruction)'
              : 'Motion worker: intermediate artifacts disabled';
            this.controls.updateStatus(status);
          }
        });
        
        this._flagUnsubs.push(unsubIntermediates);
        
      } catch (e) {
        console.warn('main.js: persistIntermediates subscription failed', e);
      }
      
      const statusElement = document.getElementById('status');
      this.mediaInput = new MediaInput(this.video, statusElement);

      // Receive canonical camera container from MediaInput
      this.mediaInput.onCameraContainer = (container) => {
        // More lenient validation - accept CameraContainer instances or plain objects
        if (!container) {
          console.warn('[cameraContainer] main.js: null/undefined container received');
          return;
        }

        // Extract cameraId from instance or plain object
        const cameraId = container.cameraId || container.id || null;
        
        if (!cameraId) {
          console.warn('[cameraContainer] main.js: container missing cameraId', {
            container,
            keys: Object.keys(container),
            prototype: Object.getPrototypeOf(container)
          });
          return;
        }

        // Extract relevant fields from CameraContainer instance or plain object
        const canonicalContainer = {
          cameraId: cameraId,
          kind: container.kind || 'unknown',
          deviceId: container.deviceId || null,
          status: container.status || 'unknown',
          meta: container.meta || {},

          // --- Stage 0: plenoptic sampling descriptor sub-objects ---
          // Spread from container instance (populated by startCamera()).
          // Fallback objects mirror CameraContainer constructor defaults so
          // file/synthetic sources that skip track inspection still produce
          // a valid, consistent container.
          differentialGeometry: Object.freeze({
            ...(container.differentialGeometry || {
              orientationConvention: 'CCW',
              reconstructionResolution: null,
              pipelineVersion: '1.0'
            })
          }),
          plenopticSampling: Object.freeze({
            ...(container.plenopticSampling || {
              nativeWidthPx: null,
              nativeHeightPx: null,
              activeWidthPx: null,
              activeHeightPx: null,
              frameRate: null,
              spectralModel: 'srgb',
              angularApertureSr: null,
              shutterType: 'rolling',
              temporalEpochUTC: null,
              effectiveWindowMs: null,
              clockDriftPpmEstimate: 0,
              tetrachromaticExpanded: false
            })
          }),
          ambiFrame: Object.freeze({
            ...(container.ambiFrame || {
              worldFrameId: null,
              legibilityScore: null,
              viewManifoldComponent: null,
              positionInManifold: null,
              sharedStructureId: null
            })
          }),

          hasStream: !!container.stream,
          hasVideoElement: !!container.videoElement,
          createdAt: container.createdAt || Date.now()
        };

        // Freeze to prevent mutations
        this.cameraContainer = Object.freeze(canonicalContainer);
        
        console.log('[cameraContainer] main.js: canonical camera container set', {
          cameraId: this.cameraContainer.cameraId,
          kind: this.cameraContainer.kind,
          status: this.cameraContainer.status
        });

        // Propagate to eviction hook immediately if available
        if (this.evictionHook) {
          if (typeof this.evictionHook.setCameraContainer === 'function') {
            console.log('[cameraContainer] main.js: propagating to evictionHook');
            this.evictionHook.setCameraContainer(this.cameraContainer);
          } else {
            console.warn('[cameraContainer] main.js: evictionHook exists but has no setCameraContainer method');
          }
        } else {
          console.log('[cameraContainer] main.js: evictionHook not yet initialized (will propagate on init)');
        }

        // ── Arm motionWorker early ───────────────────────────────────────────
        // The wrapper takes ~4s to start (ES module worker + storage init).
        // Starting here, rather than waiting for calibrationNeeded, ensures the
        // worker is ready and listening to BC by the time calibration frames
        // have been collected and the calibration:ready event fires.
        if (!this._heavyPathRequested) {
          this._heavyPathRequested = true;
          try {
            this._ensureMotionWorker();
            console.log('[cameraContainer] main.js: heavy path armed — motionWorker bootstrap initiated');
          } catch (e) {
            console.warn('[cameraContainer] main.js: _ensureMotionWorker failed (non-fatal):', e);
          }
        }

        // ── Open calibration stable-scene gate ──────────────────────────────
        // MotionDetector._calibrationStale starts as an empty Map.
        // _isCalibrationStale(cameraId) returns false for any new cameraId,
        // which means the stable-scene condition in handleAnnularEvent never
        // emits calibrationNeeded regardless of how stable the scene is.
        // Calling _markCalibrationStale here opens that gate.
        // The gate closes again when notifyCalibrationComplete is called from
        // the calibration:ready BC handler, allowing the cycle to repeat.
        if (this.motionDetector && cameraId) {
          try {
            this.motionDetector._markCalibrationStale(cameraId, 'camera_start');
            console.log('[cameraContainer] main.js: calibration marked stale for', cameraId,
                        '— stable-scene gate now open');
          } catch (e) {
            console.warn('[cameraContainer] main.js: _markCalibrationStale failed (non-fatal):', e);
          }
        }
      };
      
      // Set up event handlers
      this.setupEventHandlers();

      // Snapshot current flags for topology.worker dispatch.
      // Kept live via the featureFlags.subscribe callback below.
      try {
        this._currentFlags = featureFlags.getFlags();
      } catch (e) {
        console.warn('main.js: failed to snapshot initial feature flags', e);
        this._currentFlags = {};
      }

      // Initialize BroadcastChannel for cross-worker coordination (release requests, etc.)
      try {
        // Use the same channel name as the preprocessor.worker to keep events consistent
        this._bc = new BroadcastChannel('motion-painter-store');
        this._bc.addEventListener('message', (ev) => {
          const msg = ev.data || {};

          // Forward release requests from MotionWorker (or any worker) to the preprocessor wrapper
          if (msg && msg.event === 'calibration:release_request') {
            const token = msg.releaseToken || msg.token || null;
            const metaKey = msg.metaKey || null;
            if (!token) {
              console.warn('Main: received calibration:release_request with no token', msg);
              return;
            }
            if (this.preprocessor && typeof this.preprocessor.releaseCalibrationToken === 'function') {
              try {
                this.preprocessor.releaseCalibrationToken(token);
                console.log('Main: forwarded release token to preprocessor', { token, metaKey });
              } catch (e) {
                console.warn('Main: failed to forward release token to preprocessor', e, msg);
              }
            } else {
              console.warn('Main: no preprocessor wrapper available to handle release token', token);
            }
          }

          // --- Stage 0: container writeback from motion.worker after first reconstruction ---
          // motion.worker broadcasts RECON_DONE with reconstructionResolution and effectiveWindowMs
          // once it has completed its first reconstruction pass and instantiated DirectionalLifting.
          // We re-freeze the container with these values so all subsequent artifact snapshots
          // carry the fully calibrated sampling context.
          if (msg && msg.event === 'RECON_DONE') {
            console.log('[RECON_DONE] main.js: guard evaluation:', {
              hasMsg:           !!msg,
              hasCameraContainer: !!this.cameraContainer,
              msgCameraId:      msg.cameraId       ?? '(absent)',
              ccCameraId:       this.cameraContainer?.cameraId ?? '(absent)',
              cameraIdMatch:    msg.cameraId === this.cameraContainer?.cameraId,
              willEnterHandler: !!(msg && this.cameraContainer && msg.cameraId === this.cameraContainer?.cameraId)
            });
          }

          if (msg && msg.event === 'RECON_DONE' &&
              this.cameraContainer &&
              msg.cameraId === this.cameraContainer.cameraId) {

            const updates = {};

            if (msg.reconstructionResolution != null) {
              updates.differentialGeometry = {
                reconstructionResolution: msg.reconstructionResolution
              };
            }

            if (msg.effectiveWindowMs != null) {
              updates.plenopticSampling = {
                effectiveWindowMs: msg.effectiveWindowMs
              };
            }

            if (Object.keys(updates).length > 0) {
              try {
                this._updateCameraContainer(updates);
                console.log('[Stage0] main.js: container updated from RECON_DONE writeback', {
                  cameraId: this.cameraContainer.cameraId,
                  reconstructionResolution: this.cameraContainer.differentialGeometry?.reconstructionResolution,
                  effectiveWindowMs: this.cameraContainer.plenopticSampling?.effectiveWindowMs
                });
              } catch (e) {
                console.warn('[Stage0] main.js: _updateCameraContainer failed on RECON_DONE', e);
              }
            }


            // ── Stage 1 inline data — store on cameraContainer for forwarding ──
            // directness_field, modal_decomposition, penumbra_field are no longer
            // persisted to IDB. They travel inline in RECON_DONE and are forwarded
            // directly to consumer workers via postMessage.
            if (msg.stage1Inline) {
              try {
                this._updateCameraContainer({
                  passThrough: { stage1Inline: msg.stage1Inline }
                });
              } catch (e) {
                console.warn('[Stage1] main.js: stage1Inline writeback failed', e);
              }
            }

            // ── fluxInline: store on cameraContainer for minimizer forwarding ──
            // A_coo and solver data travel inline — fluxFieldKey is null.
            // minimizer.worker reads from msg.fluxInline instead of getArtifact.
            if (msg.fluxInline) {
              try {
                this._updateCameraContainer({
                  passThrough: { fluxInline: msg.fluxInline }
                });
                console.log('[Stage3] main.js: fluxInline stored on cameraContainer (full flux_field):', {
                  hasACoo:      !!msg.fluxInline.A_coo,
                  hasAcsr:      !!msg.fluxInline.A_csr,
                  hasB:         !!msg.fluxInline.b,
                  hasSOCs:      !!msg.fluxInline.SOCs,
                  hasInitH:     !!msg.fluxInline.init_h,
                  acoRowLength: msg.fluxInline.A_coo?.row?.length ?? 0,
                  solverReady:  msg.fluxInline.solverReady         ?? false
                });
              } catch (e) {
                console.warn('[Stage3] main.js: fluxInline writeback failed', e);
              }
            } else {
              console.warn('[Stage3] main.js: fluxInline absent in RECON_DONE — minimizer will have no SOC data');
            }

            // ── sdfInline: store on cameraContainer for worker forwarding ──────
            // signedSdf, narrowBandMask, densityMap, surfaceMask are not in IDB.
            // They travel in msg.sdfInline and must be stored here so the
            // topology and minimizer dispatch blocks below can include them.
            // cc.sdfInline is also available to any future consumer stage.
            if (msg.sdfInline) {
              try {
                this._updateCameraContainer({
                  passThrough: { sdfInline: msg.sdfInline }
                });
                
                console.log('[Stage2] main.js: sdfInline stored on cameraContainer:', {
                  signedSdfLength:      msg.sdfInline.signedSdf?.length      ?? 0,
                  narrowBandMaskLength: msg.sdfInline.narrowBandMask?.length ?? 0,
                  densityMapLength:     msg.sdfInline.densityMap?.length     ?? 0,
                  surfaceMaskLength:    msg.sdfInline.surfaceMask?.length    ?? 0
                });
              } catch (e) {
                console.warn('[Stage2] main.js: sdfInline writeback failed', e);
              }
} else {
              console.warn('[Stage2] main.js: sdfInline absent in RECON_DONE — topology and minimizer will lack SDF arrays');
            }

          // ── directionalFieldInline: store for topology + ambi workers ──────
            if (msg.directionalFieldInline) {
              try {
                this._updateCameraContainer({
                  passThrough: { directionalFieldInline: msg.directionalFieldInline }
                });
                console.log('[Stage3] main.js: directionalFieldInline stored on cameraContainer:', {
                  fieldLength:     msg.directionalFieldInline.field?.length     ?? 0,
                  coherenceLength: msg.directionalFieldInline.coherence?.perPixel?.length
                                   ?? msg.directionalFieldInline.coherence?.length ?? 0
                });
              } catch (e) {
                console.warn('[Stage3] main.js: directionalFieldInline writeback failed', e);
              }
            } else {
              console.warn('[Stage3] main.js: directionalFieldInline absent — topology/ambi will fall back to IDB');
            }    

            // ── flowFieldInline: cache for KEM dispatch ──────────────────────
            if (msg.flowFieldInline) {
              try {
                this._updateCameraContainer({
                  passThrough: { flowFieldInline: msg.flowFieldInline }
                });
                console.log('[Stage3] main.js: flowFieldInline stored on cameraContainer:', {
                  uLength: msg.flowFieldInline.u?.length ?? 0,
                  vLength: msg.flowFieldInline.v?.length ?? 0
                });
              } catch (e) {
                console.warn('[Stage3] main.js: flowFieldInline writeback failed', e);
              }
            }

            // ── normalInline: store on cameraContainer for topology forwarding ─
            if (msg.normalInline) {
              try {
                this._updateCameraContainer({
                  passThrough: { normalInline: msg.normalInline }
                });
                console.log('[Stage2] main.js: normalInline stored on cameraContainer:', {
                  fieldLength: msg.normalInline.field?.length ?? 0,
                  resolution:  msg.normalInline.resolution
                });
              } catch (e) {
                console.warn('[Stage2] main.js: normalInline writeback failed', e);
              }
            }
            // ── diskSeedsForMinimizer: store for minimizer.worker dispatch ─────
            // Tiny payload (<1KB). Eliminates minimizer.worker's IDB open for
            // disk_seeds artifact.
            if (msg.diskSeedsForMinimizer) {
              try {
                this._updateCameraContainer({
                  passThrough: { diskSeedsForMinimizer: msg.diskSeedsForMinimizer }
                });
                console.log('[Stage2] main.js: diskSeedsForMinimizer stored on cameraContainer:', {
                  seedCount: msg.diskSeedsForMinimizer.length
                });
              } catch (e) {
                console.warn('[Stage2] main.js: diskSeedsForMinimizer writeback failed', e);
              }
            }

            // ── Stage 2: SDF and disk seed keys ────────────────────────────
            // Hoisted to cameraContainer top-level so Stage 4B
            // (ConstrainedMinimizer) can resolve inputs without a storage query.
            if (msg.stage2) {
              try {
                this._updateCameraContainer({
                  passThrough: {
                    stage2: {
                      sdfFieldKey:    msg.stage2.sdfFieldKey    ?? null,
                      diskSeedsKey:   msg.stage2.diskSeedsKey   ?? null,
                      seedCount:      msg.stage2.seedCount      ?? 0,
                      sdfRange:       msg.stage2.sdfRange       ?? null
                    },
                    // Hoist the two most-consumed keys to top level so legacy
                    // consumers that predate the stage2 sub-object don't need
                    // updating.
                    sdfFieldKey:  msg.stage2.sdfFieldKey  ?? null,
                    diskSeedsKey: msg.stage2.diskSeedsKey ?? null
                  }
                });
                console.log('[Stage2] main.js: sdfFieldKey/diskSeedsKey written to cameraContainer', {
                  sdfFieldKey:  msg.stage2.sdfFieldKey,
                  diskSeedsKey: msg.stage2.diskSeedsKey,
                  seedCount:    msg.stage2.seedCount
                });
              } catch (e) {
                console.warn('[Stage2] main.js: stage2 writeback failed', e);
              }
            }

            // ── Stage 3 prerequisite: optical flow key + directional field ──
            if (msg.stage3) {
              try {
                this._updateCameraContainer({
                  passThrough: {
                    stage3: {
                      flowFieldKey:        msg.stage3.flowFieldKey        ?? null,
                      directionalFieldKey: msg.stage3.directionalFieldKey ?? null
                    }
                  }
                });
                // Hoist directionalFieldKey to top-level for topology.worker lookup
                if (msg.stage3.directionalFieldKey) {
                  this._updateCameraContainer({
                    passThrough: {
                      directionalFieldKey: msg.stage3.directionalFieldKey
                    }
                  });
                }
                console.log('[Stage3] main.js: flowFieldKey + directionalFieldKey written to cameraContainer', {
                  flowFieldKey:        msg.stage3.flowFieldKey,
                  directionalFieldKey: msg.stage3.directionalFieldKey
                });
              } catch (e) {
                console.warn('[Stage3] main.js: stage3 writeback failed', e);
              }
            }
            // Hoist fluxFieldKey to top-level (needed by minimizer.worker, Stage 4B)
            if (msg.fluxFieldKey) {
              try {
                this._updateCameraContainer({
                  passThrough: { fluxFieldKey: msg.fluxFieldKey }
                });
                console.log('[Stage3] main.js: fluxFieldKey hoisted to top-level', {
                  fluxFieldKey: msg.fluxFieldKey
                });
              } catch (e) {
                console.warn('[Stage3] main.js: fluxFieldKey hoist failed', e);
              }
            }

            // ── dgInline: DG computed arrays — direct assignment ───────────
            // _updateCameraContainer handles known keys only.
            // dgInline is stored directly on cc so topology, minimizer and
            // ambi workers can receive it without an IDB lookup.
            if (msg.dgInline) {
              try {
                this._updateCameraContainer({
                  passThrough: { dgInline: msg.dgInline }
                });
                console.log('[Stage4] main.js: dgInline stored on cameraContainer:', {
                  hasKH:          !!msg.dgInline.kH,
                  hasPrincipalE1: !!msg.dgInline.principalE1,
                  hasNormalCurl:  !!msg.dgInline.normalCurl,
                  hasFlowCurl:    !!msg.dgInline.flowCurl,
                  hasFlowDiv:     !!msg.dgInline.flowDiv
                });
              } catch (e) {
                console.warn('[Stage4] main.js: dgInline writeback failed', e);
              }
            } else {
              console.warn('[Stage4] main.js: dgInline absent — consumers will have null kH');
            }
            
            // ── Stage 4: DifferentialGeometry keys ─────────────────────────
            // Written into cameraContainer.differentialGeometry so Stage 5+
            // can resolve any DG artifact key without a storage query.
            // All values may be null when the relevant input was unavailable.
            if (msg.stage4) {
              try {
                this._updateCameraContainer({
                  differentialGeometry: {
                    curvatureKey:      msg.stage4.curvatureKey      ?? null,
                    principalFrameKey: msg.stage4.principalFrameKey ?? null,
                    sdfDivKey:         msg.stage4.sdfDivKey         ?? null,
                    sdfCurlKey:        msg.stage4.sdfCurlKey        ?? null,
                    normalCurlKey:     msg.stage4.normalCurlKey     ?? null,
                    flowDivKey:        msg.stage4.flowDivKey        ?? null,
                    flowCurlKey:       msg.stage4.flowCurlKey       ?? null,
                    overhangCurlKey:   msg.stage4.overhangCurlKey   ?? null,
                    dgComputedAt:      Date.now()
                  }
                });
                console.log('[Stage4] main.js: DifferentialGeometry keys written to cameraContainer.differentialGeometry', {
                  curvatureKey:      msg.stage4.curvatureKey,
                  principalFrameKey: msg.stage4.principalFrameKey,
                  sdfDivKey:         msg.stage4.sdfDivKey,
                  flowDivKey:        msg.stage4.flowDivKey        ?? null,
                  overhangCurlKey:   msg.stage4.overhangCurlKey   ?? null
                });
              } catch (e) {
                console.warn('[Stage4] main.js: stage4 writeback failed', e);
              }
            }
            // Pause the periodic IDB evictor for the duration of Stage 4.
            // The evictor fires checkQuotaAndEvict every 10s which creates a
            // readwrite transaction on ARTIFACTS_STORE — this blocks topology.worker's
            // readonly read on the same store across all IDB connections.
            // Resumed in _checkStage4Complete once both Stage 4 workers finish.
            try { storageAPI.stopEvictorLoop(); } catch(e) {
              console.warn('[Stage4] main.js: failed to pause evictor', e);
            }

            // Pause the periodic IDB evictor for the duration of Stage 4.
            // The evictor fires checkQuotaAndEvict every 10s which creates a
            // readwrite transaction on ARTIFACTS_STORE — this blocks topology.worker's
            // readonly read on the same store across all IDB connections.
            // Resumed in _checkStage4Complete once both Stage 4 workers finish.
            try { storageAPI.stopEvictorLoop(); } catch(e) {
              console.warn('[Stage4] main.js: failed to pause evictor', e);
            }

            // ── Stage 4A: fire topology.worker ──────────────────────────────
            // All inputs are now in cameraContainer after Stage 2–4 writes.
            // topology.worker broadcasts TOPOLOGY_DONE when complete.
            if (this._topologyWorker && msg.metaKey) {
              const cc = this.cameraContainer;
              try {
                this._topologyWorker.postMessage({
                  op:      'TOPOLOGY_ANALYZE',
                  jobId:   `topo:${msg.metaKey}:${Date.now()}`,
                  metaKey: msg.metaKey,
                  flags:   this._currentFlags ?? {},
                  stage1Inline: cc.stage1Inline ?? null,
                  sdfInline:    cc.sdfInline     ?? null,
                  normalInline: null,    // topology never uses normalInline.field
                  // principalE2 excluded — topology.worker does not use it.
                  // Saves 8MB from this structured clone.
                  dgInline: cc.dgInline ? {
                    kH:         cc.dgInline.kH          ?? null,
                    principalE1: cc.dgInline.principalE1 ?? null,
                    normalCurl: cc.dgInline.normalCurl  ?? null,
                    flowCurl:   cc.dgInline.flowCurl    ?? null,
                    flowDiv:    cc.dgInline.flowDiv     ?? null
                  } : null,
                  directionalFieldInline: cc.directionalFieldInline ?? null,
                  artifactKeys: {
                    directionalFieldKey: cc.directionalFieldInline ? null : (cc.directionalFieldKey ?? null),
                    sdfFieldKey:         null,
                    diskSeedsKey:        null,   // disk seeds go to minimizer.worker only
                    curvatureKey:        null,  // kH in dgInline
                    principalFrameKey:   null,  // unused by topology
                    sdfDivKey:           cc.differentialGeometry?.sdfDivKey            ?? null,
                    flowFieldKey:        null,   // flowCurl + flowDiv from dgInline are sufficient; raw u/v not needed by topology
                    flowCurlKey:         null,  // in dgInline
                    flowDivKey:          null,  // in dgInline
                    directnessFieldKey:  null,
                    normalCurlKey:       null,  // in dgInline
                    penumbraFieldKey:    null,
                    normalMapKey:        null,
                    resolution:          cc.differentialGeometry?.reconstructionResolution
                                         ?? cc.reconstructionResolution
                                         ?? 512
                  }
                });
                console.log('[Stage4A] main.js: topology.worker dispatched', {
                  metaKey:              msg.metaKey,
                  hasSdfInline:         !!cc.sdfInline,
                  hasStage1Inline:      !!cc.stage1Inline,
                  diskSeedsKey:         cc.stage2?.diskSeedsKey ?? null
                });
              } catch (topoErr) {
                console.warn('[Stage4A] main.js: topology.worker dispatch failed', topoErr);
              }

              // ── Worker crash diagnostic ────────────────────────────────────
              // If a worker throws an unhandled error it fires onerror.
              // These handlers let us distinguish a worker crash from OOM.
              if (this._topologyWorker) {
                this._topologyWorker.onerror = (e) => {
                  console.error('[topology.worker] WORKER CRASH:', {
                    message:  e.message,
                    filename: e.filename,
                    lineno:   e.lineno,
                    colno:    e.colno
                  });
                };
              }
            }
            // ── Stage 4B: fire minimizer.worker ─────────────────────────────────────
            // Runs in parallel with topology.worker (Phase A).
            // Phase B executes after minimizer.worker receives TOPOLOGY_DONE on BC.
            if (this._minimizerWorker && msg.metaKey) {
              const cc = this.cameraContainer;
              try {
                this._minimizerWorker.postMessage({
                  op:      'MINIMIZE',
                  jobId:   `mini:${msg.metaKey}:${Date.now()}`,
                  metaKey: msg.metaKey,
                  flags:   this._currentFlags ?? {},
                  sdfInline:  cc.sdfInline  ?? null,
                  fluxInline: cc.fluxInline ?? null,
                  // minimizer only uses kH — strip principalE1/E2, normalCurl,
                  // flowCurl, flowDiv. Saves 24MB from this structured clone.
                  dgInline: cc.dgInline?.kH ? { kH: cc.dgInline.kH } : null,
                  diskSeedsInline: cc.diskSeedsForMinimizer     ?? null,
                  artifactKeys: {
                    sdfFieldKey:   null,
                    diskSeedsKey:  cc.stage2?.diskSeedsKey               ?? null,
                    fluxFieldKey:  null,
                    curvatureKey:  null,   // kH in dgInline
                    normalMapKey:  null,   // unused by minimizer
                    resolution:    cc.reconstructionResolution           ?? 512
                  }
                });
                console.log('[Stage4B] main.js: minimizer.worker dispatched', {
                  metaKey:        msg.metaKey,
                  hasSdfInline:   !!cc.sdfInline,
                  hasFluxInline:  !!cc.fluxInline,
                  acoRowLength:   cc.fluxInline?.A_coo?.row?.length ?? 0,
                  diskSeedsKey:   cc.stage2?.diskSeedsKey ?? null
                });  } catch (miniErr) {
                console.warn('[Stage4B] main.js: minimizer.worker dispatch failed', miniErr);
              }

              if (this._minimizerWorker) {
                this._minimizerWorker.onerror = (e) => {
                  console.error('[minimizer.worker] WORKER CRASH:', {
                    message:  e.message,
                    filename: e.filename,
                    lineno:   e.lineno,
                    colno:    e.colno
                  });
                };
              }
            }

            // ── Release large inline arrays now that Stage 4 workers have been dispatched.
            // postMessage structured-clones the payloads; originals on cameraContainer
            // are no longer needed and would otherwise survive indefinitely under the
            // frozen object chain, holding ~2–4 MB of dead Float32Arrays.
            // dgInline is intentionally kept — ambi.worker reads it in _checkStage4Complete.
            // fluxInline is intentionally kept — ambi.worker may use overhang data.
            try {
              this._updateCameraContainer({
                passThrough: {
                  sdfInline:    null,
                  normalInline: null
                }
              });
            } catch (e) {
              console.warn('[Stage4] main.js: failed to release sdfInline/normalInline from cameraContainer', e);
            }
          }
          // ── calibration:ready → close the calibration loop ──────────────────
          // This is the event the preprocessor WORKER broadcasts when it has
          // finished computing and persisting all calibration artifacts to IDB.
          // (Different from the postMessage 'calibration:ready' that the wrapper
          // uses internally — this is the BC broadcast, which main.js sees.)
          //
          // Three things must happen here:
          // 1. notifyCalibrationComplete clears _calibrationPending so the
          //    stable-scene gate can open again on the next cycle.
          // 2. _nativeCalibComplete gates the native dispatch fallback.
          // 3. _lastCalibrationCompletedAt starts the 90s lockout that prevents
          //    flat_field_degradation from immediately triggering a second
          //    calibration before the first reconstruction has completed.
          if (msg && msg.event === 'calibration:ready') {
            const _calCameraId = this.cameraContainer?.cameraId ?? null;
            console.log('[calibration:ready] main.js:', {
              key:      msg.metaKey || msg.key || null,
              cameraId: _calCameraId
            });

            // Late-arm failsafe: ensure motionWorker exists even if camera-start
            // arming (Change B) was somehow skipped.
            if (!this._heavyPathRequested) {
              this._heavyPathRequested = true;
              try { this._ensureMotionWorker(); } catch (e) {
                console.warn('[calibration:ready] main.js: _ensureMotionWorker failed:', e);
              }
            }

            if (_calCameraId && this.motionDetector) {
              try {
                this.motionDetector.notifyCalibrationComplete(_calCameraId);
                console.log('[calibration:ready] main.js: notifyCalibrationComplete called for',
                            _calCameraId,
                            '— cycle closed, gate reopens on next spike or exposure change');
              } catch (e) {
                console.warn('[calibration:ready] main.js: notifyCalibrationComplete failed:', e);
              }

              // Unblock intent creation in MotionDetector. Idempotent — once true,
              // stays true for the lifetime of the detector instance. Must come
              // AFTER notifyCalibrationComplete so the per-camera stale/pending
              // flags are already cleared before the first post-calibration intent
              // is ever created.
              try {
                this.motionDetector.setCalibrationConfirmed(true);
              } catch (e) {
                console.warn('[calibration:ready] main.js: setCalibrationConfirmed failed:', e);
              }
            }

            // Arm native dispatch and start lockout timer.
            this._nativeCalibComplete        = true;
            this._lastCalibrationCompletedAt = Date.now();
            console.log('[Native flow] Post-calibration reconstruction dispatch armed.',
                        'Lockout active for', Math.round(this._calibrationLockoutMs / 1000), 's.');
          }

          // ── artifact:ready → MotionDetector + native dispatch ───────────────
          //
          // ORDERING IS CRITICAL: Step 1 before Step 2.
          //
          // Step 1 calls handleAnnularEvent(jobId) which calls _createIntent,
          // registering jobId → intentId in _intentsByJobId.
          //
          // Step 2 calls onArtifactReady(jobId, metaKey) which looks up the
          // intent by jobId, attaches metaKey, and calls _scheduleReconstruction
          // → _processQueue → requestReconstructionByMeta.
          //
          // If Step 2 runs first, _intentsByJobId is empty and it is a no-op.
          //
          // The native dispatch fallback runs AFTER both steps. It directly
          // calls requestReconstructionByMeta for every manifest (with cooldown)
          // once calibration is confirmed. This mirrors what the test script does
          // with forceDirectReconstruction(). It is needed because MotionDetector
          // spike detection may not fire reliably for all scene types: after EMA
          // warmup the adaptive threshold is mean + 3×std on normalized data,
          // which can exceed 1.0 (the maximum possible peak) for uniform scenes.
          if (msg && msg.event === 'artifact:ready' && msg.metaKey && msg.jobId) {
            const _arMeta = msg.meta ?? {};

            // Step 1 — annular data into MotionDetector intent system.
            // annular is now present in msg.meta (Change A in preprocessor.worker.js).
            // Accept both Float32Array and plain Array (eviction hook uses Array.from).
            if (_arMeta.annular && _arMeta.annular.length > 0 && this.motionDetector) {
              try {
                this.motionDetector.handleAnnularEvent({
                  annular:   Float32Array.from(_arMeta.annular),
                  meta: {
                    jobId:    msg.jobId,
                    cameraId: _arMeta.cameraId || this.cameraContainer?.cameraId || 'default',
                    width:    _arMeta.width  ?? null,
                    height:   _arMeta.height ?? null
                  },
                  avgLuma:   typeof _arMeta.avgLuma === 'number' ? _arMeta.avgLuma : 0,
                  timestamp: _arMeta.captureTime ?? Date.now()
                });
              } catch (e) {
                // Non-fatal — Step 2 and native dispatch must still run.
                console.warn('[Dispatch] handleAnnularEvent error (non-fatal):', e);
              }
            }

            // Step 2 — attach metaKey to intent created in Step 1.
            // No _nativeCalibComplete guard needed here: MotionDetector refuses
            // to create intents before setCalibrationConfirmed(true) is called,
            // so _intentsByJobId will be empty for any pre-calibration jobId and
            // this lookup is a natural no-op. Keeping the gating logic in one
            // place (MotionDetector._calibrationConfirmed) avoids duplicating
            // "does this require calibration" knowledge across two files.
            if (this.motionDetector?.onArtifactReady) {
              try {
                this.motionDetector.onArtifactReady({
                  metaKey: msg.metaKey,
                  jobId:   msg.jobId,
                  meta:    _arMeta
                });
              } catch(e) {
                console.warn('[Dispatch] motionDetector.onArtifactReady error:', e);
              }
            }

            // ── Native dispatch fallback ─────────────────────────────────────
            // Runs once calibration is confirmed, with a cooldown to avoid
            // flooding motion.worker while a reconstruction is in progress.
            //
            // Guard: _manifestCalibKey must be present. The very first manifest
            // after calibration:ready may have been constructed before CALIB.metaKey
            // was set (Change A2 closes this for subsequent frames). If null, we
            // skip silently — the next manifest (milliseconds later) will have it.
            if (
              this._nativeCalibComplete &&
              this.motionWorker?.workerReady &&
              !this._nativeReconInFlight &&
              (Date.now() - this._nativeLastReconAt) >= this._nativeReconCooldownMs
            ) {
              const _nativeCameraId    = _arMeta.cameraId || this.cameraContainer?.cameraId || 'default';
              const _manifestCalibKey  = _arMeta.calibrationKey ?? null;

              if (!_manifestCalibKey) {
                // Manifest pre-dates calibration. Next frame will have it.
                // Do not consume the cooldown for a skip.
                console.log('[Native flow] Skipping — no calibrationKey yet (race window).');
              } else {
                this._nativeReconInFlight = true;
                this._nativeLastReconAt   = Date.now();

                console.log('[Native flow] Dispatching reconstruction →', msg.metaKey, {
                  cameraId:       _nativeCameraId,
                  calibrationKey: _manifestCalibKey
                });

                this.motionWorker.requestReconstructionByMeta(
                  msg.metaKey,
                  {
                    reason:   'native-continuous',
                    priority: 50,
                    reqId:    msg.jobId,
                    cameraId: _nativeCameraId,
                    // Pass calibrationKey from the BC artifact:ready message directly
                    // into the job payload. The BC message reads CALIB.metaKey from
                    // readyData which is constructed AFTER all persist awaits —
                    // reliably after CALIB.metaKey is set even under quota pressure.
                    // This bypasses the IDB manifest race where manifest.data.calibrationKey
                    // was written to IDB before CALIB.metaKey was set in preprocessor.worker.
                    calibrationKey: _manifestCalibKey
                  }
                ).then(() => {
                  this._nativeReconInFlight = false;
                  console.log('[Native flow] Reconstruction resolved for', msg.metaKey);
                }).catch((err) => {
                  this._nativeReconInFlight = false;
                  console.warn('[Native flow] Reconstruction failed (will retry next manifest):', err.message);
                });
              }
            }
          }
          // --- End Stage 0–4 RECON_DONE handler ---
          // ── TOPOLOGY_DONE handler ──────────────────────────────────────────
          if (msg && msg.event === 'TOPOLOGY_DONE') {
            const topoMetaKey = msg.metaKey;
            if (!topoMetaKey) return;

            // Hold transiently — forwarded to minimizer.worker now and to
            // ambi.worker when MINIMIZER_DONE arrives, then nulled immediately.
            this._pendingTopoInline = msg.topoInline ?? null;

            // Fanout 1: minimizer.worker needs componentMap to run Phase B
            if (this._minimizerWorker && msg.topoInline) {
              try {
                this._minimizerWorker.postMessage({
                  op:         'TOPOLOGY_DONE',
                  metaKey:    msg.metaKey,
                  topoInline: msg.topoInline,
                  betti:      msg.betti    ?? null,
                  endCount:   msg.endCount ?? null
                });
              } catch (e) {
                console.warn('[Stage4B] main.js: failed to forward TOPOLOGY_DONE to minimizer.worker', e);
              }
            }

            // Write only lightweight metadata to cameraContainer — no typed arrays.
            // Clear stage4b so stale minimizer data from a prior frame cannot
            // trigger _checkStage4Complete prematurely on this new topology result.
            if (this.cameraContainer) {
              try {
                this._updateCameraContainer({
                  passThrough: {
                    stage4b: null,
                    stage4a: {
                      betti:       msg.betti    ?? null,
                      endCount:    msg.endCount ?? null,
                      completedAt: Date.now()
                    }
                  }
                });
                this._checkStage4Complete(topoMetaKey);
                console.log('[Stage4A] main.js: TOPOLOGY_DONE processed', {
                  topoMetaKey,
                  endCount: msg.endCount,
                  betti:    msg.betti
                });
              } catch (e) {
                console.warn('[Stage4A] main.js: TOPOLOGY_DONE writeback failed', e);
              }
            }
            // ── Artifact upload: Stage 4A topology fields ─────────────────
            // Placed after all pipeline logic. Isolated try/catch — a failure
            // here cannot affect the return or any subsequent handler.
            // Field names confirmed from pipeline logs:
            //   msg.topoInline.topologyMap  → Int32Array, 262144 (512²)
            //   msg.topoInline.componentMap → Int32Array, 262144 (512²)
            //   msg.topoInline.topoResolution → 512
            try {
              if (this.artifactRenderer && msg.topoInline) {
                const topoRes = msg.topoInline.topoResolution ?? 512;
                if (msg.topoInline.topologyMap) {
                  this.artifactRenderer.uploadLabel(
                    'topologyMap',
                    msg.topoInline.topologyMap,
                    topoRes, topoRes
                  );
                }
                if (msg.topoInline.componentMap) {
                  this.artifactRenderer.uploadLabel(
                    'componentMap',
                    msg.topoInline.componentMap,
                    topoRes, topoRes
                  );
                }
              }
            } catch (arErr) {
              console.warn('[ArtifactRenderer] TOPOLOGY_DONE upload failed (non-fatal):', arErr);
            }

            return;
          }

          // ── MINIMIZER_DONE handler ──────────────────────────────────────
          if (msg && msg.event === 'MINIMIZER_DONE') {
            const miniMetaKey = msg.metaKey;
            if (!miniMetaKey) return;

            // Hold transiently — forwarded to ambi.worker in _checkStage4Complete, then nulled.
            this._pendingMinimizerInline = msg.minimizerInline ?? null;

            // Write only lightweight metadata to cameraContainer — no typed arrays
            if (this.cameraContainer) {
              try {
                this._updateCameraContainer({
                  passThrough: {
                    stage4b: {
                      converged:          msg.converged          ?? false,
                      stopReason:         msg.stopReason         ?? null,
                      targetArea:         msg.targetArea         ?? null,
                      finalArea:          msg.finalArea          ?? null,
                      topologyConsistent: msg.topologyConsistent ?? false,
                      completedAt:        Date.now()
                    }
                  }
                });
                this._checkStage4Complete(miniMetaKey);
                console.log('[Stage4B] main.js: MINIMIZER_DONE processed', {
                  miniMetaKey,
                  converged:          msg.converged,
                  topologyConsistent: msg.topologyConsistent,
                  stopReason:         msg.stopReason
                });
              } catch (e) {
                console.warn('[Stage4B] main.js: MINIMIZER_DONE writeback failed', e);
              }
            }
            // ── Artifact upload: phiMin ───────────────────────────────────
            // Field name confirmed from kem.worker.js log:
            //   msg.minimizerInline.phiMin → Float32Array, 1048576 (1024²)
            //   (phiMin is at minimizerResolution = 1024², not topoResolution)
            try {
              if (this.artifactRenderer && msg.minimizerInline?.phiMin) {
                const phi     = msg.minimizerInline.phiMin;
                const phiSide = Math.round(Math.sqrt(phi.length));
                this.artifactRenderer.uploadScalar(
                  'phiMin', phi, phiSide, phiSide
                );
              }
            } catch (arErr) {
              console.warn('[ArtifactRenderer] MINIMIZER_DONE upload failed (non-fatal):', arErr);
            }

            // ── Artifact upload: Stage 5 warp and world frame fields ──────
            // Field names confirmed from correspondence.worker.js log:
            //   msg.warpFieldInline.field    → Float32Array, 524288 (512²×2, interleaved r,θ)
            //   msg.worldFrameMapInline.map  → Int32Array,   262144 (512²)
            try {
              if (this.artifactRenderer) {
                const ambiRes = this.cameraContainer?.stage67Inputs?._topoResolution ?? 512;
                if (msg.warpFieldInline?.field) {
                  this.artifactRenderer.uploadFlowInterleaved(
                    'warpField',
                    msg.warpFieldInline.field,
                    ambiRes, ambiRes
                  );
                }
                if (msg.worldFrameMapInline?.map) {
                  this.artifactRenderer.uploadLabel(
                    'worldFrameMap',
                    msg.worldFrameMapInline.map,
                    ambiRes, ambiRes
                  );
                }
              }
            } catch (arErr) {
              console.warn('[ArtifactRenderer] AMBI_DONE upload failed (non-fatal):', arErr);
            }

            return;
          }
          // ── AMBI_REFINED handler (Stage 5 — post Stage 6 refinement) ──
          if (msg && msg.event === 'AMBI_DONE') {
            const ambiMetaKey = msg.metaKey;
            if (!ambiMetaKey || !this.cameraContainer) return;
            try {
              // Write stage5 artifact keys + proxy motion values via passThrough.
              // meanMotionMagnitude and meanLQESpeed are stored here so
              // KEM_ANALYZE can pass them to kem.worker for AMBI_REFINE residuals.
              this._updateCameraContainer({
                passThrough: {
                  stage5: {
                    worldFrameMapKey:      msg.worldFrameMapKey      ?? null,
                    warpFieldKey:          msg.warpFieldKey          ?? null,
                    integrationWeightsKey: msg.integrationWeightsKey ?? null,
                    surfaceParamKey:       msg.surfaceParamKey       ?? null,
                    degradedMode:          msg.degradedMode          ?? false,
                    isKeyframe:            msg.isKeyframe            ?? false,
                    meanMotionMagnitude:   msg.meanMotionMagnitude   ?? null,
                    meanLQESpeed:          msg.meanLQESpeed          ?? null,
                    completedAt:           Date.now()
                  }
                }
              });
              if (msg.containerUpdate?.ambiFrame) {
                this._updateCameraContainer({
                  ambiFrame: msg.containerUpdate.ambiFrame
                });
              }

              // ── Cache ambi inline outputs for Stage 6/7 dispatch ──────────
              if (msg.warpFieldInline || msg.worldFrameMapInline) {
                try {
                  this._updateCameraContainer({
                    passThrough: {
                      stage5Inline: {
                        warpFieldInline:          msg.warpFieldInline          ?? null,
                        worldFrameMapInline:      msg.worldFrameMapInline      ?? null,
                        integrationWeightsInline: msg.integrationWeightsInline ?? null,
                        surfaceParamInline:       msg.surfaceParamInline       ?? null
                      }
                    }
                  });
                  console.log('[Stage5] main.js: stage5Inline stored on cameraContainer:', {
                    hasWarpField:        !!msg.warpFieldInline,
                    hasWorldFrameMap:    !!msg.worldFrameMapInline,
                    hasSurfaceParam:     !!msg.surfaceParamInline,
                    warpFieldLength:     msg.warpFieldInline?.field?.length ?? 0,
                    worldFrameMapLength: msg.worldFrameMapInline?.map?.length ?? 0
                  });
                } catch (e) {
                  console.warn('[Stage5] main.js: stage5Inline writeback failed', e);
                }
              }

              // ── Reset stage 678 state and dispatch Stages 6 + 7 ──────────
              const cc = this.cameraContainer;
              this._stage678State = {
                metaKey:            ambiMetaKey,
                kemDone:            false,
                correspondenceDone: false,
                ambiRefined:        false
              };

              // Stage 6 — KEM
              if (this._kemWorker) {
                try {
                  this._kemWorker.postMessage({
                    op:       'KEM_ANALYZE',
                    jobId:    `kem:${ambiMetaKey}:${Date.now()}`,
                    metaKey:  ambiMetaKey,
                    cameraId: cc.cameraId ?? 'default',
                    flags:    this._currentFlags ?? {},
                    meanMotionMagnitude: cc.stage5?.meanMotionMagnitude ?? null,
                    meanLQESpeed:        cc.stage5?.meanLQESpeed        ?? null,
                    // ── Inline data — eliminates all KEM IDB reads ────────────
                    // principalE1/E2 and flow are at reconstructionResolution (1024²).
                    // kem.worker detects source resolution and downsamples each
                    // input to topoResolution before computing KEMModule.
                    principalFrameInline: cc.dgInline
                      ? { e1: cc.dgInline.principalE1 ?? null,
                          e2: cc.dgInline.principalE2 ?? null }
                      : null,
                    flowFieldInline:    cc.flowFieldInline                    ?? null,
                    motionMapsInline:   cc.stage67Inputs?.motionMaps          ?? null,
                    coherenceInline:    (cc.directionalFieldInline?.coherence instanceof Float32Array)
                                          ? cc.directionalFieldInline.coherence
                                          : (cc.directionalFieldInline?.coherence?.perPixel ?? null),
                    phiMinInline:       cc.stage67Inputs?.phiMin              ?? null,
                    surfaceParamInline: cc.stage5Inline?.surfaceParamInline   ?? null,
                    artifactKeys: {
                      // All null — data travels inline above
                      principalFrameKey:   null,
                      flowFieldKey:        null,
                      directionalFieldKey: null,
                      motionMapsKey:       null,
                      narrowBandKey:       null,
                      surfaceParamKey:     null,
                      // Must be topoResolution (512), NOT reconstructionResolution (1024).
                      // motionMaps (motionMagnitude, motionEndsMap) come from topology at 512².
                      // kem.worker uses this as the target N = resolution² for all arrays.
                      // principalFrame/flow/coherence are downsampled from 1024² → 512² inside kem.worker.
                      resolution: cc.stage67Inputs?._topoResolution ?? 512,
                      cameraId:   cc.cameraId ?? 'default'
                    }
                  });
                  console.log('[Stage6] main.js: KEM_ANALYZE dispatched', { metaKey: ambiMetaKey });
                } catch (kemErr) {
                  console.warn('[Stage6] main.js: kem.worker dispatch failed', kemErr);
                }
              }

              // Stage 7 — Correspondence (parallel with Stage 6)
              if (this._correspondenceWorker) {
                try {
                  this._correspondenceWorker.postMessage({
                    op:       'CORRESPONDENCE_ANALYZE',
                    jobId:    `corr:${ambiMetaKey}:${Date.now()}`,
                    metaKey:  ambiMetaKey,
                    cameraId: cc.cameraId ?? 'default',
                    flags:    this._currentFlags ?? {},
                    // ── Inline data — eliminates all Correspondence IDB reads ─
                    // warpField (512²×2), worldFrameMap (512²), topologyMap (512²)
                    // are all at topoResolution from ambi/topology. phiMinInline
                    // is at minimizerResolution (1024²) and is downsampled inside
                    // correspondence.worker to match resolution below.
                    warpFieldInline:     cc.stage5Inline?.warpFieldInline     ?? null,
                    worldFrameMapInline: cc.stage5Inline?.worldFrameMapInline ?? null,
                    primeEndsInline:     cc.stage67Inputs?.primeEnds          ?? null,
                    topologyMapInline:   cc.stage67Inputs?.topologyMap        ?? null,
                    phiMinInline:        cc.stage67Inputs?.phiMin             ?? null,
                    surfaceParamInline:  cc.stage5Inline?.surfaceParamInline  ?? null,
                    artifactKeys: {
                      // All null — data travels inline above
                      warpFieldKey:     null,
                      worldFrameMapKey: null,
                      surfaceParamKey:  null,
                      primeEndsKey:     null,
                      topologyMapKey:   null,
                      phiMinKey:        null,
                      // Must be topoResolution (512), NOT reconstructionResolution (1024).
                      // warpField, worldFrameMap, topologyMap and primeEnd anchor pixels
                      // are all in 512² coordinate space. correspondence.worker uses
                      // this to set N = resolution² and downsample phiMin to match.
                      resolution: cc.stage67Inputs?._topoResolution ?? 512,
                      cameraId:   cc.cameraId ?? 'default'
                    }
                  });
                  console.log('[Stage7] main.js: CORRESPONDENCE_ANALYZE dispatched', { metaKey: ambiMetaKey });
                } catch (corrErr) {
                  console.warn('[Stage7] main.js: correspondence.worker dispatch failed', corrErr);
                }
              }

              // ── Release large inline arrays now that KEM and Correspondence ─
              // have been dispatched via structured clone. These hold ~70MB of
              // typed arrays that are dead weight for the rest of the frame.
              // Clearing here allows GC to reclaim memory before the next
              // reconstruction cycle begins.
              try {
                this._updateCameraContainer({
                  passThrough: {
                    // Stage 3 inline — KEM consumed principalE1/E2, coherence, flowU/V
                    dgInline:               null,   // ~32MB (kH + e1/e2 + curls × 1024²)
                    directionalFieldInline: null,   // ~20MB (field + coherence × 1024²)
                    flowFieldInline:        null,   // ~8MB  (u + v × 1024²)
                    // Stage 4 fragments — KEM + Correspondence consumed phiMin,
                    // motionMaps, topologyMap, primeEnds
                    stage67Inputs:          null,   // ~7MB  (topologyMap + motionMaps + phiMin)
                    // Stage 5 outputs — Correspondence consumed warpField, worldFrameMap
                    stage5Inline:           null    // ~3MB  (warpField + worldFrameMap)
                  }
                });
                console.log('[Stage678] main.js: ~70MB of inline arrays released after KEM+Correspondence dispatch');
              } catch (e) {
                console.warn('[Stage678] main.js: failed to release inline arrays post-dispatch', e);
              }

              // STAGE5_DONE broadcast for any other BC consumers
              if (this._bc) {
                try {
                  this._bc.postMessage({
                    event:     'STAGE5_DONE',
                    metaKey:   ambiMetaKey,
                    stage5:    this.cameraContainer.stage5,
                    ambiFrame: this.cameraContainer.ambiFrame,
                    timestamp: Date.now()
                  });
                } catch (e) {
                  console.warn('[Stage5] main.js: STAGE5_DONE broadcast failed', e);
                }
              }
              console.log('[Stage5] main.js: AMBI_DONE processed — Stages 6+7 dispatched', {
                ambiMetaKey,
                degradedMode:    msg.degradedMode,
                isKeyframe:      msg.isKeyframe,
                legibilityScore: msg.containerUpdate?.ambiFrame?.legibilityScore
              });
            } catch (e) {
              console.warn('[Stage5] main.js: AMBI_DONE handler failed', e);
            }
            return;
          }

          // ── AMBI_REFINED handler (Stage 5 — post Stage 6 refinement) ──
          if (msg && msg.event === 'AMBI_REFINED') {
            if (!this.cameraContainer) return;
            try {
              if (msg.componentId) {
                this._updateCameraContainer({
                  ambiFrame: {
                    viewManifoldComponent: msg.componentId,
                    positionInManifold:    msg.positionInManifold ?? this.cameraContainer.ambiFrame?.positionInManifold
                  }
                });
              }
              console.log('[Stage5] main.js: AMBI_REFINED — view manifold refined', {
                cameraId:          msg.cameraId,
                componentId:       msg.componentId,
                motionMagResidual: msg.residuals?.motionMagResidual,
                lqeSpeedResidual:  msg.residuals?.lqeSpeedResidual
              });
            } catch (e) {
              console.warn('[Stage5] main.js: AMBI_REFINED writeback failed', e);
            }
            if (this._stage678State) {
              this._stage678State.ambiRefined = true;
              this._checkStage678Complete();
            }
            return;
          }
          

          // ── KEM_DONE handler (Stage 6) ─────────────────────────────────
          if (msg && msg.event === 'KEM_DONE') {
            const kemMetaKey = msg.metaKey;
            if (!kemMetaKey || !this.cameraContainer) return;
            try {
              this._updateCameraContainer({
                passThrough: {
                  stage6: {
                    kemMapKey:           msg.kemMapKey           ?? null,
                    cladeMapKey:         msg.cladeMapKey         ?? null,
                    tensionFieldKey:     msg.tensionFieldKey     ?? null,
                    velocityManifoldKey: msg.velocityManifoldKey ?? null,
                    kemSummaryKey:       msg.kemSummaryKey       ?? null,
                    meanKEM:             msg.meanKEM             ?? null,
                    cladeCount:          msg.cladeCount          ?? 0,
                    completedAt:         Date.now()
                  }
                }
              });
              console.log('[Stage6] main.js: KEM_DONE written', {
                kemMetaKey,
                meanKEM:    msg.meanKEM,
                cladeCount: msg.cladeCount
              });
            } catch (e) {
              console.warn('[Stage6] main.js: KEM_DONE writeback failed', e);
            }
            if (this._stage678State) {
              this._stage678State.kemDone = true;
              this._checkStage678Complete();
            }
            return;
          }

          // ── CORRESPONDENCE_DONE handler (Stage 7) ──────────────────────
          if (msg && msg.event === 'CORRESPONDENCE_DONE') {
            const corrMetaKey = msg.metaKey;
            if (!corrMetaKey || !this.cameraContainer) return;
            try {
              this._updateCameraContainer({
                passThrough: {
                  stage7: {
                    correspondenceMapKey:       msg.correspondenceMapKey       ?? null,
                    confidenceMapKey:           msg.confidenceMapKey           ?? null,
                    bilateralConsistencyMapKey: msg.bilateralConsistencyMapKey ?? null,
                    correspondenceSummaryKey:   msg.correspondenceSummaryKey   ?? null,
                    symmetryMismatchScore:      msg.symmetryMismatchScore      ?? null,
                    geometricAsymmetry:         msg.geometricAsymmetry         ?? null,
                    reconstructionConsistency:  msg.reconstructionConsistency  ?? null,
                    symmetryAxisAngle:          msg.symmetryAxisAngle          ?? null,
                    unmatchedFraction:          msg.unmatchedFraction          ?? null,
                    unreliableScore:            msg.unreliableScore            ?? false,
                    completedAt:                Date.now()
                  }
                }
              });
              console.log('[Stage7] main.js: CORRESPONDENCE_DONE written', {
                corrMetaKey,
                symmetryMismatchScore: msg.symmetryMismatchScore,
                unmatchedFraction:     msg.unmatchedFraction
              });
            } catch (e) {
              console.warn('[Stage7] main.js: CORRESPONDENCE_DONE writeback failed', e);
            }
            if (this._stage678State) {
              this._stage678State.correspondenceDone = true;
              this._checkStage678Complete();
            }
            return;
          }
        });
      } catch (e) {
        console.warn('Main: failed to create BroadcastChannel for orchestration', e);
        this._bc = null;
      }

      // Set up MotionDetector -> Main calibration orchestration (main only orchestrates; it won't store artifacts)
      this.setupCalibrationOrchestration();

      // ============================================================================
      // ✅ NEW: Periodic MotionDetector metrics persistence (debug mode only)
      // ============================================================================
      /**
       * Timer that persists MotionDetector metrics every 10 seconds when debug flag enabled
       * 
       * Lifecycle:
       * - Started if persistDebugArtifacts is initially true
       * - Stopped/started dynamically when flag changes (handled by subscription above)
       * - Stopped on page unload (see beforeunload handler below)
       * 
       * Storage impact: ~15KB every 10s = ~90KB/min = ~5.4MB/hour
       */
      this._metricsTimer = null;
      
      const startMetricsTimer = () => {
        if (this._metricsTimer) {
          return; // Already running
        }
        
        this._metricsTimer = setInterval(() => {
          // Double-check flag is still enabled (defensive)
          if (this.motionDetector && this.motionDetector._persistDebugArtifacts) {
            this.motionDetector.persistMetrics().catch(err => {
              console.warn('main.js: Metrics persistence failed (non-fatal)', err);
            });
          } else {
            // Flag was disabled - stop timer
            if (this._metricsTimer) {
              clearInterval(this._metricsTimer);
              this._metricsTimer = null;
              console.log('main.js: Metrics timer stopped (debug flag disabled)');
            }
          }
        }, 10000); // Every 10 seconds
        
        console.log('main.js: Metrics timer started (10s interval)');
      };
      
      const stopMetricsTimer = () => {
        if (this._metricsTimer) {
          clearInterval(this._metricsTimer);
          this._metricsTimer = null;
          console.log('main.js: Metrics timer stopped');
        }
      };
      
      // Start immediately if debug flag is enabled
      try {
        if (featureFlags.getFlag('persistDebugArtifacts')) {
          startMetricsTimer();
        }
      } catch (e) {
        console.warn('main.js: Failed to check initial persistDebugArtifacts flag', e);
      }
      
      // Store references for later use (cleanup + dynamic start/stop)
      this._startMetricsTimer = startMetricsTimer;
      this._stopMetricsTimer = stopMetricsTimer;

      // Update UI with initial buffer info and hardware limitations
      this.updateBufferSizeDisplay();
      this.displayHardwareLimitations();
      
      console.log('Motion Painter initialized successfully');
      console.log('Hardware capabilities:', this.hardwareLimitations);
      console.log('Buffer configuration:', this.frameBuffer.getBufferInfo());
      
      // Show hardware warnings if any
      if (this.hardwareLimitations && this.hardwareLimitations.validation) {
        const validation = this.hardwareLimitations.validation;
        
        // Check if validation has issues array with warnings
        if (validation.issues && validation.issues.length > 0) {
          const warnings = validation.issues
            .filter(issue => issue.type === 'warning')
            .map(issue => issue.message);
          
          warnings.forEach(warning => {
            console.warn('Hardware limitation:', warning);
          });
        }
      }
      
      // NOTE: main intentionally exposes no calibration helpers — preprocessor and MotionWorker are the canonical actors.
      
    } catch (error) {
      console.error('Failed to initialize Motion Painter:', error);
      alert('Initialization failed: ' + error.message);
    }
  }
  
  setupEventHandlers() {
    // Controls event handlers
    this.controls.on('paramChange', (data) => {
      this.handleParamChange(data);
    });
    
    this.controls.on('action', (data) => {
      this.handleAction(data.action);
    });
    
    // Media input ready callback
    this.mediaInput.onSourceReady = () => {
      this.startRendering();
    };
    
    // Window resize handler
    window.addEventListener('resize', () => {
      if (this.isRendering) {
        this.resizeCanvas();
      }
    });
    
    // Visibility change handler (pause when tab hidden)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.isRendering) {
        this.pauseRendering();
      } else if (!document.hidden && this.isRendering && !this.isPaused) {
        this.resumeRendering();
      }
    });
  }
  
  handleParamChange(data) {
    const { param, value, allParams } = data;
    
    // Handle special buffer-related parameters
    if (param === 'bufferSize') {
      this.updateBufferSize(value);
      return;
    }
    
    if (param === 'spiralRetention') {
      this.frameBuffer.setSpiralRetention(value);
      return;
    }
    
    if (param === 'reset') {
      // Handle full parameter reset - validate all time-based params
      const validatedParams = this.validateTemporalParameters(allParams);
      this.compositeRenderer.updateParams(validatedParams);
      this.updateBufferSizeDisplay();
      return;
    }
    
    // Handle regular parameter updates with validation for time-based params
    const updatedParams = this.validateTemporalParameters({ [param]: value });
    this.compositeRenderer.updateParams(updatedParams);
  }
  
  /**
   * Validate temporal parameters against current buffer size
   */
  validateTemporalParameters(params) {
    const bufferSize = this.frameBuffer.bufferSize;
    const maxOffset = bufferSize - 1;
    const validatedParams = { ...params };
    
    // Clamp time-based parameters
    if ('timeShift' in validatedParams) {
      validatedParams.timeShift = Math.min(validatedParams.timeShift, maxOffset);
    }
    if ('rOff' in validatedParams) {
      validatedParams.rOff = Math.min(validatedParams.rOff, maxOffset);
    }
    if ('gOff' in validatedParams) {
      validatedParams.gOff = Math.min(validatedParams.gOff, maxOffset);
    }
    if ('bOff' in validatedParams) {
      validatedParams.bOff = Math.min(validatedParams.bOff, maxOffset);
    }
    
    return validatedParams;
  }
  
  updateBufferSize(newSize) {
    try {
      const oldSize = this.frameBuffer.bufferSize;
      
      // Validate against hardware limits
      const validation = validateBufferSize(newSize);
      const targetSize = validation.clampedSize;
      
      // Show validation warnings
      if (validation.warning) {
        console.warn(validation.warning);
        this.controls.updateStatus(validation.warning);
      }
      
      // Update buffer size
      this.frameBuffer.setBufferSize(targetSize);
      this.webglRenderer.updateBufferSize(targetSize);
      this.compositeRenderer.updateParams({ bufferSize: targetSize });
      
      // Update UI display
      this.updateBufferSizeDisplay();
      
      // If we're currently rendering, reinitialize with current frame
      if (this.isRendering && this.mediaInput.isVideoReady()) {
        this.frameBuffer.initializeWithFrame(this.video);
      }
      
      console.log(`Buffer size updated: ${oldSize} → ${targetSize}${targetSize !== newSize ? ` (requested ${newSize})` : ''}`);
      
      // Show performance warnings if needed
      const suggestions = this.compositeRenderer.getOptimizationSuggestions();
      suggestions.forEach(suggestion => {
        if (suggestion.type === 'warning') {
          console.warn(suggestion.message);
          this.controls.updateStatus(suggestion.message);
        }
      });
      
    } catch (error) {
      console.error('Failed to update buffer size:', error);
      this.controls.updateStatus('Buffer resize failed: ' + error.message);
    }
  }
  
updateBufferSizeDisplay() {
  const bufferInfo = this.frameBuffer.getBufferInfo();
  
  // Update max values for time-based controls
  const maxOffset = bufferInfo.bufferSize - 1;
  
  // FIXED: Handle missing DOM elements gracefully
  const maxBufferSizeElement = document.getElementById('maxBufferSize');
  if (maxBufferSizeElement) {
    maxBufferSizeElement.textContent = `${bufferInfo.bufferSize} (max: ${CONFIG.MAX_BUFFER_SIZE})`;
  } else {
    // Alternative: Update status instead if maxBufferSize element doesn't exist
    console.log(`Buffer size: ${bufferInfo.bufferSize} (max: ${CONFIG.MAX_BUFFER_SIZE})`);
  }
  
  // Update range control limits and current values - with bounds checking
  const timeShiftElement = document.getElementById('timeShift');
  if (timeShiftElement) {
    timeShiftElement.max = maxOffset;
    // FIXED: Ensure current value doesn't exceed new max
    const currentValue = parseInt(timeShiftElement.value) || 0;
    timeShiftElement.value = Math.min(currentValue, maxOffset);
  }
  
  // FIXED: Update color offset controls with proper bounds
  ['rOff', 'gOff', 'bOff'].forEach(id => {
    const element = document.getElementById(id);
    if (element) {
      element.max = maxOffset;
      const currentValue = parseInt(element.value) || 0;
      element.value = Math.min(currentValue, maxOffset);
      
      // Update display value if it exists
      const displayElement = document.getElementById(id.replace('Off', 'Val'));
      if (displayElement) {
        displayElement.textContent = element.value;
      }
    }
  });
  
  // Update buffer size slider if it exists
  const bufferSizeElement = document.getElementById('bufferSize');
  if (bufferSizeElement) {
    bufferSizeElement.max = CONFIG.MAX_BUFFER_SIZE; // Ensure this is 16
    bufferSizeElement.value = bufferInfo.bufferSize;
  }
  
  // Update memory usage display
  if (this.controls) {
    this.controls.updateBufferInfo();
  }
  
  // ADDED: Log current buffer configuration for debugging
  console.log('Buffer configuration updated:', {
    bufferSize: bufferInfo.bufferSize,
    maxOffset: maxOffset,
    spiralRetention: bufferInfo.useSpiralRetention,
    hardwareLimited: bufferInfo.hardwareLimits?.isHardwareLimited
  });
}
  
/**
 * Display hardware limitations to user - FIXED VERSION
 */
displayHardwareLimitations() {
  if (!this.hardwareLimitations) return;
  
  // FIXED: Use 'validation' instead of 'hardwareValidation'
  const validation = this.hardwareLimitations.validation;
  
  // Check if validation exists and has the expected structure
  if (!validation) {
    console.warn('Hardware validation data not available');
    return;
  }
  
  // Update hardware info display if elements exist
  const hardwareInfoElement = document.getElementById('hardwareInfo');
  if (hardwareInfoElement) {
    hardwareInfoElement.innerHTML = `
      <strong>Hardware:</strong> ${this.hardwareLimitations.renderer}<br>
      <strong>Max Texture Units:</strong> ${this.hardwareLimitations.maxTextureUnits}<br>
      <strong>Max Buffer Size:</strong> ${this.hardwareLimitations.maxBufferSize}
    `;
  }
  
  // Show warnings in status - check if issues exist and have warnings
  if (validation.issues && validation.issues.length > 0) {
    const warnings = validation.issues
      .filter(issue => issue.type === 'warning')
      .map(issue => issue.message);
    
    if (warnings.length > 0) {
      const warningMessage = warnings.join('; ');
      if (this.controls) {
        this.controls.updateStatus(warningMessage);
      }
    }
  }
}
  
  async handleAction(action) {
    switch (action) {
      case 'startCamera':
        await this.mediaInput.startCamera();
        break;
        
      case 'loadVideo':
        await this.mediaInput.loadSampleVideo();
        break;
        
      case 'togglePause':
        this.togglePause();
        break;
        
      case 'toggleMotionMask':
        this.toggleMotionMask();
        break;
        
      case 'resetToOptimal':
        this.resetToOptimalSettings();
        break;

      case 'viewportResize':
        // Handle viewport size changes
        if (this.isRendering) {
          this.resizeCanvas();
        }
        break;
        
      default:
        console.warn('Unknown action:', action);
    }
  }
  
  /**
   * Reset to optimal settings based on current hardware
   */
  resetToOptimalSettings() {
    const optimalSize = this.webglRenderer.getOptimalBufferSize();
    this.updateBufferSize(optimalSize);
    
    // Reset other parameters to defaults
    const defaultParams = {
      bufferSize: optimalSize,
      spiralRetention: true,
      timeShift: 1,
      opacity: CONFIG.DEFAULT_OPACITY,
      invert: true,
      rOff: Math.min(1, optimalSize - 1),
      gOff: Math.min(2, optimalSize - 1),
      bOff: Math.min(3, optimalSize - 1),
      motionThresh: CONFIG.MOTION_THRESHOLD,
      glow: CONFIG.GLOW_INTENSITY
    };
    
    this.compositeRenderer.updateParams(defaultParams);
    this.controls.updateFromParams(defaultParams);
    this.updateBufferSizeDisplay();
    
    console.log('Reset to optimal settings:', defaultParams);
  }
  
  startRendering() {
    if (this.isRendering) {
      this.stopRendering();
    }
    
    // Resize canvas to match video
    this.resizeCanvas();
    
    // Initialize frame buffer with first video frame
    this.compositeRenderer.initializeBuffer(this.video);
    
    // Start render loop
    this.isRendering = true;
    this.isPaused = false;
    this.renderLoop();
    
    const bufferInfo = this.frameBuffer.getBufferInfo();
    console.log('Rendering started with buffer configuration:', bufferInfo);
    
    // Update status
    this.controls.updateStatus(`Rendering started (${bufferInfo.bufferSize} frame buffer)`);
  }
  
  stopRendering() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    
    this.isRendering = false;
    this.isPaused = false;
    
    console.log('Rendering stopped');
    this.controls.updateStatus('Rendering stopped');
  }
  
  togglePause() {
    this.isPaused = !this.isPaused;
    this.controls.updatePauseButton(this.isPaused);
    
    if (!this.isPaused && this.isRendering) {
      this.renderLoop();
    }
    
    this.controls.updateStatus(this.isPaused ? 'Rendering paused' : 'Rendering resumed');
  }
  
  pauseRendering() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }
  
  resumeRendering() {
    if (this.isRendering && !this.isPaused) {
      this.renderLoop();
    }
  }
  
  toggleMotionMask() {
    const currentState = this.compositeRenderer.showMotionMask;
    this.compositeRenderer.setShowMotionMask(!currentState);
    this.controls.updateMotionButton(!currentState);
    
    this.controls.updateStatus(`Motion mask ${!currentState ? 'enabled' : 'disabled'}`);
  }
  
  resizeCanvas() {
    if (!this.video || !this.mediaInput.isVideoReady()) {
      return;
    }

    // Get current viewport configuration
    const viewportConfig = this.controls.getViewportConfiguration();

    // Calculate canvas size based on viewport settings and video aspect ratio
    const videoAspectRatio = this.video.videoWidth / this.video.videoHeight;
    const canvasPanel = document.querySelector('.canvas-panel');

    if (!canvasPanel) {
      // Fallback to original resize behavior but use drawing-buffer sizes
      const sizes = this.webglRenderer.resizeCanvas(this.video);

      // Prefer the video's native pixel resolution for the frame array texture
      const fbWidth  = (this.video && this.video.videoWidth)  ? this.video.videoWidth  : sizes.drawingWidth;
      const fbHeight = (this.video && this.video.videoHeight) ? this.video.videoHeight : sizes.drawingHeight;

      this.frameBuffer.resize(fbWidth, fbHeight);
      this.controls.updateBufferInfo(fbWidth, fbHeight);
      console.log(`Canvas resized to ${sizes.drawingWidth}x${sizes.drawingHeight} (fallback). FrameBuffer allocated at ${fbWidth}x${fbHeight}`); 
      return;
    }

    // Get available space in canvas panel
    const panelRect = canvasPanel.getBoundingClientRect();
    console.log('panelRect', panelRect, 'videoAspect', videoAspectRatio, 'viewport', viewportConfig);
    const availableWidth = panelRect.width - 16; // Account for padding
    const availableHeight = panelRect.height - 16;

    let targetWidth, targetHeight;

    // Calculate target size based on viewport mode
    switch (viewportConfig.size) {
      case 'small':
        targetWidth = Math.min(640, availableWidth);
        targetHeight = targetWidth / videoAspectRatio;
        if (targetHeight > Math.min(480, availableHeight)) {
          targetHeight = Math.min(480, availableHeight);
          targetWidth = targetHeight * videoAspectRatio;
        }
        break;

      case 'medium':
        targetWidth = Math.min(800, availableWidth);
        targetHeight = targetWidth / videoAspectRatio;
        if (targetHeight > Math.min(600, availableHeight)) {
          targetHeight = Math.min(600, availableHeight);
          targetWidth = targetHeight * videoAspectRatio;
        }
        break;

      case 'large':
        targetWidth = Math.min(1200, availableWidth);
        targetHeight = targetWidth / videoAspectRatio;
        if (targetHeight > Math.min(900, availableHeight)) {
          targetHeight = Math.min(900, availableHeight);
          targetWidth = targetHeight * videoAspectRatio;
        }
        break;

      case 'fullscreen':
        targetWidth = window.innerWidth;
        targetHeight = window.innerHeight;
        // Maintain aspect ratio
        const screenAspectRatio = targetWidth / targetHeight;
        if (videoAspectRatio > screenAspectRatio) {
          targetHeight = targetWidth / videoAspectRatio;
        } else {
          targetWidth = targetHeight * videoAspectRatio;
        }
        break;

      case 'fit':
      default:
        // Fit to available space while maintaining aspect ratio
        targetWidth = availableWidth;
        targetHeight = targetWidth / videoAspectRatio;
        if (targetHeight > availableHeight) {
          targetHeight = availableHeight;
          targetWidth = targetHeight * videoAspectRatio;
        }
        break;
    }

    // Ensure minimum sizes
    targetWidth = Math.max(320, Math.floor(targetWidth));
    targetHeight = Math.max(240, Math.floor(targetHeight));

    // Store video dimensions for buffer memory calculations
    this.controls.videoWidth = targetWidth;
    this.controls.videoHeight = targetHeight;

  // Ask renderer to compute drawing sizes (canvas sized to target)
    const sizes = this.webglRenderer.resizeCanvas(this.video, targetWidth, targetHeight);

  // keep debug copy
    this.webglRenderer.lastResizeResult = sizes;

  // --- Use the VIDEO native pixel size for the FrameBuffer texture where possible ---
    const fbWidth  = (this.video && this.video.videoWidth)  ? this.video.videoWidth  : sizes.drawingWidth;
    const fbHeight = (this.video && this.video.videoHeight) ? this.video.videoHeight : sizes.drawingHeight;

    this.frameBuffer.resize(fbWidth, fbHeight);
    this.controls.updateBufferInfo(fbWidth, fbHeight);

    console.log(`Canvas resized to ${sizes.drawingWidth}x${sizes.drawingHeight} (${viewportConfig.size} mode). FrameBuffer allocated at ${fbWidth}x${fbHeight} (video native preferred).`);
  }
  
  // main.js (MotionPainter) — updated renderLoop to await processFrame
  async renderLoop() {
    if (!this.isRendering) {
      return;
    }

    if (!this.isPaused && this.mediaInput.isVideoReady()) {
      try {
        // Await processing of current video frame (upload + buffer management + render).
        // After this call the temporal composite is on the default framebuffer.
        await this.compositeRenderer.processFrame(this.video);

        // Render the active pipeline artifact AFTER the composite is on screen.
        // If no artifact is active this is a complete no-op.
        // A thrown error here must NOT stop the camera composite from rendering
        // on the next frame, hence the isolated try/catch.
        if (this.artifactRenderer && this.artifactRenderer.hasActive()) {
          try {
            this.artifactRenderer.renderActiveIfAny();
          } catch (arErr) {
            console.warn('[ArtifactRenderer] renderActiveIfAny error (non-fatal):', arErr);
          }
        }

      } catch (error) {
        console.error('Render error:', error);
        this.controls.updateStatus('Render error: ' + error.message);
        this.stopRendering();
        return;
      }
    }

    // Schedule next frame
    this.animationId = requestAnimationFrame(() => this.renderLoop());
  }
  
  /**
   * Get memory usage information
   */
  getMemoryUsage() {
    if (!this.frameBuffer || !this.frameBuffer.width || !this.frameBuffer.height) {
      return null;
    }
    
    const bufferInfo = this.frameBuffer.getBufferInfo();
    const bytesPerPixel = 4; // RGBA
    const bytesPerFrame = bufferInfo.dimensions.width * bufferInfo.dimensions.height * bytesPerPixel;
    const totalBytes = bytesPerFrame * bufferInfo.bufferSize;
    
    return {
      bufferSize: bufferInfo.bufferSize,
      dimensions: bufferInfo.dimensions,
      bytesPerFrame,
      totalBytes,
      totalMB: Math.round(totalBytes / (1024 * 1024) * 100) / 100,
      hardwareLimited: bufferInfo.hardwareLimits?.isHardwareLimited || false
    };
  }
  
  /**
   * Get comprehensive application statistics including hardware info
   */
  getApplicationStats() {
    if (!this.compositeRenderer) {
      return null;
    }
    
    return {
      rendering: {
        isRendering: this.isRendering,
        isPaused: this.isPaused
      },
      mediaInput: this.mediaInput.getVideoInfo(),
      compositeRenderer: this.compositeRenderer.getStats(),
      bufferConfiguration: this.compositeRenderer.getBufferConfiguration(),
      optimizationSuggestions: this.compositeRenderer.getOptimizationSuggestions(),
      hardwareLimitations: this.hardwareLimitations,
      memoryUsage: this.getMemoryUsage(),
      viewportConfiguration: this.controls.getViewportConfiguration(),
      preprocessorMetrics: this.preprocessor ? this.preprocessor.getMetrics() : null,
      processingCapacity: this.preprocessor ? this.preprocessor.getCapacityStatus() : 'unknown',
      // main intentionally does not store calibration artifacts; report wrapper's canonical metaKey if present
      calibrationMetaKey: this.preprocessor ? this.preprocessor.calibrationMetaKey : null,
      featureFlags: featureFlags.getFlags()
    };
  }
  
  /**
   * Export current frame for debugging/screenshots
   */
  exportCurrentFrame() {
    if (!this.compositeRenderer) {
      return null;
    }
    
    try {
      return this.compositeRenderer.exportFrame();
    } catch (error) {
      console.error('Failed to export frame:', error);
      return null;
    }
  }
  
  /**
   * Validate current configuration and provide recommendations
   */
  validateConfiguration() {
    const stats = this.getApplicationStats();
    if (!stats) {
      return { isValid: false, errors: ['Application not initialized'] };
    }
    
    const validation = {
      isValid: true,
      errors: [],
      warnings: [],
      recommendations: []
    };
    
    // Check hardware limitations
    const hardware = stats.hardwareLimitations.hardwareValidation;
    if (!hardware.isSupported) {
      validation.isValid = false;
      validation.errors.push('Hardware does not meet minimum requirements');
    }
    
    // Check memory usage
    if (stats.memoryUsage && stats.memoryUsage.totalMB > 100) {
      validation.warnings.push(`High memory usage: ${stats.memoryUsage.totalMB}MB`);
    }
    
    // Check buffer configuration
    const bufferConfig = stats.bufferConfiguration;
    if (bufferConfig.bufferSize < 8 && bufferConfig.useSpiralRetention) {
      validation.recommendations.push('Consider increasing buffer size for better spiral retention benefits');
    }
    
    // Add optimization suggestions
    stats.optimizationSuggestions.forEach(suggestion => {
      if (suggestion.type === 'warning') {
        validation.warnings.push(suggestion.message);
      } else if (suggestion.type === 'optimization') {
        validation.recommendations.push(suggestion.message);
      }
    });
    
    return validation;
  }

  // ------------------ Stage 0: container update protocol ------------------

  /**
   * _updateCameraContainer(updates)
   *
   * Immutably updates this.cameraContainer by spread-and-refreeze.
   * Only the three Stage 0 sub-objects can be updated via this path:
   * differentialGeometry, plenopticSampling, ambiFrame.
   *
   * Called by:
   *  - RECON_DONE BC handler (Stage 0) — reconstructionResolution + effectiveWindowMs
   *  - AmbiAnamorph result handler (Stage 5) — ambiFrame fields
   *  - Future: angularApertureSr inference (Stage 1+) — plenopticSampling.angularApertureSr
   *
   * @param {Object} updates - object with optional keys:
   *   differentialGeometry?: Partial<differentialGeometry>
   *   plenopticSampling?: Partial<plenopticSampling>
   *   ambiFrame?: Partial<ambiFrame>
   */
    _updateCameraContainer(updates = {}) {
    if (!this.cameraContainer) {
      console.warn('[Stage0] _updateCameraContainer: no cameraContainer to update');
      return;
    }

    const current = this.cameraContainer;

    // passThrough: arbitrary top-level keys that are spread directly onto the
    // container without any deep-merge treatment. Used for stage2/stage3/stage4
    // keys written back from RECON_DONE payloads.
    const { differentialGeometry, plenopticSampling, ambiFrame,
            passThrough = {}, ...rest } = updates;

    const merged = Object.freeze({
      ...current,
      // Spread any pass-through top-level keys first so the three
      // controlled sub-object merges below can still override them.
      ...passThrough,

      differentialGeometry: differentialGeometry
        ? Object.freeze({
            ...current.differentialGeometry,
            ...differentialGeometry
          })
        : current.differentialGeometry,

      plenopticSampling: plenopticSampling
        ? Object.freeze({
            ...current.plenopticSampling,
            ...plenopticSampling
          })
        : current.plenopticSampling,

      ambiFrame: ambiFrame
        ? Object.freeze({
            ...current.ambiFrame,
            ...ambiFrame
          })
        : current.ambiFrame
    });

    this.cameraContainer = merged;

    // Propagate to eviction hook — subsequent frame snapshots will carry
    // the updated sampling context
    if (this.evictionHook && typeof this.evictionHook.setCameraContainer === 'function') {
      try {
        this.evictionHook.setCameraContainer(merged);
      } catch (e) {
        console.warn('[Stage0] _updateCameraContainer: evictionHook.setCameraContainer failed', e);
      }
    }

    // Broadcast updated container to any other BC consumers (e.g. motion.worker
    // querying container state, future AmbiAnamorph listener)
    if (this._bc) {
      try {
        this._bc.postMessage({
          event: 'cameraContainer:updated',
          cameraId: merged.cameraId,
          differentialGeometry: merged.differentialGeometry,
          plenopticSampling: merged.plenopticSampling,
          ambiFrame: merged.ambiFrame,
          timestamp: Date.now()
        });
      } catch (e) {
        console.warn('[Stage0] _updateCameraContainer: BC postMessage failed', e);
      }
    }
  }

  // ------------------ CALIBRATION: orchestration-only helpers ------------------
  /**
   * requestCalibrationFromWorker(frames, framesNeeded, resolution)
   *
   * Orchestrates a calibration computation by transferring frames to the preprocessor wrapper.
   * Main will NOT keep returned dark/flat bitmaps or tokens. It will accept the worker's response
   * only to ensure the call completed and to release/close any returned ImageBitmaps immediately.
   *
   * On success this returns an object with minimal info: { metaKey?:string } if worker provided it,
   * but main will not persist bitmaps or manage releaseTokens.
   */
  async requestCalibrationFromWorker(frames, framesNeeded = 10, resolution) {
    if (!this.preprocessor) {
      throw new Error('Preprocessor not initialized');
    }
    try {
      // Transfer frames into the worker; wrapper returns a result but main discards bitmaps.
      const result = await this.preprocessor.requestCalibration(frames, framesNeeded, resolution);

      // Defensive cleanup: worker may return ImageBitmaps (darkFrame/flatFrame). Close them immediately.
      try {
        if (result && result.darkFrame) {
          try { result.darkFrame.close(); } catch (e) {}
        }
        if (result && result.flatFrame) {
          try { result.flatFrame.close(); } catch (e) {}
        }
      } catch (cleanupErr) {
        console.warn('Main: failed to close returned calibration bitmaps', cleanupErr);
      }

      // Optionally return only canonical metaKey (if provided). Do not store it locally.
      return { metaKey: result && result.metaKey ? result.metaKey : null };

    } catch (err) {
      console.error('Main: requestCalibrationFromWorker failed', err);
      // If frames were not transferred successfully, caller is responsible for closing them.
      throw err;
    }
  }

/**
 * IMPORTANT ARCHITECTURAL RULE:
 * main.js must NEVER decide whether HFH "heavy" or "light" path is taken.
 *
 * main.js responsibilities here are LIMITED to:
 *  - ensuring MotionWorker infrastructure exists
 *  - relaying context (camera container, flags, storage keys)
 *
 * The decision to escalate to heavy reconstruction belongs to:
 *  - MotionDetector (runtime judgment)
 *  - motion.worker (post-hoc reconstruction choice)
 */
/**
 * IMPORTANT ARCHITECTURAL RULE:
 * main.js must NEVER decide whether HFH "heavy" or "light" path is taken.
 *
 * main.js responsibilities here are LIMITED to:
 *  - ensuring MotionWorker infrastructure exists
 *  - relaying context (camera container, flags, storage keys)
 *
 * The decision to escalate to heavy reconstruction belongs to:
 *  - MotionDetector (runtime judgment)
 *  - motion.worker (post-hoc reconstruction choice)
 */
_ensureMotionWorker() {
  if (this.motionWorker) {
    console.log('MotionPainter: MotionWorker already exists, skipping creation');
    return;
  }

  try {
    // Guard: MotionWorker may ONLY be created after explicit escalation
    if (!this._heavyPathRequested) {
      console.warn(
        'MotionPainter: MotionWorker creation attempted without heavy-path escalation; ignoring.'
      );
      return;
    }

    console.log('MotionPainter: Creating MotionWorkerWrapper...');

    // Instantiate the wrapper which will create the underlying worker.
    // Use absolute path that maps to project layout so the wrapper can resolve URL reliably.
    this.motionWorker = new MotionWorkerWrapper('/src/js/core/motion.worker.js', { 
      readyTimeoutMs: 8000,
      defaultJobTimeoutMs: 120000,
      debug: true  // Enable debug logging for development
    });

    // ===================================================================
    // CRITICAL: Connect MotionWorkerWrapper to MotionDetector
    // ===================================================================
    if (this.motionDetector && typeof this.motionDetector.setDispatcher === 'function') {
      this.motionDetector.setDispatcher(this.motionWorker);
      console.log('✅ MotionPainter: MotionDetector.setDispatcher() called successfully');
      console.log('✅ MotionPainter: MotionDetector → MotionWorker pipeline established');
    } else {
      console.error('❌ MotionPainter: MotionDetector not available or missing setDispatcher method!');
      console.error('   This will cause reconstruction requests to fail silently.');
      // Don't throw - let app continue but log the critical issue
    }

    // ===================================================================
    // Worker Death Callback (Recovery)
    // ===================================================================
    this.motionWorker.onWorkerDeath = (error) => {
      console.error('🔴 MotionPainter: MotionWorker died unexpectedly!', error);
      
      // Notify MotionDetector to recover in-flight intents
      if (this.motionDetector && typeof this.motionDetector.recoverFromWorkerDeath === 'function') {
        try {
          console.warn('MotionPainter: Initiating MotionDetector recovery...');
          this.motionDetector.recoverFromWorkerDeath();
          console.log('✅ MotionPainter: MotionDetector recovery completed');
        } catch (recoveryErr) {
          console.error('❌ MotionPainter: MotionDetector recovery failed', recoveryErr);
        }
      } else {
        console.warn('⚠️ MotionPainter: MotionDetector.recoverFromWorkerDeath() not available');
      }
      
      // Clear worker reference so it can be recreated on next escalation
      this.motionWorker = null;
      
      // Update UI status
      if (this.controls) {
        this.controls.updateStatus('Motion worker crashed - will restart on next reconstruction');
      }
      
      // Optionally: attempt automatic restart after a delay
      setTimeout(() => {
        if (this._heavyPathRequested && !this.motionWorker) {
          console.log('MotionPainter: Attempting automatic MotionWorker restart...');
          try {
            this._ensureMotionWorker();
          } catch (restartErr) {
            console.error('MotionPainter: Automatic restart failed', restartErr);
          }
        }
      }, 5000); // Wait 5 seconds before restart attempt
    };

    // ===================================================================
    // Ready Callback (Non-blocking)
    // ===================================================================
    try {
    this.motionWorker.onReady(() => {
        try {
          console.log('✅ MotionPainter: MotionWorkerWrapper is ready');
          
          // Verify dispatcher connection is still intact
          if (this.motionDetector && this.motionDetector._dispatcher === this.motionWorker) {
            console.log('✅ MotionPainter: Dispatcher connection verified');
          } else {
            console.warn('⚠️ MotionPainter: Dispatcher connection verification failed!');
          }

          // ── Override hfhHeavyPathThreshold → 0.0 ──────────────────────────
          // Lesson from test script: _setFlag broadcasts
          // { event: 'flagsChanged', flags: { hfhHeavyPathThreshold: 0.0 } }
          // which is the event motion.worker's featureFlags listener handles.
          //
          // Why this is needed: motion.worker loads featureFlags from webpack's
          // persistent bundle cache. If the cache pre-dates our change of the
          // value to 0.0 in featureFlags.js, the worker sees 0.85. At 0.85,
          // reconstruction is gated on HFH severity exceeding 0.85, which many
          // scenes never reach. At 0.0, any HFH 'shouldRun' event is sufficient.
          //
          // We use this._bc (already initialized in init()) rather than a new
          // channel to avoid creating/closing unnecessary resources. By the time
          // this callback fires, motion.worker is confirmed ready and listening.
          try {
            if (this._bc) {
              this._bc.postMessage({
                event: 'flagsChanged',
                flags: { hfhHeavyPathThreshold: 0.0 }
              });
              console.log('[MotionPainter] hfhHeavyPathThreshold overridden to 0.0 in motion.worker');
            }
          } catch (e) {
            console.warn('[MotionPainter] hfhHeavyPathThreshold override failed (non-fatal):', e);
          }

          // Instantiate topology.worker, minimizer.worker, and ambi.worker now
          // that motion.worker is confirmed ready. All Stage 4/5 workers consume
          // artifacts produced by motion.worker, so this ordering guarantees they
          // are live before the first RECON_DONE fires.
          try {
            this._ensureTopologyWorker();
          } catch (e) {
            console.warn('[Stage4A] MotionPainter: _ensureTopologyWorker failed in onReady', e);
          }
          try {
            this._ensureMinimizerWorker();
          } catch (e) {
            console.warn('[Stage4B] MotionPainter: _ensureMinimizerWorker failed in onReady', e);
          }
          try {
            this._ensureAmbiWorker();
          } catch (e) {
            console.warn('[Stage5] MotionPainter: _ensureAmbiWorker failed in onReady', e);
          }
          try {
            this._ensureKEMWorker();
          } catch (e) {
            console.warn('[Stage6] MotionPainter: _ensureKEMWorker failed in onReady', e);
          }
          try {
            this._ensureCorrespondenceWorker();
          } catch (e) {
            console.warn('[Stage7] MotionPainter: _ensureCorrespondenceWorker failed in onReady', e);
          }

          // Request initial metrics to warm the worker
          try {
            this.motionWorker.requestMetrics().then(metrics => {
              if (metrics) {
                console.debug('MotionWorker initial metrics:', metrics);
                console.log(`   - Worker ready: ${metrics.workerReady}`);
                console.log(`   - Pending jobs: ${metrics.pendingJobs || 0}`);
              }
            }).catch(metricsErr => {
              console.warn('MotionPainter: Failed to fetch initial metrics', metricsErr);
            });
          } catch (e) {
            // Metrics request is optional, ignore errors
          }
          
          // Update UI status
          if (this.controls) {
            this.controls.updateStatus('Motion worker ready');
          }
        } catch (e) {
          console.warn('MotionPainter: motionWorker onReady handler error', e);
        }
      });
    } catch (e) {
      // onReady might not be present in all wrapper versions - defensive coding
      console.warn('MotionPainter: motionWorker.onReady() not available', e);
    }

    console.log('✅ MotionPainter: MotionWorkerWrapper created (non-blocking initialization)');
    
    // ===================================================================
    // Verification Log Summary
    // ===================================================================
    console.group('🔍 MotionWorker Setup Verification');
    console.log('Wrapper instance:', this.motionWorker ? '✅ Created' : '❌ Failed');
    console.log('Dispatcher connected:', this.motionDetector?._dispatcher === this.motionWorker ? '✅ Yes' : '❌ No');
    console.log('Death callback:', this.motionWorker?.onWorkerDeath ? '✅ Registered' : '❌ Missing');
    console.log('Ready callback:', 'Registered (will execute asynchronously)');
    console.log('Heavy path requested:', this._heavyPathRequested ? '✅ Yes' : '❌ No');
    console.groupEnd();
    
  } catch (err) {
    console.error('❌ MotionPainter: Failed to create MotionWorkerWrapper', err);
    console.error('Stack trace:', err.stack);
    
    // Cleanup on failure
    try { 
      if (this.motionWorker && typeof this.motionWorker.terminate === 'function') {
        this.motionWorker.terminate();
      }
    } catch (terminateErr) {
      console.warn('MotionPainter: Failed to terminate worker during cleanup', terminateErr);
    }
    
    this.motionWorker = null;
    
    // Update UI status
    if (this.controls) {
      this.controls.updateStatus('Failed to initialize motion worker: ' + err.message);
    }
    
    // Re-throw so caller knows creation failed
    throw err;
  }
}


/**
   * _ensureAmbiWorker()
   *
   * Instantiates ambi.worker.js as a module worker on first call.
   * No-op if the worker already exists.
   *
   * Called alongside _ensureTopologyWorker() and _ensureMinimizerWorker()
   * from motionWorker.onReady() so all Stage 4/5 workers are live before
   * the first RECON_DONE arrives.
   *
   * { type: 'module' } is required — ambi.worker.js uses ES module
   * import statements and will throw SyntaxError as a classic worker.
   *
   * ambi.worker maintains persistent session state (_sessionState and
   * _manifold) across calls — it must NOT be restarted between frames.
   * The onerror handler sets the reference to null so that the next
   * STAGE4_DONE will attempt to re-instantiate, resetting session state.
   */
  _ensureKEMWorker() {
    if (this._kemWorker) return;
    try {
      this._kemWorker = new Worker(
        new URL('./core/kem.worker.js', import.meta.url),
        { type: 'module' }
      );
      try {
        this._kemWorker.postMessage({
          op:    'init',
          flags: this._currentFlags ?? {}
        });
      } catch (e) {
        console.warn('[Stage6] main.js: kem.worker init message failed', e);
      }
      this._kemWorker.onerror = (err) => {
        console.error('[Stage6] main.js: kem.worker runtime error:', err);
        this._kemWorker = null;
      };
      console.log('[Stage6] main.js: kem.worker instantiated (module worker)');
    } catch (err) {
      console.error('[Stage6] main.js: failed to instantiate kem.worker:', err);
      this._kemWorker = null;
    }
  }

  _ensureCorrespondenceWorker() {
    if (this._correspondenceWorker) return;
    try {
      this._correspondenceWorker = new Worker(
        new URL('./core/correspondence.worker.js', import.meta.url),
        { type: 'module' }
      );
      try {
        this._correspondenceWorker.postMessage({
          op:    'init',
          flags: this._currentFlags ?? {}
        });
      } catch (e) {
        console.warn('[Stage7] main.js: correspondence.worker init message failed', e);
      }
      this._correspondenceWorker.onerror = (err) => {
        console.error('[Stage7] main.js: correspondence.worker runtime error:', err);
        this._correspondenceWorker = null;
      };
      console.log('[Stage7] main.js: correspondence.worker instantiated (module worker)');
    } catch (err) {
      console.error('[Stage7] main.js: failed to instantiate correspondence.worker:', err);
      this._correspondenceWorker = null;
    }
  }

  _ensureAmbiWorker() {
    if (this._ambiWorker) return;

    try {
      this._ambiWorker = new Worker(
        new URL('./core/ambi.worker.js', import.meta.url),
        { type: 'module' }
      );

      // Send initial flags snapshot so _flags is populated before
      // the first AMBI_ANALYZE message arrives.
      try {
        this._ambiWorker.postMessage({
          op:    'init',
          flags: this._currentFlags ?? {}
        });
      } catch (e) {
        console.warn('[Stage5] main.js: ambi.worker init message failed', e);
      }

      this._ambiWorker.onerror = (err) => {
        console.error('[Stage5] main.js: ambi.worker runtime error:', err);
        // Null the reference — next STAGE4_DONE re-instantiates,
        // which resets session state (new keyframe on restart).
        this._ambiWorker = null;
      };

      console.log('[Stage5] main.js: ambi.worker instantiated (module worker)');
    } catch (err) {
      console.error('[Stage5] main.js: failed to instantiate ambi.worker:', err);
      this._ambiWorker = null;
    }
  }

  _ensureMinimizerWorker() {
    if (this._minimizerWorker) return;

    try {
      this._minimizerWorker = new Worker(
        new URL('./core/minimizer.worker.js', import.meta.url),
        { type: 'module' }
      );

      // Send initial flags snapshot
      try {
        this._minimizerWorker.postMessage({
          op:    'init',
          flags: this._currentFlags ?? {}
        });
      } catch (e) {
        console.warn('[Stage4B] main.js: minimizer.worker init message failed', e);
      }

      this._minimizerWorker.onerror = (err) => {
        console.error('[Stage4B] main.js: minimizer.worker runtime error:', err);
        this._minimizerWorker = null;
      };

      console.log('[Stage4B] main.js: minimizer.worker instantiated (module worker)');
    } catch (err) {
      console.error('[Stage4B] main.js: failed to instantiate minimizer.worker:', err);
      this._minimizerWorker = null;
    }
  }

  _ensureTopologyWorker() {
    if (this._topologyWorker) return;

    try {
      this._topologyWorker = new Worker(
        new URL('./core/topology.worker.js', import.meta.url),
        { type: 'module' }
      );

      // Send initial flags snapshot so the worker's _flags are populated
      // before the first TOPOLOGY_ANALYZE message arrives.
      try {
        this._topologyWorker.postMessage({
          op:    'init',
          flags: this._currentFlags ?? {}
        });
      } catch (e) {
        console.warn('[Stage4A] main.js: topology.worker init message failed', e);
      }

      // Worker-level error handler — clears the reference so the next
      // RECON_DONE will attempt to re-instantiate.
      this._topologyWorker.onerror = (err) => {
        console.error('[Stage4A] main.js: topology.worker runtime error:', err);
        this._topologyWorker = null;
      };

      console.log('[Stage4A] main.js: topology.worker instantiated (module worker)');
    } catch (err) {
      console.error('[Stage4A] main.js: failed to instantiate topology.worker:', err);
      this._topologyWorker = null;
    }
  }

  /**
   * _checkStage678Complete
   *
   * Called after any of: KEM_DONE, CORRESPONDENCE_DONE, AMBI_REFINED.
   * Broadcasts STAGE678_DONE when all three have arrived for the current metaKey.
   * _stage678State is reset on each AMBI_DONE so a stale flag from a prior
   * frame cannot prematurely trigger Stage 8.
   */
  _checkStage678Complete() {
    const s = this._stage678State;
    if (!s) return;
    if (s.kemDone && s.correspondenceDone && s.ambiRefined) {
      if (this._bc) {
        try {
          this._bc.postMessage({
            event:     'STAGE678_DONE',
            metaKey:   s.metaKey,
            stage6:    this.cameraContainer?.stage6  ?? null,
            stage7:    this.cameraContainer?.stage7  ?? null,
            ambiFrame: this.cameraContainer?.ambiFrame ?? null,
            timestamp: Date.now()
          });
          console.log('[Stage678] main.js: STAGE678_DONE broadcast', { metaKey: s.metaKey });
        } catch (e) {
          console.warn('[Stage678] main.js: STAGE678_DONE broadcast failed', e);
        }
      }
      this._stage678State = null;

      // ── Safety-net: release any inline typed arrays still on cameraContainer ─
      // Fix 2 (AMBI_DONE handler) clears most of these immediately after dispatch.
      // This catch-all runs after all three stage-678 workers have confirmed done,
      // ensuring nothing survives into the next reconstruction cycle.
      // Each field is guarded — if already null this is a no-op.
      try {
        this._updateCameraContainer({
          passThrough: {
            dgInline:               null,   // principalE1/E2 + kH + curls (~32MB)
            directionalFieldInline: null,   // directional field + coherence (~20MB)
            flowFieldInline:        null,   // Horn-Schunck u/v (~8MB)
            stage1Inline:           null,   // fMap + edgeMask (~5MB)
            fluxInline:             null,   // solver matrix (~5MB)
            stage67Inputs:          null,   // topologyMap + motionMaps + phiMin (~7MB)
            stage5Inline:           null,   // warpField + worldFrameMap (~3MB)
            diskSeedsForMinimizer:  null    // seed objects (small)
          }
        });
        console.log('[Stage678] main.js: Inline array safety-net release complete after STAGE678_DONE');
      } catch (e) {
        console.warn('[Stage678] main.js: Safety-net inline release failed (non-fatal)', e);
      }
    }
  }

  _checkStage4Complete(metaKey) {
    const cc = this.cameraContainer;
    if (!cc) return;
    if (cc.stage4a && cc.stage4b) {
      if (this._bc) {
        try {
          this._bc.postMessage({
            event:     'STAGE4_DONE',
            metaKey,
            stage4a:   cc.stage4a,
            stage4b:   cc.stage4b,
            timestamp: Date.now()
          });
          console.log('[Stage4] main.js: STAGE4_DONE broadcast (both 4A and 4B complete)', { metaKey });
        } catch (e) {
          console.warn('[Stage4] main.js: STAGE4_DONE broadcast failed', e);
        }
      }

      // ── Extract Stage 6/7 inputs before transient payloads are nulled ────
      // _pendingTopoInline and _pendingMinimizerInline are cleared in the
      // finally block after postMessage. KEM and Correspondence are dispatched
      // from the AMBI_DONE handler — by that point both are null. Extract the
      // fragments each Stage 6/7 worker needs and store on cameraContainer now.
      {
        const _t = this._pendingTopoInline;
        const _m = this._pendingMinimizerInline;
        if (_t || _m) {
          try {
            this._updateCameraContainer({
              passThrough: {
                stage67Inputs: {
                  primeEnds:       _t?.primeEnds       ?? null,  // Correspondence — array of PrimeEnd
                  topologyMap:     _t?.topologyMap     ?? null,  // Correspondence — Int32Array res²
                  motionMaps:      _t?.motionMaps      ?? null,  // KEM — { motionMagnitude, motionEndsMap }
                  phiMin:          _m?.phiMin          ?? null,  // KEM + Correspondence — Float32Array res²
                  _topoResolution: _t?.topoResolution  ?? null   // KEM + Correspondence — target resolution
                                                                  // for all downsampling (always 512 when
                                                                  // topoMaxResolution=512). Both workers
                                                                  // use this to set N = _topoResolution².
                }
              }
            });
            console.log('[Stage67] main.js: stage67Inputs stored on cameraContainer:', {
              hasPrimeEnds:    !!(_t?.primeEnds),
              hasTopologyMap:  !!(_t?.topologyMap),
              hasMotionMaps:   !!(_t?.motionMaps),
              hasPhiMin:       !!(_m?.phiMin),
              topoResolution:  _t?.topoResolution  ?? null,
              primeEndsCount:  _t?.primeEnds?.length   ?? 0,
              topologyMapLen:  _t?.topologyMap?.length ?? 0,
              phiMinLen:       _m?.phiMin?.length      ?? 0
            });
          } catch (e) {
            console.warn('[Stage67] main.js: stage67Inputs writeback failed', e);
          }
        }
      }

      if (this._ambiWorker) {
        try {
          this._ambiWorker.postMessage({
            op:       'AMBI_ANALYZE',
            jobId:    `ambi:${metaKey}:${Date.now()}`,
            metaKey,
            cameraId: cc.cameraId ?? 'default',
            flags:    this._currentFlags ?? {},
            stage4a:  cc.stage4a,
            stage4b:  cc.stage4b,
            stage1Inline:    cc.stage1Inline ?? null,
            dgInline:        cc.dgInline     ?? null,
            // Transient payloads — large typed arrays forwarded directly and then discarded.
            // These are never stored on cameraContainer.
            topoInline:             this._pendingTopoInline      ?? null,
            minimizerInline:        this._pendingMinimizerInline ?? null,
            directionalFieldInline: cc.directionalFieldInline    ?? null,
            artifactKeys: {
              // All Stage 4A/4B artifact keys are null — data travels inline above.
              phiMinKey:               null,
              zeroCurveKey:            null,
              constrainedMinimizerKey: null,
              primeEndsKey:            null,
              topologyMapKey:          null,
              componentMapKey:         null,
              lipschitzEndsKey:        null,
              motionMapsKey:           null,
              principalFrameKey:       null,
              curvatureKey:            null,
              directionalFieldKey:     cc.directionalFieldInline ? null : (cc.directionalFieldKey ?? null),
              directnessKey:           null,
              penumbraKey:             null,
              resolution:              cc.differentialGeometry?.reconstructionResolution
                                       ?? cc.reconstructionResolution
                                       ?? 512,
              cameraId:                cc.cameraId ?? 'default'
            }
          });
          console.log('[Stage5] main.js: ambi.worker dispatched (AMBI_ANALYZE)', { metaKey });
        } catch (ambiErr) {
          console.warn('[Stage5] main.js: ambi.worker dispatch failed', ambiErr);
        } finally {
          // Discard transient payloads — large typed arrays must not be held beyond this point
          this._pendingTopoInline      = null;
          this._pendingMinimizerInline = null;
        }
      } else {
        console.warn('[Stage5] main.js: _ambiWorker not ready — AMBI_ANALYZE skipped for', metaKey);
      }

      // Resume evictor now that Stage 4 IDB reads (directional_field, disk_seeds,
      // flow_field) are complete. Keeping it paused longer risks quota overflow.
      try { storageAPI.startEvictorLoop(); } catch(e) {
        console.warn('[Stage4] main.js: failed to resume evictor', e);
      }

      // ── Release stage1Inline and fluxInline ───────────────────────────────
      // ambi.worker received both via structured clone in postMessage above.
      // Clearing here frees ~10MB immediately rather than waiting for GC.
      // diskSeedsForMinimizer is tiny but cleared for completeness.
      try {
        this._updateCameraContainer({
          passThrough: {
            stage1Inline:          null,   // fMap (4MB) + edgeMask (1MB) — ambi consumed
            fluxInline:            null,   // A_coo, b, init_h (~5MB) — minimizer consumed
            diskSeedsForMinimizer: null    // small seed objects — minimizer consumed
          }
        });
        console.log('[Stage5] main.js: stage1Inline / fluxInline released after ambi dispatch');
      } catch (e) {
        console.warn('[Stage5] main.js: failed to release stage1Inline/fluxInline', e);
      }
    }
  }

// ── Log filter ────────────────────────────────────────────────────────────
  // Silences high-frequency renderer/storage telemetry so pipeline events
  // are readable. restoreConsole() removes the filter at any time.
  _installLogFilter() {
    const _origLog   = console.log.bind(console);
    const _origWarn  = console.warn.bind(console);
    const _origDebug = (console.debug || console.log).bind(console);

    window.restoreConsole = () => {
      console.log = _origLog; console.warn = _origWarn; console.debug = _origDebug;
      _origLog('[MotionPainter] Log filter removed');
    };

    // Strings that, when found at the start of the first argument, suppress the line.
    const LOG_BLOCK = [
      // ── Renderer (fires on every frame at 30fps) ──
      '[FB]', '[FB_DIAG]', '[GL]', '[GL_DIAG]', '[GL_VALIDATE]', '[CR]',
      'renderComposite', 'rotateBuffers', 'getSpiralIndices',
      'uploadVideoFrame', 'advanceWriteIndex', 'initializeWithFrame',
      '[CR] processFrame',
      // ── Pin lifecycle (fires on every artifact write) ──
      '[PIN] ✓', '[PIN] ⏱', '[PIN] ⏰', '[PIN] 🚫',
      '[PIN] ⚠', '[PIN] ⏸', '[PIN] ℹ',
      // ── Storage per-artifact / per-eviction ──
      '[parts] Serializing',
      'storage: NORMAL quota pressure',
      'NORMAL quota pressure',
      '[PERSIST]',
      'artifact:pinned', 'artifact:unpinned',
      'artifact:ttl_unpinned', 'artifact:evicted',
      // ── Worker flag broadcasts ──
      'motion.worker: feature flags updated',
      '[PIN] Feature flag updated',
      '[_wrapStorage]',
      'MotionWorkerWrapper: init posted',
      'MotionWorkerWrapper: feature flags',
      'MotionWorkerWrapper: RECONSTRUCT_META missing',
      // ── Preprocessor per-frame ──
      'PreprocessorWorker: Frame',
      'PreprocessorWorker: HFH',
      // ── Camera container propagation ──
      'cameraContainer:updated',
      '[cameraContainer] main.js: propagating',
      '[cameraContainer] FrameEvictionHook',
      // ── Layout / resize ──
      'Buffer configuration updated',
      'panelRect',
      'Canvas resized to',
      // ── Expected non-actionable ──
      'FrameEvictionHook: calibration buffer hard limit',
      // ── Recurring flag and debug logs ──
      'featureFlags: enableFlux',
      'main.js: persistIntermediates flag changed',
      'main.js: Initial MotionDetector',
      'main.js: Metrics timer',
      'Reaper:',
      // ── Storage module boilerplate ──
      'storage.js: All functions defined',
      'storage.js: Setting up worker globals',
      'storage.js: Worker globals set up successfully',
    ];

    const WARN_BLOCK = [
      '[PIN] ✗ Aggressive unpin',
      '[PIN] ✗ Failed to check',
      'preprocessor.worker: BroadcastChannel failed',
      'preprocessor.worker: failed to broadcast',
    ];

    const blocked = (list, args) => {
      const s = typeof args[0] === 'string' ? args[0] : '';
      return list.some(p => s.includes(p));
    };

    console.log   = (...a) => { if (!blocked(LOG_BLOCK,  a)) _origLog(...a);   };
    console.debug = (...a) => { if (!blocked(LOG_BLOCK,  a)) _origDebug(...a); };
    console.warn  = (...a) => { if (!blocked(WARN_BLOCK, a)) _origWarn(...a);  };
    // console.error is never filtered.

    _origLog('[MotionPainter] Log filter active — restoreConsole() to remove');
  }

/**
 * Teardown MotionWorker if present (called during destroy)
 */
_teardownMotionWorker() {
  if (!this.motionWorker) {
    return;
  }

  console.log('MotionPainter: Tearing down MotionWorker...');
  
  try {
    // Clear dispatcher connection in MotionDetector
    if (this.motionDetector && typeof this.motionDetector.setDispatcher === 'function') {
      try {
        this.motionDetector.setDispatcher(null);
        console.log('MotionPainter: Cleared MotionDetector dispatcher');
      } catch (err) {
        console.warn('MotionPainter: Failed to clear dispatcher', err);
      }
    }
    
    // Terminate worker (prefer wrapper method if available)
    if (typeof this.motionWorker.terminate === 'function') {
      // Wrapper has async terminate - don't await in destroy path
      try { 
        this.motionWorker.terminate(); 
        console.log('MotionPainter: MotionWorker termination initiated');
      } catch (e) {
        console.warn('MotionPainter: Worker termination failed', e);
      }
    } else {
      // Fallback for older raw worker usage (unlikely)
      try { 
        if (this.motionWorker.postMessage) {
          this.motionWorker.postMessage({ op: 'shutdown' }); 
        }
      } catch (e) {
        console.warn('MotionPainter: Failed to send shutdown message', e);
      }
      try { 
        if (this.motionWorker.terminate) {
          this.motionWorker.terminate(); 
        }
      } catch (e) {
        console.warn('MotionPainter: Failed to terminate worker', e);
      }
    }
    
    this.motionWorker = null;
    console.log('✅ MotionPainter: MotionWorker teardown complete');
    
  } catch (err) {
    console.error('❌ MotionPainter: Error during MotionWorker teardown', err);
    // Force null even on error
    this.motionWorker = null;
  }
}

/**
 * Manual dispatcher verification (for debugging)
 * Call this from console: window.MotionPainter.verifyDispatcherConnection()
 */
verifyDispatcherConnection() {
  console.group('🔍 Dispatcher Connection Verification');
  
  try {
    const detectorExists = !!this.motionDetector;
    const workerExists = !!this.motionWorker;
    const dispatcherSet = this.motionDetector?._dispatcher === this.motionWorker;
    
    console.log('MotionDetector exists:', detectorExists ? '✅' : '❌');
    console.log('MotionWorker exists:', workerExists ? '✅' : '❌');
    console.log('Dispatcher connected:', dispatcherSet ? '✅' : '❌');
    
    if (detectorExists && workerExists && !dispatcherSet) {
      console.error('🔴 CRITICAL: MotionWorker exists but dispatcher not connected!');
      console.log('   Fix: Call this.motionDetector.setDispatcher(this.motionWorker)');
    }
    
    if (this.motionDetector) {
      console.log('MotionDetector stats:', this.motionDetector.getRecentStats());
    }
    
    if (this.motionWorker) {
      this.motionWorker.getMetrics().then(metrics => {
        console.log('MotionWorker metrics:', metrics);
      }).catch(err => {
        console.warn('Failed to get worker metrics:', err);
      });
    }
    
    console.log('Heavy path requested:', this._heavyPathRequested ? '✅' : '❌');
    
  } catch (err) {
    console.error('Verification failed:', err);
  }
  
  console.groupEnd();
  
  return {
    detectorExists: !!this.motionDetector,
    workerExists: !!this.motionWorker,
    dispatcherConnected: this.motionDetector?._dispatcher === this.motionWorker,
    heavyPathRequested: this._heavyPathRequested
  };
}

  /**
   * Register MotionDetector event handlers and calibration orchestration.
   * This function tries to support multiple event patterns (on/ addEventListener / property).
   * It records unsubscribe handlers so destroy() can clean them up.
   */
  setupCalibrationOrchestration() {
    // Defensive no-op if no motionDetector present
    if (!this.motionDetector) return;

    const handler = (payload) => {
      // Payload may be { count, resolution, reason } or a boolean
      try {
        // Normalize payload into object
        const info = (typeof payload === 'object' && payload) ? payload : {};
        // Kick off calibration request
        this._handleCalibrationRequest(info).catch(err => {
          console.warn('Calibration request failed:', err);
          // Surface a UI status
          if (this.controls) this.controls.updateStatus('Calibration failed: ' + (err && err.message ? err.message : String(err)));
        });
      } catch (err) {
        console.warn('Calibration handler exception:', err);
      }
    };

    try {
      // EventEmitter-style: .on/.off or .addListener/.removeListener
      if (typeof this.motionDetector.on === 'function') {
        // Attach both common event names and record unsubs
        try {
          this.motionDetector.on('calibrationNeeded', handler);
          this._motionDetectorUnsubs.push(() => {
            try {
              if (typeof this.motionDetector.off === 'function') {
                this.motionDetector.off('calibrationNeeded', handler);
              } else if (typeof this.motionDetector.removeListener === 'function') {
                this.motionDetector.removeListener('calibrationNeeded', handler);
              }
            } catch (e) { /* ignore */ }
          });
        } catch (e) {
          console.warn('Failed to attach calibrationNeeded via .on', e);
        }

        try {
          this.motionDetector.on('needCalibration', handler);
          this._motionDetectorUnsubs.push(() => {
            try {
              if (typeof this.motionDetector.off === 'function') {
                this.motionDetector.off('needCalibration', handler);
              } else if (typeof this.motionDetector.removeListener === 'function') {
                this.motionDetector.removeListener('needCalibration', handler);
              }
            } catch (e) { /* ignore */ }
          });
        } catch (e) {
          // swallow - not all detectors emit both names
        }

      } else if (typeof this.motionDetector.addEventListener === 'function') {
        // DOM/EventTarget style
        try {
          this.motionDetector.addEventListener('calibrationNeeded', handler);
          this._motionDetectorUnsubs.push(() => {
            try { this.motionDetector.removeEventListener('calibrationNeeded', handler); } catch (e) {}
          });
        } catch (e) {
          console.warn('Failed to attach calibrationNeeded via addEventListener', e);
        }

        try {
          this.motionDetector.addEventListener('needCalibration', handler);
          this._motionDetectorUnsubs.push(() => {
            try { this.motionDetector.removeEventListener('needCalibration', handler); } catch (e) {}
          });
        } catch (e) {
          // swallow
        }

      } else {
        // Property-based callback or custom registration function
        if (typeof this.motionDetector.requestCalibration === 'function') {
          try {
            const maybeUnsub = this.motionDetector.requestCalibration(handler);
            if (typeof maybeUnsub === 'function') {
              this._motionDetectorUnsubs.push(() => {
                try { maybeUnsub(); } catch (e) {}
              });
            } else {
              this._motionDetectorUnsubs.push(() => {});
            }
          } catch (e) {
            console.warn('motionDetector.requestCalibration threw while registering', e);
          }
        } else {
          try {
            const prev = this.motionDetector.onCalibrationNeeded;
            this.motionDetector.onCalibrationNeeded = handler;
            this._motionDetectorUnsubs.push(() => {
              try { this.motionDetector.onCalibrationNeeded = prev; } catch (e) {}
            });
          } catch (e) {
            console.warn('MotionPainter: MotionDetector does not expose standard event API for calibration signals', e);
          }
        }
      }
    } catch (err) {
      console.warn('MotionPainter: failed to hook MotionDetector calibration events', err);
    }
  }

  /**
   * Internal handler: MotionDetector requested calibration.
   *
   * Flow:
   *  - ensure MotionWorker exists (so it can listen to BC or query storage)
   *  - start a short capture window via evictionHook.startCalibrationCapture(...)
   *  - register one-shot callback via evictionHook.registerCalibrationCallback(...)
   *  - callback transfers clones to preprocessor.requestCalibration(frames,...)
   *  - main does NOT keep returned artifacts; it closes them immediately to avoid holding copies.
   */
  async _handleCalibrationRequest({ count = 16, resolution = null, reason = 'motion-trigger' } = {}) {
    if (!this.evictionHook) {
      throw new Error('EvictionHook not initialized (cannot capture calibration frames)');
    }
    if (!this.preprocessor) {
      throw new Error('Preprocessor wrapper not initialized (cannot compute calibration)');
    }

    // ── Post-calibration lockout ────────────────────────────────────────────
    // After calibration:ready fires, MotionDetector immediately detects
    // flat_field_degradation because the fresh calibration statistics differ
    // from what was seen during frame capture. Without a lockout, a second
    // calibration starts before the first reconstruction has finished.
    // 90s is long enough for one full reconstruction cycle (30-60s) + buffer.
    const _msSinceLastCalib = Date.now() - this._lastCalibrationCompletedAt;
    if (this._lastCalibrationCompletedAt > 0 && _msSinceLastCalib < this._calibrationLockoutMs) {
      console.log(
        '[Calibration] Lockout active — suppressing request.',
        `Completed ${Math.round(_msSinceLastCalib / 1000)}s ago,`,
        `lockout expires in ${Math.round((this._calibrationLockoutMs - _msSinceLastCalib) / 1000)}s.`,
        `Suppressed reason: ${reason}`
      );
      return;
    }

    // Defensive: if a capture is already in progress, ignore duplicate triggers
    if (this.evictionHook.captureCalibration) {
      console.log('Calibration capture already in progress — ignoring duplicate request');
      return;
    }

    console.log('Calibration requested by MotionDetector:', { count, resolution, reason });
    this.controls && this.controls.updateStatus('Calibration requested...');

    // Escalation intent: MotionDetector has requested deeper analysis
    this._heavyPathRequested = true;

    // Ensure MotionWorker exists so it will receive BC messages or can query storage
    try {
      this._ensureMotionWorker();
    } catch (err) {
      console.warn('Main: failed to ensure MotionWorker; continuing but MotionWorker may miss calibration ready event', err);
    }

    // Register one-shot callback
    let unsub = null;
    let calledBack = false;

    const cb = async (frames, info) => {
      // frames: array of ImageBitmap clones (ownership expected to be transferred)
      try {
        calledBack = true;
        // Unsubscribe immediately to ensure one-shot semantics
        try { if (typeof unsub === 'function') unsub(); } catch (_) {}

        if (!Array.isArray(frames) || frames.length === 0) {
          console.warn('Calibration callback invoked with no frames');
          return false;
        }

        // Transfer clones to preprocessor for calibration computation.
        // Main will await completion to ensure the transfer succeeded and then close any returned bitmaps.
        //
        // NOTE: evictor/reaper pausing is now handled generically by the
        // _coordCheckInterval poller set up in init() — it watches
        // StorageActivityCoordinator for any 'calibration' or 'reconstruction'
        // activity and pauses/resumes accordingly. No per-call-site pause code
        // is needed here anymore; preprocessor.worker registers the
        // 'calibration' activity itself via StorageActivityCoordinator.begin/end.
        try {
          const res = resolution || { width: (this.video && this.video.videoWidth) || frames[0].width, height: (this.video && this.video.videoHeight) || frames[0].height };
          const callResult = await this.preprocessor.requestCalibration(frames, count, res);

          // Immediately close any ImageBitmaps returned by worker (we don't retain them).
          try {
            if (callResult && callResult.darkFrame) { try { callResult.darkFrame.close(); } catch (e) {} }
            if (callResult && callResult.flatFrame) { try { callResult.flatFrame.close(); } catch (e) {} }
          } catch (closeErr) {
            console.warn('Main: error closing returned calibration ImageBitmaps', closeErr);
          }

          // We do not manage releaseTokens or pins here — consumers (MotionWorker) will fetch persisted artifacts and manage lifecycle.
          console.log('Main: Preprocessor accepted calibration frames; orchestration complete.');
          return true;

        } catch (err) {
          console.error('Preprocessor.requestCalibration rejected', err);
          // If transfer failed and frames were not consumed, ensure we close the clones to avoid leaks
          try {
            frames.forEach(f => { try { f.close(); } catch (e) {} });
          } catch (_) {}
          throw err;
        } finally {
          // No manual evictor/reaper resume needed here — the generic
          // _coordCheckInterval poller (see init()) resumes both automatically
          // once StorageActivityCoordinator reports no 'calibration' or
          // 'reconstruction' activity remaining.
        }

      } catch (err) {
        console.error('Calibration callback error:', err);
        // Defensive cleanup of frames if something went wrong.
        try {
          if (Array.isArray(frames)) {
            for (const f of frames) {
              try { f.close(); } catch (e) {}
            }
          }
        } catch (_) {}
        return false;
      }
    }; // end cb

    // register the callback and start capture
    try {
      unsub = this.evictionHook.registerCalibrationCallback(cb);

      // Start capture: clones will be created on evictions until count reached or timeout triggers
      this.evictionHook.startCalibrationCapture({
        count,
        resolution: resolution || null,
        // 90s matches the post-calibration lockout in _lastCalibrationCompletedAt.
        // The 30s original timeout fired before the preprocessor worker finished
        // its IDB persist loop for all five calibration artifacts, causing
        // calibration:ready to never fire and stalling the pipeline permanently.
        // In practice the 16 frames accumulate in ~0.5s; the timeout is only
        // relevant if the scene is so busy that evictions stall.
        timeoutMs: 90_000,
        forceFull: true
      });

      console.log('Main: started calibration capture (evictionHook)');

      // The callback will run asynchronously when the hook collected enough clones;
      // We return and let the callback handle the rest.
    } catch (err) {
      // cleanup if registration failed
      try { if (typeof unsub === 'function') unsub(); } catch (_) {}
      console.error('Main: failed to register calibration callback', err);
      // Stop capture proactively
      try { this.evictionHook.stopCalibrationCapture(); } catch (_) {}
      throw err;
    }
  }

  // ------------------ end MotionDetector calibration orchestration ------------------
   destroy() {
    this.stopRendering();

    // Tear down artifact panel first (removes DOM, stops timer)
    if (this.artifactPanel) {
      try {
        this.artifactPanel.destroy();
      } catch (e) {
        console.warn('[ArtifactPanel] destroy failed:', e);
      }
      this.artifactPanel = null;
    }

    // Tear down artifact renderer (deletes all GPU textures and shaders)
    if (this.artifactRenderer) {
      try {
        this.artifactRenderer.destroy();
      } catch (e) {
        console.warn('[ArtifactRenderer] destroy failed:', e);
      }
      this.artifactRenderer = null;
    }

    if (Array.isArray(this._flagUnsubs)) {
      try {
        this._flagUnsubs.forEach(unsub => {
          try { if (typeof unsub === 'function') unsub(); } catch (e) {}
        });
      } catch (e) { console.warn('Failed to cleanup flag subscriptions', e); }
      this._flagUnsubs = [];
    }

    // ============================================================================
    // ✅ NEW: Stop metrics timer on destroy
    // ============================================================================
    /**
     * CRITICAL: Must stop metrics timer to prevent memory leaks
     * 
     * If not stopped, timer continues to:
     * - Call persistMetrics() every 10s
     * - Hold references to MotionDetector
     * - Prevent garbage collection
     * 
     * This is especially important for SPA contexts where app may be
     * destroyed/recreated without full page reload.
     */
    try {
      if (this._stopMetricsTimer) {
        this._stopMetricsTimer();
        console.log('✅ main.js: Metrics timer stopped on destroy');
      } else if (this._metricsTimer) {
        // Fallback: direct clear if helper not available
        clearInterval(this._metricsTimer);
        this._metricsTimer = null;
        console.log('✅ main.js: Metrics timer cleared on destroy (fallback)');
      }
    } catch (e) {
      console.warn('⚠️ main.js: Failed to stop metrics timer on destroy', e);
    }
    
    // Clear helper references
    this._startMetricsTimer = null;
    this._stopMetricsTimer = null;

    // Clean up MotionDetector listeners we registered
    try {
      if (Array.isArray(this._motionDetectorUnsubs) && this._motionDetectorUnsubs.length > 0) {
        this._motionDetectorUnsubs.forEach(unsubFn => {
          try { if (typeof unsubFn === 'function') unsubFn(); } catch (e) {}
        });
        this._motionDetectorUnsubs = [];
      }
    } catch (e) {
      console.warn('Failed to cleanup motionDetector listeners', e);
    }

    // ========================================================================
    // CLEANUP REAPER INTERVAL
    // ========================================================================
    if (this._reaperInterval) {
      try {
        clearInterval(this._reaperInterval);
        this._reaperInterval = null;
        console.log('Reaper interval stopped');
      } catch (e) {
        console.warn('Failed to stop reaper interval:', e);
      }
    }

    if (this._reconStatusCleanupInterval) {
      try {
        clearInterval(this._reconStatusCleanupInterval);
        this._reconStatusCleanupInterval = null;
        console.log('reconStatus cleanup interval stopped');
      } catch (e) {
        console.warn('Failed to stop reconStatus cleanup interval:', e);
      }
    }

    if (this._coordCheckInterval) {
      try {
        clearInterval(this._coordCheckInterval);
        this._coordCheckInterval = null;
        console.log('StorageActivityCoordinator poll interval stopped');
      } catch (e) {
        console.warn('Failed to stop coordinator poll interval:', e);
      }
    }
    // ========================================================================
    
    // Detach eviction hook and terminate preprocessor worker (if present)
    if (this.evictionHook && typeof this.evictionHook.detach === 'function') {
      try { this.evictionHook.detach(); } catch (e) { console.warn('Error detaching eviction hook', e); }
      this.evictionHook = null;
    }

    if (this.preprocessor && this.preprocessor.worker) {
      try { this.preprocessor.worker.terminate(); } catch (e) { console.warn('Error terminating preprocessor worker', e); }
      this.preprocessor = null;
    }

    // Teardown MotionWorker and close BroadcastChannel
    try {
      this._teardownMotionWorker();
    } catch (e) {
      console.warn('Failed to teardown MotionWorker', e);
    }

    // Teardown topology worker (Stage 4A)
    if (this._topologyWorker) {
      try {
        this._topologyWorker.postMessage({ op: 'shutdown' });
      } catch (e) { /* ignore — worker may already be dead */ }
      try {
        this._topologyWorker.terminate();
      } catch (e) { /* ignore */ }
      this._topologyWorker = null;
      console.log('[Stage4A] main.js: topology.worker terminated');
    }

    // Teardown minimizer worker (Stage 4B)
    if (this._minimizerWorker) {
      try {
        this._minimizerWorker.postMessage({ op: 'shutdown' });
      } catch (e) { /* ignore — worker may already be dead */ }
      try {
        this._minimizerWorker.terminate();
      } catch (e) { /* ignore */ }
      this._minimizerWorker = null;
      console.log('[Stage4B] main.js: minimizer.worker terminated');
    }

    // Teardown ambi worker (Stage 5)
    if (this._ambiWorker) {
      try {
        this._ambiWorker.postMessage({ op: 'shutdown' });
      } catch (e) { /* ignore — worker may already be dead */ }
      try {
        this._ambiWorker.terminate();
      } catch (e) { /* ignore */ }
      this._ambiWorker = null;
      console.log('[Stage5] main.js: ambi.worker terminated');
    }

    // Teardown kem worker (Stage 6)
    if (this._kemWorker) {
      try {
        this._kemWorker.postMessage({ op: 'shutdown' });
      } catch (e) { /* ignore — worker may already be dead */ }
      try {
        this._kemWorker.terminate();
      } catch (e) { /* ignore */ }
      this._kemWorker = null;
      console.log('[Stage6] main.js: kem.worker terminated');
    }

    // Teardown correspondence worker (Stage 7)
    if (this._correspondenceWorker) {
      try {
        this._correspondenceWorker.postMessage({ op: 'shutdown' });
      } catch (e) { /* ignore — worker may already be dead */ }
      try {
        this._correspondenceWorker.terminate();
      } catch (e) { /* ignore */ }
      this._correspondenceWorker = null;
      console.log('[Stage7] main.js: correspondence.worker terminated');
    }

    try {
      if (this._bc) {
        try { this._bc.close(); } catch (e) {}
        this._bc = null;
      }
    } catch (e) {
      console.warn('Failed to close BroadcastChannel', e);
    }
    
    // Main intentionally does not hold calibration ImageBitmaps — nothing to close here.

    if (this.mediaInput) {
      this.mediaInput.destroy();
    }
    
    if (this.frameBuffer) {
      this.frameBuffer.destroy();
    }
    
    if (this.webglRenderer) {
      this.webglRenderer.destroy();
    }
    
    // Clear references
    this.hardwareLimitations = null;
    
    console.log('Motion Painter destroyed');
  }
}

// Application bootstrap
(async function() {
  const app = new MotionPainter();
  
  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => app.init());
  } else {
    await app.init();
  }
  
  // ============================================================================
  // ✅ ENHANCED: Clean up on page unload
  // ============================================================================
  window.addEventListener('beforeunload', () => {
    try {
      // Stop metrics timer first (prevents final persist attempt during teardown)
      if (app._stopMetricsTimer) {
        try {
          app._stopMetricsTimer();
          console.log('beforeunload: Metrics timer stopped');
        } catch (e) {
          console.warn('beforeunload: Failed to stop metrics timer', e);
        }
      }
      
      // Full app teardown
      app.destroy();
      
      console.log('beforeunload: Application cleanup complete');
      
    } catch (err) {
      console.error('beforeunload: Cleanup error', err);
      // Force destroy even on error
      try { app.destroy(); } catch (e) {}
    }
  });
  
// Export for debugging
  window.MotionPainter = app;
  
  // Debug helpers
  window.getAppStats = () => app.getApplicationStats();
  window.exportFrame = () => app.exportCurrentFrame();
  window.validateConfig = () => app.validateConfiguration();
  window.resetToOptimal = () => app.resetToOptimalSettings();
  
  // ============================================================================
  // ✅ NEW: Storage cleanup helpers for debug artifacts
  // ============================================================================
  /**
   * Clean up debug artifacts from storage (call from browser console)
   * 
   * Usage:
   *   await window.cleanupDebugArtifacts()           // All debug types
   *   await window.cleanupDebugArtifacts('motion_analysis')  // Specific type
   */
  window.cleanupDebugArtifacts = async (artifactType = null) => {
    try {
      if (typeof storageAPI === 'undefined') {
        console.error('storageAPI not available');
        return { error: 'storageAPI not available' };
      }
      
      const debugTypes = artifactType 
        ? [artifactType]
        : ['motion_analysis', 'motion_detector_metrics'];
      
      const results = {};
      let totalDeleted = 0;
      
      for (const type of debugTypes) {
        console.log(`Cleaning up artifacts of type: ${type}...`);
        
        // Query all artifacts of this type
        const artifacts = await storageAPI.queryArtifacts({ type });
        
        if (!artifacts || artifacts.length === 0) {
          console.log(`  No ${type} artifacts found`);
          results[type] = 0;
          continue;
        }
        
        console.log(`  Found ${artifacts.length} ${type} artifacts`);
        
        // Delete each artifact
        let deleted = 0;
        for (const artifact of artifacts) {
          try {
            await storageAPI.deleteArtifact(artifact.metaKey);
            deleted++;
          } catch (err) {
            console.warn(`  Failed to delete ${artifact.metaKey}:`, err);
          }
        }
        
        console.log(`  Deleted ${deleted}/${artifacts.length} ${type} artifacts`);
        results[type] = deleted;
        totalDeleted += deleted;
      }
      
      console.log(`Total cleanup: ${totalDeleted} debug artifacts deleted`);
      
      return {
        success: true,
        totalDeleted,
        byType: results
      };
      
    } catch (err) {
      console.error('Cleanup failed:', err);
      return {
        error: err.message,
        stack: err.stack
      };
    }
  };
  
  /**
   * Get storage usage breakdown by artifact type
   * 
   * Usage:
   *   await window.getStorageUsage()
   */
  window.getStorageUsage = async () => {
    try {
      if (typeof storageAPI === 'undefined') {
        console.error('storageAPI not available');
        return { error: 'storageAPI not available' };
      }
      
      const stats = await storageAPI.getStorageStats();
      
      console.log('Storage Usage:');
      console.log('  Total:', (stats.totalBytes / (1024 * 1024)).toFixed(2), 'MB');
      console.log('  Artifacts:', stats.artifactCount);
      console.log('  Pinned:', (stats.pinnedBytes / (1024 * 1024)).toFixed(2), 'MB');
      
      if (stats.byType) {
        console.log('  By Type:');
        Object.entries(stats.byType).forEach(([type, bytes]) => {
          console.log(`    ${type}: ${(bytes / (1024 * 1024)).toFixed(2)} MB`);
        });
      }
      
      return stats;
      
    } catch (err) {
      console.error('Failed to get storage usage:', err);
      return {
        error: err.message,
        stack: err.stack
      };
    }
  };
  
  console.log('💡 Debug helpers available:');
  console.log('  - await window.cleanupDebugArtifacts()  // Clean all debug artifacts');
  console.log('  - await window.getStorageUsage()        // Show storage breakdown');
})();
