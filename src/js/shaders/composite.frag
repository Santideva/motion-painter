#version 300 es
precision highp float;

in vec2 vTexCoord;
out vec4 fragColor;

uniform sampler2D uFrame0;
uniform sampler2D uFrame1;
uniform sampler2D uFrame2;
uniform sampler2D uFrame3;
uniform sampler2D uFrame4;
uniform sampler2D uFrame5;
uniform sampler2D uFrame6;
uniform sampler2D uFrame7;
uniform sampler2D uFrame8;
uniform sampler2D uFrame9;
uniform sampler2D uFrame10;
uniform sampler2D uFrame11;
uniform sampler2D uFrame12;
uniform sampler2D uFrame13;
uniform sampler2D uFrame14;
uniform sampler2D uFrame15;

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

vec4 sampleFrame(int frameIndex, vec2 texCoord) {
    int index = clamp(frameIndex, 0, uBufferSize - 1);
    if (index == 0) return texture(uFrame0, texCoord);
    else if (index == 1) return texture(uFrame1, texCoord);
    else if (index == 2) return texture(uFrame2, texCoord);
    else if (index == 3) return texture(uFrame3, texCoord);
    else if (index == 4) return texture(uFrame4, texCoord);
    else if (index == 5) return texture(uFrame5, texCoord);
    else if (index == 6) return texture(uFrame6, texCoord);
    else if (index == 7) return texture(uFrame7, texCoord);
    else if (index == 8) return texture(uFrame8, texCoord);
    else if (index == 9) return texture(uFrame9, texCoord);
    else if (index == 10) return texture(uFrame10, texCoord);
    else if (index == 11) return texture(uFrame11, texCoord);
    else if (index == 12) return texture(uFrame12, texCoord);
    else if (index == 13) return texture(uFrame13, texCoord);
    else if (index == 14) return texture(uFrame14, texCoord);
    else if (index == 15) return texture(uFrame15, texCoord);
    else return texture(uFrame0, texCoord);
}

float getLuminance(vec3 color) {
    return dot(color, vec3(0.299, 0.587, 0.114));
}

float calculateMotion(vec2 texCoord) {
    vec3 current = sampleFrame(0, texCoord).rgb;
    vec3 previous = sampleFrame(1, texCoord).rgb;
    float currentLum = getLuminance(current);
    float previousLum = getLuminance(previous);
    return abs(currentLum - previousLum);
}

void main() {
    vec2 texCoord = vTexCoord;
    if (uFlipY) texCoord.y = 1.0 - texCoord.y;

    vec4 currentFrame = sampleFrame(0, texCoord);
    float motion = calculateMotion(texCoord);
    float motionMask = smoothstep(uMotionThresh * 0.5, uMotionThresh * 1.5, motion);

    int rIndex = clamp(uRoff, 0, uBufferSize - 1);
    int gIndex = clamp(uGoff, 0, uBufferSize - 1);
    int bIndex = clamp(uBoff, 0, uBufferSize - 1);

    vec4 rFrame = sampleFrame(rIndex, texCoord);
    vec4 gFrame = sampleFrame(gIndex, texCoord);
    vec4 bFrame = sampleFrame(bIndex, texCoord);

    vec3 temporalColor = vec3(rFrame.r, gFrame.g, bFrame.b);

    if (uInvert && (rIndex > 0 || gIndex > 0 || bIndex > 0)) {
        if (rIndex > 0) temporalColor.r = 1.0 - temporalColor.r;
        if (gIndex > 0) temporalColor.g = 1.0 - temporalColor.g;
        if (bIndex > 0) temporalColor.b = 1.0 - temporalColor.b;
    }

    vec3 blendedColor = mix(temporalColor, currentFrame.rgb, uOpacity);

    float glowFactor = 1.0 + (motionMask * uGlow);
    blendedColor *= glowFactor;

    if (uBufferSize > 8) {
        float depthBlend = 0.1 * (1.0 - uOpacity);
        int midFrame = uBufferSize / 2;
        int farFrame = min(uBufferSize - 1, (uBufferSize * 3) / 4);
        vec3 midColor = sampleFrame(midFrame, texCoord).rgb;
        vec3 farColor = sampleFrame(farFrame, texCoord).rgb;
        if (uInvert) {
            midColor = 1.0 - midColor;
            farColor = 1.0 - farColor;
        }
        blendedColor += depthBlend * motionMask * (midColor * 0.3 + farColor * 0.2);
    }

    blendedColor = blendedColor / (blendedColor + vec3(1.0));
    blendedColor = pow(blendedColor, vec3(1.0 / 2.2));

    fragColor = vec4(clamp(blendedColor, 0.0, 1.0), currentFrame.a);
}
