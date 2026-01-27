# Splatmap Terrain Rendering Design

## Problem Statement

At zoom 14+, polygons need to follow 3D terrain. The current grid-sampling approach has fundamental issues:

1. **Grid resolution vs polygon complexity**: A 32×32 grid can't capture narrow features like ring-shaped lakes
2. **Scaling issues**: Higher resolution (64, 128, 256) is slow and still produces "pixel art" edges
3. **4-vertex polygons**: Many polygons have only 4 vertices but cover large areas with terrain variation inside

## Why Current Approaches Fail

### Grid Sampling (Current)
- Samples terrain at grid intersections
- Only creates triangles where ALL 4 corners are inside polygon
- Narrow rings/holes get missed entirely
- Higher resolution = exponentially slower

### Polygon Subdivision
- Could add interior vertices before triangulation
- But earcut triangulation doesn't guarantee vertices where terrain changes
- Large triangles still "float" over valleys

### Decals
- Projection-based overlay
- Each decal = extra shader work per fragment
- Many overlapping polygons = performance death
- Complex layer ordering

## Solution: Splatmap-Based Terrain Rendering

### Core Concept

**Don't drape polygons onto terrain. Paint polygons onto the terrain mesh.**

The terrain mesh already has vertices everywhere. Instead of building polygon geometry, we:
1. Rasterize polygons to a texture (splatmap)
2. Terrain fragment shader samples splatmap to get color/material
3. One unified terrain mesh handles all geometry

### How It Works

```
Vector Polygon          Splatmap Texture         Terrain Mesh
(4 vertices)            (256×256 pixels)         (32×32 vertices)
                        
┌─────────┐             ┌─────────────┐          Samples splatmap
│         │    ──►      │ ▓▓▓▓▓▓▓▓▓▓ │    ──►   at each fragment
│  PARK   │  Rasterize  │ ▓▓▓▓▓▓▓▓▓▓ │  Render  to get color
│         │             │ ▓▓▓▓▓▓▓▓▓▓ │          
└─────────┘             └─────────────┘          3D terrain with
                                                 park "painted" on
```

### Layer Stacking

Polygons are rasterized in layer order. Later layers overwrite earlier:

```
Layer Order (bottom to top):
1. Background (tan)
2. Park (green, 80% alpha)
3. Water (blue, 60% alpha)

Rasterization:
- Start with background
- Blend park on top
- Blend water on top

Result: Pre-composited RGBA ready for rendering
```

### Data Structures

**Per-tile textures:**

1. **Color Splatmap** (RGBA, 256×256)
   - Pre-composited color from all polygon layers
   - Ready to use in fragment shader
   - Alpha = opacity for blending with terrain

2. **Feature ID Splatmap** (RG, 256×256)
   - R = feature ID low byte
   - G = feature ID high byte
   - For picking/hover detection

### Benefits

| Feature | Before (Polygon Mesh) | After (Splatmap) |
|---------|----------------------|------------------|
| Terrain following | Complex grid sampling | Automatic (it IS terrain) |
| Z-fighting | Constant battle | None |
| Draw calls | Many per tile | 1 per tile |
| Ring/hole polygons | Grid misses narrow areas | Pixel-perfect rasterization |
| Layer blending | Depth buffer fights | Pre-composited alpha |
| Performance | O(polygons × grid²) | O(1) per fragment |
| Feature picking | Per-vertex IDs | Texture lookup |

### What Stays as 3D Geometry

Not everything becomes splatmap. These remain as separate meshes:

- **Buildings** (fill-extrusion): 3D boxes need geometry
- **Roads** (lines): Tube meshes with width
- **Markers**: 3D icons/symbols
- **Labels**: Text rendering

Only **flat fill polygons** (parks, water, landuse) become splatmap.

### Implementation Steps

#### Phase 1: Splatmap Generator
- Create `SplatmapGenerator` class
- Rasterize polygons to RGBA texture
- Handle holes (inner rings)
- Handle alpha blending
- Generate feature ID texture

#### Phase 2: Terrain Shader Modification
- Sample splatmap in fragment shader
- Apply color from splatmap
- Blend with base terrain color
- Apply lighting to splatmap color

