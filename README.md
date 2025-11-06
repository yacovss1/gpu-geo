# WebGPU Map Renderer

> A high-performance, GPU-accelerated web mapping engine built from scratch with WebGPU compute shaders.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![WebGPU](https://img.shields.io/badge/WebGPU-Enabled-brightgreen.svg)](https://www.w3.org/TR/webgpu/)

## 🚀 Features

- **🎮 GPU-Accelerated Coordinate Transformation** - Leverage WebGPU compute shaders for massive parallel processing of geographic coordinates
- **🎯 Efficient Feature Picking** - Hidden buffer technique for fast, pixel-perfect feature identification
- **📊 Real-time Performance Monitoring** - Built-in FPS and render time tracking
- **🗺️ Vector Tile Support** - Render MapLibre/Mapbox vector tiles up to zoom level 48
- **🎨 Custom Rendering Pipeline** - Full control over the rendering stack with WebGPU
- **📦 TypeScript Support** - Gradual migration to TypeScript for better type safety

## 🎯 Why This Project?

Most web mapping libraries rely on WebGL and CPU-based coordinate transformations. This project explores using **WebGPU compute shaders** to:
- Offload coordinate transformation to the GPU
- Process thousands of coordinates in parallel
- Achieve better performance for large, complex geometries

## 📸 Demo

> **Live Demo Coming Soon** - Will be deployed to GitHub Pages

## 🛠️ Prerequisites

- **Node.js** 18+ 
- **Modern Browser** with WebGPU support:
  - Chrome/Edge 113+
  - Safari Technology Preview (with WebGPU enabled)
  - Firefox Nightly (with `dom.webgpu.enabled` flag)

Check browser compatibility: https://caniuse.com/webgpu

## 🚀 Quick Start

```bash
# Clone the repository
git clone https://github.com/YOUR-USERNAME/webgpu-map-renderer.git
cd webgpu-map-renderer

# Install dependencies
npm install

# Start development server
npm run dev
```

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

- [ ] Fix zoom-to-mouse positioning
- [ ] Add proper tile request prioritization
- [ ] Implement text/label rendering
- [ ] Add Web Worker for GeoJSON parsing
- [ ] Complete TypeScript migration
- [ ] Add automated tests
- [ ] Support custom tile sources
- [ ] Mobile optimization

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
