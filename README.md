# gpu-geo

> WebGPU-accelerated vector map renderer with real-time coordinate transformation and zoom-to-mouse controls.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![WebGPU](https://img.shields.io/badge/WebGPU-Enabled-brightgreen.svg)](https://www.w3.org/TR/webgpu/)

## ✨ Features

- **🎮 GPU Compute Shaders** - Parallel coordinate transformation (10,000+ coords in <10ms)
- **🔍 Zoom-to-Mouse** - Smooth exponential zoom (2^zoom) toward cursor position
- **🗺️ Vector Tiles** - MapLibre tiles with overzooming (fetch zoom 6, visual zoom 22)
- **🎯 Feature Picking** - Hidden buffer technique for pixel-perfect click detection
- **📊 Dual Render Pass** - Edge detection shader for crisp borders
- **⚡ High Performance** - 60fps with hundreds of features, tile caching, matrix caching

## � Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

Visit `http://localhost:3000` - Use mouse wheel to zoom, drag to pan.

## 📚 Documentation

- **[Architecture](./docs/ARCHITECTURE.md)** - System design and rendering pipeline
- **[Camera](./docs/CAMERA.md)** - Zoom, pan, and viewport management
- **[Coordinates](./docs/COORDINATES.md)** - How coordinates flow through the system
- **[Performance](./docs/PERFORMANCE.md)** - GPU acceleration and optimization
- **[API Reference](./docs/API.md)** - Core classes and methods

## 🎯 How It Works

**Rendering Pipeline**:
```
User Input → Camera → Matrix (2^zoom) → Viewport → Tiles → 
VectorTile → GeoJSON → Mercator coords → GPU Transform → 
Vertex Buffers → WebGPU Render → Screen
```

**Key Components**:
- **Camera**: Exponential zoom system (2^zoom), zoom-to-mouse calculations
- **Tiles**: Fetch from MapLibre demo server (zoom 0-6), overzoom for higher levels
- **GPU**: Compute shader batch processes 1000+ coords in parallel
- **Rendering**: Dual pass (hidden texture for feature IDs, visible for colors)

## 🛠️ Prerequisites

- **Node.js** 18+
- **Browser** with WebGPU support:
  - Chrome/Edge 113+
  - Safari Technology Preview (experimental)
  - Check: https://caniuse.com/webgpu

Open `http://localhost:5173` in a WebGPU-compatible browser.

## 📦 Build for Production

```bash
# Type-check and build
npm run build

# Preview production build
npm run preview
```

## 🏗️ Architecture

### Core Components

```
src/
├── camera.js           # Camera controls (pan, zoom, rotation)
├── coordinateGPU.js    # GPU-accelerated coordinate transformation
├── geojsonGPU.js       # GeoJSON parsing with GPU transforms
├── renderer.js         # Main WebGPU rendering pipeline
├── events.js           # Mouse/touch event handling
├── shaders/            # WGSL shader code
└── types/              # TypeScript type definitions
```

### Key Technologies

- **WebGPU Compute Shaders** - Parallel coordinate transformation
- **Hidden Buffer Picking** - Efficient feature identification via color-coded offscreen rendering
- **Earcut** - Fast polygon triangulation
- **GL-Matrix** - Matrix math utilities

### GPU Coordinate Transformation

Traditional approach (CPU):
```javascript
features.forEach(feature => {
  feature.coordinates.forEach(coord => {
    const transformed = mercatorProjection(coord); // Slow!
  });
});
```

Our approach (GPU):
```javascript
// Transform ALL coordinates in a single GPU dispatch
const allCoords = extractAllCoordinates(features);
const transformed = await gpuTransform(allCoords); // Fast! ⚡
```

## 📊 Performance

Preliminary benchmarks show **2-5x faster** coordinate transformation for datasets with 10,000+ coordinates compared to CPU-based approaches.

> **Note**: Actual performance depends on GPU capabilities, dataset complexity, and browser implementation.

## 🗺️ Current Limitations

- ⚠️ **Zoom-to-mouse drift** - Known issue being addressed (see [Issues](#))
- 🏷️ No text/symbol rendering yet
- 🌍 Limited to MapLibre demo tile server
- 📱 Mobile/touch support is experimental

## 🛣️ Roadmap

### Current Focus
- [ ] Fix zoom-to-mouse positioning
- [ ] Add proper tile request prioritization
- [ ] Complete TypeScript migration
- [ ] Add Web Worker for GeoJSON parsing

### Experimental Research
- [ ] 🔬 **GPU cloth-physics triangulation** - Replace CPU-based Earcut with GPU spring simulation
- [ ] Animated polygon triangulation
- [ ] Adaptive mesh refinement using physics

### Future Enhancements
- [ ] Text/label rendering
- [ ] Support custom tile sources
- [ ] Mobile optimization
- [ ] Automated tests

See [`docs/`](docs/) for detailed architectural analysis and implementation guides.

## 📚 Documentation

- [Project Structure Overview](docs/Project-Structure-Overview.md)
- [Coordinate System Analysis](docs/coordinate-system-analysis/)
- [TypeScript Migration Guide](docs/TypeScript-Activation-Guide.md)
- [Performance Optimization](docs/coordinate-system-analysis/04-performance-optimization-guide.md)

## 🤝 Contributing

Contributions are welcome! This project is in active development.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Guidelines

- Run `npm run type-check` before committing
- Keep compute shaders well-documented
- Add performance benchmarks for significant changes

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Inspired by [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js)
- WebGPU samples from [WebGPU Fundamentals](https://webgpufundamentals.org/)
- Tile data from MapLibre demo servers

## 📬 Contact

- Open an issue for bugs or feature requests
- Discussions welcome in [GitHub Discussions](#)

---

**⚠️ Experimental Project**: This is an experimental exploration of WebGPU for web mapping. Not recommended for production use yet.

**Browser Support**: Requires cutting-edge browsers with WebGPU enabled. This is bleeding-edge technology!
