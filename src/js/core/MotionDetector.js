export class MotionDetector {
  constructor() {
    this.threshold = 0.08;
    this.sensitivity = 1.0;
    this.smoothing = 0.05;
  }
  
  setThreshold(threshold) {
    this.threshold = Math.max(0, Math.min(1, threshold));
  }
  
  setSensitivity(sensitivity) {
    this.sensitivity = Math.max(0, Math.min(2, sensitivity));
  }
  
  /**
   * Calculate motion parameters for the shader
   * @param {number} threshold - Motion detection threshold (0-1)
   * @returns {Object} Motion parameters for shader uniforms
   */
  getMotionParams(threshold = this.threshold) {
    return {
      threshold: threshold,
      smoothingRange: this.smoothing,
      sensitivity: this.sensitivity
    };
  }
  
  /**
   * Analyze motion between two frames (CPU-based analysis if needed)
   * This could be used for additional motion analytics
   * @param {ImageData} currentFrame 
   * @param {ImageData} previousFrame 
   * @returns {Object} Motion analysis results
   */
  analyzeMotion(currentFrame, previousFrame) {
    if (!currentFrame || !previousFrame) {
      return { motionLevel: 0, motionAreas: [] };
    }
    
    const width = currentFrame.width;
    const height = currentFrame.height;
    const currentData = currentFrame.data;
    const previousData = previousFrame.data;
    
    let totalMotion = 0;
    let motionPixels = 0;
    const motionAreas = [];
    
    // Grid-based motion analysis (downsample for performance)
    const gridSize = 16;
    const stepX = Math.floor(width / gridSize);
    const stepY = Math.floor(height / gridSize);
    
    for (let y = 0; y < height; y += stepY) {
      for (let x = 0; x < width; x += stepX) {
        const index = (y * width + x) * 4;
        
        // Calculate luminance for both frames
        const currLum = this.calculateLuminance(
          currentData[index],
          currentData[index + 1], 
          currentData[index + 2]
        );
        
        const prevLum = this.calculateLuminance(
          previousData[index],
          previousData[index + 1],
          previousData[index + 2]
        );
        
        const diff = Math.abs(currLum - prevLum);
        
        if (diff > this.threshold) {
          totalMotion += diff;
          motionPixels++;
          
          motionAreas.push({
            x: x / width,
            y: y / height,
            intensity: diff
          });
        }
      }
    }
    
    const avgMotion = motionPixels > 0 ? totalMotion / motionPixels : 0;
    
    return {
      motionLevel: avgMotion,
      motionPixels,
      motionAreas,
      coverage: motionPixels / (gridSize * gridSize)
    };
  }
  
  calculateLuminance(r, g, b) {
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }
  
  /**
   * Get adaptive threshold based on scene analysis
   * @param {Object} motionAnalysis - Result from analyzeMotion
   * @returns {number} Suggested threshold value
   */
  getAdaptiveThreshold(motionAnalysis) {
    const baseThreshold = this.threshold;
    
    // Increase threshold if too much motion detected (reduce noise)
    if (motionAnalysis.coverage > 0.5) {
      return Math.min(1.0, baseThreshold * 1.5);
    }
    
    // Decrease threshold if very little motion (increase sensitivity)
    if (motionAnalysis.coverage < 0.1) {
      return Math.max(0.01, baseThreshold * 0.7);
    }
    
    return baseThreshold;
  }
}