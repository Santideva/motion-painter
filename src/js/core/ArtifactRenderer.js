// src/js/core/ArtifactRenderer.js
//
// GPU texture registry and visualization shaders for pipeline artifact rendering.
//
// Completely standalone — zero imports, zero pipeline dependencies.
// Takes a shared WebGL2RenderingContext from WebGLRenderer.
//
// Supported upload formats:
//   R32F    — single-channel Float32Array (scalar fields)
//   RG32F   — two-channel Float32Array, pre-interleaved (flow, warpField)
//   RGBA32F — four-channel Float32Array, stride-4 (directional field)
//   R32I    — Int32Array (label / segmentation maps)
//
// Visualization modes:
//   scalar           — false-colour scalar heatmap (4 colormaps)
//   flow             — HSV colour-wheel (hue=direction, saturation=magnitude)
//   label            — hash-derived distinct hue per integer label
//   rgba             — direct RGBA passthrough or single-channel extract
//   edge_glow        — Sobel edge detection, additive glow over camera frame
//   contour_animated — scrolling level-set contour lines over time
//   emergence        — field-keyed composite: uncertain pixels transparent
//   standalone       — artifact at full opacity, covers composite entirely

export class ArtifactRenderer {
  /**
   * @param {WebGL2RenderingContext} gl — shared with WebGLRenderer
   */
  constructor(gl) {
    if (!gl) throw new Error('[ArtifactRenderer] WebGL2RenderingContext required');
    this.gl = gl;

    // name → { texture, width, height, format, uploadedAt }
    this._registry = new Map();

    // Active artifact state
    this._activeName   = null;
    this._activeMode   = null;
    this._activeParams = {};
    this._startTime    = null;  // performance.now() at first activation

    // Compiled shader programs, keyed by mode name
    this._programs = {};

    // Shared fullscreen quad (own VAO/VBO; independent of WebGLRenderer's)
    this._vao = null;
    this._vbo = null;

    this._initQuad();
    this._initShaders();

    console.log('[ArtifactRenderer] Initialized');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // QUAD GEOMETRY
  // ═══════════════════════════════════════════════════════════════════════

  _initQuad() {
    const gl    = this.gl;
    const verts = new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]);

    this._vao = gl.createVertexArray();
    gl.bindVertexArray(this._vao);

    this._vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

    // attrib 0 = aPos (2 floats)
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SHADER COMPILATION
  // ═══════════════════════════════════════════════════════════════════════

