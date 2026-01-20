// Vector layer shaders with GPU terrain projection

export const vertexShaderCode = `
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) fragCoord: vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) worldZ: f32
};

struct TerrainBounds {
    minX: f32,
    minY: f32,
    maxX: f32,
    maxY: f32,
    exaggeration: f32,
    enabled: f32,
    _pad1: f32,
    _pad2: f32
};

@group(0) @binding(0) var<uniform> uniforms: mat4x4<f32>;

// Terrain data in bind group 1 (optional - for GPU terrain projection)
@group(1) @binding(0) var terrainTexture: texture_2d<f32>;
@group(1) @binding(1) var terrainSampler: sampler;
@group(1) @binding(2) var<uniform> terrainBounds: TerrainBounds;

fn sampleTerrainHeight(clipX: f32, clipY: f32) -> f32 {
    if (terrainBounds.enabled < 0.5) {
        return 0.0;
    }
    
    // Check if position is within terrain bounds (with small margin)
    let margin = 0.001;
    if (clipX < terrainBounds.minX - margin || clipX > terrainBounds.maxX + margin ||
        clipY < terrainBounds.minY - margin || clipY > terrainBounds.maxY + margin) {
        return 0.0;
    }
    
    // Convert clip coords to UV (0-1) and clamp to valid range
    let u = clamp((clipX - terrainBounds.minX) / (terrainBounds.maxX - terrainBounds.minX), 0.001, 0.999);
    let v = clamp(1.0 - (clipY - terrainBounds.minY) / (terrainBounds.maxY - terrainBounds.minY), 0.001, 0.999);
    
    // Sample terrain texture
    let pixel = textureSampleLevel(terrainTexture, terrainSampler, vec2<f32>(u, v), 0.0);
    
    // Decode Terrarium height: height = (R * 256 + G + B / 256) - 32768
    let r = pixel.r * 255.0;
    let g = pixel.g * 255.0;
    let b = pixel.b * 255.0;
    let rawHeight = (r * 256.0 + g + b / 256.0) - 32768.0;
    
    // Clamp height to reasonable range (0 to 9000m - slightly above Everest)
    let height = clamp(rawHeight, 0.0, 9000.0);
    
    // Scale height to clip space
    return (height / 50000000.0) * terrainBounds.exaggeration;
}

@vertex
fn main(@location(0) inPosition: vec3<f32>, @location(1) inColor: vec4<f32>) -> VertexOutput {
    var output: VertexOutput;
    
    // Sample terrain height at this vertex position
    let terrainHeight = sampleTerrainHeight(inPosition.x, inPosition.y);
    
    // Add terrain height to vertex Z
    let pos = vec4<f32>(inPosition.x, inPosition.y, inPosition.z + terrainHeight, 1.0);

    // Apply camera transform
    output.position = uniforms * pos;

    output.fragCoord = output.position.xy;
    output.color = inColor;
    output.worldZ = inPosition.z + terrainHeight;
    
    return output;
}
`;

export const fragmentShaderCode = `
@fragment
fn main(@location(0) fragCoord: vec2<f32>, @location(1) color: vec4<f32>, @location(2) worldZ: f32) -> @location(0) vec4<f32> {
    // Just use the color as-is - walls are already darkened in the geometry
    return color;
}
`;

export const hiddenFragmentShaderCode = `
@fragment
fn main(@location(0) fragCoord: vec2<f32>, @location(1) color: vec4<f32>, @location(2) worldZ: f32) -> @location(0) vec4<f32> {
    // color.r = Feature ID high byte
    // color.g = Feature ID low byte
    // color.b = Layer ID
    // color.a = Pickable flag
    return color;
}
`;

