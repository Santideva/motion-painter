import { CONFIG, getBufferSizeRecommendations, calculateBufferMemoryUsage, validateBufferSize } from '../utils/MathUtils.js';

export class Controls {
  constructor() {
    this.elements = {};
    this.callbacks = {};
    this.isInitialized = false;
    
    this.params = {
      bufferSize: CONFIG.DEFAULT_BUFFER_SIZE,
      spiralRetention: true,
      timeShift: 1,
      opacity: 0.6,
      invert: true,
      rOff: 1,
      gOff: 2,
      bOff: 3,
      motionThresh: 0.08,
      glow: 0.9
    };

    // Optional fields for real measured video/canvas size
    this.videoWidth = null;
    this.videoHeight = null;

    // Viewport control state
    this.viewportState = {
      size: 'fit', // 'small', 'medium', 'large', 'fit', 'fullscreen'
      panelsVisible: true,
      panelsCollapsed: false
    };
  }
  
  init() {
    if (this.isInitialized) return;
    
    // Cache DOM elements
    this.elements = {
      // Viewport controls
      viewportControls: document.getElementById('viewportControls'),
      viewportToggle: document.getElementById('viewportToggle'),
      viewportSize: document.getElementById('viewportSize'),
      panelsToggle: document.getElementById('panelsToggle'),
      fullscreenToggle: document.getElementById('fullscreenToggle'),
      
      // Buffer controls
      bufferSize: document.getElementById('bufferSize'),
      bufferSizeVal: document.getElementById('bufferSizeVal'),
      spiralRetention: document.getElementById('spiralRetention'),
      bufferMemory: document.getElementById('bufferMemory'),
      bufferPreset: document.getElementById('bufferPreset'),
      maxTimeShift: document.getElementById('maxTimeShift'),
      
      // Existing controls
      timeShift: document.getElementById('timeShift'),
      timeShiftVal: document.getElementById('timeShiftVal'),
      opacity: document.getElementById('opacity'),
      invert: document.getElementById('invert'),
      rOff: document.getElementById('rOff'),
      gOff: document.getElementById('gOff'),
      bOff: document.getElementById('bOff'),
      rVal: document.getElementById('rVal'),
      gVal: document.getElementById('gVal'),
      bVal: document.getElementById('bVal'),
      motionThresh: document.getElementById('motionThresh'),
      glow: document.getElementById('glow'),
      startCam: document.getElementById('startCam'),
      useVideo: document.getElementById('useVideo'),
      showMotion: document.getElementById('showMotion'),
      pauseBtn: document.getElementById('pauseBtn'),
      status: document.getElementById('status')
    };
    
    this.initViewportControls();
    this.bindEvents();
    this.updateDisplayValues();
    this.updateBufferInfo();
    
    this.isInitialized = true;
  }

  initViewportControls() {
    // Create viewport controls if not present
    if (!this.elements.viewportControls) {
      this.createViewportControls();
    }
    
    // Set initial viewport state
    this.applyViewportSize(this.viewportState.size);
  }

  createViewportControls() {
    // Find a suitable parent (controls container or body)
    const controlsContainer = document.querySelector('.controls') || document.body;
    
    // Create viewport controls container
    const viewportDiv = document.createElement('div');
    viewportDiv.id = 'viewportControls';
    viewportDiv.className = 'control viewport-controls collapsed';
    
    viewportDiv.innerHTML = `
      <div class="viewport-header" id="viewportToggle">
        <label>Viewport <span class="toggle-icon">▼</span></label>
      </div>
      <div class="viewport-content">
        <div class="row">
          <select id="viewportSize">
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large</option>
            <option value="fit" selected>Fit</option>
          </select>
          <button id="panelsToggle" class="compact">Hide Panels</button>
          <button id="fullscreenToggle" class="compact">Fullscreen</button>
        </div>
      </div>
    `;
    
    // Insert at top of controls
    controlsContainer.insertBefore(viewportDiv, controlsContainer.firstChild);
    
    // Update element references
    this.elements.viewportControls = viewportDiv;
    this.elements.viewportToggle = document.getElementById('viewportToggle');
    this.elements.viewportSize = document.getElementById('viewportSize');
    this.elements.panelsToggle = document.getElementById('panelsToggle');
    this.elements.fullscreenToggle = document.getElementById('fullscreenToggle');
  }
  
