/**
 * MultiSampler.js - Core sampling module for MotionnPainter (Complete Refactored Version)
 * 
 * Provides tri-sampling strategy: Wallis Sieve + Random + Vogel/Phyllotaxis
 * Supports temporal frequencies, input-agnostic design, and plugin architecture
 * 
 * FIXES IMPLEMENTED:
 * - Deterministic sampling with seeded RNG
 * - Fixed temporal input handling (no nested arrays)
 * - Performance optimizations (quickselect, variance stride, time budgets)
 * - Memory-conscious operations for worker usage
 * - Normalized coordinates with tolerance-based deduplication
 * - Cancellation support
 * - Consistent config naming and synchronization
 * - Complete blob normalization implementation
 * 
 * Usage:
 *   const sampler = new MultiSampler({ seed: 12345, plugins: [...] });
 *   const result = await sampler.sample(input, options);
 */

export class MultiSampler {
    constructor(options = {}) {
        this.plugins = new Map();
        this.config = {
            // Tri-sampling blend weights (should sum to 1.0)
            wallis: options.wallis || 0.4,
            random: options.random || 0.3,
            vogel: options.vogel || 0.3,
            
            // Deterministic sampling
            seed: options.seed || Date.now(),
            
            // Performance & resource management
            timeBudgetMs: options.timeBudgetMs || 100,    // Max processing time per call
            maxSamplePoints: options.maxSamplePoints || 1024,
            minSamplePoints: options.minSamplePoints || 64,
            adaptiveDensity: options.adaptiveDensity !== false,
            
            // Coordinate system
            normalizedCoords: options.normalizedCoords !== false,    // Return coords in [0,1] range
            dedupeToleranceNorm: options.dedupeToleranceNorm || 0.01, // Tolerance for normalized coord dedupe
            
            // Variance computation optimization
            varianceStride: options.varianceStride || 2,          // Skip pixels for performance
            varianceWindow: options.varianceWindow || 3,          // Keep small for speed
            percentileMethod: options.percentileMethod || 'quickselect', // vs 'sort'
            
            // Temporal support
            temporalModes: ['single', 'sequence', 'sliding_window'],
            defaultTemporalMode: options.defaultTemporalMode || 'single',
            maxTemporalWindow: options.maxTemporalWindow || 32,
            
            // Adaptive blending
            enableAdaptiveBlending: options.enableAdaptiveBlending !== false,
            blendingWindow: options.blendingWindow || 16,
            
            // Debug/telemetry
            enableMetrics: options.enableMetrics !== false,
            enableDebugOutput: options.enableDebugOutput === true,
            
            ...options
        };
        
        // Initialize seeded RNG
        this.rng = this._createSeededRNG(this.config.seed);
        
        this.metrics = {
            totalSamples: 0,
            avgSampleTime: 0,
            pluginCallCounts: new Map(),
            blendingHistory: [],
            lastError: null,
            timeouts: 0,
            cancelled: 0,
            memoryPressure: 0
        };
        
        // Blending state (sync with config naming)
        this.blendingState = {
            history: [],
            currentWeights: {
                wallis: this.config.wallis,
                random: this.config.random,
                vogel: this.config.vogel
            }
        };
        
        this._initializeSamplers();
        this._loadPlugins(options.plugins || []);
    }
    
    /**
     * Main sampling entry point with cancellation support
     * @param {ImageBitmap|OffscreenCanvas|Blob|Array} input - Input to sample
     * @param {Object} options - Runtime configuration
     * @returns {Promise<Object>} Sampling result with manifests
     */
    async sample(input, options = {}) {
        const startTime = performance.now();
        const config = { ...this.config, ...options };
        const cancelToken = options.cancelToken || { cancelled: false };
        
        try {
            if (cancelToken.cancelled) return this._createCancelledResult();
            
            const inputType = this._detectInputType(input);
            const normalizedInput = await this._normalizeInput(input, inputType);
            
            if (cancelToken.cancelled) return this._createCancelledResult();
            
            // Handle temporal modes - FIXED: proper single input handling
            const samplingInputs = this._prepareTemporalInputs(normalizedInput, config);
            
            let results = [];
            
            // Process each temporal input with time budget
            for (const temporalInput of samplingInputs) {
                if (cancelToken.cancelled) break;
                
                const elapsed = performance.now() - startTime;
                if (elapsed > config.timeBudgetMs) {
                    this.metrics.timeouts++;
                    if (this.config.enableDebugOutput) {
                        console.warn('MultiSampler: Time budget exceeded, stopping processing');
                    }
                    break;
                }
                
                const remainingTime = config.timeBudgetMs - elapsed;
                const result = await this._sampleSingle(temporalInput, config, cancelToken, remainingTime);
                if (result && !result.cancelled) {
                    results.push(result);
                }
            }
            
            // Merge temporal results if needed
            const finalResult = this._mergeTemporalResults(results, config);
            
            // Update metrics
            this._updateMetrics(startTime, finalResult);
            
            return finalResult;
            
        } catch (error) {
            this.metrics.lastError = error;
            if (this.config.enableDebugOutput) {
                console.error('MultiSampler.sample error:', error);
            }
            throw error;
        }
    }
    
