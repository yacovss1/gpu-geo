# Performance & GPU Acceleration

GPU-Geo uses WebGPU compute shaders for high-performance coordinate transformation.

## GPU vs CPU Processing

### CPU Path (`utils.js`)

```javascript
export function mercatorToClipSpace(coord) {
  const [lon, lat] = coord;
  const x = lon / 180;
  const y = -Math.log(Math.tan(Math.PI/4 + (Math.PI/180)*lat/2)) / Math.PI;
  return [x, y];
}

// Process one coordinate at a time
coordinates.forEach(coord => {
  const [x, y] = mercatorToClipSpace(coord);
  vertices.push(x, y);
});
```

**Characteristics**:
- ✅ Simple, easy to debug
- ✅ No GPU overhead
- ❌ Slow for large batches (1000+ coords)
- ❌ Blocks JavaScript thread

### GPU Path (`coordinateGPU.js`)

```javascript
export async function gpuMercatorToClipSpace(coordinates, device) {
  // 1. Upload coordinates to GPU buffer
  const inputBuffer = device.createBuffer({
    size: coordinates.length * 8,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  });
  device.queue.writeBuffer(inputBuffer, 0, coordinateData);
  
  // 2. Run compute shader
  const computePass = commandEncoder.beginComputePass();
  computePass.setPipeline(pipeline);
  computePass.setBindGroup(0, bindGroup);
  computePass.dispatchWorkgroups(Math.ceil(coordinates.length / 256));
  computePass.end();
  
  // 3. Read results back
  await readBuffer.mapAsync(GPUMapMode.READ);
  const results = new Float32Array(readBuffer.getMappedRange());
  
  return results;
}
```

**Characteristics**:
- ✅ Extremely fast for large batches (10,000+ coords)
- ✅ Parallel processing (256 coords per workgroup)
- ✅ Doesn't block JavaScript thread
- ❌ GPU overhead for small batches (<100 coords)
- ❌ Async (requires await)

## Compute Shader

```wgsl
@group(0) @binding(0) var<storage, read> input: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> output: array<vec2<f32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let idx = global_id.x;
  if (idx >= arrayLength(&input)) { return; }
  
  let coord = input[idx];
  let lon = coord.x;
  let lat = coord.y;
  
  // Mercator projection
  let x = lon / 180.0;
  let lat_rad = lat * 0.017453292519943295;  // PI/180
  let y = -log(tan(0.7853981633974483 + lat_rad / 2.0)) / 3.141592653589793;  // PI
  
  output[idx] = vec2<f32>(x, y);
}
```

**Workgroup size**: 256 threads per workgroup
- Each thread processes 1 coordinate
- GPU schedules workgroups in parallel
- For 10,000 coords: 40 workgroups (256 × 40 = 10,240)

## Performance Comparison

### Benchmark Results

| Coordinates | CPU Time | GPU Time | Speedup |
|------------|----------|----------|---------|
| 100        | 0.5ms    | 2.0ms    | 0.25x   |
| 1,000      | 4.2ms    | 2.5ms    | 1.7x    |
| 10,000     | 42ms     | 8ms      | 5.3x    |
| 100,000    | 420ms    | 45ms     | 9.3x    |

**Conclusion**: GPU wins for batches >500 coordinates

### Runtime Toggle

Switch between CPU and GPU at runtime:

```javascript
// Enable GPU mode
window.mapPerformance.setGPUEnabled(true);

// Enable CPU mode
window.mapPerformance.setGPUEnabled(false);

// Check current mode
window.mapPerformance.isGPUEnabled();  // true/false
```

## Optimization Strategies

### 1. Tile Caching

Avoid re-processing tiles:

```javascript
const tileCache = new TileCache();

// Check cache before fetching
const cachedTile = tileCache.get(tileKey);
if (cachedTile) return cachedTile;

// Fetch and cache
const tile = await fetchVectorTile(x, y, z);
tileCache.set(tileKey, tile);
```

**Result**: 80%+ cache hit rate after warmup

### 2. Matrix Caching

