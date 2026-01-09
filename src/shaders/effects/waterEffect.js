// Water Effect - Animated wave shader
// Applies wave animation to water surfaces

/**
 * Water Effect - Animated wave vertex shader
 * Applies sine wave displacement to create flowing water effect
 */
export const waterVertexShaderCode = `
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) fragCoord: vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) worldZ: f32,
    @location(3) worldPos: vec2<f32>
};

@group(0) @binding(0) var<uniform> uniforms: mat4x4<f32>;
@group(0) @binding(1) var<uniform> time: f32;

@vertex
fn main(@location(0) inPosition: vec3<f32>, @location(1) inColor: vec4<f32>) -> VertexOutput {
    var output: VertexOutput;
    
    // Store world position for fragment shader
    output.worldPos = inPosition.xy;
    
    // Apply camera transform WITHOUT any displacement
    // The geometry stays in place, only the visual appearance changes
    // Use inPosition.z for layer-based Z offset (for proper depth ordering)
    let pos = vec4<f32>(inPosition.x, inPosition.y, inPosition.z, 1.0);
    output.position = uniforms * pos;
    
    // Perspective matrix handles depth correctly via Z/W - don't override it
    
    output.fragCoord = output.position.xy;
    output.color = inColor;
    output.worldZ = inPosition.z;
    
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
