(subject to change during development)

motion-painter/
├── src/
│ ├── js/
│ │ ├── core/
│ │ │ ├── WebGLRenderer.js # WebGL2 context, shaders, programs
│ │ │ ├── FrameBuffer.js # Ring buffer texture management
│ │ │ ├── MotionDetector.js # Frame differencing & motion analysis
│ │ │ └── CompositeRenderer.js # Final composition & effects
│ │ ├── ui/
│ │ │ ├── Controls.js # UI controls management
│ │ │ └── MediaInput.js # Camera/video input handling
│ │ ├── shaders/
│ │ │ ├── composite.frag # Main composite fragment shader
│ │ │ ├── motion.frag # Motion detection fragment shader
│ │ │ └── quad.vert # Vertex shader for full-screen quad
│ │ ├── utils/
│ │ │ ├── ShaderUtils.js # Shader compilation utilities
│ │ │ └── MathUtils.js # Math/utility functions
│ │ └── main.js # Application entry point
│ ├── styles/
│ │ ├── main.css # Main styles
│ │ ├── controls.css # UI controls styling
│ │ └── layout.css # Layout & responsive styles
│ └── assets/
│ └── sample-video.mp4 # Sample video file
├── public/
│ └── index.html # HTML template
├── dist/ # Built files (webpack output)
├── webpack.config.js # Webpack configuration
├── .gitignore
├── package.json
└── README.md

# Motion Painter - Complete Technical Deep Dive

## Overview & Concept

Motion Painter is a **real-time temporal compositing system** that creates artistic visual effects by analyzing and blending multiple video frames across time. It transforms motion into visual art by creating "temporal echoes" - ghostly trails of past movement that persist and blend with the current frame.

**Core Innovation**: Instead of just showing the current video frame, it maintains a sliding window of recent frames and intelligently blends them based on detected motion, creating effects impossible with traditional video processing.

---

## Detailed Architecture

### 1. Core Components

#### **MotionPainter (Main Controller)**

```javascript
class MotionPainter {
  // Orchestrates all components
  // Manages render loop and event handling
  // Controls application lifecycle
}
```

**Key Responsibilities:**

- Initialize all subsystems
- Manage the main render loop (60fps)
- Handle user interactions and events
- Coordinate between UI and rendering systems
- Manage application state (playing, paused, etc.)

#### **WebGLRenderer (Graphics Engine)**

```javascript
class WebGLRenderer {
  // Low-level WebGL operations
  // Shader program management
  // Texture rendering and compositing
}
```

**Technical Details:**

- Creates WebGL2 context with specific settings (no antialias, no depth test)
- Compiles and links shader programs
- Manages vertex array objects (VAO) for full-screen quad
- Handles texture binding and uniform variable updates
- Provides high-level rendering functions

#### **FrameBuffer (Memory Manager)**

```javascript
class FrameBuffer {
  // Manages circular buffer of 4 video frame textures
  // Handles texture creation and rotation
  // Provides frame history access
}
```

**Memory Management Strategy:**

- Uses circular buffer pattern for efficient memory usage
- Pre-allocates 4 RGB textures at video resolution
- Rotates texture indices instead of copying data
- Handles dynamic resizing when video dimensions change

#### **CompositeRenderer (Effect Processor)**

```javascript
class CompositeRenderer {
  // Applies temporal effects and compositing
  // Manages render parameters
  // Coordinates frame processing pipeline
}
```

#### **Controls (UI Manager)**

```javascript
class Controls {
  // Manages all UI interactions
  // Handles parameter validation and updates
  // Provides event system for component communication
}
```

#### **MediaInput (Video Handler)**

```javascript
class MediaInput {
  // Manages camera and video file input
  // Handles WebRTC camera permissions
  // Provides video loading and error handling
}
```

---

## Complete Data Flow Analysis

### Phase 1: Initialization Sequence

```
1. DOM Ready Event
   ↓
2. MotionPainter.init()
   ↓
3. Get Canvas & Video Elements
   ↓
4. Initialize WebGL2 Context
   ↓
5. Compile Shaders (vertex + fragment)
   ↓
6. Create Frame Buffer Textures
   ↓
7. Initialize UI Controls
   ↓
8. Bind Event Handlers
   ↓
9. Ready State
```

