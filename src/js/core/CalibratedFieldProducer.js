// /src/js/modules/CalibratedFieldProducer.js
// CalibratedFieldProducer (storage loader) - revised to accept an injected storage wrapper
// - Does NOT import storage.js itself
// - Accepts storageWrapper via constructor options or setStorageWrapper()
// - If caller already fetched artifact, accepts calibratedArtifact in calibData
// - Prefers typed-array blobs when artifact.meta indicates typedArrayType
// - Falls back to image blob -> createImageBitmap -> OffscreenCanvas -> Float32Array

export class CalibratedFieldProducer {
  /**
   * @param {Object} options
   * @param {number} [options.resolution=512]
   * @param {boolean} [options.enableMultiSpectral=false]
   * @param {string} [options.normalization='uint8'] - 'uint8'|'float32' (only advisory)
   * @param {Object} [options.storageWrapper=null] - injected storage API wrapper (optional)
   * @param {boolean} [options.debug=false]
   */
  constructor(options = {}) {
    this.resolution = options.resolution || 512;
    this.enableMultiSpectral = options.enableMultiSpectral || false;
    this.normalization = options.normalization || 'uint8';
    this.debug = !!options.debug;

    // Optional injected storage wrapper (set by caller)
    this.storageWrapper = options.storageWrapper || null;

    // Internal canvas for image -> float extraction
    this._canvas = null;
    this._ctx = null;

    // stats
    this.stats = {
      framesLoaded: 0,
      avgLoadMs: 0,
      totalLoadMs: 0,
      lastError: null
    };
  }

  /**
   * Allow caller to inject the storage wrapper
   * @param {Object} storageWrapper - object implementing getArtifact(key, opts) -> { blob, meta, data }
   */
  setStorageWrapper(storageWrapper) {
    this.storageWrapper = storageWrapper;
  }

