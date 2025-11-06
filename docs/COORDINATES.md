# Coordinate Systems

Understanding how coordinates flow through the rendering pipeline.

## Coordinate System Hierarchy

### 1. Geographic Coordinates (Lon/Lat)
**Source**: VectorTile data from server

```javascript
// Example: San Francisco
lon: -122.4194   // Longitude [-180, 180]
lat: 37.7749     // Latitude [-90, 90]
```

**Usage**: Raw tile data, user input (future)

### 2. Mercator World Coordinates
**Purpose**: Intermediate calculation space

```javascript
mercatorToClipSpace([lon, lat]) {
  const x = lon / 180;
  const y = -Math.log(Math.tan(Math.PI/4 + (Math.PI/180) * lat / 2)) / Math.PI;
  return [x, y];
}
```

**Range**: 
- X: roughly [-1, 1] (wraps around world)
- Y: roughly [-1, 1] (clamped near poles)

**Usage**: Camera position, tile positioning, world bounds

### 3. Clip Space
**Purpose**: GPU rendering coordinates

```javascript
// After camera matrix multiplication
output.position = uniforms * vec4(worldX, worldY, 0.0, 1.0);
```

**Range**: [-1, 1] in both X and Y
- (-1, -1) = bottom-left of screen
- (1, 1) = top-right of screen

**Usage**: Vertex shader output, GPU rasterization

### 4. Screen Space
**Purpose**: Mouse events, pixel-perfect operations

```javascript
// Normalized (0-1)
screenX = (event.clientX - rect.left) / rect.width;
screenY = (event.clientY - rect.top) / rect.height;

// Pixel coordinates
pixelX = screenX * canvas.width;
pixelY = screenY * canvas.height;
```

**Usage**: Mouse tracking, click detection, UI

## Conversion Functions

### Geographic → Mercator

```javascript
// In utils.js
export function mercatorToClipSpace(coord) {
  const [lon, lat] = coord;
  const x = lon / 180;
  const y = -Math.log(Math.tan(Math.PI/4 + (Math.PI/180)*lat/2)) / Math.PI;
  return [x, y];
}
```

### Screen → Clip Space

```javascript
// In camera.js zoom calculations
const mouseClipX = this.mouseScreenX * 2 - 1;
const mouseClipY = this.mouseScreenY * 2 - 1;
```

### Clip → World Space

```javascript
// Reverse of camera transform
const effectiveZoom = Math.pow(2, this.zoom);
const aspectRatio = this.viewportWidth / this.viewportHeight;

const worldX = cameraX + (clipX * aspectRatio) / effectiveZoom;
const worldY = cameraY + clipY / effectiveZoom;
```

## Tile Coordinate System

Tiles use a different coordinate system:

```javascript
// For zoom level z, tile at (x, y):
const scale = 1 << z;  // 2^z tiles per axis
const worldX = x / scale;
const worldY = y / scale;
```

**Example at zoom 0**:
- Single tile (0, 0) covers entire world
- World bounds: [0, 1] × [0, 1]

**Example at zoom 6**:
- 64 × 64 = 4,096 tiles
- Each tile covers 1/64 of world axis

### World → Tile Conversion

```javascript
function worldToTile(worldX, worldY, zoom) {
  // Convert Mercator world coords to lon/lat
  let lon = ((worldX * 180) % 360 + 540) % 360 - 180;
  const latRadian = Math.atan(Math.sinh(Math.PI * -worldY));
  let lat = latRadian * 180 / Math.PI;
  
  // Clamp latitude (Mercator projection limits)
  lat = Math.max(-85, Math.min(85, lat));
  
  // Standard Web Mercator tile formula
  const scale = 1 << zoom;
  const tileX = ((lon + 180) / 360) * scale;
  const tileY = ((1 - Math.log(Math.tan((lat * Math.PI / 180) / 2 + Math.PI/4)) / Math.PI) / 2) * scale;
  
  return [tileX, tileY];
}
```

## VectorTile Coordinates

Tiles contain features in local tile space:

```javascript
// VectorTile extent (usually 4096)
const extent = tile.layers[layerName].extent;

// Feature coordinates are integers [0, extent]
feature.geometry = [[x, y], [x2, y2], ...];
```

**Converting to world coordinates**:

The `@mapbox/vector-tile` library's `toGeoJSON(x, y, z)` handles this:

```javascript
// Converts tile-local coords → lon/lat based on tile position
const feature = layer.feature(i).toGeoJSON(tileX, tileY, zoom);
// Then mercatorToClipSpace() → Mercator world coords
```

## Coordinate Flow Example

**Loading a tile at zoom 6, tile (32, 32)**:

1. **Fetch**: Get tile data from `https://demotiles.maplibre.org/tiles/6/32/32.pbf`
2. **Parse**: VectorTile with features in local space [0, 4096]
3. **Convert**: `toGeoJSON(32, 32, 6)` → lon/lat coordinates
4. **Transform**: `mercatorToClipSpace()` → Mercator world coords (e.g., [0.5, -0.2])
5. **Store**: Vertex buffer with world coordinates
6. **Render**: Camera matrix transforms to clip space for GPU

**Zoom-to-mouse calculation**:

1. **Mouse event**: clientX=500, clientY=300
2. **Normalize**: screenX=0.5, screenY=0.3
3. **Clip space**: clipX=0.0, clipY=-0.4
4. **World space**: worldX = camera.x + (0.0 * aspect) / effectiveZoom
5. **Stay fixed**: After zoom, reposition camera so worldX stays at clipX=0.0

## Aspect Ratio Handling

**Why aspect matters**: Screen isn't square!

```javascript
const aspectRatio = viewportWidth / viewportHeight;

// Matrix scales X differently to maintain square pixels
mat4.scale(matrix, [effectiveZoom / aspectRatio, effectiveZoom, 1]);
```

**Example (1920×1080 screen)**:
- aspectRatio = 1920/1080 = 1.778
- X scaled by: zoom / 1.778 (less zoom in X)
- Y scaled by: zoom (full zoom in Y)
- Result: 1 world unit = same pixel size in X and Y

## Common Pitfalls

❌ **Don't mix raw zoom with effective zoom**:
```javascript
// Wrong
const offset = mouseClip / this.zoom;  // zoom=6, dividing by 6

// Correct
const effectiveZoom = Math.pow(2, this.zoom);  // 2^6 = 64
const offset = mouseClip / effectiveZoom;  // dividing by 64
```

❌ **Don't forget aspect ratio**:
```javascript
// Wrong
const worldX = cameraX + clipX / effectiveZoom;

// Correct (X is affected by aspect)
const worldX = cameraX + (clipX * aspectRatio) / effectiveZoom;
```

❌ **Don't assume tile coords = world coords**:
- Tile coordinates need conversion via `toGeoJSON(x, y, z)`
- World coordinates are in Mercator projection space
