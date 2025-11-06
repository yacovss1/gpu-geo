// Map Active Work - Clean MapLibre Integration
// Entry point: main.ts

import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import earcut from 'earcut';
import { MathUtils } from './utils/math';
import { HiddenBufferIntegration } from './core/translation/HiddenBufferIntegration';
import { WebGPUTranslationLayer } from './core/translation/WebGPUTranslationLayer';

interface MapLibreTile {
  z: number;
  x: number;
  y: number;
  data: ArrayBuffer;
}

class MapLibreIntegration {
  private canvas: HTMLCanvasElement;
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private renderPipeline: GPURenderPipeline | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private renderPipelineBindGroup: GPUBindGroup | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private hiddenBuffer: GPUTexture | null = null;
  private hiddenBufferView: GPUTextureView | null = null;
  private hiddenBufferReadBuffer: GPUBuffer | null = null;
  private translationLayer: WebGPUTranslationLayer | null = null;
  private hiddenBufferIntegration: HiddenBufferIntegration | null = null;

  constructor() {
    this.canvas = document.getElementById('mapCanvas') as HTMLCanvasElement;
    if (!this.canvas) {
      throw new Error('Canvas not found');
    }
  }

  async initialize(): Promise<void> {
    this.setupCanvas();
    await this.initializeWebGPU();
    await this.loadMapLibreTiles();
    await this.createRenderPipeline();
    this.render();
    console.log('✅ MapLibre Integration ready');
  }

  private setupCanvas(): void {
    this.canvas.width = window.innerWidth * window.devicePixelRatio;
    this.canvas.height = window.innerHeight * window.devicePixelRatio;
    this.canvas.style.width = window.innerWidth + 'px';
    this.canvas.style.height = window.innerHeight + 'px';
  }

  private async initializeWebGPU(): Promise<void> {
    if (!navigator.gpu) {
      throw new Error('WebGPU not supported');
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error('WebGPU adapter not found');
    }
    this.device = await adapter.requestDevice();
    this.context = this.canvas.getContext('webgpu')!;
    this.context.configure({
      device: this.device,
      format: 'bgra8unorm',
      alphaMode: 'premultiplied'
    });
    console.log('🎮 WebGPU initialized');
  }

  private async loadMapLibreTiles(): Promise<void> {
    // Fetch tiles for world view (zoom 2)
    const tiles = this.calculateWorldTiles();
    const tilePromises = tiles.map(tile => this.fetchTile(tile.z, tile.x, tile.y));
    const loadedTiles = await Promise.all(tilePromises);
    const validTiles = loadedTiles.filter(tile => tile.data.byteLength > 0);
    this.processTilesForRendering(validTiles);
  }

  private calculateWorldTiles(): Array<{z: number, x: number, y: number}> {
    const tiles = [];
    const zoom = 2;
    for (let x = 0; x < 4; x++) {
      for (let y = 0; y < 4; y++) {
        tiles.push({ z: zoom, x, y });
      }
    }
    return tiles;
  }

