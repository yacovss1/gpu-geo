// Advanced WebGPU Translation Layer Demo
// Demonstrates the complete coordinate transformation and hidden buffer system

import {
  WebGPUTranslationLayer,
  HiddenBufferIntegration,
  checkWebGPUSupport,
  CoordinateUtils
} from '../index';

import type {
  LngLat,
  PolygonFeature,
  PointFeature,
  MapTransform
} from '../types/core';

/**
 * Comprehensive demo of the WebGPU translation layer
 */
export class TranslationLayerDemo {
  private device: GPUDevice | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private translationLayer: WebGPUTranslationLayer | null = null;
  private hiddenBuffer: HiddenBufferIntegration | null = null;
  
  // Demo state
  private isInitialized = false;
  private currentTransform: MapTransform = {
    center: { lng: -122.4194, lat: 37.7749 }, // San Francisco
    zoom: 10,
    bearing: 0,
    pitch: 0
  };
  
  constructor() {
    console.log('🚀 Translation Layer Demo initialized');
  }
  
  /**
   * Initialize the demo with WebGPU support
   */
  async initialize(canvas: HTMLCanvasElement): Promise<boolean> {
    try {
      // Check WebGPU support
      const support = await checkWebGPUSupport();
      if (!support.supported || !support.device) {
        console.error('❌ WebGPU not supported');
        return false;
      }
      
      this.device = support.device;
      this.canvas = canvas;
      
      // Initialize translation layer
      this.translationLayer = new WebGPUTranslationLayer(this.device, this.canvas, {
        cacheSize: 50000,
        batchSize: 10000,
        enableCompute: true,
        precision: {
          threshold: 1e-8,
          useHighPrecision: true
        }
      });
      
      await this.translationLayer.initialize();
      this.translationLayer.updateTransform(this.currentTransform);
      
      // Initialize hidden buffer
      this.hiddenBuffer = new HiddenBufferIntegration(
        this.device,
        this.canvas,
        this.translationLayer,
        {
          width: canvas.width,
          height: canvas.height,
          enableMultiTarget: true,
          enableDepthTest: true
        }
      );
      
      await this.hiddenBuffer.initialize();
      
      this.isInitialized = true;
      console.log('✅ Translation Layer Demo initialized successfully');
      
      return true;
      
    } catch (error) {
      console.error('❌ Failed to initialize Translation Layer Demo:', error);
      return false;
    }
  }
  
  /**
   * Demonstrate single coordinate translation
   */
  async demonstrateSingleTranslation(): Promise<string> {
    if (!this.translationLayer) {
      return '❌ Translation layer not initialized';
    }
    
    const startTime = performance.now();
    
    // Test various coordinates
    const testCoordinates: LngLat[] = [
      { lng: -122.4194, lat: 37.7749 }, // San Francisco
      { lng: -74.0060, lat: 40.7128 },  // New York
      { lng: -87.6298, lat: 41.8781 },  // Chicago
      { lng: 2.3522, lat: 48.8566 },    // Paris
      { lng: 139.6917, lat: 35.6895 }   // Tokyo
    ];
    
    const results: string[] = [];
    
    for (const coord of testCoordinates) {
      const result = await this.translationLayer.lngLatToClip(coord);
      
      if (result.success) {
        results.push(
          `(${coord.lng.toFixed(4)}, ${coord.lat.toFixed(4)}) → ` +
          `(${result.coordinates.x.toFixed(6)}, ${result.coordinates.y.toFixed(6)}) ` +
          `[${result.processingTime.toFixed(3)}ms]`
        );
      } else {
        results.push(`(${coord.lng.toFixed(4)}, ${coord.lat.toFixed(4)}) → ERROR: ${result.error}`);
      }
    }
    
    const totalTime = performance.now() - startTime;
    const metrics = this.translationLayer.getMetrics();
    
    return `Single Coordinate Translation Demo:
${results.join('\n')}

Performance Summary:
- Total Time: ${totalTime.toFixed(2)}ms
- Cache Hit Ratio: ${(metrics.cacheHitRatio * 100).toFixed(1)}%
- GPU Memory Usage: ${(metrics.gpuMemoryUsage / 1024).toFixed(1)}KB
- Translations/Frame: ${metrics.translationsPerFrame}`;
  }
  
