export const CONFIG = {
  BUFFER_SIZE: 4, // Legacy default
  DEFAULT_BUFFER_SIZE: 8, // New default with more capacity
  MIN_BUFFER_SIZE: 4,
  MAX_BUFFER_SIZE: 16, // Hardware-imposed limit
  HARDWARE_MAX_TEXTURE_UNITS: 16, // WebGL fragment shader limit
  DEFAULT_RESOLUTION: { width: 640, height: 480 },
  MOTION_THRESHOLD: 0.08,
  DEFAULT_OPACITY: 0.6,
  GLOW_INTENSITY: 0.9,
  
  // Spiral buffer configuration optimized for 16 frame limit
  SPIRAL_RETENTION: {
    // Linear spacing for recent frames (1-4 frames back)
    LINEAR_SLOTS: 4,
    // Exponential base for older frames - adjusted for smaller buffer
    EXPONENTIAL_BASE: 1.4, // Reduced from 1.5 for better distribution
    // Minimum gap between exponential slots
    MIN_EXPONENTIAL_GAP: 2
  }
};

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

export function getOptimalCanvasSize(video, maxWidth = 1920, maxHeight = 1080) {
  const videoWidth = video.videoWidth || CONFIG.DEFAULT_RESOLUTION.width;
  const videoHeight = video.videoHeight || CONFIG.DEFAULT_RESOLUTION.height;

  const aspectRatio = videoWidth / videoHeight;
  let width = videoWidth;
  let height = videoHeight;

  // Scale down if too large
  if (width > maxWidth) {
    width = maxWidth;
    height = width / aspectRatio;
  }

  if (height > maxHeight) {
    height = maxHeight;
    width = height * aspectRatio;
  }

  // Ensure even dimensions for better GPU performance
  width = Math.floor(width / 2) * 2;
  height = Math.floor(height / 2) * 2;

  return { width, height };
}

/**
 * Generate spiral buffer indices for logarithmic frame retention
 * Optimized for 16 frame limit with better temporal distribution
 * 
 * This creates a retention pattern where:
 * - Recent frames (0-4) are kept with linear spacing (every frame)
 * - Older frames are kept with exponentially increasing gaps
 * - Pattern ensures optimal use of all 16 slots
 * 
 * @param {number} bufferSize - Total number of texture slots (max 16)
 * @returns {number[]} Array of frame lookback distances
 */
/**
 * FIXED: Generate spiral buffer indices that respect buffer size limits
 */
export function getSpiralBufferIndices(bufferSize) {
  const clampedSize = Math.min(bufferSize, CONFIG.MAX_BUFFER_SIZE);
  const indices = [0]; // Always include current frame
  const config = CONFIG.SPIRAL_RETENTION;
  
  if (clampedSize <= 1) return indices;
  
  // Linear portion: recent frames with unit spacing
  const linearSlots = Math.min(config.LINEAR_SLOTS, clampedSize - 1);
  for (let i = 1; i <= linearSlots; i++) {
    indices.push(i);
  }
  
  // Exponential portion: older frames with increasing gaps
  // CRITICAL FIX: Ensure we never exceed buffer bounds
  if (clampedSize > linearSlots + 1) {
    const remainingSlots = clampedSize - linearSlots - 1;
    let currentOffset = linearSlots;
    let currentGap = config.MIN_EXPONENTIAL_GAP;
    
    for (let i = 0; i < remainingSlots; i++) {
      currentOffset = Math.min(currentOffset + Math.max(currentGap, 1), clampedSize - 1);
      
      // Avoid duplicates and ensure we don't exceed buffer size
      if (currentOffset < clampedSize && !indices.includes(currentOffset)) {
        indices.push(currentOffset);
      }
      
      // If we've reached the buffer limit, fill remaining slots with evenly spaced indices
      if (currentOffset >= clampedSize - 1) {
        const remaining = remainingSlots - i - 1;
        if (remaining > 0) {
          // Fill remaining slots with evenly distributed indices
          const step = Math.max(1, Math.floor((clampedSize - linearSlots - 1) / remaining));
          let fillOffset = linearSlots + step;
          
          for (let j = 0; j < remaining && fillOffset < clampedSize; j++) {
            if (!indices.includes(fillOffset)) {
              indices.push(fillOffset);
            }
            fillOffset += step;
          }
        }
        break;
      }
      
      currentGap = Math.ceil(currentGap * config.EXPONENTIAL_BASE);
    }
  }
  
  // Ensure all indices are within bounds and sorted
  return indices
    .filter(index => index < clampedSize)
    .sort((a, b) => a - b)
    .slice(0, clampedSize); // Ensure we don't exceed buffer size
}

/**
 * Get recommended buffer sizes for different use cases (16 frame limit)
 */
export function getBufferSizeRecommendations() {
  return {
    minimal: { size: 4, description: "Basic temporal effects" },
    standard: { size: 8, description: "Good balance of memory and quality" },
    enhanced: { size: 12, description: "Rich temporal effects" },
    maximum: { size: 16, description: "Maximum hardware-supported depth" }
  };
}

/**
 * Calculate memory usage for a given buffer configuration
 * @param {number} bufferSize - Number of buffer slots (max 16)
 * @param {number} width - Frame width
 * @param {number} height - Frame height
 * @returns {Object} Memory usage information
 */
