// GPU-accelerated coordinate transformation shaders
// This file contains compute shaders for batch processing coordinate transformations

export const coordinateTransformShaderCode = `
// Input/Output structures for coordinate transformation
struct CoordinateInput {
    lon: f32,
    lat: f32,
};

struct CoordinateOutput {
    x: f32,
    y: f32,
};

@group(0) @binding(0) var<storage, read> inputCoords: array<CoordinateInput>;
@group(0) @binding(1) var<storage, read_write> outputCoords: array<CoordinateOutput>;

// Constants for coordinate transformation
const PI: f32 = 3.14159265359;
const PI_4: f32 = PI / 4.0;
const PI_180: f32 = PI / 180.0;

// Rounding function equivalent to roundTo6Places
fn roundTo6Places(value: f32) -> f32 {
    return round(value * 1e6) / 1e6;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let idx = id.x;
    if (idx >= arrayLength(&inputCoords)) { return; }
    
    let coord = inputCoords[idx];
    let lon = coord.lon;
    let lat = coord.lat;
    
    // GPU-parallel Mercator to clip space transformation
    // This is the exact same math as the CPU version but runs in parallel
    let x = lon / 180.0;
    
    // Flip the Y coordinate by negating it (same as CPU version)
    let y = -log(tan(PI_4 + (PI_180 * lat) / 2.0)) / PI;
    
    // Apply scale (currently 1.0 but keeping for future flexibility)
    let scale = 1.0;
    
    // Store result with full precision (no rounding)
    outputCoords[idx] = CoordinateOutput(
        x * scale,
        y * scale
    );
}
`;

export const batchCoordinateTransformShaderCode = `
// Enhanced version that can handle multiple coordinate arrays in a single dispatch
struct BatchCoordinateInput {
    coordinates: array<f32>, // Flattened lon,lat,lon,lat...
};

struct BatchCoordinateOutput {
    coordinates: array<f32>, // Flattened x,y,x,y...
};

@group(0) @binding(0) var<storage, read> batchInput: BatchCoordinateInput;
@group(0) @binding(1) var<storage, read_write> batchOutput: BatchCoordinateOutput;
@group(0) @binding(2) var<uniform> coordinateCount: u32;

const PI: f32 = 3.14159265359;
const PI_4: f32 = PI / 4.0;
const PI_180: f32 = PI / 180.0;

fn roundTo6Places(value: f32) -> f32 {
    return round(value * 1e6) / 1e6;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let coordIdx = id.x;
    if (coordIdx >= coordinateCount) { return; }
    
    // Each coordinate pair is stored as [lon, lat] in the input array
    let inputIndex = coordIdx * 2u;
    let lon = batchInput.coordinates[inputIndex];
    let lat = batchInput.coordinates[inputIndex + 1u];
    
    // Transform to clip space
    let x = lon / 180.0;
    let y = -log(tan(PI_4 + (PI_180 * lat) / 2.0)) / PI;
    let scale = 1.0;
    
    // Store in output array as [x, y]
    let outputIndex = coordIdx * 2u;
    batchOutput.coordinates[outputIndex] = roundTo6Places(x * scale);
    batchOutput.coordinates[outputIndex + 1u] = roundTo6Places(y * scale);
}
`;
