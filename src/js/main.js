// Import styles
import '../styles/main.css';
import '../styles/controls.css';
import '../styles/layout.css';

// Import core modules
import { WebGLRenderer } from './core/WebGLRenderer.js';
import { FrameBuffer } from './core/FrameBuffer.js';
import { MotionDetector } from './core/MotionDetector.js';
import { CompositeRenderer } from './core/CompositeRenderer.js';

// Import UI modules
import { Controls } from './ui/Controls.js';
import { MediaInput } from './ui/MediaInput.js';

// Import utilities
import { CONFIG, validateBufferSize } from './utils/MathUtils.js';

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
      
      // Check hardware capabilities immediately after WebGL initialization
      this.hardwareLimitations = this.webglRenderer.getCapabilities();
      
      // Validate and adjust initial buffer size based on hardware
      const validation = validateBufferSize(CONFIG.DEFAULT_BUFFER_SIZE);
      const initialBufferSize = validation.clampedSize;
      
      this.frameBuffer = new FrameBuffer(this.webglRenderer.gl, initialBufferSize);
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
    
    const { width, height } = this.webglRenderer.resizeCanvas(this.video);
    this.frameBuffer.resize(width, height);
    
    // Update memory usage display after resize
    this.controls.updateBufferInfo();
    
    console.log(`Canvas resized to ${width}x${height}`);
  }
  
  renderLoop() {
    if (!this.isRendering) {
      return;
    }
    
    if (!this.isPaused && this.mediaInput.isVideoReady()) {
      try {
        // Process current video frame
        this.compositeRenderer.processFrame(this.video);
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
      memoryUsage: this.getMemoryUsage()
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
  
  destroy() {
    this.stopRendering();
    
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