### Phase 2: Video Source Setup

```
User Action (Camera/Video)
   ↓
MediaInput.startCamera() OR MediaInput.loadSampleVideo()
   ↓
Acquire Video Stream/File
   ↓
video.play() - Start Video Playback
   ↓
onSourceReady() Callback
   ↓
MotionPainter.startRendering()
   ↓
Initialize Frame Buffer with First Frame
   ↓
Start Render Loop
```

### Phase 3: Frame Processing Pipeline (60fps)

```
requestAnimationFrame()
   ↓
Check if video.readyState >= 2 (enough data)
   ↓
FrameBuffer.uploadVideoFrame(video)
   - Bind current texture slot
   - gl.texImage2D() uploads video frame to GPU
   ↓
FrameBuffer.rotateBuffers()
   - Rearrange texture array so newest is at index 0
   ↓
FrameBuffer.advanceWriteIndex()
   - Move to next texture slot for next frame
   ↓
CompositeRenderer.render()
   - Apply temporal effects
   - Composite final image
   ↓
WebGLRenderer.renderComposite() OR renderMotionMask()
   - Execute shaders
   - Draw to canvas
   ↓
Schedule Next Frame
```

---

## Shader System Deep Dive

### Vertex Shader (quad.vert)

```glsl
#version 300 es
in vec2 aPos;           // Vertex position (-1 to 1)
out vec2 vTexCoord;     // Texture coordinates (0 to 1)

void main() {
    // Convert vertex coords to texture coords
    vTexCoord = (aPos + 1.0) * 0.5;
    gl_Position = vec4(aPos, 0.0, 1.0);
}
```

**Purpose**: Creates full-screen quad covering entire canvas
**Issue**: This is where the upside-down problem occurs!

### Composite Fragment Shader (composite.frag)

```glsl
#version 300 es
precision highp float;

// Frame textures (4 historical frames)
uniform sampler2D uFrame0;  // Current frame
uniform sampler2D uFrame1;  // 1 frame ago
uniform sampler2D uFrame2;  // 2 frames ago
uniform sampler2D uFrame3;  // 3 frames ago

// Effect parameters
uniform int uTimeShift;     // Which frame to use for main blend
uniform float uOpacity;     // Blend ratio old/new
uniform bool uInvert;       // Invert historical frames
uniform int uRoff, uGoff, uBoff;  // RGB channel time offsets
uniform float uMotionThresh;  // Motion detection sensitivity
uniform float uGlow;        // Motion area brightness boost

in vec2 vTexCoord;
out vec4 fragColor;

void main() {
    vec2 coord = vTexCoord;

    // Sample current and historical frames
    vec4 current = texture(uFrame0, coord);
    vec4 shifted = texture(/* frame based on uTimeShift */, coord);

    // Calculate motion mask (difference between frames)
    float motion = length(current.rgb - shifted.rgb);
    bool hasMotion = motion > uMotionThresh;

    // Apply RGB channel time shifting
    vec4 timeShifted;
    timeShifted.r = texture(/* frame uRoff */, coord).r;
    timeShifted.g = texture(/* frame uGoff */, coord).g;
    timeShifted.b = texture(/* frame uBoff */, coord).b;
    timeShifted.a = 1.0;

    // Apply inversion to historical frames
    if (uInvert) {
        timeShifted.rgb = 1.0 - timeShifted.rgb;
    }

    // Blend based on motion and opacity
    vec4 blended = mix(current, timeShifted, uOpacity);

    // Apply glow effect to motion areas
    if (hasMotion) {
        blended.rgb *= (1.0 + uGlow);
    }

    fragColor = blended;
}
```

### Motion Detection Shader (motion.frag)

```glsl
#version 300 es
precision highp float;

uniform sampler2D uCurr;    // Current frame
uniform sampler2D uPrev;    // Previous frame
uniform float uMotionThresh; // Detection threshold

in vec2 vTexCoord;
out vec4 fragColor;

void main() {
    vec4 current = texture(uCurr, vTexCoord);
    vec4 previous = texture(uPrev, vTexCoord);

    // Calculate luminance-based difference
    float currLum = dot(current.rgb, vec3(0.299, 0.587, 0.114));
    float prevLum = dot(previous.rgb, vec3(0.299, 0.587, 0.114));

    float diff = abs(currLum - prevLum);
    float motion = step(uMotionThresh, diff);

    // Output as grayscale (white = motion, black = no motion)
    fragColor = vec4(motion, motion, motion, 1.0);
}
```