  bindEvents() {
    // Viewport control events
    if (this.elements.viewportToggle) {
      this.elements.viewportToggle.onclick = () => {
        this.toggleViewportControls();
      };
    }

    if (this.elements.viewportSize) {
      this.elements.viewportSize.onchange = () => {
        const size = this.elements.viewportSize.value;
        this.setViewportSize(size);
      };
    }

    if (this.elements.panelsToggle) {
      this.elements.panelsToggle.onclick = () => {
        this.togglePanels();
      };
    }

    if (this.elements.fullscreenToggle) {
      this.elements.fullscreenToggle.onclick = () => {
        this.toggleFullscreen();
      };
    }

    // Buffer size controls
    if (this.elements.bufferSize) {
      this.elements.bufferSize.oninput = () => {
        const newSize = parseInt(this.elements.bufferSize.value);
        const validation = validateBufferSize(newSize);
        
        this.params.bufferSize = validation.clampedSize;
        if (this.elements.bufferSizeVal) this.elements.bufferSizeVal.textContent = this.params.bufferSize;
        this.updateBufferInfo();
        this.updateTimeShiftLimits();
        this.notifyChange('bufferSize', this.params.bufferSize);
        
        if (validation.warning) {
          this.showWarning(validation.warning);
        }
      };
    }
    
    if (this.elements.spiralRetention) {
      this.elements.spiralRetention.onchange = () => {
        this.params.spiralRetention = this.elements.spiralRetention.checked;
        this.notifyChange('spiralRetention', this.params.spiralRetention);
      };
    }
    
    if (this.elements.bufferPreset) {
      this.elements.bufferPreset.onchange = () => {
        const presetSize = parseInt(this.elements.bufferPreset.value);
        if (presetSize > 0) {
          this.setBufferSize(presetSize);
        }
      };
    }
    
    // Existing range inputs with live value display
    if (this.elements.timeShift) {
      this.elements.timeShift.oninput = () => {
        const maxTimeShift = Math.min(parseInt(this.elements.timeShift.max), this.params.bufferSize - 1);
        this.params.timeShift = Math.min(parseInt(this.elements.timeShift.value), maxTimeShift);
        this.elements.timeShift.value = this.params.timeShift; // Ensure UI reflects clamped value
        if (this.elements.timeShiftVal) {
          this.elements.timeShiftVal.textContent = this.params.timeShift;
        }
        this.notifyChange('timeShift', this.params.timeShift);
      };
    }
    
    if (this.elements.opacity) {
      this.elements.opacity.oninput = () => {
        this.params.opacity = parseFloat(this.elements.opacity.value);
        this.notifyChange('opacity', this.params.opacity);
      };
    }
    
    if (this.elements.invert) {
      this.elements.invert.onchange = () => {
        this.params.invert = this.elements.invert.checked;
        this.notifyChange('invert', this.params.invert);
      };
    }
    
    if (this.elements.rOff) {
      this.elements.rOff.oninput = () => {
        const maxOffset = this.params.bufferSize - 1;
        this.params.rOff = Math.min(parseInt(this.elements.rOff.value), maxOffset);
        this.elements.rOff.value = this.params.rOff;
        if (this.elements.rVal) {
          this.elements.rVal.textContent = this.params.rOff;
        }
        this.notifyChange('rOff', this.params.rOff);
      };
    }
    
    if (this.elements.gOff) {
      this.elements.gOff.oninput = () => {
        const maxOffset = this.params.bufferSize - 1;
        this.params.gOff = Math.min(parseInt(this.elements.gOff.value), maxOffset);
        this.elements.gOff.value = this.params.gOff;
        if (this.elements.gVal) {
          this.elements.gVal.textContent = this.params.gOff;
        }
        this.notifyChange('gOff', this.params.gOff);
      };
    }
    
    if (this.elements.bOff) {
      this.elements.bOff.oninput = () => {
        const maxOffset = this.params.bufferSize - 1;
        this.params.bOff = Math.min(parseInt(this.elements.bOff.value), maxOffset);
        this.elements.bOff.value = this.params.bOff;
        if (this.elements.bVal) {
          this.elements.bVal.textContent = this.params.bOff;
        }
        this.notifyChange('bOff', this.params.bOff);
      };
    }
    
    if (this.elements.motionThresh) {
      this.elements.motionThresh.oninput = () => {
        this.params.motionThresh = parseFloat(this.elements.motionThresh.value);
        this.notifyChange('motionThresh', this.params.motionThresh);
      };
    }
    
    if (this.elements.glow) {
      this.elements.glow.oninput = () => {
        this.params.glow = parseFloat(this.elements.glow.value);
        this.notifyChange('glow', this.params.glow);
      };
    }
    
    // Button events
    if (this.elements.startCam) {
      this.elements.startCam.onclick = () => {
        this.notifyAction('startCamera');
      };
    }
    
    if (this.elements.useVideo) {
      this.elements.useVideo.onclick = () => {
        this.notifyAction('loadVideo');
      };
    }
    
    if (this.elements.showMotion) {
      this.elements.showMotion.onclick = () => {
        this.notifyAction('toggleMotionMask');
      };
    }
    
    if (this.elements.pauseBtn) {
      this.elements.pauseBtn.onclick = () => {
        this.notifyAction('togglePause');
      };
    }
    
    // Keyboard shortcuts
    this.bindKeyboardEvents();
  }
  
