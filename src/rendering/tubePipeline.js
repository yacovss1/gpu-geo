// Tube/Pipe Rendering Pipeline
// Handles line-extrusion type layers with full 3D cylinder geometry

import { tubeVertexShaderCode, tubeFragmentShaderCode } from '../shaders/tubeShaders.js';

export class TubePipeline {
    constructor(device, format) {
        this.device = device;
        this.format = format;
        this.pipeline = null;
        this.bindGroup = null;
        this.cameraBuffer = null;
        this.paramsBuffer = null;
        this.segmentBuffer = null;
        this.indexBuffer = null;
        this.initialized = false;
        this.maxSegments = 10000; // Maximum line segments per layer
    }

    /**
     * Initialize the rendering pipeline
     */
    async initialize(cameraBuffer) {
        this.cameraBuffer = cameraBuffer;

        // Create params buffer for tube properties (radius, depth, segments, padding)
        this.paramsBuffer = this.device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        // Create segment storage buffer (startPos, endPos, color per segment)
        // Layout: vec2 startPos + vec2 endPos + vec4 color = 12 floats * 4 bytes = 48 bytes per segment
        this.segmentBuffer = this.device.createBuffer({
            size: this.maxSegments * 48,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });

        // Compile shaders
        const vertexShader = this.device.createShaderModule({
            code: tubeVertexShaderCode,
            label: 'Tube Vertex Shader'
        });

        const fragmentShader = this.device.createShaderModule({
            code: tubeFragmentShaderCode,
            label: 'Tube Fragment Shader'
        });

        // Create bind group layout
        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: 'uniform' }
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: 'uniform' }
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: 'read-only-storage' }
                }
            ]
        });

        // Create pipeline with instanced rendering
        this.pipeline = this.device.createRenderPipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [bindGroupLayout]
            }),
            vertex: {
                module: vertexShader,
                entryPoint: 'main',
                buffers: []
            },
            fragment: {
                module: fragmentShader,
                entryPoint: 'main',
                targets: [{
                    format: this.format,
                    blend: {
                        color: {
                            srcFactor: 'src-alpha',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add'
                        },
                        alpha: {
                            srcFactor: 'one',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add'
                        }
                    }
                }]
            },
            primitive: {
                topology: 'triangle-list',
                stripIndexFormat: undefined,
                cullMode: 'none'  // Disable culling to see both sides
            },
            depthStencil: {
                depthWriteEnabled: false,
                depthCompare: 'always',
                format: 'depth24plus'
            },
            multisample: { count: 4 }
        });

        // Create bind group
        this.bindGroup = this.device.createBindGroup({
            layout: bindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: { buffer: this.cameraBuffer }
                },
                {
                    binding: 1,
                    resource: { buffer: this.paramsBuffer }
                },
                {
                    binding: 2,
                    resource: { buffer: this.segmentBuffer }
                }
            ]
        });

        // Generate index buffer for cylinder mesh
        this.createIndexBuffer();
        
        // Create dummy vertex buffer (we generate geometry in shader, but need buffer for indexed draw)
        const verticesPerInstance = this.currentSegments * 2; // 2 rings
        this.vertexBuffer = this.device.createBuffer({
            size: verticesPerInstance * 4, // Just dummy data
            usage: GPUBufferUsage.VERTEX
        });

        this.initialized = true;
    }

    /**
     * Create index buffer for cylinder mesh
     * Generates indices for a cylinder with N segments around the circumference
     */
    createIndexBuffer() {
        const segments = 8; // Default, matches shader
        
        // Generate indices to connect two rings of vertices into a cylinder
        // Ring 0 vertices: 0 to (segments-1)
        // Ring 1 vertices: segments to (2*segments-1)
        const indices = [];
        
        for (let i = 0; i < segments; i++) {
            const next = (i + 1) % segments;
            
            // Two triangles per segment to form a quad
            // Triangle 1: current-start, next-start, current-end
            indices.push(i, next, segments + i);
            
            // Triangle 2: next-start, next-end, current-end
            indices.push(next, segments + next, segments + i);
        }
        
        this.indexBuffer = this.device.createBuffer({
            size: Math.max(1024, indices.length * 4),
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
        });
        
        this.device.queue.writeBuffer(this.indexBuffer, 0, new Uint32Array(indices));
        this.indexCount = indices.length;
        this.currentSegments = segments;
    }

    /**
     * Update index buffer when segment count changes
     */
    updateIndexBuffer(segments) {
        const indices = [];
        
        for (let i = 0; i < segments; i++) {
            const next = (i + 1) % segments;
            
            // Two triangles per quad segment
            indices.push(i, next, segments + i);
            indices.push(next, segments + next, segments + i);
        }
        
        this.device.queue.writeBuffer(this.indexBuffer, 0, new Uint32Array(indices));
        this.indexCount = indices.length;
        this.currentSegments = segments;
    }

    /**
     * Render tubes from line features
     */
    render(passEncoder, tileBuffers, layer, zoom) {
        if (!this.initialized || !this.pipeline) {
            console.log('🔴 TUBE RENDER: Not initialized or no pipeline');
            return 0;
        }

        // Extract paint properties
        const paint = layer.paint || {};
        const metadata = layer.metadata || {};
        const pipeConfig = metadata['pipe-config'] || {};
        
        // Get tube parameters from pipe-config
        const radius = pipeConfig.radius || 0.002;
        const depth = pipeConfig.depth || 0.01;
        const segments = pipeConfig.segments || 8;
        
        // Scale radius based on zoom like regular lines do
        // At higher zoom, lines appear thicker in world space
        const zoomScale = Math.pow(2, 14 - zoom); // Inverse zoom scale
        const scaledRadius = radius * zoomScale;
        const scaledDepth = depth * zoomScale;

        // Update params buffer
        const paramsData = new Float32Array([scaledRadius, scaledDepth, segments, 0.0]);
        this.device.queue.writeBuffer(this.paramsBuffer, 0, paramsData);

        // Get buffers for this layer
        const layerBuffers = tileBuffers.get(layer.id);
        
        if (!layerBuffers || layerBuffers.length === 0) {
            console.log(`🔴 TUBE RENDER: No buffers for layer ${layer.id}`);
            return 0;
        }

        // Collect all line segments from all tiles for this layer
        const segmentData = [];
        for (const buffer of layerBuffers) {
            if (buffer.lineSegments && buffer.lineSegments.length > 0) {
                segmentData.push(...buffer.lineSegments);
            }
        }

        if (segmentData.length === 0) {
            console.log(`🔴 TUBE RENDER: No segment data for layer ${layer.id}`);
            return 0;
        }

        // Validate segment data alignment (must be multiple of 12 floats)
        if (segmentData.length % 12 !== 0) {
            console.warn(`⚠️ Tube: Invalid segment data length ${segmentData.length}, not multiple of 12`);
            return 0;
        }

        const instanceCount = segmentData.length / 12;

        // Upload segment data to GPU
        const segmentArray = new Float32Array(segmentData);
        this.device.queue.writeBuffer(this.segmentBuffer, 0, segmentArray);

        // Set pipeline and draw
        passEncoder.setPipeline(this.pipeline);
        passEncoder.setBindGroup(0, this.bindGroup);
        
        // Draw: 48 vertices per instance (triangles for 8-segment cylinder)
        // Each instance draws its own cylinder
        passEncoder.draw(48, instanceCount);

        return instanceCount;
    }

    /**
     * Clean up GPU resources
     */
    destroy() {
        if (this.paramsBuffer) {
            this.paramsBuffer.destroy();
            this.paramsBuffer = null;
        }
        if (this.segmentBuffer) {
            this.segmentBuffer.destroy();
            this.segmentBuffer = null;
        }
        if (this.indexBuffer) {
            this.indexBuffer.destroy();
            this.indexBuffer = null;
        }
        this.pipeline = null;
        this.bindGroup = null;
        this.initialized = false;
    }
}
