// Interactive Map Demo - Real WebGPU Map Implementation
// Shows actual map rendering with tiles, navigation, and performance metrics

import { WebGPUMapEngine } from '../core/map/WebGPUMapEngine';
import type { LngLat, MapConfig } from '../types/core';

// Simple WebGPU support check function
async function checkWebGPUSupport() {
  if (!navigator.gpu) {
    return { supported: false, error: 'WebGPU not available in this browser' };
  }
  
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return { supported: false, error: 'No WebGPU adapter available' };
    }
    
    const device = await adapter.requestDevice();
    return { supported: true, adapter, device };
  } catch (error) {
    return { supported: false, error: `WebGPU error: ${error}` };
  }
}

/**
 * Interactive map demo showcasing the complete WebGPU mapping system
 */
export class InteractiveMapDemo {
  private mapEngine: WebGPUMapEngine | null = null;
  private device: GPUDevice | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private isInitialized = false;
  
  // Performance monitoring
  private performanceInterval: number | null = null;
  private metricsUpdateCallback: ((metrics: any) => void) | null = null;
  
  constructor() {
    console.log('🗺️ Interactive Map Demo initialized');
  }
  
  /**
   * Initialize the interactive map demo
   */
  async initialize(canvas: HTMLCanvasElement, config: Partial<MapConfig> = {}): Promise<boolean> {
    try {
      // Check WebGPU support
      const support = await checkWebGPUSupport();
      if (!support.supported || !support.device) {
        console.error('❌ WebGPU not supported for map demo');
        return false;
      }
      
      this.device = support.device;
      this.canvas = canvas;
      
      // Configure canvas size
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * devicePixelRatio;
      canvas.height = rect.height * devicePixelRatio;
      
      // Default map configuration for demo
      const mapConfig: MapConfig = {
        center: config.center ?? { lng: -122.4194, lat: 37.7749 }, // San Francisco
        zoom: config.zoom ?? 10,
        bearing: config.bearing ?? 0,
        pitch: config.pitch ?? 0,
        minZoom: config.minZoom ?? 1,
        maxZoom: config.maxZoom ?? 18,
        tileSize: config.tileSize ?? 512,
        maxTileCacheSize: config.maxTileCacheSize ?? 100,
        enableInteraction: config.enableInteraction ?? true,
        enablePerformanceMonitoring: config.enablePerformanceMonitoring ?? true
      };
        // Initialize map engine
      if (!this.device) {
        console.error('❌ Device not available');
        return false;
      }
      
      this.mapEngine = new WebGPUMapEngine(this.device, this.canvas, mapConfig);
      await this.mapEngine.initialize();
      
      // Setup event listeners for UI controls
      this.setupUIControls();
      
      // Start performance monitoring
      this.startPerformanceMonitoring();
      
      this.isInitialized = true;
      console.log('✅ Interactive Map Demo ready');
      
      return true;
      
    } catch (error) {
      console.error('❌ Failed to initialize Interactive Map Demo:', error);
      return false;
    }
  }
  
