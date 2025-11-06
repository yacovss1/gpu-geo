// WebGPU Translation Layer - TypeScript Implementation
// High-performance coordinate transformation system with GPU acceleration

import { mat4, vec3 } from 'gl-matrix';
import type {
  LngLat,
  Point,
  ClipCoordinates,
  WorldCoordinates,
  WebGPUContext,
  TranslationLayerConfig,
  MapTransform,
  PerformanceMetrics
} from '../../types/core';

/**
 * Result of a single coordinate translation
 */
export interface TranslationResult {
  /** Translated coordinates */
  coordinates: ClipCoordinates;
  /** Whether translation was successful */
  success: boolean;
  /** Error message if translation failed */
  error?: string;
  /** Processing time in milliseconds */
  processingTime: number;
}

/**
 * Result of batch coordinate translation
 */
export interface BatchTranslationResult {
  /** Array of translated coordinates */
  coordinates: ClipCoordinates[];
  /** Number of successful translations */
  successCount: number;
  /** Number of failed translations */
  failureCount: number;
  /** Total processing time in milliseconds */
  processingTime: number;
  /** Cache hit ratio (0-1) */
  cacheHitRatio: number;
}

/**
 * Advanced WebGPU-powered coordinate translation layer
 * Provides high-performance translation between geographic and clip coordinates
 */
export class WebGPUTranslationLayer {
  private device: GPUDevice;
  private canvas: HTMLCanvasElement;
  private context: GPUCanvasContext;
  private config: Required<TranslationLayerConfig>;
  
  // GPU resources
  private computePipeline: GPUComputePipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private inputBuffer: GPUBuffer | null = null;
  private outputBuffer: GPUBuffer | null = null;
  private stagingBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  
  // Transform state
  private currentTransform: MapTransform = {
    center: { lng: 0, lat: 0 },
    zoom: 0,
    bearing: 0,
    pitch: 0
  };
  
  // Performance tracking
  private metrics: PerformanceMetrics = {
    fps: 0,
    frameTime: 0,
    gpuMemoryUsage: 0,
    featureCount: 0,
    cacheHitRatio: 0,
    translationsPerFrame: 0
  };
  
  // Coordinate cache for performance
  private coordinateCache = new Map<string, ClipCoordinates>();
  private cacheHits = 0;
  private cacheMisses = 0;
  
  // High-precision reference point for large coordinate values
  private referencePoint: LngLat = { lng: 0, lat: 0 };
  private referenceWorldPoint: WorldCoordinates = { x: 0, y: 0 };
  
  constructor(device: GPUDevice, canvas: HTMLCanvasElement, config: Partial<TranslationLayerConfig> = {}) {
    this.device = device;
    this.canvas = canvas;
    
    // Get WebGPU context
    const context = canvas.getContext('webgpu');
    if (!context) {
      throw new Error('Failed to get WebGPU context from canvas');
    }
    this.context = context;
      // Apply default configuration
    this.config = {
      cacheSize: config.cacheSize ?? 10000,
      batchSize: config.batchSize ?? 1000,
      enableCompute: config.enableCompute ?? false, // Disable GPU compute for now to avoid buffer issues
      precision: {
        threshold: config.precision?.threshold ?? 1e-10,
        useHighPrecision: config.precision?.useHighPrecision ?? true
      }
    };
    
    // Configure WebGPU context
    this.configureContext();
  }
  
  /**
   * Initialize the translation layer with GPU resources
   */
  async initialize(): Promise<void> {
    try {
      if (this.config.enableCompute) {
        await this.createComputePipeline();
        await this.createBuffers();
        this.createBindGroup();
      }
      
      console.log('✅ WebGPU Translation Layer initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize WebGPU Translation Layer:', error);
      throw error;
    }
  }
  
  /**
   * Configure the WebGPU canvas context
   */
  private configureContext(): void {
    this.context.configure({
      device: this.device,
      format: 'bgra8unorm',
      alphaMode: 'premultiplied'
    });
  }
  
