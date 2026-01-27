// Shader Effect Manager
// Creates and manages specialized rendering pipelines for visual effects

import { 
    waterVertexShaderCode,
    waterFragmentShaderCode,
    glassFragmentShaderCode, 
    grassVertexShaderCode,
    standardFragmentShaderCode 
} from '../shaders/effects/index.js';
import { vertexShaderCode } from '../shaders/shaders.js';

export class ShaderEffectManager {
    constructor(device) {
        this.device = device;
        this.pipelines = new Map();
        this.timeBuffer = null;
        this.currentTime = 0;
        this.cachedShaderModules = new Map();
        
        // Initialize time buffer for animated effects
        this.initTimeBuffer();
    }
    
    initTimeBuffer() {
        this.timeBuffer = this.device.createBuffer({
            size: 4, // Single f32 for time
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(this.timeBuffer, 0, new Float32Array([0]));
    }
    
    /**
     * Get or create a shader module (cached)
     */
    getShaderModule(name, code) {
        if (!this.cachedShaderModules.has(name)) {
            this.cachedShaderModules.set(
                name, 
                this.device.createShaderModule({ code })
            );
        }
        return this.cachedShaderModules.get(name);
    }
    
    /**
     * Create effect pipeline based on type
     */
    createEffectPipeline(effectType, format) {
        switch(effectType) {
            case 'animated-water':
                return this.createWaterPipeline(format);
            case 'glass':
                return this.createGlassPipeline(format);
            case 'grass':
                return this.createGrassPipeline(format);
            default:
                console.warn(`Unknown effect type: ${effectType}`);
                return null;
        }
    }
    
    /**
     * Create water animation pipeline
     */
    createWaterPipeline(format) {
        const vertexModule = this.getShaderModule('water-vertex', waterVertexShaderCode);
        const fragmentModule = this.getShaderModule('water-fragment', waterFragmentShaderCode);
        
        // Create bind group layout with camera uniform and time
        const cameraBindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: "uniform" }
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: "uniform" }
                }
            ]
        });
        
        // Terrain bind group layout (must match main shaders with splatmap)
        const terrainBindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX,
                    texture: { sampleType: 'float' }
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.VERTEX,
                    sampler: { type: 'filtering' }
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: "uniform" }
                },
                {
                    binding: 3,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'float' }
                },
                {
                    binding: 4,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: { type: 'filtering' }
                }
            ]
        });
        
        const pipelineLayout = this.device.createPipelineLayout({ 
            bindGroupLayouts: [cameraBindGroupLayout, terrainBindGroupLayout] 
        });
        
        return this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: vertexModule,
                entryPoint: "main",
                buffers: [{
                    // Vertex format: position(3) + normal(3) + color(4) = 10 floats = 40 bytes
                    arrayStride: 40,
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x3' },   // position
                        { shaderLocation: 1, offset: 12, format: 'float32x3' },  // normal
                        { shaderLocation: 2, offset: 24, format: 'float32x4' }   // color
                    ]
                }],
            },
            fragment: {
                module: fragmentModule,
                entryPoint: "main",
                targets: [{
                    format: format,
                    blend: {
                        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
                    }
                }],
            },
            primitive: { 
                topology: "triangle-list", 
                cullMode: 'none', 
                frontFace: 'ccw' 
            },
            depthStencil: {
                format: 'depth24plus',
                depthWriteEnabled: false,  // Water doesn't write depth - rendered via painter's algorithm
                depthCompare: 'always',    // Painter's algorithm - layer order determines visibility, not depth
            },
            multisample: { count: 4 }
        });
    }

    /**
     * Create glass effect pipeline (for tall buildings)
     */
    createGlassPipeline(format) {
        // Use standard vertex shader from main shaders
        const vertexModule = this.getShaderModule('standard-vertex', vertexShaderCode);
        const fragmentModule = this.getShaderModule('glass-fragment', glassFragmentShaderCode);
        
        // Group 0: Camera uniform
        const cameraBindGroupLayout = this.device.createBindGroupLayout({
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                buffer: { type: "uniform" }
            }]
        });
        
        // Group 1: Terrain data (must match main shader bindings with splatmap)
        const terrainBindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX,
                    texture: { sampleType: 'float' }
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.VERTEX,
                    sampler: { type: 'filtering' }
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: "uniform" }
                },
                {
                    binding: 3,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'float' }
                },
                {
                    binding: 4,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: { type: 'filtering' }
                }
            ]
        });
        
        // Group 2: Shadow map data (must match main vertex shader bindings)
        const shadowBindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: "uniform" }  // Light space matrix
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'depth' }  // Shadow depth texture
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: { type: 'comparison' }  // Comparison sampler for shadow testing
                }
            ]
        });
        
        const pipelineLayout = this.device.createPipelineLayout({ 
            bindGroupLayouts: [cameraBindGroupLayout, terrainBindGroupLayout, shadowBindGroupLayout] 
        });
        
        return this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: vertexModule,
                entryPoint: "main",
                buffers: [{
                    // Vertex format: position(3) + normal(3) + color(4) = 10 floats = 40 bytes
                    arrayStride: 40,
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x3' },   // position
                        { shaderLocation: 1, offset: 12, format: 'float32x3' },  // normal
                        { shaderLocation: 2, offset: 24, format: 'float32x4' }   // color
                    ]
                }],
            },
            fragment: {
                module: fragmentModule,
                entryPoint: "main",
                targets: [{
                    format: format,
                    blend: {
                        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
                    }
                }],
            },
            primitive: { 
                topology: "triangle-list", 
                cullMode: 'none', 
                frontFace: 'ccw' 
            },
            depthStencil: {
                format: 'depth24plus',
                depthWriteEnabled: true,
                depthCompare: 'less-equal',
            },
            multisample: { count: 4 }
        });
    }
    
    /**
     * Create grass wind effect pipeline
     */
    createGrassPipeline(format) {
        const vertexModule = this.getShaderModule('grass-vertex', grassVertexShaderCode);
        const fragmentModule = this.getShaderModule('standard-fragment', standardFragmentShaderCode);
        
        const cameraBindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: "uniform" }
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: "uniform" }
                }
            ]
        });
        
        // Terrain bind group layout (same as main shaders with splatmap)
        const terrainBindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX,
                    texture: { sampleType: 'float' }
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.VERTEX,
                    sampler: { type: 'filtering' }
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: "uniform" }
                },
                {
                    binding: 3,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'float' }
                },
                {
                    binding: 4,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: { type: 'filtering' }
                }
            ]
        });
        
        const pipelineLayout = this.device.createPipelineLayout({ 
            bindGroupLayouts: [cameraBindGroupLayout, terrainBindGroupLayout] 
        });
        
        return this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: vertexModule,
                entryPoint: "main",
                buffers: [{
                    // Vertex format: position(3) + normal(3) + color(4) = 10 floats = 40 bytes
                    arrayStride: 40,
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x3' },   // position
                        { shaderLocation: 1, offset: 12, format: 'float32x3' },  // normal
                        { shaderLocation: 2, offset: 24, format: 'float32x4' }   // color
                    ]
                }],
            },
            fragment: {
                module: fragmentModule,
                entryPoint: "main",
                targets: [{
                    format: format,
                    blend: {
                        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
                    }
                }],
            },
            primitive: { 
                topology: "triangle-list", 
                cullMode: 'none', 
                frontFace: 'ccw' 
            },
            depthStencil: {
                format: 'depth24plus',
                depthWriteEnabled: false,  // Grass doesn't write depth - rendered via painter's algorithm
                depthCompare: 'always',    // Painter's algorithm - layer order determines visibility
            },
            multisample: { count: 4 }
        });
    }
    
    /**
     * Create bind group for effect pipeline with time uniform
     */
    createEffectBindGroup(pipeline, cameraBuffer) {
        return this.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: cameraBuffer } },
                { binding: 1, resource: { buffer: this.timeBuffer } }
            ]
        });
    }
    
    /**
     * Update time uniform for animations
     */
    updateTime(deltaTime) {
        this.currentTime += deltaTime;
        this.device.queue.writeBuffer(
            this.timeBuffer, 
            0, 
            new Float32Array([this.currentTime])
        );
    }
}