  private async fetchTile(z: number, x: number, y: number): Promise<MapLibreTile> {
    const url = `https://demotiles.maplibre.org/tiles/${z}/${x}/${y}.pbf`;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.arrayBuffer();
      return { z, x, y, data };
    } catch {
      return { z, x, y, data: new ArrayBuffer(0) };
    }
  }

  private processTilesForRendering(tiles: MapLibreTile[]): void {
    const vertices: number[] = [];
    const indices: number[] = [];

    function hashColor(str: string): [number, number, number] {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
      }
      const r = ((hash >> 0) & 0xFF) / 255;
      const g = ((hash >> 8) & 0xFF) / 255;
      const b = ((hash >> 16) & 0xFF) / 255;
      return [r, g, b];
    }

    tiles.forEach((tile) => {
      if (tile.data.byteLength === 0) return;
      let vt: VectorTile;
      try {
        vt = new VectorTile(new Pbf(tile.data));
      } catch (e) {
        console.warn('Failed to parse vector tile', tile, e);
        return;
      }
      for (const layerName in vt.layers) {
        const layer = vt.layers[layerName];
        for (let i = 0; i < layer.length; i++) {
          const feature = layer.feature(i);
          if (feature.type === 3) { // Polygon
            const geojson = feature.toGeoJSON(tile.x, tile.y, tile.z);
            const props = geojson.properties || {};
            const countryKey = props.name || props.NAME || props.admin || props.id || `${layerName}_${i}`;
            const [r, g, b] = hashColor(countryKey);
            const color = [r, g, b, 1.0];
            // Only handle Polygon and MultiPolygon
            if (geojson.geometry.type === 'Polygon' || geojson.geometry.type === 'MultiPolygon') {
              const polygons = geojson.geometry.type === 'Polygon' ? [geojson.geometry.coordinates] : geojson.geometry.coordinates;
              polygons.forEach((polygon: any) => {
                if (!Array.isArray(polygon) || !Array.isArray(polygon[0])) return;
                // polygon: [outer, hole1, hole2, ...]
                const flat: number[] = [];
                const holeIndices: number[] = [];
                polygon.forEach((ring: any, ringIdx: number) => {
                  if (!Array.isArray(ring) || ring.length < 3) return;
                  if (ringIdx > 0) holeIndices.push(flat.length / 2);
                  for (const coord of ring) {
                    // Use lngLatToWorld for world coordinates
                    const { x, y } = MathUtils.Matrix.lngLatToWorld(coord[0], coord[1]);
                    flat.push(x * 2 - 1, y * 2 - 1); // Map to [-1,1] for NDC
                  }
                });
                if (flat.length < 6) return;
                const triangles = earcut(flat, holeIndices.length > 0 ? holeIndices : undefined, 2);
                const base = vertices.length / 6;
                for (let v = 0; v < flat.length; v += 2) {
                  vertices.push(flat[v], flat[v + 1], ...color);
                }
                for (let t = 0; t < triangles.length; t += 3) {
                  indices.push(base + triangles[t], base + triangles[t + 1], base + triangles[t + 2]);
                }
              });
            }
          }
        }
      }
    });
    if (vertices.length === 0) {
      this.createFallbackGeometry();
      return;
    }
    this.createBuffers(new Float32Array(vertices), new Uint16Array(indices));
  }

  private createFallbackGeometry(): void {
    const vertices = new Float32Array([
      -0.6, 0.4, 0.3, 0.7, 0.3, 1.0,
      -0.2, 0.4, 0.3, 0.7, 0.3, 1.0,
      -0.2, 0.0, 0.3, 0.7, 0.3, 1.0,
      -0.6, 0.0, 0.3, 0.7, 0.3, 1.0,
      0.0, 0.6, 0.8, 0.6, 0.2, 1.0,
      0.4, 0.6, 0.8, 0.6, 0.2, 1.0,
      0.4, -0.4, 0.8, 0.6, 0.2, 1.0,
      0.0, -0.4, 0.8, 0.6, 0.2, 1.0,
      0.4, 0.6, 0.6, 0.4, 0.2, 1.0,
      0.8, 0.6, 0.6, 0.4, 0.2, 1.0,
      0.8, 0.0, 0.6, 0.4, 0.2, 1.0,
      0.4, 0.0, 0.6, 0.4, 0.2, 1.0,
    ]);
    const indices = new Uint16Array([
      0, 1, 2, 0, 2, 3,
      4, 5, 6, 4, 6, 7,
      8, 9, 10, 8, 10, 11
    ]);
    this.createBuffers(vertices, indices);
  }

  private createBuffers(vertices: Float32Array, indices: Uint16Array): void {
    if (!this.device) return;
    const vertexBufferSize = Math.max(16, vertices.byteLength);
    let indexData = indices;
    if (indices.byteLength % 4 !== 0) {
      const paddedSize = Math.ceil(indices.byteLength / 4) * 4;
      const paddedIndices = new Uint16Array(paddedSize / 2);
      paddedIndices.set(indices);
      indexData = paddedIndices;
    }
    const indexBufferSize = Math.max(16, indexData.byteLength);
    this.vertexBuffer = this.device.createBuffer({
      size: vertexBufferSize,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.vertexBuffer, 0, vertices);
    this.indexBuffer = this.device.createBuffer({
      size: indexBufferSize,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.indexBuffer, 0, indexData);
  }

  private async createRenderPipeline(): Promise<void> {
    if (!this.device) return;
    // Create a uniform buffer for the transform matrix (4x4)
    this.uniformBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    // Identity matrix for now (no pan/zoom)
    const identity = new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ]);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, identity);

    const shaderCode = `
      struct Uniforms {
        matrix : mat4x4<f32>,
      };
      @group(0) @binding(0) var<uniform> uniforms : Uniforms;
      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) color: vec4<f32>,
      }
      @vertex fn vs_main(
        @location(0) position: vec2<f32>,
        @location(1) color: vec4<f32>
      ) -> VertexOutput {
        var output: VertexOutput;
        output.position = uniforms.matrix * vec4<f32>(position, 0.0, 1.0);
        output.color = color;
        return output;
      }
      @fragment fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
        return input.color;
      }
    `;
    const shaderModule = this.device.createShaderModule({ code: shaderCode });
    this.renderPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: 6 * 4,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32x4' }
          ]
        }]
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: 'bgra8unorm' }]
      },
      primitive: { topology: 'triangle-list' }
    });
    // Create bind group for the uniform buffer
    this.renderPipelineBindGroup = this.device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [{
        binding: 0,
        resource: { buffer: this.uniformBuffer }
      }]
    });
    // Create hidden buffer for feature picking
    this.hiddenBuffer = this.device.createTexture({
      size: [this.canvas.width, this.canvas.height, 1],
      format: 'r32uint',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
    });
    this.hiddenBufferView = this.hiddenBuffer.createView();
    this.hiddenBufferReadBuffer = this.device.createBuffer({
      size: this.canvas.width * this.canvas.height * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
  }

  // Add a method to pick a feature at (x, y)
  async pickFeature(x: number, y: number): Promise<number | null> {
    if (!this.device || !this.hiddenBuffer || !this.hiddenBufferReadBuffer) return null;
    const commandEncoder = this.device.createCommandEncoder();
    // Use bytesPerRow = 256 (minimum required by WebGPU)
    commandEncoder.copyTextureToBuffer(
      { texture: this.hiddenBuffer, origin: { x, y, z: 0 } },
      { buffer: this.hiddenBufferReadBuffer, bytesPerRow: 256 },
      { width: 1, height: 1, depthOrArrayLayers: 1 }
    );
    this.device.queue.submit([commandEncoder.finish()]);
    await this.hiddenBufferReadBuffer.mapAsync(GPUMapMode.READ, 0, 256);
    const array = new Uint32Array(this.hiddenBufferReadBuffer.getMappedRange(0, 256));
    const featureId = array[0];
    this.hiddenBufferReadBuffer.unmap();
    return featureId;
  }

  private render(): void {
    if (!this.device || !this.context || !this.renderPipeline || !this.vertexBuffer || !this.indexBuffer || !this.renderPipelineBindGroup) return;
    const commandEncoder = this.device.createCommandEncoder();
    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.2, g: 0.5, b: 0.9, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store'
      }]
    });
    renderPass.setPipeline(this.renderPipeline);
    renderPass.setBindGroup(0, this.renderPipelineBindGroup);
    renderPass.setVertexBuffer(0, this.vertexBuffer);
    renderPass.setIndexBuffer(this.indexBuffer, 'uint16');
    renderPass.drawIndexed(this.indexBuffer.size / 2);
    renderPass.end();
    this.device.queue.submit([commandEncoder.finish()]);
    console.log('🎨 World map rendered from MapLibre tiles');
  }
}

// Entry point
async function main() {
  try {
    const canvas = document.getElementById('mapCanvas') as HTMLCanvasElement;
    if (!canvas) throw new Error('Canvas not found');
    if (!navigator.gpu) throw new Error('WebGPU not supported');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('WebGPU adapter not found');
    const device = await adapter.requestDevice();

    // Set up translation layer
    const translationLayer = new WebGPUTranslationLayer(device, canvas);
    await translationLayer.initialize();

    // Set up hidden buffer integration
    const hiddenBuffer = new HiddenBufferIntegration(device, canvas, translationLayer);
    await hiddenBuffer.initialize();

    // TODO: Load features from vector tiles or a sample source
    // Example: const features = await loadFeaturesFromTiles();
    // await hiddenBuffer.addFeatures(features);

    // Render all features
    await hiddenBuffer.renderFeatures();

    // Example: Feature picking on click
    canvas.addEventListener('click', async (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const result = await hiddenBuffer.pickFeature({ x, y });
      if (result) {
        console.log('Picked feature:', result.feature);
      } else {
        console.log('No feature picked');
      }
    });

    console.log('✅ MapLibre Integration with Hidden Buffer ready');
  } catch (error) {
    console.error('❌ MapLibre integration failed:', error);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}

