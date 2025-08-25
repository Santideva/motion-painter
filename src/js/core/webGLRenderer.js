import { createShaderProgram } from '../utils/ShaderUtils.js';
import { getOptimalCanvasSize, CONFIG } from '../utils/MathUtils.js';

// Import shaders
import quadVertexShader from '../shaders/quad.vert';
import compositeFragmentShader from '../shaders/composite.frag';
import motionFragmentShader from '../shaders/motion.frag';

export class WebGLRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.programs = {};
    this.vao = null;
    this.quadBuffer = null;
    this.uniformLocations = {};
    this.currentBufferSize = CONFIG.DEFAULT_BUFFER_SIZE;
    this.maxTextureUnits = 0;
    
    this.init();
  }
  
  init() {
    // Initialize WebGL2 context
    this.gl = this.canvas.getContext('webgl2', { antialias: false });
    if (!this.gl) {
      throw new Error('WebGL2 not supported');
    }
    
    const gl = this.gl;
    
    // Query hardware capabilities
    this.maxTextureUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
    
    // Validate against hardware limits
    if (this.maxTextureUnits < CONFIG.MIN_BUFFER_SIZE) {
      throw new Error(`Hardware supports only ${this.maxTextureUnits} texture units, minimum required is ${CONFIG.MIN_BUFFER_SIZE}`);
    }
    
    // Warn if hardware limits our buffer size
    if (this.maxTextureUnits < CONFIG.MAX_BUFFER_SIZE) {
      console.warn(`Hardware supports ${this.maxTextureUnits} texture units, limiting buffer to this size`);
    }
    
    // Create shader programs
    this.programs.composite = createShaderProgram(gl, quadVertexShader, compositeFragmentShader);
    this.programs.motion = createShaderProgram(gl, quadVertexShader, motionFragmentShader);
    
    if (!this.programs.composite || !this.programs.motion) {
      throw new Error('Failed to create shader programs');
    }
    
    // Create full-screen quad geometry
    this.createQuadGeometry();
    
    // Get uniform locations for default buffer size
    this.getUniformLocations(Math.min(this.currentBufferSize, this.maxTextureUnits));
    
    // Set initial GL state
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
  }
  
  createQuadGeometry() {
    const gl = this.gl;
    
    // Full-screen quad vertices
    const quadVertices = new Float32Array([
      -1, -1,   1, -1,   -1,  1,
      -1,  1,   1, -1,    1,  1
    ]);
    
    // Create VAO and buffer
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    
    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);
    
    // Set up vertex attributes for both programs
    const aPos = gl.getAttribLocation(this.programs.composite, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  }
  
  updateBufferSize(newBufferSize) {
    // Enforce hardware limits
    const clampedSize = Math.min(newBufferSize, this.maxTextureUnits, CONFIG.MAX_BUFFER_SIZE);
    
    if (clampedSize === this.currentBufferSize) {
      return; // No change needed
    }
    
    // Warn if size was clamped due to hardware
    if (clampedSize !== newBufferSize) {
      if (newBufferSize > this.maxTextureUnits) {
        console.warn(`Buffer size ${newBufferSize} exceeds hardware limit ${this.maxTextureUnits}, clamped to ${clampedSize}`);
      } else if (newBufferSize > CONFIG.MAX_BUFFER_SIZE) {
        console.warn(`Buffer size ${newBufferSize} exceeds application limit ${CONFIG.MAX_BUFFER_SIZE}, clamped to ${clampedSize}`);
      }
    }
    
    this.currentBufferSize = clampedSize;
    this.getUniformLocations(clampedSize);
  }
  
  getUniformLocations(bufferSize) {
    const gl = this.gl;
    const effectiveBufferSize = Math.min(bufferSize, CONFIG.MAX_BUFFER_SIZE);
    
    // Composite program uniforms - dynamic frame samplers
    gl.useProgram(this.programs.composite);
    this.uniformLocations.composite = {
      // Dynamic frame texture samplers - limited to 16
      frames: [],
      // Other uniforms
      uTimeShift: gl.getUniformLocation(this.programs.composite, 'uTimeShift'),
      uOpacity: gl.getUniformLocation(this.programs.composite, 'uOpacity'),
      uInvert: gl.getUniformLocation(this.programs.composite, 'uInvert'),
      uRoff: gl.getUniformLocation(this.programs.composite, 'uRoff'),
      uGoff: gl.getUniformLocation(this.programs.composite, 'uGoff'),
      uBoff: gl.getUniformLocation(this.programs.composite, 'uBoff'),
      uMotionThresh: gl.getUniformLocation(this.programs.composite, 'uMotionThresh'),
      uGlow: gl.getUniformLocation(this.programs.composite, 'uGlow'),
      uBufferSize: gl.getUniformLocation(this.programs.composite, 'uBufferSize')
    };
    
    // Get frame uniform locations dynamically - up to 16 only
    for (let i = 0; i < effectiveBufferSize; i++) {
      const uniformName = `uFrame${i}`;
      const location = gl.getUniformLocation(this.programs.composite, uniformName);
      if (location) {
        this.uniformLocations.composite.frames[i] = location;
      } else {
        console.warn(`Could not find uniform location for ${uniformName}`);
      }
    }
    
    // Motion program uniforms
    gl.useProgram(this.programs.motion);
    this.uniformLocations.motion = {
      uCurr: gl.getUniformLocation(this.programs.motion, 'uCurr'),
      uPrev: gl.getUniformLocation(this.programs.motion, 'uPrev'),
      uMotionThresh: gl.getUniformLocation(this.programs.motion, 'uMotionThresh')
    };
  }
  
  resizeCanvas(video) {
    const { width, height } = getOptimalCanvasSize(video);
    
    this.canvas.width = width;
    this.canvas.height = height;
    
    this.gl.viewport(0, 0, width, height);
    
    return { width, height };
  }
  
  renderComposite(frameTextures, uniforms) {
    const gl = this.gl;
    const actualBufferSize = Math.min(frameTextures.length, CONFIG.MAX_BUFFER_SIZE, this.maxTextureUnits);
    
    // Update buffer size if it changed
    if (actualBufferSize !== this.currentBufferSize) {
      this.updateBufferSize(actualBufferSize);
    }
    
    // Bind framebuffer (null = screen)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    
    // Use composite program
    gl.useProgram(this.programs.composite);
    gl.bindVertexArray(this.vao);
    
    const locs = this.uniformLocations.composite;
    
    // Bind frame textures to texture units - limited to actualBufferSize
    for (let i = 0; i < actualBufferSize; i++) {
      if (i < frameTextures.length && frameTextures[i]) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, frameTextures[i]);
        
        if (locs.frames[i]) {
          gl.uniform1i(locs.frames[i], i);
        }
      }
    }
    
    // Set buffer size uniform
    if (locs.uBufferSize) {
      gl.uniform1i(locs.uBufferSize, actualBufferSize);
    }
    
    // Set other uniforms with proper clamping
    if (locs.uTimeShift) {
      gl.uniform1i(locs.uTimeShift, Math.min(uniforms.timeShift, actualBufferSize - 1));
    }
    if (locs.uOpacity) {
      gl.uniform1f(locs.uOpacity, uniforms.opacity);
    }
    if (locs.uInvert) {
      gl.uniform1i(locs.uInvert, uniforms.invert ? 1 : 0);
    }
    if (locs.uRoff) {
      gl.uniform1i(locs.uRoff, Math.min(uniforms.rOff, actualBufferSize - 1));
    }
    if (locs.uGoff) {
      gl.uniform1i(locs.uGoff, Math.min(uniforms.gOff, actualBufferSize - 1));
    }
    if (locs.uBoff) {
      gl.uniform1i(locs.uBoff, Math.min(uniforms.bOff, actualBufferSize - 1));
    }
    if (locs.uMotionThresh) {
      gl.uniform1f(locs.uMotionThresh, uniforms.motionThresh);
    }
    if (locs.uGlow) {
      gl.uniform1f(locs.uGlow, uniforms.glow);
    }
    
    // Draw
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  
  renderMotionMask(currentTexture, previousTexture, motionThresh) {
    const gl = this.gl;
    
    gl.useProgram(this.programs.motion);
    gl.bindVertexArray(this.vao);
    
    // Bind textures
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, currentTexture);
    if (this.uniformLocations.motion.uCurr) {
      gl.uniform1i(this.uniformLocations.motion.uCurr, 0);
    }
    
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, previousTexture);
    if (this.uniformLocations.motion.uPrev) {
      gl.uniform1i(this.uniformLocations.motion.uPrev, 1);
    }
    
    if (this.uniformLocations.motion.uMotionThresh) {
      gl.uniform1f(this.uniformLocations.motion.uMotionThresh, motionThresh);
    }
    
    // Draw
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  
  /**
   * Generate fallback composite shader for any buffer size
   * This creates shader code that can handle variable buffer sizes up to 16
   */
  generateCompositeShader(bufferSize) {
    // This would generate dynamic shader code based on buffer size
    // For now, we'll assume the shader can handle up to 16 textures
    // and use uBufferSize uniform to limit actual sampling
    return compositeFragmentShader;
  }
  
  /**
   * Validate that current configuration is within hardware limits
   */
  validateConfiguration() {
    const currentConfig = {
      bufferSize: this.currentBufferSize,
      maxTextureUnits: this.maxTextureUnits,
      hardwareLimit: this.maxTextureUnits,
      applicationLimit: CONFIG.MAX_BUFFER_SIZE
    };
    
    const issues = [];
    
    if (this.currentBufferSize > this.maxTextureUnits) {
      issues.push({
        type: 'error',
        message: `Buffer size ${this.currentBufferSize} exceeds hardware limit of ${this.maxTextureUnits} texture units`
      });
    }
    
    if (this.currentBufferSize > CONFIG.MAX_BUFFER_SIZE) {
      issues.push({
        type: 'error', 
        message: `Buffer size ${this.currentBufferSize} exceeds application limit of ${CONFIG.MAX_BUFFER_SIZE}`
      });
    }
    
    if (this.maxTextureUnits < CONFIG.MAX_BUFFER_SIZE) {
      issues.push({
        type: 'warning',
        message: `Hardware supports ${this.maxTextureUnits} texture units, less than optimal ${CONFIG.MAX_BUFFER_SIZE}`
      });
    }
    
    return {
      isValid: issues.filter(i => i.type === 'error').length === 0,
      config: currentConfig,
      issues
    };
  }
  
  /**
   * Get renderer capabilities and status
   */
  getCapabilities() {
    const gl = this.gl;
    
    return {
      maxTextureUnits: this.maxTextureUnits,
      maxBufferSize: Math.min(CONFIG.MAX_BUFFER_SIZE, this.maxTextureUnits),
      currentBufferSize: this.currentBufferSize,
      webglVersion: gl.getParameter(gl.VERSION),
      renderer: gl.getParameter(gl.RENDERER),
      hardwareLimited: this.maxTextureUnits < CONFIG.MAX_BUFFER_SIZE,
      effectiveLimit: Math.min(CONFIG.MAX_BUFFER_SIZE, this.maxTextureUnits),
      validation: this.validateConfiguration()
    };
  }
  
  destroy() {
    const gl = this.gl;
    
    if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.programs.composite) gl.deleteProgram(this.programs.composite);
    if (this.programs.motion) gl.deleteProgram(this.programs.motion);
  }
}