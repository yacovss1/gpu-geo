// Effect Shaders for specialized rendering
// Water animation, glass reflections, grass wind effects, etc.

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
    let pos = vec4<f32>(inPosition.x, inPosition.y, 0.0, 1.0);
    output.position = uniforms * pos;
    
    // Set depth for flat features
    output.position.z = 0.95;
    
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
