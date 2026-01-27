// Water Effect - Animated wave shader
// Applies wave animation to water surfaces

/**
 * Water Effect - Animated wave vertex shader
 * Applies sine wave displacement to create flowing water effect
 * Includes terrain projection to stay aligned with other features
 */
export const waterVertexShaderCode = `
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) fragCoord: vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) worldZ: f32,
    @location(3) worldPos: vec2<f32>
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
// Splatmap bindings (must match main shader layout)
@group(1) @binding(3) var splatmapTexture_w: texture_2d<f32>;
@group(1) @binding(4) var splatmapSampler_w: sampler;

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
    
    // Store world position for fragment shader
    output.worldPos = inPosition.xy;
    
    // Only sample terrain if Z is not already baked in (Z == 0)
    // This matches the logic in main shaders to avoid double-sampling
    var finalZ = inPosition.z;
    if (abs(inPosition.z) < 0.0000001) {
        finalZ = sampleTerrainHeight(inPosition.x, inPosition.y);
    }
    
    // Apply camera transform with terrain projection
    let pos = vec4<f32>(inPosition.x, inPosition.y, finalZ, 1.0);
    output.position = uniforms * pos;
    
    output.fragCoord = output.position.xy;
    output.color = inColor;
    output.worldZ = finalZ;
    
    return output;
}
`;

/**
 * Water Fragment Shader - Animates color/brightness instead of position
 */
export const waterFragmentShaderCode = `
@group(0) @binding(1) var<uniform> time: f32;

@fragment
fn main(@location(0) fragCoord: vec2<f32>, 
        @location(1) color: vec4<f32>, 
        @location(2) worldZ: f32,
        @location(3) worldPos: vec2<f32>) -> @location(0) vec4<f32> {
    
    // Wave animation parameters
    let waveSpeed = 0.5;
    
    // Use screen-space coordinates for wave frequency
    // This makes waves appear at the same visual scale regardless of zoom
    let screenFrequency = 30.0; // Frequency in screen space
    
    // Calculate wave pattern based on screen position (fragCoord)
    let wave1 = sin(fragCoord.x * screenFrequency + time * waveSpeed);
    let wave2 = cos(fragCoord.y * screenFrequency * 0.8 + time * waveSpeed * 0.7);
    let combinedWave = (wave1 + wave2) * 0.5;
    
    // Modulate brightness instead of position (0.9 to 1.1 range)
    let brightness = 1.0 + combinedWave * 0.1;
    
    // Apply brightness modulation to water color
    let animatedColor = vec3<f32>(
        color.r * brightness,
        color.g * brightness,
        color.b * brightness
    );
    
    return vec4<f32>(animatedColor, color.a);
}
`;
