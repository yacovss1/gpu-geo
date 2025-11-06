export const vertexShaderCode = `
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) fragCoord: vec2<f32>,
    @location(1) color: vec4<f32>
};

@group(0) @binding(0) var<uniform> uniforms: mat4x4<f32>;

@vertex
fn main(@location(0) inPosition: vec2<f32>, @location(1) inColor: vec4<f32>) -> VertexOutput {
    var output: VertexOutput;
    // Transform the position while preserving orientation
    output.position = uniforms * vec4<f32>(inPosition.x, inPosition.y, 0.0, 1.0);
    output.fragCoord = output.position.xy;
    output.color = inColor;
    return output;
}
`;

export const fragmentShaderCode = `
// Debugging: Output a solid red color
@fragment
fn main() -> @location(0) vec4<f32> {
    return vec4<f32>(1.0, 0.0, 0.0, 1.0); // Solid red color
}
`;

export const hiddenFragmentShaderCode = `
@fragment
fn main(@location(0) fragCoord: vec2<f32>, @location(1) color: vec4<f32>) -> @location(0) vec4<f32> {
    // Only use red channel for the feature ID, zero out others
    return vec4<f32>(color.r, 0.0, 0.0, 1.0);
}
`;

export const edgeDetectionVertexShaderCode = `
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>
};

@vertex
fn main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    let vertices = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0),  // Triangle 1
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0),
        vec2<f32>(-1.0, 3.0),   // Triangle 2
        vec2<f32>(3.0, -1.0),
        vec2<f32>(3.0, 3.0)
    );
    
    var output: VertexOutput;
    output.position = vec4<f32>(vertices[vertexIndex], 0.0, 1.0);
    output.texCoord = vertices[vertexIndex] * 0.5 + 0.5;
    return output;
}`;

export const edgeDetectionFragmentShaderCode = `
    @group(0) @binding(0) var colorTexture: texture_2d<f32>;
    @group(0) @binding(1) var idTexture: texture_2d<f32>;
    @group(0) @binding(2) var mysampler: sampler;
    @group(0) @binding(3) var<uniform> canvasSize: vec2<f32>;
    @group(0) @binding(4) var<uniform> pickedId: f32;

    @fragment
    fn main(@location(0) texCoord: vec2<f32>) -> @location(0) vec4<f32> {
        let texelSize = 1.0 / canvasSize;
        
        // Get center color and ID
        let centerColor = textureSample(colorTexture, mysampler, texCoord);
        let id = textureSample(idTexture, mysampler, texCoord).r * 255.0;
        
        // Sample neighbors for edge detection
        let leftId = textureSample(idTexture, mysampler, texCoord + vec2<f32>(-texelSize.x, 0.0)).r * 255.0;
        let rightId = textureSample(idTexture, mysampler, texCoord + vec2<f32>(texelSize.x, 0.0)).r * 255.0;
        let upId = textureSample(idTexture, mysampler, texCoord + vec2<f32>(0.0, -texelSize.y)).r * 255.0;
        let downId = textureSample(idTexture, mysampler, texCoord + vec2<f32>(0.0, texelSize.y)).r * 255.0;

        let hasFeature = id > 0.1;
        let isDifferent = hasFeature && (
            abs(id - leftId) > 0.1 || 
            abs(id - rightId) > 0.1 || 
            abs(id - upId) > 0.1 || 
            abs(id - downId) > 0.1
        );
        
        // More lenient comparison for selection
        let isSelected = hasFeature && (abs(id - pickedId) < 1.0);

        if (!hasFeature) {
            return vec4<f32>(0.15, 0.35, 0.6, 1.0);  // Ocean blue
        } else if (isSelected) {
            // Changed order to prioritize selection
            return vec4<f32>(1.0, 1.0, 0.0, 1.0);  // Yellow highlight
        } else if (isDifferent) {
            return vec4<f32>(0.0, 0.0, 0.0, 1.0);  // Black borders
        } else {
            return centerColor;  // Original color
        }
    }
`;

export const debugVertexShaderCode = `
    @vertex fn main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
        var pos = array<vec2<f32>, 6>(
            vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
            vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0)
        );
        return vec4<f32>(pos[idx], 0.0, 1.0);
    }
`;

export const debugFragmentShaderCode = `
    @group(0) @binding(0) var tex: texture_2d<f32>;
    @fragment fn main(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
        let coord = vec2<i32>(pos.xy);
        let value = textureLoad(tex, coord, 0);
        // Amplify the red channel to make IDs visible
        return vec4<f32>(value.r * 10.0, 0.0, 0.0, 1.0);
    }
`;