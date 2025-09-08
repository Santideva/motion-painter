// src/js/core/PreprocessorWorker.js
// Enhanced version with backpressure and improved queue management

export class PreprocessorWorker {
  constructor() {
    // Only log worker creation, not the verbose "Creating worker..." message
    
    // Initialize all properties first
    this.jobCounter = 0;
    this.pending = new Map();
    this.workerReady = false;
    this.queuedFrames = [];
    
    // Enhanced queue management
    this.maxQueueSize = 30; // Increased from 10
    this.processingRate = 0; // frames/second
    this.lastProcessedTime = Date.now();
    this.processedCount = 0;
    this.droppedCount = 0;
    this.backpressureActive = false;
    
    // Performance monitoring
    this.metrics = {
      avgProcessingTime: 0,
      queueUtilization: 0,
      dropRate: 0,
      throughput: 0,
      backpressureActive: false
    };

    // Create worker with correct path resolution
    try {
      // Fix: Use absolute path from public folder root
      this.worker = new Worker('/src/js/core/preprocessor.worker.js');
      // Silenced: console.log('PreprocessorWorker: Worker created successfully');
    } catch (err) {
      console.error('PreprocessorWorker: Failed to create worker', err);
      throw err;
    }

    // Add timeout for worker readiness
    this.readyTimeout = setTimeout(() => {
      if (!this.workerReady) {
        console.error('PreprocessorWorker: Worker failed to become ready within 10 seconds');
        // Only show state info if there's actually an error
        console.log('PreprocessorWorker: Current state:', {
          workerReady: this.workerReady,
          queuedFrames: this.queuedFrames.length,
          pendingJobs: this.pending.size
        });
      }
    }, 10000);

    // Set up message handler
    this.worker.onmessage = (ev) => {
      const data = ev.data || {};
      // Silenced recurring debug: console.log('PreprocessorWorker: Received message:', data.event, data);
      
      if (data.event === 'worker:ready') {
        clearTimeout(this.readyTimeout);
        this.workerReady = true;
        // Silenced: console.log('PreprocessorWorker: worker is ready, processing queued frames');
        
        // Only show detailed diagnostics if there are queued frames or issues
        const queuedCount = this.queuedFrames.length;
        if (queuedCount > 0) {
          console.log(`PreprocessorWorker: Processing ${queuedCount} queued frames`);
        }
        this._processQueuedFrames();
        
      } else if (data.event === 'worker:error') {
        console.error('PreprocessorWorker: worker initialization error', data.error);
        this.workerReady = false;
        clearTimeout(this.readyTimeout);
        
      } else if (data.event === 'artifact:ready') {
        // Silenced recurring info: console.info('PreprocessorWorker: artifact ready', data.jobId, data.keys || data.key);
        this._updateProcessingMetrics(data);
        this.pending.delete(data.jobId);
        
      } else if (data.event === 'artifact:error') {
        console.warn('PreprocessorWorker: artifact error', data.jobId, data.error);
        this.pending.delete(data.jobId);
        
      } else {
        // Silenced debug: console.debug('PreprocessorWorker:onmessage', data);
      }
    };

    this.worker.onerror = (ev) => {
      console.error('PreprocessorWorker: worker error', ev.message || ev);
      console.error('PreprocessorWorker: worker error details:', {
        filename: ev.filename,
        lineno: ev.lineno,
        colno: ev.colno,
        error: ev.error
      });
      clearTimeout(this.readyTimeout);
    };

    this.worker.onmessageerror = (ev) => {
      console.error('PreprocessorWorker: worker message error', ev);
      clearTimeout(this.readyTimeout);
    };
  }

  // Enhanced frame enqueueing with backpressure
  enqueueFrame(imageBitmap, meta = {}, options = {}) {
    // Check if we should apply backpressure
    if (this._shouldApplyBackpressure()) {
      this._applyBackpressure(imageBitmap);
      return { ok: false, reason: 'BACKPRESSURE_ACTIVE', queued: false };
    }

    if (!this.workerReady) {
      return this._queueFrame(imageBitmap, meta, options);
    }

    return this._enqueueFrameImmediate(imageBitmap, meta, options);
  }

