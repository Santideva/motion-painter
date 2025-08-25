#version 300 es
precision highp float;

in vec2 vTexCoord;
out vec4 fragColor;

uniform sampler2D uCurr;
uniform sampler2D uPrev;
uniform float uMotionThresh;
uniform bool uFlipY;

float getLuminance(vec3 color) {
    return dot(color, vec3(0.299, 0.587, 0.114));
}

void main() {
    vec2 texCoord = vTexCoord;
    if (uFlipY) texCoord.y = 1.0 - texCoord.y;

    vec3 currentColor = texture(uCurr, texCoord).rgb;
    vec3 previousColor = texture(uPrev, texCoord).rgb;

    float currentLum = getLuminance(currentColor);
    float previousLum = getLuminance(previousColor);
    float difference = abs(currentLum - previousLum);

    float motion = smoothstep(uMotionThresh * 0.5, uMotionThresh * 1.5, difference);

    vec3 motionColor = vec3(motion);
    if (motion > 0.1) {
        motionColor = mix(vec3(1.0, 1.0, 1.0), vec3(1.0, 0.3, 0.3), motion);
    }

    fragColor = vec4(motionColor, 1.0);
}
