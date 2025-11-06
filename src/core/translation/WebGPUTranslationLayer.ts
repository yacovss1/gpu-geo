// WebGPU Translation Layer Implementation
// Core translation engine for bridging standard coordinates with hidden buffer system

import type {
  LngLat,
  Point,
  ClipCoordinates,
  WorldCoordinates,
  MapTransform,
  TransformOptions,
  TranslationLayerConfig,
  WebGPUContext,
  CoordinateSpace,
  TypedCoordinate
} from '../../types/core';

export interface TranslationResult {
  coordinates: ClipCoordinates;
  precision: number;
  cached: boolean;
}

export interface BatchTranslationResult {
  coordinates: ClipCoordinates[];
  totalTime: number;
  cacheHitRatio: number;
  gpuAccelerated: boolean;
}

export class WebGPUTranslationLayer {
  private readonly device: GPUDevice;
  private readonly canvas: HTMLCanvasElement;
  private readonly transform: Transform;
  private readonly cache: TranslationCache;
  private computePipeline: GPUComputePipeline | null = null;
  private transformBuffer: GPUBuffer | null = null;
  private coordinateBuffer: GPUBuffer | null = null;
  private resultBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private isInitialized = false;
  private readonly config: Required<TranslationLayerConfig>;

  constructor(
    device: GPUDevice,
    canvas: HTMLCanvasElement,
    transformOptions: TransformOptions = {},
    translationOptions: TranslationLayerConfig = {}
  ) {
    this.device = device;
    this.canvas = canvas;
    this.transform = new Transform(transformOptions);
    
    // Set default configuration
    this.config = {
      cacheSize: translationOptions.cacheSize ?? 10000,
      batchSize: translationOptions.batchSize ?? 1000,
      enableCompute: translationOptions.enableCompute ?? true,
      precision: {
        threshold: translationOptions.precision?.threshold ?? 1e-10,
        useHighPrecision: translationOptions.precision?.useHighPrecision ?? true
      }
    };
    
    this.cache = new TranslationCache(this.config.cacheSize);
    
    if (this.config.enableCompute) {
      this.initializeComputePipeline().catch(console.warn);
    }
  }

  // === MAIN TRANSLATION METHODS ===

  /**
   * Convert geographic coordinates to WebGPU clip space coordinates
   */
  public lngLatToClip(lngLat: LngLat): ClipCoordinates {
    const cacheKey = this.generateCacheKey('lng2clip', lngLat);
    const cached = this.cache.get<ClipCoordinates>(cacheKey);
    if (cached) return cached;

    // Geographic → World coordinates
    const worldCoord = this.lngLatToWorld(lngLat);
    
    // World → Screen coordinates
    const screenCoord = this.worldToScreen(worldCoord);
    
    // Screen → WebGPU clip coordinates
    const clipCoord = this.screenToClip(screenCoord);
    
    this.cache.set(cacheKey, clipCoord);
    return clipCoord;
  }

  /**
   * Convert WebGPU clip space coordinates to geographic coordinates
   */
  public clipToLngLat(clipPoint: ClipCoordinates): LngLat {
    const cacheKey = this.generateCacheKey('clip2lng', clipPoint);
    const cached = this.cache.get<LngLat>(cacheKey);
    if (cached) return cached;

    // Clip → Screen coordinates
    const screenCoord = this.clipToScreen(clipPoint);
    
    // Screen → World coordinates
    const worldCoord = this.screenToWorld(screenCoord);
    
    // World → Geographic coordinates
    const lngLat = this.worldToLngLat(worldCoord);
    
    this.cache.set(cacheKey, lngLat);
    return lngLat;
  }

