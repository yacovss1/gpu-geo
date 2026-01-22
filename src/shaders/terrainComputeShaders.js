/**
 * Terrain Compute Shaders
 * 
 * WGSL compute shaders for GPU-based terrain projection pipeline.
 * Handles adaptive subdivision, mesh generation, and terrain draping.
 */

// ============================================================================
// SHARED STRUCTURES AND FUNCTIONS
// ============================================================================

const sharedStructures = `
// Terrain bounds uniform
struct TerrainBounds {
    minX: f32,
    minY: f32,
    maxX: f32,
    maxY: f32,
    exaggeration: f32,
    enabled: f32,
    _pad1: f32,
    _pad2: f32
};

// Pipeline configuration
struct Config {
    maxSubdivisionFactor: f32,
    terrainGradientThreshold: f32,
    defaultLineWidth: f32,
    depthOffset: f32,
    _pad1: f32,
    _pad2: f32,
    _pad3: f32,
    _pad4: f32
};

// Input vertex (from CPU - just XY position)
struct InputVertex {
    x: f32,
    y: f32
};

// Segment definition
struct Segment {
    startIdx: u32,
    endIdx: u32,
    featureIdx: u32
};

// Feature metadata
struct Feature {
    featureType: f32,  // 0=line, 1=polygon, 2=point
    width: f32,
    colorR: f32,
    colorG: f32,
    colorB: f32,
    colorA: f32,
    depthOffset: f32,
    _pad: f32
};

// Output vertex (for rendering)
struct OutputVertex {
    posX: f32,
    posY: f32,
    posZ: f32,
    normX: f32,
    normY: f32,
    normZ: f32,
    colorR: f32,
    colorG: f32,
    colorB: f32,
    colorA: f32
};

// Statistics
struct Stats {
    totalOutputVertices: atomic<u32>,
    totalOutputIndices: atomic<u32>,
    maxSubdivisions: atomic<u32>,
    _pad: u32
};

// Sample terrain height at clip space position
fn sampleTerrainHeight(
    clipX: f32, 
    clipY: f32,
    terrainTexture: texture_2d<f32>,
    terrainSampler: sampler,
    bounds: TerrainBounds
) -> f32 {
    if (bounds.enabled < 0.5) {
        return 0.0;
    }
    
    // Check if position is within terrain bounds
    let margin = 0.001;
    if (clipX < bounds.minX - margin || clipX > bounds.maxX + margin ||
        clipY < bounds.minY - margin || clipY > bounds.maxY + margin) {
        return 0.0;
    }
    
    // Convert clip coords to UV (0-1)
    let u = clamp((clipX - bounds.minX) / (bounds.maxX - bounds.minX), 0.001, 0.999);
    let v = clamp(1.0 - (clipY - bounds.minY) / (bounds.maxY - bounds.minY), 0.001, 0.999);
    
    // Sample terrain texture
    let pixel = textureSampleLevel(terrainTexture, terrainSampler, vec2<f32>(u, v), 0.0);
    
    // Decode Terrarium height: height = (R * 256 + G + B / 256) - 32768
    let r = pixel.r * 255.0;
    let g = pixel.g * 255.0;
    let b = pixel.b * 255.0;
    let rawHeight = (r * 256.0 + g + b / 256.0) - 32768.0;
    
    // Clamp height to reasonable range
    let height = clamp(rawHeight, 0.0, 9000.0);
    
    // Scale height to clip space
    return (height / 50000000.0) * bounds.exaggeration;
}

// Calculate terrain gradient (for subdivision decisions)
fn getTerrainGradient(
    x1: f32, y1: f32,
    x2: f32, y2: f32,
    terrainTexture: texture_2d<f32>,
    terrainSampler: sampler,
    bounds: TerrainBounds
) -> f32 {
    let h1 = sampleTerrainHeight(x1, y1, terrainTexture, terrainSampler, bounds);
    let h2 = sampleTerrainHeight(x2, y2, terrainTexture, terrainSampler, bounds);
    
    let dx = x2 - x1;
    let dy = y2 - y1;
    let dist = sqrt(dx * dx + dy * dy);
    
    if (dist < 0.00001) {
        return 0.0;
    }
    
    return abs(h2 - h1) / dist;
}
`;

