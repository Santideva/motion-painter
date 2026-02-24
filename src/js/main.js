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

// Import storage API (main may still use storageAPI for other needs)
import storageAPI from './core/storage.js';

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
    this.motionWorker = null;
    this._heavyPathRequested = false;
    this.cameraContainer = null;
    // BroadcastChannel used for cross-worker signaling (listen for release_request etc.)
    this._bc = null;

    // IMPORTANT: main no longer keeps calibration artifacts or bias arrays.
    // The canonical persisted metaKey and tokens are owned/pinned by the preprocessor.worker.
    // Main's role: detect the need for calibration and instruct preprocessor to compute it.
    
    // Track unsubscribers for MotionDetector listeners so we can clean them up on destroy()
    this._motionDetectorUnsubs = [];

    this.isRendering = false;
    this.isPaused = false;
    this.animationId = null;
    this.hardwareLimitations = null; // Track hardware constraints
  }
  
  async init() {
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
          quota: 500 * 1024 * 1024,  // 500MB
          startEvictor: true 
        });
        
        // Start periodic reaper for stale reconstruction jobs
        this._reaperInterval = setInterval(async () => {
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
      };
      
      // Set up event handlers
      this.setupEventHandlers();

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
          }
          // --- End Stage 0 RECON_DONE handler ---
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
        // Await processing of current video frame (upload + buffer management + render)
        await this.compositeRenderer.processFrame(this.video);
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

    const merged = Object.freeze({
      ...current,

      differentialGeometry: updates.differentialGeometry
        ? Object.freeze({
            ...current.differentialGeometry,
            ...updates.differentialGeometry
          })
        : current.differentialGeometry,

      plenopticSampling: updates.plenopticSampling
        ? Object.freeze({
            ...current.plenopticSampling,
            ...updates.plenopticSampling
          })
        : current.plenopticSampling,

      ambiFrame: updates.ambiFrame
        ? Object.freeze({
            ...current.ambiFrame,
            ...updates.ambiFrame
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
        timeoutMs: 30_000,
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
