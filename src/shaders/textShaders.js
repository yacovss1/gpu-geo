// GPU Text Rendering Shaders
// 
// Instanced rendering approach: generates quads in vertex shader, one instance per character.
// No vertex buffers needed - uses vertex_index and instance_index to generate geometry.
//
// Architecture:
// - Vertex shader: Iterates through labels to find which label contains the current character,
//   then generates a quad for that character with proper positioning and UV mapping
// - Fragment shader: Samples from font atlas texture
//
// Performance: Single draw call for all labels, GPU-only computation

export const textShaderCode = `
struct Marker {
    center: vec2<f32>,
    color: vec4<f32>,
};

struct Label {
    featureId: u32,
    charStart: u32,
    charCount: u32,
    padding: u32,
};

struct CharMetrics {
    u0: f32,
    v0: f32,
    u1: f32,
    v1: f32,
    width: f32,
    advance: f32,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>,
};

@group(0) @binding(0) var texSampler: sampler;
@group(0) @binding(1) var fontAtlas: texture_2d<f32>;

@group(1) @binding(0) var<storage> markers: array<Marker>;
@group(1) @binding(1) var<storage> labels: array<Label>;
@group(1) @binding(2) var<storage> textData: array<u32>;
@group(1) @binding(3) var<storage> charMetrics: array<CharMetrics>;
@group(1) @binding(4) var<storage> heights: array<f32>;

@vertex
fn vertexMain(
    @builtin(vertex_index) vertexId: u32,
    @builtin(instance_index) charInstanceId: u32
) -> VertexOutput {
    var output: VertexOutput;
    
    // Find which label and which character this instance represents
    // Need to iterate through labels to find which one this character belongs to
    var labelId: u32 = 0u;
    var charInLabel: u32 = 0u;
    var charsProcessed: u32 = 0u;
    
    // Find the label that contains this character instance
    for (var i: u32 = 0u; i < arrayLength(&labels); i = i + 1u) {
        let label = labels[i];
        if (charInstanceId < charsProcessed + label.charCount) {
            labelId = i;
            charInLabel = charInstanceId - charsProcessed;
            break;
        }
        charsProcessed = charsProcessed + label.charCount;
    }
    
    if (labelId >= arrayLength(&labels)) {
        // Out of bounds - discard
        output.position = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        return output;
    }
    
    let label = labels[labelId];
    
    if (charInLabel >= label.charCount) {
        // This character doesn't exist for this label
        output.position = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        return output;
    }
    
    // Get marker position
    let marker = markers[label.featureId];
    
    // Get height offset for this feature (3D building height)
    let heightOffset = heights[label.featureId];
    
    // Skip labels with invalid positions (0,0 would cluster at origin)
    if (marker.center.x == 0.0 && marker.center.y == 0.0) {
        output.position = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        return output;
    }
    
    // Get character
    let charIndex = label.charStart + charInLabel;
    let charCode = textData[charIndex];
    let metrics = charMetrics[charCode];
    
    // Calculate character position offset
    var xOffset: f32 = 0.0;
    for (var i: u32 = 0u; i < charInLabel; i = i + 1u) {
        let prevCharCode = textData[label.charStart + i];
        let prevMetrics = charMetrics[prevCharCode];
        xOffset = xOffset + prevMetrics.advance * 0.04;
    }
    
    // Center the text
    var totalWidth: f32 = 0.0;
    for (var i: u32 = 0u; i < label.charCount; i = i + 1u) {
        let cCode = textData[label.charStart + i];
        let cMetrics = charMetrics[cCode];
        totalWidth = totalWidth + cMetrics.advance * 0.04;
    }
    xOffset = xOffset - totalWidth * 0.5;
    
    // Generate quad corners (triangle list: 0,1,2, 0,2,3 pattern)
    let charWidth = 0.024;
    let charHeight = 0.04;
    
    var corner: vec2<f32>;
    var uv: vec2<f32>;
    
    let vid = vertexId % 6u;
    if (vid == 0u) {
        corner = vec2<f32>(-charWidth, -charHeight);
        uv = vec2<f32>(metrics.u0, metrics.v1);
    } else if (vid == 1u) {
        corner = vec2<f32>(charWidth, -charHeight);
        uv = vec2<f32>(metrics.u1, metrics.v1);
    } else if (vid == 2u) {
        corner = vec2<f32>(charWidth, charHeight);
        uv = vec2<f32>(metrics.u1, metrics.v0);
    } else if (vid == 3u) {
        corner = vec2<f32>(-charWidth, -charHeight);
        uv = vec2<f32>(metrics.u0, metrics.v1);
    } else if (vid == 4u) {
        corner = vec2<f32>(charWidth, charHeight);
        uv = vec2<f32>(metrics.u1, metrics.v0);
    } else {
        corner = vec2<f32>(-charWidth, charHeight);
        uv = vec2<f32>(metrics.u0, metrics.v0);
    }
    
    // Offset text slightly above the marker point, adding height for 3D buildings
    let finalPos = marker.center + vec2<f32>(xOffset, 0.035 + heightOffset) + corner;
    output.position = vec4<f32>(finalPos, 0.0, 1.0);
    output.texCoord = uv;
    
    return output;
}

@fragment
fn fragmentMain(@location(0) texCoord: vec2<f32>) -> @location(0) vec4<f32> {
    let texColor = textureSample(fontAtlas, texSampler, texCoord);
    
    // Black text instead of white
    return vec4<f32>(0.0, 0.0, 0.0, texColor.r);
}
`;
