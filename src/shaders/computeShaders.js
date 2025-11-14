// 3-Pass GPU Compute Pipeline for Stable Label Positioning
//
// COORDINATE SYSTEM & QUADRANT NAMING:
//   WebGPU screen-space: Y increases DOWNWARD (0 = top of screen, height = bottom)
//   
//   Our quadrant names match GEOGRAPHIC/CARTOGRAPHIC positions:
//     "top" = NORTH (top of polygon on screen, small Y values)
//     "bottom" = SOUTH (bottom of polygon on screen, large Y values)
//     "left" = WEST (left side, small X values)
//     "right" = EAST (right side, large X values)
//
// NOTE: This is OPPOSITE of MapLibre's text-anchor convention, where "top" means
//       "anchor the top edge of the text" (making text appear below the point).
//       Here, "top" means "the top/northern part of the polygon geometry".
//
// Pass 1: Calculate stable centroid + bounding box for each feature
// Pass 2: Use stable centroid to divide pixels into 9 geographic quadrants
// Pass 3: Generate final marker position from selected quadrant

export const accumulatorShaderCode = `
// Pass 1: Scan hidden texture and accumulate (sum, count, min, max) per feature ID
//
// For 3D buildings: checks markerOffset texture first (roof pixels)
// For 2D features: uses hidden texture (ground footprint pixels)
//
// This dual-buffer approach ensures:
// - Building markers appear on roofs (not at building edges/ground)
// - 2D feature markers appear at their centroid

struct FeatureAccumulator {
    sumX: atomic<u32>,
    sumY: atomic<u32>,
    count: atomic<u32>,
    minX: atomic<u32>,
    minY: atomic<u32>,
    maxX: atomic<u32>,
    maxY: atomic<u32>
};

@group(0) @binding(0) var hiddenTex: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> accumulators: array<FeatureAccumulator>;

@compute @workgroup_size(16,16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(hiddenTex);
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }
    
    // DISABLED: markerOffset texture until we fix building roof geometry
    // Just use hidden texture for all features (2D only)
    let pixel = textureLoad(hiddenTex, vec2<i32>(gid.xy), 0);
    
    // Feature ID from red+green channels (16-bit encoding)
    let fid: u32 = u32(pixel.r * 255.0) * 256u + u32(pixel.g * 255.0);
    if (fid == 0u || fid >= 65535u) { return; }
    
    // Blue channel contains layer ID, alpha contains pickable flag
    // Include all pixels with valid feature IDs for marker calculation
    let x = gid.x;
    let y = gid.y;
    
    atomicAdd(&accumulators[fid].count, 1u);
    atomicAdd(&accumulators[fid].sumX, x);
    atomicAdd(&accumulators[fid].sumY, y);
    atomicMin(&accumulators[fid].minX, x);
    atomicMin(&accumulators[fid].minY, y);
    atomicMax(&accumulators[fid].maxX, x);
    atomicMax(&accumulators[fid].maxY, y);
}
`;

