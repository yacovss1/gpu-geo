// Grass Effect - Wind sway shader
// Applies directional wind displacement for vegetation

/**
 * Grass Effect - Wind sway vertex shader
 * Applies directional wind displacement for vegetation
 * Includes terrain projection to stay aligned with terrain surface
 */
export const grassVertexShaderCode = `
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
@group(0) @binding(1) var<uniform> time: f32;

// Terrain data in bind group 1
@group(1) @binding(0) var terrainTexture: texture_2d<f32>;
@group(1) @binding(1) var terrainSampler: sampler;
@group(1) @binding(2) var<uniform> terrainBounds: TerrainBounds;

fn sampleTerrainHeight(clipX: f32, clipY: f32) -> f32 {
    if (terrainBounds.enabled < 0.5) {
        return 0.0;
    }
    
    let margin = 0.001;
    if (clipX < terrainBounds.minX - margin || clipX > terrainBounds.maxX + margin ||
        clipY < terrainBounds.minY - margin || clipY > terrainBounds.maxY + margin) {
        return 0.0;
    }
    
    let u = clamp((clipX - terrainBounds.minX) / (terrainBounds.maxX - terrainBounds.minX), 0.001, 0.999);
    let v = clamp(1.0 - (clipY - terrainBounds.minY) / (terrainBounds.maxY - terrainBounds.minY), 0.001, 0.999);
    
    let pixel = textureSampleLevel(terrainTexture, terrainSampler, vec2<f32>(u, v), 0.0);
    
    let r = pixel.r * 255.0;
    let g = pixel.g * 255.0;
    let b = pixel.b * 255.0;
    let rawHeight = (r * 256.0 + g + b / 256.0) - 32768.0;
    let height = clamp(rawHeight, 0.0, 9000.0);
    
    return (height / 50000000.0) * terrainBounds.exaggeration;
}

@vertex
fn main(@location(0) inPosition: vec3<f32>, @location(1) inNormal: vec3<f32>, @location(2) inColor: vec4<f32>) -> VertexOutput {
    var output: VertexOutput;
    
    // Wind parameters
    let windSpeed = 1.2;
    let windStrength = 0.001;
    let windFrequency = 20.0;
    
    // Create directional wind (primarily horizontal)
    let windX = sin(inPosition.x * windFrequency + time * windSpeed) * windStrength;
    let windY = cos(inPosition.x * windFrequency * 0.5 + time * windSpeed * 0.8) * windStrength * 0.3;
    
    // Only sample terrain if Z is not already baked in (Z == 0)
    // This matches the logic in main shaders to avoid double-sampling
    var finalZ = inPosition.z;
    if (abs(inPosition.z) < 0.0000001) {
        finalZ = sampleTerrainHeight(inPosition.x, inPosition.y);
    }
    
    // Apply wind displacement and terrain projection
    let pos = vec4<f32>(
        inPosition.x + windX, 
        inPosition.y + windY, 
        finalZ, 
        1.0
    );
    
    // Apply camera transform
    output.position = uniforms * pos;
    
    output.fragCoord = output.position.xy;
    output.color = inColor;
    output.worldZ = finalZ;
    
    return output;
}
`;

/**
 * Standard fragment shader (reused for most effects)
 * Just passes through the color with optional shading
 */
export const standardFragmentShaderCode = `
@fragment
fn main(@location(0) fragCoord: vec2<f32>, 
        @location(1) color: vec4<f32>, 
        @location(2) worldZ: f32) -> @location(0) vec4<f32> {
    return color;
}
`;
