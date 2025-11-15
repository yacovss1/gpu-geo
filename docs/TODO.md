# TODO: Architecture Improvements

## PRIORITY 1: Fix Water Labels (Actual Bug)
**Problem:** Water labels disappear at zoom 7+ when rendered over land due to landuse occlusion

**Solution:** Multi-pass rendering + proper RGBA encoding
1. Implement standardized RGBA vertex encoding:
   - R+G = 16-bit feature ID (0-65535)
   - B = 8-bit layer ID (0-255)
   - A = normalized height (0-1)
   
2. Update compute shaders (Pass 1, 2, 3):
   - Remove hash function hack: `((layerId * 257u) ^ fid) % 65535u`
   - Read layer ID directly from pixel.b
   - Read height directly from pixel.a
   
3. Implement multi-pass rendering in main.js:
   - Pass 1: Render hidden buffer with ONLY symbol layers (water, poi, etc.)
     → Run compute pipeline on this to generate markers
   - Pass 2: Render hidden buffer with ALL layers (including landuse)
     → Use for selection picking and edge detection only
   
4. Validate: Water labels should appear at zoom 7-10 over land

**Estimated complexity:** Medium - well-defined problem with clear solution

---

## PRIORITY 2: Coordinate System Refactor (Optimization)
**Problem:** Inefficient pipeline: CPU (tile parse) → GPU (coordinate transform) → CPU (compute shaders)

**Current flow:**
```
TileManager.parseVectorTile()
  → rawFeature.toGeoJSON(x, y, z)  // Converts tile coords → [lon, lat]
  → geojsonGPU.js 
    → GPU coordinate transformer   // [lon, lat] → Mercator
    → Extract transformed coords   // GPU → CPU readback
    → coordMap lookup in vertex builders
  → Vertex buffers
```

**Proposed flow:**
```
TileManager.parseVectorTile()
  → Parse Protobuf directly with @mapbox/vector-tile
  → transformTileCoords() on CPU  // tile coords → Mercator directly
  → geojsonGPU.js (simplified)
    → No GPU transformer needed
    → Use coords directly
  → Vertex buffers
```

**Complexity factors:**
- Coordinate format expectations (arrays vs objects)
- GeoJSON structure for Point/LineString/Polygon/Multi*
- Earcut triangulation input format
- Vertex buffer packing (x, y, z, r, g, b, a)
- Building extrusion geometry with pre-transformed coords
- Edge cases: empty geometries, invalid coords, extent variations

**Dependencies:**
- Remove toGeoJSON() calls in TileManager
- Create vectorTileParser.js with transformTileCoords()
- Modify geojsonGPU.js: remove GPU transformer, simplify coordinate handling
- Modify geojson.js: remove mercatorToClipSpace(), use coords directly
- Test EVERY geometry type: Point, LineString, Polygon, MultiPoint, MultiLineString, MultiPolygon
- Verify buildings render correctly with extrusions

**Estimated complexity:** HIGH - Many interconnected pieces, subtle format requirements

**Recommendation:** Do AFTER labels are fixed, when you have working tests to validate against

---

## PRIORITY 3: Code Cleanup (Future)
Once labels work and coordinates are refactored:
- Consolidate duplicate code between geojson.js and geojsonGPU.js
- Consider removing GPU path entirely if CPU is fast enough
- Simplify TileManager
- Add unit tests for coordinate transforms