    /**
     * Core single-input sampling - FIXED: expects single normalized input
     * @param {Object} normalizedInput - Single normalized input {width, height, data, type}
     * @param {Object} config - Configuration
     * @param {Object} cancelToken - Cancellation token
     * @param {number} remainingTimeMs - Remaining time budget
     * @returns {Promise<Object>} Sample result
     */
    async _sampleSingle(normalizedInput, config, cancelToken, remainingTimeMs) {
        // Ensure we have a single normalized input, not an array
        if (Array.isArray(normalizedInput)) {
            throw new Error('_sampleSingle expects single input, got array');
        }
        
        const { width, height, data } = normalizedInput;
        const startTime = performance.now();
        
        if (cancelToken?.cancelled) return this._createCancelledResult();
        
        const targetPoints = this._calculateSampleDensity(width, height, config);
        
        // Distribute points across sampling methods
        const wallisCount = Math.floor(targetPoints * this.blendingState.currentWeights.wallis);
        const randomCount = Math.floor(targetPoints * this.blendingState.currentWeights.random);
        const vogelCount = targetPoints - wallisCount - randomCount; // Ensure exact total
        
        if (this.config.enableDebugOutput) {
            console.log(`MultiSampler: Distributing ${targetPoints} points - Wallis:${wallisCount}, Random:${randomCount}, Vogel:${vogelCount}`);
        }
        
        // Generate sample points with time budget awareness
        const timePerMethod = remainingTimeMs / 3;
        
        const wallisPoints = await this._wallisBasedSampling(normalizedInput, wallisCount, 
            timePerMethod, cancelToken);
        
        if (cancelToken?.cancelled) return this._createCancelledResult();
        
        const randomPoints = this._randomSampling(normalizedInput, randomCount);
        const vogelPoints = this._vogelPhyllotaxisSampling(normalizedInput, vogelCount);
        
        // Merge and deduplicate - FIXED: tolerance-based deduplication
        const allSamplePoints = this._mergeSamplePoints(wallisPoints, randomPoints, vogelPoints, config);
        
        if (cancelToken?.cancelled) return this._createCancelledResult();
        
        // Run plugins on sample points
        const pluginResults = await this._runPlugins(normalizedInput, allSamplePoints, config, cancelToken);
        
        // Create sampling manifest
        const manifest = {
            timestamp: Date.now(),
            inputDimensions: { width, height },
            samplePoints: allSamplePoints,
            samplingStrategy: {
                weights: { ...this.blendingState.currentWeights },
                totalPoints: allSamplePoints.length,
                distribution: {
                    wallis: wallisPoints.length,
                    random: randomPoints.length,
                    vogel: vogelPoints.length
                },
                seed: this.config.seed,
                targetPoints: targetPoints
            },
            pluginResults,
            metadata: {
                inputType: normalizedInput.type,
                temporalMode: config.temporalMode || 'single',
                processingTime: performance.now() - startTime,
                coordinateSystem: config.normalizedCoords ? 'normalized' : 'pixel',
                budgetUtilization: (performance.now() - startTime) / remainingTimeMs
            }
        };
        
        // Update adaptive blending if enabled
        if (config.enableAdaptiveBlending) {
            this._updateAdaptiveBlending(manifest);
        }
        
        return manifest;
    }
    
    /**
     * FIXED: Optimized Wallis-inspired sampling with time budget
     * @param {Object} input - Normalized input
     * @param {number} targetPoints - Target number of points
     * @param {number} timeBudgetMs - Time budget in milliseconds
     * @param {Object} cancelToken - Cancellation token
     * @returns {Promise<Array>} Sample points
     */
    async _wallisBasedSampling(input, targetPoints, timeBudgetMs, cancelToken) {
        const { width, height, data } = input;
        const points = [];
        const startTime = performance.now();
        
        if (targetPoints === 0) return points;
        
        try {
            // FIXED: Optimized variance computation with stride
            const varianceMap = this._computeVarianceMapOptimized(data, width, height);
            
            if (cancelToken?.cancelled || (performance.now() - startTime) > timeBudgetMs) {
                return this._fallbackRandomSampling(input, targetPoints);
            }
            
            // FIXED: Quick percentile calculation
            const threshold = this._quickPercentile(varianceMap, 0.85);
            
            // Sample based on variance exceeding threshold
            const stride = Math.max(1, Math.floor(Math.sqrt(width * height / targetPoints)));
            
            for (let y = 0; y < height && points.length < targetPoints; y += stride) {
                for (let x = 0; x < width && points.length < targetPoints; x += stride) {
                    if (cancelToken?.cancelled) break;
                    
                    const idx = y * width + x;
                    if (idx < varianceMap.length && varianceMap[idx] > threshold) {
                        points.push(this._createSamplePoint(x, y, width, height, 
                            varianceMap[idx], 'wallis'));
                    }
                    
                    // Time budget check every 100 points
                    if (points.length % 100 === 0 && (performance.now() - startTime) > timeBudgetMs) {
                        break;
                    }
                }
                if (cancelToken?.cancelled || (performance.now() - startTime) > timeBudgetMs) break;
            }
            
            // Fill remaining with highest variance if under target and time allows
            if (points.length < targetPoints && !cancelToken?.cancelled && 
                (performance.now() - startTime) < timeBudgetMs * 0.8) {
                
                const additional = this._selectTopVariancePoints(varianceMap, width, height, 
                    targetPoints - points.length, points);
                points.push(...additional);
            }
            
        } catch (error) {
            if (this.config.enableDebugOutput) {
                console.warn('Wallis sampling failed, falling back to random:', error);
            }
            return this._fallbackRandomSampling(input, targetPoints);
        }
        
        return points.slice(0, targetPoints);
    }
    