  /**
   * Batch convert multiple coordinates using GPU compute shader
   */
  public async batchLngLatToClip(lngLats: readonly LngLat[]): Promise<BatchTranslationResult> {
    const startTime = performance.now();
    
    if (!this.isInitialized || lngLats.length < 100) {
      // Use CPU for small batches
      const coordinates = lngLats.map(ll => this.lngLatToClip(ll));
      return {
        coordinates,
        totalTime: performance.now() - startTime,
        cacheHitRatio: this.cache.getStats().hitRatio,
        gpuAccelerated: false
      };
    }

    // Prepare input data
    const inputData = new Float32Array(lngLats.length * 2);
    for (let i = 0; i < lngLats.length; i++) {
      inputData[i * 2] = lngLats[i].lng;
      inputData[i * 2 + 1] = lngLats[i].lat;
    }

    // Upload to GPU
    this.device.queue.writeBuffer(this.coordinateBuffer!, 0, inputData);
    this.updateTransformBuffer();

    // Execute compute shader
    const commandEncoder = this.device.createCommandEncoder({
      label: 'Coordinate Translation Compute'
    });
    const computePass = commandEncoder.beginComputePass({
      label: 'Batch Translation Pass'
    });
    
    computePass.setPipeline(this.computePipeline!);
    computePass.setBindGroup(0, this.bindGroup!);
    
    const workgroupCount = Math.ceil(lngLats.length / 64);
    computePass.dispatchWorkgroups(workgroupCount);
    computePass.end();

    // Copy results to readable buffer
    commandEncoder.copyBufferToBuffer(
      this.coordinateBuffer!,
      0,
      this.resultBuffer!,
      0,
      inputData.byteLength
    );

    this.device.queue.submit([commandEncoder.finish()]);

    // Read results
    await this.resultBuffer!.mapAsync(GPUMapMode.READ);
    const resultData = new Float32Array(this.resultBuffer!.getMappedRange());
    const coordinates: ClipCoordinates[] = [];
    
    for (let i = 0; i < lngLats.length; i++) {
      coordinates.push({
        x: resultData[i * 2],
        y: resultData[i * 2 + 1]
      });
    }
    
    this.resultBuffer!.unmap();
    
    return {
      coordinates,
      totalTime: performance.now() - startTime,
      cacheHitRatio: this.cache.getStats().hitRatio,
      gpuAccelerated: true
    };
  }

  // === COORDINATE TRANSFORMATION PIPELINE ===

