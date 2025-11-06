/**
 * Simple World Map - Direct implementation with real geographic features
 * No complex engine dependencies - just pure WebGPU rendering
 */

interface LngLat {
  lng: number;
  lat: number;
}

class SimpleWorldMap {
  private device: GPUDevice;
  private canvas: HTMLCanvasElement;
  private context: GPUCanvasContext;
  private renderPipeline!: GPURenderPipeline;
  private uniformBuffer!: GPUBuffer;
  private vertexBuffer!: GPUBuffer;
  private indexBuffer!: GPUBuffer;
  private bindGroup!: GPUBindGroup;
  
  // Map state
  private center: LngLat = { lng: 0, lat: 20 };
  private zoom: number = 3;
  private bearing: number = 0;
  
  // World geometry data
  private worldFeatures!: Float32Array;
  private worldIndices!: Uint16Array;
  private featureCount: number = 0;

  constructor(device: GPUDevice, canvas: HTMLCanvasElement) {
    this.device = device;
    this.canvas = canvas;
    this.context = canvas.getContext('webgpu')!;
  }

  async initialize(): Promise<void> {
    // Configure canvas
    this.context.configure({
      device: this.device,
      format: 'bgra8unorm',
      alphaMode: 'premultiplied'
    });

    // Create world geography
    this.createWorldGeometry();
    
    // Create GPU resources
    await this.createRenderPipeline();
    this.createBuffers();
    this.createBindGroup();
    
    // Start render loop
    this.startRenderLoop();
    
    console.log(`🌍 Simple World Map initialized with ${this.featureCount} features`);
  }

  private createWorldGeometry(): void {
    const features: number[] = [];
    const indices: number[] = [];
    let vertexIndex = 0;

    // Ocean (background)
    this.addRectangle(features, indices, vertexIndex, -180, -90, 360, 180, [0.2, 0.4, 0.8, 1.0]);
    vertexIndex += 4;

    // North America
    const northAmerica = [
      [-140, 70], [-60, 70], [-60, 25], [-125, 25], [-125, 50], [-140, 50]
    ];
    vertexIndex = this.addPolygon(features, indices, vertexIndex, northAmerica, [0.3, 0.7, 0.3, 1.0]);

    // South America
    const southAmerica = [
      [-85, 15], [-35, 15], [-35, -55], [-75, -55], [-85, -20]
    ];
    vertexIndex = this.addPolygon(features, indices, vertexIndex, southAmerica, [0.4, 0.8, 0.4, 1.0]);

    // Europe
    const europe = [
      [-10, 70], [40, 70], [40, 35], [-10, 35]
    ];
    vertexIndex = this.addPolygon(features, indices, vertexIndex, europe, [0.6, 0.6, 0.4, 1.0]);

    // Africa
    const africa = [
      [-20, 35], [50, 35], [50, -35], [-20, -35]
    ];
    vertexIndex = this.addPolygon(features, indices, vertexIndex, africa, [0.8, 0.7, 0.4, 1.0]);

    // Asia
    const asia = [
      [40, 70], [180, 70], [180, 10], [40, 10]
    ];
    vertexIndex = this.addPolygon(features, indices, vertexIndex, asia, [0.5, 0.6, 0.3, 1.0]);

    // Australia
    const australia = [
      [110, -10], [155, -10], [155, -45], [110, -45]
    ];
    vertexIndex = this.addPolygon(features, indices, vertexIndex, australia, [0.7, 0.5, 0.3, 1.0]);

    // Major cities as points
    const cities = [
      [-74, 40.7], [0, 51.5], [139.7, 35.7], [151.2, -33.9], [31.2, 30.0], [-46.6, -23.5]
    ];

    cities.forEach(city => {
      vertexIndex = this.addPoint(features, indices, vertexIndex, city[0], city[1], [1.0, 0.0, 0.0, 1.0]);
    });

    this.worldFeatures = new Float32Array(features);
    this.worldIndices = new Uint16Array(indices);
    this.featureCount = Math.floor(features.length / 6);
    
    console.log(`🗺️ Created world with ${this.featureCount} vertices`);
  }

  private addRectangle(features: number[], indices: number[], startIndex: number, 
                      x: number, y: number, width: number, height: number, color: number[]): void {
    const x1 = (x + 180) / 360 * 2 - 1;
    const y1 = (y + 90) / 180 * 2 - 1;
    const x2 = ((x + width) + 180) / 360 * 2 - 1;
    const y2 = ((y + height) + 90) / 180 * 2 - 1;

    features.push(x1, y1, ...color);
    features.push(x2, y1, ...color);
    features.push(x2, y2, ...color);
    features.push(x1, y2, ...color);

    indices.push(startIndex, startIndex + 1, startIndex + 2);
    indices.push(startIndex, startIndex + 2, startIndex + 3);
  }

