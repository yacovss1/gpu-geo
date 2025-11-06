// Hidden Buffer Integration - TypeScript Implementation
// Advanced feature picking and rendering using hidden buffer technique

import type {
  LngLat,
  Point,
  Feature,
  PolygonFeature,
  PointFeature,
  LineStringFeature,
  PickingResult,
  HiddenBufferConfig,
  PerformanceMetrics
} from '../../types/core';

import { WebGPUTranslationLayer } from './WebGPUTranslationLayer';
import { TriangulationUtils } from '../../utils/math';

/**
 * RGBA color representation
 */
export interface ColorRGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Feature with translated coordinates ready for rendering
 */
export interface TranslatedFeature<T = Record<string, unknown>> {
  /** Original feature */
  original: Feature<T>;
  /** Translated geometry in clip coordinates */
  clipGeometry: Point[];
  /** Triangulated vertex data for rendering */
  vertices: Float32Array;
  /** Index buffer for triangles */
  indices: Uint32Array;
  /** Feature color for hidden buffer */
  hiddenColor: ColorRGBA;
  /** Feature ID encoded as color */
  featureId: number;
}

/**
 * Rendering statistics
 */
export interface RenderStatistics {
  /** Number of features rendered */
  featuresRendered: number;
  /** Number of vertices processed */
  verticesProcessed: number;
  /** Number of triangles generated */
  trianglesGenerated: number;
  /** GPU memory used for buffers (bytes) */
  bufferMemoryUsage: number;
  /** Rendering time (milliseconds) */
  renderTime: number;
  /** Hidden buffer memory usage (bytes) */
  hiddenBufferMemoryUsage: number;
}

/**
 * Advanced hidden buffer integration for WebGPU feature picking
 * Enables efficient mouse interaction and feature selection
 */
export class HiddenBufferIntegration {
  private device: GPUDevice;
  private canvas: HTMLCanvasElement;
  private translationLayer: WebGPUTranslationLayer;
  private config: Required<HiddenBufferConfig>;
  
  // Hidden buffer resources
  private hiddenTexture: GPUTexture | null = null;
  private hiddenTextureView: GPUTextureView | null = null;
  private depthTexture: GPUTexture | null = null;
  private depthTextureView: GPUTextureView | null = null;
  
  // Render pipelines
  private visibleRenderPipeline: GPURenderPipeline | null = null;
  private hiddenRenderPipeline: GPURenderPipeline | null = null;
  
  // GPU buffers
  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private colorBuffer: GPUBuffer | null = null;
  
  // Bind groups
  private visibleBindGroup: GPUBindGroup | null = null;
  private hiddenBindGroup: GPUBindGroup | null = null;
    // Feature management
  private features: Map<number, TranslatedFeature<any>> = new Map();
  private featureIdCounter = 1;
  private colorToFeatureId: Map<string, number> = new Map();
  
  // Performance tracking
  private renderStats: RenderStatistics = {
    featuresRendered: 0,
    verticesProcessed: 0,
    trianglesGenerated: 0,
    bufferMemoryUsage: 0,
    renderTime: 0,
    hiddenBufferMemoryUsage: 0
  };
  
  constructor(
    device: GPUDevice,
    canvas: HTMLCanvasElement,
    translationLayer: WebGPUTranslationLayer,
    config: Partial<HiddenBufferConfig> = {}
  ) {
    this.device = device;
    this.canvas = canvas;
    this.translationLayer = translationLayer;
    
    // Apply default configuration
    this.config = {
      width: config.width ?? canvas.width,
      height: config.height ?? canvas.height,
      featureIdFormat: (config.featureIdFormat ?? 'rgba8unorm') as GPUTextureFormat,
      depthFormat: (config.depthFormat ?? 'depth24plus') as GPUTextureFormat,
      enableMultiTarget: config.enableMultiTarget ?? true,
      enableDepthTest: config.enableDepthTest ?? true
    };
  }
  
  /**
   * Initialize the hidden buffer system
   */
  async initialize(): Promise<void> {
    try {
      await this.createTextures();
      await this.createRenderPipelines();
      await this.createBuffers();
      this.createBindGroups();
      
      console.log('✅ Hidden Buffer Integration initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize Hidden Buffer Integration:', error);
      throw error;
    }
  }
  