#### Phase 3: Feature Picking
- Sample feature ID texture on click
- Look up feature properties
- Apply hover/selection highlighting

#### Phase 4: Integration
- Replace zoom 14+ terrain polygon building
- Route flat fill polygons to splatmap generator
- Keep buildings/roads as geometry

### Splatmap Resolution

| Resolution | Pixels per tile | Quality | Memory |
|------------|-----------------|---------|--------|
| 128×128 | 16K | Low | 64KB |
| 256×256 | 65K | Medium | 256KB |
| 512×512 | 262K | High | 1MB |

Recommendation: **256×256** - good balance of quality and memory

### Polygon Rasterization Algorithm

Classic scanline fill:
1. For each polygon ring (outer + holes)
2. Build edge table (sorted by Y)
3. Scanline from top to bottom
4. Fill pixels between edge intersections
5. Holes: fill with "erase" or previous layer

Can be done on CPU (simple) or GPU compute (faster for many polygons).

### Alpha Blending During Rasterization

```javascript
// For each polygon in layer order:
for (const polygon of polygonsInLayerOrder) {
    for (const pixel of rasterize(polygon)) {
        const src = polygon.color;  // RGBA
        const dst = splatmap[pixel];
        
        // Standard alpha composite
        const outA = src.a + dst.a * (1 - src.a);
        const outR = (src.r * src.a + dst.r * dst.a * (1 - src.a)) / outA;
        const outG = (src.g * src.a + dst.g * dst.a * (1 - src.a)) / outA;
        const outB = (src.b * src.a + dst.b * dst.a * (1 - src.a)) / outA;
        
        splatmap[pixel] = { r: outR, g: outG, b: outB, a: outA };
        featureIdMap[pixel] = polygon.featureId;  // Top-most feature
    }
}
```

### Open Questions

1. **Water effects**: How to apply animated water shader to splatmap regions?
   - Option A: Flag in splatmap (e.g., A channel bit)
   - Option B: Separate water mask texture
   
2. **Dynamic updates**: If user adds/removes features, regenerate splatmap?
   - For static map tiles: regenerate on tile load
   - For user edits: incremental update or full regenerate

3. **Zoom transitions**: How to handle LOD between zoom levels?
   - Each zoom level has its own splatmap
   - Cross-fade during zoom animation

---

## Status

- [x] Phase 1: SplatmapGenerator class - `src/rendering/splatmapGenerator.js`
- [x] Splatmap terrain shader - `src/shaders/splatmapTerrainShader.js`
- [x] TileManager integration - splatmap generation on tile load
- [ ] Phase 2: Create splatmap pipeline and bind groups in renderer
- [ ] Phase 3: Modify renderingUtils to use splatmap pipeline for base terrain
- [ ] Phase 4: Feature picking from splatmap
- [ ] Phase 5: Test and tune at zoom 14+
- [ ] Phase 6: Extend to earlier zoom levels

## Files Modified/Created

1. `src/rendering/splatmapGenerator.js` - NEW: Rasterizes polygons to texture
2. `src/shaders/splatmapTerrainShader.js` - NEW: Shader for splatmap terrain rendering
3. `src/tiles/TileManager.js` - MODIFIED: Generates splatmap on tile load
4. `src/rendering/renderingUtils.js` - TODO: Use splatmap in rendering

## Next Steps

The splatmap is now being generated when tiles load at zoom 14+. The textures are stored in 
`TileManager.tileSplatmaps`. 

To complete the integration:

1. **Create splatmap pipeline** in `renderer.js`:
   - New pipeline with splatmap vertex/fragment shaders
   - Bind group layout with splatmap textures

2. **Update base terrain rendering** in `renderingUtils.js`:
   - For tiles with splatmaps, use splatmap pipeline
   - Pass splatmap textures in bind group
   - Fall back to regular fill for tiles without splatmap

3. **Handle bind group per tile**:
   - Each tile needs its own bind group (different splatmap texture)
   - Create bind group when splatmap is created
   - Store with tile data