export const quadrantShaderCode = `
// Pass 2: Calculate quadrant centroids using stable centroid from pass 1
//
// Quadrant naming = GEOGRAPHIC position on map:
//   "top" = northern pixels (small Y, top of screen)
//   "bottom" = southern pixels (large Y, bottom of screen)
//   "left" = western pixels (small X, left side)
//   "right" = eastern pixels (large X, right side)

struct FeatureAccumulator {
    sumX: atomic<u32>,
    sumY: atomic<u32>,
    count: atomic<u32>,
    minX: atomic<u32>,
    minY: atomic<u32>,
    maxX: atomic<u32>,
    maxY: atomic<u32>
};

struct QuadrantData {
    sumX: atomic<u32>,
    sumY: atomic<u32>,
    count: atomic<u32>
};

struct QuadrantAccumulator {
    center: QuadrantData,
    topLeft: QuadrantData,
    top: QuadrantData,
    topRight: QuadrantData,
    left: QuadrantData,
    right: QuadrantData,
    bottomLeft: QuadrantData,
    bottom: QuadrantData,
    bottomRight: QuadrantData
};

@group(0) @binding(0) var hiddenTex: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> accumulators: array<FeatureAccumulator>;
@group(0) @binding(2) var<storage, read_write> quadrants: array<QuadrantAccumulator>;

@compute @workgroup_size(16,16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(hiddenTex);
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }
    
    // DISABLED: markerOffset texture until we fix building roof geometry
    // Just use hidden texture for all features (2D only)
    let pixel = textureLoad(hiddenTex, vec2<i32>(gid.xy), 0);
    
    // Feature ID from red+green channels (16-bit encoding)
    let fid: u32 = u32(pixel.r * 255.0) * 256u + u32(pixel.g * 255.0);
    if (fid == 0u || fid >= 65535u) { return; }
    
    let x = gid.x;
    let y = gid.y;
    
    // Get STABLE centroid from pass 1
    let count = atomicLoad(&accumulators[fid].count);
    if (count == 0u) { return; }
    
    let sumX = atomicLoad(&accumulators[fid].sumX);
    let sumY = atomicLoad(&accumulators[fid].sumY);
    let centerX = f32(sumX) / f32(count);
    let centerY = f32(sumY) / f32(count);
    
    // Always accumulate in center
    atomicAdd(&quadrants[fid].center.count, 1u);
    atomicAdd(&quadrants[fid].center.sumX, x);
    atomicAdd(&quadrants[fid].center.sumY, y);
    
    // Now use stable centroid to determine quadrants
    // Quadrant naming = GEOGRAPHIC position (top=north, bottom=south, left=west, right=east)
    // Y increases downward, so: small Y = top/north, large Y = bottom/south
    let inLeft = f32(x) < centerX;    // West side (small X)
    let inRight = f32(x) >= centerX;  // East side (large X)
    let inBottom = f32(y) < centerY;  // North side (small Y, top of screen) - YES, "bottom" uses small Y!
    let inTop = f32(y) >= centerY;    // South side (large Y, bottom of screen) - YES, "top" uses large Y!
    
    // Accumulate into directional quadrants
    if (inTop && inLeft) {
        atomicAdd(&quadrants[fid].topLeft.count, 1u);
        atomicAdd(&quadrants[fid].topLeft.sumX, x);
        atomicAdd(&quadrants[fid].topLeft.sumY, y);
    }
    if (inTop && inRight) {
        atomicAdd(&quadrants[fid].topRight.count, 1u);
        atomicAdd(&quadrants[fid].topRight.sumX, x);
        atomicAdd(&quadrants[fid].topRight.sumY, y);
    }
    if (inBottom && inLeft) {
        atomicAdd(&quadrants[fid].bottomLeft.count, 1u);
        atomicAdd(&quadrants[fid].bottomLeft.sumX, x);
        atomicAdd(&quadrants[fid].bottomLeft.sumY, y);
    }
    if (inBottom && inRight) {
        atomicAdd(&quadrants[fid].bottomRight.count, 1u);
        atomicAdd(&quadrants[fid].bottomRight.sumX, x);
        atomicAdd(&quadrants[fid].bottomRight.sumY, y);
    }
    
    // Edge midpoints
    if (inTop) {
        atomicAdd(&quadrants[fid].top.count, 1u);
        atomicAdd(&quadrants[fid].top.sumX, x);
        atomicAdd(&quadrants[fid].top.sumY, y);
    }
    if (inBottom) {
        atomicAdd(&quadrants[fid].bottom.count, 1u);
        atomicAdd(&quadrants[fid].bottom.sumX, x);
        atomicAdd(&quadrants[fid].bottom.sumY, y);
    }
    if (inLeft) {
        atomicAdd(&quadrants[fid].left.count, 1u);
        atomicAdd(&quadrants[fid].left.sumX, x);
        atomicAdd(&quadrants[fid].left.sumY, y);
    }
    if (inRight) {
        atomicAdd(&quadrants[fid].right.count, 1u);
        atomicAdd(&quadrants[fid].right.sumX, x);
        atomicAdd(&quadrants[fid].right.sumY, y);
    }
}
`;