  /**
   * Produce calibrated field
   * @param {ImageBitmap|null} frameBitmap - original frame (kept for API compatibility; may be unused)
   * @param {Object} calibData - calibration metadata; expected to contain either:
   *    - calibratedFrameKey OR
   *    - meta.calibratedFrameKey OR
   *    - calibratedArtifact (already fetched artifact object)
   * @param {Object} options - { resolution, enableMultiSpectral, storageWrapper, calibratedFrameKey, calibratedArtifact }
   * @returns {Promise<Object>} { calibratedField: Float32Array, resolution, channels, encoding, calibratedFrameKey, telemetry }
   */
  async produce(frameBitmap = null, calibData = null, options = {}) {
    const start = performance.now();
    const telemetry = { stages: {}, warnings: [], success: false };

    const resolution = Number.isInteger(options.resolution) ? options.resolution : this.resolution;
    const enableMultiSpectral = options.enableMultiSpectral ?? this.enableMultiSpectral;

    try {
      telemetry.stages.validate_start = performance.now();

      if (!calibData || typeof calibData !== 'object') {
        throw new Error('calibData required - cannot proceed without calibration metadata');
      }

      // Candidate sources for the calibrated artifact/key
      const candidateArtifact = options.calibratedArtifact || calibData.calibratedArtifact || null;
      const candidateKey =
        options.calibratedFrameKey ||
        calibData.calibratedFrameKey ||
        (calibData.meta && calibData.meta.calibratedFrameKey) ||
        null;

      telemetry.stages.validate_end = performance.now();
      telemetry.stages.validate_ms = telemetry.stages.validate_end - telemetry.stages.validate_start;

      // Storage wrapper resolution
      const storageWrapper = options.storageWrapper || this.storageWrapper || null;
      if (!candidateArtifact && !candidateKey) {
        throw new Error('No calibratedFrameKey or calibratedArtifact provided in calibData/options');
      }
      if (!candidateArtifact && !storageWrapper) {
        throw new Error('No storageWrapper provided: CalibratedFieldProducer needs storage access to load artifact');
      }

      // Load artifact if not provided
      let artifact = candidateArtifact;
      telemetry.stages.storage_start = performance.now();
      if (!artifact) {
        // Use storageWrapper.getArtifact(key, { denormalize: true }) if available
        if (typeof storageWrapper.getArtifact === 'function') {
          artifact = await storageWrapper.getArtifact(candidateKey, { denormalize: true }).catch(err => { throw new Error('storage.getArtifact failed: ' + String(err)); });
        } else {
          throw new Error('storageWrapper.getArtifact is not a function');
        }
      }
      telemetry.stages.storage_end = performance.now();
      telemetry.stages.storage_ms = telemetry.stages.storage_end - telemetry.stages.storage_start;

      if (!artifact) throw new Error(`Calibrated artifact not found for key ${candidateKey || '(artifact provided but falsy)'}`);

      // ── DIAGNOSTIC: verify we loaded the right artifact ─────────────────
      // Check that the loaded artifact is the calibrated frame and not
      // accidentally the dark, flat, or bias frame.
      console.log('[CALIB-PRODUCER-DIAG] Artifact loaded:', {
        key:            candidateKey,
        hasBlob:        !!artifact.blob,
        blobType:       artifact.blob?.type ?? 'none',
        blobSize:       artifact.blob?.size ?? 0,
        hasDataField:   !!(artifact.data?.field),
        metaType:       artifact.meta?.type ?? 'unknown',
        metaKeys:       artifact.meta ? Object.keys(artifact.meta) : [],
        // These should all be null/undefined — if any are present,
        // we may have loaded a calibration component instead of the output
        isDark:         artifact.meta?.type === 'dark' ||
                        candidateKey?.includes(':dark:'),
        isFlat:         artifact.meta?.type === 'flat' ||
                        candidateKey?.includes(':flat:'),
        isBias:         artifact.meta?.type === 'bias' ||
                        candidateKey?.includes(':bias:'),
        isCalibrated:   candidateKey?.includes(':calibrated:'),
        verdict: candidateKey?.includes(':calibrated:')
          ? '✅ Key looks correct (calibrated frame)'
          : candidateKey?.includes(':dark:')
            ? '❌ WRONG ARTIFACT — loaded dark frame instead of calibrated frame'
            : candidateKey?.includes(':flat:')
              ? '❌ WRONG ARTIFACT — loaded flat frame instead of calibrated frame'
              : '⚠️ Key type unclear — inspect manually'
      });

      // If it is an image blob, sample a few pixels immediately to check brightness
      if (artifact.blob && artifact.blob.size > 0) {
        try {
          const bmpCheck = await createImageBitmap(artifact.blob);
          const checkCanvas = new OffscreenCanvas(32, 32); // tiny sample
          const checkCtx = checkCanvas.getContext('2d');
          checkCtx.drawImage(bmpCheck, 0, 0, 32, 32);
          const checkData = checkCtx.getImageData(0, 0, 32, 32).data;
          let maxPx = 0, sumPx = 0;
          for (let i = 0; i < checkData.length; i += 4) {
            const lum = 0.299 * checkData[i] + 0.587 * checkData[i+1] + 0.114 * checkData[i+2];
            if (lum > maxPx) maxPx = lum;
            sumPx += lum;
          }
          const meanPx = sumPx / (checkData.length / 4);
          console.log('[CALIB-PRODUCER-DIAG] Artifact blob pixel sample (32×32):', {
            maxLuminance:  maxPx.toFixed(2) + ' / 255',
            meanLuminance: meanPx.toFixed(2) + ' / 255',
            isNearBlack:   maxPx < 5,
            verdict: maxPx < 5
              ? '❌ BLOB IS NEARLY BLACK — wrong artifact or dark frame loaded'
              : maxPx < 20
                ? '⚠️ LOW SIGNAL — may be dark frame or underexposed'
                : '✅ Blob has usable signal'
          });
          try { bmpCheck.close(); } catch (_) {}
        } catch (e) {
          console.warn('[CALIB-PRODUCER-DIAG] Blob pixel check failed:', e.message);
        }
      }
      // ── END DIAGNOSTIC ────────────────────────────────────────────────────
      
      // Artifact can contain data (structured) or blob (binary)
      if (!artifact.blob && artifact.data && artifact.data.field) {
        // If storage returned a structured Float32Array under artifact.data.field, accept it
        if (artifact.data.field instanceof Float32Array) {
          telemetry.source = 'artifact.data.field';
          var calibratedField = artifact.data.field;
        } else if (Array.isArray(artifact.data.field) || artifact.data.field instanceof Uint8Array) {
          // convert array to Float32 normalizing if needed
          const arr = artifact.data.field;
          const count = resolution * resolution;
          const field = new Float32Array(count * 4);
          // best-effort copy/normalize
          for (let i = 0; i < Math.min(field.length, arr.length); i++) {
            field[i] = Number(arr[i]) || 0;
          }
          telemetry.source = 'artifact.data.field(array)';
          var calibratedField = field;
        } else {
          // fallthrough to blob handling
        }
      }

      // If calibratedField not yet obtained, inspect blob
      if (typeof calibratedField === 'undefined') {
        if (!artifact.blob) {
          throw new Error('Artifact has no blob and no field data');
        }

        // If artifact.meta indicates typedArrayType, prefer blob.arrayBuffer -> typed array
        const typedType = artifact.meta && artifact.meta.typedArrayType ? artifact.meta.typedArrayType : null;
        if (typedType && (typedType.toLowerCase().includes('float32') || typedType.toLowerCase().includes('float'))) {
          telemetry.stages.blob_arraybuffer_start = performance.now();
          const ab = await artifact.blob.arrayBuffer();
          telemetry.stages.blob_arraybuffer_end = performance.now();
          telemetry.stages.blob_arraybuffer_ms = telemetry.stages.blob_arraybuffer_end - telemetry.stages.blob_arraybuffer_start;

          // If the blob is exactly Float32Array of length resolution^2 * 4, use it directly
          const f32 = new Float32Array(ab);
          if (f32.length === resolution * resolution * 4) {
            calibratedField = f32;
            telemetry.source = 'blob.float32';
          } else {
            // If sizes differ, try to salvage by truncating / expanding
            const field = new Float32Array(resolution * resolution * 4);
            field.set(f32.subarray(0, Math.min(f32.length, field.length)));
            calibratedField = field;
            telemetry.source = 'blob.float32.truncated_or_padded';
            telemetry.warnings.push('typed-array blob length mismatch: padded/truncated to target resolution');
          }
        } else {
          // Treat blob as an encoded image (e.g. webp/png/jpeg from preprocessor)
          telemetry.stages.bitmap_start = performance.now();
          let bmp = null;
          try {
            bmp = await createImageBitmap(artifact.blob);
          } catch (e) {
            throw new Error('createImageBitmap failed for calibrated artifact blob: ' + String(e));
          }
          telemetry.stages.bitmap_end = performance.now();
          telemetry.stages.bitmap_ms = telemetry.stages.bitmap_end - telemetry.stages.bitmap_start;

          // Extract via OffscreenCanvas
          calibratedField = await this._extractFieldFromBitmap(bmp, resolution, telemetry);
          try { if (bmp && typeof bmp.close === 'function') bmp.close(); } catch (_) {}
          telemetry.source = 'blob.image->canvas';
        }
      }

      // Final validation
      if (!(calibratedField && calibratedField.length === resolution * resolution * 4)) {
        throw new Error(`calibratedField invalid size (${calibratedField?.length || 0}) expected ${resolution * resolution * 4}`);
      }

      // Optionally separate channels for tetrachromacy consumer
      const result = {
        calibratedField,
        resolution,
        channels: 4,
        spectralModel: enableMultiSpectral ? 'tetrachromatic' : 'rgba',
        encoding: 'float32',
        calibratedFrameKey: artifact.meta?.metaKey || artifact.meta?.key || options.calibratedFrameKey || null,
        telemetry
      };

      if (enableMultiSpectral) {
        result.separatedChannels = this._separateChannels(calibratedField, resolution);
      }

      // stats
      const loadMs = performance.now() - start;
      this.stats.framesLoaded++;
      this.stats.totalLoadMs += loadMs;
      this.stats.avgLoadMs = this.stats.totalLoadMs / this.stats.framesLoaded;

      telemetry.processingMs = loadMs;
      telemetry.success = true;

      if (this.debug) {
        console.log('CalibratedFieldProducer.produce: success', {
          resolution,
          source: telemetry.source,
          loadMs
        });
      }

      return result;

    } catch (err) {
      this.stats.lastError = String(err.message || err);
      telemetry.success = false;
      telemetry.error = String(err.message || err);
      telemetry.stack = err && err.stack ? err.stack : null;
      if (this.debug) console.error('CalibratedFieldProducer.produce failed', err);
      throw err;
    }
  }

