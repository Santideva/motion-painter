#version 300 es
precision highp float;

// Vertex attributes
in vec2 aPos;

// Output to fragment shader
out vec2 vTexCoord;

void main() {
    // Convert from clip space [-1,1] to texture coordinates [0,1]
    vTexCoord = aPos * 0.5 + 0.5;
    
    gl_Position = vec4(aPos, 0.0, 1.0);
}