export const centerShaderCode = `
// Pass 3: Calculate final marker positions from stable quadrant data
//
// MapLibre text-anchor reminder:
//   "top"/"bottom" refer to which edge of TEXT is anchored, not screen position
//   "top" = southern part of polygon (where text with top-anchor would appear)
//   "bottom" = northern part of polygon (where text with bottom-anchor would appear)
//
struct FeatureAccumulator {
    sumX: atomic<u32>,
    sumY: atomic<u32>,
    count: atomic<u32>,
    minX: atomic<u32>,
    minY: atomic<u32>,
    maxX: atomic<u32>,
    maxY: atomic<u32>
};

struct QuadrantData {
    sumX: atomic<u32>,
    sumY: atomic<u32>,
    count: atomic<u32>
};

struct QuadrantAccumulator {
    center: QuadrantData,
    topLeft: QuadrantData,
    top: QuadrantData,
    topRight: QuadrantData,
    left: QuadrantData,
    right: QuadrantData,
    bottomLeft: QuadrantData,
    bottom: QuadrantData,
    bottomRight: QuadrantData
};

struct Marker {
    center: vec2<f32>,
    height: f32,
    padding: f32,
    color: vec4<f32>,
    featureId: u32,
    padding2: u32,
};

@group(0) @binding(0) var<storage, read_write> accumulators: array<FeatureAccumulator>;
@group(0) @binding(1) var<storage, read_write> quadrants: array<QuadrantAccumulator>;
@group(0) @binding(2) var<storage, read_write> markers: array<Marker>;
@group(0) @binding(3) var<uniform> dims: vec2<u32>;
@group(0) @binding(4) var hiddenTex: texture_2d<f32>;
@group(0) @binding(5) var<storage, read> heights: array<f32>;

// Helper function to calculate centroid from quadrant data
fn calculateCentroid(quad: ptr<storage, QuadrantData, read_write>) -> vec2<f32> {
    let count = atomicLoad(&(*quad).count);
    if (count == 0u) {
        return vec2<f32>(-1.0, -1.0); // Invalid position
    }
    let sumX = atomicLoad(&(*quad).sumX);
    let sumY = atomicLoad(&(*quad).sumY);
    return vec2<f32>(f32(sumX) / f32(count), f32(sumY) / f32(count));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx: u32 = gid.x;
    if (idx >= 65535u) { return; } // Match feature ID limit
    
    // Initialize marker with default values (use -999 as sentinel for invalid)
    markers[idx].center = vec2<f32>(-999.0, -999.0);
    markers[idx].height = 0.0;
    markers[idx].padding = 0.0;
    markers[idx].color = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    markers[idx].featureId = idx;
    markers[idx].padding2 = 0u;
    
    // Skip background
    if (idx == 0u) { return; }
    
    // Get pixel count for this feature
    let count = atomicLoad(&accumulators[idx].count);
    
    // Skip features with too few pixels
    let minPixels = 5u;
    if (count < minPixels) { return; }
    
    let width = f32(dims.x);
    let height = f32(dims.y);
    
    // Use center quadrant for default positioning
    var position = calculateCentroid(&quadrants[idx].center);
    
    // Validate position
    if (position.x < 0.0 || position.y < 0.0) {
        return; // Invalid position
    }
    
    var centerX = position.x;
    var centerY = position.y;
    
    // CRITICAL: Verify the computed centroid is actually ON the feature
    let sampleX = i32(centerX);
    let sampleY = i32(centerY);
    var onFeature = false;
    
    // Check if the centroid point is on this feature
    // DISABLED: markerOffset texture - just use hidden texture for all features
    if (sampleX >= 0 && sampleX < i32(width) && sampleY >= 0 && sampleY < i32(height)) {
        let pixelColor = textureLoad(hiddenTex, vec2<i32>(sampleX, sampleY), 0);
        let pixelId = u32(pixelColor.r * 255.0) * 256u + u32(pixelColor.g * 255.0);
        onFeature = (pixelId == idx);
    }
    
    // If centroid is not on feature, do a grid search to find a valid point
    if (!onFeature) {
        let gridSteps = 16;
        let stepSizeX = i32(width) / gridSteps;
        let stepSizeY = i32(height) / gridSteps;
        
        for (var gy = 0; gy < gridSteps && !onFeature; gy++) {
            for (var gx = 0; gx < gridSteps && !onFeature; gx++) {
                let gridX = gx * stepSizeX + stepSizeX / 2;
                let gridY = gy * stepSizeY + stepSizeY / 2;
                
                let gridPixel = textureLoad(hiddenTex, vec2<i32>(gridX, gridY), 0);
                let gridId = u32(gridPixel.r * 255.0) * 256u + u32(gridPixel.g * 255.0);
                
                if (gridId == idx) {
                    centerX = f32(gridX);
                    centerY = f32(gridY);
                    onFeature = true;
                }
            }
        }
    }
    
    // Skip if we couldn't find a valid position
    if (!onFeature) {
        return;
    }
    
    // Convert screen pixels to clip space (-1 to 1)
    let clipX = (centerX / width) * 2.0 - 1.0;
    let clipY = (centerY / height) * 2.0 - 1.0;
    
    // Store marker in clip space (markers will be drawn in screen space)
    // The vertex shader will apply the isometric offset
    let buildingHeight = heights[idx];
    markers[idx].center = vec2<f32>(clipX, clipY);
    markers[idx].height = buildingHeight;
    markers[idx].featureId = idx;
    
    // Set color from feature - use a simple scheme based on feature ID
    let r = f32(idx % 256u) / 255.0;
    let g = f32((idx / 256u) % 256u) / 255.0;
    let b = f32((idx / 65536u) % 256u) / 255.0;
    markers[idx].color = vec4<f32>(r, g, b, 1.0);
}
`;
