# WebGPU Translation Layer

## Overview

The WebGPU Translation Layer bridges your innovative hidden buffer system with industry-standard geographic coordinate systems. This enables your application to maintain its superior picking and rendering capabilities while gaining compatibility with standard mapping data formats and tile systems.

## Key Features

- **🚀 WebGPU-Accelerated**: Uses compute shaders for parallel coordinate transformations
- **🎯 Precision-Aware**: Maintains high precision for geographic coordinates at all zoom levels
- **⚡ Performance Optimized**: Smart caching and batch processing for minimal overhead
- **🔄 Bidirectional Translation**: Seamless conversion between geographic and clip coordinates
- **💾 Memory Efficient**: Intelligent cache management and GPU memory optimization

## Architecture

```
Geographic Coordinates (LngLat)
           ↓
    [Translation Layer]
           ↓
WebGPU Clip Coordinates
           ↓
   [Your Hidden Buffer System]
           ↓
    Feature Picking & Rendering
```

## Quick Start

### 1. Initialize the Translation Layer

```typescript
import { WebGPUTranslationLayer } from './core/translation/WebGPUTranslationLayer';

const device = await getWebGPUDevice();
const canvas = document.getElementById('map-canvas') as HTMLCanvasElement;

const translator = new WebGPUTranslationLayer(device, canvas, {
  center: { lng: 0, lat: 0 },
  zoom: 1,
  bearing: 0
});
```

### 2. Convert Coordinates

```typescript
// Single coordinate conversion
const geographic = { lng: -122.4194, lat: 37.7749 }; // San Francisco
const clipCoords = translator.lngLatToClip(geographic);

// Batch conversion (GPU-accelerated)
const geoCoords = [
  { lng: -122.4194, lat: 37.7749 },
  { lng: -74.0060, lat: 40.7128 },
  // ... thousands more
];
const clipCoords = await translator.batchLngLatToClip(geoCoords);
```

### 3. Integrate with Your Hidden Buffer System

```typescript
import { HiddenBufferIntegration } from './core/translation/HiddenBufferIntegration';

const integration = new HiddenBufferIntegration(device, canvas, {
  width: canvas.width,
  height: canvas.height,
  format: 'rgba32uint'
});

// Render geographic features
const features = [
  {
    id: 'feature1',
    type: 'polygon',
    geometry: [
      { lng: -122.4194, lat: 37.7749 },
      { lng: -122.4094, lat: 37.7749 },
      { lng: -122.4094, lat: 37.7849 },
      { lng: -122.4194, lat: 37.7849 }
    ],
    properties: { name: 'San Francisco' }
  }
];

await integration.renderFeatures(features);
```

### 4. Feature Picking

```typescript
// Pick features at screen coordinates
canvas.addEventListener('click', async (event) => {
  const rect = canvas.getBoundingClientRect();
  const screenPoint = {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };

  const pickedFeatures = await integration.pickFeatures(screenPoint);
  console.log('Picked features:', pickedFeatures);
});
```

## API Reference

### WebGPUTranslationLayer

#### Constructor

```typescript
constructor(
  device: GPUDevice,
  canvas: HTMLCanvasElement,
  transformOptions?: TransformOptions,
  translationOptions?: TranslationOptions
)
```

#### Methods

##### `lngLatToClip(lngLat: LngLat): Point`
Converts geographic coordinates to WebGPU clip space coordinates.

##### `clipToLngLat(clipPoint: Point): LngLat`
Converts WebGPU clip space coordinates back to geographic coordinates.

##### `batchLngLatToClip(lngLats: LngLat[]): Promise<Point[]>`
GPU-accelerated batch conversion of multiple coordinates.

##### `updateTransform(options: Partial<TransformOptions>): void`
Updates the map transform (center, zoom, bearing, pitch).

### HiddenBufferIntegration

#### Methods

##### `renderFeatures(features: Feature[]): Promise<void>`
Renders geographic features using your hidden buffer system with automatic coordinate translation.

##### `pickFeatures(screenPoint: Point): Promise<Feature[]>`
Picks features at screen coordinates using your hidden buffer picking system.

##### `updateTransform(options: TransformOptions): void`
Updates the map view and invalidates coordinate caches.

## Performance Optimization

### Caching Strategy

