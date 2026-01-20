/**
 * Terrain layer shaders for rendering elevation data
 * 
 * Uses AWS Terrarium encoding: height = (R * 256 + G + B / 256) - 32768
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
    @location(2) normal: vec3<f32>
};

fn decodeHeight(pixel: vec4<f32>) -> f32 {
    // Terrarium encoding: height = (R * 256 + G + B / 256) - 32768
    let r = pixel.r * 255.0;
    let g = pixel.g * 255.0;
    let b = pixel.b * 255.0;
    return (r * 256.0 + g + b / 256.0) - 32768.0;
}

@vertex
fn vs_main(@location(0) clipPos: vec2<f32>, @location(1) uv: vec2<f32>) -> VertexOutput {
    var output: VertexOutput;
    output.uv = uv;
    
    // clipPos is already in clip-space (pre-transformed using Mercator projection)
    // This matches EXACTLY how vector tiles transform their coordinates
    
    // Sample terrain height from texture
    let texSize = vec2<f32>(textureDimensions(terrainTexture));
    let texCoord = vec2<i32>(uv * texSize);
    let pixel = textureLoad(terrainTexture, texCoord, 0);
    let rawHeight = decodeHeight(pixel);
    
    // Clamp height to 0 - don't render ocean trenches, only land elevation
    let height = max(rawHeight, 0.0);
    
    // Scale height to clip space and apply exaggeration
    // Height is in meters (0 to ~8848m for Everest)
    // Use VERY small divisor - terrain should be subtle relief, not taller than buildings
    // 50,000,000 makes even 1000m hills barely visible bumps
    let scaledHeight = (height / 50000000.0) * tileInfo.exaggeration;
    output.height = scaledHeight;
    
    // Calculate normal from neighboring heights (clamp to 0 like main height)
    // At tile edges (UV near 0 or 1), use flat normal to avoid seams
    let edgeMargin = 2.0 / texSize.x; // 2 pixels from edge
    let isEdge = uv.x < edgeMargin || uv.x > (1.0 - edgeMargin) || 
                 uv.y < edgeMargin || uv.y > (1.0 - edgeMargin);
    
    if (isEdge) {
        output.normal = vec3<f32>(0.0, 0.0, 1.0); // Flat normal at edges
    } else {
        let hL = max(decodeHeight(textureLoad(terrainTexture, texCoord + vec2<i32>(-1, 0), 0)), 0.0);
        let hR = max(decodeHeight(textureLoad(terrainTexture, texCoord + vec2<i32>(1, 0), 0)), 0.0);
        let hD = max(decodeHeight(textureLoad(terrainTexture, texCoord + vec2<i32>(0, -1), 0)), 0.0);
        let hU = max(decodeHeight(textureLoad(terrainTexture, texCoord + vec2<i32>(0, 1), 0)), 0.0);
        output.normal = normalize(vec3<f32>(hL - hR, hD - hU, 2.0));
    }
    
    // Create world position WITH height displacement for 3D terrain
    // Use very small negative Z to be behind vector tiles at Z=0
    let terrainZ = scaledHeight - 0.00001;
    let worldPos = vec4<f32>(clipPos.x, clipPos.y, terrainZ, 1.0);
    output.position = cameraMatrix * worldPos;
    
    return output;
}
`;

export const terrainFragmentShader = `
@fragment
fn fs_main(
    @location(0) uv: vec2<f32>,
    @location(1) height: f32,
    @location(2) normal: vec3<f32>
) -> @location(0) vec4<f32> {
    // Elevation-based coloring
    var color: vec3<f32>;
    
    let h = height * 10.0; // Scale for color mapping
    
    if (h < 0.0) {
        // Water - blue
        color = vec3<f32>(0.2, 0.4, 0.7);
    } else if (h < 0.05) {
        // Lowlands - green
        color = vec3<f32>(0.3, 0.5, 0.2);
    } else if (h < 0.15) {
        // Hills - yellow-green
        let t = (h - 0.05) / 0.1;
        color = mix(vec3<f32>(0.3, 0.5, 0.2), vec3<f32>(0.5, 0.5, 0.3), t);
    } else if (h < 0.35) {
        // Mountains - brown
        let t = (h - 0.15) / 0.2;
        color = mix(vec3<f32>(0.5, 0.5, 0.3), vec3<f32>(0.5, 0.4, 0.3), t);
    } else {
        // High mountains/snow
        let t = min((h - 0.35) / 0.15, 1.0);
        color = mix(vec3<f32>(0.5, 0.4, 0.3), vec3<f32>(0.9, 0.9, 0.95), t);
    }
    
    // Simple lighting
    let lightDir = normalize(vec3<f32>(0.5, 0.5, 1.0));
    let diffuse = max(dot(normal, lightDir), 0.0);
    let ambient = 0.4;
    let lighting = ambient + diffuse * 0.6;
    
    return vec4<f32>(color * lighting, 1.0);
}
`;

// Combined shader code for single module creation
export const terrainShaderCode = terrainVertexShader + terrainFragmentShader;
