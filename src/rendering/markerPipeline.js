import { markerVertexShaderCode, markerFragmentShaderCode } from '../shaders/markerShader.js';

export function createMarkerPipeline(device, format) {
    // Define bind group layouts
    const markerBindGroupLayout0 = device.createBindGroupLayout({
        entries: [{
            binding: 0,
            visibility: GPUShaderStage.VERTEX,
            buffer: { type: 'uniform' }
        }]
    });
    
    const markerBindGroupLayout1 = device.createBindGroupLayout({
        entries: [{
            binding: 0,
            visibility: GPUShaderStage.VERTEX,
            buffer: { type: 'read-only-storage' }
        }]
    });
    
    const pipelineLayout = device.createPipelineLayout({
        bindGroupLayouts: [markerBindGroupLayout0, markerBindGroupLayout1]
    });

    return device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: {
            module: device.createShaderModule({ code: markerVertexShaderCode }),
            entryPoint: 'main',
            buffers: [{
                arrayStride: 8,
                attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }]
            }]
        },
        fragment: {
            module: device.createShaderModule({ code: markerFragmentShaderCode }),
            entryPoint: 'main',
            targets: [{
                format,
                blend: {
                    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                    alpha: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' }
                }
            }]
        },
        primitive: { 
            topology: 'triangle-list'
        }
    });
}
