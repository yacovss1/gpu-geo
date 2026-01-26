/**
 * GPU Compute Shader for Point-in-Polygon Testing
 * 
 * Tests grid points against polygon boundaries in parallel on GPU.
 * Much faster than CPU ray-casting for large grids.
 * 
 * Input:
 *   - Grid parameters (size, tile bounds)
 *   - Polygon vertices (outer ring + holes)
 *   - Terrain height data
 * 
 * Output:
 *   - For each grid point: inside flag + terrain height
 */

export const polygonTerrainComputeShader = `
struct Params {
    gridSize: u32,           // Grid resolution (e.g., 32, 64)
    numOuterVerts: u32,      // Number of outer ring vertices
    numHoleVerts: u32,       // Total hole vertices
    numHoles: u32,           // Number of holes
    tileX: u32,
    tileY: u32,
    tileZ: u32,
    terrainWidth: u32,
    terrainHeight: u32,
    exaggeration: f32,
    minX: f32,               // Polygon bounding box
    maxX: f32,
    minY: f32,
    maxY: f32,
    tileBoundsMinX: f32,     // Terrain tile bounds in clip space
    tileBoundsMaxX: f32,
    tileBoundsMinY: f32,
    tileBoundsMaxY: f32,
};

struct GridResult {
    inside: u32,             // 1 if inside polygon, 0 otherwise
    clipX: f32,
    clipY: f32,
    height: f32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> outerRing: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> holes: array<vec2<f32>>;       // All hole vertices concatenated
@group(0) @binding(3) var<storage, read> holeStarts: array<u32>;        // Start index of each hole
@group(0) @binding(4) var<storage, read> terrainHeights: array<f32>;
@group(0) @binding(5) var<storage, read_write> results: array<GridResult>;

// Ray casting algorithm for point-in-ring test
fn pointInRing(px: f32, py: f32, ringStart: u32, ringEnd: u32, ring: ptr<storage, array<vec2<f32>>, read>) -> bool {
    var inside = false;
    let n = ringEnd - ringStart;
    
    for (var i = 0u; i < n; i++) {
        let j = (i + n - 1u) % n;
        let vi = (*ring)[ringStart + i];
        let vj = (*ring)[ringStart + j];
        
        let xi = vi.x;
        let yi = vi.y;
        let xj = vj.x;
        let yj = vj.y;
        
        if (((yi > py) != (yj > py)) &&
            (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    
    return inside;
}

// Check if point is in outer ring but not in any hole
fn pointInPolygon(px: f32, py: f32) -> bool {
    // Must be inside outer ring
    if (!pointInRing(px, py, 0u, params.numOuterVerts, &outerRing)) {
        return false;
    }
    
    // Must NOT be inside any hole
    for (var h = 0u; h < params.numHoles; h++) {
        let holeStart = holeStarts[h];
        var holeEnd: u32;
        if (h + 1u < params.numHoles) {
            holeEnd = holeStarts[h + 1u];
        } else {
            holeEnd = params.numHoleVerts;
        }
        
        if (pointInRing(px, py, holeStart, holeEnd, &holes)) {
            return false;
        }
    }
    
    return true;
}

// Sample terrain height at clip-space position
fn sampleTerrainHeight(clipX: f32, clipY: f32) -> f32 {
    // Convert clip coords to UV within terrain tile
    let u = (clipX - params.tileBoundsMinX) / (params.tileBoundsMaxX - params.tileBoundsMinX);
    let v = 1.0 - (clipY - params.tileBoundsMinY) / (params.tileBoundsMaxY - params.tileBoundsMinY);
    
    // Clamp to valid range
    let clampedU = clamp(u, 0.0, 1.0);
    let clampedV = clamp(v, 0.0, 1.0);
    
    // Sample height
    let tx = u32(clampedU * f32(params.terrainWidth - 1u));
    let ty = u32(clampedV * f32(params.terrainHeight - 1u));
    
    let idx = ty * params.terrainWidth + tx;
    let rawHeight = terrainHeights[idx];
    
    // Apply same scaling as terrain mesh
    return max(0.0, rawHeight) / 50000000.0 * params.exaggeration;
}

// Transform grid position to clip space (MUST match transformTileCoords in vectorTileParser.js)
fn gridToClipSpace(gx: u32, gy: u32) -> vec2<f32> {
    let n = f32(params.gridSize);
    let extent = 4096.0;
    
    // Grid position -> tile pixel position
    let tilePixelX = (f32(gx) / n) * extent;
    let tilePixelY = (f32(gy) / n) * extent;
    
    // Step 1: Tile-local (0-extent) → World coordinates (0-1)
    let tilesAtZoom = f32(1u << params.tileZ);
    let worldX = (f32(params.tileX) + tilePixelX / extent) / tilesAtZoom;
    let worldY = (f32(params.tileY) + tilePixelY / extent) / tilesAtZoom;
    
    // Step 2: World coords → Geographic (lon/lat)
    let lon = worldX * 360.0 - 180.0;
    let mercatorY = 3.14159265359 * (1.0 - 2.0 * worldY);
    let lat = (2.0 * atan(exp(mercatorY)) - 3.14159265359 / 2.0) * (180.0 / 3.14159265359);
    
    // Step 3: Geographic → Mercator clip space (EXACT match to coordinateShaders.js)
    let clipX = lon / 180.0;
    let clipY = -log(tan(3.14159265359 / 4.0 + (3.14159265359 / 180.0) * lat / 2.0)) / 3.14159265359;
    
    return vec2<f32>(clipX, clipY);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let gridSize = params.gridSize;
    let gx = gid.x;
    let gy = gid.y;
    
    // Out of bounds check
    if (gx > gridSize || gy > gridSize) {
        return;
    }
    
    let idx = gy * (gridSize + 1u) + gx;
    
    // Transform to clip space
    let clipPos = gridToClipSpace(gx, gy);
    let clipX = clipPos.x;
    let clipY = clipPos.y;
    
    // Quick bounding box check
    if (clipX < params.minX || clipX > params.maxX || 
        clipY < params.minY || clipY > params.maxY) {
        results[idx].inside = 0u;
        results[idx].clipX = clipX;
        results[idx].clipY = clipY;
        results[idx].height = 0.0;
        return;
    }
    
    // Full point-in-polygon test
    let inside = pointInPolygon(clipX, clipY);
    
    results[idx].inside = select(0u, 1u, inside);
    results[idx].clipX = clipX;
    results[idx].clipY = clipY;
    
    if (inside) {
        results[idx].height = sampleTerrainHeight(clipX, clipY);
    } else {
        results[idx].height = 0.0;
    }
}
`;