// Hidden buffer vertex shader - MUST apply SAME transforms as visible rendering
// This ensures the 2D screen position matches exactly between visible and hidden
export const hiddenVertexShaderCode = `
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) fragCoord: vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) worldZ: f32
};

struct TerrainBounds {
    minX: f32,
    minY: f32,
    maxX: f32,
    maxY: f32,
    exaggeration: f32,
    enabled: f32,
    _pad1: f32,
    _pad2: f32
};

@group(0) @binding(0) var<uniform> uniforms: mat4x4<f32>;

// Terrain data in bind group 1 (optional - for GPU terrain projection)
@group(1) @binding(0) var terrainTexture: texture_2d<f32>;
@group(1) @binding(1) var terrainSampler: sampler;
@group(1) @binding(2) var<uniform> terrainBounds: TerrainBounds;

fn sampleTerrainHeight(clipX: f32, clipY: f32) -> f32 {
    if (terrainBounds.enabled < 0.5) {
        return 0.0;
    }
    
    // Check if position is within terrain bounds (with small margin)
    let margin = 0.001;
    if (clipX < terrainBounds.minX - margin || clipX > terrainBounds.maxX + margin ||
        clipY < terrainBounds.minY - margin || clipY > terrainBounds.maxY + margin) {
        return 0.0;
    }
    
    // Convert clip coords to UV (0-1) and clamp to valid range
    let u = clamp((clipX - terrainBounds.minX) / (terrainBounds.maxX - terrainBounds.minX), 0.001, 0.999);
    let v = clamp(1.0 - (clipY - terrainBounds.minY) / (terrainBounds.maxY - terrainBounds.minY), 0.001, 0.999);
    
    let pixel = textureSampleLevel(terrainTexture, terrainSampler, vec2<f32>(u, v), 0.0);
    
    let r = pixel.r * 255.0;
    let g = pixel.g * 255.0;
    let b = pixel.b * 255.0;
    let rawHeight = (r * 256.0 + g + b / 256.0) - 32768.0;
    
    // Clamp height to reasonable range (0 to 9000m - slightly above Everest)
    let height = clamp(rawHeight, 0.0, 9000.0);
    
    return (height / 50000000.0) * terrainBounds.exaggeration;
}

@vertex
fn main(@location(0) inPosition: vec3<f32>, @location(1) inColor: vec4<f32>) -> VertexOutput {
    var output: VertexOutput;
    
    let terrainHeight = sampleTerrainHeight(inPosition.x, inPosition.y);
    let pos = vec4<f32>(inPosition.x, inPosition.y, inPosition.z + terrainHeight, 1.0);

    output.position = uniforms * pos;
    output.fragCoord = output.position.xy;
    output.color = inColor;
    output.worldZ = inPosition.z + terrainHeight;
    
    return output;
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
    @group(0) @binding(6) var<uniform> pickedLayerId: f32;
    @group(0) @binding(7) var idSampler: sampler;  // Nearest-neighbor sampler for ID texture

    @fragment
    fn main(@location(0) texCoord: vec2<f32>) -> @location(0) vec4<f32> {
        let texelSize = 1.0 / canvasSize;
        
        // Get center color (use linear filtering for smooth appearance)
        let centerColor = textureSample(colorTexture, mysampler, texCoord);
        
        // Get center ID pixel (use NEAREST filtering - no interpolation for exact IDs)
        let centerPixel = textureSample(idTexture, idSampler, texCoord);
        let id = centerPixel.r * 255.0 * 256.0 + centerPixel.g * 255.0;
        
        // FIXED: Use actual display zoom (same as used in the vertex shader)
        let displayZoom = zoomInfo.x;
        let effectStrength = zoomInfo.z;
        let extremeZoom = zoomInfo.w;
        
        // Keep edge detection at 1-pixel width always
        let sampleOffset = texelSize;
        
        // Sample neighbors with NEAREST filtering (exact IDs, no interpolation)
        let leftPixel = textureSample(idTexture, idSampler, texCoord + vec2<f32>(-sampleOffset.x, 0.0));
        let leftId = leftPixel.r * 255.0 * 256.0 + leftPixel.g * 255.0;
        
        let rightPixel = textureSample(idTexture, idSampler, texCoord + vec2<f32>(sampleOffset.x, 0.0));
        let rightId = rightPixel.r * 255.0 * 256.0 + rightPixel.g * 255.0;
        
        let upPixel = textureSample(idTexture, idSampler, texCoord + vec2<f32>(0.0, -sampleOffset.y));
        let upId = upPixel.r * 255.0 * 256.0 + upPixel.g * 255.0;
        
        let downPixel = textureSample(idTexture, idSampler, texCoord + vec2<f32>(0.0, sampleOffset.y));
        let downId = downPixel.r * 255.0 * 256.0 + downPixel.g * 255.0;

        let hasFeature = id > 0.1;
        let isDifferent = hasFeature && (
            abs(id - leftId) > 0.1 || 
            abs(id - rightId) > 0.1 || 
            abs(id - upId) > 0.1 || 
            abs(id - downId) > 0.1
        );
        
        // Decode layer IDs from blue channel
        let layerId = centerPixel.b * 255.0;
        let pickedLayerIdValue = pickedLayerId;  // From uniform
        
        // Check if this pixel's feature matches the picked feature
        let featureMatch = hasFeature && 
                          (abs(id - pickedId) < 0.01) && 
                          (abs(layerId - pickedLayerIdValue) < 0.01);
        
        // Only highlight if the picked feature is actually visible at this pixel
        // If another feature (different ID or layer) is at this pixel, it's occluding the picked feature
        // So we should NOT highlight - just show the occluding feature's color
        let isSelected = featureMatch;

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
                    return centerColor;
                }
            }
            return centerColor;
        } else if (isSelected) {
            // Highlight selected feature with yellow tint
            return mix(centerColor, vec4<f32>(1.0, 1.0, 0.0, 1.0), 0.4);
        } else if (isDifferent) {
            return centerColor;  // OUTLINES DISABLED - just return color
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
