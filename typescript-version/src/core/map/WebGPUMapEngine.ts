// WebGPU Map Engine - Complete Mapping System
// High-performance map rendering with tile management and layer system

import { mat4, vec3 } from 'gl-matrix';
import { WebGPUTranslationLayer } from '../translation/WebGPUTranslationLayer';
import { HiddenBufferIntegration } from '../translation/HiddenBufferIntegration';
import { MatrixUtils, TriangulationUtils } from '../../utils/math';

import type {
  LngLat,
  Point,
  MapTransform,
  Feature,
  PolygonFeature,
  PointFeature,
  LineStringFeature,
  TileCoordinate,
  MapLayer,
  MapConfig,
  ViewportBounds,
  RenderState
} from '../../types/core';

/**
 * Tile data structure for map rendering
 */
export interface MapTile {
  /** Tile coordinates (z/x/y) */
  coord: TileCoordinate;
  /** Tile bounds in geographic coordinates */
  bounds: ViewportBounds;
  /** Features contained in this tile */
  features: Feature[];
  /** Render data for GPU */
  renderData?: {
    vertices: Float32Array;
    indices: Uint32Array;
    featureCount: number;
  };
  /** Loading state */
  loading: boolean;
  /** Error state */
  error?: string;
}

/**
 * Map layer definition
 */
export interface MapLayerDefinition {
  /** Layer ID */
  id: string;
  /** Layer type */
  type: 'fill' | 'line' | 'symbol' | 'raster';
  /** Source data */
  source: string;
  /** Styling configuration */
  paint: {
    fillColor?: string;
    fillOpacity?: number;
    lineColor?: string;
    lineWidth?: number;
    symbolSize?: number;
  };
  /** Visibility */
  visible: boolean;
  /** Minimum zoom level */
  minZoom?: number;
  /** Maximum zoom level */
  maxZoom?: number;
}

/**
 * Performance metrics for map rendering
 */
export interface MapPerformanceMetrics {
  /** Frames per second */
  fps: number;
  /** Frame render time (ms) */
  frameTime: number;
  /** Number of tiles rendered */
  tilesRendered: number;
  /** Number of features rendered */
  featuresRendered: number;
  /** GPU memory usage (bytes) */
  gpuMemoryUsage: number;
  /** Tile cache size */
  tileCacheSize: number;
  /** Translation layer metrics */
  translationMetrics: {
    coordinatesTranslated: number;
    cacheHitRatio: number;
    batchProcessingTime: number;
  };
}

/**
 * Advanced WebGPU-powered map engine
 * Provides complete mapping functionality with tile management, layers, and interaction
 */
export class WebGPUMapEngine {
  private device: GPUDevice;
  private canvas: HTMLCanvasElement;
  private context: GPUCanvasContext;
  private config: Required<MapConfig>;
  
  // Core systems
  private translationLayer: WebGPUTranslationLayer;
  private hiddenBuffer: HiddenBufferIntegration;
  
  // Map state
  private transform: MapTransform;
  private viewport: ViewportBounds;
  private layers: Map<string, MapLayerDefinition> = new Map();
  private tiles: Map<string, MapTile> = new Map();
    // Rendering pipeline
  private renderPipeline: GPURenderPipeline | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  
  // Test pattern buffers (persistent)
  private testVertexBuffer: GPUBuffer | null = null;
  private testIndexBuffer: GPUBuffer | null = null;
  
  // Performance tracking
  private performanceMetrics: MapPerformanceMetrics;
  private lastFrameTime = 0;
  private frameCount = 0;
  
  // Interaction state
  private isDragging = false;
  private lastMousePosition: Point | null = null;
  private isInitialized = false;
  constructor(device: GPUDevice, canvas: HTMLCanvasElement, config: Partial<MapConfig> = {}) {
    this.device = device;
    this.canvas = canvas;
      // CRITICAL DEBUGGING: Check if canvas is valid
    console.log(`🔧 MAP ENGINE Constructor called`);
    console.log(`🔧 MAP ENGINE: Received device:`, device);
    console.log(`🔧 MAP ENGINE: Canvas element:`, canvas);
    console.log(`🔧 MAP ENGINE: Canvas exists:`, !!canvas);
    console.log(`🔧 MAP ENGINE: Canvas ID: ${canvas?.id || 'NO ID'}`);
    console.log(`🔧 MAP ENGINE: Canvas tagName: ${canvas?.tagName || 'NO TAG'}`);
    console.log(`🔧 MAP ENGINE: Canvas parent:`, canvas?.parentElement);
    
    // CRITICAL: Check for canvas ID conflict
    if (canvas?.id !== 'mapCanvas') {
      console.error(`❌ MAP ENGINE: WRONG CANVAS! Expected 'mapCanvas', got '${canvas?.id}'`);
      console.error(`❌ This explains why the map renders to the wrong canvas!`);
      throw new Error(`Canvas ID mismatch: expected 'mapCanvas', got '${canvas?.id}'`);
    }
    
    if (!canvas) {
      throw new Error('❌ MAP ENGINE: No canvas provided to constructor!');
    }
    
    if (canvas.tagName !== 'CANVAS') {
      throw new Error(`❌ MAP ENGINE: Element is not a canvas! Got: ${canvas.tagName}`);
    }
    
    // Get WebGPU context
    const context = canvas.getContext('webgpu');
    if (!context) {
      throw new Error('Failed to get WebGPU context from canvas');
    }
    this.context = context;
    
    console.log(`🔧 MAP ENGINE: Got WebGPU context:`, context);
    
    // Apply default configuration
    this.config = {
      center: config.center ?? { lng: -122.4194, lat: 37.7749 }, // San Francisco
      zoom: config.zoom ?? 10,
      bearing: config.bearing ?? 0,
      pitch: config.pitch ?? 0,
      minZoom: config.minZoom ?? 0,
      maxZoom: config.maxZoom ?? 22,
      tileSize: config.tileSize ?? 512,
      maxTileCacheSize: config.maxTileCacheSize ?? 256,
      enableInteraction: config.enableInteraction ?? true,
      enablePerformanceMonitoring: config.enablePerformanceMonitoring ?? true
    };
    
    // Initialize map state
    this.transform = {
      center: this.config.center,
      zoom: this.config.zoom,
      bearing: this.config.bearing,
      pitch: this.config.pitch
    };
    
    this.viewport = this.calculateViewportBounds();
      // Initialize translation layer
    this.translationLayer = new WebGPUTranslationLayer(device, canvas, {
      cacheSize: 50000,
      batchSize: 10000,
      enableCompute: false, // Disable to avoid buffer mapping conflicts
      precision: {
        threshold: 1e-8,
        useHighPrecision: true
      }
    });
    
    // Initialize hidden buffer for feature picking
    this.hiddenBuffer = new HiddenBufferIntegration(
      device,
      canvas,
      this.translationLayer,
      {
        width: canvas.width,
        height: canvas.height,
        enableMultiTarget: true,
        enableDepthTest: true
      }
    );
    
    // Initialize performance metrics
    this.performanceMetrics = {
      fps: 0,
      frameTime: 0,
      tilesRendered: 0,
      featuresRendered: 0,
      gpuMemoryUsage: 0,
      tileCacheSize: 0,
      translationMetrics: {
        coordinatesTranslated: 0,
        cacheHitRatio: 0,
        batchProcessingTime: 0
      }
    };
    
    // Configure WebGPU context
    this.configureContext();
  }
  
