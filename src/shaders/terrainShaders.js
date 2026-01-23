/**
 * Terrain layer shaders for rendering elevation data
 * 
 * Uses AWS Terrarium encoding: height = (R * 256 + G + B / 256) - 32768
 * Includes skirt support to hide seams between adjacent tiles
 */

export const terrainVertexShader = `
struct TileInfo {
    exaggeration: f32,      // height scale (4 bytes)
    _pad1: f32,             // padding (4 bytes)
    _pad2: f32,             // padding (4 bytes)
    _pad3: f32              // padding (4 bytes) - total 16 bytes
};

@group(0) @binding(0) var<uniform> cameraMatrix: mat4x4<f32>;
@group(0) @binding(1) var terrainTexture: texture_2d<f32>;
@group(0) @binding(2) var terrainSampler: sampler;
@group(0) @binding(3) var<uniform> tileInfo: TileInfo;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) height: f32,
    @location(2) normal: vec3<f32>,
    @location(3) skirtFlag: f32  // Pass to fragment to make skirts transparent
};

fn decodeHeight(pixel: vec4<f32>) -> f32 {
    // Terrarium encoding: height = (R * 256 + G + B / 256) - 32768
    let r = pixel.r * 255.0;
    let g = pixel.g * 255.0;
    let b = pixel.b * 255.0;
    return (r * 256.0 + g + b / 256.0) - 32768.0;
}

@vertex
fn vs_main(
    @location(0) clipPos: vec2<f32>, 
    @location(1) uv: vec2<f32>,
    @location(2) isSkirt: f32
) -> VertexOutput {
    var output: VertexOutput;
    output.uv = uv;
    output.skirtFlag = 0.0;
    
    // Sample terrain height from texture
    let texSize = vec2<f32>(textureDimensions(terrainTexture));
    let texCoord = vec2<i32>(uv * texSize);
    let pixel = textureLoad(terrainTexture, texCoord, 0);
    let rawHeight = decodeHeight(pixel);
    
    // Clamp height to 0 - don't render ocean trenches
    let height = max(rawHeight, 0.0);
    
    // Scale height - use smaller divisor for more subtle terrain
    // Push terrain slightly BELOW Z=0 so features render on top
    let scaledHeight = (height / 50000000.0) * tileInfo.exaggeration - 0.0001;
    
    output.height = scaledHeight;
    output.normal = vec3<f32>(0.0, 0.0, 1.0);
    
    // Create world position WITH height displacement for 3D terrain
    let worldPos = vec4<f32>(clipPos.x, clipPos.y, scaledHeight, 1.0);
    output.position = cameraMatrix * worldPos;
    
    return output;
}
`;

export const terrainFragmentShader = `
// terrainTexture and terrainSampler already declared in vertex shader

fn decodeHeightFrag(pixel: vec4<f32>) -> f32 {
    // Terrarium encoding: height = (R * 256 + G + B / 256) - 32768
    let r = pixel.r * 255.0;
    let g = pixel.g * 255.0;
    let b = pixel.b * 255.0;
    return (r * 256.0 + g + b / 256.0) - 32768.0;
}

@fragment
fn fs_main(
    @location(0) uv: vec2<f32>,
    @location(1) height: f32,
    @location(2) normal: vec3<f32>,
    @location(3) skirtFlag: f32
) -> @location(0) vec4<f32> {
    // Solid land color - light tan/beige like traditional topo maps
    let landColor = vec3<f32>(0.96, 0.94, 0.90);
    
    // Calculate normals for shading
    let texSize = vec2<f32>(textureDimensions(terrainTexture));
    let pixelSize = 1.0 / texSize;
    
    let hL = max(decodeHeightFrag(textureSampleLevel(terrainTexture, terrainSampler, uv + vec2<f32>(-pixelSize.x, 0.0), 0.0)), 0.0);
    let hR = max(decodeHeightFrag(textureSampleLevel(terrainTexture, terrainSampler, uv + vec2<f32>(pixelSize.x, 0.0), 0.0)), 0.0);
    let hD = max(decodeHeightFrag(textureSampleLevel(terrainTexture, terrainSampler, uv + vec2<f32>(0.0, -pixelSize.y), 0.0)), 0.0);
    let hU = max(decodeHeightFrag(textureSampleLevel(terrainTexture, terrainSampler, uv + vec2<f32>(0.0, pixelSize.y), 0.0)), 0.0);
    
    // Calculate smooth normal
    let smoothNormal = normalize(vec3<f32>(hL - hR, hD - hU, 2.0));
    
    // Light direction (from upper-left)
    let lightDir = normalize(vec3<f32>(0.5, 0.5, 1.0));
    let ndotl = max(dot(smoothNormal, lightDir), 0.0);
    
    // Simple lighting: ambient + diffuse
    let ambient = 0.6;
    let diffuse = 0.4;
    let lighting = ambient + diffuse * ndotl;
    
    // Apply lighting to land color
    let finalColor = landColor * lighting;
    
    return vec4<f32>(finalColor, 1.0);
}

// Overlay mode: output grayscale shading to blend on top of vector layers
// White (1.0) = fully lit, no change to underlying color
// Gray/Dark = shaded slopes, darkens underlying color
@fragment
fn fs_overlay(
    @location(0) uv: vec2<f32>,
    @location(1) height: f32,
    @location(2) normal: vec3<f32>,
    @location(3) skirtFlag: f32
) -> @location(0) vec4<f32> {
    // Calculate normals for hillshade
    let texSize = vec2<f32>(textureDimensions(terrainTexture));
    let pixelSize = 1.0 / texSize;
    
    let hL = max(decodeHeightFrag(textureSampleLevel(terrainTexture, terrainSampler, uv + vec2<f32>(-pixelSize.x, 0.0), 0.0)), 0.0);
    let hR = max(decodeHeightFrag(textureSampleLevel(terrainTexture, terrainSampler, uv + vec2<f32>(pixelSize.x, 0.0), 0.0)), 0.0);
    let hD = max(decodeHeightFrag(textureSampleLevel(terrainTexture, terrainSampler, uv + vec2<f32>(0.0, -pixelSize.y), 0.0)), 0.0);
    let hU = max(decodeHeightFrag(textureSampleLevel(terrainTexture, terrainSampler, uv + vec2<f32>(0.0, pixelSize.y), 0.0)), 0.0);
    
    // Calculate smooth normal from height gradients
    let smoothNormal = normalize(vec3<f32>(hL - hR, hD - hU, 2.0));
    
    // Light direction (from upper-left, same as classic hillshade)
    let lightDir = normalize(vec3<f32>(0.5, 0.5, 1.0));
    let ndotl = max(dot(smoothNormal, lightDir), 0.0);
    
    // Shading factor: 1.0 = fully lit, lower = darker
    // Use stronger contrast for visible hillshade effect
    let ambient = 0.4;
    let diffuse = 0.6;
    let shade = ambient + diffuse * ndotl;
    
    // Output as grayscale with alpha for blending
    // Darker shading = more visible overlay, lit areas = transparent
    // Invert: we want shadows to darken, so output dark color with alpha
    let darkness = 1.0 - shade;  // 0 = lit, 1 = fully shaded
    let overlayStrength = 0.5;   // How strong the hillshade effect is
    
    // Output black with alpha proportional to darkness
    // This darkens shaded slopes while leaving lit areas unchanged
    return vec4<f32>(0.0, 0.0, 0.0, darkness * overlayStrength);
}
`;

// Combined shader code for single module creation
export const terrainShaderCode = terrainVertexShader + terrainFragmentShader;
