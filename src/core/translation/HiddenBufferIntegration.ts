// Integration wrapper for your existing hidden buffer system
// This shows how to integrate the translation layer with your WebGPU rendering

import { WebGPUTranslationLayer, BatchTranslationResult } from './WebGPUTranslationLayer';
import type {
  LngLat,
  Point,
  ClipCoordinates,
  Feature,
  PolygonFeature,
  PointFeature,
  LineStringFeature,
  HiddenBufferConfig,
  PickingResult,
  GeometryType,
  GPUBufferConfig,
  GPUTextureConfig,
  RenderPipelineConfig
} from '../../types/core';

export interface TranslatedFeature<T = Record<string, unknown>, G extends GeometryType = GeometryType> {
  id: string;
  geometry: ClipCoordinates[];
  properties: T;
  type: G;
  originalGeometry: Feature<T, G>['geometry'];
  coordinateSpace: 'clip' | 'geographic';
}

export interface RenderStatistics {
  featuresRendered: number;
  translationTime: number;
  renderTime: number;
  cacheHitRatio: number;
  gpuMemoryUsed: number;
}

export interface ColorRGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export class HiddenBufferIntegration {
  private readonly device: GPUDevice;
  private readonly canvas: HTMLCanvasElement;
  private readonly translator: WebGPUTranslationLayer;
  private readonly config: Required<HiddenBufferConfig>;
  
  // Your existing hidden buffer components
  private pickingFramebuffer: GPUTexture | null = null;
  private featureIdTexture: GPUTexture | null = null;
  private depthTexture: GPUTexture | null = null;
  private renderPipeline: GPURenderPipeline | null = null;
  private pickingPipeline: GPURenderPipeline | null = null;
  
  // Feature management
  private readonly featureRegistry = new Map<number, Feature>();
  private nextFeatureId = 1;
  private lastRenderStats: RenderStatistics | null = null;

  constructor(
    device: GPUDevice,
    canvas: HTMLCanvasElement,
    config: HiddenBufferConfig
  ) {
    this.device = device;
    this.canvas = canvas;
    
    // Set default configuration
    this.config = {
      width: config.width,
      height: config.height,
      featureIdFormat: config.featureIdFormat,
      depthFormat: config.depthFormat ?? 'depth24plus',
      enableMultiTarget: config.enableMultiTarget ?? true,
      enableDepthTest: config.enableDepthTest ?? true
    };
    
    // Initialize translation layer
    this.translator = new WebGPUTranslationLayer(device, canvas, {
      center: { lng: 0, lat: 0 },
      zoom: 1,
      bearing: 0,
      pitch: 0
    });
    
    this.initializeResources();
  }

  // === MAIN INTEGRATION METHODS ===

  /**
   * Render features using your hidden buffer system with automatic coordinate translation
   */
  public async renderFeatures<T = Record<string, unknown>>(
    features: readonly Feature<T>[]
  ): Promise<RenderStatistics> {
    const startTime = performance.now();
    
    // Batch translate all features to clip space
    const translatedFeatures = await this.batchTranslateFeatures(features);
    const translationTime = performance.now() - startTime;
    
    // Clear feature registry for new frame
    this.featureRegistry.clear();
    this.nextFeatureId = 1;
    
    // Render to hidden buffer using your existing system
    const renderStartTime = performance.now();
    await this.renderToHiddenBuffer(translatedFeatures);
    
    // Render to main framebuffer
    await this.renderToMainBuffer(translatedFeatures);
    const renderTime = performance.now() - renderStartTime;
    
    // Collect statistics
    const stats: RenderStatistics = {
      featuresRendered: features.length,
      translationTime,
      renderTime,
      cacheHitRatio: this.translator.getCacheStats().hitRatio,
      gpuMemoryUsed: this.estimateGPUMemoryUsage()
    };
    
    this.lastRenderStats = stats;
    return stats;
  }

