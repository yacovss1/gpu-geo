// Fix the vertex shader to better handle high zoom values

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
    
    // Create homogeneous coordinate
    let pos = vec4<f32>(inPosition.x, inPosition.y, 0.0, 1.0);
    
    // FIXED: Use proper matrix multiplication instead of accessing individual elements
    // This ensures we're correctly applying the zoom scale
    output.position = uniforms * pos;
    
    // Pass along coordinates for fragment shader
    output.fragCoord = output.position.xy;
    output.color = inColor;
    
    return output;
}
`;

export const fragmentShaderCode = `
@fragment
fn main(@location(0) fragCoord: vec2<f32>, @location(1) color: vec4<f32>) -> @location(0) vec4<f32> {
    // Use color as-is from vertex shader
    return color;
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
    @group(0) @binding(5) var<uniform> zoomInfo: vec4<f32>; // [displayZoom, fetchZoom, effectStrength, extremeZoom]

    @fragment
    fn main(@location(0) texCoord: vec2<f32>) -> @location(0) vec4<f32> {
        let texelSize = 1.0 / canvasSize;
        
        // Get center color and ID
        let centerColor = textureSample(colorTexture, mysampler, texCoord);
        let id = textureSample(idTexture, mysampler, texCoord).r * 255.0;
        
        // FIXED: Use actual display zoom (same as used in the vertex shader)
        let displayZoom = zoomInfo.x;
        let effectStrength = zoomInfo.z;
        let extremeZoom = zoomInfo.w;
        
        // FIXED: Scale edge detection the same way as the features
        var edgeZoomFactor = 1.0;
        
        if (displayZoom > 5.0) {
            // Use a fixed minimum thickness instead of scaling
            edgeZoomFactor = min(1.0, 5.0 / displayZoom);
        }
        
        // Apply the scale factor to sampling
        let sampleOffset = texelSize * edgeZoomFactor;
        
        // Sample neighbors with adapted offset
        let leftId = textureSample(idTexture, mysampler, texCoord + vec2<f32>(-sampleOffset.x, 0.0)).r * 255.0;
        let rightId = textureSample(idTexture, mysampler, texCoord + vec2<f32>(sampleOffset.x, 0.0)).r * 255.0;
        let upId = textureSample(idTexture, mysampler, texCoord + vec2<f32>(0.0, -sampleOffset.y)).r * 255.0;
        let downId = textureSample(idTexture, mysampler, texCoord + vec2<f32>(0.0, sampleOffset.y)).r * 255.0;

        let hasFeature = id > 0.1;
        let isDifferent = hasFeature && (
            abs(id - leftId) > 0.1 || 
            abs(id - rightId) > 0.1 || 
            abs(id - upId) > 0.1 || 
            abs(id - downId) > 0.1
        );
        
        // More lenient comparison for selection
        let isSelected = hasFeature && (abs(id - pickedId) < 1.0);

        // CRITICAL FIX: Delay pattern changes until much higher zoom levels (20+)
        if (!hasFeature) {
            // Only start pattern changes at zoom 20+ instead of 12
            if (displayZoom > 20.0) {
                // FIXED: Use a normalized pattern scale factor
                // This ensures patterns don't scale too quickly with zoom
                let patternScale = displayZoom / 10.0;  // Much slower scaling
                let stripeWidth = 0.8;  // Wider stripes to reduce apparent scaling
                
                // Only show grid pattern at extreme zoom (28+)
                if (displayZoom > 28.0) {
                    let gridSize = stripeWidth / patternScale;
                    let vertPattern = fract(texCoord.y * patternScale / stripeWidth) < 0.5;
                    let horizPattern = fract(texCoord.x * patternScale / stripeWidth) < 0.5;
                    
                    var blue: f32;
                    if (vertPattern != horizPattern) { // XOR for grid
                        blue = 0.7;
                    } else {
                        blue = 0.5;
                    }
                    
                    return vec4<f32>(0.2, 0.3, blue, 1.0);
                } else {
                    // Simple stripe pattern that scales with zoom
                    let stripePattern = fract(texCoord.x * patternScale / stripeWidth) < 0.5;
                    
                    var blue: f32;
                    if (stripePattern) {
                        blue = 0.7;
                    } else {
                        blue = 0.6;
                    }
                    return vec4<f32>(0.15, 0.35, blue, 1.0);
                }
            }
            return vec4<f32>(0.15, 0.35, 0.6, 1.0);  // Ocean blue
        } else if (isSelected) {
            return vec4<f32>(1.0, 1.0, 0.0, 1.0);  // Yellow highlight
        } else if (isDifferent) {
            return vec4<f32>(0.0, 0.0, 0.0, 1.0);  // Black borders
        } else {
            // FIXED: Only add interior patterns at very high zoom
            if (displayZoom > 22.0) {
                // Much slower pattern scaling
                let patternScale = displayZoom / 12.0;
                let patternSize = 0.5;  // Larger pattern size to reduce apparent scaling
                
                let countryPatternX = fract(texCoord.x * patternScale / patternSize) < 0.5;
                let countryPatternY = fract(texCoord.y * patternScale / patternSize) < 0.5;
                
                if ((countryPatternX && !countryPatternY) || (!countryPatternX && countryPatternY)) {
                    return centerColor * 1.2; // Lighten
                } else {
                    return centerColor * 0.9; // Darken
                }
            }
            
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
