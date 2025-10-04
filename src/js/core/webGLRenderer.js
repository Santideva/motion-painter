// src/core/WebGLRenderer.js
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

    // Calibration-related GL resources
    this.calibrationTextures = {
      dark: null,   // GL texture for averaged dark frame
      flat: null,   // GL texture for averaged flat frame
      bias: null    // GL float texture for bias normalization (RGB float)
    };
    this.calibrationResolution = null; // { width, height } for bias/frames
    this.calibrationMetaKey = null;    // persisted metaKey (optional)
    this.calibrationEnabled = false;

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

    // With TEXTURE_2D_ARRAY approach, we need minimal texture units:
    // 1 for frame array + up to 3 for calibration = 4 total maximum
    const minimumRequired = 4;
    
    if (this.maxTextureUnits < minimumRequired) {
      throw new Error(`Hardware supports only ${this.maxTextureUnits} texture units, minimum required is ${minimumRequired}`);
    }

    console.log(`WebGL2 initialized: ${this.maxTextureUnits} texture units available, using TEXTURE_2D_ARRAY approach`);

    // Create shader programs
    this.programs.composite = createShaderProgram(gl, quadVertexShader, compositeFragmentShader);
    this.programs.motion = createShaderProgram(gl, quadVertexShader, motionFragmentShader);

    if (!this.programs.composite || !this.programs.motion) {
      throw new Error('Failed to create shader programs');
    }

    // Create full-screen quad geometry
    this.createQuadGeometry();

    // Get uniform locations (simplified with array texture approach)
    this.getUniformLocations();

    // Set initial GL state
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
  }

    /**
   * Create (once) and bind a neutral 1x1 RGBA texture to a specified texture unit.
   * Fallback when calibration textures are missing so we never set sampler uniforms to -1.
   */
  _getOrCreateNeutralTexture(unit = 0) {
    const gl = this.gl;
    // lazily create neutral texture
    if (!this._neutralTex) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      // opaque black pixel
      const pixel = new Uint8Array([0, 0, 0, 255]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      this._neutralTex = tex;
    }
    // bind neutral texture to requested unit
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this._neutralTex);
    return this._neutralTex;
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
    // Defensive: ensure we have a finite numeric size
    if (typeof newBufferSize !== 'number' || !Number.isFinite(newBufferSize)) {
      console.warn('WebGLRenderer.updateBufferSize: invalid newBufferSize', newBufferSize, '— ignoring');
      return;
    }

    // Clamp to application limits
    const clampedSize = Math.max(CONFIG.MIN_BUFFER_SIZE || 1, Math.min(newBufferSize, CONFIG.MAX_BUFFER_SIZE));

    if (clampedSize === this.currentBufferSize) {
      return;
    }

    if (clampedSize !== newBufferSize) {
      console.warn(`Buffer size ${newBufferSize} exceeds application limit ${CONFIG.MAX_BUFFER_SIZE}, clamped to ${clampedSize}`);
    }

    this.currentBufferSize = clampedSize;
    // No need to regenerate uniform locations since we use sampler2DArray
  }

    /**
   * Sanitize layer indices coming from FrameBuffer / CompositeRenderer
   * clamps to [0, this.currentBufferSize-1], ensures integer values, optionally deduplicates (keeps first occurrence)
   * Returns { indices: number[], changed: boolean, reason: string|null }
   */
  _sanitizeLayerIndices(rawIndices, { dedupe = true, maxCount = CONFIG.MAX_BUFFER_SIZE } = {}) {
    const clamped = [];
    const seen = new Set();
    let changed = false;
    let reason = null;

    if (!Array.isArray(rawIndices)) {
      return { indices: [], changed: true, reason: 'not-an-array' };
    }

    if (this.currentBufferSize <= 0) {
      // No valid buffer configured — return empty
      return { indices: [], changed: true, reason: 'no-buffer' };
    }

    for (let i = 0; i < rawIndices.length && clamped.length < maxCount; i++) {
      const v = rawIndices[i];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        changed = true;
        continue; // skip invalid entry
      }
      // integer and clamp
      const idx = Math.max(0, Math.min(Math.floor(v), Math.max(0, this.currentBufferSize - 1)));
      // deduplicate if requested
      if (dedupe) {
        if (seen.has(idx)) {
          changed = true;
          continue;
        }
        seen.add(idx);
      }
      // push valid
      if (idx !== v) changed = true;
      clamped.push(idx);
    }

    // If we removed entries or trimmed, set a reason
    if (changed && !reason) reason = 'sanitized';

    return { indices: clamped, changed, reason };
  }

  getUniformLocations() {
    const gl = this.gl;

    // Composite program uniforms - simplified with TEXTURE_2D_ARRAY
    gl.useProgram(this.programs.composite);
    this.uniformLocations.composite = {
      // Single frame array sampler instead of individual frame samplers
      uFramesArray: gl.getUniformLocation(this.programs.composite, 'uFramesArray'),
      
      // Other uniforms remain the same
      uTimeShift: gl.getUniformLocation(this.programs.composite, 'uTimeShift'),
      uOpacity: gl.getUniformLocation(this.programs.composite, 'uOpacity'),
      uInvert: gl.getUniformLocation(this.programs.composite, 'uInvert'),
      uRoff: gl.getUniformLocation(this.programs.composite, 'uRoff'),
      uGoff: gl.getUniformLocation(this.programs.composite, 'uGoff'),
      uBoff: gl.getUniformLocation(this.programs.composite, 'uBoff'),
      uMotionThresh: gl.getUniformLocation(this.programs.composite, 'uMotionThresh'),
      uGlow: gl.getUniformLocation(this.programs.composite, 'uGlow'),
      uBufferSize: gl.getUniformLocation(this.programs.composite, 'uBufferSize'),
      uFlipY: gl.getUniformLocation(this.programs.composite, 'uFlipY'),
      uTime: gl.getUniformLocation(this.programs.composite, 'uTime'),
      uDelta: gl.getUniformLocation(this.programs.composite, 'uDelta'),
      
      // Calibration-related uniforms (unchanged)
      uUseCalibration: gl.getUniformLocation(this.programs.composite, 'uUseCalibration'),
      uDark: gl.getUniformLocation(this.programs.composite, 'uDark'),
      uFlat: gl.getUniformLocation(this.programs.composite, 'uFlat'),
      uBias: gl.getUniformLocation(this.programs.composite, 'uBias')
    };

    // Motion program uniforms - updated to use array texture
    gl.useProgram(this.programs.motion);
    this.uniformLocations.motion = {
      uFramesArray: gl.getUniformLocation(this.programs.motion, 'uFramesArray'),
      uCurrentLayer: gl.getUniformLocation(this.programs.motion, 'uCurrentLayer'),
      uPreviousLayer: gl.getUniformLocation(this.programs.motion, 'uPreviousLayer'),
      uMotionThresh: gl.getUniformLocation(this.programs.motion, 'uMotionThresh'),
      uFlipY: gl.getUniformLocation(this.programs.motion, 'uFlipY'),
      
      // Calibration uniforms for motion shader
      uUseCalibration: gl.getUniformLocation(this.programs.motion, 'uUseCalibration'),
      uDark: gl.getUniformLocation(this.programs.motion, 'uDark'),
      uBias: gl.getUniformLocation(this.programs.motion, 'uBias')
    };
  }

  /**
   * Resize the canvas.
   * - Accepts:
   *    1) (cssWidth:number, cssHeight:number)
   *    2) (videoElement:HTMLVideoElement) -> compute size from parent
   *    3) (videoElement:HTMLVideoElement, cssWidth:number, cssHeight:number) -> use target css size
   * - Returns { cssWidth, cssHeight, drawingWidth, drawingHeight } (drawing sizes are device-pixel)
   */
  resizeCanvas(videoOrCssWidth = null, optCssHeight = null, optCssHeight2 = null) {
    const canvas = this.canvas;
    const gl = this.gl;

    let cssWidth, cssHeight;

    // Case A: explicit numeric pixel sizes passed as (number, number)
    if (typeof videoOrCssWidth === 'number' && typeof optCssHeight === 'number') {
      cssWidth = Math.max(1, Math.floor(videoOrCssWidth));
      cssHeight = Math.max(1, Math.floor(optCssHeight));
    }
    // Case B: first arg is a video element and explicit target CSS sizes also provided:
    else if (videoOrCssWidth && typeof videoOrCssWidth === 'object' && 
             (typeof optCssHeight === 'number' && typeof optCssHeight2 === 'number')) {
      cssWidth = Math.max(1, Math.floor(optCssHeight));
      cssHeight = Math.max(1, Math.floor(optCssHeight2));
    }
    // Case C: first arg is a video element and no explicit sizes -> compute from parent container
    else if (videoOrCssWidth && typeof videoOrCssWidth === 'object') {
      const parentRect = (canvas.parentElement && canvas.parentElement.getBoundingClientRect())
        || canvas.getBoundingClientRect();
      const padX = 16;
      const padY = 16;
      cssWidth = Math.max(1, Math.floor(parentRect.width - padX));
      cssHeight = Math.max(1, Math.floor(parentRect.height - padY));
      if (cssWidth <= 0 || cssHeight <= 0) {
        cssWidth = Math.max(1, window.innerWidth);
        cssHeight = Math.max(1, window.innerHeight);
      }
    }
    // Case D: fallback - compute from parent container
    else {
      const parentRect = (canvas.parentElement && canvas.parentElement.getBoundingClientRect())
        || canvas.getBoundingClientRect();
      const padX = 16;
      const padY = 16;
      cssWidth = Math.max(1, Math.floor(parentRect.width - padX));
      cssHeight = Math.max(1, Math.floor(parentRect.height - padY));
      if (cssWidth <= 0 || cssHeight <= 0) {
        cssWidth = Math.max(1, window.innerWidth);
        cssHeight = Math.max(1, window.innerHeight);
      }
    }

    // Apply CSS size explicitly so layout is deterministic
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    // Compute device-pixel drawing buffer size
    const DPR = window.devicePixelRatio || 1;
    const drawingWidth = Math.max(1, Math.floor(cssWidth * DPR));
    const drawingHeight = Math.max(1, Math.floor(cssHeight * DPR));

    // Update canvas drawing buffer only if it changed
    if (canvas.width !== drawingWidth || canvas.height !== drawingHeight) {
      canvas.width = drawingWidth;
      canvas.height = drawingHeight;
    }

    // Update GL viewport
    try {
      gl.viewport(0, 0, canvas.width, canvas.height);
    } catch (err) {
      console.warn('WebGLRenderer.resizeCanvas: viewport call failed', err);
    }

    return { cssWidth, cssHeight, drawingWidth, drawingHeight };
  }

  renderComposite(frameBufferData, uniforms = {}) {
    const gl = this.gl;
    
    // Extract array texture and layer indices from FrameBuffer
    const { arrayTexture, layerIndices } = frameBufferData || {};
    console.log('[GL] renderComposite: called. arrayTexture=', !!arrayTexture, 'layerIndices.len=', Array.isArray(layerIndices) ? layerIndices.length : 'null', 'currentBufferSize=', this.currentBufferSize);

    // Sanitize incoming layerIndices to valid range and dedupe to avoid duplicate uploads / invalid shader indices
    let validLayerIndices = Array.isArray(layerIndices) ? layerIndices.slice() : [];
    const sanit = this._sanitizeLayerIndices(validLayerIndices, { dedupe: true, maxCount: CONFIG.MAX_BUFFER_SIZE });
    if (sanit.changed) {
      console.warn('[GL] renderComposite: layerIndices sanitized. original=', validLayerIndices.slice(0,16), 'sanitized=', sanit.indices.slice(0,16), 'reason=', sanit.reason);
    }
    validLayerIndices = sanit.indices;

    // Defensive: compute actual buffer size using safe fallbacks (from sanitized indices)
    let actualBufferSize;
    if (Array.isArray(validLayerIndices) && validLayerIndices.length > 0) {
      actualBufferSize = Math.min(validLayerIndices.length, CONFIG.MAX_BUFFER_SIZE);
    } else if (typeof this.currentBufferSize === 'number' && Number.isFinite(this.currentBufferSize)) {
      actualBufferSize = this.currentBufferSize;
    } else {
      actualBufferSize = Math.min(CONFIG.DEFAULT_BUFFER_SIZE || 8, CONFIG.MAX_BUFFER_SIZE);
    }
    console.log('[GL] renderComposite: actualBufferSize=', actualBufferSize, 'layerIndices(first8)=', validLayerIndices ? validLayerIndices.slice(0,8) : null);

    if (!arrayTexture) {
      console.warn('renderComposite: no array texture provided');
      return;
    }

    // Update buffer size if it changed (safe numeric)
    if (actualBufferSize !== this.currentBufferSize) {
      this.updateBufferSize(actualBufferSize);
      console.log('[GL] renderComposite: updateBufferSize ->', this.currentBufferSize);
    }

    // Bind framebuffer (null = screen)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Use composite program
    gl.useProgram(this.programs.composite);
    gl.bindVertexArray(this.vao);

    const locs = this.uniformLocations.composite;

    // Bind the frame array texture to texture unit 0
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, arrayTexture);
    if (locs.uFramesArray != null) {
      gl.uniform1i(locs.uFramesArray, 0);
    }

    // Set buffer size uniform
    if (locs.uBufferSize != null) {
      gl.uniform1i(locs.uBufferSize, actualBufferSize);
    }

    // Set other uniforms with proper clamping
    if (locs.uTimeShift != null) {
      gl.uniform1i(locs.uTimeShift, Math.min(uniforms.timeShift || 0, Math.max(0, actualBufferSize - 1)));
    }
    if (locs.uOpacity != null) {
      gl.uniform1f(locs.uOpacity, uniforms.opacity ?? 0.6);
    }
    if (locs.uInvert != null) {
      gl.uniform1i(locs.uInvert, uniforms.invert ? 1 : 0);
    }
    if (locs.uRoff != null) {
      gl.uniform1i(locs.uRoff, Math.min(uniforms.rOff || 0, Math.max(0, actualBufferSize - 1)));
    }
    if (locs.uGoff != null) {
      gl.uniform1i(locs.uGoff, Math.min(uniforms.gOff || 0, Math.max(0, actualBufferSize - 1)));
    }
    if (locs.uBoff != null) {
      gl.uniform1i(locs.uBoff, Math.min(uniforms.bOff || 0, Math.max(0, actualBufferSize - 1)));
    }
    if (locs.uMotionThresh != null) {
      gl.uniform1f(locs.uMotionThresh, uniforms.motionThresh ?? 0.08);
    }
    if (locs.uGlow != null) {
      gl.uniform1f(locs.uGlow, uniforms.glow ?? 0.9);
    }

    // Time uniforms
    if (locs.uFlipY != null) {
      gl.uniform1i(locs.uFlipY, uniforms.flipY ? 1 : 0);
    }
    if (locs.uTime != null) {
      gl.uniform1f(locs.uTime, uniforms.time ?? 0.0);
    }
    if (locs.uDelta != null) {
      gl.uniform1f(locs.uDelta, uniforms.delta ?? 0.0);
    }

    // --- Calibration binding (safe) ---
    let calibrationBound = false;
    const firstCalUnit = 1; // frame array uses unit 0
    const maxUnits = Math.max(0, this.maxTextureUnits || 0);
    const neededUnits = (this.calibrationTextures.dark ? 1 : 0) +
                        (this.calibrationTextures.flat ? 1 : 0) +
                        (this.calibrationTextures.bias ? 1 : 0);

    if (neededUnits > 0 && (firstCalUnit + neededUnits) <= maxUnits) {
      let unit = firstCalUnit;

      // dark (or neutral fallback)
      if (this.calibrationTextures.dark) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, this.calibrationTextures.dark);
      } else {
        this._getOrCreateNeutralTexture(unit);
      }
      if (locs.uDark != null) gl.uniform1i(locs.uDark, unit);
      unit++;

      // flat (or neutral fallback)
      if (this.calibrationTextures.flat) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, this.calibrationTextures.flat);
      } else {
        this._getOrCreateNeutralTexture(unit);
      }
      if (locs.uFlat != null) gl.uniform1i(locs.uFlat, unit);
      unit++;

      // bias (or neutral fallback)
      if (this.calibrationTextures.bias) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, this.calibrationTextures.bias);
      } else {
        this._getOrCreateNeutralTexture(unit);
      }
      if (locs.uBias != null) gl.uniform1i(locs.uBias, unit);
      unit++;

      calibrationBound = true;
    } else {
      // Not enough texture units or none present: bind neutral textures into first available cal units.
      for (let i = 0; i < 3 && (firstCalUnit + i) < maxUnits; i++) {
        this._getOrCreateNeutralTexture(firstCalUnit + i);
      }
      if (locs.uDark != null && maxUnits > firstCalUnit) gl.uniform1i(locs.uDark, firstCalUnit);
      if (locs.uFlat != null && maxUnits > firstCalUnit + 1) gl.uniform1i(locs.uFlat, firstCalUnit + 1);
      if (locs.uBias != null && maxUnits > firstCalUnit + 2) gl.uniform1i(locs.uBias, firstCalUnit + 2);

      calibrationBound = false;
    }

    if (locs.uUseCalibration != null) {
      gl.uniform1i(locs.uUseCalibration, calibrationBound ? 1 : 0);
    }

    // --- pre-draw validation & draw ---
    try {
      // basic validations
      if (!arrayTexture) {
        console.error('renderComposite: missing arrayTexture at draw time — skipping draw');
      } else if (this.maxTextureUnits < 1) {
        console.error('renderComposite: insufficient texture units available — skipping draw');
      } else {
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    } catch (e) {
      console.error('renderComposite: drawArrays threw', e);
    }

    const _err = gl.getError();
    if (_err !== gl.NO_ERROR) {
      console.error('[GL] renderComposite: gl.getError() after drawArrays =', _err);
    } else {
      console.log('[GL] renderComposite: drawArrays OK');
    }
  }

  renderMotionMask(frameBufferData, motionThresh, flipY = false) {
    const gl = this.gl;
    const { arrayTexture, layerIndices } = frameBufferData || {};

    // Sanitize incoming layer indices — motion mask requires at least two valid layers
    const sanit = this._sanitizeLayerIndices(Array.isArray(layerIndices) ? layerIndices : [], { dedupe: false, maxCount: 2 });
    if (sanit.indices.length < 2) {
      console.warn('[GL] renderMotionMask: insufficient valid frame indices after sanitization. original=', layerIndices, 'sanitized=', sanit.indices);
      return;
    }
    if (sanit.changed) {
      console.warn('[GL] renderMotionMask: layerIndices sanitized. original=', layerIndices.slice(0,4), 'sanitized=', sanit.indices.slice(0,4), 'reason=', sanit.reason);
    }
    const validLayerIndices = sanit.indices;

    if (!arrayTexture) {
      console.warn('renderMotionMask: no array texture provided');
      return;
    }

    gl.useProgram(this.programs.motion);
    gl.bindVertexArray(this.vao);

    const locs = this.uniformLocations.motion;

    // Bind the frame array texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, arrayTexture);
    if (locs.uFramesArray != null) {
      gl.uniform1i(locs.uFramesArray, 0);
    }
    // More explicit diagnostic
    const uLoc = locs.uFramesArray;
    const uLocPresent = (uLoc != null);
    console.log('[GL] renderMotionMask: bound TEXTURE_2D_ARRAY to unit 0; uFramesArray location =',
    uLocPresent ? uLoc : 'missing (null)', ' layerIndices=', validLayerIndices.slice(0,4));

    // Set layer indices for current and previous frames
    if (locs.uCurrentLayer != null) {
      gl.uniform1i(locs.uCurrentLayer, validLayerIndices[0]); // newest frame
    }
    if (locs.uPreviousLayer != null) {
      gl.uniform1i(locs.uPreviousLayer, validLayerIndices[1]); // previous frame
    }

    if (locs.uMotionThresh != null) {
      gl.uniform1f(locs.uMotionThresh, motionThresh);
    }

    // Set flipY uniform if present in shader
    if (locs.uFlipY != null) {
      gl.uniform1i(locs.uFlipY, flipY ? 1 : 0);
    }

    // Calibration for motion shader - simplified (dark and bias only)
    let calibrationBound = false;
    const firstCalUnit = 1; // Frame array uses unit 0
    
    if (this.calibrationTextures.dark && this.calibrationTextures.bias) {
      let unit = firstCalUnit;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, this.calibrationTextures.dark);
      if (locs.uDark != null) gl.uniform1i(locs.uDark, unit);
      unit++;

      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, this.calibrationTextures.bias);
      if (locs.uBias != null) gl.uniform1i(locs.uBias, unit);

      calibrationBound = true;
    } else {
      // fallback: bind neutral textures to avoid invalid sampler uniforms
      if (this.maxTextureUnits > firstCalUnit) {
        this._getOrCreateNeutralTexture(firstCalUnit);
        if (locs.uDark != null) gl.uniform1i(locs.uDark, firstCalUnit);
      }
      if (this.maxTextureUnits > firstCalUnit + 1) {
        this._getOrCreateNeutralTexture(firstCalUnit + 1);
        if (locs.uBias != null) gl.uniform1i(locs.uBias, firstCalUnit + 1);
      }
      calibrationBound = false;
    }

    console.log('[GL] renderComposite: calibrationBound=', calibrationBound, 'calibTextures=', {
      dark: !!this.calibrationTextures.dark,
      flat: !!this.calibrationTextures.flat,
      bias: !!this.calibrationTextures.bias
    });
    
    if (locs.uUseCalibration != null) {
      gl.uniform1i(locs.uUseCalibration, calibrationBound ? 1 : 0);
    }

    // --- pre-draw validation & draw ---
    try {
      if (!arrayTexture) {
        console.error('renderMotionMask: missing arrayTexture at draw time — skipping draw');
      } else if (this.maxTextureUnits < 1) {
        console.error('renderMotionMask: insufficient texture units available — skipping draw');
      } else {
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    } catch (e) {
      console.error('renderMotionMask: drawArrays threw', e);
    }

    const _err2 = gl.getError();
    if (_err2 !== gl.NO_ERROR) {
      console.error('[GL] renderMotionMask: gl.getError() after drawArrays =', _err2);
    } else {
      console.log('[GL] renderMotionMask: drawArrays OK');
    }
  }

  /**
   * Create a GL texture from an ImageBitmap
   * Returns the texture object or throws on error.
   */
  _createTextureFromBitmap(imageBitmap) {
    const gl = this.gl;
    if (!imageBitmap) return null;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);

    try {
      // Upload image bitmap directly (WebGL2 allows ImageBitmap)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imageBitmap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      return tex;
    } catch (err) {
      // cleanup on failure
      try { gl.deleteTexture(tex); } catch (e) {}
      console.warn('WebGLRenderer._createTextureFromBitmap failed', err);
      return null;
    }
  }

  /**
   * Create a GL float RGB texture from a Float32Array of length width*height*3
   * Returns texture or null on failure (e.g. unsupported float textures).
   */
  _createFloatTextureFromArray(floatArray, width, height) {
    const gl = this.gl;
    if (!floatArray || width <= 0 || height <= 0) return null;

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);

    try {
      // Try uploading as RGB32F (WebGL2)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB32F, width, height, 0, gl.RGB, gl.FLOAT, floatArray);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      return tex;
    } catch (err) {
      // If this fails, do graceful fallback and delete texture
      try { gl.deleteTexture(tex); } catch (e) {}
      console.warn('WebGLRenderer._createFloatTextureFromArray failed (float textures may not be supported):', err);
      return null;
    }
  }

  /**
   * Public: set calibration textures & bias into GL.
   * - darkBitmap, flatBitmap: ImageBitmap or null
   * - biasArray: Float32Array or null (length width*height*3)
   * - resolution: { width, height } dimensions of calibration bitmaps / bias map
   * - metaKey: optional canonical storage metaKey (string)
   *
   * This method replaces any prior calibration textures (deletes old GL resources).
   */
  setCalibrationTextures({ darkBitmap = null, flatBitmap = null, biasArray = null, resolution = null, metaKey = null } = {}) {
    const gl = this.gl;

    // Free old textures first
    this.clearCalibrationTextures();

    if (darkBitmap) {
      const darkTex = this._createTextureFromBitmap(darkBitmap);
      if (darkTex) {
        this.calibrationTextures.dark = darkTex;
      } else {
        console.warn('setCalibrationTextures: failed to create dark texture');
      }
    }

    if (flatBitmap) {
      const flatTex = this._createTextureFromBitmap(flatBitmap);
      if (flatTex) {
        this.calibrationTextures.flat = flatTex;
      } else {
        console.warn('setCalibrationTextures: failed to create flat texture');
      }
    }

    if (biasArray && resolution && resolution.width && resolution.height) {
      // Attempt to create float texture
      const biasTex = this._createFloatTextureFromArray(biasArray, resolution.width, resolution.height);
      if (biasTex) {
        this.calibrationTextures.bias = biasTex;
      } else {
        console.warn('setCalibrationTextures: float bias texture creation failed; bias will not be available in shaders');
      }
    }

    this.calibrationResolution = resolution || null;
    this.calibrationMetaKey = metaKey || this.calibrationMetaKey || null;
    this.calibrationEnabled = !!(this.calibrationTextures.dark || this.calibrationTextures.flat || this.calibrationTextures.bias);

    // No return value; best effort
  }

  /**
   * Delete/clear calibration GL textures and metadata
   */
  clearCalibrationTextures() {
    const gl = this.gl;
    try {
      if (this.calibrationTextures.dark) { gl.deleteTexture(this.calibrationTextures.dark); }
    } catch (e) {}
    try {
      if (this.calibrationTextures.flat) { gl.deleteTexture(this.calibrationTextures.flat); }
    } catch (e) {}
    try {
      if (this.calibrationTextures.bias) { gl.deleteTexture(this.calibrationTextures.bias); }
    } catch (e) {}

    this.calibrationTextures.dark = null;
    this.calibrationTextures.flat = null;
    this.calibrationTextures.bias = null;
    this.calibrationResolution = null;
    this.calibrationMetaKey = null;
    this.calibrationEnabled = false;
  }

  /**
   * Expose whether the renderer currently has calibration bound
   */
  hasCalibration() {
    return this.calibrationEnabled;
  }

  /**
   * Validate that current configuration is within hardware limits
   */
  validateConfiguration() {
    const currentConfig = {
      bufferSize: this.currentBufferSize,
      maxTextureUnits: this.maxTextureUnits,
      textureUnitsRequired: 4, // 1 for frame array + up to 3 for calibration
      hardwareLimit: this.maxTextureUnits,
      applicationLimit: CONFIG.MAX_BUFFER_SIZE,
      arrayTextureApproach: true
    };

    const issues = [];

    const requiredUnits = 4; // Conservative estimate
    if (this.maxTextureUnits < requiredUnits) {
      issues.push({
        type: 'error',
        message: `Hardware supports ${this.maxTextureUnits} texture units, minimum required is ${requiredUnits}`
      });
    }

    if (this.currentBufferSize > CONFIG.MAX_BUFFER_SIZE) {
      issues.push({
        type: 'error', 
        message: `Buffer size ${this.currentBufferSize} exceeds application limit of ${CONFIG.MAX_BUFFER_SIZE}`
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
      maxBufferSize: CONFIG.MAX_BUFFER_SIZE, // No longer limited by texture units
      currentBufferSize: this.currentBufferSize,
      webglVersion: gl.getParameter(gl.VERSION),
      renderer: gl.getParameter(gl.RENDERER),
      hardwareLimited: false, // TEXTURE_2D_ARRAY removes this limitation
      effectiveLimit: CONFIG.MAX_BUFFER_SIZE,
      arrayTextureSupport: true,
      textureUnitsRequired: 4, // Much more efficient
      validation: this.validateConfiguration()
    };
  }

  /**
   * Return an "optimal" buffer size based on application limits (no longer hardware constrained)
   */
  getOptimalBufferSize() {
    // With TEXTURE_2D_ARRAY, we can use the full application limit
    return CONFIG.MAX_BUFFER_SIZE;
  }

  destroy() {
    const gl = this.gl;

    if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.programs.composite) gl.deleteProgram(this.programs.composite);
    if (this.programs.motion) gl.deleteProgram(this.programs.motion);

    // Clear calibration textures if any
    this.clearCalibrationTextures();
  }
}