  /**
   * Pick features at screen point using your hidden buffer system
   */
  public async pickFeatures<T = Record<string, unknown>>(
    screenPoint: Point
  ): Promise<PickingResult<T>[]> {
    // Validate screen point
    if (screenPoint.x < 0 || screenPoint.x >= this.canvas.width ||
        screenPoint.y < 0 || screenPoint.y >= this.canvas.height) {
      return [];
    }
    
    // Use your existing hidden buffer picking
    const featureIds = await this.performHiddenBufferPick(screenPoint);
    
    // Convert to geographic coordinates for result
    const clipPoint: ClipCoordinates = {
      x: (screenPoint.x / this.canvas.width) * 2 - 1,
      y: 1 - (screenPoint.y / this.canvas.height) * 2
    };
    const worldCoordinates = this.translator.clipToLngLat(clipPoint);
    
    // Return original features with geographic coordinates
    const results: PickingResult<T>[] = [];
    for (const id of featureIds) {
      const feature = this.featureRegistry.get(id) as Feature<T> | undefined;
      if (feature) {
        results.push({
          feature,
          screenPoint,
          worldCoordinates,
          distance: this.calculateDistanceToFeature(worldCoordinates, feature)
        });
      }
    }
    
    // Sort by distance
    return results.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
  }

  /**
   * Update transform and invalidate cached translations
   */
  public updateTransform(options: {
    center?: LngLat;
    zoom?: number;
    bearing?: number;
    pitch?: number;
  }): void {
    this.translator.updateTransform(options);
  }

  // === COORDINATE TRANSLATION METHODS ===

  private async batchTranslateFeatures<T = Record<string, unknown>>(
    features: readonly Feature<T>[]
  ): Promise<TranslatedFeature<T>[]> {
    const results: TranslatedFeature<T>[] = [];
    
    for (const feature of features) {
      const geometryCoords = this.extractGeometryCoordinates(feature.geometry);
      
      // Batch translate geometry coordinates
      const translationResult = await this.translator.batchLngLatToClip(geometryCoords);
      
      // Create translated feature
      const translatedFeature: TranslatedFeature<T> = {
        id: feature.id,
        geometry: translationResult.coordinates,
        properties: feature.properties,
        type: feature.type,
        originalGeometry: feature.geometry,
        coordinateSpace: 'clip'
      };
      
      results.push(translatedFeature);
    }
    
    return results;
  }

  private extractGeometryCoordinates(geometry: Feature['geometry']): LngLat[] {
    if (Array.isArray(geometry)) {
      // Handle LineString, MultiPoint, or polygon exterior ring
      if (geometry.length > 0 && typeof geometry[0] === 'object' && 'lng' in geometry[0]) {
        return geometry as LngLat[];
      } else if (Array.isArray(geometry[0])) {
        // Handle Polygon (flatten all rings) or MultiLineString
        return (geometry as LngLat[][]).flat();
      } else {
        // Handle MultiPolygon
        return (geometry as LngLat[][][]).flat(2);
      }
    } else {
      // Handle Point
      return [geometry as LngLat];
    }
  }

  // === HIDDEN BUFFER RENDERING (Your existing system enhanced) ===

  private async renderToHiddenBuffer<T = Record<string, unknown>>(
    features: readonly TranslatedFeature<T>[]
  ): Promise<void> {
    if (!this.featureIdTexture || !this.depthTexture || !this.pickingPipeline) {
      throw new Error('Hidden buffer resources not initialized');
    }

    const commandEncoder = this.device.createCommandEncoder({
      label: 'Hidden Buffer Command Encoder'
    });
    
    // Begin render pass for hidden buffer
    const renderPass = commandEncoder.beginRenderPass({
      label: 'Hidden Buffer Render Pass',
      colorAttachments: [{
        view: this.featureIdTexture.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store'
      }],
      depthStencilAttachment: this.config.enableDepthTest ? {
        view: this.depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store'
      } : undefined
    });

    renderPass.setPipeline(this.pickingPipeline);

    // Render each feature with encoded ID
    for (const feature of features) {
      const featureId = this.nextFeatureId++;      this.featureRegistry.set(featureId, {
        ...feature,
        geometry: feature.originalGeometry // Store original coords
      } as Feature);

      // Your existing feature rendering logic with clip coordinates
      await this.renderFeatureForPicking(renderPass, feature, featureId);
    }

    renderPass.end();
    this.device.queue.submit([commandEncoder.finish()]);
  }

