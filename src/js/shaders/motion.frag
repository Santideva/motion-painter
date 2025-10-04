#version 300 es
precision highp float;
precision highp sampler2DArray;
precision highp sampler2D;

in vec2 vTexCoord;
out vec4 fragColor;

// NEW: Use array texture instead of separate current/previous samplers
uniform sampler2DArray uFramesArray;
uniform int uCurrentLayer;
uniform int uPreviousLayer;
uniform float uMotionThresh;
uniform bool uFlipY;

// Calibration uniforms (simplified for motion detection)
uniform bool uUseCalibration;
uniform sampler2D uDark;
uniform sampler2D uBias;

float getLuminance(vec3 color) {
    return dot(color, vec3(0.299, 0.587, 0.114));
}

// Simple calibration used by the motion shader: (src - dark) / bias
vec3 applyCalibrationSimple(vec3 src, vec2 tc) {
    if (!uUseCalibration) return src;

    vec3 dark = texture(uDark, tc).rgb;
    vec3 bias = texture(uBias, tc).rgb;

    // Safety clamp to avoid division by zero and NaNs
    const float EPS = 1e-3;
    bias = max(bias, vec3(EPS));

    vec3 corrected = (src - dark) / bias;
    return clamp(corrected, 0.0, 1.0);
}

void main() {
    vec2 texCoord = vTexCoord;
    if (uFlipY) texCoord.y = 1.0 - texCoord.y;

    // Sample current and previous frames from the array texture
    // Use +0.5 to center sampling in the layer and avoid interpolation between layers
    vec3 currentColor = texture(uFramesArray, vec3(texCoord, float(uCurrentLayer) + 0.5)).rgb;
    vec3 previousColor = texture(uFramesArray, vec3(texCoord, float(uPreviousLayer) + 0.5)).rgb;

    // Apply calibration to colors used for motion detection (optional)
    currentColor = applyCalibrationSimple(currentColor, texCoord);
    previousColor = applyCalibrationSimple(previousColor, texCoord);

    // Calculate luminance-based motion detection
    float currentLum = getLuminance(currentColor);
    float previousLum = getLuminance(previousColor);
    float difference = abs(currentLum - previousLum);

    // Apply smoothstep for smooth motion threshold
    float motion = smoothstep(uMotionThresh * 0.5, uMotionThresh * 1.5, difference);

    // Create motion visualization color
    vec3 motionColor = vec3(motion);
    if (motion > 0.1) {
        // Blend between white and red based on motion intensity
        motionColor = mix(vec3(1.0, 1.0, 1.0), vec3(1.0, 0.3, 0.3), motion);
    }

    fragColor = vec4(motionColor, 1.0);
}