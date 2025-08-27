// src/core/FrameEvictionHook.js
// Adapter that forwards ImageBitmaps produced by FrameBuffer to the Preprocessor
export class FrameEvictionHook {
  constructor(preprocessor) {
    this.preprocessor = preprocessor;
    this._attached = false;
    this._handler = null;
    this._frameBuffer = null;
  }

  attach(frameBuffer) {
    if (!frameBuffer) {
      console.warn('FrameEvictionHook.attach(): received null frameBuffer — deferring attach.');
      return;
    }

    if (this._attached) this.detach();

    this._handler = (imageBitmap, meta) => {
      if (!imageBitmap) {
        console.warn('FrameEvictionHook: received null imageBitmap', meta);
        return;
      }
      try {
        // Forward the transferable ImageBitmap to the preprocessor wrapper.
        // The preprocessor wrapper will transfer it into a worker.
        this.preprocessor.enqueueFrame(imageBitmap, meta);
      } catch (err) {
        console.error('FrameEvictionHook handler error', err);
        try { imageBitmap.close(); } catch (e) {}
      }
    };

    frameBuffer.onEvict = this._handler;
    this._frameBuffer = frameBuffer;
    this._attached = true;
    console.log('FrameEvictionHook attached to FrameBuffer');
  }

  detach() {
    if (this._attached && this._frameBuffer && this._frameBuffer.onEvict === this._handler) {
      this._frameBuffer.onEvict = null;
    }
    this._frameBuffer = null;
    this._handler = null;
    this._attached = false;
    console.log('FrameEvictionHook detached');
  }
}