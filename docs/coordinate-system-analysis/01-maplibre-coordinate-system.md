# MapLibre Coordinate System Analysis

## Overview

MapLibre GL JS uses a sophisticated coordinate system architecture that manages transformations between geographic coordinates, world coordinates, camera coordinates, and screen coordinates. This analysis covers the core components for camera control, tile fetching, and user interactions.

## Coordinate System Hierarchy

### 1. Geographic Coordinates (LngLat)
- **Range**: Longitude [-180, 180], Latitude [-90, 90]
- **Purpose**: Real-world geographic positioning
- **Usage**: User input, data sources, API interfaces

### 2. World Coordinates
- **Range**: [0, 1] normalized coordinate space at zoom level 0
- **Purpose**: Intermediate coordinate space for calculations
- **Conversion**: `x = (lng + 180) / 360`, `y = (1 - ln(tan(lat * π/180) + 1/cos(lat * π/180)) / π) / 2`

### 3. Pixel Coordinates
- **Range**: Variable based on zoom level and tile size
- **Purpose**: Rendering and tile positioning
- **Formula**: `pixelCoord = worldCoord * 2^zoom * tileSize`

### 4. Screen Coordinates
- **Range**: Canvas dimensions
- **Purpose**: User interaction and display
- **Origin**: Top-left corner (0, 0)

## Core Classes and Components

### Transform Class
The `Transform` class is the central coordinator for all coordinate transformations:

```typescript
class Transform {
  // Core properties
  center: LngLat;           // Map center in geographic coordinates
  zoom: number;             // Current zoom level
  bearing: number;          // Map rotation in degrees
  pitch: number;            // 3D tilt angle
  
  // Projection matrices
  projMatrix: mat4;         // 3D projection matrix
  labelPlaneMatrix: mat4;   // Matrix for label positioning
  glCoordMatrix: mat4;      // WebGL coordinate matrix
  
  // Key methods
  locationToScreenPoint(lnglat: LngLat): Point;
  screenPointToLocation(point: Point): LngLat;
  getBounds(): LngLatBounds;
  getVisibleUnwrappedCoordinates(): Array<UnwrappedTileID>;
}
```

### Camera Class
Manages camera positioning and smooth transitions:

```typescript
class Camera {
  // Animation and easing
  easeTo(options: EaseToOptions): Camera;
  flyTo(options: FlyToOptions): Camera;
  jumpTo(options: CameraOptions): Camera;
  
  // Coordinate conversion helpers
  project(lnglat: LngLat): Point;
  unproject(point: Point): LngLat;
  
  // Bounds and constraints
  setMaxBounds(bounds?: LngLatBoundsLike): Camera;
  fitBounds(bounds: LngLatBoundsLike, options?: FitBoundsOptions): Camera;
}
```

## Tile System Architecture

### Tile Coordinate System
MapLibre uses a quadtree-based tile system where:
- Zoom level 0: Single tile (256x256 pixels) covers entire world
- Each zoom level quadruples the number of tiles
- Tile coordinates: `{z: zoom, x: column, y: row}`

### TileID Structure
```typescript
class TileID {
  z: number;        // Zoom level
  x: number;        // Column index
  y: number;        // Row index
  key: string;      // Unique identifier "z/x/y"
  
  // Coordinate conversion
  toUnwrapped(): UnwrappedTileID;
  getURL(sources: Array<string>): string;
}
```

### Source Manager
Handles tile fetching and caching:

```typescript
class SourceCache {
  // Tile lifecycle
  loadTile(tile: Tile): void;
  reloadTile(id: TileID): void;
  abortTile(id: TileID): void;
  unloadTile(id: TileID): void;
  
  // Visibility calculation
  getVisibleCoordinates(): Array<TileID>;
  findLoadedParent(tileID: TileID): Tile | null;
  findLoadedChildren(tileID: TileID): Array<Tile>;
}
```

## Panning and Zooming Implementation

### Mouse/Touch Event Handling
```typescript
class HandlerManager {
  // Pan handling
  _onPanStart(e: MouseEvent): void;
  _onPanMove(e: MouseEvent): void;
  _onPanEnd(e: MouseEvent): void;
  
  // Zoom handling
  _onZoom(e: WheelEvent): void;
  _onPinchStart(e: TouchEvent): void;
  _onPinchMove(e: TouchEvent): void;
}
```

### Smooth Animation System
```typescript
class EaseToHandler {
  // Animation parameters
  duration: number;
  easing: (t: number) => number;
  startTime: number;
  
  // Animation loop
  tick(now: number): boolean {
    const t = Math.min((now - this.startTime) / this.duration, 1);
    const easedT = this.easing(t);
    
    // Interpolate camera properties
    this.map.transform.center = interpolate(startCenter, endCenter, easedT);
    this.map.transform.zoom = interpolate(startZoom, endZoom, easedT);
    
    return t < 1; // Continue animation
  }
}
```