  /**
   * Create the compute shader pipeline for coordinate transformation
   */
  private async createComputePipeline(): Promise<void> {
    const shaderCode = `
      struct Transform {
        projectionMatrix: mat4x4<f32>,
        viewMatrix: mat4x4<f32>,
        modelMatrix: mat4x4<f32>,
        referencePoint: vec2<f32>,
        zoomScale: f32,
        aspectRatio: f32,
      }
      
      struct InputCoord {
        lng: f32,
        lat: f32,
      }
      
      struct OutputCoord {
        x: f32,
        y: f32,
      }
      
      @group(0) @binding(0) var<uniform> transform: Transform;
      @group(0) @binding(1) var<storage, read> inputCoords: array<InputCoord>;
      @group(0) @binding(2) var<storage, read_write> outputCoords: array<OutputCoord>;
      
      // Web Mercator projection
      fn webMercatorProject(lngLat: vec2<f32>) -> vec2<f32> {
        let lng = lngLat.x * 0.017453292519943295; // deg to rad
        let lat = lngLat.y * 0.017453292519943295;
        
        // Clamp latitude to avoid singularities
        let clampedLat = clamp(lat, -1.4844222297453324, 1.4844222297453324); // ~85 degrees
        
        let x = lng;
        let y = log(tan(0.7853981633974483 + clampedLat * 0.5)); // PI/4 + lat/2
        
        return vec2<f32>(x, y);
      }
      
      // Transform to normalized world coordinates [0,1]
      fn toWorldCoordinates(mercator: vec2<f32>, referencePoint: vec2<f32>) -> vec2<f32> {
        let worldX = (mercator.x - referencePoint.x) / (2.0 * 3.141592653589793) + 0.5;
        let worldY = (-mercator.y - referencePoint.y) / (2.0 * 3.141592653589793) + 0.5;
        return vec2<f32>(worldX, worldY);
      }
      
      // Transform to clip space [-1,1]
      fn toClipCoordinates(world: vec2<f32>, zoom: f32, aspectRatio: f32) -> vec2<f32> {
        let scale = pow(2.0, zoom);
        let scaledX = (world.x - 0.5) * scale * 2.0;
        let scaledY = (world.y - 0.5) * scale * 2.0 * aspectRatio;
        return vec2<f32>(scaledX, scaledY);
      }
      
      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
        let index = global_id.x;
        if (index >= arrayLength(&inputCoords)) {
          return;
        }
        
        let input = inputCoords[index];
        let lngLat = vec2<f32>(input.lng, input.lat);
        
        // High-precision coordinate transformation pipeline
        let mercator = webMercatorProject(lngLat);
        let world = toWorldCoordinates(mercator, transform.referencePoint);
        let clip = toClipCoordinates(world, transform.zoomScale, transform.aspectRatio);
        
        outputCoords[index] = OutputCoord(clip.x, clip.y);
      }
    `;
    
    const shaderModule = this.device.createShaderModule({
      label: 'Coordinate Transform Compute Shader',
      code: shaderCode
    });
    
    this.computePipeline = this.device.createComputePipeline({
      label: 'Coordinate Transform Pipeline',
      layout: 'auto',
      compute: {
        module: shaderModule,
        entryPoint: 'main'
      }
    });
  }
  
