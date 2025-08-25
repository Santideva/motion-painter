import { CONFIG, getOptimalCanvasSize } from '../utils/MathUtils.js';

export class MediaInput {
  constructor(videoElement, statusElement) {
    this.video = videoElement;
    this.statusElement = statusElement;
    this.currentStream = null;
    this.isActive = false;
    
    this.onSourceReady = null; // Callback for when media is ready
  }
  
  async startCamera() {
    try {
      this.updateStatus('starting camera...');
      
      // Stop any existing stream
      this.stopCamera();
      
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { 
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });
      
      this.currentStream = stream;
      this.video.srcObject = stream;
      
      await this.video.play();
      
      this.isActive = true;
      this.updateStatus('camera started');
      
      if (this.onSourceReady) {
        this.onSourceReady();
      }
      
      return true;
      
    } catch (error) {
      console.error('Camera error:', error);
      this.updateStatus('camera error');
      
      let errorMessage = 'Camera access failed';
      if (error.name === 'NotAllowedError') {
        errorMessage = 'Camera permission denied';
      } else if (error.name === 'NotFoundError') {
        errorMessage = 'No camera found';
      } else if (error.name === 'NotSupportedError') {
        errorMessage = 'Camera not supported';
      }
      
      alert(errorMessage + ': ' + error.message);
      return false;
    }
  }
  
  stopCamera() {
    if (this.currentStream) {
      this.currentStream.getTracks().forEach(track => track.stop());
      this.currentStream = null;
    }
    
    if (this.video.srcObject) {
      this.video.srcObject = null;
    }
    
    this.isActive = false;
  }
  
  async loadSampleVideo(videoUrl = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4') {
    try {
      this.updateStatus('loading sample video...');
      
      // Stop camera if running
      this.stopCamera();
      
      this.video.src = videoUrl;
      this.video.loop = true;
      
      // Wait for video to be ready
      await new Promise((resolve, reject) => {
        let timedOut = false;
        const timeoutHandle = setTimeout(() => {
          timedOut = true;
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
          this.video.onloadeddata = null;
          this.video.onerror = null;
        };

        this.video.onloadeddata = onLoaded;
        this.video.onerror = onError;
      });
      
      await this.video.play();
      
      this.isActive = true;
      this.updateStatus('sample video loaded');
      
      if (this.onSourceReady) {
        this.onSourceReady();
      }
      
      return true;
      
    } catch (error) {
      console.error('Video load error:', error);
      this.updateStatus('video load error');
      alert('Failed to load sample video: ' + error.message);
      return false;
    }
  }
  
  async loadCustomVideo(file) {
    try {
      this.updateStatus('loading custom video...');
      
      // Stop camera if running
      this.stopCamera();
      
      const videoUrl = URL.createObjectURL(file);
      this.video.src = videoUrl;
      this.video.loop = true;
      
      // Wait for video to be ready
      await new Promise((resolve, reject) => {
        let timedOut = false;
        const timeoutHandle = setTimeout(() => {
          timedOut = true;
          reject(new Error('Custom video load timeout'));
        }, 10000);

        const onLoaded = () => {
          if (timedOut) return;
          clearTimeout(timeoutHandle);
          cleanup();
          // Clean up object URL after loadeddata (we keep src, but can revoke now)
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
          this.video.onloadeddata = null;
          this.video.onerror = null;
        };

        this.video.onloadeddata = onLoaded;
        this.video.onerror = onError;
      });
      
      await this.video.play();
      
      this.isActive = true;
      this.updateStatus('custom video loaded');
      
      if (this.onSourceReady) {
        this.onSourceReady();
      }
      
      return true;
      
    } catch (error) {
      console.error('Custom video load error:', error);
      this.updateStatus('custom video error');
      alert('Failed to load custom video: ' + error.message);
      return false;
    }
  }
  
  updateStatus(message) {
    if (this.statusElement) {
      this.statusElement.textContent = message;
    }
  }
  
  isVideoReady() {
    return this.video && this.video.readyState >= 2 && !this.video.paused && !this.video.ended;
  }
  
  getVideoInfo() {
    return {
      width: this.video ? this.video.videoWidth || 0 : 0,
      height: this.video ? this.video.videoHeight || 0 : 0,
      duration: this.video ? this.video.duration || 0 : 0,
      currentTime: this.video ? this.video.currentTime || 0 : 0,
      isActive: this.isActive
    };
  }
  
  destroy() {
    this.stopCamera();
    try {
      this.video.src = '';
    } catch (e) {}
    this.isActive = false;
  }
}