  /**
   * Initialize the map engine
   */
  async initialize(): Promise<void> {
    try {
      // Initialize core systems
      await this.translationLayer.initialize();
      await this.hiddenBuffer.initialize();
      
      // Create render pipeline
      await this.createRenderPipeline();
      await this.createBuffers();
      this.createBindGroup();
      
      // Setup interaction handlers
      if (this.config.enableInteraction) {
        this.setupInteractionHandlers();
      }
      
      // Start render loop
      this.startRenderLoop();
      
      this.isInitialized = true;
      console.log('✅ WebGPU Map Engine initialized successfully');
      
    } catch (error) {
      console.error('❌ Failed to initialize WebGPU Map Engine:', error);
      throw error;
    }
  }
  /**
   * Configure the WebGPU canvas context
   */
  private configureContext(): void {
    // Check canvas dimensions first!
    console.log(`🖼️ MAP ENGINE Canvas actual size: ${this.canvas.width}x${this.canvas.height}`);
    console.log(`🖼️ MAP ENGINE Canvas client size: ${this.canvas.clientWidth}x${this.canvas.clientHeight}`);
    console.log(`🖼️ MAP ENGINE Canvas ID: ${this.canvas.id}`);
    console.log(`🖼️ MAP ENGINE Canvas class: ${this.canvas.className}`);
    console.log(`🖼️ MAP ENGINE Canvas style: width=${this.canvas.style.width}, height=${this.canvas.style.height}`);
    
    if (this.canvas.width === 0 || this.canvas.height === 0) {
      console.error('❌ Canvas has zero dimensions! This will prevent rendering.');
      // Force a reasonable size
      this.canvas.width = 800;
      this.canvas.height = 600;
      console.log(`🔧 Forced canvas size to: ${this.canvas.width}x${this.canvas.height}`);
    }
      this.context.configure({
      device: this.device,
      format: 'bgra8unorm',
      alphaMode: 'opaque' // Change from 'premultiplied' to 'opaque' to debug alpha issues
    });
    
    console.log(`✅ WebGPU context configured for ${this.canvas.width}x${this.canvas.height} canvas with OPAQUE alpha`);
  }
  