// ============================================================================
// PASS 1: COUNT SUBDIVISIONS
// ============================================================================

export const countSubdivisionsShaderCode = `
${sharedStructures}

@group(0) @binding(0) var terrainTexture: texture_2d<f32>;
@group(0) @binding(1) var terrainSampler: sampler;
@group(0) @binding(2) var<uniform> terrainBounds: TerrainBounds;

@group(1) @binding(0) var<storage, read> inputVertices: array<f32>;      // Packed x,y pairs
@group(1) @binding(1) var<storage, read> inputSegments: array<u32>;      // Packed startIdx, endIdx, featureIdx
@group(1) @binding(2) var<storage, read> inputFeatures: array<f32>;      // Packed feature data
@group(1) @binding(3) var<storage, read_write> subdivisionCounts: array<u32>;
@group(1) @binding(4) var<storage, read_write> subdivisionOffsets: array<u32>;
@group(1) @binding(5) var<storage, read_write> subdividedVertices: array<f32>;
@group(1) @binding(6) var<storage, read_write> outputVertices: array<f32>;
@group(1) @binding(7) var<storage, read_write> outputIndices: array<u32>;
@group(1) @binding(8) var<storage, read_write> stats: Stats;

@group(2) @binding(0) var<uniform> config: Config;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
    let segmentIdx = globalId.x;
    
    // Bounds check (segment count is stored implicitly in buffer size)
    let segmentBase = segmentIdx * 3u;
    if (segmentBase + 2u >= arrayLength(&inputSegments)) {
        return;
    }
    
    // Read segment
    let startIdx = inputSegments[segmentBase];
    let endIdx = inputSegments[segmentBase + 1u];
    
    // Read vertex positions
    let v1x = inputVertices[startIdx * 2u];
    let v1y = inputVertices[startIdx * 2u + 1u];
    let v2x = inputVertices[endIdx * 2u];
    let v2y = inputVertices[endIdx * 2u + 1u];
    
    // Calculate segment length
    let dx = v2x - v1x;
    let dy = v2y - v1y;
    let segmentLength = sqrt(dx * dx + dy * dy);
    
    // Calculate terrain gradient along segment
    // Sample at multiple points to detect terrain changes
    var maxGradient: f32 = 0.0;
    let numSamples = 4u;
    for (var i = 0u; i < numSamples; i++) {
        let t1 = f32(i) / f32(numSamples);
        let t2 = f32(i + 1u) / f32(numSamples);
        
        let px1 = v1x + dx * t1;
        let py1 = v1y + dy * t1;
        let px2 = v1x + dx * t2;
        let py2 = v1y + dy * t2;
        
        let gradient = getTerrainGradient(px1, py1, px2, py2, terrainTexture, terrainSampler, terrainBounds);
        maxGradient = max(maxGradient, gradient);
    }
    
    // Calculate required subdivisions based on:
    // 1. Segment length (longer segments need more points)
    // 2. Terrain gradient (steeper terrain needs more points)
    let lengthFactor = segmentLength / 0.01; // Normalize to ~0.01 clip units
    let gradientFactor = maxGradient / config.terrainGradientThreshold;
    
    var subdivisions = u32(max(1.0, min(
        config.maxSubdivisionFactor,
        max(lengthFactor, gradientFactor * 4.0)
    )));
    
    // Store subdivision count
    subdivisionCounts[segmentIdx] = subdivisions;
    
    // Compute prefix sum offset (simple approach - each thread writes its own)
    // Note: This is a simplified approach; production would use parallel prefix sum
    var offset = 0u;
    for (var i = 0u; i < segmentIdx; i++) {
        offset += subdivisionCounts[i];
    }
    subdivisionOffsets[segmentIdx] = offset;
    
    // Update max subdivisions stat
    atomicMax(&stats.maxSubdivisions, subdivisions);
}
`;

// ============================================================================
// PASS 2: PERFORM SUBDIVISION
// ============================================================================

