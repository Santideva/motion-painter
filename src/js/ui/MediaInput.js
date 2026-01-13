// src/js/core/MediaInput.js
// MediaInput: robust multi-source media capture and lightweight annular sampling
// - Supports local camera, file samples, custom file blobs, remote/synthetic sources
// - Integrates MultiSampler (lightweight instance) with graceful fallback
// - CameraContainer abstraction for per-source metadata and sampler tuning
// - Defensive capture, cleanup, and annular preview generation
//
// Maintains existing structure, methods, APIs, flow, functionality and nomenclature,
// while adding the refinements requested: validation, MultiSampler safety, robust cleanup,
// sampler failure handling, and hierarchical-ready camera containers.
//
// NOTE: MultiSampler import is attempted but gracefully tolerated if it fails.

import { CONFIG, getOptimalCanvasSize } from '../utils/MathUtils.js';

let MultiSampler = null;
try {
  // Prefer absolute path used in worker contexts; fallback to relative.
  // Adjust as appropriate for your project layout.
  try {
    // attempt relative import
    // eslint-disable-next-line no-undef
    MultiSampler = (await import('../sampler/MultiSampler.js')).default || (await import('../sampler/MultiSampler.js')).MultiSampler;
  } catch (e) {
    // try absolute path style
    try {
      // eslint-disable-next-line no-undef
      MultiSampler = (await import('/src/js/sampler/MultiSampler.js')).default || (await import('/src/js/sampler/MultiSampler.js')).MultiSampler;
    } catch (e2) {
      console.warn('MediaInput: MultiSampler not available via import paths', e2);
      MultiSampler = null;
    }
  }
} catch (e) {
  // In environments where top-level await is not allowed, the above try may fail;
  // In that case, MultiSampler will remain null and we handle that later.
  console.warn('MediaInput: MultiSampler dynamic import attempt failed', e);
  MultiSampler = null;
}

/**
 * CameraContainer - lightweight encapsulation of a camera or source.
 */
class CameraContainer {
  constructor({
    cameraId = null,
    kind = 'local', // 'local' | 'file' | 'remote' | 'synthetic'
    deviceId = null,
    stream = null,
    videoElement = null,
    meta = {}
  } = {}) {
    // Validate kind
    const validKinds = ['local', 'file', 'remote', 'synthetic'];
    if (!validKinds.includes(kind)) {
      console.warn(`CameraContainer: invalid kind '${kind}', defaulting to 'local'`);
      kind = 'local';
    }

    this.cameraId = cameraId || this._generateCameraId(kind, deviceId);
    this.kind = kind;
    this.deviceId = deviceId || null;
    this.stream = stream || null;
    this.videoElement = videoElement || null;
    this.meta = meta || {};
    this.status = 'idle';
    this.createdAt = Date.now();

    // Sampler-specific overrides (per-camera tuning)
    this.samplerOptions = {
      seed: Math.floor(Math.random() * 2 ** 31),
      timeBudgetMs: 60,
      maxSamplePoints: 512,
      minSamplePoints: 64,
      normalizedCoords: false,
      enableAdaptiveBlending: false,
      // allow overriding via camera meta later
      ...this.meta.samplerOptions
    };

    // ADDED: Validate consistency
    if (kind === 'local' && !this.stream && videoElement && videoElement.srcObject) {
      this.stream = videoElement.srcObject;
    }

    if (kind === 'local' && !this.stream && !this.videoElement) {
      console.warn('CameraContainer: local camera created without stream or videoElement');
    }
  }

  _generateCameraId(kind, deviceId) {
    const prefix = kind || 'unknown';
    const middle = deviceId || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10));
    const timestamp = Date.now();
    return `${prefix}:${middle}:${timestamp}`;
  }

  getInfo() {
    return {
      cameraId: this.cameraId,
      kind: this.kind,
      deviceId: this.deviceId,
      status: this.status,
      meta: this.meta,
      hasStream: !!this.stream,
      hasVideoElement: !!this.videoElement,
      videoReady: this.videoElement ? (this.videoElement.readyState >= 2 && !this.videoElement.paused) : false,
      createdAt: this.createdAt
    };
  }

  isReady() {
    return this.status === 'ready' && this.videoElement && this.videoElement.readyState >= 2;
  }
}

/**
 * MediaInput - manages media sources, sampling and annular previews.
 */
