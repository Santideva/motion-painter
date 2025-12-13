// Import styles 
import '../styles/main.css';
import '../styles/controls.css';
import '../styles/layout.css';

// Import core modules
import featureFlags from '../config/featureFlags.js';
import { addFrameBufferDiagnostics, addWebGLRendererDiagnostics } from './core/diagnostics.js';
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
        
        // create and attach the eviction hook (FrameEvictionHook is defensive if frameBuffer is null)
        this.evictionHook = new FrameEvictionHook(this.preprocessor);
        this.evictionHook.attach(this.frameBuffer);
        console.log('Eviction hook attached to FrameBuffer');
      } catch (err) {
        console.error('Failed to initialize preprocessor/eviction hook:', err);
        // keep app running — preprocessor is optional for rendering
        this.preprocessor = null;
        this.evictionHook = null;
      }
      
      this.motionDetector = new MotionDetector();
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
      
      const statusElement = document.getElementById('status');
      this.mediaInput = new MediaInput(this.video, statusElement);
      
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
        });
      } catch (e) {
        console.warn('Main: failed to create BroadcastChannel for orchestration', e);
        this._bc = null;
      }

      // Set up MotionDetector -> Main calibration orchestration (main only orchestrates; it won't store artifacts)
      this.setupCalibrationOrchestration();

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
   * Ensure MotionWorker exists and is minimally initialized so it can listen/ query storage.
   * We create a MotionWorkerWrapper which manages the worker lifecycle and communications.
   * This is non-blocking: we create the wrapper and attach basic handlers so it can listen on BC.
   */
  _ensureMotionWorker() {
    if (this.motionWorker) return;

    try {
      // Instantiate the wrapper which will create the underlying worker.
      // Use absolute path that maps to project layout so the wrapper can resolve URL reliably.
      this.motionWorker = new MotionWorkerWrapper('/src/js/core/motion.worker.js', { readyTimeoutMs: 8000 });

      // Minimal ready hook so we can log; wrapper will broadcast flags when it becomes ready.
      try {
        this.motionWorker.onReady(() => {
          try {
            console.log('MotionPainter: MotionWorkerWrapper is ready');
            // optionally request metrics to warm the worker
            try {
              this.motionWorker.requestMetrics().then(m => {
                if (m) console.debug('MotionWorker metrics:', m);
              }).catch(() => {});
            } catch (e) {}
          } catch (e) {
            console.warn('MotionPainter: motionWorker onReady handler error', e);
          }
        });
      } catch (e) {
        // ignore if onReady isn't present (defensive)
      }

      // Note: we intentionally do not send any calibration/artifacts from main.
      // MotionWorker will use the BroadcastChannel or storage API to obtain persisted artifacts.

      console.log('MotionPainter: MotionWorkerWrapper created (non-blocking)');
    } catch (err) {
      console.error('MotionPainter: Failed to create MotionWorkerWrapper', err);
      try { if (this.motionWorker && typeof this.motionWorker.terminate === 'function') this.motionWorker.terminate(); } catch (_) {}
      this.motionWorker = null;
    }
  }

  /**
   * Teardown MotionWorker if present (called during destroy)
   */
  _teardownMotionWorker() {
    try {
      if (this.motionWorker) {
        // prefer wrapper terminate if available
        try {
          if (typeof this.motionWorker.terminate === 'function') {
            // terminate may be async — call but do not await in destroy path
            try { this.motionWorker.terminate(); } catch (e) {}
          } else {
            // fallback for older raw worker usage (unlikely)
            try { if (this.motionWorker.postMessage) this.motionWorker.postMessage({ op: 'shutdown' }); } catch (e) {}
            try { if (this.motionWorker.terminate) this.motionWorker.terminate(); } catch (e) {}
          }
        } catch (e) {
          console.warn('MotionPainter: error terminating motionWorker', e);
        }
        this.motionWorker = null;
      }
    } catch (err) {
      console.warn('MotionPainter: error tearing down MotionWorker', err);
      this.motionWorker = null;
    }
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
  
  // Clean up on page unload
  window.addEventListener('beforeunload', () => {
    app.destroy();
  });
  
  // Export for debugging
  window.MotionPainter = app;
  
  // Debug helpers
  window.getAppStats = () => app.getApplicationStats();
  window.exportFrame = () => app.exportCurrentFrame();
  window.validateConfig = () => app.validateConfiguration();
  window.resetToOptimal = () => app.resetToOptimalSettings();
})();
