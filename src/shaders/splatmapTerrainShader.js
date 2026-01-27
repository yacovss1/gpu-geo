/**
 * Splatmap Terrain Shader
 * 
 * Renders terrain mesh with colors from a splatmap texture.
 * The splatmap contains pre-composited colors from rasterized vector polygons.
 * 
 * Vertex input: position(3) + normal(3) + baseColor(4) = 10 floats
 * The baseColor is used as fallback when splatmap is transparent.
 */

export const splatmapTerrainVertexShader = `
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,           // UV for splatmap lookup
    @location(1) baseColor: vec4<f32>,    // Fallback color (from style background)
    @location(2) normal: vec3<f32>,       // For lighting
    @location(3) worldZ: f32,             // Height for shadows
    @location(4) shadowCoord: vec3<f32>,  // Shadow map lookup
    @location(5) clipPos: vec2<f32>,      // For terrain normal sampling
};

struct TerrainBounds {
    minX: f32,
    minY: f32,
    maxX: f32,
    maxY: f32,
};

@group(0) @binding(0) var<uniform> cameraMatrix: mat4x4<f32>;
@group(1) @binding(3) var<uniform> terrainBounds: TerrainBounds;

// Shadow map
@group(2) @binding(0) var<uniform> lightSpaceMatrix: mat4x4<f32>;

@vertex
fn main(
    @location(0) inPosition: vec3<f32>,
    @location(1) inNormal: vec3<f32>,
    @location(2) inColor: vec4<f32>
) -> VertexOutput {
    var output: VertexOutput;
    
    // Calculate UV from clip position (assumes terrain covers tile bounds)
    let u = (inPosition.x - terrainBounds.minX) / (terrainBounds.maxX - terrainBounds.minX);
    let v = (inPosition.y - terrainBounds.minY) / (terrainBounds.maxY - terrainBounds.minY);
    output.uv = vec2<f32>(clamp(u, 0.0, 1.0), clamp(v, 0.0, 1.0));
    
    // Pass through data
    output.baseColor = inColor;
    output.normal = inNormal;
    output.worldZ = inPosition.z;
    output.clipPos = inPosition.xy;
    
    // Transform to clip space
    let worldPos = vec4<f32>(inPosition.x, inPosition.y, inPosition.z, 1.0);
    output.position = cameraMatrix * worldPos;
    
    // Calculate shadow coordinates
    let lightPos = lightSpaceMatrix * worldPos;
    output.shadowCoord = vec3<f32>(
        lightPos.x * 0.5 + 0.5,
        lightPos.y * 0.5 + 0.5,
        lightPos.z
    );
    
    return output;
}
`;