  bindKeyboardEvents() {
    window.addEventListener('keydown', (e) => {
      switch (e.key) {
        case ' ':
          e.preventDefault();
          this.notifyAction('togglePause');
          break;
        case 'm':
        case 'M':
          this.notifyAction('toggleMotionMask');
          break;
        case 'c':
        case 'C':
          this.notifyAction('startCamera');
          break;
        case 'v':
        case 'V':
          this.notifyAction('loadVideo');
          break;
        case 'r':
        case 'R':
          this.resetToDefaults();
          break;
        case 's':
        case 'S':
          if (e.ctrlKey) {
            e.preventDefault();
            this.toggleSpiralRetention();
          }
          break;
        case '=':
        case '+':
          if (e.ctrlKey) {
            e.preventDefault();
            this.adjustBufferSize(1);
          }
          break;
        case '-':
        case '_':
          if (e.ctrlKey) {
            e.preventDefault();
            this.adjustBufferSize(-1);
          }
          break;
        // Viewport keyboard shortcuts
        case '1':
          if (e.ctrlKey) {
            e.preventDefault();
            this.setViewportSize('small');
          }
          break;
        case '2':
          if (e.ctrlKey) {
            e.preventDefault();
            this.setViewportSize('medium');
          }
          break;
        case '3':
          if (e.ctrlKey) {
            e.preventDefault();
            this.setViewportSize('large');
          }
          break;
        case '0':
          if (e.ctrlKey) {
            e.preventDefault();
            this.setViewportSize('fit');
          }
          break;
        case 'h':
        case 'H':
          if (e.ctrlKey) {
            e.preventDefault();
            this.togglePanels();
          }
          break;
        case 'f':
        case 'F':
          if (e.ctrlKey && e.shiftKey) {
            e.preventDefault();
            this.toggleFullscreen();
          }
          break;
      }
    });
  }

  // Viewport control methods
  toggleViewportControls() {
    if (!this.elements.viewportControls) return;
    
    const isCollapsed = this.elements.viewportControls.classList.contains('collapsed');
    
    if (isCollapsed) {
      this.elements.viewportControls.classList.remove('collapsed');
      this.elements.viewportToggle.querySelector('.toggle-icon').textContent = '▲';
    } else {
      this.elements.viewportControls.classList.add('collapsed');
      this.elements.viewportToggle.querySelector('.toggle-icon').textContent = '▼';
    }
  }