  _shouldApplyBackpressure() {
    // Apply backpressure if:
    // 1. Queue is more than 80% full
    // 2. Processing rate is significantly slower than incoming rate
    // 3. Drop rate is too high
    
    const queueUtilization = this.queuedFrames.length / this.maxQueueSize;
    const highQueuePressure = queueUtilization > 0.8;
    const highDropRate = this.metrics.dropRate > 0.3; // More than 30% drops
    
    return highQueuePressure || highDropRate;
  }

  _applyBackpressure(imageBitmap) {
    // Close the bitmap to prevent memory leaks
    try { 
      imageBitmap.close(); 
    } catch (e) {}
    
    if (!this.backpressureActive) {
      this.backpressureActive = true;
      this.metrics.backpressureActive = true;
      console.warn('PreprocessorWorker: Backpressure activated - dropping frames to prevent overflow');
    }
    
    this.droppedCount++;
    this._updateDropRate();
  }

  _queueFrame(imageBitmap, meta, options) {
    // Silenced debug: console.debug('PreprocessorWorker: worker not ready, queuing frame');
    
    // Enhanced queue management with priority
    const frameData = { 
      imageBitmap, 
      meta, 
      options,
      timestamp: Date.now(),
      priority: this._calculateFramePriority(meta, options)
    };
    
    if (this.queuedFrames.length >= this.maxQueueSize) {
      // Remove lowest priority frame or oldest frame
      const victimIndex = this._findVictimFrame();
      const victim = this.queuedFrames.splice(victimIndex, 1)[0];
      
      try { 
        victim.imageBitmap.close(); 
      } catch (e) {}
      
      this.droppedCount++;
      console.warn('PreprocessorWorker: dropped queued frame due to queue overflow');
    }
    
    this.queuedFrames.push(frameData);
    this._updateQueueMetrics();
    
    return { ok: true, jobId: null, queued: true };
  }

  _calculateFramePriority(meta, options) {
    // Higher number = higher priority
    let priority = 0;
    
    // Prioritize final processing over preview
    if (options.mode === 'final') priority += 10;
    
    // Prioritize frames with motion detection
    if (meta.hasMotion) priority += 5;
    
    // Prioritize keyframes or significant frames
    if (meta.isKeyframe) priority += 3;
    
    return priority;
  }

  _findVictimFrame() {
    // Find the frame with lowest priority, or oldest if priorities are equal
    let victimIndex = 0;
    let lowestPriority = this.queuedFrames[0]?.priority || 0;
    let oldestTime = this.queuedFrames[0]?.timestamp || Date.now();
    
    for (let i = 1; i < this.queuedFrames.length; i++) {
      const frame = this.queuedFrames[i];
      if (frame.priority < lowestPriority || 
          (frame.priority === lowestPriority && frame.timestamp < oldestTime)) {
        victimIndex = i;
        lowestPriority = frame.priority;
        oldestTime = frame.timestamp;
      }
    }
    
    return victimIndex;
  }

