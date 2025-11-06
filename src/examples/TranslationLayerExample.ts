// Example usage of the WebGPU Translation Layer
// This shows how to integrate with your existing hidden buffer system

import { WebGPUTranslationLayer } from '../core/translation/WebGPUTranslationLayer';
import { HiddenBufferIntegration, RenderStatistics } from '../core/translation/HiddenBufferIntegration';
import type {
  LngLat,
  Point,
  Feature,
  PolygonFeature,
  PointFeature,
  HiddenBufferConfig,
  PickingResult,
  WebGPUContext,
  MapError,
  MapErrorType
} from '../types/core';

export interface MapRendererConfig {
  canvas: HTMLCanvasElement;
  powerPreference?: 'low-power' | 'high-performance';
  hiddenBufferConfig?: Partial<HiddenBufferConfig>;
}

export class MapRenderer {
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private readonly canvas: HTMLCanvasElement;
  private integration!: HiddenBufferIntegration;
  private isInitialized = false;
  private readonly config: MapRendererConfig;

  constructor(config: MapRendererConfig) {
    this.canvas = config.canvas;
    this.config = config;
  }

  /**
   * Initialize WebGPU and translation layer
   */
  public async initialize(): Promise<void> {
    if (!navigator.gpu) {
      throw this.createMapError('webgpu-not-supported', 'WebGPU not supported in this browser');
    }

    try {
      const adapter = await navigator.gpu.requestAdapter({
        powerPreference: this.config.powerPreference ?? 'high-performance'
      });
      
      if (!adapter) {
        throw this.createMapError('device-creation-failed', 'No WebGPU adapter found');
      }

      this.device = await adapter.requestDevice({
        requiredFeatures: [],
        requiredLimits: {}
      });      // Setup canvas context
      this.context = this.canvas.getContext('webgpu')!;
      if (!this.context) {
        throw this.createMapError('device-creation-failed', 'Failed to get WebGPU context');
      }

      const presentationFormat: GPUTextureFormat = 'bgra8unorm'; // Default format
      this.context.configure({
        device: this.device,
        format: presentationFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
        alphaMode: 'premultiplied'
      });
      
      // Initialize integration layer
      const hiddenBufferConfig: HiddenBufferConfig = {
        width: this.canvas.width,
        height: this.canvas.height,
        featureIdFormat: 'rgba32uint',
        depthFormat: 'depth24plus',
        enableMultiTarget: true,
        enableDepthTest: true,
        ...this.config.hiddenBufferConfig
      };

      this.integration = new HiddenBufferIntegration(
        this.device,
        this.canvas,
        hiddenBufferConfig
      );

      this.isInitialized = true;
    } catch (error) {
      const mapError = error instanceof Error 
        ? this.createMapError('device-creation-failed', error.message, { originalError: error })
        : this.createMapError('device-creation-failed', 'Unknown error during initialization');
      throw mapError;
    }
  }

