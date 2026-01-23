// Vector layer shaders with GPU terrain projection, global lighting, and shadows
// Vertex format: position(3) + normal(3) + color(4) = 10 floats = 40 bytes

export const vertexShaderCode = `
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) fragCoord: vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) worldZ: f32,
    @location(3) normal: vec3<f32>,
    @location(4) shadowCoord: vec3<f32>,  // Position in light space for shadow lookup
    @location(5) terrainNormal: vec3<f32> // Terrain surface normal for shading flat features
};

struct TerrainAndLighting {
    // Terrain bounds (8 floats)
    minX: f32,
    minY: f32,
    maxX: f32,
    maxY: f32,
    exaggeration: f32,
    enabled: f32,
    tilesX: f32,     // Number of tiles in X direction in atlas
    tilesY: f32,     // Number of tiles in Y direction in atlas
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

@group(0) @binding(0) var<uniform> uniforms: mat4x4<f32>;

// Terrain and lighting data in bind group 1
@group(1) @binding(0) var terrainTexture: texture_2d<f32>;
@group(1) @binding(1) var terrainSampler: sampler;
@group(1) @binding(2) var<uniform> terrainData: TerrainAndLighting;

// Shadow map data in bind group 2
@group(2) @binding(0) var<uniform> lightSpaceMatrix: mat4x4<f32>;

fn decodeTerrainHeight(pixel: vec4<f32>) -> f32 {
    let r = pixel.r * 255.0;
    let g = pixel.g * 255.0;
    let b = pixel.b * 255.0;
    return (r * 256.0 + g + b / 256.0) - 32768.0;
}

fn sampleTerrainHeight(clipX: f32, clipY: f32) -> f32 {
    if (terrainData.enabled < 0.5) {
        return 0.0;
    }
    
    // Check if position is within terrain bounds (with small margin)
    let margin = 0.001;
    if (clipX < terrainData.minX - margin || clipX > terrainData.maxX + margin ||
        clipY < terrainData.minY - margin || clipY > terrainData.maxY + margin) {
        return 0.0;
    }
    
    // Convert clip coords to UV (0-1) across the entire atlas
    let u = (clipX - terrainData.minX) / (terrainData.maxX - terrainData.minX);
    let v = 1.0 - (clipY - terrainData.minY) / (terrainData.maxY - terrainData.minY);
    
    // Clamp to valid UV range (let GPU bilinear filter handle edge interpolation)
    let clampedU = clamp(u, 0.001, 0.999);
    let clampedV = clamp(v, 0.001, 0.999);
    
    // Sample terrain texture directly - atlas is pre-stitched
    let pixel = textureSampleLevel(terrainTexture, terrainSampler, vec2<f32>(clampedU, clampedV), 0.0);
    
    // Decode Terrarium height
    let rawHeight = decodeTerrainHeight(pixel);
    
    // Clamp height to reasonable range (0 to 9000m - slightly above Everest)
    let height = clamp(rawHeight, 0.0, 9000.0);
    
    // Scale height to clip space - no edge fading
    return (height / 50000000.0) * terrainData.exaggeration;
}

// Sample terrain normal at a clip-space position
fn sampleTerrainNormal(clipX: f32, clipY: f32) -> vec3<f32> {
    if (terrainData.enabled < 0.5) {
        return vec3<f32>(0.0, 0.0, 1.0); // Flat normal
    }
    
    // Convert clip coords to UV (0-1) across the entire atlas
    let u = (clipX - terrainData.minX) / (terrainData.maxX - terrainData.minX);
    let v = 1.0 - (clipY - terrainData.minY) / (terrainData.maxY - terrainData.minY);
    
    // Clamp to valid UV range
    let clampedU = clamp(u, 0.002, 0.998);
    let clampedV = clamp(v, 0.002, 0.998);
    let uv = vec2<f32>(clampedU, clampedV);
    
    // Sample neighboring heights to compute normal
    // Use a larger offset for smoother normals
    let texSize = vec2<f32>(textureDimensions(terrainTexture));
    let pixelSize = 2.0 / texSize; // 2 pixels offset
    
    let hL = max(decodeTerrainHeight(textureSampleLevel(terrainTexture, terrainSampler, uv + vec2<f32>(-pixelSize.x, 0.0), 0.0)), 0.0);
    let hR = max(decodeTerrainHeight(textureSampleLevel(terrainTexture, terrainSampler, uv + vec2<f32>(pixelSize.x, 0.0), 0.0)), 0.0);
    let hD = max(decodeTerrainHeight(textureSampleLevel(terrainTexture, terrainSampler, uv + vec2<f32>(0.0, -pixelSize.y), 0.0)), 0.0);
    let hU = max(decodeTerrainHeight(textureSampleLevel(terrainTexture, terrainSampler, uv + vec2<f32>(0.0, pixelSize.y), 0.0)), 0.0);
    
    // Compute normal from height differences
    return normalize(vec3<f32>(hL - hR, hD - hU, 2.0));
}

// Calculate lighting factor for a surface
fn calculateLighting(normal: vec3<f32>) -> f32 {
    let sunDir = normalize(vec3<f32>(terrainData.sunDirX, terrainData.sunDirY, terrainData.sunDirZ));
    let ambient = (terrainData.ambientR + terrainData.ambientG + terrainData.ambientB) / 3.0;
    
    // Diffuse lighting (how much surface faces the sun)
    let ndotl = max(dot(normal, sunDir), 0.0);
    
    // Combine ambient + diffuse, scaled by intensity
    return (ambient + ndotl * (1.0 - ambient)) * terrainData.intensity;
}

@vertex
fn main(@location(0) inPosition: vec3<f32>, @location(1) inNormal: vec3<f32>, @location(2) inColor: vec4<f32>) -> VertexOutput {
    var output: VertexOutput;
    
    // Check if Z is already set (CPU-baked terrain from centerline)
    // If so, skip GPU terrain sampling to avoid Z-fighting
    // (Left/right road edges would sample different terrain heights)
    var terrainHeight = 0.0;
    if (abs(inPosition.z) < 0.0000001) {
        // Z is zero - sample terrain at vertex position (polygons, non-line geometry)
        terrainHeight = sampleTerrainHeight(inPosition.x, inPosition.y);
    }
    
    // Add terrain height to vertex Z (or use pre-baked Z)
    let pos = vec4<f32>(inPosition.x, inPosition.y, inPosition.z + terrainHeight, 1.0);

    // Apply camera transform
    output.position = uniforms * pos;

    output.fragCoord = output.position.xy;
    output.color = inColor;
    output.worldZ = inPosition.z + terrainHeight;
    
    // Pass normal to fragment shader for lighting calculation
    output.normal = inNormal;
    
    // Sample terrain normal for shading flat features (roads, polygons)
    // This gives terrain-based lighting without needing visible terrain mesh
    output.terrainNormal = sampleTerrainNormal(inPosition.x, inPosition.y);
    
    // Calculate shadow map coordinates (position in light space)
    let lightSpacePos = lightSpaceMatrix * pos;
    // Convert from clip space [-1,1] to texture coords [0,1]
    output.shadowCoord = vec3<f32>(
        lightSpacePos.x * 0.5 + 0.5,
        lightSpacePos.y * -0.5 + 0.5,  // Flip Y for texture coords
        lightSpacePos.z  // Depth in light space
    );
    
    return output;
}
`;