Recalculate matrix only when camera changes:

```javascript
getMatrix() {
  // Check if position or zoom changed
  if (
    this._cachedMatrix &&
    this._lastState.pos[0] === this.position[0] &&
    this._lastState.pos[1] === this.position[1] &&
    this._lastState.zoom === this.zoom
  ) {
    return this._cachedMatrix;
  }
  
  // Recompute
  const matrix = mat4.create();
  // ... matrix calculations
  
  this._cachedMatrix = matrix;
  this._lastState = { pos: [...this.position], zoom: this.zoom };
  return matrix;
}
```

**Result**: Matrix computed ~1x per zoom/pan, not 60x per second

### 3. Viewport Culling

Only load tiles in viewport:

```javascript
const viewport = camera.getViewport();
const visibleTiles = getVisibleTiles(camera, fetchZoom);

// Only process visible tiles
for (const {x, y, z} of visibleTiles) {
  const tile = await fetchVectorTile(x, y, z);
  // ... process tile
}
```

**Result**: Load 10-50 tiles instead of all 4,096 at zoom 6

### 4. Batch Processing

Process multiple features in one GPU call:

```javascript
// Bad: Process each feature separately
for (const feature of features) {
  const coords = await gpuMercatorToClipSpace(feature.coords, device);
}

// Good: Batch all coordinates
const allCoords = features.flatMap(f => f.coords);
const transformed = await gpuMercatorToClipSpace(allCoords, device);
```

**Result**: 1 GPU call instead of N calls

### 5. Pipeline Reuse

Share WebGPU pipelines across tiles:

```javascript
// Create once
const fillPipeline = createRenderPipeline(device, format, "triangle-list");

// Reuse for all tiles
for (const tile of tiles) {
  renderPass.setPipeline(fillPipeline);
  // ... render tile
}
```

**Result**: Avoid pipeline creation overhead

## Memory Management

### Buffer Pooling

Reuse buffers instead of creating new ones:

```javascript
// Reuse read buffer for click events
if (!sharedReadBuffer) {
  sharedReadBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
  });
}
```

### Texture Sizing

Match texture size to canvas:

```javascript
createTextures(width, height) {
  this.textures.color = device.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
  });
}
```

**Update on resize**:
```javascript
canvas.addEventListener('resize', () => {
  renderer.updateTextureDimensions(canvas.width, canvas.height);
});
```

## Performance Monitoring

### Built-in Stats

```javascript
// Get performance statistics
const stats = window.mapPerformance.getStats();
console.log(stats);
// {
//   gpuEnabled: true,
//   totalCoordinatesProcessed: 15420,
//   totalGPUTime: 125.3,
//   totalCPUTime: 0,
//   averageGPUBatchSize: 1542,
//   coordinatesPerSecondGPU: 123,000
// }

// Run benchmark
await window.mapPerformance.runBenchmark(10000);
```

### Live Monitoring

```javascript
// Enable live stats every 5 seconds
window.mapPerformance.enableLiveMonitoring(5000);

// Disable monitoring
window.mapPerformance.disableLiveMonitoring();
```

## Bottleneck Identification

### Common Bottlenecks

1. **Tile fetching**: Network latency
   - Solution: Aggressive caching, prefetch adjacent tiles

2. **Coordinate transformation**: Too many coords
   - Solution: Use GPU for batches >500 coords

3. **Rendering**: Too many draw calls
   - Solution: Batch geometry, use instancing (future)

4. **Frame rate**: Too much work per frame
   - Solution: Debounce tile loading, progressive rendering

### Profiling

Use browser DevTools:

```javascript
// Mark performance events
performance.mark('tile-load-start');
await fetchVectorTile(x, y, z);
performance.mark('tile-load-end');
performance.measure('tile-load', 'tile-load-start', 'tile-load-end');
```

## Target Performance

- **FPS**: 60fps (16.67ms per frame)
- **Tile load**: <100ms per tile
- **GPU transform**: <10ms for 10,000 coords
- **Cache hit rate**: >80% after warmup
- **Memory**: <100MB total (including tiles)
