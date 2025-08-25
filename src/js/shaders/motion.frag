#version 300 es
precision highp float;

// Input from vertex shader
in vec2 vTexCoord;

// Output
out vec4 fragColor;

// Texture samplers
uniform sampler2D uCurr;      // Current frame
uniform sampler2D uPrev;      // Previous frame
uniform float uMotionThresh;  // Motion detection threshold

// Calculate luminance
float getLuminance(vec3 color) {
    return dot(color, vec3(0.299, 0.587, 0.114));
}

void main() {
    vec2 texCoord = gl_FragCoord.xy / vec2(textureSize(uCurr, 0));
    
    // Sample current and previous frames
    vec3 currentColor = texture(uCurr, texCoord).rgb;
    vec3 previousColor = texture(uPrev, texCoord).rgb;
    
    // Calculate luminance difference
    float currentLum = getLuminance(currentColor);
    float previousLum = getLuminance(previousColor);
    float difference = abs(currentLum - previousLum);
    
    // Apply threshold and create motion mask
    float motion = smoothstep(uMotionThresh * 0.5, uMotionThresh * 1.5, difference);
    
    // Visualize motion as white pixels
    vec3 motionColor = vec3(motion);
    
    // Optional: Add some color coding for motion intensity
    if (motion > 0.1) {
        // Red for high motion
        motionColor = mix(vec3(1.0, 1.0, 1.0), vec3(1.0, 0.3, 0.3), motion);
    }
    
    fragColor = vec4(motionColor, 1.0);
}