    /**
     * FIXED: Deterministic random sampling using seeded RNG
     * @param {Object} input - Normalized input
     * @param {number} targetPoints - Target number of points
     * @returns {Array} Sample points
     */
    _randomSampling(input, targetPoints) {
        const { width, height } = input;
        const points = [];
        
        for (let i = 0; i < targetPoints; i++) {
            const x = Math.floor(this.rng() * width);
            const y = Math.floor(this.rng() * height);
            points.push(this._createSamplePoint(x, y, width, height, 1.0, 'random'));
        }
        
        return points;
    }
    
    /**
     * Deterministic Vogel/Phyllotaxis spiral sampling
     * @param {Object} input - Normalized input
     * @param {number} targetPoints - Target number of points
     * @returns {Array} Sample points
     */
    _vogelPhyllotaxisSampling(input, targetPoints) {
        const { width, height } = input;
        const points = [];
        
        if (targetPoints === 0) return points;
        
        const goldenAngle = Math.PI * (3 - Math.sqrt(5)); // Golden angle in radians
        const centerX = width / 2;
        const centerY = height / 2;
        const maxRadius = Math.min(width, height) / 2;
        
        for (let i = 0; i < targetPoints; i++) {
            const theta = i * goldenAngle;
            const r = Math.sqrt(i / targetPoints) * maxRadius;
            
            const x = Math.floor(centerX + r * Math.cos(theta));
            const y = Math.floor(centerY + r * Math.sin(theta));
            
            // Ensure bounds
            if (x >= 0 && x < width && y >= 0 && y < height) {
                const weight = 1.0 - (i / targetPoints); // Higher weight for inner points
                points.push(this._createSamplePoint(x, y, width, height, weight, 'vogel', { 
                    spiralIndex: i,
                    radius: r,
                    angle: theta
                }));
            }
        }
        
        return points;
    }
    
    /**
     * FIXED: Tolerance-based deduplication for normalized coordinates
     * @param {Array} wallisPoints - Wallis sample points
     * @param {Array} randomPoints - Random sample points
     * @param {Array} vogelPoints - Vogel sample points
     * @param {Object} config - Configuration
     * @returns {Array} Merged and deduplicated points
     */
    _mergeSamplePoints(wallisPoints, randomPoints, vogelPoints, config) {
        const allPoints = [...wallisPoints, ...randomPoints, ...vogelPoints];
        
        if (allPoints.length === 0) return [];
        
        if (!config.normalizedCoords) {
            // Simple pixel-coordinate deduplication
            const pointMap = new Map();
            allPoints.forEach(point => {
                const key = `${point.x},${point.y}`;
                if (!pointMap.has(key) || pointMap.get(key).weight < point.weight) {
                    pointMap.set(key, point);
                }
            });
            return Array.from(pointMap.values());
        }
        
        // Tolerance-based deduplication for normalized coordinates
        const deduplicated = [];
        const tolerance = config.dedupeToleranceNorm;
        
        for (const point of allPoints) {
            let isDuplicate = false;
            for (let i = 0; i < deduplicated.length; i++) {
                const existing = deduplicated[i];
                const dx = Math.abs(point.xNorm - existing.xNorm);
                const dy = Math.abs(point.yNorm - existing.yNorm);
                if (dx < tolerance && dy < tolerance) {
                    // Keep higher weight point
                    if (point.weight > existing.weight) {
                        deduplicated[i] = point;
                    }
                    isDuplicate = true;
                    break;
                }
            }
            if (!isDuplicate) {
                deduplicated.push(point);
            }
        }
        
        return deduplicated;
    }
    
    /**
     * FIXED: Optimized variance computation with configurable stride
     * @param {Uint8ClampedArray} data - RGBA pixel data
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @returns {Float32Array} Variance map
     */
    _computeVarianceMapOptimized(data, width, height) {
        const stride = this.config.varianceStride;
        const windowSize = this.config.varianceWindow;
        const half = Math.floor(windowSize / 2);
        const variance = new Float32Array(width * height);
        
        // Pre-compute grayscale values for efficiency
        const grayscale = new Uint8Array(width * height);
        for (let i = 0; i < width * height; i++) {
            const pixelIdx = i * 4;
            grayscale[i] = Math.floor(
                data[pixelIdx] * 0.299 + 
                data[pixelIdx + 1] * 0.587 + 
                data[pixelIdx + 2] * 0.114
            );
        }
        
        for (let y = half; y < height - half; y += stride) {
            for (let x = half; x < width - half; x += stride) {
                let sum = 0;
                let sumSq = 0;
                let count = 0;
                
                // Extract window values
                for (let dy = -half; dy <= half; dy++) {
                    for (let dx = -half; dx <= half; dx++) {
                        const grayIdx = (y + dy) * width + (x + dx);
                        if (grayIdx >= 0 && grayIdx < grayscale.length) {
                            const gray = grayscale[grayIdx];
                            sum += gray;
                            sumSq += gray * gray;
                            count++;
                        }
                    }
                }
                
                // Compute variance efficiently
                if (count > 0) {
                    const mean = sum / count;
                    const variance_val = (sumSq / count) - (mean * mean);
                    
                    const baseIdx = y * width + x;
                    // Fill stride area with same variance (approximate)
                    for (let sy = 0; sy < stride && (y + sy) < height; sy++) {
                        for (let sx = 0; sx < stride && (x + sx) < width; sx++) {
                            const idx = baseIdx + sy * width + sx;
                            if (idx < variance.length) {
                                variance[idx] = variance_val;
                            }
                        }
                    }
                }
            }
        }
        
        return variance;
    }
    