export function calculateBufferMemoryUsage(bufferSize, width = 1920, height = 1080) {
  const clampedSize = Math.min(bufferSize, CONFIG.MAX_BUFFER_SIZE);
  const bytesPerPixel = 4; // RGBA
  const bytesPerFrame = width * height * bytesPerPixel;
  const totalBytes = bytesPerFrame * clampedSize;
  
  return {
    bytesPerFrame,
    totalBytes,
    totalMB: Math.round(totalBytes / (1024 * 1024) * 100) / 100,
    actualBufferSize: clampedSize,
    hardwareLimited: bufferSize > CONFIG.MAX_BUFFER_SIZE,
    recommendation: totalBytes > 50 * 1024 * 1024 ? 'high' : 
                   totalBytes > 25 * 1024 * 1024 ? 'medium' : 'low'
  };
}

/**
 * Generate optimal buffer size based on available memory and performance target
 * Now respects 16 frame hardware limit
 * @param {number} availableMemoryMB - Available memory in MB
 * @param {number} width - Frame width
 * @param {number} height - Frame height
 * @param {string} performanceTarget - 'low', 'medium', 'high'
 * @returns {number} Recommended buffer size
 */
export function getOptimalBufferSize(availableMemoryMB = 100, width = 1920, height = 1080, performanceTarget = 'medium') {
  const targetMemoryUsage = {
    low: availableMemoryMB * 0.3,
    medium: availableMemoryMB * 0.5,
    high: availableMemoryMB * 0.7
  };
  
  const targetMB = targetMemoryUsage[performanceTarget] || targetMemoryUsage.medium;
  const bytesPerFrame = width * height * 4;
  const maxFrames = Math.floor((targetMB * 1024 * 1024) / bytesPerFrame);
  
  // Respect both memory and hardware constraints
  return Math.max(
    CONFIG.MIN_BUFFER_SIZE, 
    Math.min(CONFIG.MAX_BUFFER_SIZE, maxFrames)
  );
}

/**
 * Validate buffer configuration against hardware limits
 * @param {number} bufferSize - Proposed buffer size
 * @param {number} hardwareMaxTextureUnits - (optional) runtime hardware max texture units
 * @returns {Object} Validation result
 */
export function validateBufferSize(bufferSize, hardwareMaxTextureUnits = CONFIG.HARDWARE_MAX_TEXTURE_UNITS) {
  const size = Math.round(bufferSize);
  const isValid = size >= CONFIG.MIN_BUFFER_SIZE && size <= CONFIG.MAX_BUFFER_SIZE;
  const clamped = Math.max(CONFIG.MIN_BUFFER_SIZE, Math.min(CONFIG.MAX_BUFFER_SIZE, size));
  const isHardwareLimited = size > hardwareMaxTextureUnits;
  
  let warning = null;
  if (size < CONFIG.MIN_BUFFER_SIZE) {
    warning = `Buffer size must be at least ${CONFIG.MIN_BUFFER_SIZE}`;
  } else if (isHardwareLimited) {
    warning = `Buffer size limited to ${Math.min(CONFIG.MAX_BUFFER_SIZE, hardwareMaxTextureUnits)} by WebGL texture unit constraints`;
  } else if (!isValid) {
    warning = `Buffer size must be between ${CONFIG.MIN_BUFFER_SIZE} and ${CONFIG.MAX_BUFFER_SIZE}`;
  }
  
  return {
    isValid,
    originalSize: bufferSize,
    clampedSize: clamped,
    isHardwareLimited,
    warning
  };
}

/**
 * Get hardware-optimized spiral indices for specific buffer sizes
 * Pre-computed patterns for common sizes to improve performance
 * @param {number} bufferSize - Buffer size (1-16)
 * @returns {number[]} Optimized spiral indices
 */
export function getOptimizedSpiralIndices(bufferSize) {
  // Safer: prefer dynamically generated indices that are guaranteed in-bounds
  return getSpiralBufferIndices(bufferSize);
}

/**
 * Calculate effective temporal coverage for a given buffer configuration
 * @param {number} bufferSize - Buffer size
 * @param {number} frameRate - Video frame rate (fps)
 * @returns {Object} Temporal coverage information
 */
export function calculateTemporalCoverage(bufferSize, frameRate = 30) {
  const clampedSize = Math.min(bufferSize, CONFIG.MAX_BUFFER_SIZE);
  const spiralIndices = getOptimizedSpiralIndices(clampedSize);
  
  const maxFrameBack = Math.max(...spiralIndices);
  const maxTimeBack = maxFrameBack / frameRate; // seconds
  
  const recentFrames = spiralIndices.filter(i => i <= 4).length;
  const mediumFrames = spiralIndices.filter(i => i > 4 && i <= 16).length;
  const distantFrames = spiralIndices.filter(i => i > 16).length;
  
  return {
    bufferSize: clampedSize,
    maxFrameBack,
    maxTimeBack,
    temporalDistribution: {
      recent: recentFrames,    // 0-133ms at 30fps
      medium: mediumFrames,    // 133ms-533ms at 30fps  
      distant: distantFrames   // 533ms+ at 30fps
    },
    effectiveResolution: {
      recent: '33ms',     // Every frame for recent
      medium: '100-200ms', // Exponential spacing
      distant: '500ms+'   // Wide spacing for distant
    }
  };
}
