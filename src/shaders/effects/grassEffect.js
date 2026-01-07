// Grass Effect - Wind sway shader
// Applies directional wind displacement for vegetation

/**
 * Grass Effect - Wind sway vertex shader
 * Applies directional wind displacement for vegetation
 */
export const grassVertexShaderCode = `
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) fragCoord: vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) worldZ: f32
};

@group(0) @binding(0) var<uniform> uniforms: mat4x4<f32>;
@group(0) @binding(1) var<uniform> time: f32;

@vertex
fn main(@location(0) inPosition: vec3<f32>, @location(1) inColor: vec4<f32>) -> VertexOutput {
    var output: VertexOutput;
    
    // Wind parameters
    let windSpeed = 1.2;
    let windStrength = 0.001;
    let windFrequency = 20.0;
    
    // Create directional wind (primarily horizontal)
    let windX = sin(inPosition.x * windFrequency + time * windSpeed) * windStrength;
    let windY = cos(inPosition.x * windFrequency * 0.5 + time * windSpeed * 0.8) * windStrength * 0.3;
    
    // Apply wind displacement
    let pos = vec4<f32>(
        inPosition.x + windX, 
        inPosition.y + windY, 
        0.0, 
        1.0
    );
    
    // Apply camera transform
    output.position = uniforms * pos;
    output.position.z = 0.95;
    
    output.fragCoord = output.position.xy;
    output.color = inColor;
    output.worldZ = inPosition.z;
    
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
