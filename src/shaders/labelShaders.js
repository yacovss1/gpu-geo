export const labelVertexShaderCode = `
struct Uniforms {
    transform: mat4x4<f32>,
};

struct Label {
    position: vec2<f32>,  // Position in clip space
    size: vec2<f32>,      // Width and height in clip space
    texCoord: vec4<f32>,  // uv coordinates in atlas (x, y, width, height)
    color: vec4<f32>,     // Text color
    priority: f32,        // Label priority
    state: f32,           // Visibility state (1=visible, 0=hidden)
};

struct VertexInput {
    @location(0) quadPosition: vec2<f32>,  // Vertex position within quad (-0.5 to 0.5)
    @location(1) texCoord: vec2<f32>,      // Texture coordinate for this vertex (0 to 1)
    @builtin(instance_index) instanceIndex: u32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> labels: array<Label>;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>,
    @location(1) color: vec4<f32>,
};

@vertex
fn main(input: VertexInput) -> VertexOutput {
    // CRITICAL FIX: Fixed the shader syntax error by initializing the output variable
    var output: VertexOutput;
    
    // CRITICAL FIX: Force all labels to be fixed-position with solid red color
    
    // Fixed position in center of screen with a large size
    output.position = vec4<f32>(
        input.quadPosition.x * 0.8,  // Large 80% of screen width
        input.quadPosition.y * 0.3,  // 30% of screen height
        0.0,
        1.0
    );
    
    output.texCoord = input.texCoord;
    output.color = vec4<f32>(1.0, 0.0, 0.0, 1.0);
    
    return output;
}
`;

export const labelFragmentShaderCode = `
@group(1) @binding(0) var fontAtlas: texture_2d<f32>;
@group(1) @binding(1) var fontSampler: sampler;

@fragment
fn main(
    @location(0) texCoord: vec2<f32>,
    @location(1) color: vec4<f32>
) -> @location(0) vec4<f32> {
    // CRITICAL FIX: Just return a solid color to confirm shader is running
    return vec4<f32>(1.0, 0.0, 0.0, 1.0);
}
`;
