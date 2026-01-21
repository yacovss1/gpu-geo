# Architecture

WebGPU-based vector map renderer with true 3D perspective projection and GPU terrain projection.

## File Structure

```
src/
├── core/
│   ├── camera.js          # 3D camera with perspective/lookAt
│   ├── style.js           # Mapbox style spec parser & evaluator
│   ├── styleManager.js    # Style loading, tile source config
│   ├── events.js          # Mouse/keyboard input handling
│   ├── webgpu-init.js     # WebGPU device & context setup
│   ├── bufferUtils.js     # GPU buffer creation helpers
│   ├── utils.js           # General utilities
│   ├── performance.js     # Timing & profiling
│   └── shaderEffectManager.js  # Shader effect pipeline (water, glass, grass)
│
├── tiles/
│   ├── TileManager.js     # Tile loading, caching, lifecycle
│   ├── tileCache.js       # LRU tile cache
│   ├── vectorTileParser.js # Protobuf → geometry (coordinate transform)
│   ├── geojson.js         # Feature processing, ID assignment, extrusion
│   ├── tile-utils.js      # Tile coordinate math
│   ├── line-tessellation.js      # Road/line width expansion
│   └── line-tessellation-simple.js
│
├── rendering/
│   ├── renderer.js        # Main render loop, pass orchestration
│   ├── renderingUtils.js  # Draw call helpers
│   ├── terrainLayer.js    # Terrain tile loading, atlas, hillshade
│   ├── labelManager.js    # Text label placement
│   ├── markerPipeline.js  # Point marker rendering
│   ├── markerCompute.js   # Marker position compute shader
│   └── tubePipeline.js    # 3D tube rendering
│
├── text/
│   ├── gpuTextRenderer.js # GPU text atlas & rendering
│   └── labelCollisionDetector.js  # Label overlap prevention
│
└── shaders/
    ├── shaders.js         # Main geometry shaders (with terrain sampling)
    ├── terrainShaders.js  # Terrain mesh & hillshade shaders
    ├── textShaders.js     # Text rendering shaders
    ├── markerShader.js    # Point marker shaders
    ├── tubeShaders.js     # Tube shaders
    ├── computeShaders.js  # Compute shaders
    ├── effectShaders.js   # Post-processing effects
    └── effects/           # Water, glass, grass effects (with terrain)
```

## Data Flow

```
Style JSON (Mapbox spec v8)
    ↓
styleManager.js → parses layers, sources, expressions
    ↓
TileManager.js → fetches .pbf tiles for visible area
    ↓
vectorTileParser.js → Protobuf decode, tile coords → Mercator clip space
    ↓
geojson.js → Feature processing:
    • getSmartFeatureId() → 16-bit ID assignment
    • Building extrusion (height/min_height)
    • Polygon triangulation (earcut)
    • Line tessellation (road widths)
    ↓
GPU Buffers → positions, colors, feature IDs
    ↓
renderer.js → Two-pass rendering:
    1. Hidden pass → feature IDs to pick buffer
    2. Visible pass → final colors to screen
    ↓
camera.js → Perspective matrix (lookAt + projection)
    ↓
Screen
```

## Coordinate System

**Mercator Clip Space**: All geometry in range [-1, 1]
- X: `longitude / 180`
- Y: `-log(tan(π/4 + lat*π/360)) / π`

**Tile Coordinates**: 0-4096 (extent) per tile, transformed to clip space by `vectorTileParser.js`

**Building Heights**: Meters → clip space units via `zoomExtrusion` factor

## Camera System

True 3D perspective using `gl-matrix`:

```javascript
// Projection
mat4.perspective(proj, fov, aspectRatio, nearZ, farZ);

// View (camera orbits based on pitch)
const camY = distance * sin(pitch);
const camZ = distance * cos(pitch);
mat4.lookAt(view, [0, camY, camZ], [0,0,0], [upX, upY, upZ]);

// World transform
mat4.rotateZ(view, bearing);
mat4.scale(view, effectiveZoom);
mat4.translate(view, -position);

// Final
matrix = proj * view;
```

**Controls:**
- Scroll: Zoom
- Drag: Pan
- Right-drag: Pitch + Bearing
- Shift+drag: Bearing only

## Feature ID System

16-bit IDs encoded in hidden buffer (red+green channels):