export const fragmentShaderCode = `
struct TerrainAndLighting {
    minX: f32, minY: f32, maxX: f32, maxY: f32,
    exaggeration: f32, enabled: f32, _pad1: f32, _pad2: f32,
    sunDirX: f32, sunDirY: f32, sunDirZ: f32, intensity: f32,
    ambientR: f32, ambientG: f32, ambientB: f32, isNight: f32
};

@group(1) @binding(2) var<uniform> terrainData: TerrainAndLighting;

// Shadow map in bind group 2
@group(2) @binding(1) var shadowMap: texture_depth_2d;
@group(2) @binding(2) var shadowSampler: sampler_comparison;

// Debug flag: set to true to visualize shadows
const DEBUG_SHADOWS: bool = false;

@fragment
fn main(@location(0) fragCoord: vec2<f32>, @location(1) color: vec4<f32>, @location(2) worldZ: f32, @location(3) normal: vec3<f32>, @location(4) shadowCoord: vec3<f32>, @location(5) terrainNormal: vec3<f32>) -> @location(0) vec4<f32> {
    // Force alpha to 1.0 to prevent visible seams at tile boundaries.
    // Vector tiles include overlapping geometry at tile edges (buffer zone).
    // With standard alpha blending, overlapping semi-transparent fills cause seams.
    // This is a known limitation - proper fix would require stencil-based rendering.
    var fixedColor = color;
    fixedColor.a = 1.0;
    
    // Normalize the interpolated normals
    let geomNormal = normalize(normal);
    let terrNormal = normalize(terrainNormal);
    
    // For flat features (normal pointing straight up), use terrain normal for shading
    // This gives roads and polygons proper terrain-based lighting
    var effectiveNormal = geomNormal;
    let isFlatFeature = abs(geomNormal.z) > 0.99; // Nearly vertical normal = flat/horizontal surface
    if (isFlatFeature) {
        // Use terrain normal for terrain-based shading on flat surfaces
        effectiveNormal = terrNormal;
    }
    
    // Calculate shadow factor (1.0 = lit, 0.0 = in shadow)
    var shadow = 1.0;
    if (terrainData.isNight < 0.5) {
        // Shadow bias to reduce shadow acne
        let bias = 0.005;
        let compareDepth = shadowCoord.z - bias;
        
        // Clamp shadow coords to valid range for sampling
        let clampedCoord = clamp(shadowCoord.xy, vec2<f32>(0.001), vec2<f32>(0.999));
        
        // Single shadow sample (no PCF for now to avoid uniform control flow issues)
        shadow = textureSampleCompare(shadowMap, shadowSampler, clampedCoord, compareDepth);
        
        // If outside shadow map bounds, no shadow
        if (shadowCoord.x < 0.0 || shadowCoord.x > 1.0 ||
            shadowCoord.y < 0.0 || shadowCoord.y > 1.0 ||
            shadowCoord.z < 0.0 || shadowCoord.z > 1.0) {
            shadow = 1.0;
        }
    }
    
    // Debug: visualize shadow map coverage
    if (DEBUG_SHADOWS) {
        return vec4<f32>(shadow, shadow, shadow, 1.0);
    }
    
    // Calculate lighting based on effective normal (terrain or geometry)
    let sunDir = normalize(vec3<f32>(terrainData.sunDirX, terrainData.sunDirY, terrainData.sunDirZ));
    let ambient = vec3<f32>(terrainData.ambientR, terrainData.ambientG, terrainData.ambientB);
    
    // Diffuse lighting: how much surface faces the sun
    let ndotl = max(dot(effectiveNormal, sunDir), 0.0);
    
    var litColor: vec3<f32>;
    if (terrainData.isNight > 0.5) {
        // Night: use ambient as base, reduce saturation, dim diffuse
        let gray = dot(fixedColor.rgb, vec3<f32>(0.299, 0.587, 0.114));
        let desaturated = mix(fixedColor.rgb, vec3<f32>(gray), 0.5);
        litColor = desaturated * (ambient + ndotl * 0.1);
    } else {
        // Day: ambient + diffuse lighting, modulated by shadow
        let diffuse = ndotl * (1.0 - ambient) * terrainData.intensity * shadow;
        litColor = fixedColor.rgb * (ambient + diffuse);
    }
    
    return vec4<f32>(litColor, 1.0);
}
`;

