# API Reference

Core classes and methods for GPU-Geo.

## Camera

### Constructor

```javascript
const camera = new Camera(viewportWidth, viewportHeight);
```

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `position` | `[number, number]` | Camera position in Mercator world coords |
| `zoom` | `number` | Zoom level (0-22), scale = 2^zoom |
| `viewportWidth` | `number` | Canvas width in pixels |
| `viewportHeight` | `number` | Canvas height in pixels |
| `maxZoom` | `number` | Maximum zoom level (default: 22) |
| `minZoom` | `number` | Minimum zoom level (default: 0) |
| `friction` | `number` | Drift friction coefficient (default: 0.92) |

### Methods

#### `getMatrix(): mat4`
Returns the view-projection matrix for rendering.

```javascript
const matrix = camera.getMatrix();
device.queue.writeBuffer(uniformBuffer, 0, matrix);
```

#### `zoomIn(factor?: number): void`
Zoom in toward mouse cursor.

```javascript
camera.zoomIn();  // Increment zoom by 1
camera.zoomIn(2); // Increment zoom by 2
```

#### `zoomOut(factor?: number): void`
Zoom out from mouse cursor.

```javascript
camera.zoomOut();  // Decrement zoom by 1
```

#### `pan(dx: number, dy: number): void`
Pan the camera by screen-space delta.

```javascript
// Pan right 100 pixels
const dx = 100 / canvas.width;
camera.pan(dx, 0);
```

#### `getViewport(): Viewport`
Get visible world bounds.

```javascript
const viewport = camera.getViewport();
// {
//   left: -0.5,
//   right: 0.5,
//   top: 0.3,
//   bottom: -0.3,
//   zoom: 6,
//   aspectRatio: 1.778
// }
```

#### `updateMousePosition(event: MouseEvent, canvas: HTMLCanvasElement): void`
Update mouse position for zoom-to-mouse.

```javascript
canvas.addEventListener('mousemove', (e) => {
  camera.updateMousePosition(e, canvas);
});
```

#### `updatePosition(): void`
Apply velocity/drift (call every frame).

```javascript
function frame() {
  camera.updatePosition();
  // ... render
  requestAnimationFrame(frame);
}
```

### Events

Camera extends `EventTarget`:

```javascript
camera.addEventListener('zoom', (e) => {
  console.log('Zoom changed:', e.detail.factor);
});

camera.addEventListener('pan', (e) => {
  console.log('Pan:', e.detail.dx, e.detail.dy);
});

camera.addEventListener('zoomend', () => {
  console.log('Zoom animation complete');
  loadVisibleTiles();
});
```

## MapRenderer

### Constructor

```javascript
const renderer = new MapRenderer(device, context, format);
```

### Methods

#### `createResources(canvas, camera): void`
Initialize textures and buffers.

```javascript
renderer.createResources(canvas, camera);
```

#### `updateCameraTransform(matrix: mat4): void`
Update camera matrix on GPU.

```javascript
const matrix = camera.getMatrix();
renderer.updateCameraTransform(matrix);
```

#### `updatePickedFeature(featureId: number): void`
Highlight a feature by ID.

```javascript
renderer.updatePickedFeature(42);  // Highlight feature 42
renderer.updatePickedFeature(0);   // Clear selection
```

## Tile Utilities

### `getVisibleTiles(camera, fetchZoom): TileCoord[]`

Get tiles visible in viewport.

```javascript
import { getVisibleTiles } from './tile-utils.js';

const fetchZoom = Math.min(Math.floor(camera.zoom), 6);
const tiles = getVisibleTiles(camera, fetchZoom);
// [{x: 32, y: 21, z: 6}, {x: 33, y: 21, z: 6}, ...]
```

### `fetchVectorTile(x, y, z): Promise<VectorTile>`

Fetch and parse a vector tile.

```javascript
import { fetchVectorTile } from './geojson.js';

const tile = await fetchVectorTile(32, 21, 6);
// VectorTile with layers: countries, geolines, centroids
```

### `parseGeoJSONFeature(feature, fillColor): FeatureGeometry`

Parse GeoJSON feature to vertices/indices.

