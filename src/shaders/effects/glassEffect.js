// Glass Effect - Reflective shader for tall buildings
// Mixes building color with sky reflection based on height

/**
 * Glass Effect - Fragment shader for reflective tall buildings
 * Mixes building color with sky reflection based on height
 */
export const glassFragmentShaderCode = `
@fragment
fn main(@location(0) fragCoord: vec2<f32>, 
        @location(1) color: vec4<f32>, 
        @location(2) worldZ: f32) -> @location(0) vec4<f32> {
    
    // Sky color for reflection (bright blue)
    let skyColor = vec3<f32>(0.5, 0.75, 1.0);
    
    // Apply glass effect based on height
    // worldZ represents building height in world units
    // Higher buildings get more reflection
    let reflectionAmount = clamp(worldZ * 0.3, 0.0, 0.6);
    
    // Mix building color with sky reflection
    let glassColor = mix(color.rgb, skyColor, reflectionAmount);
    
    // Slight transparency for glass effect
    return vec4<f32>(glassColor, color.a * 0.95);
}
`;