export const splatmapTerrainFragmentShader = `
struct TerrainAndLighting {
    // Terrain bounds (8 floats)
    minX: f32,
    minY: f32,
    maxX: f32,
    maxY: f32,
    exaggeration: f32,
    enabled: f32,
    tilesX: f32,
    tilesY: f32,
    // Lighting data (8 floats)
    sunDirX: f32,
    sunDirY: f32,
    sunDirZ: f32,
    intensity: f32,
    ambientR: f32,
    ambientG: f32,
    ambientB: f32,
    isNight: f32
};

// Main camera (already applied in vertex shader)
@group(0) @binding(0) var<uniform> cameraMatrix: mat4x4<f32>;

// Terrain and lighting
@group(1) @binding(0) var terrainTexture: texture_2d<f32>;
@group(1) @binding(1) var terrainSampler: sampler;
@group(1) @binding(2) var<uniform> terrainData: TerrainAndLighting;

// Splatmap textures
@group(1) @binding(4) var splatmapColor: texture_2d<f32>;
@group(1) @binding(5) var splatmapSampler: sampler;
@group(1) @binding(6) var splatmapFeatureId: texture_2d<u32>;

// Shadow map
@group(2) @binding(0) var<uniform> lightSpaceMatrix: mat4x4<f32>;
@group(2) @binding(1) var shadowMap: texture_depth_2d;
@group(2) @binding(2) var shadowSampler: sampler_comparison;

fn decodeTerrainHeight(pixel: vec4<f32>) -> f32 {
    // Check for invalid/transparent pixels (common at ocean edges)
    if (pixel.a < 0.01) {
        return 0.0;
    }
    
    // Check for NoData sentinel values (often white, black, or specific colors)
    if ((pixel.r > 0.99 && pixel.g > 0.99 && pixel.b > 0.99) ||
        (pixel.r < 0.01 && pixel.g < 0.01 && pixel.b < 0.01)) {
        return 0.0;
    }
    
    let r = pixel.r * 255.0;
    let g = pixel.g * 255.0;
    let b = pixel.b * 255.0;
    let height = (r * 256.0 + g + b / 256.0) - 32768.0;
    
    // Below sea level or above max = treat as 0
    if (height < 0.0 || height > 9000.0) {
        return 0.0;
    }
    
    return height;
}

// Sample terrain normal from height texture
fn sampleTerrainNormal(uv: vec2<f32>) -> vec3<f32> {
    let texSize = vec2<f32>(textureDimensions(terrainTexture));
    let pixelSize = 2.0 / texSize;
    
    let hL = max(decodeTerrainHeight(textureSampleLevel(terrainTexture, terrainSampler, uv + vec2<f32>(-pixelSize.x, 0.0), 0.0)), 0.0);
    let hR = max(decodeTerrainHeight(textureSampleLevel(terrainTexture, terrainSampler, uv + vec2<f32>(pixelSize.x, 0.0), 0.0)), 0.0);
    let hD = max(decodeTerrainHeight(textureSampleLevel(terrainTexture, terrainSampler, uv + vec2<f32>(0.0, -pixelSize.y), 0.0)), 0.0);
    let hU = max(decodeTerrainHeight(textureSampleLevel(terrainTexture, terrainSampler, uv + vec2<f32>(0.0, pixelSize.y), 0.0)), 0.0);
    
    return normalize(vec3<f32>(hL - hR, hD - hU, 2.0));
}

// Calculate shadow factor
fn calculateShadow(shadowCoord: vec3<f32>) -> f32 {
    // Check if in shadow map bounds
    if (shadowCoord.x < 0.0 || shadowCoord.x > 1.0 ||
        shadowCoord.y < 0.0 || shadowCoord.y > 1.0) {
        return 1.0; // Outside shadow map = fully lit
    }
    
    // PCF shadow sampling
    let texelSize = 1.0 / vec2<f32>(textureDimensions(shadowMap));
    var shadow = 0.0;
    let bias = 0.002;
    
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let offset = vec2<f32>(f32(x), f32(y)) * texelSize;
            shadow += textureSampleCompare(
                shadowMap,
                shadowSampler,
                shadowCoord.xy + offset,
                shadowCoord.z - bias
            );
        }
    }
    
    return shadow / 9.0;
}

@fragment
fn main(
    @location(0) uv: vec2<f32>,
    @location(1) baseColor: vec4<f32>,
    @location(2) normal: vec3<f32>,
    @location(3) worldZ: f32,
    @location(4) shadowCoord: vec3<f32>,
    @location(5) clipPos: vec2<f32>
) -> @location(0) vec4<f32> {
    // Sample splatmap color
    let splatColor = textureSample(splatmapColor, splatmapSampler, uv);
    
    // Blend splatmap with base color based on splatmap alpha
    var color = mix(baseColor.rgb, splatColor.rgb, splatColor.a);
    
    // Sample terrain normal for lighting
    let terrainNormal = sampleTerrainNormal(uv);
    
    // Calculate lighting
    let sunDir = normalize(vec3<f32>(terrainData.sunDirX, terrainData.sunDirY, terrainData.sunDirZ));
    let ndotl = max(dot(terrainNormal, sunDir), 0.0);
    
    let ambient = vec3<f32>(terrainData.ambientR, terrainData.ambientG, terrainData.ambientB);
    let diffuse = ndotl * terrainData.intensity;
    
    // Apply shadow
    let shadow = calculateShadow(shadowCoord);
    let lighting = ambient + diffuse * shadow;
    
    // Apply lighting to color
    color = color * lighting;
    
    return vec4<f32>(color, 1.0);
}
`;

// Hidden pass fragment shader for picking
export const splatmapTerrainHiddenFragmentShader = `
@group(1) @binding(6) var splatmapFeatureId: texture_2d<u32>;

@fragment
fn main(
    @location(0) uv: vec2<f32>,
    @location(1) baseColor: vec4<f32>,
    @location(2) normal: vec3<f32>,
    @location(3) worldZ: f32,
    @location(4) shadowCoord: vec3<f32>,
    @location(5) clipPos: vec2<f32>
) -> @location(0) vec4<f32> {
    // Sample feature ID from splatmap
    let texCoord = vec2<i32>(uv * vec2<f32>(textureDimensions(splatmapFeatureId)));
    let idPixel = textureLoad(splatmapFeatureId, texCoord, 0);
    
    // Reconstruct feature ID from RG channels
    let featureId = idPixel.r | (idPixel.g << 8u);
    
    // Encode feature ID as color for picking
    let r = f32(featureId & 0xFFu) / 255.0;
    let g = f32((featureId >> 8u) & 0xFFu) / 255.0;
    
    return vec4<f32>(r, g, 0.0, 1.0);
}
`;

export const splatmapTerrainShaderCode = splatmapTerrainVertexShader + splatmapTerrainFragmentShader;