export class MediaInput {
  /**
   * @param {HTMLVideoElement|null} videoElement - optional primary video element
   * @param {HTMLElement|null} statusElement - optional status display element
   */
  constructor(videoElement = null, statusElement = null) {
    this.video = videoElement;
    this.statusElement = statusElement;
    this.sources = new Map();        // cameraId -> CameraContainer
    this.activeCameraId = null;
    this.isActive = false;

    // Track if primary video element was provided by caller
    this._providedVideoElement = !!videoElement;

    // Sampler initialization with fallback
    try {
      if (MultiSampler && typeof MultiSampler.createLightweight === 'function') {
        this.sampler = MultiSampler.createLightweight({ enableDebugOutput: false });
        console.log('MediaInput: MultiSampler initialized (lightweight)');
      } else if (MultiSampler && typeof MultiSampler === 'function') {
        // If default export is constructor itself
        this.sampler = new MultiSampler({ enableDebugOutput: false });
        console.log('MediaInput: MultiSampler initialized (constructor)');
      } else {
        this.sampler = null;
        console.warn('MediaInput: MultiSampler not available; annular preview will use grid fallback');
      }
    } catch (e) {
      console.warn('MediaInput: MultiSampler initialization failed, annular previews will use fallback', e);
      this.sampler = null;
    }

    // Sampler failure tracking
    this._samplerFailureCount = 0;
    this._maxSamplerFailures = 3;

    this.onSourceReady = null;
    this._attachedLocalStreamCameraId = null;
    this._tempCanvas = null;
    this._createdVideoElements = new Set();
  }

  // ---------------------
  // Status and utility
  // ---------------------
  updateStatus(message) {
    if (this.statusElement) {
      try {
        this.statusElement.textContent = message;
      } catch (e) {
        // ignore UI errors
      }
    } else {
      // console.debug fallback
      // console.debug('MediaInput status:', message);
    }
  }

  // If caller used primary video element previously, keep that semantics via active camera info
  isVideoReady() {
    const info = this.getActiveCameraInfo();
    if (!info) return false;
    return info.videoInfo && info.videoInfo.isActive;
  }

  getVideoInfo() {
    if (!this.activeCameraId) {
      return {
        width: this.video ? (this.video.videoWidth || 0) : 0,
        height: this.video ? (this.video.videoHeight || 0) : 0,
        duration: this.video ? (this.video.duration || 0) : 0,
        currentTime: this.video ? (this.video.currentTime || 0) : 0,
        isActive: this.isActive
      };
    }

    const cam = this.sources.get(this.activeCameraId);
    if (!cam) return {
      width: 0, height: 0, duration: 0, currentTime: 0, isActive: this.isActive
    };

    const vid = cam.videoElement;
    return {
      width: vid ? (vid.videoWidth || 0) : 0,
      height: vid ? (vid.videoHeight || 0) : 0,
      duration: vid ? (vid.duration || 0) : 0,
      currentTime: vid ? (vid.currentTime || 0) : 0,
      isActive: this.isActive
    };
  }

  // ---------------------
  // Camera lifecycle
  // ---------------------

