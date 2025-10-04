// Import styles 
import '../styles/main.css';
import '../styles/controls.css';
import '../styles/layout.css';

// Import core modules
// near top imports
import { addFrameBufferDiagnostics, addWebGLRendererDiagnostics } from './core/diagnostics.js';
import { WebGLRenderer } from './core/webGLRenderer.js';
import { FrameBuffer } from './core/FrameBuffer.js';
import { MotionDetector } from './core/MotionDetector.js';
import { CompositeRenderer } from './core/CompositeRenderer.js';
import { FrameEvictionHook } from './core/FrameEvictionHook.js';
import { PreprocessorWorker } from './core/PreProcessorWorker.js';

// Import UI modules
import { Controls } from './ui/Controls.js';
import { MediaInput } from './ui/MediaInput.js';

// Import utilities
import { CONFIG, validateBufferSize } from './utils/MathUtils.js';

// Import storage API (storage.js exports storageAPI for main thread use)
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
    
    // Calibration state (main-side)
    // Note: the canonical persisted metaKey is owned/pinned by the worker when computeCalibration succeeds.
    // The wrapper (PreprocessorWorker instance) will also store the canonical metaKey in this.preprocessor.calibrationMetaKey
    this.calibration = {
      metaKey: null,     // canonical persisted calibration manifest key
      meta: null,        // calibration metadata (resolution/frameCount/version...)
      darkFrame: null,   // ImageBitmap (if worker returned it on compute)
      flatFrame: null    // ImageBitmap (if worker returned it on compute)
      // Note: bias buffer (Float32Array) is intentionally NOT stored here unless explicitly fetched from storage
    };
    
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
        this.preprocessor = new PreprocessorWorker('./core/preprocessor.worker.js');

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
      
      const statusElement = document.getElementById('status');
      this.mediaInput = new MediaInput(this.video, statusElement);
      
      // Set up event handlers
      this.setupEventHandlers();
      
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
      
      // Expose calibration helpers for debugging / UI (optional)
      window.fetchCalibrationBias = (metaKey) => this.getCalibrationBias(metaKey);
      window.loadPersistedCalibrationImages = (metaKey) => this.loadPersistedCalibrationImages(metaKey);
      window.clearCalibration = () => this.clearCalibration();
      
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
      calibrationMetaKey: this.preprocessor ? this.preprocessor.calibrationMetaKey : (this.calibration.metaKey || null)
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

  // ------------------ CALIBRATION: main-thread helpers ------------------

  /**
   * requestCalibrationFromWorker(frames, framesNeeded, resolution)
   *
   * Ask the preprocessor wrapper to compute a calibration set.
   * NOTE: ImageBitmaps passed in `frames` will be **transferred** to the worker (become unusable here).
   *
   * On success the wrapper resolves with { darkFrame, flatFrame, meta }.
   * The wrapper also stores the canonical persisted metaKey (if persisted) on
   * preprocessor.calibrationMetaKey (set from the worker's calibration:ready message).
   */
  async requestCalibrationFromWorker(frames, framesNeeded = 10, resolution) {
    if (!this.preprocessor) {
      throw new Error('Preprocessor not initialized');
    }
    try {
      // This will transfer the ImageBitmaps into the worker.
      const result = await this.preprocessor.requestCalibration(frames, framesNeeded, resolution);
      // The wrapper has already set this.preprocessor.calibrationMetaKey (if persistence happened)
      this.calibration.darkFrame = result.darkFrame || null;
      this.calibration.flatFrame = result.flatFrame || null;
      this.calibration.meta = result.meta || null;
      this.calibration.metaKey = this.preprocessor.calibrationMetaKey || null;

      console.log('Main: Calibration computed. metaKey=', this.calibration.metaKey, 'meta=', this.calibration.meta);

      // IMPORTANT: do not fetch bias buffer here. If the main or renderer needs it, call getCalibrationBias(metaKey).
      return {
        darkFrame: this.calibration.darkFrame,
        flatFrame: this.calibration.flatFrame,
        meta: this.calibration.meta,
        metaKey: this.calibration.metaKey
      };

    } catch (err) {
      console.error('Main: requestCalibrationFromWorker failed', err);
      throw err;
    }
  }

  /**
   * loadPersistedCalibrationImages(metaKey)
   *
   * If you only have a persisted metaKey and want the dark/flat bitmaps locally in main,
   * load them from storage directly (the worker stores dark/flat as blobs).
   *
   * Returns: { darkFrame: ImageBitmap|null, flatFrame: ImageBitmap|null, meta }
   */
  async loadPersistedCalibrationImages(metaKey = null) {
    try {
      const key = metaKey || (this.calibration.metaKey || (this.preprocessor && this.preprocessor.calibrationMetaKey));
      if (!key) throw new Error('No calibration metaKey provided');

      // Get manifest artifact
      const metaArt = await storageAPI.getArtifact(key);
      if (!metaArt || !metaArt.data) {
        throw new Error(`Calibration manifest not found for key ${key}`);
      }

      const { darkKey, flatKey } = metaArt.data;

      // Fetch dark/flat artifacts
      const darkArt = darkKey ? await storageAPI.getArtifact(darkKey) : null;
      const flatArt = flatKey ? await storageAPI.getArtifact(flatKey) : null;

      const darkBitmap = (darkArt && darkArt.blob) ? await createImageBitmap(darkArt.blob) : null;
      const flatBitmap = (flatArt && flatArt.blob) ? await createImageBitmap(flatArt.blob) : null;

      // store locally for main/UI use (don't store bias)
      this.calibration.darkFrame = darkBitmap;
      this.calibration.flatFrame = flatBitmap;
      this.calibration.meta = metaArt.data;
      this.calibration.metaKey = key;

      console.log('Main: Loaded persisted calibration images for', key);
      return { darkFrame: darkBitmap, flatFrame: flatBitmap, meta: metaArt.data };

    } catch (err) {
      console.error('Main: loadPersistedCalibrationImages failed', err);
      throw err;
    }
  }

  /**
   * getCalibrationBias(metaKey)
   *
   * If you need the bias normalization array (Float32Array), fetch it from storage.
   * - This intentionally fetches the bias blob and converts to Float32Array on main thread.
   *
   * Returns Float32Array or null if not present.
   */
  async getCalibrationBias(metaKey = null) {
    try {
      const key = metaKey || (this.calibration.metaKey || (this.preprocessor && this.preprocessor.calibrationMetaKey));
      if (!key) throw new Error('No calibration metaKey provided');

      // read manifest
      const metaArt = await storageAPI.getArtifact(key);
      if (!metaArt || !metaArt.data) throw new Error('Calibration manifest not found');

      const biasKey = metaArt.data.biasKey;
      if (!biasKey) {
        console.warn('Main: No biasKey present in calibration meta');
        return null;
      }

      const biasArt = await storageAPI.getArtifact(biasKey);
      if (!biasArt || !biasArt.blob) {
        console.warn('Main: bias artifact missing for key', biasKey);
        return null;
      }

      const ab = await biasArt.blob.arrayBuffer();
      const biasArray = new Float32Array(ab);
      return biasArray;

    } catch (err) {
      console.error('Main: getCalibrationBias failed', err);
      throw err;
    }
  }

  /**
   * clearCalibration()
   *
   * Clear/close any ImageBitmaps held by main for calibration and request worker invalidate.
   * Worker will attempt to unpin the persisted metaKey when it is safe (deferred if necessary).
   */
  async clearCalibration() {
    try {
      // Close any ImageBitmaps main holds
      try {
        if (this.calibration.darkFrame) { this.calibration.darkFrame.close(); }
      } catch (_) {}
      try {
        if (this.calibration.flatFrame) { this.calibration.flatFrame.close(); }
      } catch (_) {}

      this.calibration.darkFrame = null;
      this.calibration.flatFrame = null;
      this.calibration.meta = null;
      // Do not locally unpin; worker owns pin and will unpin on invalidate (deferred if required)
      this.calibration.metaKey = null;

      if (this.compositeRenderer) this.compositeRenderer.clearCalibration();

      if (this.preprocessor) {
        this.preprocessor.invalidateCalibration(); // instruct worker to unpin/invalidate (worker defers if frames in-flight)
      }

      console.log('Main: Cleared main-side calibration and requested worker invalidation');
    } catch (err) {
      console.warn('Main: clearCalibration error', err);
    }
  }

  // ------------------ end calibration helpers ------------------

  destroy() {
    this.stopRendering();
    
    // Detach eviction hook and terminate preprocessor worker (if present)
    if (this.evictionHook && typeof this.evictionHook.detach === 'function') {
      try { this.evictionHook.detach(); } catch (e) { console.warn('Error detaching eviction hook', e); }
      this.evictionHook = null;
    }

    if (this.preprocessor && this.preprocessor.worker) {
      try { this.preprocessor.worker.terminate(); } catch (e) { console.warn('Error terminating preprocessor worker', e); }
      this.preprocessor = null;
    }
    
    // Release main-held calibration bitmaps
    try {
      if (this.calibration.darkFrame) this.calibration.darkFrame.close();
    } catch (e) {}
    try {
      if (this.calibration.flatFrame) this.calibration.flatFrame.close();
    } catch (e) {}
    this.calibration = { metaKey: null, meta: null, darkFrame: null, flatFrame: null };

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