---

## Frame Buffer System Explained

### Buffer Structure

```
Frame Buffer (Circular Array)
┌─────────────┬─────────────┬─────────────┬─────────────┐
│   Texture 0 │   Texture 1 │   Texture 2 │   Texture 3 │
│  (Current)  │ (1 frame    │ (2 frames   │ (3 frames   │
│             │  ago)       │  ago)       │  ago)       │
└─────────────┴─────────────┴─────────────┴─────────────┘
      ↑
  writeIndex
```

### Rotation Process

```javascript
// Before rotation (after uploading new frame)
textures = [old0, old1, old2, NEW_FRAME]
writeIndex = 3

// After rotation
textures = [NEW_FRAME, old0, old1, old2]
writeIndex = 0 (ready for next frame)
```

**Why Rotation Instead of Copying?**

- **Performance**: Moving array indices is faster than copying texture data
- **Memory**: Avoids GPU memory allocation/deallocation
- **Predictable Access**: Index 0 is always newest, index 3 is always oldest

### Texture Management

```javascript
createTexture(width, height) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);

    // Allocate empty texture memory
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0,
                  gl.RGBA, gl.UNSIGNED_BYTE, null);

    // Set filtering (LINEAR for smooth interpolation)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // Clamp to edges (prevent wrapping artifacts)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}
```

---

## UI Controls - Complete Reference

### Source Controls

#### **Start Camera Button**

- **Function**: `MediaInput.startCamera()`
- **WebRTC Call**: `navigator.mediaDevices.getUserMedia()`
- **Default Settings**:
  ```javascript
  {
    video: {
      facingMode: 'environment',  // Back camera on mobile
      width: { ideal: 1280 },
      height: { ideal: 720 }
    },
    audio: false
  }
  ```
- **Error Handling**: Permission denied, no camera found, not supported
- **Status Updates**: "starting camera..." → "camera started" or error

#### **Load Sample Video Button**

- **Function**: `MediaInput.loadSampleVideo()`
- **Default URL**: Mozilla's sample flower video
- **Features**: Automatically loops, muted playback
- **Fallback**: 10-second timeout with error handling

### Temporal Effect Controls

#### **Time Shift Slider (0-3)**

- **Purpose**: Controls which historical frame is used for main temporal blending
- **Values**:
  - `0`: Only current frame (no temporal effect)
  - `1`: Blend current with 1 frame ago
  - `2`: Blend current with 2 frames ago
  - `3`: Blend current with 3 frames ago
- **Visual Effect**: Higher values create longer "temporal trails"
- **Performance Impact**: Minimal (just changes texture sampling)

#### **Opacity Slider (0.0-1.0)**

- **Purpose**: Controls blending ratio between current and historical frames
- **Implementation**: `mix(current, historical, opacity)` in shader
- **Values**:
  - `0.0`: Only current frame visible
  - `0.5`: Equal blend of current and historical
  - `1.0`: Only historical frame visible (ghostly effect)
- **Artistic Use**: Lower values for subtle trails, higher for dramatic ghosts

#### **Invert Older Frames Checkbox**

- **Purpose**: Color-inverts historical frames before blending
- **Implementation**: `1.0 - color.rgb` in shader
- **Effect**: Creates negative/positive artistic contrasts
- **Best Used With**: Medium opacity values (0.3-0.7)

### Advanced Color Controls

#### **RGB Channel Time Offsets (3 separate sliders, 0-3)**

- **Purpose**: Each color channel can sample from different time points
- **Default**: R=1, G=2, B=3 (creates rainbow trails)
- **Implementation**:
  ```glsl
  result.r = texture(frameTextures[uRoff], coord).r;
  result.g = texture(frameTextures[uGoff], coord).g;
  result.b = texture(frameTextures[uBoff], coord).b;
  ```
- **Creative Possibilities**:
  - `R=G=B=0`: All channels from current (no effect)
  - `R=1, G=1, B=1`: All channels from 1 frame ago (monochromatic ghost)
  - `R=0, G=1, B=3`: Red from current, green from 1 ago, blue from 3 ago

