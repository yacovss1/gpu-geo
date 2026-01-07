// Tube/Pipe Extrusion Shaders
// Renders line strings as 3D cylindrical tubes (pipes, cables, etc.)

/**
 * Tube Vertex Shader
 * Generates cylinder geometry around line segments using instanced rendering
 * Each instance represents one line segment, vertices are extruded into cylinder
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

struct SegmentData {
    startPos: vec2<f32>,
    endPos: vec2<f32>,
    color: vec4<f32>,
    padding: vec4<f32>  // Padding to align to 16-byte boundary (total 48 bytes)
};

@group(0) @binding(0) var<uniform> cameraMatrix: mat4x4<f32>;
@group(0) @binding(1) var<uniform> tubeParams: TubeParams;
@group(0) @binding(2) var<storage, read> segments: array<SegmentData>;

@vertex
fn main(
    @builtin(vertex_index) vertexIndex: u32,
    @builtin(instance_index) instanceId: u32
) -> VertexOutput {
    var output: VertexOutput;
    
    let segment = segments[instanceId];
    let segmentCount = u32(tubeParams.segments);
    
    // Convert vertex index to triangle topology
    // 48 vertices = 16 triangles = 8 quads (one per segment)
    let quadIndex = vertexIndex / 6u; // Which quad (0-7)
    let vertInQuad = vertexIndex % 6u; // Which vertex in the quad (0-5)
    
    // Map quad vertex to ring and angle
    // Quad vertices: 0,1,2 = first triangle, 3,4,5 = second triangle
    // Triangle 1: (i, i+1, i+seg)
    // Triangle 2: (i+1, i+seg+1, i+seg)
    var ringIndex: u32;
    var angleIndex: u32;
    
    if (vertInQuad == 0u) {
        ringIndex = 0u;
        angleIndex = quadIndex;
    } else if (vertInQuad == 1u) {
        ringIndex = 0u;
        angleIndex = (quadIndex + 1u) % segmentCount;
    } else if (vertInQuad == 2u || vertInQuad == 5u) {
        ringIndex = 1u;
        angleIndex = quadIndex;
    } else if (vertInQuad == 3u) {
        ringIndex = 0u;
        angleIndex = (quadIndex + 1u) % segmentCount;
    } else { // vertInQuad == 4u
        ringIndex = 1u;
        angleIndex = (quadIndex + 1u) % segmentCount;
    }
    
    // Calculate angle around the cylinder
    let angle = f32(angleIndex) * 2.0 * 3.14159265359 / f32(segmentCount);
    
    // Get segment direction
    let segmentVec = segment.endPos - segment.startPos;
    let segmentLength = length(segmentVec);
    
    // Skip degenerate segments
    if (segmentLength < 0.00001) {
        output.position = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        output.color = vec4<f32>(1.0, 1.0, 0.0, 1.0);
        output.normal = vec3<f32>(0.0, 0.0, 1.0);
        output.worldPos = vec3<f32>(0.0, 0.0, 0.0);
        return output;
    }
    
    let segmentDir = normalize(segmentVec);
    let perpendicular = vec2<f32>(-segmentDir.y, segmentDir.x);
    
    // Calculate radius offset - extend vertically in Z axis
    let cosAngle = cos(angle);
    let sinAngle = sin(angle);
    
    // Choose base position (start or end of segment)
    let basePos = select(segment.startPos, segment.endPos, ringIndex == 1u);
    
    // Create 3D position with vertical extrusion
    // Perpendicular offset stays in XY plane, but we also add vertical (Z) offset based on sine
    let horizontalOffset = perpendicular * cosAngle * tubeParams.radius;
    let verticalOffset = sinAngle * tubeParams.radius;
    
    let worldX = basePos.x + horizontalOffset.x;
    let worldY = basePos.y + horizontalOffset.y;
    let worldZ = tubeParams.depth + verticalOffset;
    
    // Apply SAME isometric offset as regular shaders (shift Y based on Z)
    let isoY = worldY - worldZ * 0.3;
    let pos = vec4<f32>(worldX, isoY, 0.0, 1.0);
    
    // Calculate outward-pointing normal - use angle directly for consistent normals
    output.normal = vec3<f32>(perpendicular.x * cosAngle, perpendicular.y * cosAngle, sinAngle);
    
    // Transform to clip space using camera matrix
    output.position = cameraMatrix * pos;
    
    // Set depth similar to regular shader (buildings depth calculation)
    let baseDepth = 0.95;
    output.position.z = baseDepth - (worldZ * 10.0);
    
    output.color = vec4<f32>(1.0, 1.0, 0.0, 1.0);
    output.worldPos = vec3<f32>(worldX, worldY, worldZ);
    
    return output;
}
`;

/**
 * Tube Fragment Shader
 * Apply simple lighting to show cylindrical shape
 */
export const tubeFragmentShaderCode = `
@fragment
fn main(
    @builtin(position) fragCoord: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) worldPos: vec3<f32>
) -> @location(0) vec4<f32> {
    // SUPER BRIGHT MAGENTA - impossible to miss!
    return vec4<f32>(1.0, 0.0, 1.0, 1.0);
}
`;