export const subdivisionShaderCode = `
${sharedStructures}

@group(0) @binding(0) var terrainTexture: texture_2d<f32>;
@group(0) @binding(1) var terrainSampler: sampler;
@group(0) @binding(2) var<uniform> terrainBounds: TerrainBounds;

@group(1) @binding(0) var<storage, read> inputVertices: array<f32>;
@group(1) @binding(1) var<storage, read> inputSegments: array<u32>;
@group(1) @binding(2) var<storage, read> inputFeatures: array<f32>;
@group(1) @binding(3) var<storage, read> subdivisionCounts: array<u32>;
@group(1) @binding(4) var<storage, read> subdivisionOffsets: array<u32>;
@group(1) @binding(5) var<storage, read_write> subdividedVertices: array<f32>; // x, y, z per vertex
@group(1) @binding(6) var<storage, read_write> outputVertices: array<f32>;
@group(1) @binding(7) var<storage, read_write> outputIndices: array<u32>;
@group(1) @binding(8) var<storage, read_write> stats: Stats;

@group(2) @binding(0) var<uniform> config: Config;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
    let segmentIdx = globalId.x;
    
    // Bounds check
    let segmentBase = segmentIdx * 3u;
    if (segmentBase + 2u >= arrayLength(&inputSegments)) {
        return;
    }
    
    // Read segment data
    let startIdx = inputSegments[segmentBase];
    let endIdx = inputSegments[segmentBase + 1u];
    let featureIdx = inputSegments[segmentBase + 2u];
    
    // Read vertex positions
    let v1x = inputVertices[startIdx * 2u];
    let v1y = inputVertices[startIdx * 2u + 1u];
    let v2x = inputVertices[endIdx * 2u];
    let v2y = inputVertices[endIdx * 2u + 1u];
    
    // Get subdivision info
    let numSubdivisions = subdivisionCounts[segmentIdx];
    let outputOffset = subdivisionOffsets[segmentIdx];
    
    // Get depth offset from feature
    let featureBase = featureIdx * 8u;
    let depthOffset = inputFeatures[featureBase + 6u];
    
    // Interpolate vertices along segment
    for (var i = 0u; i <= numSubdivisions; i++) {
        let t = f32(i) / f32(numSubdivisions);
        
        let px = v1x + (v2x - v1x) * t;
        let py = v1y + (v2y - v1y) * t;
        
        // Sample terrain height
        let terrainZ = sampleTerrainHeight(px, py, terrainTexture, terrainSampler, terrainBounds);
        let pz = terrainZ + depthOffset;
        
        // Write to subdivided vertex buffer
        let outIdx = (outputOffset + i) * 3u;
        subdividedVertices[outIdx] = px;
        subdividedVertices[outIdx + 1u] = py;
        subdividedVertices[outIdx + 2u] = pz;
    }
    
    // Update total vertex count
    atomicAdd(&stats.totalOutputVertices, numSubdivisions + 1u);
}
`;

// ============================================================================
// PASS 3: MESH GENERATION (Line → Ribbon)
// ============================================================================