  /**
   * startCamera - starts a local camera and registers a CameraContainer.
   * Returns cameraId on success or null on failure.
   *
   * options: { facingMode, width, height, deviceId, preferFrameRate }
   */
  async startCamera({
    facingMode = 'environment',
    width = 1280,
    height = 720,
    deviceId = null,
    preferFrameRate = 30
  } = {}) {
    this.updateStatus('starting camera...');

    let stream = null;
    let vid = null;
    let createdLocalVideo = false;

    try {
      // Stop previous attached local stream if any
      if (this._attachedLocalStreamCameraId) {
        try { await this.stopCamera(this._attachedLocalStreamCameraId); } catch (_) {}
      }

      const constraints = {
        video: {
          facingMode: facingMode || undefined,
          width: { ideal: width },
          height: { ideal: height },
          deviceId: deviceId ? { exact: deviceId } : undefined,
          frameRate: { ideal: preferFrameRate }
        },
        audio: false
      };

      stream = await navigator.mediaDevices.getUserMedia(constraints);

      // Create or reuse video element
      vid = this.video;
      if (!vid) {
        vid = document.createElement('video');
        vid.setAttribute('playsinline', 'true');
        vid.muted = true;
        vid.style.display = 'none';
        // Do not rely on DOM; best-effort append for some browsers to autoplay
        try { document.body.appendChild(vid); } catch (e) {}
        createdLocalVideo = true;
        this._createdVideoElements.add(vid);
      }

      vid.srcObject = stream;

      // Timeout guard for play() to avoid indefinite hangs
      await Promise.race([
        vid.play(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Video play timeout')), 5000)
        )
      ]);

      // Ensure metadata loaded
      if ((vid.videoWidth === 0 || vid.videoHeight === 0) && typeof vid.addEventListener === 'function') {
        await new Promise((resolve, reject) => {
          let timeout = setTimeout(() => reject(new Error('Video metadata timeout')), 3000);
          const cb = () => {
            clearTimeout(timeout);
            vid.removeEventListener('loadedmetadata', cb);
            resolve();
          };
          vid.addEventListener('loadedmetadata', cb);
        });
      }

      const cam = new CameraContainer({
        kind: 'local',
        deviceId: deviceId || null,
        stream,
        videoElement: vid,
        meta: {
          width: vid.videoWidth || width,
          height: vid.videoHeight || height,
          facingMode,
          frameRate: preferFrameRate
        }
      });
      cam.status = 'ready';

this.sources.set(cam.cameraId, cam);
      this.activeCameraId = cam.cameraId;

      if (createdLocalVideo) {
        this._attachedLocalStreamCameraId = cam.cameraId;
      }

      this.isActive = true;
      this.updateStatus('camera started');

      // Call onCameraContainer FIRST with explicit container info
      try {
        if (typeof this.onCameraContainer === 'function') {
          console.log('[cameraContainer] MediaInput: calling onCameraContainer', {
            cameraId: cam.cameraId,
            kind: cam.kind,
            hasGetInfo: typeof cam.getInfo === 'function',
            keys: Object.keys(cam)
          });
          
          // Pass the container instance
          this.onCameraContainer(cam);
        } else {
          console.warn('[cameraContainer] MediaInput: onCameraContainer not registered');
        }
      } catch (e) {
        console.error('[cameraContainer] MediaInput: onCameraContainer callback error', e);
      }

      // THEN call onSourceReady for backwards compatibility
      try {
        if (typeof this.onSourceReady === 'function') {
          this.onSourceReady(cam);
        }
      } catch (e) {
        console.warn('MediaInput: onSourceReady callback error', e);
      }

      return cam.cameraId;

    } catch (error) {
      console.error('Camera error:', error);

      // Cleanup on failure
      if (stream) {
        try { stream.getTracks().forEach(t => t.stop()); } catch (e) {}
      }

      if (vid && createdLocalVideo) {
        try {
          vid.pause();
          vid.srcObject = null;
          if (vid.parentNode) vid.parentNode.removeChild(vid);
          this._createdVideoElements.delete(vid);
        } catch (e) {
          console.warn('MediaInput: video element cleanup failed', e);
        }
      }

      this.updateStatus('camera error');

      // Do not alert here; return null for caller to handle
      return null;
    }
  }

  /**
   * stopCamera - stops a camera by cameraId. If no id passed and activeCameraId present, stops that.
   */
  async stopCamera(cameraId = null) {
    const id = cameraId || this.activeCameraId;
    if (!id) return;

    const cam = this.sources.get(id);
    if (!cam) return;

    try {
      // Stop stream tracks
      if (cam.stream && typeof cam.stream.getTracks === 'function') {
        try {
          cam.stream.getTracks().forEach(t => {
            try { t.stop(); } catch (e) {}
          });
        } catch (e) { /* ignore */ }
      }

      // Clear video element
      if (cam.videoElement) {
        try {
          cam.videoElement.pause();
          try { cam.videoElement.srcObject = null; } catch (e) {}
          try { cam.videoElement.src = ''; } catch (e) {}
          // If we created it, remove from DOM
          if (this._createdVideoElements.has(cam.videoElement) && cam.videoElement.parentNode) {
            try { cam.videoElement.parentNode.removeChild(cam.videoElement); } catch (e) {}
            this._createdVideoElements.delete(cam.videoElement);
          }
        } catch (e) {
          console.warn('MediaInput: error clearing video element', e);
        }
      }

      cam.status = 'stopped';
    } catch (e) {
      console.warn(`MediaInput: error stopping camera ${id}`, e);
    } finally {
      this.sources.delete(id);
      if (this._attachedLocalStreamCameraId === id) this._attachedLocalStreamCameraId = null;
      if (this.activeCameraId === id) this.activeCameraId = null;
      // Update global active flag if no sources left
      this.isActive = this.sources.size > 0;
    }
  }