    /**
     * FIXED: Quick percentile using quickselect algorithm
     * @param {Float32Array} arr - Array to find percentile in
     * @param {number} percentile - Percentile (0-1)
     * @returns {number} Percentile value
     */
    _quickPercentile(arr, percentile) {
        if (arr.length === 0) return 0;
        
        if (this.config.percentileMethod === 'sort') {
            const sorted = Array.from(arr).sort((a, b) => a - b);
            return sorted[Math.floor(sorted.length * percentile)];
        }
        
        // Quickselect for O(n) average case
        const k = Math.floor(arr.length * percentile);
        return this._quickselect(Array.from(arr), k);
    }
    
    /**
     * Quickselect algorithm for efficient percentile calculation
     * @param {Array} arr - Array to select from
     * @param {number} k - Index to select
     * @returns {number} k-th smallest element
     */
    _quickselect(arr, k) {
        if (arr.length <= 1) return arr[0] || 0;
        
        const pivot = arr[Math.floor(arr.length / 2)];
        const left = arr.filter(x => x < pivot);
        const middle = arr.filter(x => x === pivot);
        const right = arr.filter(x => x > pivot);
        
        if (k < left.length) {
            return this._quickselect(left, k);
        } else if (k < left.length + middle.length) {
            return pivot;
        } else {
            return this._quickselect(right, k - left.length - middle.length);
        }
    }
    
    /**
     * Create properly formatted sample point with both coordinate systems
     * @param {number} x - Pixel x coordinate
     * @param {number} y - Pixel y coordinate
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {number} weight - Sample weight
     * @param {string} source - Sample source ('wallis', 'random', 'vogel')
     * @param {Object} extra - Additional properties
     * @returns {Object} Sample point
     */
    _createSamplePoint(x, y, width, height, weight, source, extra = {}) {
        const point = {
            x: Math.max(0, Math.min(width - 1, x)),     // Clamp to bounds
            y: Math.max(0, Math.min(height - 1, y)),    // Clamp to bounds
            xNorm: x / width,                           // Normalized coordinates
            yNorm: y / height,                          // Normalized coordinates
            weight: Math.max(0, weight),                // Ensure non-negative weight
            source,
            ...extra
        };
        
        return point;
    }
    
    /**
     * Fallback sampling for time budget overruns
     * @param {Object} input - Normalized input
     * @param {number} targetPoints - Target number of points
     * @returns {Array} Sample points
     */
    _fallbackRandomSampling(input, targetPoints) {
        const fallbackCount = Math.min(targetPoints, this.config.minSamplePoints);
        if (this.config.enableDebugOutput) {
            console.warn(`MultiSampler: Falling back to ${fallbackCount} random samples`);
        }
        return this._randomSampling(input, fallbackCount);
    }
    
    /**
     * Select top variance points efficiently
     * @param {Float32Array} varianceMap - Variance map
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {number} count - Number of points to select
     * @param {Array} existingPoints - Already selected points
     * @returns {Array} Additional sample points
     */
    _selectTopVariancePoints(varianceMap, width, height, count, existingPoints) {
        const existingSet = new Set(existingPoints.map(p => `${p.x},${p.y}`));
        const candidates = [];
        
        // Sample candidates efficiently (don't check every pixel)
        const sampleStride = Math.max(1, Math.floor(Math.sqrt(width * height / (count * 4))));
        
        for (let i = 0; i < varianceMap.length; i += sampleStride) {
            const x = i % width;
            const y = Math.floor(i / width);
            const key = `${x},${y}`;
            
            if (!existingSet.has(key) && varianceMap[i] > 0) {
                candidates.push({ x, y, variance: varianceMap[i] });
            }
            
            if (candidates.length >= count * 3) break; // Enough candidates
        }
        
        // Select top variance candidates
        candidates.sort((a, b) => b.variance - a.variance);
        
        return candidates.slice(0, count).map(c => 
            this._createSamplePoint(c.x, c.y, width, height, c.variance, 'wallis'));
    }
    