  private lngLatToWorld(lngLat: LngLat): WorldCoordinates {
    const x = (lngLat.lng + 180) / 360;
    const lat = lngLat.lat * Math.PI / 180;
    const y = (1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2;
    
    return { x, y };
  }

  private worldToLngLat(worldCoord: WorldCoordinates): LngLat {
    const lng = worldCoord.x * 360 - 180;
    const n = Math.PI - 2 * Math.PI * worldCoord.y;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    
    return { lng, lat };
  }

  private worldToScreen(worldCoord: WorldCoordinates): Point {
    const scale = Math.pow(2, this.transform.zoom);
    const centerWorld = this.lngLatToWorld(this.transform.center);
    
    // Apply zoom scaling
    let x = (worldCoord.x - centerWorld.x) * scale;
    let y = (worldCoord.y - centerWorld.y) * scale;
    
    // Apply bearing rotation
    if (this.transform.bearing !== 0) {
      const angle = this.transform.bearing * Math.PI / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const rotatedX = x * cos - y * sin;
      const rotatedY = x * sin + y * cos;
      x = rotatedX;
      y = rotatedY;
    }
    
    // Translate to screen center
    return {
      x: x + this.canvas.width / 2,
      y: y + this.canvas.height / 2
    };
  }

  private screenToWorld(screenCoord: Point): WorldCoordinates {
    // Translate from screen center
    let x = screenCoord.x - this.canvas.width / 2;
    let y = screenCoord.y - this.canvas.height / 2;
    
    // Reverse bearing rotation
    if (this.transform.bearing !== 0) {
      const angle = -this.transform.bearing * Math.PI / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const rotatedX = x * cos - y * sin;
      const rotatedY = x * sin + y * cos;
      x = rotatedX;
      y = rotatedY;
    }
    
    // Reverse zoom scaling
    const scale = Math.pow(2, this.transform.zoom);
    const centerWorld = this.lngLatToWorld(this.transform.center);
    
    return {
      x: centerWorld.x + x / scale,
      y: centerWorld.y + y / scale
    };
  }

  private screenToClip(screenCoord: Point): ClipCoordinates {
    return {
      x: (screenCoord.x / this.canvas.width) * 2 - 1,
      y: 1 - (screenCoord.y / this.canvas.height) * 2
    };
  }

  private clipToScreen(clipCoord: ClipCoordinates): Point {
    return {
      x: (clipCoord.x + 1) * this.canvas.width / 2,
      y: (1 - clipCoord.y) * this.canvas.height / 2
    };
  }

  // === GPU COMPUTE PIPELINE SETUP ===

  private async initializeComputePipeline(): Promise<void> {
    try {
      const shaderCode = `
        struct TransformUniforms {
          center: vec2<f32>,
          zoom: f32,
          bearing: f32,
          canvasSize: vec2<f32>,
          _padding: vec2<f32>,
        };
        
        @group(0) @binding(0) var<storage, read_write> coordinates: array<vec2<f32>>;
        @group(0) @binding(1) var<uniform> transform: TransformUniforms;
        
        @compute @workgroup_size(64)
        fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
          let index = global_id.x;
          if (index >= arrayLength(&coordinates)) { return; }
          
          let lngLat = coordinates[index];
          
          // Geographic to world coordinates
          let worldX = (lngLat.x + 180.0) / 360.0;
          let lat = lngLat.y * 0.017453292519943295; // Convert to radians
          let worldY = (1.0 - log(tan(lat) + 1.0 / cos(lat)) / 3.141592653589793) / 2.0;
          let worldCoord = vec2<f32>(worldX, worldY);
          
          // World to screen coordinates
          let scale = pow(2.0, transform.zoom);
          let centerWorldX = (transform.center.x + 180.0) / 360.0;
          let centerLat = transform.center.y * 0.017453292519943295;
          let centerWorldY = (1.0 - log(tan(centerLat) + 1.0 / cos(centerLat)) / 3.141592653589793) / 2.0;
          let centerWorld = vec2<f32>(centerWorldX, centerWorldY);
          
          var screenOffset = (worldCoord - centerWorld) * scale;
          
          // Apply bearing rotation
          if (transform.bearing != 0.0) {
            let angle = transform.bearing * 0.017453292519943295;
            let cosAngle = cos(angle);
            let sinAngle = sin(angle);
            let rotatedX = screenOffset.x * cosAngle - screenOffset.y * sinAngle;
            let rotatedY = screenOffset.x * sinAngle + screenOffset.y * cosAngle;
            screenOffset = vec2<f32>(rotatedX, rotatedY);
          }
          
          let screenCoord = screenOffset + transform.canvasSize * 0.5;
          
          // Screen to clip coordinates
          let clipCoord = vec2<f32>(
            (screenCoord.x / transform.canvasSize.x) * 2.0 - 1.0,
            1.0 - (screenCoord.y / transform.canvasSize.y) * 2.0
          );
          
          coordinates[index] = clipCoord;
        }
      `;

      this.computePipeline = this.device.createComputePipeline({
        label: 'Coordinate Translation Pipeline',
        layout: 'auto',
        compute: {
          module: this.device.createShaderModule({ 
            label: 'Translation Compute Shader',
            code: shaderCode 
          }),
          entryPoint: 'main'
        }
      });

      // Create buffers
      const maxCoordinates = this.config.batchSize;
      const coordinateBufferSize = maxCoordinates * 2 * 4; // vec2<f32>

      this.coordinateBuffer = this.device.createBuffer({
        label: 'Coordinate Storage Buffer',
        size: coordinateBufferSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
      });

      this.transformBuffer = this.device.createBuffer({
        label: 'Transform Uniform Buffer',
        size: 32, // TransformUniforms size (8 floats)
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });

      this.resultBuffer = this.device.createBuffer({
        label: 'Result Read Buffer',
        size: coordinateBufferSize,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
      });

      // Create bind group
      this.bindGroup = this.device.createBindGroup({
        label: 'Translation Bind Group',
        layout: this.computePipeline.getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: {
              buffer: this.coordinateBuffer
            }
          },
          {
            binding: 1,
            resource: {
              buffer: this.transformBuffer
            }
          }
        ]
      });

      this.isInitialized = true;
    } catch (error) {
      console.warn('Failed to initialize compute pipeline:', error);
      this.isInitialized = false;
    }
  }

  private updateTransformBuffer(): void {
    if (!this.transformBuffer) return;

    const transformData = new Float32Array([
      this.transform.center.lng,
      this.transform.center.lat,
      this.transform.zoom,
      this.transform.bearing,
      this.canvas.width,
      this.canvas.height,
      0, // padding
      0  // padding
    ]);

    this.device.queue.writeBuffer(this.transformBuffer, 0, transformData);
  }
  private generateCacheKey(operation: string, coords: LngLat | ClipCoordinates): string {
    if ('lng' in coords) {
      return `${operation}_${coords.lng.toFixed(6)}_${coords.lat.toFixed(6)}_${this.transform.getHash()}`;
    } else {
      return `${operation}_${coords.x.toFixed(6)}_${coords.y.toFixed(6)}_${this.transform.getHash()}`;
    }
  }

  // === PUBLIC API METHODS ===

  /**
   * Update transform parameters
   */
  public updateTransform(options: Partial<TransformOptions>): void {
    this.transform.update(options);
    this.cache.invalidateOnTransformChange();
  }

  /**
   * Get current transform state
   */
  public getTransform(): MapTransform {
    return { ...this.transform };
  }

  /**
   * Clear translation cache
   */
  public clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  public getCacheStats(): { size: number; hitRatio: number } {
    return this.cache.getStats();
  }

  /**
   * Dispose of GPU resources
   */
  public dispose(): void {
    this.coordinateBuffer?.destroy();
    this.transformBuffer?.destroy();
    this.resultBuffer?.destroy();
    this.cache.clear();
  }
}