  // ---------------------
  // Sample / file sources
  // ---------------------

  /**
   * loadSampleVideo - loads a remote sample video URL as a source (file kind)
   * Returns cameraId on success or null on failure.
   */
  async loadSampleVideo(videoUrl = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4') {
    this.updateStatus('loading sample video...');

    let vid = null;
    let createdVideo = false;

    try {
      // Create or reuse primary video element
      vid = this.video;
      if (!vid) {
        vid = document.createElement('video');
        vid.setAttribute('playsinline', 'true');
        vid.muted = true;
        vid.loop = true;
        vid.style.display = 'none';
        try { document.body.appendChild(vid); } catch (e) {}
        createdVideo = true;
        this._createdVideoElements.add(vid);
      }

      // Stop any active local camera if necessary
      if (this._attachedLocalStreamCameraId) {
        try { await this.stopCamera(this._attachedLocalStreamCameraId); } catch (_) {}
      }

      vid.src = videoUrl;
      vid.loop = true;

      await new Promise((resolve, reject) => {
        let timedOut = false;
        const timeoutHandle = setTimeout(() => {
          timedOut = true;
          cleanup();
          reject(new Error('Video load timeout'));
        }, 10000);

        const onLoaded = () => {
          if (timedOut) return;
          clearTimeout(timeoutHandle);
          cleanup();
          resolve();
        };
        const onError = () => {
          if (timedOut) return;
          clearTimeout(timeoutHandle);
          cleanup();
          reject(new Error('Video load failed'));
        };
        const cleanup = () => {
          vid.onloadeddata = null;
          vid.onerror = null;
        };

        vid.onloadeddata = onLoaded;
        vid.onerror = onError;
      });

      await vid.play();

      const cam = new CameraContainer({
        kind: 'file',
        stream: null,
        videoElement: vid,
        meta: { sourceUrl: videoUrl, width: vid.videoWidth, height: vid.videoHeight }
      });
      cam.status = 'ready';

      this.sources.set(cam.cameraId, cam);
      this.activeCameraId = cam.cameraId;
      this.isActive = true;

      this.updateStatus('sample video loaded');

      // Call onCameraContainer FIRST
      try {
        if (typeof this.onCameraContainer === 'function') {
          console.log('[cameraContainer] MediaInput: calling onCameraContainer (sample video)', {
            cameraId: cam.cameraId,
            kind: cam.kind
          });
          this.onCameraContainer(cam);
        }
      } catch (e) {
        console.error('[cameraContainer] MediaInput: onCameraContainer callback error (sample video)', e);
      }

      // THEN call onSourceReady
      try {
        if (typeof this.onSourceReady === 'function') this.onSourceReady(cam);
      } catch (e) {
        console.warn('MediaInput: onSourceReady callback error', e);
      }

      return cam.cameraId;

    } catch (error) {
      console.error('Video load error:', error);
      this.updateStatus('video load error');

      if (vid && createdVideo) {
        try {
          vid.pause();
          vid.src = '';
          if (vid.parentNode) vid.parentNode.removeChild(vid);
          this._createdVideoElements.delete(vid);
        } catch (e) {}
      }

      return null;
    }
  }