  _compileShader(type, src) {
    const gl = this.gl;
    const s  = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error('[ArtifactRenderer] Shader compile error:\n' + info);
    }
    return s;
  }

  _linkProgram(vertSrc, fragSrc, label) {
    const gl   = this.gl;
    const vs   = this._compileShader(gl.VERTEX_SHADER,   vertSrc);
    const fs   = this._compileShader(gl.FRAGMENT_SHADER, fragSrc);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error(`[ArtifactRenderer] Link error (${label}):\n` + info);
    }
    return prog;
  }

  _initShaders() {
    // ── Shared vertex shader (all modes) ────────────────────────────────
    const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

    // ── Scalar (R32F) ────────────────────────────────────────────────────
    // uColormap: 0=greyscale  1=diverging(blue→white→red)
    //            2=hot(black→red→yellow→white)  3=SDF-contour
    const SCALAR_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uField;
uniform float uMin;
uniform float uMax;
uniform float uOpacity;
uniform bool  uFlipY;
uniform int   uColormap;

vec3 colHot(float t) {
  return vec3(
    clamp(t * 3.0,        0.0, 1.0),
    clamp(t * 3.0 - 1.0,  0.0, 1.0),
    clamp(t * 3.0 - 2.0,  0.0, 1.0)
  );
}

vec3 colDiverging(float t) {
  vec3 lo  = vec3(0.09, 0.18, 0.72);
  vec3 mid = vec3(0.97, 0.97, 0.97);
  vec3 hi  = vec3(0.73, 0.08, 0.08);
  return t < 0.5
    ? mix(lo,  mid, t * 2.0)
    : mix(mid, hi, (t - 0.5) * 2.0);
}

void main() {
  vec2  uv    = vUv;
  if (uFlipY) uv.y = 1.0 - uv.y;

  float raw   = texture(uField, uv).r;
  float range = max(uMax - uMin, 1e-7);
  float t     = clamp((raw - uMin) / range, 0.0, 1.0);

  vec3 col;

  if (uColormap == 0) {
    col = vec3(t);

  } else if (uColormap == 1) {
    col = colDiverging(t);

  } else if (uColormap == 2) {
    col = colHot(t);

  } else {
    // SDF-contour: diverging background + bright zero-crossing + level lines
    col = colDiverging(t);
    float absNorm = abs(raw) / max(range, 1e-7);

    // Zero-crossing band
    float zc  = 1.0 - smoothstep(0.0, 0.012, absNorm);
    col = mix(col, vec3(1.0, 0.97, 0.1), zc * 0.95);

    // Level-set contour lines at regular intervals
    float band  = fract(absNorm * 20.0);
    float lineW = fwidth(absNorm * 20.0) * 1.5;
    float line  = 1.0 - smoothstep(0.0, lineW, min(band, 1.0 - band));
    col = mix(col, vec3(1.0), line * 0.28);
  }

  fragColor = vec4(col, uOpacity);
}`;

    // ── Flow / warp field (RG32F: pre-interleaved u,v or r,θ) ────────────
    const FLOW_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uField;
uniform float uMaxMag;
uniform float uOpacity;
uniform bool  uFlipY;

const float PI = 3.14159265358979323846;

vec3 hsv2rgb(float h, float s, float v) {
  float c  = v * s;
  float h6 = h * 6.0;
  float x  = c * (1.0 - abs(mod(h6, 2.0) - 1.0));
  float m  = v - c;
  vec3 rgb;
  if      (h6 < 1.0) rgb = vec3(c, x, 0.0);
  else if (h6 < 2.0) rgb = vec3(x, c, 0.0);
  else if (h6 < 3.0) rgb = vec3(0.0, c, x);
  else if (h6 < 4.0) rgb = vec3(0.0, x, c);
  else if (h6 < 5.0) rgb = vec3(x, 0.0, c);
  else               rgb = vec3(c, 0.0, x);
  return rgb + vec3(m);
}

void main() {
  vec2  uv   = vUv;
  if (uFlipY) uv.y = 1.0 - uv.y;

  vec2  flow = texture(uField, uv).rg;
  float mag  = length(flow);

  // Zero or near-zero pixels: dark background so they don't dominate
  if (mag < 1e-5) {
    fragColor = vec4(0.06, 0.06, 0.08, uOpacity);
    return;
  }

  float hue = (atan(flow.y, flow.x) + PI) / (2.0 * PI);
  float sat = clamp(mag / max(uMaxMag, 1e-6), 0.0, 1.0);
  float val = 0.72 + 0.28 * sat;

  fragColor = vec4(hsv2rgb(hue, sat, val), uOpacity);
}`;

    // ── Integer label map (R32I) ─────────────────────────────────────────
    // uBackground: pixels with this label value are rendered fully transparent.
    // Pass -999 to colour ALL labels (including 0).
    const LABEL_FRAG = `#version 300 es
precision highp float;
precision highp isampler2D;
in vec2 vUv;
out vec4 fragColor;
uniform isampler2D uField;
uniform float uOpacity;
uniform bool  uFlipY;
uniform int   uBackground;

// Murmur-inspired integer hash → visually distinct saturated colour
vec3 labelToColor(int id) {
  if (id == 0) return vec3(0.0);
  uint x = uint(abs(id));
  x ^= x >> 16u;
  x *= 0x45d9f3bu;
  x ^= x >> 16u;
  x *= 0x119de1f3u;
  x ^= x >> 16u;

  float r = float((x       ) & 0xFFu) / 255.0;
  float g = float((x >>  8u) & 0xFFu) / 255.0;
  float b = float((x >> 16u) & 0xFFu) / 255.0;

  // Push towards saturation
  float lum = 0.299*r + 0.587*g + 0.114*b;
  r = clamp(lum + (r - lum) * 3.0, 0.0, 1.0);
  g = clamp(lum + (g - lum) * 3.0, 0.0, 1.0);
  b = clamp(lum + (b - lum) * 3.0, 0.0, 1.0);

  // Minimum brightness so dark hashes remain visible
  return max(vec3(r, g, b), vec3(0.22));
}

void main() {
  vec2 uv = vUv;
  if (uFlipY) uv.y = 1.0 - uv.y;

  int label = texture(uField, uv).r;

  if (uBackground != -999 && label == uBackground) {
    fragColor = vec4(0.0);   // transparent → camera shows through
    return;
  }

  fragColor = vec4(labelToColor(label), uOpacity);
}`;

    // ── RGBA (RGBA32F) ───────────────────────────────────────────────────
    // uChannel: -1=use RGB as-is  0=R  1=G  2=B  3=A (greyscale extract)
    const RGBA_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uField;
uniform float uOpacity;
uniform bool  uFlipY;
uniform int   uChannel;

void main() {
  vec2 uv  = vUv;
  if (uFlipY) uv.y = 1.0 - uv.y;

  vec4  val = texture(uField, uv);
  vec3  col;
  if      (uChannel == 0) col = vec3(val.r);
  else if (uChannel == 1) col = vec3(val.g);
  else if (uChannel == 2) col = vec3(val.b);
  else if (uChannel == 3) col = vec3(val.a);
  else                    col = val.rgb;

  // Auto-normalise if values are outside [0,1]
  float lo = min(col.r, min(col.g, col.b));
  float hi = max(col.r, max(col.g, col.b));
  if (hi - lo > 0.0 && (hi > 1.001 || lo < -0.001)) {
    col = (col - vec3(lo)) / (hi - lo);
  }

  fragColor = vec4(clamp(col, 0.0, 1.0), uOpacity);
}`;

    // ── Edge glow (Sobel → additive blend) ──────────────────────────────
    const EDGE_GLOW_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uField;
uniform vec2  uTexelSize;
uniform vec3  uEdgeColor;
uniform float uEdgeStrength;
uniform float uOpacity;
uniform bool  uFlipY;

float sample1(vec2 uv) {
  // Works for R32F (.r); for RGBA returns first channel
  return texture(uField, uv).r;
}

void main() {
  vec2 uv = vUv;
  if (uFlipY) uv.y = 1.0 - uv.y;

  vec2 ts = uTexelSize;

  float tl = sample1(uv + vec2(-ts.x,  ts.y));
  float tm = sample1(uv + vec2( 0.0,   ts.y));
  float tr = sample1(uv + vec2( ts.x,  ts.y));
  float ml = sample1(uv + vec2(-ts.x,  0.0));
  float mr = sample1(uv + vec2( ts.x,  0.0));
  float bl = sample1(uv + vec2(-ts.x, -ts.y));
  float bm = sample1(uv + vec2( 0.0,  -ts.y));
  float br = sample1(uv + vec2( ts.x, -ts.y));

  float gx = (-tl - 2.0*ml - bl) + (tr + 2.0*mr + br);
  float gy = (-tl - 2.0*tm - tr) + (bl + 2.0*bm + br);

  float edgeMag = clamp(sqrt(gx*gx + gy*gy) * uEdgeStrength, 0.0, 1.0);
  float glow    = pow(edgeMag, 0.5);

  fragColor = vec4(uEdgeColor * glow, glow * uOpacity);
}`;

    // ── Animated contour lines (R32F, time-driven) ───────────────────────
    const CONTOUR_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uField;
uniform float uMin;
uniform float uMax;
uniform float uOpacity;
uniform float uTime;
uniform float uScrollSpeed;
uniform float uContourDensity;
uniform bool  uFlipY;

void main() {
  vec2  uv    = vUv;
  if (uFlipY) uv.y = 1.0 - uv.y;

  float raw   = texture(uField, uv).r;
  float range = max(uMax - uMin, 1e-7);
  float t     = (raw - uMin) / range;

  // Background: subtle diverging tint
  vec3 bgLo  = vec3(0.04, 0.10, 0.32);
  vec3 bgMid = vec3(0.06, 0.06, 0.06);
  vec3 bgHi  = vec3(0.32, 0.04, 0.04);
  vec3 bgCol = t < 0.5
    ? mix(bgLo,  bgMid, clamp(t * 2.0,       0.0, 1.0))
    : mix(bgMid, bgHi,  clamp((t-0.5) * 2.0, 0.0, 1.0));

  // Scrolling contour bands
  float drift   = uTime * uScrollSpeed;
  float bands   = fract((t + drift) * uContourDensity);
  float lineW   = fwidth(t * uContourDensity) * 2.0;
  float contour = 1.0 - smoothstep(0.0, lineW, min(bands, 1.0 - bands));

  vec3 lineCol  = mix(
    vec3(0.35, 0.65, 1.0),
    vec3(1.0,  0.72, 0.18),
    clamp(t * 2.0, 0.0, 1.0)
  );

  // Permanent zero-crossing line (bright yellow-white)
  float absNorm = abs(raw) / max(range, 1e-7);
  float zcW     = fwidth(absNorm) * 4.0;
  float zcLine  = 1.0 - smoothstep(0.0, zcW, absNorm);

  vec3 col = bgCol;
  col = mix(col, lineCol,           contour * 0.85);
  col = mix(col, vec3(1.0,0.97,0.5), zcLine  * 0.95);

  fragColor = vec4(col, uOpacity);
}`;

    // ── Emergence (field-keyed composite) ────────────────────────────────
    // Low-value pixels → transparent (camera shows through)
    // High-value pixels → accent colour glow
    const EMERGENCE_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uField;
uniform vec3  uAccentColor;
uniform float uThreshold;
uniform float uOpacity;
uniform bool  uFlipY;

void main() {
  vec2  uv    = vUv;
  if (uFlipY) uv.y = 1.0 - uv.y;

  float v     = texture(uField, uv).r;
  float blend = smoothstep(max(0.0, uThreshold - 0.1), uThreshold, v);
  float intensity = clamp((v - uThreshold) / max(1.0 - uThreshold, 0.01), 0.0, 1.0);
  vec3  col   = uAccentColor * (0.5 + 0.5 * intensity);

  fragColor = vec4(col, blend * uOpacity);
}`;

    // Compile all programs eagerly so errors surface at startup, not at use
    const programs = {
      scalar:            [VERT, SCALAR_FRAG],
      flow:              [VERT, FLOW_FRAG],
      label:             [VERT, LABEL_FRAG],
      rgba:              [VERT, RGBA_FRAG],
      edge_glow:         [VERT, EDGE_GLOW_FRAG],
      contour_animated:  [VERT, CONTOUR_FRAG],
      emergence:         [VERT, EMERGENCE_FRAG]
    };

    for (const [name, [v, f]] of Object.entries(programs)) {
      try {
        this._programs[name] = this._linkProgram(v, f, name);
      } catch (err) {
        console.error(`[ArtifactRenderer] Failed to compile '${name}' shader:`, err);
      }
    }

    console.log('[ArtifactRenderer] All shaders compiled:', Object.keys(this._programs));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // UPLOAD METHODS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Upload a single-channel Float32Array → R32F texture.
   * length must equal width × height.
   */
  uploadScalar(name, data, width, height) {
    if (!(data instanceof Float32Array)) data = new Float32Array(data);
    if (data.length !== width * height) {
      console.warn(`[ArtifactRenderer] uploadScalar('${name}'): expected ${width * height}, got ${data.length}`);
      return false;
    }
    return this._upload(name, data, width, height, 'R32F');
  }

  /**
   * Upload separate u and v Float32Arrays → RG32F (interleaved internally).
   * Each must have length = width × height.
   */
  uploadFlow(name, u, v, width, height) {
    if (!u || !v || u.length !== width * height || v.length !== width * height) {
      console.warn(`[ArtifactRenderer] uploadFlow('${name}'): invalid u/v arrays`);
      return false;
    }
    const interleaved = new Float32Array(width * height * 2);
    for (let i = 0; i < u.length; i++) {
      interleaved[i * 2]     = u[i];
      interleaved[i * 2 + 1] = v[i];
    }
    return this._upload(name, interleaved, width, height, 'RG32F');
  }

  /**
   * Upload a pre-interleaved 2-channel Float32Array → RG32F.
   * length must equal width × height × 2.
   * Use for warpField.field (already interleaved [r0,θ0, r1,θ1, ...]).
   */
  uploadFlowInterleaved(name, data, width, height) {
    if (!(data instanceof Float32Array)) data = new Float32Array(data);
    if (data.length !== width * height * 2) {
      console.warn(`[ArtifactRenderer] uploadFlowInterleaved('${name}'): expected ${width * height * 2}, got ${data.length}`);
      return false;
    }
    return this._upload(name, data, width, height, 'RG32F');
  }

  /**
   * Upload a stride-4 Float32Array → RGBA32F.
   * length must equal width × height × 4.
   */
  uploadRGBA(name, data, width, height) {
    if (!(data instanceof Float32Array)) data = new Float32Array(data);
    if (data.length !== width * height * 4) {
      console.warn(`[ArtifactRenderer] uploadRGBA('${name}'): expected ${width * height * 4}, got ${data.length}`);
      return false;
    }
    return this._upload(name, data, width, height, 'RGBA32F');
  }

  /**
   * Upload an Int32Array → R32I.
   * length must equal width × height.
   * Use for topologyMap, componentMap, worldFrameMap, cladeMap, correspondenceMap.
   */
  uploadLabel(name, data, width, height) {
    const int32 = (data instanceof Int32Array)
      ? data
      : new Int32Array(data instanceof ArrayBuffer ? data : data.buffer);
    if (int32.length !== width * height) {
      console.warn(`[ArtifactRenderer] uploadLabel('${name}'): expected ${width * height}, got ${int32.length}`);
      return false;
    }
    return this._upload(name, int32, width, height, 'R32I');
  }

  /**
   * Core upload — replaces any existing texture registered under `name`.
   * @private
   */
  _upload(name, data, width, height, format) {
    const gl = this.gl;

    // Delete previous texture for this slot
    const prev = this._registry.get(name);
    if (prev) {
      try { gl.deleteTexture(prev.texture); } catch (_) {}
    }

    const tex = gl.createTexture();
    try {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

      if (format === 'R32F') {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0,
                      gl.RED, gl.FLOAT, data);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      } else if (format === 'RG32F') {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, width, height, 0,
                      gl.RG, gl.FLOAT, data);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      } else if (format === 'RGBA32F') {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0,
                      gl.RGBA, gl.FLOAT, data);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      } else if (format === 'R32I') {
        // Integer textures MUST use NEAREST — LINEAR is forbidden by WebGL2 spec
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32I, width, height, 0,
                      gl.RED_INTEGER, gl.INT, data);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

      } else {
        throw new Error('[ArtifactRenderer] Unknown format: ' + format);
      }

      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);

      this._registry.set(name, {
        texture:    tex,
        width,
        height,
        format,
        uploadedAt: Date.now()
      });

      const sizeMB = (data.byteLength / 1048576).toFixed(2);
      console.log(`[ArtifactRenderer] '${name}' uploaded: ${width}×${height} ${format} (${sizeMB} MB)`);
      return true;

    } catch (err) {
      try { gl.deleteTexture(tex); } catch (_) {}
      console.warn(`[ArtifactRenderer] Upload failed for '${name}':`, err);
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ACTIVE ARTIFACT STATE
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Set the artifact that will render on every renderActiveIfAny() call.
   * @param {string} name   - registry key
   * @param {string} mode   - visualization mode (scalar|flow|label|rgba|
   *                          edge_glow|contour_animated|emergence|standalone)
   * @param {Object} params - mode-specific parameters (see render() docs)
   */
  setActive(name, mode, params = {}) {
    this._activeName   = name;
    this._activeMode   = mode;
    this._activeParams = { ...params };
    // Initialise time reference on first activation
    if (!this._startTime) this._startTime = performance.now();
  }

  /** Clear active artifact — subsequent renderActiveIfAny() calls are no-ops. */
  clearActive() {
    this._activeName   = null;
    this._activeMode   = null;
    this._activeParams = {};
    // Keep _startTime so re-activation resumes from same time base
  }

  /** Returns true if there is a registered, active artifact to render. */
  hasActive() {
    return !!(this._activeName && this._registry.has(this._activeName));
  }

  /**
   * Render the active artifact.
   * Call after compositeRenderer.processFrame() in the render loop so the
   * artifact overlays the camera composite that is already on the framebuffer.
   */
  renderActiveIfAny() {
    if (!this.hasActive()) return;

    const mode       = this._activeMode   || 'scalar';
    const params     = this._activeParams || {};
    const name       = this._activeName;
    const elapsedSec = (performance.now() - (this._startTime || 0)) / 1000;

    if (mode === 'edge_glow') {
      this._renderEdgeGlow(name, params);
    } else if (mode === 'contour_animated') {
      this._renderContourAnimated(name, params, elapsedSec);
    } else if (mode === 'emergence') {
      this._renderEmergence(name, params);
    } else if (mode === 'standalone') {
      // Full-opacity: covers composite entirely
      this.render(name, { ...params, opacity: 1.0 });
    } else {
      // scalar, flow, label, rgba — standard alpha-over blend
      this.render(name, params);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RENDER (standard modes)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Render a registered artifact as a full-screen overlay.
   *
   * @param {string} name
   * @param {Object} params
   *   opacity     {number}  [0.85]
   *   flipY       {boolean} [false]
   *
   *   — scalar (R32F) —
   *   min         {number}  [0.0]
   *   max         {number}  [1.0]
   *   colormap    {number}  [0]  0=grey 1=diverging 2=hot 3=SDF-contour
   *
   *   — flow (RG32F) —
   *   maxMag      {number}  [5.0]
   *
   *   — label (R32I) —
   *   background  {number}  [0]  label rendered transparent (-999 = colour all)
   *
   *   — rgba (RGBA32F) —
   *   channel     {number}  [-1] -1=RGB  0=R  1=G  2=B  3=A
   */
  render(name, params = {}) {
    const entry = this._registry.get(name);
    if (!entry) {
      console.warn(`[ArtifactRenderer] render('${name}'): not in registry`);
      return;
    }

    const gl      = this.gl;
    const format  = entry.format;
    const opacity = params.opacity ?? 0.85;
    const flipY   = params.flipY   ?? false;

    let progName;
    if      (format === 'R32I')    progName = 'label';
    else if (format === 'RG32F')   progName = 'flow';
    else if (format === 'RGBA32F') progName = 'rgba';
    else                           progName = 'scalar';

    const prog = this._programs[progName];
    if (!prog) {
      console.warn(`[ArtifactRenderer] No compiled program for format '${format}'`);
      return;
    }

    // Alpha-over composite blend
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(
      gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,       gl.ONE_MINUS_SRC_ALPHA
    );

    gl.useProgram(prog);
    gl.bindVertexArray(this._vao);

    // All programs sample from unit 0 as 'uField'
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    this._uniform1i(prog, 'uField',  0);
    this._uniform1f(prog, 'uOpacity', opacity);
    this._uniform1i(prog, 'uFlipY',   flipY ? 1 : 0);

    if (format === 'R32F') {
      this._uniform1f(prog, 'uMin',      params.min      ?? 0.0);
      this._uniform1f(prog, 'uMax',      params.max      ?? 1.0);
      this._uniform1i(prog, 'uColormap', params.colormap ?? 0);

    } else if (format === 'RG32F') {
      this._uniform1f(prog, 'uMaxMag', params.maxMag ?? 5.0);

    } else if (format === 'R32I') {
      this._uniform1i(prog, 'uBackground', params.background ?? 0);

    } else if (format === 'RGBA32F') {
      this._uniform1i(prog, 'uChannel', params.channel ?? -1);
    }

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.useProgram(null);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SPECIAL RENDER MODES
  // ═══════════════════════════════════════════════════════════════════════

  _renderEdgeGlow(name, params) {
    const entry = this._registry.get(name);
    if (!entry) return;

    const gl   = this.gl;
    const prog = this._programs.edge_glow;
    if (!prog) return;

    const edgeColor    = params.edgeColor    || [1.0, 0.5, 0.1];
    const edgeStrength = params.edgeStrength || 3.0;
    const opacity      = params.opacity      || 0.9;
    const flipY        = params.flipY        || false;

    // Additive blend: edges light up without darkening the camera frame
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

    gl.useProgram(prog);
    gl.bindVertexArray(this._vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);

    this._uniform1i(prog, 'uField', 0);
    this._uniform2f(prog, 'uTexelSize', 1.0 / entry.width, 1.0 / entry.height);
    this._uniform3f(prog, 'uEdgeColor', edgeColor[0], edgeColor[1], edgeColor[2]);
    this._uniform1f(prog, 'uEdgeStrength', edgeStrength);
    this._uniform1f(prog, 'uOpacity', opacity);
    this._uniform1i(prog, 'uFlipY', flipY ? 1 : 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.useProgram(null);
  }

  _renderContourAnimated(name, params, elapsedSec) {
    const entry = this._registry.get(name);
    if (!entry) return;

    const gl   = this.gl;
    const prog = this._programs.contour_animated;
    if (!prog) return;

    const opacity        = params.opacity        ?? 0.88;
    const min_           = params.min            ?? -0.5;
    const max_           = params.max            ?? 0.5;
    const scrollSpeed    = params.scrollSpeed    || 0.12;
    const contourDensity = params.contourDensity || 12.0;
    const flipY          = params.flipY          || false;

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(
      gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,       gl.ONE_MINUS_SRC_ALPHA
    );

    gl.useProgram(prog);
    gl.bindVertexArray(this._vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);

    this._uniform1i(prog, 'uField',          0);
    this._uniform1f(prog, 'uMin',            min_);
    this._uniform1f(prog, 'uMax',            max_);
    this._uniform1f(prog, 'uOpacity',        opacity);
    this._uniform1f(prog, 'uTime',           elapsedSec);
    this._uniform1f(prog, 'uScrollSpeed',    scrollSpeed);
    this._uniform1f(prog, 'uContourDensity', contourDensity);
    this._uniform1i(prog, 'uFlipY',          flipY ? 1 : 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.useProgram(null);
  }

  _renderEmergence(name, params) {
    const entry = this._registry.get(name);
    if (!entry) return;

    const gl   = this.gl;
    const prog = this._programs.emergence;
    if (!prog) return;

    const color     = params.color     || [0.3, 0.85, 1.0];
    const threshold = params.threshold ?? 0.4;
    const opacity   = params.opacity   || 0.85;
    const flipY     = params.flipY     || false;

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(
      gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,       gl.ONE_MINUS_SRC_ALPHA
    );

    gl.useProgram(prog);
    gl.bindVertexArray(this._vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);

    this._uniform1i(prog, 'uField',       0);
    this._uniform3f(prog, 'uAccentColor', color[0], color[1], color[2]);
    this._uniform1f(prog, 'uThreshold',   threshold);
    this._uniform1f(prog, 'uOpacity',     opacity);
    this._uniform1i(prog, 'uFlipY',       flipY ? 1 : 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.useProgram(null);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // UNIFORM HELPERS  (avoid getUniformLocation overhead in hot path by
  //                   accepting that uniform lookup is cached by the driver)
  // ═══════════════════════════════════════════════════════════════════════

  _uniform1f(prog, name, v)          { const l = this.gl.getUniformLocation(prog, name); if (l != null) this.gl.uniform1f(l, v); }
  _uniform1i(prog, name, v)          { const l = this.gl.getUniformLocation(prog, name); if (l != null) this.gl.uniform1i(l, v); }
  _uniform2f(prog, name, x, y)       { const l = this.gl.getUniformLocation(prog, name); if (l != null) this.gl.uniform2f(l, x, y); }
  _uniform3f(prog, name, x, y, z)    { const l = this.gl.getUniformLocation(prog, name); if (l != null) this.gl.uniform3f(l, x, y, z); }

  // ═══════════════════════════════════════════════════════════════════════
  // REGISTRY MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════

  /** Returns true if an artifact is registered under `name`. */
  has(name) {
    return this._registry.has(name);
  }

  /**
   * Returns a descriptor array for all registered artifacts.
   * Used by ArtifactPanel to decide which buttons to show.
   */
  list() {
    return Array.from(this._registry.entries()).map(([name, e]) => {
      const channels = { 'R32F': 1, 'RG32F': 2, 'RGBA32F': 4, 'R32I': 4 };
      const ch       = channels[e.format] || 4;
      return {
        name,
        width:      e.width,
        height:     e.height,
        format:     e.format,
        sizeMB:     ((e.width * e.height * ch * 4) / 1048576).toFixed(2),
        uploadedAt: e.uploadedAt
      };
    });
  }

  /** Delete a single artifact texture by name. */
  clear(name) {
    const e = this._registry.get(name);
    if (e) {
      try { this.gl.deleteTexture(e.texture); } catch (_) {}
      this._registry.delete(name);
    }
  }

  /**
   * Delete ALL artifact textures.
   * Safe to call between pipeline runs.
   */
  clearAll() {
    for (const [, e] of this._registry.entries()) {
      try { this.gl.deleteTexture(e.texture); } catch (_) {}
    }
    this._registry.clear();
    console.log('[ArtifactRenderer] All textures cleared');
  }

  /** Release all GL resources. Call from MotionPainter.destroy(). */
  destroy() {
    this.clearAll();
    const gl = this.gl;
    for (const p of Object.values(this._programs)) {
      try { gl.deleteProgram(p); } catch (_) {}
    }
    this._programs = {};
    if (this._vbo) { try { gl.deleteBuffer(this._vbo);      } catch (_) {} this._vbo = null; }
    if (this._vao) { try { gl.deleteVertexArray(this._vao); } catch (_) {} this._vao = null; }
    console.log('[ArtifactRenderer] Destroyed');
  }
}

export default ArtifactRenderer;