    /**
     * FIXED: Handle temporal input preparation properly
     * @param {Object|Array} input - Input(s) to prepare
     * @param {Object} config - Configuration
     * @returns {Array} Array of single normalized inputs
     */
    _prepareTemporalInputs(input, config) {
        const temporalMode = config.temporalMode || this.config.defaultTemporalMode;
        
        switch (temporalMode) {
            case 'single':
                // Ensure input is not an array for single mode
                if (Array.isArray(input)) {
                    return input; // Each item will be processed individually
                }
                return [input]; // Wrap single input in array for uniform processing
                
            case 'sequence':
                if (!Array.isArray(input)) {
                    throw new Error('Sequence mode requires array input');
                }
                return input; // Each frame processed separately
                
            case 'sliding_window':
                if (!Array.isArray(input)) {
                    throw new Error('Sliding window mode requires array input');
                }
                const windowSize = config.windowSize || 3;
                const windows = [];
                
                // For now, just use the first frame of each window
                // TODO: Implement proper window merging/averaging
                for (let i = 0; i <= input.length - windowSize; i++) {
                    windows.push(input[i]); // Use first frame of window
                }
                return windows;
                
            default:
                throw new Error(`Unknown temporal mode: ${temporalMode}`);
        }
    }
    
    /**
     * FIXED: Implement blob normalization
     * @param {Blob} blob - Blob to normalize
     * @returns {Promise<Object>} Normalized input
     */
    async _normalizeBlob(blob) {
        try {
            const bitmap = await createImageBitmap(blob);
            const result = await this._normalizeBitmap(bitmap);
            bitmap.close(); // Clean up
            return result;
        } catch (error) {
            throw new Error(`Failed to normalize blob: ${error.message}`);
        }
    }
    
    /**
     * FIXED: Seeded RNG for deterministic sampling
     * @param {number} seed - Random seed
     * @returns {Function} Seeded random number generator
     */
    _createSeededRNG(seed) {
        let state = seed % 2147483647; // Ensure positive 32-bit integer
        if (state <= 0) state += 2147483646;
        
        return function() {
            state = (state * 16807) % 2147483647;
            return (state - 1) / 2147483646;
        };
    }
    
    /**
     * Create cancelled result object
     * @returns {Object} Cancelled result
     */
    _createCancelledResult() {
        this.metrics.cancelled++;
        return {
            cancelled: true,
            timestamp: Date.now(),
            samplePoints: [],
            samplingStrategy: {
                weights: { ...this.blendingState.currentWeights },
                totalPoints: 0,
                distribution: { wallis: 0, random: 0, vogel: 0 }
            },
            pluginResults: {},
            metadata: { 
                processingTime: 0,
                coordinateSystem: 'none'
            }
        };
    }
    
    /**
     * FIXED: Update config synchronizes blending state
     * @param {Object} newConfig - New configuration options
     */
    updateConfig(newConfig) {
        const oldSeed = this.config.seed;
        this.config = { ...this.config, ...newConfig };
        
        // Sync blending weights if they changed
        if (newConfig.wallis !== undefined || newConfig.random !== undefined || newConfig.vogel !== undefined) {
            this.blendingState.currentWeights = {
                wallis: this.config.wallis,
                random: this.config.random,
                vogel: this.config.vogel
            };
        }
        
        // Recreate RNG if seed changed
        if (newConfig.seed !== undefined && newConfig.seed !== oldSeed) {
            this.rng = this._createSeededRNG(this.config.seed);
            if (this.config.enableDebugOutput) {
                console.log(`MultiSampler: Seed changed from ${oldSeed} to ${this.config.seed}`);
            }
        }
    }
    
    /**
     * Execute registered plugins on sample points
     * @param {Object} input - Normalized input
     * @param {Array} samplePoints - Sample points
     * @param {Object} config - Configuration
     * @param {Object} cancelToken - Cancellation token
     * @returns {Promise<Object>} Plugin results
     */
    async _runPlugins(input, samplePoints, config, cancelToken) {
        const results = {};
        
        for (const [pluginName, plugin] of this.plugins) {
            if (cancelToken?.cancelled) break;
            
            if (config.enabledPlugins && !config.enabledPlugins.includes(pluginName)) {
                continue;
            }
            
            try {
                const pluginStartTime = performance.now();
                
                // Pass cancel token to plugin if it supports it
                const pluginConfig = { ...config, cancelToken };
                const result = await plugin.run(input, samplePoints, pluginConfig);
                
                results[pluginName] = {
                    data: result,
                    processingTime: performance.now() - pluginStartTime,
                    version: plugin.version || '1.0.0'
                };
                
                const currentCount = this.metrics.pluginCallCounts.get(pluginName) || 0;
                this.metrics.pluginCallCounts.set(pluginName, currentCount + 1);
                
            } catch (error) {
                results[pluginName] = {
                    error: error.message,
                    processingTime: 0
                };
                
                if (this.config.enableDebugOutput) {
                    console.warn(`Plugin ${pluginName} failed:`, error);
                }
            }
        }
        
        return results;
    }
    
    /**
     * Detect input type
     * @param {*} input - Input to detect
     * @returns {string} Input type
     */
    _detectInputType(input) {
        if (input instanceof ImageBitmap) return 'ImageBitmap';
        if (input instanceof OffscreenCanvas) return 'OffscreenCanvas';
        if (input instanceof Blob) return 'Blob';
        if (input instanceof Uint8Array) return 'Uint8Array';
        if (Array.isArray(input)) return 'Array';
        if (input && typeof input === 'object' && input.width && input.height && input.data) {
            return 'Normalized';
        }
        throw new Error('Unsupported input type');
    }
    