  /**
   * loadCustomVideo - loads a File blob as a source
   * Returns cameraId on success or null on failure.
   */
  async loadCustomVideo(file) {
    if (!file) throw new Error('file required');

    this.updateStatus('loading custom video...');

    let vid = null;
    let createdVideo = false;
    const videoUrl = URL.createObjectURL(file);

    try {
      // Create or reuse primary video element
      vid = this.video;
      if (!vid) {
        vid = document.createElement('video');
        vid.setAttribute('playsinline', 'true');
        vid.muted = true;
        vid.loop = true;
        vid.style.display = 'none';
        try { document.body.appendChild(vid); } catch (e) {}
        createdVideo = true;
        this._createdVideoElements.add(vid);
      }

      // Stop attached local camera if necessary
      if (this._attachedLocalStreamCameraId) {
        try { await this.stopCamera(this._attachedLocalStreamCameraId); } catch (_) {}
      }

      vid.src = videoUrl;
      vid.loop = true;

      await new Promise((resolve, reject) => {
        let timedOut = false;
        const timeoutHandle = setTimeout(() => {
          timedOut = true;
          cleanup();
          try { URL.revokeObjectURL(videoUrl); } catch (e) {}
          reject(new Error('Custom video load timeout'));
        }, 10000);

        const onLoaded = () => {
          if (timedOut) return;
          clearTimeout(timeoutHandle);
          cleanup();
          // We can revoke object URL after loadeddata
          try { URL.revokeObjectURL(videoUrl); } catch (e) {}
          resolve();
        };
        const onError = () => {
          if (timedOut) return;
          clearTimeout(timeoutHandle);
          cleanup();
          try { URL.revokeObjectURL(videoUrl); } catch (e) {}
          reject(new Error('Custom video load failed'));
        };
        const cleanup = () => {
          vid.onloadeddata = null;
          vid.onerror = null;
        };

        vid.onloadeddata = onLoaded;
        vid.onerror = onError;
      });

      await vid.play();

      const cam = new CameraContainer({
        kind: 'file',
        stream: null,
        videoElement: vid,
        meta: { sourceFile: file.name || null, width: vid.videoWidth, height: vid.videoHeight }
      });
      cam.status = 'ready';

      this.sources.set(cam.cameraId, cam);
      this.activeCameraId = cam.cameraId;
      this.isActive = true;

      this.updateStatus('custom video loaded');

      // Call onCameraContainer FIRST
      try {
        if (typeof this.onCameraContainer === 'function') {
          console.log('[cameraContainer] MediaInput: calling onCameraContainer (custom video)', {
            cameraId: cam.cameraId,
            kind: cam.kind
          });
          this.onCameraContainer(cam);
        }
      } catch (e) {
        console.error('[cameraContainer] MediaInput: onCameraContainer callback error (custom video)', e);
      }

      // THEN call onSourceReady
      try {
        if (typeof this.onSourceReady === 'function') this.onSourceReady(cam);
      } catch (e) {
        console.warn('MediaInput: onSourceReady callback error', e);
      }

      return cam.cameraId;

    } catch (error) {
      console.error('Custom video load error:', error);
      this.updateStatus('custom video error');

      if (vid) {
        try {
          vid.pause();
          vid.src = '';
        } catch (e) {}
      }
      try { URL.revokeObjectURL(videoUrl); } catch (e) {}

      return null;
    }
  }

