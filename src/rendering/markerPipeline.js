import { markerVertexShaderCode, markerFragmentShaderCode } from '../shaders/markerShader.js';

export function createMarkerPipeline(device, format) {
    // Debug: log shader code to verify it's correct
    if (!window._markerShaderLogged) {
        console.log('🔍 Marker shader code:', markerVertexShaderCode.substring(0, 500));
        window._markerShaderLogged = true;
    }
    
    // Define bind group layout - camera uniform + markers storage buffer
    const markerBindGroupLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                buffer: { type: 'uniform' } // Camera matrix uniform
            },
            {
                binding: 1,
                visibility: GPUShaderStage.VERTEX,
                buffer: { type: 'read-only-storage' } // Markers storage buffer
            }
        ]
    });
    
    const pipelineLayout = device.createPipelineLayout({
        bindGroupLayouts: [markerBindGroupLayout]
    });

    const pipeline = device.createRenderPipeline({
        label: 'Marker Pipeline',
        layout: pipelineLayout,
        vertex: {
            module: device.createShaderModule({ 
                label: 'Marker Vertex Shader',
                code: markerVertexShaderCode 
            }),
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
    
    return { pipeline, bindGroupLayout: markerBindGroupLayout };
}