The translation layer uses intelligent caching to minimize coordinate conversion overhead:

```typescript
// Cache statistics
const stats = translator.getCacheStats();
console.log(`Cache hit ratio: ${stats.hitRatio * 100}%`);
console.log(`Cache size: ${stats.size} entries`);
```

### Batch Processing

For optimal performance with large datasets, use batch processing:

```typescript
// Efficient for 100+ coordinates
const clipCoords = await translator.batchLngLatToClip(largeCoordinateArray);

// Less efficient for small datasets (uses CPU)
const clipCoords = largeCoordinateArray.map(coord => translator.lngLatToClip(coord));
```

### GPU Compute Shaders

The translation layer automatically uses WebGPU compute shaders for:
- Parallel coordinate transformations
- Batch processing of large datasets
- High-precision calculations

## Integration with Existing Systems

### Migrating from Your Current System

```typescript
import { YourExistingSystemIntegration } from './examples/TranslationLayerExample';

const integration = new YourExistingSystemIntegration(canvas, device);

// Convert your existing features to geographic coordinates
const existingFeatures = getYourExistingFeatures();
const standardFeatures = await integration.migrateExistingFeatures(existingFeatures);

// Now use with standard geographic coordinates
await renderer.renderGeoFeatures(standardFeatures);
```

### Custom Coordinate Conversion

```typescript
class CustomCoordinateIntegration {
  private translator: WebGPUTranslationLayer;

  constructor(device: GPUDevice, canvas: HTMLCanvasElement) {
    this.translator = new WebGPUTranslationLayer(device, canvas);
  }

  // Convert your custom coordinates to geographic
  convertCustomToGeo(customCoords: CustomCoord[]): LngLat[] {
    return customCoords.map(coord => ({
      lng: coord.x * 360 - 180, // Example conversion
      lat: coord.y * 180 - 90   // Example conversion
    }));
  }

  // Then use standard translation
  async convertToClip(customCoords: CustomCoord[]): Promise<Point[]> {
    const geoCoords = this.convertCustomToGeo(customCoords);
    return await this.translator.batchLngLatToClip(geoCoords);
  }
}
```

## Browser Support

- **Chrome/Edge**: 113+ (WebGPU stable)
- **Firefox**: Behind flag (experimental)
- **Safari**: Behind flag (experimental)

### Fallback Strategy

```typescript
async function initializeRenderer(canvas: HTMLCanvasElement) {
  if (!navigator.gpu) {
    console.warn('WebGPU not supported, falling back to WebGL implementation');
    return new WebGLRenderer(canvas); // Your existing WebGL system
  }

  try {
    const device = await getWebGPUDevice();
    return new WebGPURenderer(device, canvas); // New WebGPU system
  } catch (error) {
    console.warn('WebGPU initialization failed, falling back to WebGL');
    return new WebGLRenderer(canvas);
  }
}
```

## Troubleshooting

### Common Issues

1. **WebGPU Not Available**
   ```typescript
   if (!navigator.gpu) {
     throw new Error('WebGPU not supported in this browser');
   }
   ```

2. **Adapter Request Failed**
   ```typescript
   const adapter = await navigator.gpu.requestAdapter({
     powerPreference: 'high-performance'
   });
   ```

3. **Device Creation Failed**
   ```typescript
   const device = await adapter.requestDevice({
     requiredFeatures: ['timestamp-query'], // Optional features
     requiredLimits: {
       maxComputeWorkgroupStorageSize: 16384
     }
   });
   ```

### Performance Tips

1. **Use Batch Operations**: Always prefer `batchLngLatToClip()` for multiple coordinates
2. **Cache Management**: Monitor cache hit ratio and adjust cache size if needed
3. **Transform Updates**: Minimize transform updates to preserve cache efficiency
4. **GPU Memory**: Monitor GPU memory usage for large datasets

## Examples

See `src/examples/TranslationLayerExample.ts` for complete working examples.

## Contributing

The translation layer is designed to be extensible. Key areas for enhancement:

- **Additional Projections**: Support for custom map projections
- **Tile Integration**: Enhanced tile system compatibility
- **Performance**: Further GPU optimizations
- **Precision**: Enhanced precision handling for extreme zoom levels

## License

This implementation is part of the Map Active Work project.