  setViewportSize(size) {
    this.viewportState.size = size;
    
    if (this.elements.viewportSize) {
      this.elements.viewportSize.value = size;
    }
    
    this.applyViewportSize(size);
    this.notifyChange('viewportSize', size);
  }

  applyViewportSize(size) {
    const wrap = document.querySelector('.wrap');
    const canvasPanel = document.querySelector('.canvas-panel');
    const controls = document.querySelector('.controls');
    
    if (!wrap || !canvasPanel) return;
    
    // Remove existing viewport classes
    wrap.classList.remove('viewport-small', 'viewport-medium', 'viewport-large', 'viewport-fit', 'viewport-fullscreen');
    
    // Apply new viewport class
    switch (size) {
      case 'small':
        wrap.classList.add('viewport-small');
        break;
      case 'medium':
        wrap.classList.add('viewport-medium');
        break;
      case 'large':
        wrap.classList.add('viewport-large');
        break;
      case 'fit':
        wrap.classList.add('viewport-fit');
        break;
      case 'fullscreen':
        wrap.classList.add('viewport-fullscreen');
        break;
    }
    
    // Trigger resize event for canvas
    this.notifyAction('viewportResize');
  }

  togglePanels() {
    this.viewportState.panelsVisible = !this.viewportState.panelsVisible;
    
    const controls = document.querySelector('.controls');
    if (!controls) return;
    
    if (this.viewportState.panelsVisible) {
      controls.classList.remove('hidden');
      if (this.elements.panelsToggle) {
        this.elements.panelsToggle.textContent = 'Hide Panels';
      }
    } else {
      controls.classList.add('hidden');
      if (this.elements.panelsToggle) {
        this.elements.panelsToggle.textContent = 'Show Panels';
      }
    }
    
    this.notifyAction('viewportResize');
  }

  toggleFullscreen() {
    if (this.viewportState.size === 'fullscreen') {
      this.setViewportSize('fit');
    } else {
      this.viewportState.size = 'fullscreen';
      this.applyViewportSize('fullscreen');
      
      // Also hide panels in fullscreen
      if (this.viewportState.panelsVisible) {
        this.togglePanels();
      }
    }
    
    if (this.elements.fullscreenToggle) {
      this.elements.fullscreenToggle.textContent = 
        this.viewportState.size === 'fullscreen' ? 'Exit Fullscreen' : 'Fullscreen';
    }
  }
  
  setBufferSize(size) {
    const validation = validateBufferSize(size);
    this.params.bufferSize = validation.clampedSize;
    
    if (this.elements.bufferSize) {
      this.elements.bufferSize.value = this.params.bufferSize;
    }
    
    this.updateDisplayValues();
    this.updateBufferInfo();
    this.updateTimeShiftLimits();
    this.notifyChange('bufferSize', this.params.bufferSize);
    
    if (validation.warning) {
      this.showWarning(validation.warning);
    }
  }
  
  adjustBufferSize(delta) {
    const newSize = this.params.bufferSize + delta;
    this.setBufferSize(newSize);
  }
  
  toggleSpiralRetention() {
    this.params.spiralRetention = !this.params.spiralRetention;
    if (this.elements.spiralRetention) {
      this.elements.spiralRetention.checked = this.params.spiralRetention;
    }
    this.notifyChange('spiralRetention', this.params.spiralRetention);
  }
  
  updateTimeShiftLimits() {
    const maxTimeShift = this.params.bufferSize - 1;
    
    // Update time shift control limits
    if (this.elements.timeShift) {
      this.elements.timeShift.max = maxTimeShift;
      if (this.params.timeShift > maxTimeShift) {
        this.params.timeShift = maxTimeShift;
        this.elements.timeShift.value = this.params.timeShift;
        this.notifyChange('timeShift', this.params.timeShift);
      }
    }
    
    // Update color offset limits
    ['rOff', 'gOff', 'bOff'].forEach(param => {
      if (this.elements[param]) {
        this.elements[param].max = maxTimeShift;
        if (this.params[param] > maxTimeShift) {
          this.params[param] = maxTimeShift;
          this.elements[param].value = this.params[param];
          this.notifyChange(param, this.params[param]);
        }
      }
    });
    
    // Update display of max time shift
    if (this.elements.maxTimeShift) {
      this.elements.maxTimeShift.textContent = this.params.bufferSize;
    }
  }
  