```javascript
import { parseGeoJSONFeature } from './geojson.js';

const feature = layer.feature(i).toGeoJSON(x, y, z);
const geometry = parseGeoJSONFeature(feature, [1, 0, 0, 1]);
// {
//   vertices: Float32Array,      // [x, y, r, g, b, a, ...]
//   fillIndices: Uint16Array,    // Triangle indices
//   outlineIndices: Uint16Array  // Line indices
// }
```

## Coordinate Utilities

### `mercatorToClipSpace(coord): [number, number]`

Convert lon/lat to Mercator world coordinates.

```javascript
import { mercatorToClipSpace } from './utils.js';

const [x, y] = mercatorToClipSpace([-122.4194, 37.7749]);
// San Francisco: [-0.6801, 0.2541]
```

### `gpuMercatorToClipSpace(coords, device): Promise<Float32Array>`

GPU-accelerated batch coordinate transform.

```javascript
import { gpuMercatorToClipSpace } from './coordinateGPU.js';

const coords = [
  [-122.4194, 37.7749],
  [-74.0060, 40.7128],
  // ... 10,000 more
];

const transformed = await gpuMercatorToClipSpace(coords, device);
// Float32Array [x1, y1, x2, y2, ...]
```

## WebGPU Initialization

### `initWebGPU(canvas): Promise<{device, context}>`

Initialize WebGPU device and context.

```javascript
import { initWebGPU } from './webgpu-init.js';

const { device, context } = await initWebGPU(canvas);
const format = navigator.gpu.getPreferredCanvasFormat();
```

## Pipeline Creation

### `createRenderPipeline(device, format, topology, isHidden?): GPURenderPipeline`

Create a rendering pipeline.

```javascript
import { createRenderPipeline } from './renderer.js';

const fillPipeline = createRenderPipeline(device, format, "triangle-list");
const linePipeline = createRenderPipeline(device, format, "line-list");
const hiddenPipeline = createRenderPipeline(device, format, "triangle-list", true);
```

### `createEdgeDetectionPipeline(device, format): GPURenderPipeline`

Create edge detection post-process pipeline.

```javascript
import { createEdgeDetectionPipeline } from './renderer.js';

const edgePipeline = createEdgeDetectionPipeline(device, format);
```

## Performance API

### `window.mapPerformance`

Global performance monitoring object.

```javascript
// Enable/disable GPU mode
window.mapPerformance.setGPUEnabled(true);
window.mapPerformance.isGPUEnabled();  // true

// Get statistics
const stats = window.mapPerformance.getStats();

// Run benchmark
const results = await window.mapPerformance.runBenchmark(10000);
// {
//   coordinates: 10000,
//   gpuTime: 8.2,
//   cpuTime: 42.1,
//   speedup: 5.1
// }

// Live monitoring
window.mapPerformance.enableLiveMonitoring(5000);  // Every 5 seconds
window.mapPerformance.disableLiveMonitoring();
```

**Convenience aliases**:
```javascript
window.gpuMode();    // Enable GPU
window.cpuMode();    // Enable CPU
window.perfStats();  // Log statistics
window.benchmark(1000);  // Run benchmark with 1000 coords
```

## Type Definitions

### TileCoord
```typescript
interface TileCoord {
  x: number;    // Tile X coordinate
  y: number;    // Tile Y coordinate
  z: number;    // Zoom level
}
```

### Viewport
```typescript
interface Viewport {
  left: number;      // Left edge in world coords
  right: number;     // Right edge in world coords
  top: number;       // Top edge in world coords
  bottom: number;    // Bottom edge in world coords
  zoom: number;      // Current zoom level
  aspectRatio: number;  // Width / height
}
```

### FeatureGeometry
```typescript
interface FeatureGeometry {
  vertices: Float32Array;        // Position + color data
  hiddenVertices: Float32Array;  // Feature ID data
  fillIndices: Uint16Array;      // Triangle indices
  outlineIndices: Uint16Array;   // Line indices
  hiddenfillIndices: Uint16Array;  // Hidden triangle indices
  isFilled: boolean;             // Has fill geometry
  isLine: boolean;               // Has line geometry
}
```
