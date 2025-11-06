// WebGPU Type Definitions for Translation Layer
// This provides type safety for WebGPU APIs used in the translation layer

export {}; // Make this a module

declare global {
  // Core WebGPU interfaces
  interface GPU {
    requestAdapter(options?: GPURequestAdapterOptions): Promise<GPUAdapter | null>;
  }

  interface GPUAdapter {
    requestDevice(descriptor?: GPUDeviceDescriptor): Promise<GPUDevice>;
    features: GPUSupportedFeatures;
    limits: GPUSupportedLimits;
    isFallbackAdapter: boolean;
  }

  interface GPUDevice extends EventTarget {
    features: GPUSupportedFeatures;
    limits: GPUSupportedLimits;
    queue: GPUQueue;
    
    createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer;
    createTexture(descriptor: GPUTextureDescriptor): GPUTexture;
    createShaderModule(descriptor: GPUShaderModuleDescriptor): GPUShaderModule;
    createComputePipeline(descriptor: GPUComputePipelineDescriptor): GPUComputePipeline;
    createRenderPipeline(descriptor: GPURenderPipelineDescriptor): GPURenderPipeline;
    createBindGroup(descriptor: GPUBindGroupDescriptor): GPUBindGroup;
    createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): GPUBindGroupLayout;
    createCommandEncoder(descriptor?: GPUCommandEncoderDescriptor): GPUCommandEncoder;
    
    destroy(): void;
  }

  interface GPUQueue {
    submit(commandBuffers: Iterable<GPUCommandBuffer>): void;
    writeBuffer(buffer: GPUBuffer, bufferOffset: number, data: BufferSource, dataOffset?: number, size?: number): void;
    writeTexture(destination: GPUImageCopyTexture, data: BufferSource, dataLayout: GPUImageDataLayout, size: GPUExtent3D): void;
  }

  interface GPUBuffer {
    size: number;
    usage: number;
    mapState: GPUBufferMapState;
    
    mapAsync(mode: number, offset?: number, size?: number): Promise<void>;
    getMappedRange(offset?: number, size?: number): ArrayBuffer;
    unmap(): void;
    destroy(): void;
  }

  interface GPUTexture {
    width: number;
    height: number;
    depthOrArrayLayers: number;
    mipLevelCount: number;
    sampleCount: number;
    dimension: GPUTextureDimension;
    format: GPUTextureFormat;
    usage: number;
    
    createView(descriptor?: GPUTextureViewDescriptor): GPUTextureView;
    destroy(): void;
  }

  interface GPUTextureView {
    // Texture view interface
  }

  interface GPUShaderModule {
    // Shader module interface
  }

  interface GPUComputePipeline {
    getBindGroupLayout(index: number): GPUBindGroupLayout;
  }

  interface GPURenderPipeline {
    getBindGroupLayout(index: number): GPUBindGroupLayout;
  }

  interface GPUBindGroup {
    // Bind group interface
  }

  interface GPUBindGroupLayout {
    // Bind group layout interface
  }

  interface GPUCommandEncoder {
    beginComputePass(descriptor?: GPUComputePassDescriptor): GPUComputePassEncoder;
    beginRenderPass(descriptor: GPURenderPassDescriptor): GPURenderPassEncoder;
    copyBufferToBuffer(source: GPUBuffer, sourceOffset: number, destination: GPUBuffer, destinationOffset: number, size: number): void;
    copyBufferToTexture(source: GPUImageCopyBuffer, destination: GPUImageCopyTexture, copySize: GPUExtent3D): void;
    copyTextureToBuffer(source: GPUImageCopyTexture, destination: GPUImageCopyBuffer, copySize: GPUExtent3D): void;
    copyTextureToTexture(source: GPUImageCopyTexture, destination: GPUImageCopyTexture, copySize: GPUExtent3D): void;
    finish(descriptor?: GPUCommandBufferDescriptor): GPUCommandBuffer;
  }

  interface GPUComputePassEncoder {
    setPipeline(pipeline: GPUComputePipeline): void;
    setBindGroup(index: number, bindGroup: GPUBindGroup, dynamicOffsets?: Iterable<number>): void;
    dispatchWorkgroups(workgroupCountX: number, workgroupCountY?: number, workgroupCountZ?: number): void;
    end(): void;
  }

  interface GPURenderPassEncoder {
    setPipeline(pipeline: GPURenderPipeline): void;
    setBindGroup(index: number, bindGroup: GPUBindGroup, dynamicOffsets?: Iterable<number>): void;
    setVertexBuffer(slot: number, buffer: GPUBuffer, offset?: number, size?: number): void;
    setIndexBuffer(buffer: GPUBuffer, format: GPUIndexFormat, offset?: number, size?: number): void;
    draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void;
    drawIndexed(indexCount: number, instanceCount?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number): void;
    end(): void;
  }

  interface GPUCommandBuffer {
    // Command buffer interface
  }

  // Descriptor interfaces
  interface GPURequestAdapterOptions {
    powerPreference?: GPUPowerPreference;
    forceFallbackAdapter?: boolean;
  }

  interface GPUDeviceDescriptor {
    requiredFeatures?: Iterable<GPUFeatureName>;
    requiredLimits?: Record<string, number>;
    defaultQueue?: GPUQueueDescriptor;
  }

  interface GPUQueueDescriptor {
    label?: string;
  }

  interface GPUBufferDescriptor {
    label?: string;
    size: number;
    usage: number;
    mappedAtCreation?: boolean;
  }

  interface GPUTextureDescriptor {
    label?: string;
    size: GPUExtent3D;
    mipLevelCount?: number;
    sampleCount?: number;
    dimension?: GPUTextureDimension;
    format: GPUTextureFormat;
    usage: number;
  }

  interface GPUShaderModuleDescriptor {
    label?: string;
    code: string;
  }

  interface GPUComputePipelineDescriptor {
    label?: string;
    layout: GPUPipelineLayout | 'auto';
    compute: GPUProgrammableStage;
  }

  interface GPURenderPipelineDescriptor {
    label?: string;
    layout: GPUPipelineLayout | 'auto';
    vertex: GPUVertexState;
    primitive?: GPUPrimitiveState;
    depthStencil?: GPUDepthStencilState;
    multisample?: GPUMultisampleState;
    fragment?: GPUFragmentState;
  }

  interface GPUBindGroupDescriptor {
    label?: string;
    layout: GPUBindGroupLayout;
    entries: Iterable<GPUBindGroupEntry>;
  }

  interface GPUBindGroupLayoutDescriptor {
    label?: string;
    entries: Iterable<GPUBindGroupLayoutEntry>;
  }

  interface GPUCommandEncoderDescriptor {
    label?: string;
  }

  interface GPUComputePassDescriptor {
    label?: string;
    timestampWrites?: GPUComputePassTimestampWrites;
  }

  interface GPURenderPassDescriptor {
    label?: string;
    colorAttachments: Iterable<GPURenderPassColorAttachment | null>;
    depthStencilAttachment?: GPURenderPassDepthStencilAttachment;
    timestampWrites?: GPURenderPassTimestampWrites;
  }

  // Additional type definitions
  interface GPUProgrammableStage {
    module: GPUShaderModule;
    entryPoint: string;
    constants?: Record<string, number>;
  }

  interface GPUVertexState extends GPUProgrammableStage {
    buffers?: Iterable<GPUVertexBufferLayout | null>;
  }

  interface GPUFragmentState extends GPUProgrammableStage {
    targets: Iterable<GPUColorTargetState | null>;
  }

  interface GPUBindGroupEntry {
    binding: number;
    resource: GPUBindingResource;
  }

  interface GPUBindGroupLayoutEntry {
    binding: number;
    visibility: number;
    buffer?: GPUBufferBindingLayout;
    sampler?: GPUSamplerBindingLayout;
    texture?: GPUTextureBindingLayout;
    storageTexture?: GPUStorageTextureBindingLayout;
  }

  // Enums and constants
  const enum GPUBufferUsage {
    MAP_READ = 0x0001,
    MAP_WRITE = 0x0002,
    COPY_SRC = 0x0004,
    COPY_DST = 0x0008,
    INDEX = 0x0010,
    VERTEX = 0x0020,
    UNIFORM = 0x0040,
    STORAGE = 0x0080,
    INDIRECT = 0x0100,
    QUERY_RESOLVE = 0x0200,
  }

  const enum GPUTextureUsage {
    COPY_SRC = 0x01,
    COPY_DST = 0x02,
    TEXTURE_BINDING = 0x04,
    STORAGE_BINDING = 0x08,
    RENDER_ATTACHMENT = 0x10,
  }

  const enum GPUMapMode {
    READ = 0x0001,
    WRITE = 0x0002,
  }

  const enum GPUShaderStage {
    VERTEX = 0x1,
    FRAGMENT = 0x2,
    COMPUTE = 0x4,
  }

  // Type aliases
  type GPUPowerPreference = 'low-power' | 'high-performance';
  type GPUFeatureName = string;
  type GPUBufferMapState = 'unmapped' | 'pending' | 'mapped';
  type GPUTextureDimension = '1d' | '2d' | '3d';
  type GPUTextureFormat = string;
  type GPUIndexFormat = 'uint16' | 'uint32';
  type GPUExtent3D = {
    width: number;
    height?: number;
    depthOrArrayLayers?: number;
  } | [number, number?, number?];

  // Additional interfaces
  interface GPUSupportedFeatures extends ReadonlySet<string> {}
  interface GPUSupportedLimits {
    readonly [name: string]: number;
  }
  interface GPUPipelineLayout {}
  interface GPUPrimitiveState {}
  interface GPUDepthStencilState {}
  interface GPUMultisampleState {}
  interface GPUColorTargetState {}
  interface GPUVertexBufferLayout {}
  interface GPUBufferBindingLayout {}
  interface GPUSamplerBindingLayout {}
  interface GPUTextureBindingLayout {}
  interface GPUStorageTextureBindingLayout {}
  interface GPUBindingResource {}
  interface GPUComputePassTimestampWrites {}
  interface GPURenderPassColorAttachment {}
  interface GPURenderPassDepthStencilAttachment {}
  interface GPURenderPassTimestampWrites {}
  interface GPUImageCopyTexture {}
  interface GPUImageDataLayout {}
  interface GPUImageCopyBuffer {}
  interface GPUCommandBufferDescriptor {}  interface GPUTextureViewDescriptor {}
  
  // Canvas context for WebGPU
  interface GPUCanvasContext {
    canvas: HTMLCanvasElement;
    configure(configuration: GPUCanvasConfiguration): void;
    unconfigure(): void;
    getCurrentTexture(): GPUTexture;
  }
  
  interface GPUCanvasConfiguration {
    device: GPUDevice;
    format: GPUTextureFormat;
    usage?: GPUTextureUsage;
    colorSpace?: 'srgb' | 'display-p3';
    alphaMode?: 'opaque' | 'premultiplied';
  }
  
  // Extended HTMLCanvasElement
  interface HTMLCanvasElement {
    getContext(contextId: 'webgpu'): GPUCanvasContext | null;
  }
  
  // Global GPU object
  interface Navigator {
    gpu?: GPU;
  }
}