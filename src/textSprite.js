// NEW: Pipeline for rendering text as sprites
export function createTextSpritePipeline(device, format) {
    // Create a bind group layout for a sampler and texture.
    const textBindGroupLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }
        ]
    });

    // NEW: Create an additional bind group layout for label transform
    const transformBindGroupLayout = device.createBindGroupLayout({
        entries: [{
            binding: 0,
            visibility: GPUShaderStage.VERTEX,
            buffer: { type: "uniform" }
        }]
    });

    // Update pipeline layout to use both layouts
    const pipelineLayout = device.createPipelineLayout({ 
        bindGroupLayouts: [ 
            // Group 0: sampler & texture
            textBindGroupLayout,
            // Group 1: text transform uniform
            transformBindGroupLayout
        ] 
    });

    // UPDATED vertex shader for debugging: output a full-screen quad without applying the transform
    const vertexShaderCode = `
    // Define output structure
    struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) texCoord: vec2<f32>,
    };

    @group(1) @binding(0) var<uniform> labelTransform : mat4x4<f32>;

    @vertex
    fn main(@builtin(vertex_index) vi: u32) -> VertexOutput {
        var positions = array<vec2<f32>, 4>(
            vec2<f32>(-1.0, -1.0),
            vec2<f32>(1.0, -1.0),
            vec2<f32>(-1.0, 1.0),
            vec2<f32>(1.0, 1.0)
        );
        var texCoords = array<vec2<f32>, 4>(
            vec2<f32>(0.0, 1.0),
            vec2<f32>(1.0, 1.0),
            vec2<f32>(0.0, 0.0),
            vec2<f32>(1.0, 0.0)
        );
        var output: VertexOutput;
        // For testing, ignore labelTransform and use positions directly
        output.position = vec4<f32>(positions[vi], 0.0, 1.0);
        output.texCoord = texCoords[vi];
        return output;
    }
    `;

    // UPDATED: Replace the fragment shader code for debugging
    const fragmentShaderCode = `
    // @group(0) @binding(0) var mySampler: sampler;
    // @group(0) @binding(1) var myTexture: texture_2d<f32>;
    @fragment
    fn main(@location(0) texCoord: vec2<f32>) -> @location(0) vec4<f32> {
        // For debugging, return a solid red color
        return vec4<f32>(1.0, 0.0, 0.0, 1.0);
    }
    `;

    return device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: {
            module: device.createShaderModule({ code: vertexShaderCode }),
            entryPoint: 'main'
        },
        fragment: {
            module: device.createShaderModule({ code: fragmentShaderCode }),
            entryPoint: 'main',
            targets: [{ format }]
        },
        primitive: { topology: 'triangle-strip' }
    });
}