### Inertia and Momentum
```typescript
class PanHandler {
  // Momentum calculation
  calculateInertia(velocityX: number, velocityY: number): {
    offset: Point;
    duration: number;
  } {
    const deceleration = 2500; // pixels/second²
    const maxDuration = 1400;  // milliseconds
    
    const speed = Math.sqrt(velocityX * velocityX + velocityY * velocityY);
    const duration = Math.min(speed / deceleration * 1000, maxDuration);
    
    return {
      offset: new Point(
        velocityX * duration / 2000,
        velocityY * duration / 2000
      ),
      duration
    };
  }
}
```

## Viewport Culling and Optimization

### Frustum Culling
```typescript
class Transform {
  // Calculate visible tile pyramid
  coveringTiles(options: {
    tileSize: number;
    minzoom?: number;
    maxzoom?: number;
    roundZoom?: boolean;
    reparseOverscaled?: boolean;
  }): Array<TileID> {
    const z = this.coveringZoomLevel(options);
    const actualZ = Math.max(0, Math.floor(z));
    
    // Get bounds in tile coordinates
    const bounds = this.getVisibleUnwrappedCoordinates(actualZ);
    
    // Generate tile IDs for visible area
    const tiles: Array<TileID> = [];
    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      for (let y = bounds.minY; y <= bounds.maxY; y++) {
        tiles.push(new TileID(actualZ, x, y));
      }
    }
    
    return tiles;
  }
}
```

### Level of Detail (LOD) Management
```typescript
class Painter {
  // Render tiles at appropriate detail level
  renderTileLayer(layer: StyleLayer, tileIDs: Array<TileID>): void {
    for (const tileID of tileIDs) {
      const tile = this.sourceCache.getTile(tileID);
      
      if (tile.hasData()) {
        this.renderTile(tile, layer);
      } else {
        // Use parent or child tiles as fallback
        const parent = this.sourceCache.findLoadedParent(tileID);
        if (parent) {
          this.renderOverscaledTile(parent, tileID, layer);
        }
      }
    }
  }
}
```

## Performance Considerations

### 1. Coordinate Transformation Caching
- Cache projection matrices when camera hasn't moved
- Batch coordinate transformations for multiple points
- Use web workers for heavy calculations

### 2. Tile Request Optimization
- Prioritize visible tiles over off-screen tiles
- Implement exponential backoff for failed requests
- Use HTTP/2 multiplexing for parallel requests

### 3. Animation Performance
- Use `requestAnimationFrame` for smooth 60fps animations
- Implement frame skipping during heavy computation
- Pre-calculate animation keyframes when possible

## Integration Guidelines for Your Project

### 1. Coordinate System Adaptation
```typescript
// Adapt MapLibre's coordinate system for your use case
class CustomTransform extends Transform {
  // Override specific methods for custom projection
  projectLngLat(lnglat: LngLat): Point {
    // Your custom projection logic
    return super.projectLngLat(lnglat);
  }
  
  // Add custom coordinate spaces if needed
  worldToCustom(worldCoord: Point): CustomCoord {
    // Transform world coordinates to your custom system
  }
}
```

### 2. Tile System Integration
```typescript
// Implement custom tile source
class CustomTileSource extends VectorTileSource {
  loadTile(tile: Tile, callback: Callback<void>): void {
    // Your custom tile loading logic
    const url = this.generateTileURL(tile.tileID);
    
    fetch(url)
      .then(response => response.arrayBuffer())
      .then(data => {
        tile.loadVectorData(data);
        callback(null);
      })
      .catch(callback);
  }
}
```

### 3. Custom Interaction Handlers
```typescript
// Extend existing handlers for custom behavior
class CustomPanHandler extends PanHandler {
  onPanMove(e: MouseEvent): void {
    // Add custom constraints or transformations
    const constrainedDelta = this.applyConstraints(e.movementX, e.movementY);
    super.onPanMove({...e, movementX: constrainedDelta.x, movementY: constrainedDelta.y});
  }
  
  applyConstraints(deltaX: number, deltaY: number): Point {
    // Implement your custom pan constraints
    return new Point(deltaX, deltaY);
  }
}
```

## Key Takeaways

1. **Hierarchical Coordinates**: Understanding the transformation chain from geographic to screen coordinates is crucial for custom implementations.

2. **Tile Management**: The quadtree-based tile system with LOD fallbacks ensures smooth rendering at all zoom levels.

3. **Animation System**: Easing functions and momentum calculations provide natural user interactions.

4. **Performance Optimization**: Frustum culling, caching, and request prioritization are essential for smooth performance.

5. **Extensibility**: MapLibre's modular architecture allows for custom coordinate systems, tile sources, and interaction handlers.

This analysis provides the foundation for implementing similar coordinate system management, tile fetching, and user interaction patterns in your mapping project.