export const hiddenFragmentShaderCode = `
@fragment
fn main(@location(0) fragCoord: vec2<f32>, @location(1) color: vec4<f32>, @location(2) worldZ: f32, @location(3) normal: vec3<f32>) -> @location(0) vec4<f32> {
    // color.r = Feature ID high byte
    // color.g = Feature ID low byte
    // color.b = Layer ID
    // color.a = Pickable flag
    // (normal is ignored for picking - just pass through encoded ID)
    return color;
}
`;

// Hidden buffer vertex shader - MUST apply SAME transforms as visible rendering
// This ensures the 2D screen position matches exactly between visible and hidden
// Vertex format: position(3) + normal(3) + color(4) = 10 floats = 40 bytes
export const hiddenVertexShaderCode = `
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) fragCoord: vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) worldZ: f32,
    @location(3) normal: vec3<f32>
};

struct TerrainAndLighting {
    minX: f32, minY: f32, maxX: f32, maxY: f32,
    exaggeration: f32, enabled: f32, _pad1: f32, _pad2: f32,
    sunDirX: f32, sunDirY: f32, sunDirZ: f32, intensity: f32,
    ambientR: f32, ambientG: f32, ambientB: f32, isNight: f32
};

@group(0) @binding(0) var<uniform> uniforms: mat4x4<f32>;

// Terrain data in bind group 1
@group(1) @binding(0) var terrainTexture: texture_2d<f32>;
@group(1) @binding(1) var terrainSampler: sampler;
@group(1) @binding(2) var<uniform> terrainData: TerrainAndLighting;

fn sampleTerrainHeight(clipX: f32, clipY: f32) -> f32 {
    if (terrainData.enabled < 0.5) {
        return 0.0;
    }
    
    let margin = 0.001;
    if (clipX < terrainData.minX - margin || clipX > terrainData.maxX + margin ||
        clipY < terrainData.minY - margin || clipY > terrainData.maxY + margin) {
        return 0.0;
    }
    
    let u = clamp((clipX - terrainData.minX) / (terrainData.maxX - terrainData.minX), 0.001, 0.999);
    let v = clamp(1.0 - (clipY - terrainData.minY) / (terrainData.maxY - terrainData.minY), 0.001, 0.999);
    
    let pixel = textureSampleLevel(terrainTexture, terrainSampler, vec2<f32>(u, v), 0.0);
    
    let r = pixel.r * 255.0;
    let g = pixel.g * 255.0;
    let b = pixel.b * 255.0;
    let rawHeight = (r * 256.0 + g + b / 256.0) - 32768.0;
    let height = clamp(rawHeight, 0.0, 9000.0);
    
    return (height / 50000000.0) * terrainData.exaggeration;
}

@vertex
fn main(@location(0) inPosition: vec3<f32>, @location(1) inNormal: vec3<f32>, @location(2) inColor: vec4<f32>) -> VertexOutput {
    var output: VertexOutput;
    
    var terrainHeight = 0.0;
    if (abs(inPosition.z) < 0.0000001) {
        terrainHeight = sampleTerrainHeight(inPosition.x, inPosition.y);
    }
    
    let pos = vec4<f32>(inPosition.x, inPosition.y, inPosition.z + terrainHeight, 1.0);

    output.position = uniforms * pos;
    output.fragCoord = output.position.xy;
    output.color = inColor;
    output.worldZ = inPosition.z + terrainHeight;
    output.normal = inNormal; // Pass through (not used for picking)
    
    return output;
}
`;