// === SUPPORTING CLASSES ===

class Transform implements MapTransform {
  public center: LngLat = { lng: 0, lat: 0 };
  public zoom: number = 0;
  public bearing: number = 0;
  public pitch: number = 0;
  
  private hash: string = '';

  constructor(options: TransformOptions = {}) {
    this.center = options.center ?? { lng: 0, lat: 0 };
    this.zoom = options.zoom ?? 0;
    this.bearing = options.bearing ?? 0;
    this.pitch = options.pitch ?? 0;
    this.updateHash();
  }

  public update(options: Partial<TransformOptions>): void {
    if (options.center) this.center = options.center;
    if (options.zoom !== undefined) this.zoom = options.zoom;
    if (options.bearing !== undefined) this.bearing = options.bearing;
    if (options.pitch !== undefined) this.pitch = options.pitch;
    this.updateHash();
  }

  public getHash(): string {
    return this.hash;
  }

  private updateHash(): void {
    this.hash = `${this.center.lng.toFixed(6)}_${this.center.lat.toFixed(6)}_${this.zoom.toFixed(2)}_${this.bearing.toFixed(1)}`;
  }
}

interface CacheEntry<T = unknown> {
  value: T;
  timestamp: number;
  accessCount: number;
}

class TranslationCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly accessOrder: string[] = [];
  private readonly maxSize: number;
  private hits = 0;
  private misses = 0;

  constructor(maxSize: number = 10000) {
    this.maxSize = maxSize;
  }

  public get<T = unknown>(key: string): T | null {
    const entry = this.cache.get(key);
    if (entry) {
      this.updateAccessOrder(key);
      entry.accessCount++;
      this.hits++;
      return entry.value as T;
    }
    this.misses++;
    return null;
  }

  public set<T = unknown>(key: string, value: T): void {
    if (this.cache.size >= this.maxSize) {
      this.evictOldest();
    }
    
    const entry: CacheEntry<T> = {
      value,
      timestamp: Date.now(),
      accessCount: 1
    };
    
    this.cache.set(key, entry);
    this.updateAccessOrder(key);
  }

  public clear(): void {
    this.cache.clear();
    this.accessOrder.length = 0;
    this.hits = 0;
    this.misses = 0;
  }

  public invalidateOnTransformChange(): void {
    // Keep only non-transform dependent entries
    const keysToDelete: string[] = [];
    for (const key of this.cache.keys()) {
      if (key.includes('_')) { // Transform-dependent keys contain underscores
        keysToDelete.push(key);
      }
    }
    
    for (const key of keysToDelete) {
      this.cache.delete(key);
      const index = this.accessOrder.indexOf(key);
      if (index > -1) {
        this.accessOrder.splice(index, 1);
      }
    }
  }

  public getStats(): { size: number; hitRatio: number } {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hitRatio: total > 0 ? this.hits / total : 0
    };
  }

  private updateAccessOrder(key: string): void {
    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
    this.accessOrder.push(key);
  }

  private evictOldest(): void {
    const oldestKey = this.accessOrder.shift();
    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }
}