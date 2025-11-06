/**
 * Advanced Map Demo - Complete Mapping Application
 * Showcases the full WebGPU Map Engine with translation layer integration
 */

import { WebGPUMapEngine } from '../core/map/WebGPUMapEngine';
import type { LngLat, MapConfig, MapLayerDefinition } from '../types/core';

export class AdvancedMapDemo {
  private mapEngine: WebGPUMapEngine | null = null;
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private device: GPUDevice;
  private controlsContainer: HTMLElement;
  private infoPanel: HTMLElement;
  private isInitialized = false;

  constructor(device: GPUDevice, container: HTMLElement) {
    this.device = device;
    this.container = container;
    
    this.setupHTML();
    this.canvas = this.container.querySelector('#mapCanvas') as HTMLCanvasElement;
    this.controlsContainer = this.container.querySelector('.map-controls') as HTMLElement;
    this.infoPanel = this.container.querySelector('.map-info') as HTMLElement;
  }

  private setupHTML(): void {
    this.container.innerHTML = `
      <div class="map-demo">
        <div class="map-header">
          <h2>🗺️ WebGPU Mapping Application</h2>
          <div class="map-controls">
            <div class="control-group">
              <label>Location:</label>
              <select id="locationSelect">
                <option value="world">🌍 World View</option>
                <option value="usa">🇺🇸 United States</option>
                <option value="europe">🇪🇺 Europe</option>
                <option value="asia">🌏 Asia</option>
                <option value="africa">🌍 Africa</option>
                <option value="australia">🇦🇺 Australia</option>
                <option value="nyc">🏙️ New York City</option>
                <option value="london">🏛️ London</option>
                <option value="tokyo">🗼 Tokyo</option>
              </select>
            </div>
            
            <div class="control-group">
              <label>Zoom Level:</label>
              <input type="range" id="zoomSlider" min="1" max="15" value="3" step="0.5">
              <span id="zoomValue">3</span>
            </div>
            
            <div class="control-group">
              <label>Bearing:</label>
              <input type="range" id="bearingSlider" min="0" max="360" value="0" step="5">
              <span id="bearingValue">0°</span>
            </div>
            
            <div class="control-group">
              <label>Pitch:</label>
              <input type="range" id="pitchSlider" min="0" max="60" value="0" step="5">
              <span id="pitchValue">0°</span>
            </div>
          </div>
          
          <div class="map-actions">
            <button id="resetView">🎯 Reset View</button>
            <button id="togglePerformance">📊 Performance</button>
            <button id="saveView">💾 Save View</button>
            <button id="loadView">📂 Load View</button>
          </div>
        </div>
        
        <div class="map-container">
          <canvas id="mapCanvas" style="width: 100%; height: 600px; border: 2px solid #333; border-radius: 8px;"></canvas>
          
          <div class="map-overlay">
            <div class="map-info">
              <div class="info-item">
                <strong>Center:</strong> <span id="mapCenter">Loading...</span>
              </div>
              <div class="info-item">
                <strong>Zoom:</strong> <span id="mapZoom">Loading...</span>
              </div>
              <div class="info-item">
                <strong>Features:</strong> <span id="featureCount">Loading...</span>
              </div>
              <div class="info-item" id="performanceInfo" style="display: none;">
                <strong>FPS:</strong> <span id="mapFPS">--</span> | 
                <strong>Frame Time:</strong> <span id="frameTime">--</span>ms
              </div>
            </div>
            
            <div class="layer-controls">
              <h4>Map Layers</h4>
              <div class="layer-item">
                <input type="checkbox" id="oceanLayer" checked>
                <label for="oceanLayer">🌊 Ocean</label>
              </div>
              <div class="layer-item">
                <input type="checkbox" id="landLayer" checked>
                <label for="landLayer">🏞️ Landmasses</label>
              </div>
              <div class="layer-item">
                <input type="checkbox" id="citiesLayer" checked>
                <label for="citiesLayer">🏙️ Cities</label>
              </div>
              <div class="layer-item">
                <input type="checkbox" id="bordersLayer" checked>
                <label for="bordersLayer">🚧 Borders</label>
              </div>
            </div>
          </div>
        </div>
        
        <div class="map-footer">
          <div class="translation-layer-info">
            <h4>🔄 Translation Layer Status</h4>
            <div class="status-grid">
              <div class="status-item">
                <strong>Cache Hit Ratio:</strong> <span id="cacheHitRatio">--</span>%
              </div>
              <div class="status-item">
                <strong>Translations/Frame:</strong> <span id="translationsFrame">--</span>
              </div>
              <div class="status-item">
                <strong>GPU Memory:</strong> <span id="gpuMemory">--</span> MB
              </div>
              <div class="status-item">
                <strong>Tiles Rendered:</strong> <span id="tilesRendered">--</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    // Add CSS styles
    const style = document.createElement('style');
    style.textContent = `
      .map-demo {
        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        border-radius: 12px;
        padding: 20px;
        margin: 20px 0;
        color: white;
      }
      
      .map-header {
        margin-bottom: 20px;
      }
      
      .map-header h2 {
        margin: 0 0 15px 0;
        text-align: center;
        font-size: 28px;
        text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
      }
      
      .map-controls {
        display: flex;
        flex-wrap: wrap;
        gap: 20px;
        margin-bottom: 15px;
        justify-content: center;
      }
      
      .control-group {
        display: flex;
        flex-direction: column;
        align-items: center;
        background: rgba(255,255,255,0.1);
        padding: 10px;
        border-radius: 8px;
        backdrop-filter: blur(10px);
      }
      
      .control-group label {
        font-weight: bold;
        margin-bottom: 5px;
        font-size: 14px;
      }
      
      .control-group select,
      .control-group input[type="range"] {
        margin-bottom: 5px;
      }
      
      .control-group select {
        background: rgba(255,255,255,0.9);
        border: none;
        border-radius: 4px;
        padding: 5px 10px;
        color: #333;
      }
      
      .map-actions {
        display: flex;
        gap: 10px;
        justify-content: center;
        flex-wrap: wrap;
      }
      
      .map-actions button {
        background: linear-gradient(45deg, #FF6B6B, #4ECDC4);
        border: none;
        border-radius: 6px;
        padding: 10px 15px;
        color: white;
        font-weight: bold;
        cursor: pointer;
        transition: transform 0.2s;
      }
      
      .map-actions button:hover {
        transform: scale(1.05);
      }
      
      .map-container {
        position: relative;
        margin-bottom: 20px;
      }
      
      .map-overlay {
        position: absolute;
        top: 10px;
        right: 10px;
        background: rgba(0,0,0,0.8);
        border-radius: 8px;
        padding: 15px;
        min-width: 200px;
        backdrop-filter: blur(10px);
      }
      
      .map-info .info-item {
        margin-bottom: 8px;
        font-size: 14px;
      }
      
      .layer-controls {
        margin-top: 20px;
        border-top: 1px solid rgba(255,255,255,0.3);
        padding-top: 15px;
      }
      
      .layer-controls h4 {
        margin: 0 0 10px 0;
        font-size: 16px;
      }
      
      .layer-item {
        display: flex;
        align-items: center;
        margin-bottom: 8px;
      }
      
      .layer-item input {
        margin-right: 8px;
      }
      
      .map-footer {
        background: rgba(0,0,0,0.3);
        border-radius: 8px;
        padding: 15px;
      }
      
      .translation-layer-info h4 {
        margin: 0 0 15px 0;
        text-align: center;
      }
      
      .status-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 10px;
      }
      
      .status-item {
        background: rgba(255,255,255,0.1);
        padding: 8px;
        border-radius: 4px;
        text-align: center;
        font-size: 14px;
      }
    `;
    document.head.appendChild(style);
  }

  async initialize(): Promise<void> {
    try {
      console.log('🗺️ Initializing Advanced Map Demo...');
      
      // Setup canvas with proper dimensions
      const rect = this.canvas.getBoundingClientRect();
      this.canvas.width = rect.width * window.devicePixelRatio;
      this.canvas.height = rect.height * window.devicePixelRatio;
      
      // Configure map settings
      const mapConfig: Partial<MapConfig> = {
        center: { lng: 0, lat: 20 }, // World view
        zoom: 3,
        bearing: 0,
        pitch: 0,
        enableInteraction: true,
        enablePerformanceMonitoring: true
      };
      
      // Create map engine
      this.mapEngine = new WebGPUMapEngine(this.device, this.canvas, mapConfig);
      await this.mapEngine.initialize();
      
      // Setup event handlers
      this.setupEventHandlers();
      
      // Start info update loop
      this.startInfoUpdates();
      
      this.isInitialized = true;
      console.log('✅ Advanced Map Demo initialized successfully');
      
    } catch (error) {
      console.error('❌ Failed to initialize Advanced Map Demo:', error);
      throw error;
    }
  }

  private setupEventHandlers(): void {
    if (!this.mapEngine) return;

    // Location selector
    const locationSelect = this.container.querySelector('#locationSelect') as HTMLSelectElement;
    locationSelect.addEventListener('change', (e) => {
      const location = (e.target as HTMLSelectElement).value;
      this.flyToLocation(location);
    });

    // Zoom slider
    const zoomSlider = this.container.querySelector('#zoomSlider') as HTMLInputElement;
    const zoomValue = this.container.querySelector('#zoomValue') as HTMLSpanElement;
    zoomSlider.addEventListener('input', (e) => {
      const zoom = parseFloat((e.target as HTMLInputElement).value);
      this.mapEngine?.setZoom(zoom);
      zoomValue.textContent = zoom.toString();
    });

    // Bearing slider
    const bearingSlider = this.container.querySelector('#bearingSlider') as HTMLInputElement;
    const bearingValue = this.container.querySelector('#bearingValue') as HTMLSpanElement;
    bearingSlider.addEventListener('input', (e) => {
      const bearing = parseFloat((e.target as HTMLInputElement).value);
      this.mapEngine?.setBearing(bearing);
      bearingValue.textContent = `${bearing}°`;
    });

    // Pitch slider
    const pitchSlider = this.container.querySelector('#pitchSlider') as HTMLInputElement;
    const pitchValue = this.container.querySelector('#pitchValue') as HTMLSpanElement;
    pitchSlider.addEventListener('input', (e) => {
      const pitch = parseFloat((e.target as HTMLInputElement).value);
      this.mapEngine?.setPitch(pitch);
      pitchValue.textContent = `${pitch}°`;
    });

    // Action buttons
    this.container.querySelector('#resetView')?.addEventListener('click', () => {
      this.resetView();
    });

    this.container.querySelector('#togglePerformance')?.addEventListener('click', () => {
      this.togglePerformanceDisplay();
    });

    this.container.querySelector('#saveView')?.addEventListener('click', () => {
      this.saveCurrentView();
    });

    this.container.querySelector('#loadView')?.addEventListener('click', () => {
      this.loadSavedView();
    });

    // Layer toggles (future implementation)
    const layerCheckboxes = this.container.querySelectorAll('.layer-item input[type="checkbox"]');
    layerCheckboxes.forEach(checkbox => {
      checkbox.addEventListener('change', () => {
        this.updateLayerVisibility();
      });
    });
  }

  private flyToLocation(location: string): void {
    if (!this.mapEngine) return;

    const locations: { [key: string]: { center: LngLat; zoom: number } } = {
      world: { center: { lng: 0, lat: 20 }, zoom: 3 },
      usa: { center: { lng: -95, lat: 39 }, zoom: 4 },
      europe: { center: { lng: 10, lat: 54 }, zoom: 4 },
      asia: { center: { lng: 100, lat: 34 }, zoom: 3 },
      africa: { center: { lng: 20, lat: 0 }, zoom: 3 },
      australia: { center: { lng: 133, lat: -27 }, zoom: 5 },
      nyc: { center: { lng: -74.006, lat: 40.7128 }, zoom: 11 },
      london: { center: { lng: -0.1276, lat: 51.5074 }, zoom: 11 },
      tokyo: { center: { lng: 139.6917, lat: 35.6895 }, zoom: 11 }
    };

    const target = locations[location];
    if (target) {
      this.mapEngine.flyTo(target.center, target.zoom, 2000);
      
      // Update UI
      const zoomSlider = this.container.querySelector('#zoomSlider') as HTMLInputElement;
      const zoomValue = this.container.querySelector('#zoomValue') as HTMLSpanElement;
      zoomSlider.value = target.zoom.toString();
      zoomValue.textContent = target.zoom.toString();
    }
  }

  private resetView(): void {
    if (!this.mapEngine) return;
    
    this.mapEngine.flyTo({ lng: 0, lat: 20 }, 3, 1500);
    this.mapEngine.setBearing(0);
    this.mapEngine.setPitch(0);
    
    // Reset UI controls
    (this.container.querySelector('#zoomSlider') as HTMLInputElement).value = '3';
    (this.container.querySelector('#zoomValue') as HTMLSpanElement).textContent = '3';
    (this.container.querySelector('#bearingSlider') as HTMLInputElement).value = '0';
    (this.container.querySelector('#bearingValue') as HTMLSpanElement).textContent = '0°';
    (this.container.querySelector('#pitchSlider') as HTMLInputElement).value = '0';
    (this.container.querySelector('#pitchValue') as HTMLSpanElement).textContent = '0°';
    (this.container.querySelector('#locationSelect') as HTMLSelectElement).value = 'world';
  }

  private togglePerformanceDisplay(): void {
    const perfInfo = this.container.querySelector('#performanceInfo') as HTMLElement;
    const isVisible = perfInfo.style.display !== 'none';
    perfInfo.style.display = isVisible ? 'none' : 'block';
    
    const button = this.container.querySelector('#togglePerformance') as HTMLButtonElement;
    button.textContent = isVisible ? '📊 Show Performance' : '📊 Hide Performance';
  }

  private saveCurrentView(): void {
    if (!this.mapEngine) return;
    
    const state = this.mapEngine.getMapState();
    localStorage.setItem('savedMapView', JSON.stringify({
      center: state.transform.center,
      zoom: state.transform.zoom,
      bearing: state.transform.bearing,
      pitch: state.transform.pitch
    }));
    
    alert('✅ Current view saved!');
  }

  private loadSavedView(): void {
    if (!this.mapEngine) return;
    
    const saved = localStorage.getItem('savedMapView');
    if (saved) {
      const view = JSON.parse(saved);
      this.mapEngine.flyTo(view.center, view.zoom, 2000);
      this.mapEngine.setBearing(view.bearing);
      this.mapEngine.setPitch(view.pitch);
      alert('✅ Saved view loaded!');
    } else {
      alert('❌ No saved view found!');
    }
  }

  private updateLayerVisibility(): void {
    // Future implementation for layer management
    console.log('🎛️ Layer visibility updated');
  }

  private startInfoUpdates(): void {
    setInterval(() => {
      if (!this.mapEngine || !this.isInitialized) return;
      
      const state = this.mapEngine.getMapState();
      const metrics = this.mapEngine.getPerformanceMetrics();
      
      // Update basic info
      const centerEl = this.container.querySelector('#mapCenter');
      if (centerEl) {
        centerEl.textContent = `${state.transform.center.lng.toFixed(3)}, ${state.transform.center.lat.toFixed(3)}`;
      }
      
      const zoomEl = this.container.querySelector('#mapZoom');
      if (zoomEl) {
        zoomEl.textContent = state.transform.zoom.toFixed(1);
      }
      
      const featureEl = this.container.querySelector('#featureCount');
      if (featureEl) {
        featureEl.textContent = metrics.featuresRendered.toString();
      }
      
      // Update performance info
      const fpsEl = this.container.querySelector('#mapFPS');
      if (fpsEl) {
        fpsEl.textContent = metrics.fps.toString();
      }
      
      const frameTimeEl = this.container.querySelector('#frameTime');
      if (frameTimeEl) {
        frameTimeEl.textContent = metrics.frameTime.toFixed(1);
      }
      
      // Update translation layer info
      const cacheHitEl = this.container.querySelector('#cacheHitRatio');
      if (cacheHitEl) {
        cacheHitEl.textContent = (metrics.translationMetrics.cacheHitRatio * 100).toFixed(1);
      }
      
      const translationsEl = this.container.querySelector('#translationsFrame');
      if (translationsEl) {
        translationsEl.textContent = metrics.translationMetrics.coordinatesTranslated.toString();
      }
      
      const gpuMemoryEl = this.container.querySelector('#gpuMemory');
      if (gpuMemoryEl) {
        gpuMemoryEl.textContent = (metrics.gpuMemoryUsage / 1024 / 1024).toFixed(1);
      }
      
      const tilesEl = this.container.querySelector('#tilesRendered');
      if (tilesEl) {
        tilesEl.textContent = metrics.tilesRendered.toString();
      }
      
    }, 100); // Update 10 times per second
  }

  destroy(): void {
    if (this.mapEngine) {
      this.mapEngine.destroy();
      this.mapEngine = null;
    }
    this.isInitialized = false;
    console.log('🧹 Advanced Map Demo destroyed');
  }

  getStatus(): string {
    return this.isInitialized ? 'Ready - Interactive world map with WebGPU rendering' : 'Not initialized';
  }
}