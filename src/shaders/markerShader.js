export const markerVertexShaderCode = `
struct Marker {
    center: vec2<f32>,  // Clip-space centroid (-1 to 1)
    height: f32,        // World-space Z height
    padding: f32,       // Alignment padding
    color: vec4<f32>,
    featureId: u32,     // Feature ID
    padding2: u32,      // Alignment padding
};

struct VertexInput {
    @location(0) quadPos: vec2<f32>, // Vertex offset; range roughly [-0.5, 0.5]
    @builtin(instance_index) instanceIndex: u32,
};

@group(0) @binding(0) var<storage, read> markers: array<Marker>;

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
    
    // Marker center is already in clip space (-1 to 1) from compute shader
    // The isometric offset has already been applied in the compute shader
    // to match the building rendering (isoY = y - z * 0.3)
    let isoX = marker.center.x;
    let isoY = marker.center.y;
    
    // Use fixed marker size in screen space
    let markerSize = 0.02;
    
    // Construct final position (already in clip space, no transform needed)
    var output: VertexOutput;
    output.position = vec4<f32>(
        isoX + input.quadPos.x * markerSize,
        isoY + input.quadPos.y * markerSize,
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