  /**
   * updateBufferInfo now accepts width/height to show real memory usage
   */
  updateBufferInfo(width = null, height = null) {
    // Prefer stored video/canvas size if present
    if (!width && this.videoWidth && this.videoHeight) {
      width = this.videoWidth;
      height = this.videoHeight;
    }
    width = width || CONFIG.DEFAULT_RESOLUTION.width;
    height = height || CONFIG.DEFAULT_RESOLUTION.height;

    if (this.elements.bufferMemory) {
      const memoryUsage = calculateBufferMemoryUsage(this.params.bufferSize, width, height);
      this.elements.bufferMemory.innerHTML = `
        <span class="memory-usage ${memoryUsage.recommendation}">
          ${memoryUsage.totalMB} MB
        </span>
        <span class="memory-detail">
          (${memoryUsage.bytesPerFrame} bytes/frame)
        </span>
      `;
    }
  }
  
  updateDisplayValues() {
    if (this.elements.bufferSizeVal) {
      this.elements.bufferSizeVal.textContent = this.params.bufferSize;
    }
    
    if (this.elements.timeShiftVal) {
      this.elements.timeShiftVal.textContent = this.params.timeShift;
    }
    
    if (this.elements.rVal) {
      this.elements.rVal.textContent = this.params.rOff;
    }
    
    if (this.elements.gVal) {
      this.elements.gVal.textContent = this.params.gOff;
    }
    
    if (this.elements.bVal) {
      this.elements.bVal.textContent = this.params.bOff;
    }
  }
  
  updatePauseButton(isPaused) {
    if (this.elements.pauseBtn) {
      this.elements.pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
    }
  }
  
  updateMotionButton(showMotion) {
    if (this.elements.showMotion) {
      this.elements.showMotion.textContent = showMotion ? 'Show composited' : 'Toggle motion mask';
    }
  }
  
  updateStatus(message) {
    if (this.elements.status) {
      this.elements.status.textContent = message;
    }
  }
  
  showWarning(message) {
    // Create temporary warning display
    const warningEl = document.createElement('div');
    warningEl.className = 'buffer-warning';
    warningEl.textContent = message;
    
    if (this.elements.bufferSize && this.elements.bufferSize.parentNode) {
      this.elements.bufferSize.parentNode.appendChild(warningEl);
      setTimeout(() => {
        if (warningEl.parentNode) {
          warningEl.parentNode.removeChild(warningEl);
        }
      }, 3000);
    }
  }
  
  resetToDefaults() {
    this.params = {
      bufferSize: CONFIG.DEFAULT_BUFFER_SIZE,
      spiralRetention: true,
      timeShift: 1,
      opacity: 0.6,
      invert: true,
      rOff: 1,
      gOff: 2,
      bOff: 3,
      motionThresh: 0.08,
      glow: 0.9
    };
    
    // Update UI elements
    if (this.elements.bufferSize) this.elements.bufferSize.value = this.params.bufferSize;
    if (this.elements.spiralRetention) this.elements.spiralRetention.checked = this.params.spiralRetention;
    
    if (this.elements.timeShift) this.elements.timeShift.value = this.params.timeShift;
    if (this.elements.opacity) this.elements.opacity.value = this.params.opacity;
    if (this.elements.invert) this.elements.invert.checked = this.params.invert;
    if (this.elements.rOff) this.elements.rOff.value = this.params.rOff;
    if (this.elements.gOff) this.elements.gOff.value = this.params.gOff;
    if (this.elements.bOff) this.elements.bOff.value = this.params.bOff;
    if (this.elements.motionThresh) this.elements.motionThresh.value = this.params.motionThresh;
    if (this.elements.glow) this.elements.glow.value = this.params.glow;
    
    this.updateDisplayValues();
    this.updateBufferInfo();
    this.updateTimeShiftLimits();
    this.notifyChange('reset', this.params);
  }
  