  private addPolygon(features: number[], indices: number[], startIndex: number, 
                    coords: number[][], color: number[]): number {
    const centerIndex = startIndex;
    
    const centerX = coords.reduce((sum, coord) => sum + coord[0], 0) / coords.length;
    const centerY = coords.reduce((sum, coord) => sum + coord[1], 0) / coords.length;
    const cx = (centerX + 180) / 360 * 2 - 1;
    const cy = (centerY + 90) / 180 * 2 - 1;
    features.push(cx, cy, ...color);
    
    coords.forEach(coord => {
      const x = (coord[0] + 180) / 360 * 2 - 1;
      const y = (coord[1] + 90) / 180 * 2 - 1;
      features.push(x, y, ...color);
    });
    
    for (let i = 0; i < coords.length; i++) {
      const next = (i + 1) % coords.length;
      indices.push(centerIndex, centerIndex + 1 + i, centerIndex + 1 + next);
    }
    
    return startIndex + coords.length + 1;
  }

  private addPoint(features: number[], indices: number[], startIndex: number,
                  lng: number, lat: number, color: number[]): number {
    const x = (lng + 180) / 360 * 2 - 1;
    const y = (lat + 90) / 180 * 2 - 1;
    const size = 0.01;
    
    features.push(x - size, y - size, ...color);
    features.push(x + size, y - size, ...color);
    features.push(x + size, y + size, ...color);
    features.push(x - size, y + size, ...color);
    
    indices.push(startIndex, startIndex + 1, startIndex + 2);
    indices.push(startIndex, startIndex + 2, startIndex + 3);
    
    return startIndex + 4;
  }

  private async createRenderPipeline(): Promise<void> {
    const shaderCode = `
      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) color: vec4<f32>,
      }

      struct Uniforms {
        transform: mat4x4<f32>,
      }

      @group(0) @binding(0) var<uniform> uniforms: Uniforms;

      @vertex fn vs_main(
        @location(0) position: vec2<f32>,
        @location(1) color: vec4<f32>
      ) -> VertexOutput {
        var output: VertexOutput;
        output.position = uniforms.transform * vec4<f32>(position, 0.0, 1.0);
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
  }

  private createBuffers(): void {
    // Ensure buffer sizes are multiples of 4 bytes
    const vertexBufferSize = Math.ceil(this.worldFeatures.byteLength / 4) * 4;
    const indexBufferSize = Math.ceil(this.worldIndices.byteLength / 4) * 4;
    
    this.vertexBuffer = this.device.createBuffer({
      size: vertexBufferSize,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.vertexBuffer, 0, this.worldFeatures);

    this.indexBuffer = this.device.createBuffer({
      size: indexBufferSize,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.indexBuffer, 0, this.worldIndices);

    this.uniformBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
  }

  private createBindGroup(): void {
    this.bindGroup = this.device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [{
        binding: 0,
        resource: { buffer: this.uniformBuffer }
      }]
    });
  }

  private updateTransform(): void {
    const scale = Math.pow(2, this.zoom - 3);
    const tx = -this.center.lng / 180 * scale;
    const ty = -this.center.lat / 90 * scale;
    
    const transform = new Float32Array([
      scale, 0, 0, tx,
      0, scale, 0, ty,
      0, 0, 1, 0,
      0, 0, 0, 1
    ]);
    
    this.device.queue.writeBuffer(this.uniformBuffer, 0, transform);
  }

  private render(): void {
    this.updateTransform();
    
    const commandEncoder = this.device.createCommandEncoder();
    const renderPassDescriptor: GPURenderPassDescriptor = {
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.1, g: 0.2, b: 0.4, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store'
      }]
    };

    const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
    passEncoder.setPipeline(this.renderPipeline);
    passEncoder.setBindGroup(0, this.bindGroup);
    passEncoder.setVertexBuffer(0, this.vertexBuffer);
    passEncoder.setIndexBuffer(this.indexBuffer, 'uint16');
    passEncoder.drawIndexed(this.worldIndices.length);
    passEncoder.end();

    this.device.queue.submit([commandEncoder.finish()]);
  }

  private startRenderLoop(): void {
    const frame = () => {
      this.render();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  public flyTo(center: LngLat, zoom: number): void {
    this.center = { ...center };
    this.zoom = zoom;
    console.log(`🧭 Navigated to: ${center.lng.toFixed(2)}, ${center.lat.toFixed(2)} at zoom ${zoom}`);
  }

  public setZoom(zoom: number): void {
    this.zoom = Math.max(1, Math.min(10, zoom));
  }

  public setBearing(bearing: number): void {
    this.bearing = bearing;
  }

  public getState() {
    return {
      center: { ...this.center },
      zoom: this.zoom,
      bearing: this.bearing,
      features: this.featureCount
    };
  }
}

export { SimpleWorldMap };