export const edgeDetectionVertexShaderCode = `
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>
};

@vertex
fn main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    let vertices = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0),  // Triangle 1
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0),
        vec2<f32>(-1.0, 3.0),   // Triangle 2
        vec2<f32>(3.0, -1.0),
        vec2<f32>(3.0, 3.0)
    );
    
    var output: VertexOutput;
    output.position = vec4<f32>(vertices[vertexIndex], 0.0, 1.0);
    output.texCoord = vertices[vertexIndex] * 0.5 + 0.5;
    return output;
}`;

export const edgeDetectionFragmentShaderCode = `
    @group(0) @binding(0) var colorTexture: texture_2d<f32>;
    @group(0) @binding(1) var idTexture: texture_2d<f32>;
    @group(0) @binding(2) var mysampler: sampler;
    @group(0) @binding(3) var<uniform> canvasSize: vec2<f32>;
    @group(0) @binding(4) var<uniform> pickedId: f32;
    @group(0) @binding(5) var<uniform> zoomInfo: vec4<f32>; // [displayZoom, fetchZoom, effectStrength, extremeZoom]
    @group(0) @binding(6) var<uniform> pickedLayerId: f32;
    @group(0) @binding(7) var idSampler: sampler;  // Nearest-neighbor sampler for ID texture

    @fragment
    fn main(@location(0) texCoord: vec2<f32>) -> @location(0) vec4<f32> {
        let texelSize = 1.0 / canvasSize;
        
        // Get center color (use linear filtering for smooth appearance)
        let centerColor = textureSample(colorTexture, mysampler, texCoord);
        
        // Get center ID pixel (use NEAREST filtering - no interpolation for exact IDs)
        let centerPixel = textureSample(idTexture, idSampler, texCoord);
        let id = centerPixel.r * 255.0 * 256.0 + centerPixel.g * 255.0;
        
        // FIXED: Use actual display zoom (same as used in the vertex shader)
        let displayZoom = zoomInfo.x;
        let effectStrength = zoomInfo.z;
        let extremeZoom = zoomInfo.w;
        
        // Keep edge detection at 1-pixel width always
        let sampleOffset = texelSize;
        
        // Sample neighbors with NEAREST filtering (exact IDs, no interpolation)
        let leftPixel = textureSample(idTexture, idSampler, texCoord + vec2<f32>(-sampleOffset.x, 0.0));
        let leftId = leftPixel.r * 255.0 * 256.0 + leftPixel.g * 255.0;
        
        let rightPixel = textureSample(idTexture, idSampler, texCoord + vec2<f32>(sampleOffset.x, 0.0));
        let rightId = rightPixel.r * 255.0 * 256.0 + rightPixel.g * 255.0;
        
        let upPixel = textureSample(idTexture, idSampler, texCoord + vec2<f32>(0.0, -sampleOffset.y));
        let upId = upPixel.r * 255.0 * 256.0 + upPixel.g * 255.0;
        
        let downPixel = textureSample(idTexture, idSampler, texCoord + vec2<f32>(0.0, sampleOffset.y));
        let downId = downPixel.r * 255.0 * 256.0 + downPixel.g * 255.0;

        let hasFeature = id > 0.1;
        let isDifferent = hasFeature && (
            abs(id - leftId) > 0.1 || 
            abs(id - rightId) > 0.1 || 
            abs(id - upId) > 0.1 || 
            abs(id - downId) > 0.1
        );
        
        // Decode layer IDs from blue channel
        let layerId = centerPixel.b * 255.0;
        let pickedLayerIdValue = pickedLayerId;  // From uniform
        
        // Check if this pixel's feature matches the picked feature
        let featureMatch = hasFeature && 
                          (abs(id - pickedId) < 0.01) && 
                          (abs(layerId - pickedLayerIdValue) < 0.01);
        
        // Only highlight if the picked feature is actually visible at this pixel
        // If another feature (different ID or layer) is at this pixel, it's occluding the picked feature
        // So we should NOT highlight - just show the occluding feature's color
        let isSelected = featureMatch;

        // CRITICAL FIX: Delay pattern changes until much higher zoom levels (20+)
        if (!hasFeature) {
            // Only start pattern changes at zoom 20+ instead of 12
            if (displayZoom > 20.0) {
                // FIXED: Use a normalized pattern scale factor
                // This ensures patterns don't scale too quickly with zoom
                let patternScale = displayZoom / 10.0;  // Much slower scaling
                let stripeWidth = 0.8;  // Wider stripes to reduce apparent scaling
                
                // Only show grid pattern at extreme zoom (28+)
                if (displayZoom > 28.0) {
                    let gridSize = stripeWidth / patternScale;
                    let vertPattern = fract(texCoord.y * patternScale / stripeWidth) < 0.5;
                    let horizPattern = fract(texCoord.x * patternScale / stripeWidth) < 0.5;
                    
                    var blue: f32;
                    if (vertPattern != horizPattern) { // XOR for grid
                        blue = 0.7;
                    } else {
                        blue = 0.5;
                    }
                    
                    return vec4<f32>(0.2, 0.3, blue, 1.0);
                } else {
                    // Simple stripe pattern that scales with zoom
                    let stripePattern = fract(texCoord.x * patternScale / stripeWidth) < 0.5;
                    
                    var blue: f32;
                    if (stripePattern) {
                        blue = 0.7;
                    } else {
                        blue = 0.6;
                    }
                    return centerColor;
                }
            }
            return centerColor;
        } else if (isSelected) {
            // Highlight selected feature with yellow tint
            return mix(centerColor, vec4<f32>(1.0, 1.0, 0.0, 1.0), 0.4);
        } else if (isDifferent) {
            return centerColor;  // OUTLINES DISABLED - just return color
        } else {
            // FIXED: Only add interior patterns at very high zoom
            if (displayZoom > 22.0) {
                // Much slower pattern scaling
                let patternScale = displayZoom / 12.0;
                let patternSize = 0.5;  // Larger pattern size to reduce apparent scaling
                
                let countryPatternX = fract(texCoord.x * patternScale / patternSize) < 0.5;
                let countryPatternY = fract(texCoord.y * patternScale / patternSize) < 0.5;
                
                if ((countryPatternX && !countryPatternY) || (!countryPatternX && countryPatternY)) {
                    return centerColor * 1.2; // Lighten
                } else {
                    return centerColor * 0.9; // Darken
                }
            }
            
            return centerColor;  // Original color
        }
    }
`;

export const debugVertexShaderCode = `
    @vertex fn main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
        var pos = array<vec2<f32>, 6>(
            vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
            vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0)
        );
        return vec4<f32>(pos[idx], 0.0, 1.0);
    }
`;

export const debugFragmentShaderCode = `
    @group(0) @binding(0) var tex: texture_2d<f32>;
    @fragment fn main(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
        let coord = vec2<i32>(pos.xy);
        let value = textureLoad(tex, coord, 0);
        // Amplify the red channel to make IDs visible
        return vec4<f32>(value.r * 10.0, 0.0, 0.0, 1.0);
    }
`;
