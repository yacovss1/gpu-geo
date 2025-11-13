export const markerVertexShaderCode = `
struct Marker {
    center: vec2<f32>,  // Clip-space position from rendered scene (-1 to 1)
    height: f32,        // Building height in meters
    padding: f32,       // Alignment padding
    color: vec4<f32>,
    featureId: u32,     // Feature ID
    padding2: u32,      // Alignment padding
};

struct VertexInput {
    @location(0) quadPos: vec2<f32>, // Vertex offset for marker shape
    @builtin(instance_index) instanceIndex: u32,
};

@group(0) @binding(0) var<uniform> cameraMatrix: mat4x4<f32>;
@group(0) @binding(1) var<storage, read> markers: array<Marker>;

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
    
    // Marker center is from compute shader reading hidden texture
    // Hidden texture applied same isometric offset as visible geometry
    // So marker position is already correct - use directly
    let markerSize = 0.02;
    
    var output: VertexOutput;
    output.position = vec4<f32>(
        marker.center.x + input.quadPos.x * markerSize,
        marker.center.y + input.quadPos.y * markerSize,
        0.5,
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