  // Event system
  on(event, callback) {
    if (!this.callbacks[event]) {
      this.callbacks[event] = [];
    }
    this.callbacks[event].push(callback);
  }
  
  notifyChange(param, value) {
    this.notify('paramChange', { param, value, allParams: this.params });
  }
  
  notifyAction(action) {
    this.notify('action', { action });
  }
  
  notify(event, data) {
    if (this.callbacks[event]) {
      this.callbacks[event].forEach(callback => callback(data));
    }
  }
  
  getParams() {
    return { ...this.params };
  }
  
  setParam(param, value) {
    if (param in this.params) {
      this.params[param] = value;
      
      // Update corresponding UI element
      if (this.elements[param]) {
        if (this.elements[param].type === 'checkbox') {
          this.elements[param].checked = value;
        } else {
          this.elements[param].value = value;
        }
      }
      
      this.updateDisplayValues();
      
      if (param === 'bufferSize') {
        this.updateBufferInfo();
        this.updateTimeShiftLimits();
      }
    }
  }
  
  // Get buffer size recommendations for UI
  getBufferRecommendations() {
    return getBufferSizeRecommendations();
  }
  
  // Additional helper methods for advanced buffer management
  
  /**
   * Get current buffer configuration summary
   * @returns {Object} Buffer configuration info
   */
  getBufferConfiguration() {
    return {
      size: this.params.bufferSize,
      spiralRetention: this.params.spiralRetention,
      memoryUsage: calculateBufferMemoryUsage(this.params.bufferSize),
      temporalOffsets: {
        timeShift: this.params.timeShift,
        colorOffsets: {
          r: this.params.rOff,
          g: this.params.gOff,
          b: this.params.bOff
        }
      }
    };
  }

  /**
   * Get current viewport configuration
   * @returns {Object} Viewport state info
   */
  getViewportConfiguration() {
    return {
      ...this.viewportState
    };
  }
  
  /**
   * Apply a buffer preset configuration
   * @param {string} presetName - Name of preset (minimal, standard, enhanced, maximum)
   */
  applyBufferPreset(presetName) {
    const recommendations = getBufferSizeRecommendations();
    const preset = recommendations[presetName];
    
    if (preset) {
      this.setBufferSize(preset.size);
      
      // Show preset information
      this.updateStatus(`Applied ${presetName} preset: ${preset.description}`);
    }
  }
  
  /**
   * Optimize buffer settings based on current performance
   * @param {Object} performanceMetrics - Current performance data
   */
  optimizeBufferSettings(performanceMetrics = {}) {
    const { frameRate = 60, memoryPressure = 'low', deviceType = 'desktop' } = performanceMetrics;
    
    let recommendedSize = this.params.bufferSize;
    
    // Adjust based on frame rate
    if (frameRate < 30) {
      recommendedSize = Math.max(4, Math.floor(this.params.bufferSize * 0.75));
    } else if (frameRate > 50) {
      recommendedSize = Math.min(CONFIG.MAX_BUFFER_SIZE, Math.floor(this.params.bufferSize * 1.25));
    }
    
    // Adjust based on memory pressure
    if (memoryPressure === 'high') {
      recommendedSize = Math.max(4, Math.floor(recommendedSize * 0.5));
    } else if (memoryPressure === 'low') {
      recommendedSize = Math.min(CONFIG.MAX_BUFFER_SIZE, Math.floor(recommendedSize * 1.5));
    }
    
    // Adjust based on device type
    if (deviceType === 'mobile') {
      recommendedSize = Math.max(4, Math.min(16, recommendedSize));
    }
    
    if (recommendedSize !== this.params.bufferSize) {
      this.setBufferSize(recommendedSize);
      this.updateStatus(`Optimized buffer size to ${recommendedSize} frames`);
    }
  }
}