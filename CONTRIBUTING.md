# Contributing to gpu-geo

Thank you for your interest in contributing! This document provides guidelines and information for contributors.

## 🚀 Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR-USERNAME/gpu-geo.git
   cd gpu-geo
   ```
3. **Install dependencies**:
   ```bash
   npm install
   ```
4. **Start development server**:
   ```bash
   npm run dev
   ```

## 🏗️ Development Workflow

### Branch Naming

- `feature/description` - New features
- `fix/description` - Bug fixes
- `docs/description` - Documentation updates
- `refactor/description` - Code refactoring
- `perf/description` - Performance improvements

### Before Submitting

1. **Type check** your code:
   ```bash
   npm run type-check
   ```

2. **Test manually** in a WebGPU-compatible browser

3. **Update documentation** if you changed APIs or architecture

4. **Clean up console.logs** - Use proper debug flags instead

### Commit Messages

Use clear, descriptive commit messages:

```
Good: "Fix zoom-to-mouse drift by correcting coordinate transform"
Bad: "fix bug"
```

## 🎯 Areas for Contribution

### High Priority

- **Zoom-to-mouse fix** - See `src/camera.js` lines 172-218
- **Memory leak fixes** - Tile buffers aren't properly destroyed
- **Event listener cleanup** - `src/events.js` needs proper teardown
- **TypeScript migration** - Convert remaining `.js` files to `.ts`

### Medium Priority

- **Web Worker integration** - Move GeoJSON parsing off main thread
- **Tile request prioritization** - Load visible tiles first
- **Documentation** - Expand inline code comments
- **Performance benchmarks** - Add automated performance tests

### Nice to Have

- **Text/label rendering** - Symbol layer support
- **Mobile optimization** - Touch gesture improvements
- **Custom tile sources** - Support beyond MapLibre
- **Automated tests** - Unit and integration tests

## 🧪 Testing

Currently, testing is manual:

1. Run `npm run dev`
2. Open browser DevTools
3. Test pan, zoom, and feature picking
4. Monitor console for errors
5. Check FPS counter for performance regressions

**We need help adding automated tests!**

## 📝 Code Style

### JavaScript/TypeScript

- Use **ES6+ features**
- Prefer `const` over `let`
- Use **async/await** over Promise chains
- Add **JSDoc comments** for public APIs
- Keep functions small and focused

### WGSL Shaders

- Add comments explaining the algorithm
- Use descriptive variable names
- Document buffer layouts clearly

### Example:

```javascript
/**
 * Transform geographic coordinates using GPU compute shader
 * @param {Array<[number, number]>} coordinates - Array of [lon, lat] pairs
 * @returns {Promise<Array<[number, number]>>} Transformed coordinates in clip space
 */
async function transformCoordinates(coordinates) {
  // Implementation...
}
```

## 🐛 Reporting Bugs

When reporting bugs, include:

1. **Browser and version** (including WebGPU support check)
2. **Steps to reproduce**
3. **Expected behavior**
4. **Actual behavior**
5. **Console errors** (if any)
6. **Screenshots/videos** (if applicable)

## 💡 Proposing Features

For new features:

1. **Open an issue first** to discuss the idea
2. Explain the use case and benefits
3. Consider performance implications (this is a GPU-focused project!)
4. Be ready to implement it yourself or help others do so

## 🎓 Learning Resources

### WebGPU
- [WebGPU Fundamentals](https://webgpufundamentals.org/)
- [WebGPU Spec](https://www.w3.org/TR/webgpu/)
- [WebGPU Samples](https://webgpu.github.io/webgpu-samples/)

### Mapping Concepts
- [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js)
- [Mapbox Vector Tile Spec](https://docs.mapbox.com/data/tilesets/guides/vector-tiles-introduction/)
- [Web Mercator Projection](https://en.wikipedia.org/wiki/Web_Mercator_projection)

## 📄 License

By contributing, you agree that your contributions will be licensed under the MIT License.

## 🙋 Questions?

- Open a [GitHub Discussion](#)
- Comment on related issues
- Reach out to maintainers

---

**Thank you for contributing!** Every contribution, no matter how small, helps make this project better. 🎉
