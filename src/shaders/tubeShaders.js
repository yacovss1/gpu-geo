// Tube/Pipe Extrusion Shaders
// Renders line strings as 3D cylindrical tubes (pipes, cables, etc.)

/**
 * Tube Vertex Shader
 * Generates cylinder geometry around line segments
 */
export const tubeVertexShaderCode = `
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) worldPos: vec3<f32>
};

struct TubeParams {
    radius: f32,
    depth: f32,
    segments: f32,
    padding: f32
};

@group(0) @binding(0) var<uniform> cameraMatrix: mat4x4<f32>;
@group(0) @binding(1) var<uniform> tubeParams: TubeParams;

@vertex
fn main(
    @location(0) position: vec3<f32>,
    @location(1) color: vec4<f32>,
    @builtin(vertex_index) vertexId: u32,
    @builtin(instance_index) segmentId: u32
) -> VertexOutput {
    var output: VertexOutput;
    
    // For now, simple implementation: render as thick line at depth
    // Full cylinder generation would need line segment buffer
    
    // Apply depth offset (negative = underground)
    let worldPos = vec3<f32>(position.x, position.y, tubeParams.depth);
    
    // Transform to clip space
    output.position = cameraMatrix * vec4<f32>(worldPos, 1.0);
    output.color = color;
    output.worldPos = worldPos;
    output.normal = vec3<f32>(0.0, 0.0, 1.0);
    
    return output;
}
`;

/**
 * Tube Fragment Shader
 * Shades pipes with depth-based lighting
 */
export const tubeFragmentShaderCode = `
@fragment
fn main(
    @location(0) color: vec4<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) worldPos: vec3<f32>
) -> @location(0) vec4<f32> {
    
    // Simple lighting for underground pipes
    let lightDir = normalize(vec3<f32>(0.5, 0.5, 1.0));
    let diffuse = max(dot(normal, lightDir), 0.3); // Minimum ambient
    
    // Darken based on depth (deeper = darker)
    let depthFactor = clamp(1.0 + worldPos.z * 0.1, 0.5, 1.0);
    
    let litColor = color.rgb * diffuse * depthFactor;
    
    return vec4<f32>(litColor, color.a * 0.8); // Slightly transparent
}
`;