  private async renderToMainBuffer<T = Record<string, unknown>>(
    features: readonly TranslatedFeature<T>[]
  ): Promise<void> {
    if (!this.renderPipeline) {
      throw new Error('Render pipeline not initialized');
    }

    const commandEncoder = this.device.createCommandEncoder({
      label: 'Main Render Command Encoder'
    });
    
    // Get current canvas texture
    const canvasTexture = (this.canvas.getContext('webgpu') as GPUCanvasContext)
      ?.getCurrentTexture();
    
    if (!canvasTexture) {
      throw new Error('Failed to get canvas texture');
    }
    
    // Begin main render pass
    const renderPass = commandEncoder.beginRenderPass({
      label: 'Main Render Pass',
      colorAttachments: [{
        view: canvasTexture.createView(),
        clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store'
      }]
    });

    renderPass.setPipeline(this.renderPipeline);

    // Render features for display
    for (const feature of features) {
      await this.renderFeatureForDisplay(renderPass, feature);
    }

    renderPass.end();
    this.device.queue.submit([commandEncoder.finish()]);
  }

  private async renderFeatureForPicking<T = Record<string, unknown>>(
    renderPass: GPURenderPassEncoder,
    feature: TranslatedFeature<T>,
    featureId: number
  ): Promise<void> {
    // Encode feature ID as color (your existing logic)
    const encodedColor = this.encodeFeatureId(featureId);
    
    // Create vertex buffer with clip coordinates
    const vertexData = this.createVertexBuffer(feature.geometry, encodedColor);
    const vertexBuffer = this.createGPUBuffer({
      label: `Picking Vertex Buffer ${featureId}`,
      size: vertexData.byteLength,
      usage: GPUBufferUsage.VERTEX,
      data: vertexData,
      mappedAtCreation: true
    });

    // Render with your existing pipeline
    renderPass.setVertexBuffer(0, vertexBuffer);
    renderPass.draw(feature.geometry.length);
    
    // Clean up
    vertexBuffer.destroy();
  }

  private async renderFeatureForDisplay<T = Record<string, unknown>>(
    renderPass: GPURenderPassEncoder,
    feature: TranslatedFeature<T>
  ): Promise<void> {
    // Create vertex buffer with clip coordinates and actual colors
    const color = this.getFeatureColor(feature);
    const vertexData = this.createVertexBuffer(feature.geometry, color);
    
    const vertexBuffer = this.createGPUBuffer({
      label: `Display Vertex Buffer ${feature.id}`,
      size: vertexData.byteLength,
      usage: GPUBufferUsage.VERTEX,
      data: vertexData,
      mappedAtCreation: true
    });

    renderPass.setVertexBuffer(0, vertexBuffer);
    renderPass.draw(feature.geometry.length);
    
    vertexBuffer.destroy();
  }

  // === HIDDEN BUFFER PICKING (Your existing system) ===

  private async performHiddenBufferPick(screenPoint: Point): Promise<number[]> {
    if (!this.featureIdTexture) {
      return [];
    }

    // Create buffer to read pixel data
    const pixelBuffer = this.device.createBuffer({
      label: 'Pixel Read Buffer',
      size: 4 * 4, // RGBA32
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });

    // Copy pixel from hidden buffer
    const commandEncoder = this.device.createCommandEncoder({
      label: 'Pixel Copy Command Encoder'
    });
    
    commandEncoder.copyTextureToBuffer(
      {
        texture: this.featureIdTexture,
        origin: { x: Math.floor(screenPoint.x), y: Math.floor(screenPoint.y) }
      },
      {
        buffer: pixelBuffer,
        bytesPerRow: 16,
        rowsPerImage: 1
      },
      { width: 1, height: 1 }
    );

    this.device.queue.submit([commandEncoder.finish()]);

    // Read pixel data
    await pixelBuffer.mapAsync(GPUMapMode.READ);
    const pixelData = new Uint32Array(pixelBuffer.getMappedRange());
    const featureId = this.decodeFeatureId(pixelData);
    pixelBuffer.unmap();
    pixelBuffer.destroy();

    return featureId ? [featureId] : [];
  }

  // === UTILITY METHODS ===

  private initializeResources(): void {
    this.setupHiddenBuffers();
    this.setupRenderPipelines();
  }