    /**
     * Normalize input to standard format
     * @param {*} input - Input to normalize
     * @param {string} inputType - Input type
     * @returns {Promise<Object|Array>} Normalized input(s)
     */
    async _normalizeInput(input, inputType) {
        switch (inputType) {
            case 'ImageBitmap':
                return this._normalizeBitmap(input);
                
            case 'OffscreenCanvas':
                return this._normalizeCanvas(input);
                
            case 'Blob':
                return this._normalizeBlob(input);
                
            case 'Uint8Array':
                throw new Error('Uint8Array input requires width/height specification');
                
            case 'Array':
                const normalized = [];
                for (const item of input) {
                    const itemType = this._detectInputType(item);
                    normalized.push(await this._normalizeInput(item, itemType));
                }
                return normalized;
                
            case 'Normalized':
                return { ...input, type: inputType };
                
            default:
                throw new Error(`Cannot normalize input type: ${inputType}`);
        }
    }
    
    /**
     * Normalize ImageBitmap to standard format
     * @param {ImageBitmap} bitmap - ImageBitmap to normalize
     * @returns {Promise<Object>} Normalized input
     */
    async _normalizeBitmap(bitmap) {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        
        const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
        return {
            width: bitmap.width,
            height: bitmap.height,
            data: imageData.data,
            type: 'ImageBitmap'
        };
    }
    
    /**
     * Normalize OffscreenCanvas to standard format
     * @param {OffscreenCanvas} canvas - OffscreenCanvas to normalize
     * @returns {Promise<Object>} Normalized input
     */
    async _normalizeCanvas(canvas) {
        const ctx = canvas.getContext('2d');
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return {
            width: canvas.width,
            height: canvas.height,
            data: imageData.data,
            type: 'OffscreenCanvas'
        };
    }
    
    /**
     * Calculate optimal sample density based on image size
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {Object} config - Configuration
     * @returns {number} Target number of sample points
     */
    _calculateSampleDensity(width, height, config) {
        const totalPixels = width * height;
        const baseDensity = Math.sqrt(totalPixels) * 0.1; // Base 10% of sqrt
        
        let targetPoints = Math.floor(baseDensity);
        
        if (config.adaptiveDensity) {
            // Adjust based on image size
            if (totalPixels > 1000000) targetPoints *= 1.5; // Large images get more samples
            if (totalPixels < 100000) targetPoints *= 0.7;   // Small images get fewer samples
        }
        
        // Clamp to configured bounds
        return Math.max(this.config.minSamplePoints, 
               Math.min(this.config.maxSamplePoints, targetPoints));
    }
    
    /**
     * Update adaptive blending weights based on sampling effectiveness
     * @param {Object} manifest - Sample manifest
     */
    _updateAdaptiveBlending(manifest) {
        this.blendingState.history.push({
            weights: { ...this.blendingState.currentWeights },
            timestamp: manifest.timestamp,
            effectiveness: this._calculateEffectiveness(manifest),
            sampleCount: manifest.samplePoints.length,
            distribution: manifest.samplingStrategy.distribution
        });
        
        // Keep history bounded
        if (this.blendingState.history.length > this.config.blendingWindow) {
            this.blendingState.history.shift();
        }
        
        // Simple adaptive strategy: boost weights of effective samplers
        if (this.blendingState.history.length >= 8) {
            this._adaptWeights();
        }
    }
    
    /**
     * Adapt sampling weights based on historical effectiveness
     */
    _adaptWeights() {
        const recent = this.blendingState.history.slice(-8);
        
        // Calculate average effectiveness per sampler type
        const effectiveness = { wallis: 0, random: 0, vogel: 0 };
        const counts = { wallis: 0, random: 0, vogel: 0 };
        
        recent.forEach(entry => {
            const dist = entry.distribution;
            const eff = entry.effectiveness;
            
            if (dist.wallis > 0) {
                effectiveness.wallis += eff * (dist.wallis / (dist.wallis + dist.random + dist.vogel));
                counts.wallis++;
            }
            if (dist.random > 0) {
                effectiveness.random += eff * (dist.random / (dist.wallis + dist.random + dist.vogel));
                counts.random++;
            }
            if (dist.vogel > 0) {
                effectiveness.vogel += eff * (dist.vogel / (dist.wallis + dist.random + dist.vogel));
                counts.vogel++;
            }
        });
        
        // Average effectiveness
        Object.keys(effectiveness).forEach(key => {
            if (counts[key] > 0) {
                effectiveness[key] /= counts[key];
            }
        });
        
        // Adjust weights slightly toward more effective samplers
        const adjustment = 0.05; // Small adjustment factor
        const totalEff = effectiveness.wallis + effectiveness.random + effectiveness.vogel;
        
        if (totalEff > 0) {
            const newWeights = {
                wallis: this.blendingState.currentWeights.wallis + 
                        (effectiveness.wallis / totalEff - this.config.wallis) * adjustment,
                random: this.blendingState.currentWeights.random + 
                        (effectiveness.random / totalEff - this.config.random) * adjustment,
                vogel: this.blendingState.currentWeights.vogel + 
                       (effectiveness.vogel / totalEff - this.config.vogel) * adjustment
            };
            
            // Normalize weights to sum to 1.0
            const sum = newWeights.wallis + newWeights.random + newWeights.vogel;
            if (sum > 0) {
                this.blendingState.currentWeights = {
                    wallis: Math.max(0.1, Math.min(0.8, newWeights.wallis / sum)),
                    random: Math.max(0.1, Math.min(0.8, newWeights.random / sum)),
                    vogel: Math.max(0.1, Math.min(0.8, newWeights.vogel / sum))
                };
                
                // Ensure exact sum of 1.0
                const finalSum = this.blendingState.currentWeights.wallis + 
                               this.blendingState.currentWeights.random + 
                               this.blendingState.currentWeights.vogel;
                
                if (Math.abs(finalSum - 1.0) > 0.001) {
                    const scale = 1.0 / finalSum;
                    this.blendingState.currentWeights.wallis *= scale;
                    this.blendingState.currentWeights.random *= scale;
                    this.blendingState.currentWeights.vogel *= scale;
                }
                
                if (this.config.enableDebugOutput) {
                    console.log('MultiSampler: Adapted weights:', this.blendingState.currentWeights);
                }
            }
        }
    }
    