```
ID Strategy Priority:
1. feature.id (if 1-65534)
2. promoteId property lookup
3. String hash (murmur3) → 16-bit
4. Large number modulo (collision risk)
5. Sequential fallback (no cross-tile merging)
```

See `FEATURE-ID-IMPLEMENTATION.md` for details.

## Style Evaluation

Supports Mapbox Style Spec v8:

**Expressions:** `["interpolate", ["linear"], ["zoom"], 10, 1, 15, 5]`

**Legacy zoom functions:** `{"base": 1.2, "stops": [[12, "#fff"], [16, "#ccc"]]}`

**Colors:** hex, rgb(), rgba(), hsl(), hsla()

**Filters:** `["==", ["get", "class"], "residential"]`

## Rendering Pipeline

### Hidden Pass (Picking)
- Renders feature IDs to offscreen texture
- Red+Green = 16-bit feature ID
- Blue = layer ID (0-255)
- Used for click detection, highlighting

### Visible Pass
- Renders styled geometry to screen
- Applies colors, patterns, effects
- Respects layer ordering from style

### Depth Buffer
- Enabled for 3D occlusion
- Buildings occlude each other correctly
- Near/far planes: 0.1× to 5× camera distance

## Key Functions

| Function | File | Purpose |
|----------|------|---------|
| `getSmartFeatureId()` | geojson.js | Consistent ID across tiles |
| `parseGeoJSONFeature()` | geojson.js | Feature → triangulated geometry |
| `transformTileCoords()` | vectorTileParser.js | Tile → Mercator clip space |
| `evaluateExpression()` | style.js | Mapbox expression evaluation |
| `_buildPerspectiveMatrix()` | camera.js | 3D projection matrix |
| `render()` | renderer.js | Frame render orchestration |

## Dependencies

- **pbf**: Protobuf decoding for .pbf tiles
- **earcut**: Polygon triangulation
- **gl-matrix**: Matrix math (mat4, vec3)
- **@plandex/vt-pbf** (or similar): Vector tile parsing

## Known Limitations

1. **65k feature limit**: Compute shader buffers limited to 65k slots
2. **No layer ID encoding**: Blue channel reserved but unused
3. **Water picking**: All water highlights together (shared class)
4. **Style expressions**: Not all Mapbox expressions implemented

## Terrain System

GPU-based terrain projection using AWS Terrain Tiles (Terrarium encoding).

### Architecture

```
Terrain Tiles (.png, Terrarium encoded)
    ↓
terrainLayer.js → Loads terrain tiles, builds texture atlas
    ↓
Terrain Atlas Texture (combined visible tiles)
    ↓
Bind Group 1 (shared by all shaders):
├── @binding(0) terrainTexture
├── @binding(1) terrainSampler  
└── @binding(2) terrainBounds (minX, minY, maxX, maxY, exaggeration, enabled)
    ↓
Vertex Shaders → Sample terrain height at each vertex position
    ↓
Position.z += terrainHeight → 3D terrain projection
```

### Terrain Atlas

Multiple terrain tiles are combined into a single atlas texture:

1. **`buildTerrainAtlas()`** - Combines visible tiles via `copyTextureToTexture`
2. **Combined bounds** - Atlas covers full viewport (minX/minY/maxX/maxY)
3. **Single sample** - Vectors sample once from atlas, not per-tile

### Height Encoding (Terrarium)

```javascript
height = (R * 256 + G + B / 256) - 32768  // meters
```

### Shader Integration

All layer types sample terrain in vertex shader:

```wgsl
fn sampleTerrainHeight(clipX: f32, clipY: f32) -> f32 {
    let u = (clipX - bounds.minX) / (bounds.maxX - bounds.minX);
    let v = 1.0 - (clipY - bounds.minY) / (bounds.maxY - bounds.minY);
    let pixel = textureSampleLevel(terrainTexture, terrainSampler, uv, 0.0);
    let height = decodeTerrarium(pixel);
    return (height / 50000000.0) * exaggeration;
}
```

### Hillshade Overlay

Terrain mesh renders AFTER vectors with transparent hillshade:
- Dark shadows on slopes facing away from light
- Light highlights on slopes facing toward light
- Neutral areas fully transparent (discard)
- `depthCompare: 'always'` - renders on top as overlay
