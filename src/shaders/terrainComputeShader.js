// Terrain Compute Shader for Polygon Draping
// Updates vertex Z values based on terrain atlas sampling
// Only affects flat polygons (z ≈ 0), leaves extruded features unchanged

export const terrainDrapeComputeShader = `
// Vertex buffer layout: position(3) + normal(3) + color(4) = 10 floats per vertex
// We only modify position.z for flat polygons

struct TerrainParams {
    minX: f32,
    minY: f32,
    maxX: f32,
    maxY: f32,
    exaggeration: f32,
    enabled: f32,
    tilesX: f32,
    tilesY: f32,
    vertexCount: u32,
    vertexStride: u32,  // 10 for our format
    _pad1: u32,
    _pad2: u32
};

@group(0) @binding(0) var<storage, read_write> vertices: array<f32>;
@group(0) @binding(1) var terrainTexture: texture_2d<f32>;
@group(0) @binding(2) var terrainSampler: sampler;
@group(0) @binding(3) var<uniform> params: TerrainParams;

// Decode Terrarium format: height = (R * 256 + G + B / 256) - 32768
fn decodeTerrarium(color: vec4<f32>) -> f32 {
    // Check for invalid/transparent pixels
    if (color.a < 0.01) {
        return 0.0;
    }
    
    // Check for NoData sentinel values
    if ((color.r > 0.99 && color.g > 0.99 && color.b > 0.99) ||
        (color.r < 0.01 && color.g < 0.01 && color.b < 0.01)) {
        return 0.0;
    }
    
    let r = color.r * 255.0;
    let g = color.g * 255.0;
    let b = color.b * 255.0;
    let height = (r * 256.0 + g + b / 256.0) - 32768.0;
    
    // Below sea level or above max = treat as 0
    if (height < 0.0 || height > 9000.0) {
        return 0.0;
    }
    return height;
}

fn sampleTerrainHeight(x: f32, y: f32) -> f32 {
    // Check if terrain is enabled
    if (params.enabled < 0.5) {
        return 0.0;
    }
    
    // Caller already verified we're within bounds
    // Convert world position to UV in atlas
    let u = (x - params.minX) / (params.maxX - params.minX);
    let v = 1.0 - (y - params.minY) / (params.maxY - params.minY);
    
    // Check for degenerate bounds (would cause div by zero or NaN)
    if (params.maxX <= params.minX || params.maxY <= params.minY) {
        return 0.0;
    }
    
    // Clamp to valid range
    let clampedU = clamp(u, 0.001, 0.999);
    let clampedV = clamp(v, 0.001, 0.999);
    
    // Sample terrain texture
    let terrainColor = textureSampleLevel(terrainTexture, terrainSampler, vec2<f32>(clampedU, clampedV), 0.0);
    
    // Check for invalid texture data (all zeros or all ones typically indicate missing data)
    // Terrarium uses RGB, alpha should be 1.0 for valid data
    if (terrainColor.a < 0.5) {
        return 0.0;  // Invalid sample
    }
    
    // Decode height
    let rawHeight = decodeTerrarium(terrainColor);
    
    // Sanity check: reject unreasonable heights (< -500m or > 9000m)
    // This catches encoding errors or texture edge artifacts
    if (rawHeight < -500.0 || rawHeight > 9000.0) {
        return 0.0;
    }
    
    let clampedHeight = clamp(rawHeight, 0.0, 9000.0);
    
    // Scale to clip space with exaggeration
    return (clampedHeight / 50000000.0) * params.exaggeration;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let vertexIndex = gid.x;
    if (vertexIndex >= params.vertexCount) { return; }
    
    // Calculate offset into vertex array
    let offset = vertexIndex * params.vertexStride;
    
    // Read vertex position
    let x = vertices[offset + 0u];
    let y = vertices[offset + 1u];
    let z = vertices[offset + 2u];
    
    // Skip 3D extruded features (buildings, etc.)
    // These have large Z values from CPU extrusion (> 0.001)
    // Flat polygons with terrain have Z < 0.001 (terrain height + tiny layer offset)
    if (abs(z) > 0.001) { return; }
    
    // Check if vertex is within terrain atlas bounds
    // If outside, don't modify - leave Z as-is to avoid creating gaps
    let margin = 0.001;
    if (x < params.minX - margin || x > params.maxX + margin ||
        y < params.minY - margin || y > params.maxY + margin) {
        return;  // Outside terrain coverage - don't modify
    }
    
    // Extract layer offset from current z value
    // Layer offsets are ~0.00000005 per layer (max ~0.000005 for 100 layers)
    let layerOffset = z % 0.00001;  // Preserve layer ordering offset
    
    // Sample terrain height at this vertex position (we know we're in bounds)
    let terrainHeight = sampleTerrainHeight(x, y);
    
    // Write back updated Z: terrain height + tiny layer offset for z-ordering
    vertices[offset + 2u] = terrainHeight + layerOffset;
}
`;

// Create the compute pipeline for terrain draping
export function createTerrainDrapePipeline(device) {
    const shaderModule = device.createShaderModule({
        code: terrainDrapeComputeShader,
        label: 'Terrain Drape Compute Shader'
    });
    
    return device.createComputePipeline({
        layout: 'auto',
        compute: {
            module: shaderModule,
            entryPoint: 'main'
        },
        label: 'Terrain Drape Pipeline'
    });
}

// Create bind group for a specific vertex buffer
export function createTerrainDrapeBindGroup(device, pipeline, vertexBuffer, terrainTexture, terrainSampler, paramsBuffer) {
    return device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: vertexBuffer } },
            { binding: 1, resource: terrainTexture.createView() },
            { binding: 2, resource: terrainSampler },
            { binding: 3, resource: { buffer: paramsBuffer } }
        ],
        label: 'Terrain Drape Bind Group'
    });
}

// Dispatch compute shader for a vertex buffer
export function dispatchTerrainDrape(computePass, pipeline, bindGroup, vertexCount) {
    const workgroupSize = 256;
    const dispatchCount = Math.ceil(vertexCount / workgroupSize);
    
    computePass.setPipeline(pipeline);
    computePass.setBindGroup(0, bindGroup);
    computePass.dispatchWorkgroups(dispatchCount);
}