    /**
     * Calculate sampling effectiveness metric
     * @param {Object} manifest - Sample manifest
     * @returns {number} Effectiveness score (0-1)
     */
    _calculateEffectiveness(manifest) {
        // Simple effectiveness: ratio of actual to target points, adjusted for processing time
        const pointsRatio = manifest.samplePoints.length / this.config.maxSamplePoints;
        const timeRatio = Math.max(0, 1.0 - (manifest.metadata.processingTime / this.config.timeBudgetMs));
        
        // Combine metrics: favor more points processed quickly
        return pointsRatio * 0.7 + timeRatio * 0.3;
    }
    
    /**
     * Merge temporal sampling results
     * @param {Array} results - Array of sample results
     * @param {Object} config - Configuration
     * @returns {Object} Merged result
     */
    _mergeTemporalResults(results, config) {
        if (results.length === 0) {
            return {
                timestamp: Date.now(),
                samplePoints: [],
                samplingStrategy: {
                    weights: { ...this.blendingState.currentWeights },
                    totalPoints: 0,
                    distribution: { wallis: 0, random: 0, vogel: 0 }
                },
                pluginResults: {},
                metadata: { 
                    processingTime: 0,
                    temporalMode: config.temporalMode,
                    frameCount: 0
                }
            };
        }
        
        if (results.length === 1) {
            return results[0];
        }
        
        // Merge multiple temporal results
        const totalSamplePoints = results.reduce((sum, r) => sum + (r.samplePoints?.length || 0), 0);
        const avgProcessingTime = results.reduce((sum, r) => sum + (r.metadata?.processingTime || 0), 0) / results.length;
        
        // Aggregate distributions
        const aggregatedDistribution = { wallis: 0, random: 0, vogel: 0 };
        results.forEach(r => {
            if (r.samplingStrategy?.distribution) {
                aggregatedDistribution.wallis += r.samplingStrategy.distribution.wallis || 0;
                aggregatedDistribution.random += r.samplingStrategy.distribution.random || 0;
                aggregatedDistribution.vogel += r.samplingStrategy.distribution.vogel || 0;
            }
        });
        
        return {
            timestamp: Date.now(),
            temporalMode: config.temporalMode,
            frameCount: results.length,
            aggregatedResults: results,
            summary: {
                totalSamplePoints,
                avgProcessingTime,
                distribution: aggregatedDistribution
            },
            metadata: {
                temporalMode: config.temporalMode,
                processingTime: avgProcessingTime,
                frameCount: results.length
            }
        };
    }
    
    /**
     * Update performance metrics
     * @param {number} startTime - Processing start time
     * @param {Object} result - Sample result
     */
    _updateMetrics(startTime, result) {
        this.metrics.totalSamples++;
        const processingTime = performance.now() - startTime;
        
        // Update rolling average
        this.metrics.avgSampleTime = (
            this.metrics.avgSampleTime * (this.metrics.totalSamples - 1) + processingTime
        ) / this.metrics.totalSamples;
        
        if (result.metadata) {
            result.metadata.processingTime = processingTime;
        }
        
        // Track memory pressure (simple heuristic)
        if (processingTime > this.config.timeBudgetMs * 1.5) {
            this.metrics.memoryPressure++;
        }
    }
    
    /**
     * Initialize sampler subsystems
     */
    _initializeSamplers() {
        if (this.config.enableDebugOutput) {
            console.log('MultiSampler initialized with config:', {
                seed: this.config.seed,
                weights: {
                    wallis: this.config.wallis,
                    random: this.config.random,
                    vogel: this.config.vogel
                },
                timeBudget: this.config.timeBudgetMs,
                sampleRange: `${this.config.minSamplePoints}-${this.config.maxSamplePoints}`
            });
        }
    }
    
    /**
     * Load plugins from configuration
     * @param {Array} pluginList - List of plugins to load
     */
    _loadPlugins(pluginList) {
        pluginList.forEach(plugin => {
            if (typeof plugin === 'object' && plugin.name) {
                this.registerPlugin(plugin.name, plugin);
            } else if (typeof plugin === 'function') {
                // Allow function-based plugins with name property
                if (plugin.name) {
                    this.registerPlugin(plugin.name, { run: plugin, version: '1.0.0' });
                }
            }
        });
        
        if (this.config.enableDebugOutput && pluginList.length > 0) {
            console.log(`MultiSampler: Loaded ${pluginList.length} plugins:`, this.getRegisteredPlugins());
        }
    }
    