export const meshGenerationShaderCode = `
${sharedStructures}

@group(0) @binding(0) var terrainTexture: texture_2d<f32>;
@group(0) @binding(1) var terrainSampler: sampler;
@group(0) @binding(2) var<uniform> terrainBounds: TerrainBounds;

@group(1) @binding(0) var<storage, read> inputVertices: array<f32>;
@group(1) @binding(1) var<storage, read> inputSegments: array<u32>;
@group(1) @binding(2) var<storage, read> inputFeatures: array<f32>;
@group(1) @binding(3) var<storage, read> subdivisionCounts: array<u32>;
@group(1) @binding(4) var<storage, read> subdivisionOffsets: array<u32>;
@group(1) @binding(5) var<storage, read> subdividedVertices: array<f32>;
@group(1) @binding(6) var<storage, read_write> outputVertices: array<f32>;  // 10 floats per vertex
@group(1) @binding(7) var<storage, read_write> outputIndices: array<u32>;
@group(1) @binding(8) var<storage, read_write> stats: Stats;

@group(2) @binding(0) var<uniform> config: Config;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
    let segmentIdx = globalId.x;
    
    // Bounds check
    let segmentBase = segmentIdx * 3u;
    if (segmentBase + 2u >= arrayLength(&inputSegments)) {
        return;
    }
    
    // Read segment data
    let featureIdx = inputSegments[segmentBase + 2u];
    
    // Get subdivision info
    let numSubdivisions = subdivisionCounts[segmentIdx];
    let inputOffset = subdivisionOffsets[segmentIdx];
    
    // Get feature properties
    let featureBase = featureIdx * 8u;
    let width = inputFeatures[featureBase + 1u];
    let colorR = inputFeatures[featureBase + 2u];
    let colorG = inputFeatures[featureBase + 3u];
    let colorB = inputFeatures[featureBase + 4u];
    let colorA = inputFeatures[featureBase + 5u];
    
    let halfWidth = width * 0.5;
    
    // Generate ribbon mesh vertices
    // For each subdivided vertex, create left and right vertices
    for (var i = 0u; i <= numSubdivisions; i++) {
        let srcIdx = (inputOffset + i) * 3u;
        let px = subdividedVertices[srcIdx];
        let py = subdividedVertices[srcIdx + 1u];
        let pz = subdividedVertices[srcIdx + 2u];
        
        // Calculate direction (use adjacent vertices)
        var dirX: f32 = 0.0;
        var dirY: f32 = 0.0;
        
        if (i == 0u && numSubdivisions > 0u) {
            // First vertex - use forward direction
            let nextIdx = srcIdx + 3u;
            dirX = subdividedVertices[nextIdx] - px;
            dirY = subdividedVertices[nextIdx + 1u] - py;
        } else if (i == numSubdivisions) {
            // Last vertex - use backward direction
            let prevIdx = srcIdx - 3u;
            dirX = px - subdividedVertices[prevIdx];
            dirY = py - subdividedVertices[prevIdx + 1u];
        } else {
            // Middle vertex - average direction
            let prevIdx = srcIdx - 3u;
            let nextIdx = srcIdx + 3u;
            dirX = subdividedVertices[nextIdx] - subdividedVertices[prevIdx];
            dirY = subdividedVertices[nextIdx + 1u] - subdividedVertices[prevIdx + 1u];
        }
        
        // Normalize direction
        let dirLen = sqrt(dirX * dirX + dirY * dirY);
        if (dirLen > 0.00001) {
            dirX /= dirLen;
            dirY /= dirLen;
        } else {
            dirX = 1.0;
            dirY = 0.0;
        }
        
        // Calculate perpendicular (left is -90 degrees from direction)
        let perpX = -dirY;
        let perpY = dirX;
        
        // Calculate left and right positions
        let leftX = px + perpX * halfWidth;
        let leftY = py + perpY * halfWidth;
        let rightX = px - perpX * halfWidth;
        let rightY = py - perpY * halfWidth;
        
        // Sample terrain at offset positions for proper draping
        let leftZ = sampleTerrainHeight(leftX, leftY, terrainTexture, terrainSampler, terrainBounds) + config.depthOffset;
        let rightZ = sampleTerrainHeight(rightX, rightY, terrainTexture, terrainSampler, terrainBounds) + config.depthOffset;
        
        // Surface normal (up)
        let normX = 0.0;
        let normY = 0.0;
        let normZ = 1.0;
        
        // Output vertex layout: posX, posY, posZ, normX, normY, normZ, colorR, colorG, colorB, colorA
        let ribbonOffset = (inputOffset + i) * 2u; // 2 vertices per centerline point
        
        // Left vertex
        let leftOutIdx = ribbonOffset * 10u;
        outputVertices[leftOutIdx + 0u] = leftX;
        outputVertices[leftOutIdx + 1u] = leftY;
        outputVertices[leftOutIdx + 2u] = leftZ;
        outputVertices[leftOutIdx + 3u] = normX;
        outputVertices[leftOutIdx + 4u] = normY;
        outputVertices[leftOutIdx + 5u] = normZ;
        outputVertices[leftOutIdx + 6u] = colorR;
        outputVertices[leftOutIdx + 7u] = colorG;
        outputVertices[leftOutIdx + 8u] = colorB;
        outputVertices[leftOutIdx + 9u] = colorA;
        
        // Right vertex
        let rightOutIdx = (ribbonOffset + 1u) * 10u;
        outputVertices[rightOutIdx + 0u] = rightX;
        outputVertices[rightOutIdx + 1u] = rightY;
        outputVertices[rightOutIdx + 2u] = rightZ;
        outputVertices[rightOutIdx + 3u] = normX;
        outputVertices[rightOutIdx + 4u] = normY;
        outputVertices[rightOutIdx + 5u] = normZ;
        outputVertices[rightOutIdx + 6u] = colorR;
        outputVertices[rightOutIdx + 7u] = colorG;
        outputVertices[rightOutIdx + 8u] = colorB;
        outputVertices[rightOutIdx + 9u] = colorA;
        
        // Generate triangle indices (two triangles per quad)
        if (i < numSubdivisions) {
            let quadIdx = (inputOffset + i) * 6u; // 6 indices per quad
            let v0 = ribbonOffset;     // Current left
            let v1 = ribbonOffset + 1u; // Current right
            let v2 = ribbonOffset + 2u; // Next left
            let v3 = ribbonOffset + 3u; // Next right
            
            // Triangle 1: v0, v1, v2
            outputIndices[quadIdx + 0u] = v0;
            outputIndices[quadIdx + 1u] = v1;
            outputIndices[quadIdx + 2u] = v2;
            
            // Triangle 2: v1, v3, v2
            outputIndices[quadIdx + 3u] = v1;
            outputIndices[quadIdx + 4u] = v3;
            outputIndices[quadIdx + 5u] = v2;
        }
    }
}
`;