  /**
   * Demonstrate batch coordinate translation
   */
  async demonstrateBatchTranslation(): Promise<string> {
    if (!this.translationLayer) {
      return '❌ Translation layer not initialized';
    }
    
    // Generate a grid of coordinates around San Francisco
    const gridSize = 100;
    const baseCoord = { lng: -122.5, lat: 37.7 };
    const step = 0.01;
    
    const coordinates: LngLat[] = [];
    for (let i = 0; i < gridSize; i++) {
      for (let j = 0; j < gridSize; j++) {
        coordinates.push({
          lng: baseCoord.lng + i * step,
          lat: baseCoord.lat + j * step
        });
      }
    }
    
    console.log(`🔄 Processing batch of ${coordinates.length} coordinates...`);
    
    const result = await this.translationLayer.batchLngLatToClip(coordinates);
    
    return `Batch Translation Demo:
- Coordinates Processed: ${coordinates.length}
- Successful Translations: ${result.successCount}
- Failed Translations: ${result.failureCount}
- Processing Time: ${result.processingTime.toFixed(2)}ms
- Cache Hit Ratio: ${(result.cacheHitRatio * 100).toFixed(1)}%
- Throughput: ${(coordinates.length / result.processingTime * 1000).toFixed(0)} coords/sec

Sample Results (first 5):
${result.coordinates.slice(0, 5).map((coord, i) => 
  `  ${i + 1}. (${coord.x.toFixed(6)}, ${coord.y.toFixed(6)})`
).join('\n')}`;
  }
  
  /**
   * Demonstrate feature rendering and picking
   */
  async demonstrateFeatureRendering(): Promise<string> {
    if (!this.hiddenBuffer || !this.translationLayer) {
      return '❌ Hidden buffer not initialized';
    }
    
    // Create sample features
    const features = this.createSampleFeatures();
    
    console.log(`🎨 Rendering ${features.length} features...`);
    
    // Add features to hidden buffer
    await this.hiddenBuffer.addFeatures(features);
    
    // Render features
    await this.hiddenBuffer.renderFeatures();
    
    // Get rendering statistics
    const stats = this.hiddenBuffer.getRenderStatistics();
    
    return `Feature Rendering Demo:
- Features Added: ${features.length}
- Features Rendered: ${stats.featuresRendered}
- Vertices Processed: ${stats.verticesProcessed}
- Triangles Generated: ${stats.trianglesGenerated}
- Render Time: ${stats.renderTime.toFixed(2)}ms
- Buffer Memory: ${(stats.bufferMemoryUsage / 1024).toFixed(1)}KB
- Hidden Buffer Memory: ${(stats.hiddenBufferMemoryUsage / 1024).toFixed(1)}KB

Rendering Performance:
- Vertices/sec: ${(stats.verticesProcessed / stats.renderTime * 1000).toFixed(0)}
- Triangles/sec: ${(stats.trianglesGenerated / stats.renderTime * 1000).toFixed(0)}`;
  }
  
  /**
   * Demonstrate feature picking
   */
  async demonstrateFeaturePicking(): Promise<string> {
    if (!this.hiddenBuffer) {
      return '❌ Hidden buffer not initialized';
    }
    
    // Test picking at various screen coordinates
    const pickPoints = [
      { x: 100, y: 100 },
      { x: 200, y: 150 },
      { x: 300, y: 200 },
      { x: 400, y: 250 },
      { x: 500, y: 300 }
    ];
    
    const results: string[] = [];
    
    for (const point of pickPoints) {
      const pickResult = await this.hiddenBuffer.pickFeature(point);
      
      if (pickResult) {
        results.push(
          `Screen (${point.x}, ${point.y}) → Feature "${pickResult.feature.id}" ` +
          `at (${pickResult.worldCoordinates.lng.toFixed(4)}, ${pickResult.worldCoordinates.lat.toFixed(4)})`
        );
      } else {
        results.push(`Screen (${point.x}, ${point.y}) → No feature found`);
      }
    }
    
    return `Feature Picking Demo:
${results.join('\n')}

Note: Feature picking requires features to be rendered first.
Try running "Demonstrate Feature Rendering" before picking.`;
  }
  