    // ==================== PUBLIC API METHODS ====================
    
    /**
     * Register a plugin
     * @param {string} name - Plugin name
     * @param {Object} plugin - Plugin object with run() method
     */
    registerPlugin(name, plugin) {
        if (!plugin || typeof plugin.run !== 'function') {
            throw new Error(`Plugin ${name} must have a run() method`);
        }
        
        this.plugins.set(name, plugin);
        this.metrics.pluginCallCounts.set(name, 0);
        
        if (this.config.enableDebugOutput) {
            console.log(`MultiSampler: Registered plugin '${name}' v${plugin.version || '1.0.0'}`);
        }
    }
    
    /**
     * Unregister a plugin
     * @param {string} name - Plugin name to remove
     */
    unregisterPlugin(name) {
        const existed = this.plugins.delete(name);
        this.metrics.pluginCallCounts.delete(name);
        
        if (this.config.enableDebugOutput && existed) {
            console.log(`MultiSampler: Unregistered plugin '${name}'`);
        }
        
        return existed;
    }
    
    /**
     * Get list of registered plugin names
     * @returns {Array<string>} Plugin names
     */
    getRegisteredPlugins() {
        return Array.from(this.plugins.keys());
    }
    
    /**
     * Get comprehensive metrics
     * @returns {Object} Current metrics
     */
    getMetrics() {
        return {
            ...this.metrics,
            currentWeights: { ...this.blendingState.currentWeights },
            originalWeights: {
                wallis: this.config.wallis,
                random: this.config.random,
                vogel: this.config.vogel
            },
            pluginCount: this.plugins.size,
            seed: this.config.seed,
            config: {
                timeBudgetMs: this.config.timeBudgetMs,
                maxSamplePoints: this.config.maxSamplePoints,
                varianceStride: this.config.varianceStride,
                adaptiveBlending: this.config.enableAdaptiveBlending
            }
        };
    }
    
    /**
     * Reset all metrics and state
     */
    reset() {
        this.metrics = {
            totalSamples: 0,
            avgSampleTime: 0,
            pluginCallCounts: new Map(),
            blendingHistory: [],
            lastError: null,
            timeouts: 0,
            cancelled: 0,
            memoryPressure: 0
        };
        
        this.blendingState = {
            history: [],
            currentWeights: {
                wallis: this.config.wallis,
                random: this.config.random,
                vogel: this.config.vogel
            }
        };
        
        this.rng = this._createSeededRNG(this.config.seed);
        
        // Reset plugin call counts
        for (const pluginName of this.plugins.keys()) {
            this.metrics.pluginCallCounts.set(pluginName, 0);
        }
        
        if (this.config.enableDebugOutput) {
            console.log('MultiSampler: Reset complete');
        }
    }
    
    /**
     * Get current sampling configuration
     * @returns {Object} Current configuration
     */
    getConfig() {
        return { ...this.config };
    }
    
    /**
     * Check if sampler is in a healthy state
     * @returns {Object} Health status
     */
    getHealthStatus() {
        const metrics = this.getMetrics();
        
        return {
            healthy: metrics.lastError === null && metrics.avgSampleTime < this.config.timeBudgetMs,
            lastError: metrics.lastError,
            performance: {
                avgSampleTime: metrics.avgSampleTime,
                timeoutRate: metrics.totalSamples > 0 ? metrics.timeouts / metrics.totalSamples : 0,
                cancelRate: metrics.totalSamples > 0 ? metrics.cancelled / metrics.totalSamples : 0,
                memoryPressure: metrics.memoryPressure
            },
            adaptiveBlending: {
                enabled: this.config.enableAdaptiveBlending,
                currentWeights: metrics.currentWeights,
                driftFromOriginal: {
                    wallis: Math.abs(metrics.currentWeights.wallis - metrics.originalWeights.wallis),
                    random: Math.abs(metrics.currentWeights.random - metrics.originalWeights.random),
                    vogel: Math.abs(metrics.currentWeights.vogel - metrics.originalWeights.vogel)
                }
            }
        };
    }
    
    /**
     * Create a lightweight sampler instance for basic operations
     * @param {Object} options - Configuration overrides
     * @returns {MultiSampler} New lightweight instance
     */
    static createLightweight(options = {}) {
        return new MultiSampler({
            timeBudgetMs: 50,
            maxSamplePoints: 256,
            minSamplePoints: 32,
            varianceStride: 3,
            enableAdaptiveBlending: false,
            enableDebugOutput: false,
            ...options
        });
    }
    
    /**
     * Create a high-performance sampler instance
     * @param {Object} options - Configuration overrides
     * @returns {MultiSampler} New high-performance instance
     */
    static createHighPerformance(options = {}) {
        return new MultiSampler({
            timeBudgetMs: 200,
            maxSamplePoints: 2048,
            minSamplePoints: 128,
            varianceStride: 1,
            percentileMethod: 'quickselect',
            enableAdaptiveBlending: true,
            enableDebugOutput: false,
            ...options
        });
    }
}

export default MultiSampler;