  private setupHiddenBuffers(): void {
    // Feature ID texture (32-bit precision)
    this.featureIdTexture = this.device.createTexture({
      label: 'Feature ID Texture',
      size: { width: this.config.width, height: this.config.height },
      format: this.config.featureIdFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
    });

    // Depth texture
    if (this.config.enableDepthTest) {
      this.depthTexture = this.device.createTexture({
        label: 'Depth Texture',
        size: { width: this.config.width, height: this.config.height },
        format: this.config.depthFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT
      });
    }
  }

  private setupRenderPipelines(): void {
    // Your existing shader code adapted for the new architecture
    const vertexShaderCode = `
      struct VertexInput {
        @location(0) position: vec2<f32>,
        @location(1) color: vec4<f32>,
      };
      
      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) color: vec4<f32>,
      };
      
      @vertex
      fn vs_main(input: VertexInput) -> VertexOutput {
        var output: VertexOutput;
        // Position is already in clip space from translation layer
        output.position = vec4<f32>(input.position, 0.0, 1.0);
        output.color = input.color;
        return output;
      }
    `;

    const fragmentShaderCode = `
      @fragment
      fn fs_main(@location(0) color: vec4<f32>) -> @location(0) vec4<f32> {
        return color;
      }
    `;

    const pickingFragmentShaderCode = `
      @fragment
      fn fs_main(@location(0) color: vec4<f32>) -> @location(0) vec4<u32> {
        // Convert color to feature ID for picking
        return vec4<u32>(u32(color.r * 255.0), 0u, 0u, 1u);
      }
    `;

    // Create shader modules
    const vertexModule = this.device.createShaderModule({ 
      label: 'Vertex Shader',
      code: vertexShaderCode 
    });
    const fragmentModule = this.device.createShaderModule({ 
      label: 'Fragment Shader',
      code: fragmentShaderCode 
    });
    const pickingFragmentModule = this.device.createShaderModule({ 
      label: 'Picking Fragment Shader',
      code: pickingFragmentShaderCode 
    });

    // Vertex buffer layout
    const vertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: 6 * 4, // 2 position + 4 color floats
      attributes: [
        { format: 'float32x2', offset: 0, shaderLocation: 0 }, // position
        { format: 'float32x4', offset: 8, shaderLocation: 1 }  // color
      ]
    };

    // Main render pipeline
    this.renderPipeline = this.device.createRenderPipeline({
      label: 'Main Render Pipeline',
      layout: 'auto',
      vertex: {
        module: vertexModule,
        entryPoint: 'vs_main',
        buffers: [vertexBufferLayout]
      },
      fragment: {
        module: fragmentModule,
        entryPoint: 'fs_main',
        targets: [{ format: 'bgra8unorm' }]
      }
    });