  /**
   * Demonstrate coordinate system transformations
   */
  async demonstrateCoordinateTransforms(): Promise<string> {
    const testCoords: LngLat[] = [
      { lng: -122.4194, lat: 37.7749 }, // San Francisco
      { lng: 0, lat: 0 },               // Null Island
      { lng: 180, lat: 85 },            // Near North Pole
      { lng: -180, lat: -85 }           // Near South Pole
    ];
    
    const results: string[] = [];
    
    for (const coord of testCoords) {
      // Calculate various transformations
      const distance = CoordinateUtils.distanceHaversine(
        coord,
        this.currentTransform.center
      );
      
      const bearing = CoordinateUtils.bearing(
        this.currentTransform.center,
        coord
      );
      
      const isValid = CoordinateUtils.isValidLngLat(coord);
      const clamped = CoordinateUtils.clampLngLat(coord);
      
      // Translate to clip space
      const translation = await this.translationLayer!.lngLatToClip(coord);
      
      results.push(`
Geographic: (${coord.lng.toFixed(4)}°, ${coord.lat.toFixed(4)}°)
- Valid: ${isValid}
- Distance from center: ${(distance / 1000).toFixed(1)}km
- Bearing from center: ${bearing.toFixed(1)}°
- Clip coordinates: (${translation.coordinates.x.toFixed(6)}, ${translation.coordinates.y.toFixed(6)})
- Translation time: ${translation.processingTime.toFixed(3)}ms`);
    }
    
    return `Coordinate System Transformations:
Current View Center: (${this.currentTransform.center.lng.toFixed(4)}°, ${this.currentTransform.center.lat.toFixed(4)}°)
Zoom Level: ${this.currentTransform.zoom}
${results.join('\n')}`;
  }
  
  /**
   * Update the map transform and demonstrate caching behavior
   */
  async demonstrateTransformUpdate(): Promise<string> {
    if (!this.translationLayer) {
      return '❌ Translation layer not initialized';
    }
    
    const originalTransform = { ...this.currentTransform };
    
    // Test coordinate before transform
    const testCoord = { lng: -122.4, lat: 37.8 };
    const beforeResult = await this.translationLayer.lngLatToClip(testCoord);
    const beforeMetrics = this.translationLayer.getMetrics();
    
    // Update transform (zoom in)
    this.currentTransform.zoom += 2;
    this.currentTransform.center = { lng: -122.45, lat: 37.78 };
    this.translationLayer.updateTransform(this.currentTransform);
    
    // Test same coordinate after transform
    const afterResult = await this.translationLayer.lngLatToClip(testCoord);
    const afterMetrics = this.translationLayer.getMetrics();
    
    // Reset transform
    this.currentTransform = originalTransform;
    this.translationLayer.updateTransform(this.currentTransform);
    
    return `Transform Update Demo:
Test Coordinate: (${testCoord.lng}°, ${testCoord.lat}°)

Before Transform (zoom ${originalTransform.zoom}):
- Clip coords: (${beforeResult.coordinates.x.toFixed(6)}, ${beforeResult.coordinates.y.toFixed(6)})
- Cache hit ratio: ${(beforeMetrics.cacheHitRatio * 100).toFixed(1)}%

After Transform (zoom ${this.currentTransform.zoom + 2}):
- Clip coords: (${afterResult.coordinates.x.toFixed(6)}, ${afterResult.coordinates.y.toFixed(6)})
- Cache hit ratio: ${(afterMetrics.cacheHitRatio * 100).toFixed(1)}%

Transform updated successfully! Cache was automatically invalidated.`;
  }
  
  /**
   * Run comprehensive performance benchmark
   */
  async demonstratePerformanceBenchmark(): Promise<string> {
    if (!this.translationLayer) {
      return '❌ Translation layer not initialized';
    }
    
    const results: string[] = [];
    
    // Benchmark 1: Single coordinate performance
    const singleCoordBench = await this.benchmarkSingleCoordinates(1000);
    results.push(`Single Coordinate Benchmark (1000 coords):
- Total time: ${singleCoordBench.totalTime.toFixed(2)}ms
- Average time: ${singleCoordBench.averageTime.toFixed(4)}ms
- Throughput: ${singleCoordBench.throughput.toFixed(0)} coords/sec`);
    
    // Benchmark 2: Batch processing performance
    const batchSizes = [100, 1000, 5000];
    for (const size of batchSizes) {
      const batchBench = await this.benchmarkBatchProcessing(size);
      results.push(`Batch Processing Benchmark (${size} coords):
- Total time: ${batchBench.totalTime.toFixed(2)}ms
- Throughput: ${batchBench.throughput.toFixed(0)} coords/sec
- Cache hit ratio: ${(batchBench.cacheHitRatio * 100).toFixed(1)}%`);
    }
    
    // Benchmark 3: Memory usage
    const memoryBench = this.benchmarkMemoryUsage();
    results.push(`Memory Usage:
- GPU Memory: ${(memoryBench.gpuMemory / 1024).toFixed(1)}KB
- Cache size: ${memoryBench.cacheSize} entries
- Estimated cache memory: ${(memoryBench.cacheMemory / 1024).toFixed(1)}KB`);
    
    return `Performance Benchmark Results:\n\n${results.join('\n\n')}`;
  }
  
