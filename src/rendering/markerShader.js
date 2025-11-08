export const markerVertexShaderCode = `
struct Uniforms {
    transform: mat4x4<f32>,
};

struct Marker {
    center: vec2<f32>, // Normalized coordinates (0-1)
    color: vec4<f32>,
};

struct VertexInput {
    @location(0) quadPos: vec2<f32>, // Vertex offset; range roughly [-0.5, 0.5]
    @builtin(instance_index) instanceIndex: u32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(1) @binding(0) var<storage, read> markers: array<Marker>;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
};

@vertex
fn main(input: VertexInput) -> VertexOutput {
    let marker = markers[input.instanceIndex];
    
    // Skip invalid markers (those with zero position)
    if (marker.center.x == 0.0 && marker.center.y == 0.0) {
        return VertexOutput(
            vec4<f32>(-100.0, -100.0, 0.0, 1.0),
            vec4<f32>(0.0, 0.0, 0.0, 0.0)
        );
    }
    
    // Use fixed marker size for visibility
    let markerSize = 0.02;
    
    // Position the marker in normalized space
    var output: VertexOutput;
    output.position = vec4<f32>(
        marker.center.x + input.quadPos.x * markerSize,
        marker.center.y + input.quadPos.y * markerSize,
        0.0,
        1.0
    );
    
    output.color = marker.color;
    return output;
}
`;

export const markerFragmentShaderCode = `
@fragment
fn main(@location(0) color: vec4<f32>) -> @location(0) vec4<f32> {
    return color;
}
`;