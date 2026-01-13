// gpuComputationRenderer.js
// Simplified GPU computation renderer for Web Workers
// Accept THREE as constructor parameter instead of importing

export class GPUComputationRenderer {
  constructor(sizeX, sizeY, renderer, THREE) {
    if (!THREE) {
      throw new Error('[GPUComputationRenderer] THREE.js module required as parameter');
    }
    
    this.THREE = THREE;
    this.sizeX = sizeX;
    this.sizeY = sizeY;
    this.renderer = renderer;
    this.variables = [];
    this.currentTextureIndex = 0;
    this.renderTargets = [];
  }

  createTexture() {
    const texture = new this.THREE.DataTexture(
      new Float32Array(this.sizeX * this.sizeY * 4),
      this.sizeX,
      this.sizeY,
      this.THREE.RGBAFormat,
      this.THREE.FloatType
    );
    texture.needsUpdate = true;
    return texture;
  }

  addVariable(name, fragmentShader, initialTexture) {
    const material = new this.THREE.ShaderMaterial({
      uniforms: {
        resolution: { value: new this.THREE.Vector2(this.sizeX, this.sizeY) },
        [name]: { value: initialTexture }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        precision highp float;
        uniform vec2 resolution;
        varying vec2 vUv;
        ${fragmentShader.trim()}
      `
    });

    const renderTarget1 = new this.THREE.WebGLRenderTarget(this.sizeX, this.sizeY, {
      wrapS: this.THREE.ClampToEdgeWrapping,
      wrapT: this.THREE.ClampToEdgeWrapping,
      minFilter: this.THREE.NearestFilter,
      magFilter: this.THREE.NearestFilter,
      format: this.THREE.RGBAFormat,
      type: this.THREE.FloatType
    });

    const renderTarget2 = renderTarget1.clone();

    const variable = {
      name,
      material,
      initialTexture,
      renderTargets: [renderTarget1, renderTarget2],
      currentTextureIndex: 0
    };

    this.variables.push(variable);
    return variable;
  }

  setVariableDependencies(variable, dependencies) {
    variable.dependencies = dependencies;
  }

  init() {
    try {
      const scene = new this.THREE.Scene();
      const camera = new this.THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const geometry = new this.THREE.PlaneGeometry(2, 2);

      for (const variable of this.variables) {
        variable.material.uniforms.resolution.value.set(this.sizeX, this.sizeY);
        
        const mesh = new this.THREE.Mesh(geometry, variable.material);
        scene.add(mesh);
        
        // Render initial state
        this.renderer.setRenderTarget(variable.renderTargets[0]);
        this.renderer.render(scene, camera);
        
        scene.remove(mesh);
      }
      
      this.renderer.setRenderTarget(null);
      return null; // No error
    } catch (error) {
      console.error('[GPUComputationRenderer] Init error:', error);
      return String(error);
    }
  }

  compute() {
    try {
      const scene = new this.THREE.Scene();
      const camera = new this.THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const geometry = new this.THREE.PlaneGeometry(2, 2);

      for (const variable of this.variables) {
        const mesh = new this.THREE.Mesh(geometry, variable.material);
        scene.add(mesh);
        
        const currentIndex = variable.currentTextureIndex;
        const nextIndex = 1 - currentIndex;
        
        this.renderer.setRenderTarget(variable.renderTargets[nextIndex]);
        this.renderer.render(scene, camera);
        
        variable.currentTextureIndex = nextIndex;
        scene.remove(mesh);
      }
      
      this.renderer.setRenderTarget(null);
    } catch (error) {
      console.error('[GPUComputationRenderer] Compute error:', error);
      throw error;
    }
  }

  getCurrentRenderTarget(variable) {
    return variable.renderTargets[variable.currentTextureIndex];
  }

  dispose() {
    try {
      for (const variable of this.variables) {
        for (const rt of variable.renderTargets) {
          if (rt && typeof rt.dispose === 'function') {
            rt.dispose();
          }
        }
        if (variable.material && typeof variable.material.dispose === 'function') {
          variable.material.dispose();
        }
      }
      this.variables = [];
    } catch (error) {
      console.error('[GPUComputationRenderer] Dispose error:', error);
    }
  }
}