// ============================================================================
// PASS 4: TERRAIN DRAPING (Final height adjustment + normals)
// ============================================================================

export const terrainDrapingShaderCode = `
${sharedStructures}

@group(0) @binding(0) var terrainTexture: texture_2d<f32>;
@group(0) @binding(1) var terrainSampler: sampler;
@group(0) @binding(2) var<uniform> terrainBounds: TerrainBounds;

@group(1) @binding(0) var<storage, read> inputVertices: array<f32>;
@group(1) @binding(1) var<storage, read> inputSegments: array<u32>;
@group(1) @binding(2) var<storage, read> inputFeatures: array<f32>;
@group(1) @binding(3) var<storage, read> subdivisionCounts: array<u32>;
@group(1) @binding(4) var<storage, read> subdivisionOffsets: array<u32>;
@group(1) @binding(5) var<storage, read> subdividedVertices: array<f32>;
@group(1) @binding(6) var<storage, read_write> outputVertices: array<f32>;
@group(1) @binding(7) var<storage, read_write> outputIndices: array<u32>;
@group(1) @binding(8) var<storage, read_write> stats: Stats;

@group(2) @binding(0) var<uniform> config: Config;

// Calculate terrain normal at a point using central differences
fn calculateTerrainNormal(
    x: f32, y: f32,
    terrainTexture: texture_2d<f32>,
    terrainSampler: sampler,
    bounds: TerrainBounds
) -> vec3<f32> {
    let delta = 0.0001; // Sample offset
    
    let hL = sampleTerrainHeight(x - delta, y, terrainTexture, terrainSampler, bounds);
    let hR = sampleTerrainHeight(x + delta, y, terrainTexture, terrainSampler, bounds);
    let hD = sampleTerrainHeight(x, y - delta, terrainTexture, terrainSampler, bounds);
    let hU = sampleTerrainHeight(x, y + delta, terrainTexture, terrainSampler, bounds);
    
    // Approximate gradient
    let gradX = (hR - hL) / (2.0 * delta);
    let gradY = (hU - hD) / (2.0 * delta);
    
    // Normal is perpendicular to gradient
    return normalize(vec3<f32>(-gradX, -gradY, 1.0));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
    let vertexIdx = globalId.x;
    
    // Check if this vertex exists (use output buffer length)
    let vertexBase = vertexIdx * 10u;
    if (vertexBase + 9u >= arrayLength(&outputVertices)) {
        return;
    }
    
    // Read current vertex position
    let px = outputVertices[vertexBase + 0u];
    let py = outputVertices[vertexBase + 1u];
    
    // Skip if vertex is at origin (not written yet)
    if (px == 0.0 && py == 0.0) {
        return;
    }
    
    // Calculate terrain normal at this position
    let normal = calculateTerrainNormal(px, py, terrainTexture, terrainSampler, terrainBounds);
    
    // Update normals in output
    outputVertices[vertexBase + 3u] = normal.x;
    outputVertices[vertexBase + 4u] = normal.y;
    outputVertices[vertexBase + 5u] = normal.z;
}
`;