  _processQueuedFrames() {
    // Sort by priority (highest first) then by timestamp (newest first)
    this.queuedFrames.sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      return b.timestamp - a.timestamp;
    });
    
    const queued = [...this.queuedFrames];
    this.queuedFrames = [];
    
    // Process frames with slight delay to prevent overwhelming worker
    queued.forEach((frameData, index) => {
      setTimeout(() => {
        this._enqueueFrameImmediate(frameData.imageBitmap, frameData.meta, frameData.options);
      }, index * 10); // 10ms stagger
    });
  }

  _enqueueFrameImmediate(imageBitmap, meta = {}, options = {}) {
    const jobId = `pre-${Date.now()}-${(this.jobCounter++).toString(36)}`;
    // Silenced recurring debug: console.debug('PreprocessorWorker.enqueueFrame', jobId, meta, options);
    
    this.pending.set(jobId, { 
      meta, 
      ts: Date.now(), 
      options,
      startTime: Date.now()
    });

    try {
      this.worker.postMessage({ 
        op: 'preprocess', 
        jobId, 
        meta, 
        options, 
        imageBitmap 
      }, [imageBitmap]);
      
      return { ok: true, jobId };
      
    } catch (err) {
      console.error('PreprocessorWorker: failed to postImageBitmap to worker', err);
      try { 
        imageBitmap.close(); 
      } catch (e) {}
      this.pending.delete(jobId);
      return { ok: false, reason: 'POST_FAILED', error: String(err) };
    }
  }

  _updateProcessingMetrics(data) {
    this.processedCount++;
    
    const job = this.pending.get(data.jobId);
    if (job) {
      const processingTime = Date.now() - job.startTime;
      this.metrics.avgProcessingTime = (this.metrics.avgProcessingTime * 0.9) + (processingTime * 0.1);
    }
    
    // Update throughput
    const now = Date.now();
    const timeDelta = now - this.lastProcessedTime;
    if (timeDelta > 1000) { // Update every second
      this.metrics.throughput = (this.processedCount * 1000) / timeDelta;
      this.lastProcessedTime = now;
      this.processedCount = 0;
    }
    
    this._updateDropRate();
    this._checkBackpressureRelease();
  }

  _updateQueueMetrics() {
    this.metrics.queueUtilization = this.queuedFrames.length / this.maxQueueSize;
  }

  _updateDropRate() {
    const total = this.processedCount + this.droppedCount;
    this.metrics.dropRate = total > 0 ? this.droppedCount / total : 0;
  }

  _checkBackpressureRelease() {
    if (this.backpressureActive) {
      const queueUtilization = this.queuedFrames.length / this.maxQueueSize;
      
      // Release backpressure when conditions improve
      if (queueUtilization < 0.5 && this.metrics.dropRate < 0.1) {
        this.backpressureActive = false;
        this.metrics.backpressureActive = false;
        console.log('PreprocessorWorker: Backpressure released - normal processing resumed');
      }
    }
  }

  // Enhanced metrics including backpressure status
  getMetrics() {
    // Defensive check to prevent undefined errors
    if (!this.pending) {
      console.warn('PreprocessorWorker.getMetrics: pending Map not initialized');
      return {
        workerReady: this.workerReady || false,
        pending: 0,
        queuedFrames: this.queuedFrames ? this.queuedFrames.length : 0,
        maxQueueSize: this.maxQueueSize || 30,
        totalJobs: this.jobCounter || 0,
        droppedCount: this.droppedCount || 0,
        backpressureActive: this.backpressureActive || false,
        ...this.metrics
      };
    }

    return {
      workerReady: this.workerReady,
      pending: this.pending.size,
      queuedFrames: this.queuedFrames.length,
      maxQueueSize: this.maxQueueSize,
      totalJobs: this.jobCounter,
      droppedCount: this.droppedCount,
      backpressureActive: this.backpressureActive,
      ...this.metrics
    };
  }

  // Method to check if worker can accept more frames
  canAcceptFrames() {
    return this.workerReady && !this._shouldApplyBackpressure();
  }

  // Method to get processing capacity status
  getCapacityStatus() {
    const utilization = this.metrics.queueUtilization;
    
    if (utilization < 0.3) return 'low';
    if (utilization < 0.7) return 'medium';
    if (utilization < 0.9) return 'high';
    return 'critical';
  }

  terminate() {
    try {
      if (this.readyTimeout) {
        clearTimeout(this.readyTimeout);
      }

      // Clean up any queued frames
      this.queuedFrames.forEach(({ imageBitmap }) => {
        try { 
          imageBitmap.close(); 
        } catch (e) {}
      });
      this.queuedFrames = [];

      if (this.worker) {
        this.worker.postMessage({ op: 'shutdown' });
        this.worker.terminate();
      }
    } catch (e) {
      console.warn('PreprocessorWorker.terminate failed', e);
    } finally {
      this.worker = null;
      this.pending.clear();
      this.workerReady = false;
      this.backpressureActive = false;
    }
  }
}