  /**
   * Setup UI controls for map interaction
   */
  private setupUIControls(): void {
    // Zoom controls
    const zoomInBtn = document.getElementById('zoomIn');
    const zoomOutBtn = document.getElementById('zoomOut');
    
    if (zoomInBtn) {
      zoomInBtn.addEventListener('click', () => {
        if (this.mapEngine) {
          const currentState = this.mapEngine.getMapState();
          this.mapEngine.setZoom(currentState.transform.zoom + 1);
        }
      });
    }
    
    if (zoomOutBtn) {
      zoomOutBtn.addEventListener('click', () => {
        if (this.mapEngine) {
          const currentState = this.mapEngine.getMapState();
          this.mapEngine.setZoom(currentState.transform.zoom - 1);
        }
      });
    }
    
    // Location presets
    const locations = [
      { name: 'San Francisco', lng: -122.4194, lat: 37.7749, zoom: 12 },
      { name: 'New York', lng: -74.0060, lat: 40.7128, zoom: 12 },
      { name: 'London', lng: -0.1276, lat: 51.5074, zoom: 12 },
      { name: 'Tokyo', lng: 139.6917, lat: 35.6895, zoom: 12 },
      { name: 'Sydney', lng: 151.2093, lat: -33.8688, zoom: 12 }
    ];
    
    locations.forEach((location, index) => {
      const btn = document.getElementById(`location${index + 1}`);
      if (btn) {
        btn.textContent = location.name;
        btn.addEventListener('click', () => {
          if (this.mapEngine) {
            this.mapEngine.flyTo(
              { lng: location.lng, lat: location.lat },
              location.zoom,
              2000 // 2 second animation
            );
          }
        });
      }
    });
    
    // Reset view
    const resetBtn = document.getElementById('resetView');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        if (this.mapEngine) {
          this.mapEngine.flyTo(
            { lng: -122.4194, lat: 37.7749 },
            10,
            1500
          );
          this.mapEngine.setBearing(0);
          this.mapEngine.setPitch(0);
        }
      });
    }
    
    // Bearing controls
    const bearingSlider = document.getElementById('bearingSlider') as HTMLInputElement;
    if (bearingSlider) {
      bearingSlider.addEventListener('input', (event) => {
        if (this.mapEngine) {
          const bearing = parseFloat((event.target as HTMLInputElement).value);
          this.mapEngine.setBearing(bearing);
          
          // Update display
          const display = document.getElementById('bearingValue');
          if (display) display.textContent = `${bearing.toFixed(0)}°`;
        }
      });
    }
    
    // Pitch controls
    const pitchSlider = document.getElementById('pitchSlider') as HTMLInputElement;
    if (pitchSlider) {
      pitchSlider.addEventListener('input', (event) => {
        if (this.mapEngine) {
          const pitch = parseFloat((event.target as HTMLInputElement).value);
          this.mapEngine.setPitch(pitch);
          
          // Update display
          const display = document.getElementById('pitchValue');
          if (display) display.textContent = `${pitch.toFixed(0)}°`;
        }
      });
    }
  }
  
  /**
   * Start performance monitoring
   */
  private startPerformanceMonitoring(): void {
    this.performanceInterval = window.setInterval(() => {
      if (this.mapEngine) {
        const metrics = this.mapEngine.getPerformanceMetrics();
        this.updatePerformanceDisplay(metrics);
        
        // Call callback if set
        if (this.metricsUpdateCallback) {
          this.metricsUpdateCallback(metrics);
        }
      }
    }, 1000); // Update every second
  }
  
  /**
   * Update performance display in UI
   */
  private updatePerformanceDisplay(metrics: any): void {
    // FPS display
    const fpsElement = document.getElementById('fpsValue');
    if (fpsElement) {
      fpsElement.textContent = `${metrics.fps} FPS`;
      
      // Color code based on performance
      if (metrics.fps >= 55) {
        fpsElement.className = 'metric-good';
      } else if (metrics.fps >= 30) {
        fpsElement.className = 'metric-ok';
      } else {
        fpsElement.className = 'metric-poor';
      }
    }
    
    // Frame time
    const frameTimeElement = document.getElementById('frameTimeValue');
    if (frameTimeElement) {
      frameTimeElement.textContent = `${metrics.frameTime.toFixed(1)}ms`;
    }
    
    // Tiles rendered
    const tilesElement = document.getElementById('tilesValue');
    if (tilesElement) {
      tilesElement.textContent = `${metrics.tilesRendered}`;
    }
    
    // Features rendered
    const featuresElement = document.getElementById('featuresValue');
    if (featuresElement) {
      featuresElement.textContent = `${metrics.featuresRendered}`;
    }
    
    // GPU memory
    const memoryElement = document.getElementById('memoryValue');
    if (memoryElement) {
      const memoryMB = (metrics.gpuMemoryUsage / 1024 / 1024).toFixed(1);
      memoryElement.textContent = `${memoryMB}MB`;
    }
    
    // Cache hit ratio
    const cacheElement = document.getElementById('cacheValue');
    if (cacheElement) {
      const cachePercent = (metrics.translationMetrics.cacheHitRatio * 100).toFixed(1);
      cacheElement.textContent = `${cachePercent}%`;
    }
    
    // Coordinates translated
    const coordsElement = document.getElementById('coordsValue');
    if (coordsElement) {
      coordsElement.textContent = `${metrics.translationMetrics.coordinatesTranslated}`;
    }
  }
  
  /**
   * Set a callback for performance metrics updates
   */
  setMetricsUpdateCallback(callback: (metrics: any) => void): void {
    this.metricsUpdateCallback = callback;
  }
  
  /**
   * Get current map state for debugging
   */
  getMapState(): any {
    return this.mapEngine?.getMapState() ?? null;
  }
  
  /**
   * Get current performance metrics
   */
  getCurrentMetrics(): any {
    return this.mapEngine?.getPerformanceMetrics() ?? null;
  }
  
  /**
   * Navigate to a specific location
   */
  async navigateTo(center: LngLat, zoom?: number, animated: boolean = true): Promise<void> {
    if (!this.mapEngine) return;
    
    if (animated) {
      await this.mapEngine.flyTo(center, zoom);
    } else {
      this.mapEngine.panTo(center);
      if (zoom !== undefined) {
        this.mapEngine.setZoom(zoom);
      }
    }
  }
  
  /**
   * Test map performance with stress test
   */
  async runPerformanceStressTest(): Promise<string> {
    if (!this.mapEngine) {
      return '❌ Map not initialized';
    }
    
    const results: string[] = [];
    const startTime = performance.now();
    
    // Test 1: Rapid zoom changes
    results.push('🔄 Testing rapid zoom changes...');
    for (let i = 0; i < 10; i++) {
      this.mapEngine.setZoom(5 + i);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Test 2: Rapid pan movements
    results.push('🔄 Testing rapid pan movements...');
    const baseCenter = { lng: -122.4194, lat: 37.7749 };
    for (let i = 0; i < 20; i++) {
      const offset = i * 0.01;
      this.mapEngine.panTo({
        lng: baseCenter.lng + offset,
        lat: baseCenter.lat + offset
      });
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    // Test 3: Bearing rotation
    results.push('🔄 Testing bearing rotation...');
    for (let bearing = 0; bearing < 360; bearing += 30) {
      this.mapEngine.setBearing(bearing);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Test 4: Pitch changes
    results.push('🔄 Testing pitch changes...');
    for (let pitch = 0; pitch <= 60; pitch += 10) {
      this.mapEngine.setPitch(pitch);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    const totalTime = performance.now() - startTime;
    const finalMetrics = this.mapEngine.getPerformanceMetrics();
    
    // Reset to default view
    this.mapEngine.flyTo(baseCenter, 10);
    this.mapEngine.setBearing(0);
    this.mapEngine.setPitch(0);
    
    results.push('');
    results.push('📊 Stress Test Results:');
    results.push(`- Total test time: ${totalTime.toFixed(0)}ms`);
    results.push(`- Average FPS during test: ${finalMetrics.fps}`);
    results.push(`- Tiles cached: ${finalMetrics.tileCacheSize}`);
    results.push(`- Features rendered: ${finalMetrics.featuresRendered}`);
    results.push(`- GPU memory usage: ${(finalMetrics.gpuMemoryUsage / 1024 / 1024).toFixed(1)}MB`);
    results.push(`- Translation cache hit ratio: ${(finalMetrics.translationMetrics.cacheHitRatio * 100).toFixed(1)}%`);
    results.push('');
    results.push('✅ Stress test completed successfully!');
    
    return results.join('\n');
  }
  
  /**
   * Check if the demo is ready
   */
  isReady(): boolean {
    return this.isInitialized && this.mapEngine !== null;
  }
  
  /**
   * Clean up resources
   */
  destroy(): void {
    if (this.performanceInterval) {
      clearInterval(this.performanceInterval);
      this.performanceInterval = null;
    }
    
    this.mapEngine?.destroy();
    this.mapEngine = null;
    this.device = null;
    this.canvas = null;
    this.isInitialized = false;
    
    console.log('🧹 Interactive Map Demo cleaned up');
  }
}