  /**
   * Create hidden buffer textures
   */
  private async createTextures(): Promise<void> {
    // Hidden buffer texture for feature IDs
    this.hiddenTexture = this.device.createTexture({
      label: 'Hidden Buffer Texture',
      size: {
        width: this.config.width,
        height: this.config.height,
        depthOrArrayLayers: 1
      },
      format: this.config.featureIdFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
    });
    
    this.hiddenTextureView = this.hiddenTexture.createView({
      label: 'Hidden Buffer View'
    });
    
    // Depth texture
    if (this.config.enableDepthTest) {
      this.depthTexture = this.device.createTexture({
        label: 'Depth Texture',
        size: {
          width: this.config.width,
          height: this.config.height,
          depthOrArrayLayers: 1
        },
        format: this.config.depthFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT
      });
      
      this.depthTextureView = this.depthTexture.createView({
        label: 'Depth Buffer View'
      });
    }
  }
  
  /**
   * Create render pipelines for visible and hidden rendering
   */
  private async createRenderPipelines(): Promise<void> {
    // Vertex shader (shared between visible and hidden pipelines)
    const vertexShaderCode = `
      struct VertexInput {
        @location(0) position: vec2<f32>,
        @location(1) color: vec4<f32>,
      }
      
      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) color: vec4<f32>,
      }
      
      struct Uniforms {
        transform: mat4x4<f32>,
        viewProjection: mat4x4<f32>,
      }
      
      @group(0) @binding(0) var<uniform> uniforms: Uniforms;
      
      @vertex
      fn vs_main(input: VertexInput) -> VertexOutput {
        var output: VertexOutput;
        
        let worldPos = vec4<f32>(input.position, 0.0, 1.0);
        output.position = uniforms.viewProjection * uniforms.transform * worldPos;
        output.color = input.color;
        
        return output;
      }
    `;
    
    // Fragment shader for visible rendering
    const visibleFragmentShaderCode = `
      struct FragmentInput {
        @location(0) color: vec4<f32>,
      }
      
      @fragment
      fn fs_main(input: FragmentInput) -> @location(0) vec4<f32> {
        return input.color;
      }
    `;
    
    // Fragment shader for hidden rendering (feature ID)
    const hiddenFragmentShaderCode = `
      struct FragmentInput {
        @location(0) color: vec4<f32>,
      }
      
      @fragment
      fn fs_main(input: FragmentInput) -> @location(0) vec4<f32> {
        // Return the encoded feature ID as color
        return input.color;
      }
    `;
    
    // Create shader modules
    const vertexShaderModule = this.device.createShaderModule({
      label: 'Vertex Shader',
      code: vertexShaderCode
    });
    
    const visibleFragmentModule = this.device.createShaderModule({
      label: 'Visible Fragment Shader',
      code: visibleFragmentShaderCode
    });
    
    const hiddenFragmentModule = this.device.createShaderModule({
      label: 'Hidden Fragment Shader',
      code: hiddenFragmentShaderCode
    });
    
    // Vertex buffer layout
    const vertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: 24, // 2 floats position + 4 floats color
      attributes: [
        {
          // Position
          format: 'float32x2',
          offset: 0,
          shaderLocation: 0
        },
        {
          // Color
          format: 'float32x4',
          offset: 8,
          shaderLocation: 1
        }
      ]
    };
    
    // Visible render pipeline
    this.visibleRenderPipeline = this.device.createRenderPipeline({
      label: 'Visible Render Pipeline',
      layout: 'auto',
      vertex: {
        module: vertexShaderModule,
        entryPoint: 'vs_main',
        buffers: [vertexBufferLayout]
      },
      fragment: {
        module: visibleFragmentModule,
        entryPoint: 'fs_main',
        targets: [{
          format: 'bgra8unorm',
          blend: {
            color: {
              srcFactor: 'src-alpha',
              dstFactor: 'one-minus-src-alpha'
            },
            alpha: {
              srcFactor: 'one',
              dstFactor: 'one-minus-src-alpha'
            }
          }
        }]
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'back'
      },
      depthStencil: this.config.enableDepthTest ? {
        depthWriteEnabled: true,
        depthCompare: 'less',
        format: this.config.depthFormat
      } : undefined
    });
    