### Motion Detection Controls

#### **Motion Threshold Slider (0.0-1.0)**

- **Purpose**: Sensitivity of motion detection algorithm
- **Algorithm**: Luminance difference between consecutive frames
- **Values**:
  - `0.0`: Detects minimal changes (noise-sensitive)
  - `0.08`: Default (good balance)
  - `1.0`: Only detects major changes
- **Scene Dependency**: Bright scenes need higher thresholds, dark scenes need lower

#### **Glow Intensity Slider (0.0-2.0)**

- **Purpose**: Brightness multiplier applied to motion areas
- **Implementation**: `color *= (1.0 + glow)` for moving pixels
- **Values**:
  - `0.0`: No brightness boost
  - `0.9`: Default (subtle glow)
  - `2.0`: Very bright motion highlights
- **Effect**: Makes moving objects "glow" against static background

### Debug & Control

#### **Toggle Motion Mask Button**

- **Purpose**: Shows raw motion detection as black/white mask
- **Implementation**: Switches between composite and motion shaders
- **Visual**: White pixels = motion detected, black = no motion
- **Usage**: Tune motion threshold by observing mask

#### **Pause Button**

- **Purpose**: Stops processing new frames (freezes effect)
- **Implementation**: Sets `isPaused` flag, stops render loop
- **Use Cases**: Examine current effect, adjust parameters without change

### Keyboard Shortcuts

- **Spacebar**: Toggle pause (same as pause button)
- **M**: Toggle motion mask view
- **C**: Start camera
- **V**: Load video
- **R**: Reset all controls to factory defaults

---

## The Upside-Down Problem - Technical Analysis

### Root Cause

The upside-down rendering occurs due to **coordinate system mismatch** between different graphics standards:

#### **Screen/HTML Coordinates**

```
(0,0) ───────────→ X
  │
  │  HTML Canvas
  │  Video Element
  ↓
  Y
```

#### **OpenGL/WebGL Texture Coordinates**

```
  Y
  ↑
  │  WebGL Textures
  │  Framebuffers
(0,0) ───────────→ X
```

### What Happens Step by Step

1. **Video Frame Capture**: HTML video element uses screen coordinates (Y down)
2. **Texture Upload**: `gl.texImage2D(video)` uploads to WebGL texture (Y up convention)
3. **Shader Processing**: Vertex shader creates quad with standard WebGL coordinates
4. **Canvas Display**: Result rendered to HTML canvas (Y down) → **Image appears upside down**

### Solution Options

#### **Option 1: Flip in Vertex Shader (Recommended)**

```glsl
// Current vertex shader (causes problem)
void main() {
    vTexCoord = (aPos + 1.0) * 0.5;
    gl_Position = vec4(aPos, 0.0, 1.0);
}

// Fixed version (flips Y)
void main() {
    vTexCoord = (aPos + 1.0) * 0.5;
    vTexCoord.y = 1.0 - vTexCoord.y;  // Flip texture Y coordinate
    gl_Position = vec4(aPos, 0.0, 1.0);
}
```

#### **Option 2: Flip Vertex Positions**

```javascript
// Current quad vertices
const quadVertices = new Float32Array([
  -1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1,
]);

// Flipped Y version
const quadVertices = new Float32Array([
  -1,
  1,
  1,
  1,
  -1,
  -1, // Flip Y coordinates
  -1,
  -1,
  1,
  1,
  1,
  -1,
]);
```

#### **Option 3: CSS Transform (Quick Fix)**

```css
#glcanvas {
  transform: scaleY(-1); /* Flip canvas vertically */
}
```

---

## Performance Optimization Details

### GPU Memory Usage

```javascript
// Memory calculation for 1280x720 video
const bytesPerPixel = 4; // RGBA
const frameSize = 1280 * 720 * bytesPerPixel; // ~3.7MB per frame
const bufferSize = 4; // 4 historical frames
const totalGPUMemory = frameSize * bufferSize; // ~14.8MB
```

### Render Loop Optimization