  // ---------------------
  // Frame capture
  // ---------------------
  /**
   * _captureFrameImageData(cameraId, {width, height})
   * - Validates video readiness and dimensions
   */
  async _captureFrameImageData(cameraId, { width = null, height = null } = {}) {
    if (!cameraId) {
      throw new Error('cameraId required for frame capture');
    }

    const cam = this.sources.get(cameraId);
    if (!cam || !cam.videoElement) {
      throw new Error('Camera or video element not available');
    }

    const vid = cam.videoElement;

    if (vid.readyState < 2) {
      throw new Error('Video not ready (readyState < 2)');
    }

    let w = width;
    let h = height;

    if (!w || !h) {
      w = w || vid.videoWidth || vid.clientWidth || 640;
      h = h || vid.videoHeight || vid.clientHeight || 480;
    }

    if (w <= 0 || h <= 0) {
      throw new Error(`Invalid capture dimensions: ${w}x${h}`);
    }

    try {
      let canvas;
      if (typeof OffscreenCanvas !== 'undefined') {
        canvas = new OffscreenCanvas(w, h);
      } else {
        if (!this._tempCanvas) this._tempCanvas = document.createElement('canvas');
        canvas = this._tempCanvas;
        canvas.width = w;
        canvas.height = h;
      }

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        throw new Error('Failed to get 2D context');
      }

      ctx.drawImage(vid, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);

      if (!imageData || !imageData.data || imageData.data.length === 0) {
        throw new Error('getImageData returned invalid data');
      }

      return imageData;
    } catch (e) {
      // Fallback using createImageBitmap
      console.warn('MediaInput: direct capture failed, trying bitmap fallback', e);

      try {
        const bitmap = await createImageBitmap(vid, { resizeWidth: w, resizeHeight: h });

        let canvas;
        if (typeof OffscreenCanvas !== 'undefined') {
          canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        } else {
          if (!this._tempCanvas) this._tempCanvas = document.createElement('canvas');
          canvas = this._tempCanvas;
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }

        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('Fallback: failed to get 2D context for bitmap');

        ctx.drawImage(bitmap, 0, 0);
        const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);

        try { bitmap.close(); } catch (_) {}

        if (!imageData || !imageData.data || imageData.data.length === 0) {
          throw new Error('Fallback getImageData returned invalid data');
        }

        return imageData;
      } catch (fallbackErr) {
        throw new Error(`Frame capture failed: ${e.message} (fallback: ${fallbackErr.message})`);
      }
    }
  }

  // ---------------------
  // Annular preview generation
  // ---------------------
  /**
   * getAnnularPreview(cameraId, { binCount, maxSamplePoints, timeBudgetMs, center })
   * Returns object { cameraId, width, height, binCount, annular, counts, samplingSummary, validPoints, timestamp }
   */
  async getAnnularPreview(cameraId, {
    binCount = 12,
    maxSamplePoints = 512,
    timeBudgetMs = 80,
    center = null
  } = {}) {
    if (!cameraId) {
      throw new Error('cameraId required');
    }

    const cam = this.sources.get(cameraId);
    if (!cam) {
      throw new Error(`Camera not found: ${cameraId}`);
    }

    if (!cam.isReady()) {
      throw new Error(`Camera not ready: ${cameraId} (status: ${cam.status})`);
    }

    // Validate parameters
    binCount = Math.max(1, Math.min(64, Math.floor(binCount)));
    maxSamplePoints = Math.max(16, Math.min(8192, Math.floor(maxSamplePoints)));
    timeBudgetMs = Math.max(10, Math.min(500, timeBudgetMs));

    const imageData = await this._captureFrameImageData(cameraId);
    const width = imageData.width;
    const height = imageData.height;
    const data = imageData.data;

    if (!data || data.length === 0) {
      throw new Error('Captured frame has no data');
    }

    const normalizedInput = {
      width,
      height,
      data,
      type: 'Normalized'
    };

    // Choose sampler instance
    let sampler = this.sampler;
    if (!sampler) {
      // Try to lazily create a lightweight sampler if MultiSampler is available
      try {
        if (MultiSampler && typeof MultiSampler.createLightweight === 'function') {
          sampler = MultiSampler.createLightweight();
          this.sampler = sampler;
        } else if (MultiSampler && typeof MultiSampler === 'function') {
          sampler = new MultiSampler();
          this.sampler = sampler;
        } else {
          sampler = null;
        }
      } catch (e) {
        sampler = null;
        console.warn('MediaInput: failed to lazily initialize MultiSampler', e);
      }
    }

    const samplerConfig = Object.assign({}, cam.samplerOptions || {}, {
      maxSamplePoints,
      timeBudgetMs,
      normalizedCoords: false,
      enableAdaptiveBlending: false
    });

    let manifest = null;
    if (sampler) {
      try {
        manifest = await sampler.sample(normalizedInput, samplerConfig);
        // Success -> reset failure count
        this._samplerFailureCount = 0;
      } catch (err) {
        this._samplerFailureCount++;
        console.warn(`MediaInput: sampler failed (${this._samplerFailureCount}/${this._maxSamplerFailures})`, err);

        if (this._samplerFailureCount >= this._maxSamplerFailures) {
          console.error('MediaInput: MultiSampler disabled after repeated failures');
          try { if (typeof sampler.destroy === 'function') sampler.destroy(); } catch (e) {}
          this.sampler = null;
          sampler = null;
        }

        // continue to fallback
        manifest = null;
      }
    }

    // Fallback: uniform grid if sampler missing or failed
    if (!manifest) {
      const gridN = Math.max(8, Math.floor(Math.sqrt(Math.min(maxSamplePoints, width * height))));
      const pts = [];
      for (let j = 0; j < gridN && pts.length < maxSamplePoints; j++) {
        for (let i = 0; i < gridN && pts.length < maxSamplePoints; i++) {
          const x = Math.floor((i + 0.5) * width / gridN);
          const y = Math.floor((j + 0.5) * height / gridN);
          if (x >= 0 && x < width && y >= 0 && y < height) {
            pts.push({ x, y, weight: 1.0 });
          }
        }
      }
      manifest = {
        samplePoints: pts,
        samplingStrategy: { totalPoints: pts.length, fallback: true }
      };
    }

    // Validate manifest
    if (!manifest || !manifest.samplePoints || manifest.samplePoints.length === 0) {
      throw new Error('Sampling produced no points');
    }

    // Compute annular aggregation
    const cx = center ? center[0] : Math.floor(width / 2);
    const cy = center ? center[1] : Math.floor(height / 2);
    const maxR = Math.hypot(Math.max(cx, width - cx), Math.max(cy, height - cy));

    const annular = new Float32Array(binCount).fill(0);
    const counts = new Int32Array(binCount).fill(0);

    const pts = manifest.samplePoints;
    let validPoints = 0;

    for (const p of pts) {
      // Handle both pixel and normalized coordinates
      let x = p.x;
      let y = p.y;

      if ((x === undefined || y === undefined) && (p.xNorm !== undefined && p.yNorm !== undefined)) {
        x = Math.floor(p.xNorm * width);
        y = Math.floor(p.yNorm * height);
      }

      if (x < 0 || y < 0 || x >= width || y >= height) {
        continue;
      }

      validPoints++;

      const dx = x - cx;
      const dy = y - cy;
      const r = Math.hypot(dx, dy);

      const bin = Math.min(binCount - 1, Math.floor((r / (maxR + 1e-12)) * binCount));

      const idx = (y * width + x) * 4;
      const lum = (0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]) / 255;

      const weight = p.weight !== undefined ? p.weight : 1.0;
      annular[bin] += lum * weight;
      counts[bin]++;
    }

    if (validPoints < Math.max(1, Math.floor((manifest.samplePoints.length || 0) * 0.5))) {
      console.warn(`MediaInput: Only ${validPoints}/${manifest.samplePoints.length} sample points were valid`);
    }

    // Normalize per-bin means
    for (let b = 0; b < binCount; b++) {
      if (counts[b] > 0) {
        annular[b] = annular[b] / counts[b];
      } else {
        annular[b] = 0.0;
      }
    }

    return {
      cameraId,
      width,
      height,
      binCount,
      annular: Array.from(annular),
      counts: Array.from(counts),
      samplingSummary: manifest.samplingStrategy || { totalPoints: pts.length },
      validPoints,
      timestamp: Date.now()
    };
  }

  // ---------------------
  // Helpers & info
  // ---------------------
  /**
   * Get info about the currently active camera
   */
  getActiveCameraInfo() {
    if (!this.activeCameraId) {
      return null;
    }

    const cam = this.sources.get(this.activeCameraId);
    if (!cam) return null;

    return {
      ...cam.getInfo(),
      videoInfo: this.getVideoInfo()
    };
  }

  // ---------------------
  // Cleanup and destroy
  // ---------------------
  destroy() {
    console.log('MediaInput: destroying...');

    // Stop all sources
    for (const [id, cam] of Array.from(this.sources.entries())) {
      try {
        this.stopCamera(id);
      } catch (e) {
        console.warn(`MediaInput: error stopping camera ${id}`, e);
      }
    }

    this.sources.clear();
    this.activeCameraId = null;

    // Cleanup created video elements
    for (const vid of Array.from(this._createdVideoElements)) {
      try {
        vid.pause();
        vid.srcObject = null;
        vid.src = '';
        if (vid.parentNode) {
          vid.parentNode.removeChild(vid);
        }
      } catch (e) {
        console.warn('MediaInput: error cleaning up video element', e);
      }
    }
    this._createdVideoElements.clear();

    // Cleanup temp canvas
    if (this._tempCanvas) {
      try {
        this._tempCanvas.width = 0;
        this._tempCanvas.height = 0;
        if (this._tempCanvas.parentNode) {
          this._tempCanvas.parentNode.removeChild(this._tempCanvas);
        }
      } catch (e) {
        console.warn('MediaInput: error cleaning up temp canvas', e);
      }
      this._tempCanvas = null;
    }

    // Cleanup sampler
    if (this.sampler && typeof this.sampler.destroy === 'function') {
      try {
        this.sampler.destroy();
      } catch (e) {
        console.warn('MediaInput: error destroying sampler', e);
      }
    }
    this.sampler = null;

    // Clear primary video reference if we didn't provide it originally
    if (this.video && !this._providedVideoElement) {
      try {
        this.video.pause();
        this.video.src = '';
        this.video.srcObject = null;
      } catch (e) {
        console.warn('MediaInput: error clearing primary video', e);
      }
    }
    this.video = null;

    this.isActive = false;

    console.log('MediaInput: destroyed');
  }
}

export default MediaInput;