  /**
   * Convert an ImageBitmap -> Float32Array RGBA [0,1]
   * @private
   */
  async _extractFieldFromBitmap(bitmap, resolution, telemetry = {}) {
    // create offscreen canvas matching resolution if needed
    if (!this._canvas || this._canvas.width !== resolution || this._canvas.height !== resolution) {
      this._canvas = new OffscreenCanvas(resolution, resolution);
      this._ctx = this._canvas.getContext('2d', { willReadFrequently: true, alpha: true });
    }
    this._ctx.clearRect(0, 0, resolution, resolution);
    this._ctx.drawImage(bitmap, 0, 0, resolution, resolution);
    const imageData = this._ctx.getImageData(0, 0, resolution, resolution);
    const src = imageData.data; // Uint8ClampedArray
    const count = resolution * resolution;
    const out = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const s = i * 4;
      out[s + 0] = src[s + 0] / 255.0;
      out[s + 1] = src[s + 1] / 255.0;
      out[s + 2] = src[s + 2] / 255.0;
      out[s + 3] = src[s + 3] / 255.0;
    }
    // simple stats
    let r=0,g=0,b=0,a=0;
    for (let i=0;i<count;i++) { r += out[i*4+0]; g += out[i*4+1]; b += out[i*4+2]; a += out[i*4+3]; }
    telemetry.fieldStats = { meanR: r/count, meanG: g/count, meanB: b/count, meanA: a/count, pixels: count };
    return out;
  }

  /**
   * Separate RGBA into per-channel Float32Arrays
   */
  _separateChannels(field, resolution) {
    const count = resolution * resolution;
    const R = new Float32Array(count);
    const G = new Float32Array(count);
    const B = new Float32Array(count);
    const A = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const s = i * 4;
      R[i] = field[s + 0];
      G[i] = field[s + 1];
      B[i] = field[s + 2];
      A[i] = field[s + 3];
    }
    return { R, G, B, A };
  }

  /**
   * Convert Float32Array field -> THREE.DataTexture
   */
  toDataTexture(field, resolution, THREE) {
    if (!THREE || !THREE.DataTexture) throw new Error('THREE required for DataTexture conversion');
    const tex = new THREE.DataTexture(field, resolution, resolution, THREE.RGBAFormat, THREE.FloatType);
    tex.needsUpdate = true;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }

  getStats() { return { ...this.stats }; }
  resetStats() { this.stats = { framesLoaded: 0, avgLoadMs: 0, totalLoadMs: 0, lastError: null }; }
  dispose() { this._canvas = null; this._ctx = null; this.storageWrapper = null; }
}

/** Factory */
export function createCalibratedFieldProducer(options = {}) {
  return new CalibratedFieldProducer(options);
}
export default CalibratedFieldProducer;
