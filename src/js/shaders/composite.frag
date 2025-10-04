#version 300 es
precision highp float;
precision highp sampler2DArray;
precision highp sampler2D;

in vec2 vTexCoord;
out vec4 fragColor;

// NEW: Single array texture instead of 16 individual samplers
uniform sampler2DArray uFramesArray;

uniform int uBufferSize;
uniform int uTimeShift;
uniform float uOpacity;
uniform bool uInvert;
uniform int uRoff;
uniform int uGoff;
uniform int uBoff;
uniform float uMotionThresh;
uniform float uGlow;

uniform bool uFlipY;
uniform float uTime;
uniform float uDelta;

// --- Calibration uniforms ---
uniform bool uUseCalibration;        // true => apply calibration
uniform sampler2D uDark;             // averaged dark frame (RGB)
uniform sampler2D uFlat;             // averaged flat frame (RGB) - optional
uniform sampler2D uBias;             // per-pixel float3 bias normalization map (RGB) - ideally RGB32F

// NEW: Sample a frame from the TEXTURE_2D_ARRAY using layer index
vec4 sampleFrame(int frameIndex, vec2 texCoord) {
    int layerIndex = clamp(frameIndex, 0, uBufferSize - 1);
    // Sample from layer using vec3(texCoord, layerIndex + 0.5)
    // The +0.5 centers the sample in the layer to avoid interpolation between layers
    return texture(uFramesArray, vec3(texCoord, float(layerIndex) + 0.5));
}

float getLuminance(vec3 color) {
    return dot(color, vec3(0.299, 0.587, 0.114));
}

// Calculate motion between the newest two frames
// NOTE: we sample and apply calibration here so motion uses the corrected pixel values
float calculateMotion(vec2 texCoord) {
    vec3 current = sampleFrame(0, texCoord).rgb;
    vec3 previous = sampleFrame(1, texCoord).rgb;

    if (uUseCalibration) {
        const float EPS = 1e-3;
        vec3 dark = texture(uDark, texCoord).rgb;
        vec3 bias = texture(uBias, texCoord).rgb;
        bias = max(bias, vec3(EPS));
        current = clamp((current - dark) / bias, 0.0, 1.0);
        previous = clamp((previous - dark) / bias, 0.0, 1.0);
    }

    float currentLum = getLuminance(current);
    float previousLum = getLuminance(previous);
    return abs(currentLum - previousLum);
}

// Apply calibration to a sampled color: (src - dark) / bias (guarded)
vec3 applyCalibration(vec3 src, vec2 tc) {
    if (!uUseCalibration) return src;

    // Sample dark and bias maps
    vec3 dark = texture(uDark, tc).rgb;
    vec3 bias = texture(uBias, tc).rgb;

    // SAFETY: If bias map is missing or contains zeroes, clamp to small epsilon
    const float EPS = 1e-3;
    bias = max(bias, vec3(EPS));

    // src and dark are expected in [0,1]; subtract dark then divide by bias
    vec3 corrected = (src - dark) / bias;

    // clamp to [0,1] to protect compositing math and prevent NaNs
    return clamp(corrected, 0.0, 1.0);
}

void main() {
    vec2 texCoord = vTexCoord;
    if (uFlipY) texCoord.y = 1.0 - texCoord.y;

    // Sample current frame (layer 0) and apply calibration if available
    vec4 rawCurrentFrame = sampleFrame(0, texCoord);
    vec3 currentFrame = rawCurrentFrame.rgb;
    currentFrame = applyCalibration(currentFrame, texCoord);

    float motion = calculateMotion(texCoord);
    float motionMask = smoothstep(uMotionThresh * 0.5, uMotionThresh * 1.5, motion);

    // Clamp channel offsets to valid layer indices
    int rIndex = clamp(uRoff, 0, uBufferSize - 1);
    int gIndex = clamp(uGoff, 0, uBufferSize - 1);
    int bIndex = clamp(uBoff, 0, uBufferSize - 1);

    // Sample frames for each color channel from the array texture
    vec4 rawRFrame = sampleFrame(rIndex, texCoord);
    vec4 rawGFrame = sampleFrame(gIndex, texCoord);
    vec4 rawBFrame = sampleFrame(bIndex, texCoord);

    // Apply calibration to the temporal frames used for channels
    vec3 rCol = applyCalibration(rawRFrame.rgb, texCoord);
    vec3 gCol = applyCalibration(rawGFrame.rgb, texCoord);
    vec3 bCol = applyCalibration(rawBFrame.rgb, texCoord);

    // Construct temporal color by taking R from rCol, G from gCol, B from bCol
    vec3 temporalColor = vec3(rCol.r, gCol.g, bCol.b);

    // Apply inversion if enabled and using non-current frames
    if (uInvert && (rIndex > 0 || gIndex > 0 || bIndex > 0)) {
        if (rIndex > 0) temporalColor.r = 1.0 - temporalColor.r;
        if (gIndex > 0) temporalColor.g = 1.0 - temporalColor.g;
        if (bIndex > 0) temporalColor.b = 1.0 - temporalColor.b;
    }

    // Blend temporal color with current frame based on opacity
    vec3 blendedColor = mix(temporalColor, currentFrame, uOpacity);

    // Apply glow effect based on motion
    float glowFactor = 1.0 + (motionMask * uGlow);
    blendedColor *= glowFactor;

    // Enhanced depth blending for larger buffer sizes
    // This adds subtle contributions from mid-range and far frames
    if (uBufferSize > 8) {
        float depthBlend = 0.1 * (1.0 - uOpacity);
        int midFrame = uBufferSize / 2;
        int farFrame = min(uBufferSize - 1, (uBufferSize * 3) / 4);
        
        vec3 midColor = sampleFrame(midFrame, texCoord).rgb;
        vec3 farColor = sampleFrame(farFrame, texCoord).rgb;

        // Apply calibration to mid/far frames for consistency
        midColor = applyCalibration(midColor, texCoord);
        farColor = applyCalibration(farColor, texCoord);

        if (uInvert) {
            midColor = 1.0 - midColor;
            farColor = 1.0 - farColor;
        }
        
        // Add depth contribution weighted by motion
        blendedColor += depthBlend * motionMask * (midColor * 0.3 + farColor * 0.2);
    }

    // Apply tonemapping (Reinhard operator)
    blendedColor = blendedColor / (blendedColor + vec3(1.0));
    
    // Apply gamma correction
    blendedColor = pow(blendedColor, vec3(1.0 / 2.2));

    // Output final color, preserving original alpha
    fragColor = vec4(clamp(blendedColor, 0.0, 1.0), rawCurrentFrame.a);
}