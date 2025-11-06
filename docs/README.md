# GPU-Geo Documentation

WebGPU-accelerated vector map renderer with real-time coordinate transformation.

## Quick Links

- [Architecture Overview](./ARCHITECTURE.md) - System design and rendering pipeline
- [Coordinate Systems](./COORDINATES.md) - How coordinates flow through the system
- [Camera System](./CAMERA.md) - Zoom, pan, and viewport management
- [Performance](./PERFORMANCE.md) - GPU acceleration and optimization
- [API Reference](./API.md) - Core classes and methods

## Quick Start

```bash
npm install
npm run dev
```

Visit `http://localhost:3000` to see the map.

## Project Structure

```
Map_Active_Work/
├── main.js              # Application entry point
├── index.html           # HTML template
├── src/
│   ├── camera.js        # Camera/viewport management
│   ├── events.js        # Mouse/wheel event handling
│   ├── renderer.js      # WebGPU rendering pipeline
│   ├── geojson.js       # Tile loading and parsing
│   ├── tile-utils.js    # Tile coordinate calculations
│   ├── utils.js         # Coordinate conversion utilities
│   ├── webgpu-init.js   # WebGPU device initialization
│   ├── coordinateGPU.js # GPU compute shader for coordinates
│   └── shaders/         # WGSL shader code
└── docs/                # Documentation
```

## Key Features

- **Exponential zoom**: 2^zoom scaling (zoom levels 0-22)
- **Zoom-to-mouse**: Map zooms toward cursor position
- **Overzooming**: Visual zoom beyond tile availability (tiles at zoom 6, visual to 22)
- **GPU acceleration**: Compute shaders for coordinate transformation
- **Dual render pass**: Hidden buffer for feature picking
- **Smooth interactions**: Drift/momentum with configurable friction
