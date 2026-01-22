// Glass Effect - Reflective shader for tall buildings
// Mixes building color with sky reflection based on height and applies lighting

/**
 * Glass Effect - Fragment shader for reflective tall buildings
 * Mixes building color with sky reflection based on height
 * Now includes proper lighting based on surface normals and shadow mapping
 */
export const glassFragmentShaderCode = `
struct TerrainAndLighting {
    minX: f32, minY: f32, maxX: f32, maxY: f32,
    exaggeration: f32, enabled: f32, _pad1: f32, _pad2: f32,
    sunDirX: f32, sunDirY: f32, sunDirZ: f32, intensity: f32,
    ambientR: f32, ambientG: f32, ambientB: f32, isNight: f32
};

@group(1) @binding(2) var<uniform> terrainData: TerrainAndLighting;

// Shadow map bindings (group 2)
@group(2) @binding(1) var shadowMap: texture_depth_2d;
@group(2) @binding(2) var shadowSampler: sampler_comparison;

@fragment
fn main(@location(0) fragCoord: vec2<f32>, 
        @location(1) color: vec4<f32>, 
        @location(2) worldZ: f32,
        @location(3) normal: vec3<f32>,
        @location(4) shadowCoord: vec3<f32>) -> @location(0) vec4<f32> {
    
    // Normalize the interpolated normal
    let n = normalize(normal);
    
    // Calculate lighting based on surface normal
    let sunDir = normalize(vec3<f32>(terrainData.sunDirX, terrainData.sunDirY, terrainData.sunDirZ));
    let ambient = vec3<f32>(terrainData.ambientR, terrainData.ambientG, terrainData.ambientB);
    
    // Diffuse lighting: how much surface faces the sun
    let ndotl = max(dot(n, sunDir), 0.0);
    
    // Shadow calculation
    // Clamp shadow coords to valid range and sample shadow map
    let shadowUV = clamp(shadowCoord.xy, vec2<f32>(0.001), vec2<f32>(0.999));
    let shadowDepth = shadowCoord.z - 0.005;  // Bias to prevent shadow acne
    let shadowSample = textureSampleCompare(shadowMap, shadowSampler, shadowUV, shadowDepth);
    
    // Check if within shadow map bounds
    let inBounds = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && 
                   shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0 &&
                   shadowCoord.z >= 0.0 && shadowCoord.z <= 1.0;
    let shadow = select(1.0, shadowSample, inBounds);
    
    // Sky color for reflection (bright blue)
    let skyColor = vec3<f32>(0.5, 0.75, 1.0);
    
    // Apply glass effect based on height
    // Higher buildings get more reflection
    let reflectionAmount = clamp(worldZ * 0.3, 0.0, 0.6);
    
    // Mix building color with sky reflection
    let glassColor = mix(color.rgb, skyColor, reflectionAmount);
    
    // Apply lighting with shadows
    var litColor: vec3<f32>;
    if (terrainData.isNight > 0.5) {
        // Night: use ambient as base, reduce saturation
        let gray = dot(glassColor, vec3<f32>(0.299, 0.587, 0.114));
        let desaturated = mix(glassColor, vec3<f32>(gray), 0.5);
        litColor = desaturated * (ambient + ndotl * 0.1);
    } else {
        // Day: ambient + diffuse lighting modulated by shadow
        let diffuse = ndotl * (1.0 - ambient) * terrainData.intensity * shadow;
        litColor = glassColor * (ambient + diffuse);
    }
    
    // Slight transparency for glass effect
    return vec4<f32>(litColor, color.a * 0.95);
}
`;
