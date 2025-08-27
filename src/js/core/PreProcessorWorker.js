// src/js/core/PreprocessorWorker.js
// Main-thread wrapper for the preprocessor worker.
// Exposes enqueueFrame(imageBitmap, meta) which posts the ImageBitmap as a transferable.

export class PreprocessorWorker {
  constructor() {
    // IMPORTANT: Use a static literal so webpack can bundle the worker.
    // Make sure src/js/core/preprocessor.worker.js exists (we provided it).
    try {
      this.worker = new Worker(new URL('./preprocessor.worker.js', import.meta.url), { type: 'module' });
    } catch (err) {
      // Very old environments may not support the above; fallback (rare in modern setups)
      console.warn('Module-workers not supported; attempting classic Worker fallback', err);
      this.worker = new Worker('./preprocessor.worker.js');
    }

    this.jobCounter = 0;
    this.pending = new Map(); // jobId -> meta

    this.worker.onmessage = (ev) => {
      const data = ev.data || {};
      if (data.event === 'artifact:ready') {
        console.info('PreprocessorWorker: artifact ready', data.jobId, data.keys || data.key);
        this.pending.delete(data.jobId);
      } else if (data.event === 'artifact:error') {
        console.warn('PreprocessorWorker: artifact error', data.jobId, data.error);
        this.pending.delete(data.jobId);
      } else {
        // pass-through logging or other messages
        console.debug('PreprocessorWorker:onmessage', data);
      }
    };

    this.worker.onerror = (ev) => {
      console.error('PreprocessorWorker: worker error', ev.message || ev);
    };
  }

  // Called by FrameEvictionHook with transferable ImageBitmap and meta
  enqueueFrame(imageBitmap, meta = {}, options = {}) {
    const jobId = `pre-${Date.now()}-${(this.jobCounter++).toString(36)}`;
    console.debug('PreprocessorWorker.enqueueFrame', jobId, meta, options);
    this.pending.set(jobId, { meta, ts: Date.now(), options });

    try {
      // Post transferable ImageBitmap into worker; ownership moves to worker.
      // We include options so consumers can request 'mode':'preview'|'final' etc.
      this.worker.postMessage({ op: 'preprocess', jobId, meta, options, imageBitmap }, [imageBitmap]);
    } catch (err) {
      console.error('PreprocessorWorker: failed to postImageBitmap to worker', err);
      // If postMessage fails, we should close the bitmap to free resources
      try { imageBitmap.close(); } catch (e) {}
      this.pending.delete(jobId);
      return { ok: false, reason: 'POST_FAILED', error: String(err) };
    }
    return { ok: true, jobId };
  }

  terminate() {
    try {
      if (this.worker) this.worker.terminate();
    } catch (e) {
      console.warn('PreprocessorWorker.terminate failed', e);
    } finally {
      this.worker = null;
      this.pending.clear();
    }
  }
}