```javascript
renderLoop() {
    // Early exit conditions
    if (!this.isRendering || this.isPaused) return;
    if (!this.mediaInput.isVideoReady()) {
        // Skip processing, just schedule next frame
        this.animationId = requestAnimationFrame(() => this.renderLoop());
        return;
    }

    try {
        this.compositeRenderer.processFrame(this.video);
    } catch (error) {
        // Error handling stops infinite error loops
        this.stopRendering();
        return;
    }

    // Schedule next frame
    this.animationId = requestAnimationFrame(() => this.renderLoop());
}
```

### WebGL State Management

- **Disable Depth Testing**: 2D application doesn't need Z-buffer
- **Disable Blending**: Custom blending done in shaders
- **Linear Filtering**: Smooth interpolation for motion trails
- **Clamp to Edge**: Prevents texture wrapping artifacts

---

## Creative Applications & Effects

### Classic Effects You Can Create

#### **1. Time Echo Trails**

- Settings: `timeShift=2, opacity=0.4, invert=false`
- Effect: Moving objects leave fading trails behind them
- Best for: Dance, sports, gesture capture

#### **2. RGB Chromatic Aberration**

- Settings: `rOff=0, gOff=1, bOff=2, opacity=0.8`
- Effect: Red from current, green from 1 ago, blue from 2 ago
- Best for: Retro/glitch aesthetic

#### **3. Negative Ghost**

- Settings: `timeShift=3, opacity=0.6, invert=true, glow=1.5`
- Effect: Dark negative trails with bright highlights
- Best for: Dramatic artistic effects

#### **4. Motion-Only Painting**

- Settings: `motionThresh=0.15, opacity=1.0, glow=2.0`
- Effect: Only moving areas show temporal effects
- Best for: Performance analysis, motion isolation

### Advanced Techniques

#### **Dynamic Parameter Animation**

```javascript
// Example: Breathing opacity effect
setInterval(() => {
  const breathing = 0.5 + 0.3 * Math.sin(Date.now() * 0.003);
  controls.setParam("opacity", breathing);
}, 50);
```

#### **Scene-Adaptive Thresholding**

```javascript
// Adjust threshold based on detected motion level
const motionLevel = analyzeCurrentMotion();
if (motionLevel > 0.8) {
  controls.setParam("motionThresh", 0.12); // Reduce sensitivity
} else if (motionLevel < 0.2) {
  controls.setParam("motionThresh", 0.05); // Increase sensitivity
}
```

---

## Troubleshooting Guide

### Common Issues

#### **1. Black/Empty Canvas**

- **Causes**: WebGL context lost, shader compilation failed, no video input
- **Debug**: Check browser console for WebGL errors
- **Fix**: Refresh page, try different browser

#### **2. Choppy/Laggy Performance**

- **Causes**: High resolution video, old GPU, background tabs
- **Debug**: Monitor framerate with `performance.now()`
- **Fix**: Lower video resolution, close other tabs

#### **3. Camera Permission Denied**

- **Causes**: Browser security policy, user denied permission
- **Debug**: Check browser permission settings
- **Fix**: Allow camera access, try HTTPS instead of HTTP

#### **4. Upside-Down Video**

- **Causes**: WebGL coordinate system mismatch
- **Debug**: Visual inspection
- **Fix**: Apply one of the coordinate flipping solutions above

### Browser Compatibility

#### **WebGL2 Support Required**

- **Chrome**: 56+ (2017)
- **Firefox**: 51+ (2017)
- **Safari**: 15+ (2021)
- **Edge**: 79+ (2020)

#### **MediaDevices API (Camera)**

- **Requirement**: HTTPS or localhost
- **Mobile**: iOS Safari 11+, Chrome Mobile 53+

---

## Extension Possibilities

### Advanced Features You Could Add

#### **1. Multi-Layer Compositing**

- Add more frame buffer slots (8, 16 frames)
- Multiple blend modes (multiply, screen, overlay)
- Layer-based parameter control

#### **2. Audio-Reactive Effects**

- Analyze audio input with Web Audio API
- Modulate parameters based on frequency/amplitude
- Beat detection for rhythm-synced effects

#### **3. Machine Learning Integration**

- Pose detection with TensorFlow.js
- Object tracking for targeted effects
- Style transfer for artistic filters

#### **4. Recording & Export**

- Canvas.captureStream() for video recording
- Frame export as image sequences
- Parameter automation recording/playback