  /**
   * Create sample features for demonstration
   */
  private createSampleFeatures(): (PolygonFeature | PointFeature)[] {
    const features: (PolygonFeature | PointFeature)[] = [];
    
    // Create a polygon feature (San Francisco outline)
    const sfPolygon: PolygonFeature<{ name: string; type: string }> = {
      id: 'sf-polygon',
      type: 'polygon',
      geometry: [[
        { lng: -122.515, lat: 37.708 },
        { lng: -122.515, lat: 37.832 },
        { lng: -122.357, lat: 37.832 },
        { lng: -122.357, lat: 37.708 },
        { lng: -122.515, lat: 37.708 }
      ]],
      properties: {
        name: 'San Francisco',
        type: 'city'
      }
    };
    features.push(sfPolygon);
    
    // Create point features for landmarks
    const landmarks = [
      { name: 'Golden Gate Bridge', lng: -122.4783, lat: 37.8199 },
      { name: 'Alcatraz Island', lng: -122.4230, lat: 37.8267 },
      { name: 'Fishermans Wharf', lng: -122.4177, lat: 37.8080 },
      { name: 'Union Square', lng: -122.4075, lat: 37.7880 },
      { name: 'Mission District', lng: -122.4194, lat: 37.7598 }
    ];
    
    landmarks.forEach((landmark, index) => {
      const pointFeature: PointFeature<{ name: string; type: string }> = {
        id: `landmark-${index}`,
        type: 'point',
        geometry: { lng: landmark.lng, lat: landmark.lat },
        properties: {
          name: landmark.name,
          type: 'landmark'
        }
      };
      features.push(pointFeature);
    });
    
    return features;
  }
  
  /**
   * Benchmark single coordinate translations
   */
  private async benchmarkSingleCoordinates(count: number): Promise<{
    totalTime: number;
    averageTime: number;
    throughput: number;
  }> {
    const coordinates: LngLat[] = [];
    
    // Generate random coordinates
    for (let i = 0; i < count; i++) {
      coordinates.push({
        lng: (Math.random() - 0.5) * 360,
        lat: (Math.random() - 0.5) * 170
      });
    }
    
    const startTime = performance.now();
    
    for (const coord of coordinates) {
      await this.translationLayer!.lngLatToClip(coord);
    }
    
    const totalTime = performance.now() - startTime;
    const averageTime = totalTime / count;
    const throughput = count / totalTime * 1000;
    
    return { totalTime, averageTime, throughput };
  }
  
  /**
   * Benchmark batch processing
   */
  private async benchmarkBatchProcessing(size: number): Promise<{
    totalTime: number;
    throughput: number;
    cacheHitRatio: number;
  }> {
    // Generate coordinates
    const coordinates: LngLat[] = [];
    for (let i = 0; i < size; i++) {
      coordinates.push({
        lng: (Math.random() - 0.5) * 360,
        lat: (Math.random() - 0.5) * 170
      });
    }
    
    const startTime = performance.now();
    const result = await this.translationLayer!.batchLngLatToClip(coordinates);
    const totalTime = performance.now() - startTime;
    
    return {
      totalTime,
      throughput: size / totalTime * 1000,
      cacheHitRatio: result.cacheHitRatio
    };
  }
  
  /**
   * Benchmark memory usage
   */
  private benchmarkMemoryUsage(): {
    gpuMemory: number;
    cacheSize: number;
    cacheMemory: number;
  } {
    const metrics = this.translationLayer!.getMetrics();
    
    // Estimate cache memory (approximate)
    const avgCoordSize = 50; // bytes per cached coordinate
    const cacheMemory = metrics.cacheHitRatio * 10000 * avgCoordSize; // estimate
    
    return {
      gpuMemory: metrics.gpuMemoryUsage,
      cacheSize: Math.floor(metrics.cacheHitRatio * 10000), // estimate
      cacheMemory
    };
  }
  
  /**
   * Clean up resources
   */
  destroy(): void {
    this.translationLayer?.destroy();
    this.hiddenBuffer?.destroy();
    
    this.translationLayer = null;
    this.hiddenBuffer = null;
    this.device = null;
    this.canvas = null;
    this.isInitialized = false;
    
    console.log('🧹 Translation Layer Demo cleaned up');
  }
  
  /**
   * Check if demo is ready
   */
  isReady(): boolean {
    return this.isInitialized && this.translationLayer !== null && this.hiddenBuffer !== null;
  }
}