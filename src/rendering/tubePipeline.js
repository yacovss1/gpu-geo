// Tube/Pipe Rendering Pipeline
// Handles line-extrusion type layers from MapLibre style spec

import { tubeVertexShaderCode, tubeFragmentShaderCode } from '../shaders/tubeShaders.js';

export class TubePipeline {
    constructor(device, format) {
        this.device = device;
        this.format = format;
        this.pipeline = null;
        this.bindGroup = null;
        this.cameraBuffer = null;
        this.paramsBuffer = null;
        this.initialized = false;
    }

    /**
     * Initialize the rendering pipeline
     */
    async initialize(cameraBuffer) {
        this.cameraBuffer = cameraBuffer;

        // Create params buffer for tube properties
        this.paramsBuffer = this.device.createBuffer({
            size: 16, // radius(f32) + depth(f32) + segments(f32) + padding(f32)
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
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
                }
            ]
        });

        // Create pipeline
        this.pipeline = this.device.createRenderPipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [bindGroupLayout]
            }),
            vertex: {
                module: vertexShader,
                entryPoint: 'main',
                buffers: [
                    {
                        arrayStride: 12, // vec3<f32> position
                        attributes: [
                            {
                                shaderLocation: 0,
                                offset: 0,
                                format: 'float32x3'
                            }
                        ]
                    },
                    {
                        arrayStride: 16, // vec4<f32> color
                        attributes: [
                            {
                                shaderLocation: 1,
                                offset: 0,
                                format: 'float32x4'
                            }
                        ]
                    }
                ]
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
                topology: 'line-strip',
                stripIndexFormat: undefined
            },
            depthStencil: {
                depthWriteEnabled: true,
                depthCompare: 'less',
                format: 'depth24plus'
            }
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
                }
            ]
        });

        this.initialized = true;
    }

    /**
     * Render tubes from processed tile data
     */
    render(passEncoder, tilesData, layer, zoom) {
        if (!this.initialized || !this.pipeline) return;

        // Extract paint properties
        const paint = layer.paint || {};
        const radius = paint['line-radius'] || 0.5;
        const depth = paint['line-depth'] || 0.0;
        const metadata = layer.metadata || {};
        const pipeConfig = metadata['pipe-config'] || {};
        const segments = pipeConfig.segments || 8;

        // Update params buffer
        const paramsData = new Float32Array([radius, depth, segments, 0.0]);
        this.device.queue.writeBuffer(this.paramsBuffer, 0, paramsData);

        // Set pipeline
        passEncoder.setPipeline(this.pipeline);
        passEncoder.setBindGroup(0, this.bindGroup);

        // Render each tile's line features
        let drawnSegments = 0;
        for (const tile of tilesData) {
            if (!tile.buffers || !tile.buffers[layer.id]) continue;

            const layerBuffers = tile.buffers[layer.id];
            if (!layerBuffers.vertexBuffer || !layerBuffers.colorBuffer) continue;

            // Set vertex and color buffers
            passEncoder.setVertexBuffer(0, layerBuffers.vertexBuffer);
            passEncoder.setVertexBuffer(1, layerBuffers.colorBuffer);

            // Draw lines
            const vertexCount = layerBuffers.vertexCount || 0;
            if (vertexCount > 0) {
                passEncoder.draw(vertexCount);
                drawnSegments++;
            }
        }

        return drawnSegments;
    }

    /**
     * Clean up GPU resources
     */
    destroy() {
        if (this.paramsBuffer) {
            this.paramsBuffer.destroy();
            this.paramsBuffer = null;
        }
        this.pipeline = null;
        this.bindGroup = null;
        this.initialized = false;
    }
}