  /**
   * Create the main render pipeline for map rendering
   */
  private async createRenderPipeline(): Promise<void> {    // Vertex shader for map geometry - simplified without uniforms
    const vertexShaderCode = `
      struct VertexInput {
        @location(0) position: vec2<f32>,
        @location(1) color: vec4<f32>,
        @location(2) texCoord: vec2<f32>,
      }
      
      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) color: vec4<f32>,
        @location(1) texCoord: vec2<f32>,
        @location(2) worldPos: vec2<f32>,
      }
      
      @vertex
      fn vs_main(input: VertexInput) -> VertexOutput {
        var output: VertexOutput;
        
        // Input position is already in clip space from translation layer
        // Just pass it through directly without additional matrix transforms
        output.position = vec4<f32>(input.position, 0.0, 1.0);
        
        // Pass through attributes
        output.color = input.color;
        output.texCoord = input.texCoord;
        output.worldPos = input.position;
        
        return output;
      }
    `;      // Fragment shader for map rendering - NOW USING VERTEX COLORS
    const fragmentShaderCode = `
      struct FragmentInput {
        @location(0) color: vec4<f32>,
        @location(1) texCoord: vec2<f32>,
        @location(2) worldPos: vec2<f32>,
      }      @fragment
      fn fs_main(input: FragmentInput) -> @location(0) vec4<f32> {
        // Use vertex colors for proper map rendering
        return input.color;
      }
    `;
    
    // Create shader modules
    const vertexShaderModule = this.device.createShaderModule({
      label: 'Map Vertex Shader',
      code: vertexShaderCode
    });
    
    const fragmentShaderModule = this.device.createShaderModule({
      label: 'Map Fragment Shader',
      code: fragmentShaderCode
    });
    
    // Vertex buffer layout
    const vertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: 32, // 2 floats position + 4 floats color + 2 floats texCoord
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
        },
        {
          // Texture coordinates
          format: 'float32x2',
          offset: 24,
          shaderLocation: 2
        }
      ]
    };    // Create render pipeline
    this.renderPipeline = this.device.createRenderPipeline({
      label: 'Map Render Pipeline',
      layout: 'auto',
      vertex: {
        module: vertexShaderModule,
        entryPoint: 'vs_main',
        buffers: [vertexBufferLayout]
      },
      fragment: {
        module: fragmentShaderModule,
        entryPoint: 'fs_main',
        targets: [{
          format: 'bgra8unorm'
          // Remove ALL blending to see if that's the issue
          // blend: {
          //   color: {
          //     srcFactor: 'src-alpha',
          //     dstFactor: 'one-minus-src-alpha'
          //   },
          //   alpha: {
          //     srcFactor: 'one',
          //     dstFactor: 'one-minus-src-alpha'
          //   }
          // }
        }]      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none', // Allow double-sided rendering
        frontFace: 'ccw' // Explicitly set front face
      }
      // Remove depthStencil configuration to match render pass
    });
      console.log('🔧 Created render pipeline with auto layout (NO BLENDING)');
  }
  
  /**
   * Create GPU buffers for map rendering
   */
  private async createBuffers(): Promise<void> {
    // Large vertex buffer for map geometry
    this.vertexBuffer = this.device.createBuffer({
      label: 'Map Vertex Buffer',
      size: 1024 * 1024 * 4, // 4MB vertex buffer
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    
    // Large index buffer for triangles
    this.indexBuffer = this.device.createBuffer({
      label: 'Map Index Buffer',
      size: 1024 * 1024 * 2, // 2MB index buffer
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
    });
    
    // Uniform buffer for map parameters
    this.uniformBuffer = this.device.createBuffer({
      label: 'Map Uniform Buffer',
      size: 256, // Room for matrices and parameters
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    
    // Create persistent test pattern buffers
    this.createTestPatternBuffers();
  }
  /**
   * Create persistent test pattern buffers
   */
  private createTestPatternBuffers(): void {
    // Create a MUCH more visible test pattern that covers the whole screen
    const testVertices = new Float32Array([
      // Position (x, y), Color (r, g, b, a), TexCoord (u, v)
      -0.8, -0.8,  1.0, 0.0, 0.0, 1.0,  0.0, 0.0,  // Bottom-left (bright red)
       0.8, -0.8,  0.0, 1.0, 0.0, 1.0,  1.0, 0.0,  // Bottom-right (bright green)
       0.8,  0.8,  0.0, 0.0, 1.0, 1.0,  1.0, 1.0,  // Top-right (bright blue)
      -0.8,  0.8,  1.0, 1.0, 0.0, 1.0,  0.0, 1.0   // Top-left (bright yellow)
    ]);
    
    const testIndices = new Uint32Array([
      0, 1, 2,  // First triangle
      0, 2, 3   // Second triangle
    ]);
    
    this.testVertexBuffer = this.device.createBuffer({
      label: 'Test Pattern Vertex Buffer',
      size: testVertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    
    this.testIndexBuffer = this.device.createBuffer({
      label: 'Test Pattern Index Buffer',
      size: testIndices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
    });
    
    // Upload test pattern data once
    this.device.queue.writeBuffer(this.testVertexBuffer, 0, testVertices);
    this.device.queue.writeBuffer(this.testIndexBuffer, 0, testIndices);
    
    console.log('🎯 Created LARGE test pattern buffers (±0.8 coordinates - should fill most of screen)');
    console.log('🎯 Test vertices:', Array.from(testVertices));
    console.log('🎯 Test indices:', Array.from(testIndices));
  }
    /**
   * Create bind group for rendering
   */
  private createBindGroup(): void {
    if (!this.renderPipeline || !this.uniformBuffer) {
      throw new Error('Cannot create bind group: required resources not initialized');
    }
    
    const bindGroupLayout = this.renderPipeline.getBindGroupLayout(0);
    
    // Check if bind group layout expects any bindings
    console.log('🔧 Creating bind group for layout with auto layout');
    
    // For shaders without uniforms, the layout will be empty
    this.bindGroup = this.device.createBindGroup({
      label: 'Map Bind Group',
      layout: bindGroupLayout,
      entries: [] // Empty entries since shader has no uniforms
    });
  }
  
  /**
   * Setup interaction handlers for map navigation
   */
  private setupInteractionHandlers(): void {
    // Mouse wheel for zoom
    this.canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      const delta = -event.deltaY * 0.01;
      this.setZoom(this.transform.zoom + delta);
    });
    
    // Mouse drag for pan
    this.canvas.addEventListener('mousedown', (event) => {
      this.isDragging = true;
      this.lastMousePosition = { x: event.clientX, y: event.clientY };
      this.canvas.style.cursor = 'grabbing';
    });
    
    this.canvas.addEventListener('mousemove', (event) => {
      if (this.isDragging && this.lastMousePosition) {
        const deltaX = event.clientX - this.lastMousePosition.x;
        const deltaY = event.clientY - this.lastMousePosition.y;
        
        // Convert screen delta to world delta
        const scale = Math.pow(2, this.transform.zoom);
        const worldDeltaX = -deltaX / (scale * this.canvas.width) * 360;
        const worldDeltaY = deltaY / (scale * this.canvas.height) * 180;
        
        this.panTo({
          lng: this.transform.center.lng + worldDeltaX,
          lat: this.transform.center.lat + worldDeltaY
        });
        
        this.lastMousePosition = { x: event.clientX, y: event.clientY };
      }
    });
    
    this.canvas.addEventListener('mouseup', () => {
      this.isDragging = false;
      this.lastMousePosition = null;
      this.canvas.style.cursor = 'grab';
    });
    
    this.canvas.addEventListener('mouseleave', () => {
      this.isDragging = false;
      this.lastMousePosition = null;
      this.canvas.style.cursor = 'default';
    });
    
    // Click for feature picking
    this.canvas.addEventListener('click', async (event) => {
      const rect = this.canvas.getBoundingClientRect();
      const screenPoint = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      };
      
      const pickedFeature = await this.hiddenBuffer.pickFeature(screenPoint);
      if (pickedFeature) {
        console.log('Picked feature:', pickedFeature);
        // Emit custom event for feature selection
        this.canvas.dispatchEvent(new CustomEvent('featurePicked', {
          detail: pickedFeature
        }));
      }
    });
    
    // Initialize cursor
    this.canvas.style.cursor = 'grab';
  }
  
  /**
   * Start the render loop
   */
  private startRenderLoop(): void {
    const renderFrame = (timestamp: number) => {
      if (this.config.enablePerformanceMonitoring) {
        this.updatePerformanceMetrics(timestamp);
      }
      
      this.render();
      requestAnimationFrame(renderFrame);
    };
    
    requestAnimationFrame(renderFrame);
  }
  
  /**
   * Update performance metrics
   */
  private updatePerformanceMetrics(timestamp: number): void {
    if (this.lastFrameTime > 0) {
      this.performanceMetrics.frameTime = timestamp - this.lastFrameTime;
      this.frameCount++;
      
      // Update FPS every second
      if (this.frameCount >= 60) {
        this.performanceMetrics.fps = Math.round(1000 / this.performanceMetrics.frameTime);
        this.frameCount = 0;
      }
    }
    
    this.lastFrameTime = timestamp;
    
    // Update other metrics
    this.performanceMetrics.tileCacheSize = this.tiles.size;
    this.performanceMetrics.gpuMemoryUsage = this.estimateGPUMemoryUsage();
    
    // Get translation layer metrics
    const translationMetrics = this.translationLayer.getMetrics();
    this.performanceMetrics.translationMetrics = {
      coordinatesTranslated: translationMetrics.translationsPerFrame,
      cacheHitRatio: translationMetrics.cacheHitRatio,
      batchProcessingTime: 0 // Will be updated during rendering
    };
  }
    /**
   * Main render function
   */
  private async render(): Promise<void> {
    if (!this.renderPipeline || !this.bindGroup) return;
    
    // CRITICAL: Only render if our canvas is visible and in the DOM
    if (!this.canvas.isConnected || this.canvas.offsetParent === null) {
      if (this.frameCount === 0) {
        console.log(`⏸️ MAP ENGINE: Canvas not visible/connected, skipping render`);
      }
      return;
    }
    
    // CRITICAL: Verify we're using the right canvas
    if (this.canvas.id !== 'mapCanvas') {
      console.error(`❌ MAP ENGINE: Wrong canvas! Expected 'mapCanvas', got '${this.canvas.id}'`);
      return;
    }
    
    try {
      // Update uniform buffer with current transform
      this.updateUniformBuffer();
      
      // Update visible tiles
      await this.updateVisibleTiles();
        // Prepare render data
      const renderData = await this.prepareRenderData();
      
      // Create command encoder (always create, even if no data)
      const commandEncoder = this.device.createCommandEncoder({
        label: 'Map Render Commands'
      });      // Begin render pass with proper map background
      const renderPass = commandEncoder.beginRenderPass({
        label: 'Map Render Pass',
        colorAttachments: [{
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0.85, g: 0.90, b: 0.95, a: 1.0 }, // Light blue-gray map background
          loadOp: 'clear',
          storeOp: 'store'
        }]
      });
        if (this.frameCount === 0) {
        const currentTexture = this.context.getCurrentTexture();
        console.log(`🖼️ Current texture size: ${currentTexture.width}x${currentTexture.height}`);
        console.log(`🖼️ Current texture format: ${currentTexture.format}`);
        console.log(`🔧 DEVICE CHECK: Using device:`, this.device);
        console.log(`🔧 CONTEXT CHECK: Using context:`, this.context);
      }// Set pipeline and bindings
      renderPass.setPipeline(this.renderPipeline);
      renderPass.setBindGroup(0, this.bindGroup);
        // Add viewport debugging
      if (this.frameCount === 0) {
        console.log('🔍 Render pass viewport debugging:');
        console.log(`🔍 Canvas dimensions: ${this.canvas.width}x${this.canvas.height}`);
        console.log('🔍 No explicit viewport set - using full texture');
      }
        // SKIP test pattern and focus only on map features for debugging
      // if (this.frameCount === 0) {
      //   console.log(`🔧 Rendering test pattern for debugging`);
      // }
      // await this.renderTestPattern(renderPass);
      
      // Focus ONLY on map feature rendering
      if (this.frameCount === 0) {
        console.log(`🔧 SKIPPING test pattern - focusing only on map features`);
      }
        // Then render feature data if available
      if (renderData.vertexCount > 0 && this.vertexBuffer && this.indexBuffer) {        if (this.frameCount === 0) {
          console.log(`🎨 Rendering ${renderData.featureCount} features with ${renderData.indexCount} indices`);
          console.log(`🎨 Setting vertex buffer: size: ${this.vertexBuffer.size}`);
          console.log(`🎨 Setting index buffer: size: ${this.indexBuffer.size}`);
        }
        
        // CRITICAL: Make sure we're using the SAME pipeline as test pattern
        renderPass.setPipeline(this.renderPipeline);
        renderPass.setBindGroup(0, this.bindGroup);
        renderPass.setVertexBuffer(0, this.vertexBuffer);
        renderPass.setIndexBuffer(this.indexBuffer, 'uint32');
        
        // Draw all geometry
        if (renderData.indexCount > 0) {
          if (this.frameCount === 0) {
            console.log(`🎨 About to call drawIndexed(${renderData.indexCount})`);
            console.log(`🎨 First few vertex buffer values should contain world polygon...`);
          }
          
          renderPass.drawIndexed(renderData.indexCount);
          
          if (this.frameCount === 0) {
            console.log(`✅ Drew ${renderData.indexCount} indices - WORLD POLYGON SHOULD BE VISIBLE`);
            console.log(`✅ If you don't see red covering most of the screen, there's a WebGPU driver issue`);
          }
        }
      } else {
        if (this.frameCount === 0) {
          console.log(`⏭️ Skipping feature rendering: vertexCount=${renderData.vertexCount}, vertexBuffer=${!!this.vertexBuffer}, indexBuffer=${!!this.indexBuffer}`);
        }
      }      renderPass.end();
      
      // CRITICAL DEBUG: Check if command buffer submission actually works
      const commandBuffer = commandEncoder.finish();
      console.log(`🚀 MAP ENGINE: About to submit command buffer:`, commandBuffer);
      this.device.queue.submit([commandBuffer]);
      console.log(`🚀 MAP ENGINE: Command buffer submitted successfully`);
      
      // Update performance metrics
      this.performanceMetrics.featuresRendered = renderData.featureCount;
      
    } catch (error) {
      console.error('❌ Render error:', error);
    }
  }
    /**
   * Clear the screen
   */
  private clearScreen(): void {
    const commandEncoder = this.device.createCommandEncoder();
    
    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.2, g: 0.3, b: 0.4, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store'
      }]
    });
    
    renderPass.end();
    this.device.queue.submit([commandEncoder.finish()]);
  }  /**
   * Render a simple test pattern when no data is available
   */
  private async renderTestPattern(renderPass: GPURenderPassEncoder): Promise<void> {
    if (!this.testVertexBuffer || !this.testIndexBuffer) {
      if (this.frameCount === 0) {
        console.log('❌ Test pattern buffers not available');
      }
      return;
    }
    
    // Render the test pattern using persistent buffers
    if (this.renderPipeline && this.bindGroup) {
      try {
        renderPass.setPipeline(this.renderPipeline);
        renderPass.setBindGroup(0, this.bindGroup);
        renderPass.setVertexBuffer(0, this.testVertexBuffer);
        renderPass.setIndexBuffer(this.testIndexBuffer, 'uint32');
        
        if (this.frameCount === 0) {
          console.log('🎯 Drawing test pattern...');
          console.log('🎯 Vertex data:', Array.from(new Float32Array([
            -0.5, -0.5,  1.0, 0.0, 0.0, 1.0,  0.0, 0.0,
             0.5, -0.5,  0.0, 1.0, 0.0, 1.0,  1.0, 0.0,
             0.5,  0.5,  0.0, 0.0, 1.0, 1.0,  1.0, 1.0,
            -0.5,  0.5,  1.0, 1.0, 0.0, 1.0,  0.0, 1.0
          ])));
        }
        
        renderPass.drawIndexed(6); // 6 indices for 2 triangles
        
        if (this.frameCount === 0) {
          console.log('🎯 ✅ Test pattern rendered - you should see a BRIGHT RED square!');
        }
      } catch (error) {
        console.error('❌ Error during test pattern rendering:', error);
      }
    } else {
      console.log('❌ Pipeline or bind group not available for test pattern');
    }
  }
  
  /**
   * Update uniform buffer with current map state
   */
  private updateUniformBuffer(): void {
    if (!this.uniformBuffer) return;
    
    const aspectRatio = this.canvas.width / this.canvas.height;
    
    // Create transformation matrices
    const projectionMatrix = MatrixUtils.createPerspectiveMatrix(
      Math.PI / 4, aspectRatio, 0.1, 1000
    );
    
    const viewMatrix = MatrixUtils.createViewMatrix(
      [0, 0, 5], [0, 0, 0], [0, 1, 0]
    );
    
    const modelMatrix = MatrixUtils.createMapTransformMatrix(
      this.transform.center.lng,
      this.transform.center.lat,
      this.transform.zoom,
      this.transform.bearing,
      this.transform.pitch,
      aspectRatio
    );
    
    // Pack uniform data
    const uniformData = new Float32Array(64); // 256 bytes
    
    // Matrices (16 floats each)
    uniformData.set(projectionMatrix, 0);
    uniformData.set(viewMatrix, 16);
    uniformData.set(modelMatrix, 32);
    
    // Map parameters
    uniformData[48] = this.transform.center.lng;
    uniformData[49] = this.transform.center.lat;
    uniformData[50] = this.transform.zoom;
    uniformData[51] = this.transform.bearing;
    uniformData[52] = this.transform.pitch;
    uniformData[53] = aspectRatio;
    uniformData[54] = performance.now() * 0.001; // time
    uniformData[55] = 0; // padding
    
    // Upload to GPU
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);
    
    // Update translation layer
    this.translationLayer.updateTransform(this.transform);
  }
  
  /**
   * Calculate viewport bounds in geographic coordinates
   */
  private calculateViewportBounds(): ViewportBounds {
    const aspectRatio = this.canvas.width / this.canvas.height;
    const scale = Math.pow(2, this.transform.zoom);
    
    // Calculate half-extents in world coordinates
    const halfWidth = 1 / scale * aspectRatio;
    const halfHeight = 1 / scale;
    
    // Convert center to world coordinates
    const centerWorld = this.lngLatToWorldCoords(this.transform.center);
    
    // Calculate bounds
    const minWorld = {
      x: centerWorld.x - halfWidth,
      y: centerWorld.y - halfHeight
    };
    
    const maxWorld = {
      x: centerWorld.x + halfWidth,
      y: centerWorld.y + halfHeight
    };
    
    // Convert back to geographic coordinates
    const min = this.worldCoordsToLngLat(minWorld);
    const max = this.worldCoordsToLngLat(maxWorld);
    
    return { min, max };
  }
  
  /**
   * Convert lng/lat to normalized world coordinates [0,1]
   */
  private lngLatToWorldCoords(lngLat: LngLat): Point {
    const x = (lngLat.lng + 180) / 360;
    const lat = Math.max(-85.0511, Math.min(85.0511, lngLat.lat));
    const latRad = lat * Math.PI / 180;
    const y = (1 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI) / 2;
    
    return { x, y };
  }
  
  /**
   * Convert normalized world coordinates to lng/lat
   */
  private worldCoordsToLngLat(world: Point): LngLat {
    const lng = world.x * 360 - 180;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * world.y)));
    const lat = latRad * 180 / Math.PI;
    
    return { lng, lat };
  }  /**
   * Update visible tiles based on current viewport
   */
  private async updateVisibleTiles(): Promise<void> {
    const zoom = Math.floor(this.transform.zoom);
    const viewport = this.calculateViewportBounds();
    
    // Only log tiles update once per second to avoid spam
    if (this.frameCount === 0) {
      console.log(`🗺️ Updating tiles for zoom ${zoom}, viewport: ${viewport.min.lng.toFixed(3)},${viewport.min.lat.toFixed(3)} to ${viewport.max.lng.toFixed(3)},${viewport.max.lat.toFixed(3)}`);
    }// Calculate tile bounds for current zoom level
    const tileSize = Math.pow(2, zoom);
    
    // Web Mercator tile calculation - FIXED
    const minTileX = Math.max(0, Math.floor((viewport.min.lng + 180) / 360 * tileSize));
    const maxTileX = Math.min(tileSize - 1, Math.floor((viewport.max.lng + 180) / 360 * tileSize));
    
    // For latitude, use proper Web Mercator formula (note: Y increases northward in geo, but southward in tiles)
    const lat2rad = (lat: number) => lat * Math.PI / 180;
    const lat2tile = (lat: number, zoom: number) => {
      const n = Math.pow(2, zoom);
      return Math.floor((1 - Math.asinh(Math.tan(lat2rad(lat))) / Math.PI) / 2 * n);
    };
    
    const minTileY = Math.max(0, lat2tile(viewport.max.lat, zoom)); // max lat -> min tile Y
    const maxTileY = Math.min(tileSize - 1, lat2tile(viewport.min.lat, zoom)); // min lat -> max tile Y
      console.log(`📊 Tile bounds: X(${minTileX}-${maxTileX}), Y(${minTileY}-${maxTileY})`);
    
    // Ensure we have valid tile bounds
    if (minTileX > maxTileX || minTileY > maxTileY) {
      if (this.frameCount === 0) {
        console.warn(`⚠️ Invalid tile bounds - forcing creation of at least one tile`);
      }
      
      // Force create at least one tile at the center
      const centerTileX = Math.floor((this.transform.center.lng + 180) / 360 * tileSize);
      const centerTileY = lat2tile(this.transform.center.lat, zoom);
      const tileKey = `${zoom}/${centerTileX}/${centerTileY}`;
      
      if (!this.tiles.has(tileKey)) {
        console.log(`� Creating forced center tile: ${tileKey}`);
        const tile = await this.createTile({ z: zoom, x: centerTileX, y: centerTileY });
        this.tiles.set(tileKey, tile);
        console.log(`✅ Created forced tile ${tileKey} with ${tile.features.length} features`);
      }
      
      this.performanceMetrics.tilesRendered = 1;
      return;
    }
    
    // Load visible tiles
    const neededTiles: string[] = [];
    let tilesCreated = 0;
    
    for (let x = minTileX; x <= maxTileX; x++) {
      for (let y = minTileY; y <= maxTileY; y++) {
        const tileKey = `${zoom}/${x}/${y}`;
        neededTiles.push(tileKey);
        
        if (!this.tiles.has(tileKey)) {
          console.log(`🔄 Creating new tile: ${tileKey}`);
          
          // Create new tile
          const tile = await this.createTile({ z: zoom, x, y });
          this.tiles.set(tileKey, tile);
          tilesCreated++;
          
          console.log(`✅ Created tile ${tileKey} with ${tile.features.length} features`);
        } else {
          console.log(`♻️ Reusing existing tile: ${tileKey}`);
        }
      }
    }
    
    console.log(`📦 Total tiles: ${this.tiles.size}, Created: ${tilesCreated}, Needed: ${neededTiles.length}`);
    
    // Remove tiles that are no longer visible (basic LRU)
    if (this.tiles.size > this.config.maxTileCacheSize) {
      const tilesToRemove = Array.from(this.tiles.keys())
        .filter(key => !neededTiles.includes(key))
        .slice(0, this.tiles.size - this.config.maxTileCacheSize);
      
      tilesToRemove.forEach(key => {
        console.log(`🗑️ Removing tile: ${key}`);
        this.tiles.delete(key);
      });
    }
    
    this.performanceMetrics.tilesRendered = neededTiles.length;
  }
  
  /**
   * Create a new map tile with sample data
   */
  private async createTile(coord: TileCoordinate): Promise<MapTile> {
    const tile: MapTile = {
      coord,
      bounds: this.calculateTileBounds(coord),
      features: [],
      loading: true,
      error: undefined
    };
    
    try {
      // Generate sample features for this tile
      tile.features = this.generateSampleFeatures(tile.bounds, coord.z);
      
      // Generate render data
      tile.renderData = await this.generateTileRenderData(tile.features);
      
      tile.loading = false;
      
    } catch (error) {
      tile.error = error instanceof Error ? error.message : 'Unknown error';
      tile.loading = false;
    }
    
    return tile;
  }
  
  /**
   * Calculate geographic bounds for a tile
   */
  private calculateTileBounds(coord: TileCoordinate): ViewportBounds {
    const tileSize = Math.pow(2, coord.z);
    
    const minLng = (coord.x / tileSize) * 360 - 180;
    const maxLng = ((coord.x + 1) / tileSize) * 360 - 180;
    
    const minLatRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (coord.y + 1) / tileSize)));
    const maxLatRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * coord.y / tileSize)));
    
    const minLat = minLatRad * 180 / Math.PI;
    const maxLat = maxLatRad * 180 / Math.PI;
    
    return {
      min: { lng: minLng, lat: minLat },
      max: { lng: maxLng, lat: maxLat }
    };
  }  /**
   * Generate sample features for a tile
   */
  private generateSampleFeatures(bounds: ViewportBounds, zoom: number): Feature[] {
    const features: Feature[] = [];
    
    // Ocean background (world-spanning)
    const oceanPolygon: PolygonFeature = {
      id: 'ocean_background',
      type: 'polygon', 
      geometry: [[
        { lng: -180, lat: -85 },
        { lng: 180, lat: -85 },
        { lng: 180, lat: 85 },
        { lng: -180, lat: 85 },
        { lng: -180, lat: -85 }
      ]],
      properties: {
        area: 'ocean',
        color: '#4A90E2', // Ocean blue
        layer: 'background'
      }
    };
    features.push(oceanPolygon);
    
    // Major landmasses
    const landmasses = [
      // North America
      {
        id: 'north_america',
        geometry: [[
          { lng: -170, lat: 70 }, { lng: -50, lat: 70 }, { lng: -50, lat: 15 },
          { lng: -80, lat: 5 }, { lng: -110, lat: 15 }, { lng: -170, lat: 25 },
          { lng: -170, lat: 70 }
        ]],
        color: '#8FBC8F' // Light green
      },
      // South America
      {
        id: 'south_america',
        geometry: [[
          { lng: -80, lat: 15 }, { lng: -35, lat: 15 }, { lng: -45, lat: -55 },
          { lng: -75, lat: -55 }, { lng: -80, lat: 15 }
        ]],
        color: '#90EE90' // Light green
      },
      // Europe
      {
        id: 'europe',
        geometry: [[
          { lng: -10, lat: 70 }, { lng: 40, lat: 70 }, { lng: 40, lat: 35 },
          { lng: -10, lat: 35 }, { lng: -10, lat: 70 }
        ]],
        color: '#98FB98' // Pale green
      },
      // Africa
      {
        id: 'africa',
        geometry: [[
          { lng: -20, lat: 35 }, { lng: 50, lat: 35 }, { lng: 40, lat: -35 },
          { lng: 15, lat: -35 }, { lng: -20, lat: 35 }
        ]],
        color: '#F4A460' // Sandy brown
      },
      // Asia
      {
        id: 'asia',
        geometry: [[
          { lng: 40, lat: 75 }, { lng: 180, lat: 75 }, { lng: 180, lat: 10 },
          { lng: 40, lat: 10 }, { lng: 40, lat: 75 }
        ]],
        color: '#DDA0DD' // Plum
      },
      // Australia
      {
        id: 'australia',
        geometry: [[
          { lng: 110, lat: -10 }, { lng: 155, lat: -10 }, { lng: 155, lat: -45 },
          { lng: 110, lat: -45 }, { lng: 110, lat: -10 }
        ]],
        color: '#CD853F' // Peru
      }
    ];
    
    landmasses.forEach(land => {
      const polygon: PolygonFeature = {
        id: land.id,
        type: 'polygon',
        geometry: land.geometry,
        properties: {
          area: land.id,
          color: land.color,
          layer: 'landmass'
        }
      };
      features.push(polygon);
    });
    
    // Major cities (if zoom level is appropriate)
    if (zoom >= 4) {
      const cities = [
        { name: 'New York', lng: -74.006, lat: 40.7128, size: 8 },
        { name: 'London', lng: -0.1276, lat: 51.5074, size: 7 },
        { name: 'Tokyo', lng: 139.6917, lat: 35.6895, size: 9 },
        { name: 'Sydney', lng: 151.2093, lat: -33.8688, size: 6 },
        { name: 'São Paulo', lng: -46.6333, lat: -23.5505, size: 8 },
        { name: 'Cairo', lng: 31.2357, lat: 30.0444, size: 7 },
        { name: 'Mumbai', lng: 72.8777, lat: 19.0760, size: 8 },
        { name: 'Los Angeles', lng: -118.2437, lat: 34.0522, size: 7 }
      ];
      
      cities.forEach(city => {
        if (city.lng >= bounds.min.lng && city.lng <= bounds.max.lng &&
            city.lat >= bounds.min.lat && city.lat <= bounds.max.lat) {
          const cityPoint: PointFeature = {
            id: `city_${city.name.toLowerCase().replace(' ', '_')}`,
            type: 'point',
            geometry: { lng: city.lng, lat: city.lat },
            properties: {
              name: city.name,
              size: city.size,
              color: '#FF6B35', // Orange for cities
              layer: 'cities'
            }
          };
          features.push(cityPoint);
        }
      });
    }
    
    // Country borders (if zoom level is appropriate)
    if (zoom >= 3) {
      const borders = [
        // US-Canada border
        {
          id: 'us_canada_border',
          geometry: [
            { lng: -140, lat: 60 }, { lng: -90, lat: 49 }, { lng: -67, lat: 45 }
          ],
          color: '#FF4444'
        },
        // US-Mexico border
        {
          id: 'us_mexico_border',
          geometry: [
            { lng: -117, lat: 32.5 }, { lng: -106, lat: 31.8 }, { lng: -97, lat: 25.8 }
          ],
          color: '#FF4444'
        }
      ];
      
      borders.forEach(border => {
        const borderLine: LineStringFeature = {
          id: border.id,
          type: 'linestring',
          geometry: border.geometry,
          properties: {
            type: 'border',
            color: border.color,
            width: 2,
            layer: 'borders'
          }
        };
        features.push(borderLine);
      });
    }
    
    console.log(`✅ Generated ${features.length} realistic map features for zoom ${zoom}`);
    return features;
  }
    /**
   * Generate render data for tile features
   */
  private async generateTileRenderData(features: Feature[]): Promise<{
    vertices: Float32Array;
    indices: Uint32Array;
    featureCount: number;
  }> {
    const allVertices: number[] = [];
    const allIndices: number[] = [];
    let vertexOffset = 0;
    
    for (const feature of features) {
      let vertices: Float32Array;
      let indices: Uint32Array;
      
      if (feature.type === 'polygon') {
        const result = await this.generatePolygonRenderData(feature as PolygonFeature);
        vertices = result.vertices;
        indices = result.indices;
      } else if (feature.type === 'point') {
        const result = await this.generatePointRenderData(feature as PointFeature);
        vertices = result.vertices;
        indices = result.indices;
      } else {
        continue; // Skip unsupported types for now
      }
      
      // Add vertices directly - they already contain position + color + texCoord
      for (let i = 0; i < vertices.length; i++) {
        allVertices.push(vertices[i]);
      }
      
      // Add indices with offset
      for (let i = 0; i < indices.length; i++) {
        allIndices.push(indices[i] + vertexOffset);
      }
      
      vertexOffset += vertices.length / 8; // 8 floats per vertex
    }
    
    return {
      vertices: new Float32Array(allVertices),
      indices: new Uint32Array(allIndices),
      featureCount: features.length
    };
  }
  /**
   * Generate render data for polygon features
   */
  private async generatePolygonRenderData(feature: PolygonFeature): Promise<{
    vertices: Float32Array;
    indices: Uint32Array;
  }> {
    const exterior = feature.geometry[0];
    const holes = feature.geometry.slice(1);
    
    // Triangulate polygon
    const triangulation = TriangulationUtils.triangulatePolygon(exterior, holes);
    
    // BYPASS TRANSLATION LAYER - Use simple direct conversion for debugging
    console.log('🔧 BYPASSING translation layer - using direct coordinate conversion');
    
    // Convert lng/lat directly to clip space [-1, 1]
    const vertices = new Float32Array(triangulation.vertices.length / 2 * 8); // 8 floats per vertex
    const featureColor = this.parseFeatureColor(feature);
    
    for (let i = 0; i < triangulation.vertices.length; i += 2) {
      const lng = triangulation.vertices[i];
      const lat = triangulation.vertices[i + 1];
      
      // Simple direct conversion to clip space
      // Normalize longitude to [-1, 1] (longitude range is -180 to 180)
      const clipX = (lng + 180) / 360 * 2 - 1;
      // Normalize latitude to [-1, 1] (latitude range is -90 to 90)  
      const clipY = (lat + 90) / 180 * 2 - 1;
      
      const vertexIndex = (i / 2) * 8;
      
      // Position (clip space)
      vertices[vertexIndex] = clipX;
      vertices[vertexIndex + 1] = clipY;
      
      // Color (RGBA)
      vertices[vertexIndex + 2] = featureColor.r;
      vertices[vertexIndex + 3] = featureColor.g;
      vertices[vertexIndex + 4] = featureColor.b;
      vertices[vertexIndex + 5] = featureColor.a;
      
      // Texture coordinates
      vertices[vertexIndex + 6] = (i % 2);
      vertices[vertexIndex + 7] = Math.floor(i / 2) % 2;
      
      console.log(`🔧 Direct conversion: lng=${lng.toFixed(3)}, lat=${lat.toFixed(3)} -> clip(${clipX.toFixed(3)}, ${clipY.toFixed(3)})`);
    }
    
    console.log(`🔺 Polygon triangulated: ${triangulation.triangles.length / 3} triangles, ${vertices.length / 8} vertices`);
    
    return {
      vertices,
      indices: new Uint32Array(triangulation.triangles)
    };
  }
    /**
   * Generate render data for point features
   */
  private async generatePointRenderData(feature: PointFeature): Promise<{
    vertices: Float32Array;
    indices: Uint32Array;
  }> {
    // BYPASS TRANSLATION LAYER - Use direct coordinate conversion
    const lng = feature.geometry.lng;
    const lat = feature.geometry.lat;
    
    // Convert directly to clip space
    const clipX = (lng + 180) / 360 * 2 - 1;
    const clipY = (lat + 90) / 180 * 2 - 1;
    
    // Create a larger, more visible quad for the point
    const size = (feature.properties?.size as number || 5) * 0.01; // Larger size for visibility
    const featureColor = this.parseFeatureColor(feature);
    
    const vertices = new Float32Array([
      // Position (x, y), Color (r, g, b, a), TexCoord (u, v)
      clipX - size, clipY - size, featureColor.r, featureColor.g, featureColor.b, featureColor.a, 0.0, 0.0,
      clipX + size, clipY - size, featureColor.r, featureColor.g, featureColor.b, featureColor.a, 1.0, 0.0,
      clipX + size, clipY + size, featureColor.r, featureColor.g, featureColor.b, featureColor.a, 1.0, 1.0,
      clipX - size, clipY + size, featureColor.r, featureColor.g, featureColor.b, featureColor.a, 0.0, 1.0
    ]);
    
    const indices = new Uint32Array([
      0, 1, 2,
      0, 2, 3
    ]);
    
    console.log(`📍 Point DIRECT conversion: lng=${lng.toFixed(3)}, lat=${lat.toFixed(3)} -> clip(${clipX.toFixed(3)}, ${clipY.toFixed(3)})`);
    
    return { vertices, indices };
  }
    /**
   * Parse color from feature properties
   */
  private parseFeatureColor(feature: Feature): { r: number; g: number; b: number; a: number } {
    const colorProp = feature.properties?.color;
    
    if (typeof colorProp === 'string') {
      // HSL color parsing
      if (colorProp.startsWith('hsl')) {
        const match = colorProp.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
        if (match) {
          const h = parseInt(match[1]) / 360;
          const s = parseInt(match[2]) / 100;
          const l = parseInt(match[3]) / 100;
          
          const rgb = this.hslToRgb(h, s, l);
          return { r: rgb.r, g: rgb.g, b: rgb.b, a: 1.0 };
        }
      }
      
      // Hex color parsing
      if (colorProp.startsWith('#')) {
        const hex = colorProp.substring(1);
        if (hex.length === 6) {
          const r = parseInt(hex.substring(0, 2), 16) / 255;
          const g = parseInt(hex.substring(2, 4), 16) / 255;
          const b = parseInt(hex.substring(4, 6), 16) / 255;
          return { r, g, b, a: 1.0 };
        }
      }
    }
    
    // Feature type based colors for better visibility
    if (feature.type === 'polygon') {
      // Bright colors for polygons based on properties
      const gridX = feature.properties?.gridX as number || 0;
      const gridY = feature.properties?.gridY as number || 0;
      const hue = ((gridX * 47 + gridY * 31) % 360) / 360;
      return { ...this.hslToRgb(hue, 0.8, 0.6), a: 0.8 };
    } else if (feature.type === 'point') {
      // Bright white/yellow points for visibility
      return { r: 1.0, g: 1.0, b: 0.2, a: 1.0 };
    }
    
    // Default bright color
    return { r: 0.2, g: 0.8, b: 1.0, a: 0.9 };
  }
  
  /**
   * Convert HSL to RGB
   */
  private hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
    let r: number, g: number, b: number;
    
    if (s === 0) {
      r = g = b = l; // achromatic
    } else {
      const hue2rgb = (p: number, q: number, t: number) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1/6) return p + (q - p) * 6 * t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
      };
      
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1/3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1/3);
    }
    
    return { r, g, b };
  }
    /**
   * Prepare all render data for current frame
   */
  private async prepareRenderData(): Promise<{
    vertexCount: number;
    indexCount: number;
    featureCount: number;
  }> {    const allVertices: number[] = [];
    const allIndices: number[] = [];
    let vertexOffset = 0;
    let featureCount = 0;
    
    // Only log once per second to avoid spam
    if (this.frameCount === 0) {
      console.log(`🔄 Preparing render data for ${this.tiles.size} tiles`);
    }
      // Collect render data from all visible tiles
    for (const [tileKey, tile] of this.tiles.entries()) {
      if (!tile.renderData || tile.loading || tile.error) {
        if (this.frameCount === 0) {
          console.log(`⏭️ Skipping tile ${tileKey}: loading=${tile.loading}, error=${tile.error}`);
        }
        continue;
      }
      
      if (this.frameCount === 0) {
        console.log(`📦 Processing tile ${tileKey}: ${tile.renderData.featureCount} features, ${tile.renderData.vertices.length / 8} vertices`);
      }
      
      // Add vertices
      for (let i = 0; i < tile.renderData.vertices.length; i++) {
        allVertices.push(tile.renderData.vertices[i]);
      }
      
      // Add indices with offset
      for (let i = 0; i < tile.renderData.indices.length; i++) {
        allIndices.push(tile.renderData.indices[i] + vertexOffset);
      }
      
      vertexOffset += tile.renderData.vertices.length / 8; // 8 floats per vertex
      featureCount += tile.renderData.featureCount;    }
    
    if (this.frameCount === 0) {
      console.log(`📊 Total render data: ${allVertices.length / 8} vertices, ${allIndices.length} indices, ${featureCount} features`);
    }
      // Upload to GPU buffers
    if (allVertices.length > 0 && this.vertexBuffer) {
      const vertexData = new Float32Array(allVertices);
      this.device.queue.writeBuffer(this.vertexBuffer, 0, vertexData);
        if (this.frameCount === 0) {
        console.log(`⬆️ Uploaded ${allVertices.length} vertex floats to GPU`);
        console.log(`⬆️ First few vertices:`, Array.from(vertexData.slice(0, 16)));
        console.log(`⬆️ World polygon should start with clip(-1.0, -0.944, ...)`);
        
        // Check if colors are actually in the vertex data
        console.log(`⬆️ First vertex: pos(${vertexData[0].toFixed(3)}, ${vertexData[1].toFixed(3)}), color(${vertexData[2].toFixed(3)}, ${vertexData[3].toFixed(3)}, ${vertexData[4].toFixed(3)}, ${vertexData[5].toFixed(3)})`);
        console.log(`⬆️ Second vertex: pos(${vertexData[8].toFixed(3)}, ${vertexData[9].toFixed(3)}), color(${vertexData[10].toFixed(3)}, ${vertexData[11].toFixed(3)}, ${vertexData[12].toFixed(3)}, ${vertexData[13].toFixed(3)})`);
      }
    }
    
    if (allIndices.length > 0 && this.indexBuffer) {
      const indexData = new Uint32Array(allIndices);
      this.device.queue.writeBuffer(this.indexBuffer, 0, indexData);
      
      if (this.frameCount === 0) {
        console.log(`⬆️ Uploaded ${allIndices.length} indices to GPU`);
        console.log(`⬆️ Index pattern:`, Array.from(indexData.slice(0, 12)));
      }
    }
    
    return {
      vertexCount: allVertices.length / 8,
      indexCount: allIndices.length,
      featureCount
    };
  }
  
  /**
   * Estimate GPU memory usage
   */
  private estimateGPUMemoryUsage(): number {
    let usage = 0;
    
    // Buffer sizes
    if (this.vertexBuffer) usage += 1024 * 1024 * 4; // 4MB
    if (this.indexBuffer) usage += 1024 * 1024 * 2; // 2MB
    if (this.uniformBuffer) usage += 256;
    
    // Translation layer memory
    usage += this.translationLayer.getMetrics().gpuMemoryUsage;
    
    // Hidden buffer memory
    usage += this.hiddenBuffer.getRenderStatistics().hiddenBufferMemoryUsage;
    
    return usage;
  }
  
  // Public API methods
  
  /**
   * Pan the map to a new center
   */
  panTo(center: LngLat): void {
    this.transform.center = { ...center };
    this.viewport = this.calculateViewportBounds();
  }
  
  /**
   * Set the map zoom level
   */
  setZoom(zoom: number): void {
    this.transform.zoom = Math.max(
      this.config.minZoom,
      Math.min(this.config.maxZoom, zoom)
    );
    this.viewport = this.calculateViewportBounds();
  }
  
  /**
   * Set the map bearing (rotation)
   */
  setBearing(bearing: number): void {
    this.transform.bearing = bearing % 360;
  }
  
  /**
   * Set the map pitch (tilt)
   */
  setPitch(pitch: number): void {
    this.transform.pitch = Math.max(0, Math.min(60, pitch));
  }
  
  /**
   * Fly to a location with animation
   */
  async flyTo(center: LngLat, zoom?: number, duration: number = 1000): Promise<void> {
    const startCenter = { ...this.transform.center };
    const startZoom = this.transform.zoom;
    const targetZoom = zoom ?? this.transform.zoom;
    const startTime = performance.now();
    
    return new Promise((resolve) => {
      const animate = (currentTime: number) => {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        // Easing function
        const eased = 1 - Math.pow(1 - progress, 3);
        
        // Interpolate position
        this.transform.center = {
          lng: startCenter.lng + (center.lng - startCenter.lng) * eased,
          lat: startCenter.lat + (center.lat - startCenter.lat) * eased
        };
        
        // Interpolate zoom
        this.transform.zoom = startZoom + (targetZoom - startZoom) * eased;
        
        this.viewport = this.calculateViewportBounds();
        
        if (progress < 1) {
          requestAnimationFrame(animate);
        } else {
          resolve();
        }
      };
      
      requestAnimationFrame(animate);
    });
  }
  
  /**
   * Add a layer to the map
   */
  addLayer(layer: MapLayerDefinition): void {
    this.layers.set(layer.id, layer);
  }
  
  /**
   * Remove a layer from the map
   */
  removeLayer(layerId: string): void {
    this.layers.delete(layerId);
  }
  
  /**
   * Get current performance metrics
   */
  getPerformanceMetrics(): MapPerformanceMetrics {
    return { ...this.performanceMetrics };
  }
  
  /**
   * Get current map state
   */
  getMapState(): {
    transform: MapTransform;
    viewport: ViewportBounds;
    layers: MapLayerDefinition[];
    isInitialized: boolean;
  } {
    return {
      transform: { ...this.transform },
      viewport: { ...this.viewport },
      layers: Array.from(this.layers.values()),
      isInitialized: this.isInitialized
    };
  }
    /**
   * Clean up resources
   */
  destroy(): void {
    // Clean up GPU resources
    this.vertexBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.uniformBuffer?.destroy();
    this.testVertexBuffer?.destroy();
    this.testIndexBuffer?.destroy();
    
    // Clean up systems
    this.translationLayer.destroy();
    this.hiddenBuffer.destroy();
    
    // Clear data
    this.tiles.clear();
    this.layers.clear();
    
    console.log('🧹 WebGPU Map Engine destroyed');
  }
    /**
   * Create a tile centered on the current view
   */
  private async createCenterTile(zoom: number): Promise<MapTile> {
    const viewport = this.calculateViewportBounds();
    
    console.log(`🏗️ Creating center tile for zoom ${zoom}`);
    console.log(`📍 Viewport: ${viewport.min.lng.toFixed(3)},${viewport.min.lat.toFixed(3)} to ${viewport.max.lng.toFixed(3)},${viewport.max.lat.toFixed(3)}`);
    
    // Generate features around the center point
    const features = this.generateSampleFeatures(viewport, zoom);
    
    // Generate render data for all features
    const renderData = await this.generateTileRenderData(features);
      return {
      coord: { x: 0, y: 0, z: zoom },
      bounds: viewport,
      features,
      renderData,
      loading: false,
      error: undefined
    };
  }
}