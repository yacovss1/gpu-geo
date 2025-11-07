# gpu-geo

WebGPU-accelerated vector map renderer with compute shader-based coordinate transformation and dual-pass rendering.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Features

- **GPU Compute Shaders** - Parallel coordinate transformation using WebGPU compute shaders
- **Dual Render Pass** - Hidden buffer technique for pixel-perfect feature picking, visible pass with edge detection
- **Vector Tiles** - MapLibre/Mapbox vector tile support with dynamic tile loading
- **Interactive Camera** - Smooth pan, zoom, and zoom-to-mouse controls
- **Labels & Markers** - Canvas-based text rendering and GPU-computed marker positioning
- **Performance Monitoring** - Built-in performance tracking with GPU/CPU comparison mode

## Quick Start

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in a WebGPU-compatible browser (Chrome 113+, Edge 113+).

## Architecture

### Rendering Pipeline

```
User Input → Camera → Tile Determination → Vector Tile Fetch → 
GeoJSON Parse → GPU Coordinate Transform → Triangulation → 
Dual WebGPU Render (Hidden + Visible) → Label/Marker Overlay
```

### Core Components

- **Camera** (`src/camera.js`) - Viewport management, exponential zoom (2^zoom), matrix transformations
- **Coordinate GPU** (`src/coordinateGPU.js`) - GPU-accelerated Mercator→Clip space transformation
- **Renderer** (`src/renderer.js`) - WebGPU rendering pipeline with dual-pass system
- **GeoJSON GPU** (`src/geojsonGPU.js`) - GPU-accelerated GeoJSON feature parsing
- **Marker System** (`src/markerManager.js`, `src/markerCompute.js`) - GPU compute-based marker positioning
- **Label Manager** (`src/labels.js`) - Canvas-based text rendering with feature centers
- **Tile Cache** (`src/tileCache.js`) - Efficient vector tile caching

### GPU Acceleration

The system uses WebGPU compute shaders to transform coordinates in parallel:

```javascript
// CPU: Process one coordinate at a time
for (let coord of coordinates) {
  transformed.push(mercatorToClipSpace(coord));
}

// GPU: Process all coordinates in parallel
const transformed = await gpuTransform(coordinates);
```

Performance scales with coordinate count - 10,000+ coordinates see 2-5x speedup over CPU processing.

## Documentation

- [Architecture](./docs/ARCHITECTURE.md) - System design and pipeline details
- [Camera](./docs/CAMERA.md) - Camera system and viewport management
- [Coordinates](./docs/COORDINATES.md) - Coordinate transformation pipeline
- [Performance](./docs/PERFORMANCE.md) - GPU optimization and benchmarking
- [API Reference](./docs/API.md) - Core classes and methods

## Performance Testing

Toggle GPU/CPU processing at runtime:

```javascript
// Enable/disable GPU acceleration
window.mapPerformance.setGPUEnabled(false); // Switch to CPU
window.mapPerformance.setGPUEnabled(true);  // Switch to GPU

// View performance statistics
window.mapPerformance.logStats();

// Run benchmark
await window.mapPerformance.runBenchmark(10000);
```

## Browser Requirements

- Chrome/Edge 113+ with WebGPU enabled
- Safari Technology Preview (experimental)
- Check compatibility: https://caniuse.com/webgpu

## Build

```bash
npm run build    # Production build
npm run preview  # Preview production build
```

## Technology Stack

- **WebGPU** - GPU compute and rendering
- **Vite** - Build tooling and dev server
- **GL-Matrix** - Matrix mathematics
- **Earcut** - Polygon triangulation
- **Mapbox Vector Tile** - Vector tile parsing

## License

MIT License - see [LICENSE](LICENSE) file.

## Acknowledgments

Vector tile format and rendering concepts inspired by [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js).