  /**
   * Create GPU buffers for coordinate transformation
   */
  private async createBuffers(): Promise<void> {
    const maxCoords = this.config.batchSize;
    
    // Uniform buffer for transformation parameters
    this.uniformBuffer = this.device.createBuffer({
      label: 'Transform Uniform Buffer',
      size: 256, // mat4x4 * 3 + vec2 + 2 floats + padding
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    
    // Input buffer for longitude/latitude coordinates
    this.inputBuffer = this.device.createBuffer({
      label: 'Input Coordinates Buffer',
      size: maxCoords * 8, // 2 floats per coordinate
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    
    // Output buffer for clip coordinates
    this.outputBuffer = this.device.createBuffer({
      label: 'Output Coordinates Buffer',
      size: maxCoords * 8, // 2 floats per coordinate
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });
    
    // Staging buffer for reading results back to CPU
    this.stagingBuffer = this.device.createBuffer({
      label: 'Staging Buffer',
      size: maxCoords * 8,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
  }
  
  /**
   * Create bind group for compute shader
   */
  private createBindGroup(): void {
    if (!this.computePipeline || !this.uniformBuffer || !this.inputBuffer || !this.outputBuffer) {
      throw new Error('Cannot create bind group: required resources not initialized');
    }
    
    const bindGroupLayout = this.computePipeline.getBindGroupLayout(0);
    
    this.bindGroup = this.device.createBindGroup({
      label: 'Transform Bind Group',
      layout: bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer }
        },
        {
          binding: 1,
          resource: { buffer: this.inputBuffer }
        },
        {
          binding: 2,
          resource: { buffer: this.outputBuffer }
        }
      ]
    });
  }
  
  /**
   * Update the transformation parameters
   */
  updateTransform(transform: Partial<MapTransform>): void {
    // Update current transform
    this.currentTransform = { ...this.currentTransform, ...transform };
    
    // Update reference point if needed for high precision
    if (this.config.precision.useHighPrecision) {
      this.updateReferencePoint();
    }
    
    // Clear cache when transform changes significantly
    this.clearCacheIfNeeded();
    
    // Update uniform buffer
    this.updateUniformBuffer();
  }
    /**
   * Update reference point for high-precision calculations
   */
  private updateReferencePoint(): void {
    const threshold = this.config.precision.threshold ?? 1e-10;
    const center = this.currentTransform.center;
    
    // Check if we need to update reference point
    const deltaLng = Math.abs(center.lng - this.referencePoint.lng);
    const deltaLat = Math.abs(center.lat - this.referencePoint.lat);
    
    if (deltaLng > threshold || deltaLat > threshold) {
      this.referencePoint = { ...center };
      this.referenceWorldPoint = this.lngLatToWorld(this.referencePoint);
      
      // Clear cache since reference changed
      this.coordinateCache.clear();
      this.cacheHits = 0;
      this.cacheMisses = 0;
    }
  }
  
  /**
   * Clear coordinate cache if transform changed significantly
   */
  private clearCacheIfNeeded(): void {
    // Clear cache if zoom changed significantly
    const zoomThreshold = 0.1;
    if (Math.abs(this.currentTransform.zoom - this.metrics.translationsPerFrame) > zoomThreshold) {
      this.coordinateCache.clear();
      this.cacheHits = 0;
      this.cacheMisses = 0;
    }
    
    // Limit cache size
    if (this.coordinateCache.size > this.config.cacheSize) {
      const keysToDelete = Array.from(this.coordinateCache.keys()).slice(0, this.coordinateCache.size - this.config.cacheSize);
      keysToDelete.forEach(key => this.coordinateCache.delete(key));
    }
  }
  
  /**
   * Update GPU uniform buffer with current transformation
   */
  private updateUniformBuffer(): void {
    if (!this.uniformBuffer) return;
    
    const aspectRatio = this.canvas.width / this.canvas.height;
    
    // Create transformation matrices
    const projectionMatrix = this.createProjectionMatrix(aspectRatio);
    const viewMatrix = this.createViewMatrix();
    const modelMatrix = this.createModelMatrix();
    
    // Pack data for uniform buffer
    const uniformData = new Float32Array(64); // 256 bytes / 4 bytes per float
    
    // Set matrices (16 floats each)
    uniformData.set(projectionMatrix, 0);
    uniformData.set(viewMatrix, 16);
    uniformData.set(modelMatrix, 32);
    
    // Set reference point (48, 49)
    uniformData[48] = this.referenceWorldPoint.x;
    uniformData[49] = this.referenceWorldPoint.y;
    
    // Set zoom scale and aspect ratio (50, 51)
    uniformData[50] = this.currentTransform.zoom;
    uniformData[51] = aspectRatio;
    
    // Upload to GPU
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);
  }
  
  /**
   * Create projection matrix
   */
  private createProjectionMatrix(aspectRatio: number): Float32Array {
    const matrix = mat4.create();
    mat4.ortho(matrix, -aspectRatio, aspectRatio, -1, 1, 0.1, 100);
    return new Float32Array(matrix);
  }
  
  /**
   * Create view matrix
   */
  private createViewMatrix(): Float32Array {
    const matrix = mat4.create();
    const eye = vec3.fromValues(0, 0, 1);
    const center = vec3.fromValues(0, 0, 0);
    const up = vec3.fromValues(0, 1, 0);
    mat4.lookAt(matrix, eye, center, up);
    return new Float32Array(matrix);
  }
  
  /**
   * Create model matrix with bearing and pitch
   */
  private createModelMatrix(): Float32Array {
    const matrix = mat4.create();
    
    // Apply bearing (rotation around Z-axis)
    if (this.currentTransform.bearing !== 0) {
      const bearingRad = (this.currentTransform.bearing * Math.PI) / 180;
      mat4.rotateZ(matrix, matrix, bearingRad);
    }
    
    // Apply pitch (rotation around X-axis)
    if (this.currentTransform.pitch !== 0) {
      const pitchRad = (this.currentTransform.pitch * Math.PI) / 180;
      mat4.rotateX(matrix, matrix, pitchRad);
    }
    
    return new Float32Array(matrix);
  }
  
  /**
   * Convert geographic coordinates to Web Mercator world coordinates
   */
  private lngLatToWorld(lngLat: LngLat): WorldCoordinates {
    const lng = lngLat.lng * Math.PI / 180; // Convert to radians
    const lat = Math.max(-85.0511, Math.min(85.0511, lngLat.lat)); // Clamp latitude
    const latRad = lat * Math.PI / 180;
    
    const x = lng;
    const y = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
    
    // Normalize to [0,1] range
    const worldX = (x + Math.PI) / (2 * Math.PI);
    const worldY = (Math.PI - y) / (2 * Math.PI);
    
    return { x: worldX, y: worldY };
  }
  
  /**
   * Single coordinate translation with caching
   */
  async lngLatToClip(lngLat: LngLat): Promise<TranslationResult> {
    const startTime = performance.now();
    
    try {
      // Check cache first
      const cacheKey = `${lngLat.lng.toFixed(6)},${lngLat.lat.toFixed(6)},${this.currentTransform.zoom.toFixed(2)}`;
      const cached = this.coordinateCache.get(cacheKey);
      
      if (cached) {
        this.cacheHits++;
        return {
          coordinates: cached,
          success: true,
          processingTime: performance.now() - startTime
        };
      }
      
      this.cacheMisses++;
      
      // Perform transformation
      const world = this.lngLatToWorld(lngLat);
      const clip = this.worldToClip(world);
      
      // Cache result
      this.coordinateCache.set(cacheKey, clip);
      
      return {
        coordinates: clip,
        success: true,
        processingTime: performance.now() - startTime
      };
      
    } catch (error) {
      return {
        coordinates: { x: 0, y: 0 },
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        processingTime: performance.now() - startTime
      };
    }
  }  /**
   * Convert world coordinates to clip space
   */
  private worldToClip(world: WorldCoordinates): ClipCoordinates {
    const aspectRatio = this.canvas.width / this.canvas.height;
    const scale = Math.pow(2, this.currentTransform.zoom);
    
    // Get center in world coordinates
    const centerWorld = this.lngLatToWorld(this.currentTransform.center);
    
    // Apply zoom and center offset - ensure features appear in viewport
    const x = (world.x - centerWorld.x) * scale * 2;
    const y = (world.y - centerWorld.y) * scale * 2;
    
    return { x, y };
  }
  
  /**
   * Batch coordinate translation using GPU compute shader
   */
  async batchLngLatToClip(coordinates: LngLat[]): Promise<BatchTranslationResult> {
    const startTime = performance.now();
    
    if (!this.config.enableCompute || coordinates.length === 0) {
      // Fallback to CPU processing
      return this.batchLngLatToClipCPU(coordinates);
    }
    
    try {
      // Process in batches if needed
      const batchSize = this.config.batchSize;
      const results: ClipCoordinates[] = [];
      let successCount = 0;
      
      for (let i = 0; i < coordinates.length; i += batchSize) {
        const batch = coordinates.slice(i, Math.min(i + batchSize, coordinates.length));
        const batchResult = await this.processBatchGPU(batch);
        results.push(...batchResult);
        successCount += batchResult.length;
      }
      
      const processingTime = performance.now() - startTime;
      const cacheHitRatio = this.cacheHits / (this.cacheHits + this.cacheMisses);
      
      return {
        coordinates: results,
        successCount,
        failureCount: coordinates.length - successCount,
        processingTime,
        cacheHitRatio
      };
      
    } catch (error) {
      console.error('GPU batch processing failed, falling back to CPU:', error);
      return this.batchLngLatToClipCPU(coordinates);
    }
  }
    /**
   * Process a batch of coordinates using GPU compute shader
   */
  private async processBatchGPU(coordinates: LngLat[]): Promise<ClipCoordinates[]> {
    if (!this.inputBuffer || !this.outputBuffer || !this.stagingBuffer || 
        !this.computePipeline || !this.bindGroup) {
      throw new Error('GPU resources not initialized');
    }
    
    // Check if buffer is currently mapped and unmap if needed
    if (this.stagingBuffer.mapState === 'mapped') {
      this.stagingBuffer.unmap();
    }
    
    // Prepare input data
    const inputData = new Float32Array(coordinates.length * 2);
    coordinates.forEach((coord, i) => {
      inputData[i * 2] = coord.lng;
      inputData[i * 2 + 1] = coord.lat;
    });
    
    // Upload input data to GPU
    this.device.queue.writeBuffer(this.inputBuffer, 0, inputData);
    
    // Create command encoder
    const commandEncoder = this.device.createCommandEncoder({
      label: 'Coordinate Transform Commands'
    });
    
    // Dispatch compute shader
    const computePass = commandEncoder.beginComputePass({
      label: 'Coordinate Transform Pass'
    });
    
    computePass.setPipeline(this.computePipeline);
    computePass.setBindGroup(0, this.bindGroup);
    
    const workgroupCount = Math.ceil(coordinates.length / 64);
    computePass.dispatchWorkgroups(workgroupCount);
    computePass.end();
    
    // Copy results to staging buffer
    commandEncoder.copyBufferToBuffer(
      this.outputBuffer, 0,
      this.stagingBuffer, 0,
      coordinates.length * 8
    );
      // Submit commands
    this.device.queue.submit([commandEncoder.finish()]);
    
    // Read results back
    await this.stagingBuffer.mapAsync(GPUMapMode.READ);
    const resultData = new Float32Array(this.stagingBuffer.getMappedRange());
    
    const results: ClipCoordinates[] = [];
    for (let i = 0; i < coordinates.length; i++) {
      results.push({
        x: resultData[i * 2],
        y: resultData[i * 2 + 1]
      });
    }
    
    this.stagingBuffer.unmap();
    
    return results;
  }
  
  /**
   * CPU fallback for batch coordinate translation
   */
  private async batchLngLatToClipCPU(coordinates: LngLat[]): Promise<BatchTranslationResult> {
    const startTime = performance.now();
    const results: ClipCoordinates[] = [];
    let successCount = 0;
    
    for (const coord of coordinates) {
      const result = await this.lngLatToClip(coord);
      if (result.success) {
        results.push(result.coordinates);
        successCount++;
      } else {
        results.push({ x: 0, y: 0 });
      }
    }
    
    const processingTime = performance.now() - startTime;
    const cacheHitRatio = this.cacheHits / (this.cacheHits + this.cacheMisses);
    
    return {
      coordinates: results,
      successCount,
      failureCount: coordinates.length - successCount,
      processingTime,
      cacheHitRatio
    };
  }
  
  /**
   * Get current performance metrics
   */
  getMetrics(): PerformanceMetrics {
    return {
      ...this.metrics,
      cacheHitRatio: this.cacheHits / Math.max(1, this.cacheHits + this.cacheMisses),
      gpuMemoryUsage: this.estimateGPUMemoryUsage()
    };
  }
  
  /**
   * Estimate current GPU memory usage
   */
  private estimateGPUMemoryUsage(): number {
    let usage = 0;
    
    if (this.uniformBuffer) usage += 256;
    if (this.inputBuffer) usage += this.config.batchSize * 8;
    if (this.outputBuffer) usage += this.config.batchSize * 8;
    if (this.stagingBuffer) usage += this.config.batchSize * 8;
    
    return usage;
  }
  
  /**
   * Clean up GPU resources
   */
  destroy(): void {
    this.uniformBuffer?.destroy();
    this.inputBuffer?.destroy();
    this.outputBuffer?.destroy();
    this.stagingBuffer?.destroy();
    
    this.uniformBuffer = null;
    this.inputBuffer = null;
    this.outputBuffer = null;
    this.stagingBuffer = null;
    this.computePipeline = null;
    this.bindGroup = null;
    
    this.coordinateCache.clear();
  }
}