  /**
   * Render geographic features using translation layer
   */
  public async renderGeoFeatures<T = Record<string, unknown>>(
    features: readonly Feature<T>[]
  ): Promise<RenderStatistics> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      // Features are automatically translated from geographic to clip coordinates
      return await this.integration.renderFeatures(features);
    } catch (error) {
      throw this.createMapError('feature-rendering-failed', 
        `Failed to render features: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Pick features at screen coordinates
   */
  public async pickAt<T = Record<string, unknown>>(
    x: number, 
    y: number
  ): Promise<PickingResult<T>[]> {
    if (!this.isInitialized) return [];

    try {
      const screenPoint: Point = { x, y };
      return await this.integration.pickFeatures<T>(screenPoint);
    } catch (error) {
      throw this.createMapError('picking-failed',
        `Failed to pick features: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Update map view (automatically handles coordinate translation)
   */
  public setView(center: LngLat, zoom: number, bearing: number = 0): void {
    if (!this.isInitialized) return;

    this.integration.updateTransform({
      center,
      zoom,
      bearing
    });
  }

  /**
   * Get performance statistics
   */
  public getStats(): ReturnType<HiddenBufferIntegration['getStats']> | null {
    if (!this.isInitialized) return null;
    return this.integration.getStats();
  }

  /**
   * Clean up resources
   */
  public dispose(): void {
    if (this.integration) {
      this.integration.dispose();
    }
  }

  private createMapError(type: MapErrorType, message: string, context?: Record<string, unknown>): MapError {
    const error = new Error(message) as MapError;
    error.type = type;
    error.context = context;
    return error;
  }
}

// === USAGE EXAMPLE ===

interface ExampleFeatureProperties {
  name: string;
  color: string;
  population?: number;
}

export async function exampleUsage(): Promise<void> {
  const canvas = document.getElementById('map-canvas') as HTMLCanvasElement;
  
  if (!canvas) {
    console.error('Canvas element not found');
    return;
  }

  const renderer = new MapRenderer({
    canvas,
    powerPreference: 'high-performance',
    hiddenBufferConfig: {
      enableMultiTarget: true,
      enableDepthTest: true
    }
  });

  try {
    // Initialize the renderer
    await renderer.initialize();
    console.log('Renderer initialized successfully');

    // Sample geographic features with typed properties
    const features: PolygonFeature<ExampleFeatureProperties>[] = [
      {
        id: 'feature1',
        type: 'polygon',
        geometry: [
          [
            { lng: -122.4194, lat: 37.7749 }, // San Francisco
            { lng: -122.4094, lat: 37.7749 },
            { lng: -122.4094, lat: 37.7849 },
            { lng: -122.4194, lat: 37.7849 }
          ]
        ],
        properties: { 
          name: 'San Francisco Area', 
          color: 'blue',
          population: 883305
        }
      },
      {
        id: 'feature2',
        type: 'polygon',
        geometry: [
          [
            { lng: -74.0060, lat: 40.7128 }, // New York
            { lng: -74.0000, lat: 40.7128 },
            { lng: -74.0000, lat: 40.7200 },
            { lng: -74.0060, lat: 40.7200 }
          ]
        ],
        properties: { 
          name: 'New York Area', 
          color: 'red',
          population: 8336817
        }
      }
    ];

    // Set initial view
    renderer.setView(
      { lng: -98.5795, lat: 39.8283 }, // Center of USA
      4 // Zoom level
    );

    // Render features (coordinates automatically translated)
    const renderStats = await renderer.renderGeoFeatures(features);
    console.log('Render statistics:', renderStats);

    // Set up click handling for feature picking with type safety
    canvas.addEventListener('click', async (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      const pickedFeatures = await renderer.pickAt<ExampleFeatureProperties>(x, y);
      
      if (pickedFeatures.length > 0) {
        console.log('Picked features:', pickedFeatures);
        
        // Type-safe access to feature properties
        pickedFeatures.forEach(result => {
          console.log(`Feature: ${result.feature.properties.name}`);
          console.log(`Color: ${result.feature.properties.color}`);
          if (result.feature.properties.population) {
            console.log(`Population: ${result.feature.properties.population.toLocaleString()}`);
          }
        });
      }
    });

    // Monitor performance with proper typing
    setInterval(() => {
      const stats = renderer.getStats();
      if (stats) {
        console.log('Renderer stats:', {
          cacheHitRatio: `${(stats.cacheStats.hitRatio * 100).toFixed(1)}%`,
          featureCount: stats.featureCount,
          lastRenderTime: stats.lastRenderStats?.renderTime
        });
      }
    }, 5000);

  } catch (error) {
    if (error instanceof Error && 'type' in error) {
      const mapError = error as MapError;
      console.error(`Map error (${mapError.type}):`, mapError.message);
      if (mapError.context) {
        console.error('Error context:', mapError.context);
      }
    } else {
      console.error('Failed to initialize map renderer:', error);
    }
    
    // Handle fallback or show error message
    showErrorMessage('Failed to initialize WebGPU map renderer. Please check browser compatibility.');
  }
}

// === INTEGRATION WITH YOUR EXISTING SYSTEM ===

export interface LegacyCoordinate {
  x: number;
  y: number;
  z?: number;
}

export interface LegacyFeature {
  id: string;
  coordinates: LegacyCoordinate[];
  properties: Record<string, unknown>;
  type: string;
}

export class YourExistingSystemIntegration {
  private readonly renderer: MapRenderer;
  private readonly translationLayer: WebGPUTranslationLayer;

  constructor(canvas: HTMLCanvasElement, device: GPUDevice) {
    this.renderer = new MapRenderer({ canvas });
    
    // Direct access to translation layer for custom operations
    this.translationLayer = new WebGPUTranslationLayer(device, canvas, {
      center: { lng: 0, lat: 0 },
      zoom: 1
    });
  }

  /**
   * Convert your existing coordinate system to standard geographic coordinates
   */
  public async migrateExistingFeatures(existingFeatures: LegacyFeature[]): Promise<Feature[]> {
    const standardFeatures: Feature[] = [];

    for (const existing of existingFeatures) {
      // Convert your custom coordinates to LngLat
      const geometry = existing.coordinates.map(coord => {
        return this.yourCoordToLngLat(coord);
      });

      const feature: Feature = {
        id: existing.id,
        type: existing.type as any, // Cast to proper type
        geometry: geometry as any, // Will be properly typed based on feature type
        properties: existing.properties
      };

      standardFeatures.push(feature);
    }

    return standardFeatures;
  }

  /**
   * Your custom coordinate conversion method
   */
  private yourCoordToLngLat(coord: LegacyCoordinate): LngLat {
    // Implement your specific coordinate conversion here
    // This is where you'd convert from your current system to geographic coordinates
    
    // Example conversion (replace with your actual logic):
    return {
      lng: coord.x * 360 - 180, // Convert from [0,1] to [-180,180]
      lat: coord.y * 180 - 90   // Convert from [0,1] to [-90,90]
    };
  }

  /**
   * Batch convert coordinates using GPU acceleration
   */
  public async batchConvertCoordinates(coordinates: LngLat[]): Promise<Point[]> {
    const result = await this.translationLayer.batchLngLatToClip(coordinates);
    return result.coordinates;
  }

  /**
   * Get direct access to translation layer for advanced operations
   */
  public getTranslationLayer(): WebGPUTranslationLayer {
    return this.translationLayer;
  }

  /**
   * Get the map renderer
   */
  public getRenderer(): MapRenderer {
    return this.renderer;
  }
}

// === UTILITY FUNCTIONS ===

function showErrorMessage(message: string): void {
  // Create or update error display
  let errorDiv = document.getElementById('map-error');
  if (!errorDiv) {
    errorDiv = document.createElement('div');
    errorDiv.id = 'map-error';
    errorDiv.style.cssText = `
      position: absolute;
      top: 20px;
      left: 20px;
      background: #ff4444;
      color: white;
      padding: 16px;
      border-radius: 8px;
      font-family: Arial, sans-serif;
      max-width: 400px;
      z-index: 1000;
    `;
    document.body.appendChild(errorDiv);
  }
  errorDiv.textContent = message;
}

/**
 * Check WebGPU support and provide fallback information
 */
export async function checkWebGPUSupport(): Promise<{
  supported: boolean;
  adapter?: GPUAdapter;
  device?: GPUDevice;
  error?: string;
}> {
  if (!navigator.gpu) {
    return {
      supported: false,
      error: 'WebGPU not available in this browser'
    };
  }

  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return {
        supported: false,
        error: 'No WebGPU adapter available'
      };
    }

    const device = await adapter.requestDevice();
    return {
      supported: true,
      adapter,
      device
    };
  } catch (error) {
    return {
      supported: false,
      error: error instanceof Error ? error.message : 'Unknown WebGPU error'
    };
  }
}

// Export for easy integration
export { WebGPUTranslationLayer, HiddenBufferIntegration };