    // Hidden render pipeline
    this.hiddenRenderPipeline = this.device.createRenderPipeline({
      label: 'Hidden Render Pipeline',
      layout: 'auto',
      vertex: {
        module: vertexShaderModule,
        entryPoint: 'vs_main',
        buffers: [vertexBufferLayout]
      },
      fragment: {
        module: hiddenFragmentModule,
        entryPoint: 'fs_main',
        targets: [{
          format: this.config.featureIdFormat
        }]
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'back'
      },
      depthStencil: this.config.enableDepthTest ? {
        depthWriteEnabled: true,
        depthCompare: 'less',
        format: this.config.depthFormat
      } : undefined
    });
  }
  
  /**
   * Create GPU buffers
   */
  private async createBuffers(): Promise<void> {
    // Vertex buffer (will be resized as needed)
    this.vertexBuffer = this.device.createBuffer({
      label: 'Vertex Buffer',
      size: 1024 * 24, // Start with space for 1024 vertices
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    
    // Index buffer
    this.indexBuffer = this.device.createBuffer({
      label: 'Index Buffer',
      size: 1024 * 6, // Start with space for 1024 triangles
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
    });
    
    // Uniform buffer for transformation matrices
    this.uniformBuffer = this.device.createBuffer({
      label: 'Uniform Buffer',
      size: 128, // 2 * mat4x4
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
  }
  
  /**
   * Create bind groups for rendering
   */
  private createBindGroups(): void {
    if (!this.visibleRenderPipeline || !this.hiddenRenderPipeline || !this.uniformBuffer) {
      throw new Error('Cannot create bind groups: required resources not initialized');
    }
    
    // Visible bind group
    const visibleLayout = this.visibleRenderPipeline.getBindGroupLayout(0);
    this.visibleBindGroup = this.device.createBindGroup({
      label: 'Visible Bind Group',
      layout: visibleLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer }
        }
      ]
    });
    
    // Hidden bind group
    const hiddenLayout = this.hiddenRenderPipeline.getBindGroupLayout(0);
    this.hiddenBindGroup = this.device.createBindGroup({
      label: 'Hidden Bind Group',
      layout: hiddenLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer }
        }
      ]
    });
  }
  
  /**
   * Add features for rendering and picking
   */
  async addFeatures<T>(features: Feature<T>[]): Promise<void> {
    const startTime = performance.now();
    
    for (const feature of features) {
      const translated = await this.translateFeature(feature);
      if (translated) {
        this.features.set(translated.featureId, translated);
      }
    }
    
    // Update render statistics
    this.renderStats.featuresRendered = this.features.size;
    this.renderStats.renderTime = performance.now() - startTime;
    
    console.log(`✅ Added ${features.length} features for rendering`);
  }
  
  /**
   * Translate a single feature to clip coordinates
   */
  private async translateFeature<T>(feature: Feature<T>): Promise<TranslatedFeature<T> | null> {
    try {
      const featureId = this.featureIdCounter++;
      const hiddenColor = this.encodeFeatureId(featureId);
      
      let clipGeometry: Point[] = [];
      let vertices: Float32Array;
      let indices: Uint32Array;
      
      switch (feature.type) {
        case 'polygon':
          const polygonResult = await this.translatePolygon(feature as PolygonFeature<T>);
          clipGeometry = polygonResult.clipGeometry;
          vertices = polygonResult.vertices;
          indices = polygonResult.indices;
          break;
          
        case 'point':
          const pointResult = await this.translatePoint(feature as PointFeature<T>);
          clipGeometry = pointResult.clipGeometry;
          vertices = pointResult.vertices;
          indices = pointResult.indices;
          break;
          
        case 'linestring':
          const lineResult = await this.translateLineString(feature as LineStringFeature<T>);
          clipGeometry = lineResult.clipGeometry;
          vertices = lineResult.vertices;
          indices = lineResult.indices;
          break;
          
        default:
          console.warn(`Unsupported feature type: ${feature.type}`);
          return null;
      }
      
      // Store color-to-feature mapping
      const colorKey = `${hiddenColor.r},${hiddenColor.g},${hiddenColor.b},${hiddenColor.a}`;
      this.colorToFeatureId.set(colorKey, featureId);
      
      return {
        original: feature,
        clipGeometry,
        vertices,
        indices,
        hiddenColor,
        featureId
      };
      
    } catch (error) {
      console.error(`Failed to translate feature ${feature.id}:`, error);
      return null;
    }
  }
  
  /**
   * Translate polygon feature
   */
  private async translatePolygon<T>(feature: PolygonFeature<T>): Promise<{
    clipGeometry: Point[];
    vertices: Float32Array;
    indices: Uint32Array;
  }> {
    const exterior = feature.geometry[0];
    const holes = feature.geometry.slice(1);
    
    // Translate coordinates
    const batchResult = await this.translationLayer.batchLngLatToClip(exterior);
    const clipGeometry = batchResult.coordinates.map(coord => ({ x: coord.x, y: coord.y }));
    
    // Triangulate polygon
    const triangulation = TriangulationUtils.triangulatePolygon(exterior, holes);
    
    // Create vertex data with position and color
    const vertexCount = triangulation.vertexCount;
    const vertices = new Float32Array(vertexCount * 6); // 2 position + 4 color
    
    for (let i = 0; i < vertexCount; i++) {
      const vertexIndex = i * 6;
      const coordIndex = i * 2;
      
      // Position
      vertices[vertexIndex] = triangulation.vertices[coordIndex];
      vertices[vertexIndex + 1] = triangulation.vertices[coordIndex + 1];
      
      // Color (will be set during rendering)
      vertices[vertexIndex + 2] = 1.0; // r
      vertices[vertexIndex + 3] = 0.5; // g
      vertices[vertexIndex + 4] = 0.0; // b
      vertices[vertexIndex + 5] = 1.0; // a
    }
    
    const indices = new Uint32Array(triangulation.triangles);
    
    return {
      clipGeometry,
      vertices,
      indices
    };
  }
  
  /**
   * Translate point feature
   */
  private async translatePoint<T>(feature: PointFeature<T>): Promise<{
    clipGeometry: Point[];
    vertices: Float32Array;
    indices: Uint32Array;
  }> {
    const result = await this.translationLayer.lngLatToClip(feature.geometry);
    const clipPoint = { x: result.coordinates.x, y: result.coordinates.y };
    
    // Create a small quad for the point
    const size = 0.01; // Point size in clip space
    const vertices = new Float32Array([
      // Position (x, y), Color (r, g, b, a)
      clipPoint.x - size, clipPoint.y - size, 1.0, 0.0, 0.0, 1.0,
      clipPoint.x + size, clipPoint.y - size, 1.0, 0.0, 0.0, 1.0,
      clipPoint.x + size, clipPoint.y + size, 1.0, 0.0, 0.0, 1.0,
      clipPoint.x - size, clipPoint.y + size, 1.0, 0.0, 0.0, 1.0
    ]);
    
    const indices = new Uint32Array([
      0, 1, 2,
      0, 2, 3
    ]);
    
    return {
      clipGeometry: [clipPoint],
      vertices,
      indices
    };
  }
  
  /**
   * Translate linestring feature
   */
  private async translateLineString<T>(feature: LineStringFeature<T>): Promise<{
    clipGeometry: Point[];
    vertices: Float32Array;
    indices: Uint32Array;
  }> {
    // Translate coordinates
    const batchResult = await this.translationLayer.batchLngLatToClip(feature.geometry);
    const clipGeometry = batchResult.coordinates.map(coord => ({ x: coord.x, y: coord.y }));
    
    // Create line strip
    const lineStrip = TriangulationUtils.createLineStrip(feature.geometry, 0.005); // Line width
    
    // Create vertex data
    const vertexCount = lineStrip.vertices.length / 2;
    const vertices = new Float32Array(vertexCount * 6);
    
    for (let i = 0; i < vertexCount; i++) {
      const vertexIndex = i * 6;
      const coordIndex = i * 2;
      
      // Position
      vertices[vertexIndex] = lineStrip.vertices[coordIndex];
      vertices[vertexIndex + 1] = lineStrip.vertices[coordIndex + 1];
      
      // Color
      vertices[vertexIndex + 2] = 0.0; // r
      vertices[vertexIndex + 3] = 0.0; // g
      vertices[vertexIndex + 4] = 1.0; // b
      vertices[vertexIndex + 5] = 1.0; // a
    }
    
    const indices = new Uint32Array(lineStrip.triangles);
    
    return {
      clipGeometry,
      vertices,
      indices
    };
  }
  
  /**
   * Encode feature ID as RGBA color
   */
  private encodeFeatureId(featureId: number): ColorRGBA {
    // Encode 24-bit feature ID into RGB channels
    const r = (featureId & 0xFF0000) >> 16;
    const g = (featureId & 0x00FF00) >> 8;
    const b = featureId & 0x0000FF;
    
    return {
      r: r / 255,
      g: g / 255,
      b: b / 255,
      a: 1.0
    };
  }
  
  /**
   * Decode RGBA color back to feature ID
   */
  private decodeFeatureId(color: ColorRGBA): number {
    const r = Math.round(color.r * 255);
    const g = Math.round(color.g * 255);
    const b = Math.round(color.b * 255);
    
    return (r << 16) | (g << 8) | b;
  }
  
  /**
   * Render all features to both visible and hidden buffers
   */
  async renderFeatures(): Promise<void> {
    if (!this.visibleRenderPipeline || !this.hiddenRenderPipeline || 
        !this.visibleBindGroup || !this.hiddenBindGroup) {
      throw new Error('Render pipelines not initialized');
    }
    
    const startTime = performance.now();
    
    // Prepare vertex and index data
    await this.prepareRenderData();
    
    // Create command encoder
    const commandEncoder = this.device.createCommandEncoder({
      label: 'Feature Rendering Commands'
    });
    
    // Render to visible buffer
    await this.renderVisible(commandEncoder);
    
    // Render to hidden buffer
    await this.renderHidden(commandEncoder);
    
    // Submit commands
    this.device.queue.submit([commandEncoder.finish()]);
    
    // Update statistics
    this.renderStats.renderTime = performance.now() - startTime;
    this.renderStats.featuresRendered = this.features.size;
  }
  
  /**
   * Prepare vertex and index data for rendering
   */
  private async prepareRenderData(): Promise<void> {
    // Calculate total size needed
    let totalVertices = 0;
    let totalIndices = 0;
    
    for (const feature of this.features.values()) {
      totalVertices += feature.vertices.length / 6; // 6 floats per vertex
      totalIndices += feature.indices.length;
    }
    
    // Resize buffers if needed
    await this.resizeBuffersIfNeeded(totalVertices * 24, totalIndices * 4);
    
    // Combine all vertex and index data
    const vertexData = new Float32Array(totalVertices * 6);
    const indexData = new Uint32Array(totalIndices);
    
    let vertexOffset = 0;
    let indexOffset = 0;
    let baseVertex = 0;
    
    for (const feature of this.features.values()) {
      // Copy vertex data
      vertexData.set(feature.vertices, vertexOffset);
      
      // Copy index data with vertex offset
      for (let i = 0; i < feature.indices.length; i++) {
        indexData[indexOffset + i] = feature.indices[i] + baseVertex;
      }
      
      vertexOffset += feature.vertices.length;
      indexOffset += feature.indices.length;
      baseVertex += feature.vertices.length / 6;
    }
    
    // Upload data to GPU
    this.device.queue.writeBuffer(this.vertexBuffer!, 0, vertexData);
    this.device.queue.writeBuffer(this.indexBuffer!, 0, indexData);
    
    // Update statistics
    this.renderStats.verticesProcessed = totalVertices;
    this.renderStats.trianglesGenerated = totalIndices / 3;
  }
  
  /**
   * Resize buffers if needed
   */
  private async resizeBuffersIfNeeded(vertexSize: number, indexSize: number): Promise<void> {
    if (this.vertexBuffer!.size < vertexSize) {
      this.vertexBuffer!.destroy();
      this.vertexBuffer = this.device.createBuffer({
        label: 'Vertex Buffer',
        size: vertexSize * 2, // Double the size for future growth
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
      });
    }
    
    if (this.indexBuffer!.size < indexSize) {
      this.indexBuffer!.destroy();
      this.indexBuffer = this.device.createBuffer({
        label: 'Index Buffer',
        size: indexSize * 2,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
      });
    }
  }
  
  /**
   * Render to visible buffer
   */
  private async renderVisible(commandEncoder: GPUCommandEncoder): Promise<void> {
    const context = this.canvas.getContext('webgpu') as GPUCanvasContext;
    
    const renderPass = commandEncoder.beginRenderPass({
      label: 'Visible Render Pass',
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store'
      }],
      depthStencilAttachment: this.config.enableDepthTest ? {
        view: this.depthTextureView!,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store'
      } : undefined
    });
    
    renderPass.setPipeline(this.visibleRenderPipeline!);
    renderPass.setBindGroup(0, this.visibleBindGroup!);
    renderPass.setVertexBuffer(0, this.vertexBuffer!);
    renderPass.setIndexBuffer(this.indexBuffer!, 'uint32');
    
    // Draw all features
    let indexOffset = 0;
    for (const feature of this.features.values()) {
      renderPass.drawIndexed(feature.indices.length, 1, indexOffset);
      indexOffset += feature.indices.length;
    }
    
    renderPass.end();
  }
  
  /**
   * Render to hidden buffer
   */
  private async renderHidden(commandEncoder: GPUCommandEncoder): Promise<void> {
    const renderPass = commandEncoder.beginRenderPass({
      label: 'Hidden Render Pass',
      colorAttachments: [{
        view: this.hiddenTextureView!,
        clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
        loadOp: 'clear',
        storeOp: 'store'
      }],
      depthStencilAttachment: this.config.enableDepthTest ? {
        view: this.depthTextureView!,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store'
      } : undefined
    });
    
    renderPass.setPipeline(this.hiddenRenderPipeline!);
    renderPass.setBindGroup(0, this.hiddenBindGroup!);
    renderPass.setVertexBuffer(0, this.vertexBuffer!);
    renderPass.setIndexBuffer(this.indexBuffer!, 'uint32');
    
    // Draw features with encoded colors
    let indexOffset = 0;
    for (const feature of this.features.values()) {
      // Update vertex colors to feature ID color
      // (In a real implementation, this would be more efficient)
      renderPass.drawIndexed(feature.indices.length, 1, indexOffset);
      indexOffset += feature.indices.length;
    }
    
    renderPass.end();
  }
  
  /**
   * Pick feature at screen coordinates
   */
  async pickFeature(screenPoint: Point): Promise<PickingResult | null> {
    if (!this.hiddenTexture) {
      return null;
    }
    
    try {
      // Read pixel from hidden buffer
      const pixelData = await this.readHiddenPixel(screenPoint);
      if (!pixelData) return null;
      
      // Decode feature ID from pixel color
      const color: ColorRGBA = {
        r: pixelData[0] / 255,
        g: pixelData[1] / 255,
        b: pixelData[2] / 255,
        a: pixelData[3] / 255
      };
      
      const featureId = this.decodeFeatureId(color);
      const feature = this.features.get(featureId);
      
      if (!feature) return null;
      
      // Convert screen coordinates to world coordinates
      const worldCoordinates = await this.screenToWorld(screenPoint);
      
      return {
        feature: feature.original,
        screenPoint,
        worldCoordinates,
        distance: 0
      };
      
    } catch (error) {
      console.error('Feature picking failed:', error);
      return null;
    }
  }
  
  /**
   * Read a single pixel from the hidden buffer
   */
  private async readHiddenPixel(screenPoint: Point): Promise<Uint8Array | null> {
    // Create a small buffer to read the pixel
    const pixelBuffer = this.device.createBuffer({
      size: 4, // RGBA
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    
    // Create command encoder
    const commandEncoder = this.device.createCommandEncoder();
    
    // Copy single pixel from texture to buffer
    commandEncoder.copyTextureToBuffer(
      {
        texture: this.hiddenTexture!,
        origin: { x: Math.floor(screenPoint.x), y: Math.floor(screenPoint.y) }
      },
      {
        buffer: pixelBuffer,
        bytesPerRow: 4
      },
      { width: 1, height: 1 }
    );
    
    // Submit command
    this.device.queue.submit([commandEncoder.finish()]);
    
    // Read pixel data
    await pixelBuffer.mapAsync(GPUMapMode.READ);
    const pixelData = new Uint8Array(pixelBuffer.getMappedRange());
    const result = new Uint8Array(pixelData);
    pixelBuffer.unmap();
    pixelBuffer.destroy();
    
    return result;
  }
  
  /**
   * Convert screen coordinates to world coordinates
   */
  private async screenToWorld(screenPoint: Point): Promise<LngLat> {
    // Convert screen to clip space
    const clipX = (screenPoint.x / this.canvas.width) * 2 - 1;
    const clipY = -((screenPoint.y / this.canvas.height) * 2 - 1);
    
    // For now, return a placeholder
    // In a real implementation, this would involve inverse transformation
    return { lng: clipX * 180, lat: clipY * 90 };
  }
  
  /**
   * Get current rendering statistics
   */
  getRenderStatistics(): RenderStatistics {
    return { ...this.renderStats };
  }
  
  /**
   * Clear all features
   */
  clearFeatures(): void {
    this.features.clear();
    this.colorToFeatureId.clear();
    this.featureIdCounter = 1;
    this.renderStats.featuresRendered = 0;
  }
  
  /**
   * Clean up GPU resources
   */
  destroy(): void {
    this.hiddenTexture?.destroy();
    this.depthTexture?.destroy();
    this.vertexBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.uniformBuffer?.destroy();
    
    this.clearFeatures();
  }
}