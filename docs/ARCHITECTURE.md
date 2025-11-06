# Architecture Overview

## System Design

GPU-Geo is a WebGPU-based vector map renderer that uses compute shaders for coordinate transformation and dual-pass rendering for feature picking.

## Rendering Pipeline

```
User Input (wheel/pan/click)
    ↓
Camera System (position, zoom)
    ↓
Matrix Calculation (2^zoom scale)
    ↓
Viewport Calculation
    ↓
Tile Determination
    ↓
Tile Fetch (MapLibre demo server)
    ↓
VectorTile → GeoJSON → Mercator coords
    ↓
GPU Coordinate Transform (optional)
    ↓
Vertex/Index Buffer Creation
    ↓
WebGPU Dual Render Pass
    ├─ Pass 1: Hidden texture (feature IDs)
    └─ Pass 2: Visible (colors + edge detection)
    ↓
Screen Display
```

## Core Components

### 1. Camera System (`camera.js`)
- **Position**: `[x, y]` in Mercator world coordinates
- **Zoom**: Exponential scale factor (2^zoom)
- **Matrix**: View-projection transform for rendering
- **Viewport**: Calculates visible world bounds

### 2. Event System (`events.js`)
- **Wheel**: Zoom in/out, updates mouse position
- **Mouse drag**: Pan camera
- **Click**: Feature picking via hidden texture

### 3. Renderer (`renderer.js`)
- **Dual pass rendering**:
  - Pass 1: Render feature IDs to hidden texture
  - Pass 2: Render colors + edge detection
- **Pipeline management**: Fill, outline, edge detection
- **Resource management**: Buffers, textures, bind groups

### 4. Tile System (`tile-utils.js`, `geojson.js`)
- **Tile fetching**: From MapLibre demo server (zoom 0-6)
- **Overzooming**: Reuse zoom 6 tiles for higher zoom levels
- **VectorTile parsing**: PBF → GeoJSON → Mercator coordinates
- **Caching**: Tiles cached to avoid re-fetching

### 5. Coordinate Transform
- **CPU path** (`utils.js`): `mercatorToClipSpace()`
- **GPU path** (`coordinateGPU.js`): Compute shader batch processing
- **Performance toggle**: Switch between CPU/GPU at runtime

## Data Flow

### Coordinate Systems
1. **Geographic**: Lon/lat from tile data
2. **Mercator**: World coordinates (roughly -1 to 1)
3. **Clip space**: -1 to 1 (GPU rendering)
4. **Screen**: Pixel coordinates for events

### Tile Loading
1. Camera triggers `zoomend` event
2. `getVisibleTiles()` calculates tile coordinates
3. Fetch tiles from server (if not cached)
4. Parse VectorTile PBF format
5. Convert to GeoJSON with `toGeoJSON(x, y, z)`
6. Transform coordinates to Mercator
7. Triangulate polygons with Earcut
8. Create GPU buffers

### Rendering
1. Update camera matrix
2. Write matrix to GPU uniform buffer
3. **Pass 1**: Render to hidden texture (feature IDs)
4. **Pass 2**: Render to screen
   - Sample hidden texture for edge detection
   - Apply zoom-based effects
   - Highlight selected features

## WebGPU Resources

### Buffers
- **Vertex buffers**: Position (vec2) + Color (vec4)
- **Index buffers**: Triangle/line indices
- **Uniform buffers**: Camera matrix, canvas size, picked ID, zoom info

### Textures
- **Hidden texture**: RGBA8 format, stores feature IDs
- **Color texture**: RGBA8 format, intermediate render target

### Pipelines
- **Fill pipeline**: Triangle rendering
- **Outline pipeline**: Line rendering
- **Hidden pipeline**: Feature ID rendering
- **Edge detection pipeline**: Post-process shader

## Performance Optimizations

1. **Tile caching**: Avoid re-fetching/re-parsing tiles
2. **Matrix caching**: Recompute only on position/zoom change
3. **GPU compute**: Batch coordinate transforms (1000+ coords)
4. **Viewport culling**: Only load visible tiles
5. **Pipeline reuse**: Share pipelines across tiles