    // Picking render pipeline
    this.pickingPipeline = this.device.createRenderPipeline({
      label: 'Picking Render Pipeline',
      layout: 'auto',
      vertex: {
        module: vertexModule,
        entryPoint: 'vs_main',
        buffers: [vertexBufferLayout]
      },
      fragment: {
        module: pickingFragmentModule,
        entryPoint: 'fs_main',
        targets: [{ format: this.config.featureIdFormat }]
      },
      depthStencil: this.config.enableDepthTest ? {
        format: this.config.depthFormat,
        depthWriteEnabled: true,
        depthCompare: 'less'
      } : undefined
    });
  }

  private createVertexBuffer(geometry: ClipCoordinates[], color: ColorRGBA): Float32Array {
    const vertexData = new Float32Array(geometry.length * 6); // 2 pos + 4 color per vertex
    
    for (let i = 0; i < geometry.length; i++) {
      const offset = i * 6;
      vertexData[offset] = geometry[i].x;     // x position (clip space)
      vertexData[offset + 1] = geometry[i].y; // y position (clip space)
      vertexData[offset + 2] = color.r;       // red
      vertexData[offset + 3] = color.g;       // green
      vertexData[offset + 4] = color.b;       // blue
      vertexData[offset + 5] = color.a;       // alpha
    }
    
    return vertexData;
  }

  private createGPUBuffer(config: GPUBufferConfig): GPUBuffer {
    const buffer = this.device.createBuffer({
      label: config.label,
      size: config.size,
      usage: config.usage,
      mappedAtCreation: config.mappedAtCreation
    });    if (config.data && config.mappedAtCreation) {
      const mappedRange = buffer.getMappedRange();
      if (config.data instanceof Float32Array) {
        new Float32Array(mappedRange).set(config.data);
      } else if (config.data instanceof ArrayBuffer) {
        new Uint8Array(mappedRange).set(new Uint8Array(config.data));
      } else {
        // Handle typed arrays
        const typedArray = config.data as Uint8Array;
        new Uint8Array(mappedRange).set(typedArray);
      }
      buffer.unmap();
    }

    return buffer;
  }

  private encodeFeatureId(id: number): ColorRGBA {
    // Your existing color encoding logic
    return {
      r: (id & 0xFF) / 255.0,
      g: ((id >> 8) & 0xFF) / 255.0,
      b: ((id >> 16) & 0xFF) / 255.0,
      a: 1.0
    };
  }

  private decodeFeatureId(pixelData: Uint32Array): number | null {
    // Your existing color decoding logic
    const r = pixelData[0] & 0xFF;
    const g = (pixelData[0] >> 8) & 0xFF;
    const b = (pixelData[0] >> 16) & 0xFF;
    
    const featureId = r | (g << 8) | (b << 16);
    return featureId > 0 ? featureId : null;
  }
  private getFeatureColor<T = Record<string, unknown>>(feature: TranslatedFeature<T>): ColorRGBA {
    // Default feature color - you can customize based on properties
    const colorProperty = (feature.properties as any).color as string | undefined;
    
    if (colorProperty) {
      return this.parseColorString(colorProperty);
    }
    
    // Default blue color
    return { r: 0.5, g: 0.5, b: 1.0, a: 1.0 };
  }

  private parseColorString(color: string): ColorRGBA {
    // Simple color parsing - extend as needed
    switch (color.toLowerCase()) {
      case 'red': return { r: 1.0, g: 0.0, b: 0.0, a: 1.0 };
      case 'green': return { r: 0.0, g: 1.0, b: 0.0, a: 1.0 };
      case 'blue': return { r: 0.0, g: 0.0, b: 1.0, a: 1.0 };
      case 'yellow': return { r: 1.0, g: 1.0, b: 0.0, a: 1.0 };
      default: return { r: 0.5, g: 0.5, b: 1.0, a: 1.0 };
    }
  }

  private calculateDistanceToFeature<T = Record<string, unknown>>(
    point: LngLat, 
    feature: Feature<T>
  ): number {
    // Simple distance calculation - extend for complex geometries
    const coords = this.extractGeometryCoordinates(feature.geometry);
    
    if (coords.length === 0) return Infinity;
    
    // Calculate distance to closest point in geometry
    let minDistance = Infinity;
    for (const coord of coords) {
      const dx = point.lng - coord.lng;
      const dy = point.lat - coord.lat;
      const distance = Math.sqrt(dx * dx + dy * dy);
      minDistance = Math.min(minDistance, distance);
    }
    
    return minDistance;
  }

  private estimateGPUMemoryUsage(): number {
    let usage = 0;
    
    if (this.featureIdTexture) {
      usage += this.config.width * this.config.height * 4; // RGBA32
    }
    
    if (this.depthTexture) {
      usage += this.config.width * this.config.height * 4; // Depth24Plus
    }
    
    // Add buffer memory usage
    usage += this.featureRegistry.size * 1024; // Estimate per feature
    
    return usage;
  }

  // === PUBLIC API ===

  /**
   * Get translation layer statistics
   */
  public getStats(): {
    cacheStats: { size: number; hitRatio: number };
    featureCount: number;
    lastRenderStats: RenderStatistics | null;
  } {
    return {
      cacheStats: this.translator.getCacheStats(),
      featureCount: this.featureRegistry.size,
      lastRenderStats: this.lastRenderStats
    };
  }

  /**
   * Get the translation layer for direct access
   */
  public getTranslationLayer(): WebGPUTranslationLayer {
    return this.translator;
  }

  /**
   * Dispose of all resources
   */
  public dispose(): void {
    this.translator.dispose();
    this.featureIdTexture?.destroy();
    this.depthTexture?.destroy();
    this.featureRegistry.clear();
  }
}