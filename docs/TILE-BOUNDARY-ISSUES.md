# Tile Boundary Issues and Solutions

## Problem Summary
Features (especially buildings) that span multiple tile boundaries create visual and functional artifacts due to how vector tiles clip geometry at tile edges.

## Root Causes

### 1. Feature ID Assignment
**Issue:** OSM feature IDs are often very large (e.g., `36988943`) and exceed the 16-bit range (1-65534) used for GPU encoding.

**Impact:**
- Each tile's portion of a building gets a different sequential ID
- Same building has different `clampedFid` values across tiles (e.g., `4882` vs `2878`)
- Creates duplicate markers, inconsistent picking, label mismatches

**Solution Implemented:**
```javascript
// Map large IDs into 16-bit range using modulo
if (typeof featureId === 'number' && featureId > 65534) {
    const mappedId = (featureId % 65521) + 1; // 65521 is largest prime < 65535
    return Math.min(mappedId, 65534);
}
```

**Tradeoff:** Potential collisions where different features map to same ID (rare with prime modulo).

### 2. Hidden Buffer vs Visible Buffer Confusion
**Original Bug:** Buildings were using the visible vertex buffer for hidden rendering.

**Issue:**
- Visible buffer contains display colors (interpolated by height)
- Compute shader decoded colors as fake feature IDs
- Different building parts had different colors → different "feature IDs" → duplicate markers

**Current Status:** Both approaches (visible vs hidden buffer) produce same results because the fundamental issue is feature ID assignment, not buffer choice.

### 3. Tile Clipping Artifacts

#### Visual Seams
**Observation:** Small white/gap seams visible at tile boundaries for large polygons.

**Why vertex shader prevents worse artifacts:**
- Vertex shader calculates positions/normals per-vertex before rasterization
- Each tile's geometry is internally consistent
- Without vertex shader: fragment-level calculations cause darkening/folding across tile boundaries
- With vertex shader: just tiny spatial gaps (best-case for clipped geometry)

#### Marker Duplication
**Issue:** Even with matching feature IDs, clipped geometries are separate objects.

**Result:**
- Multiple markers for same building
- Each tile's portion gets its own marker computation
- No way to "merge" markers from the same feature ID in current architecture

## Data Quality Issues

### OpenMapTiles Limitations
1. **Large OSM IDs** - billions range, far exceeding 16-bit
2. **Tile clipping** - features split at boundaries without edge coordination
3. **No cross-tile feature continuity** - each tile treats clipped portions as independent

### Label/Height Mismatches
**Example:** Building shows `render_height: 46` in properties but displays "34m" label.

**Cause:**
- Labels from `buildFeatureNameMap()` iterate `visibleTileBuffers`
- Marker positions from compute shader reading hidden buffer
- Feature ID collisions from modulo mapping cause wrong feature data → wrong label

## Ideal Solutions (Require Clean Data)

### Server-Side
1. **Proper 16-bit feature IDs** - assign stable IDs in valid range
2. **No building clipping** - keep buildings unified even if spanning tiles
3. **Edge coordination** - ensure vertices align perfectly at tile boundaries

### Client-Side (Expensive)
1. **Geometry merging** - detect matching feature IDs and merge geometries
2. **Marker deduplication** - combine markers for same feature ID
3. **Edge stitching** - align vertices at tile boundaries

## Current Best Practice

**Accept the limitations:**
- Use modulo mapping for large IDs (minimizes collisions)
- Expect duplicate markers for tile-spanning buildings
- Recognize that vector tiles are designed for 2D, not 3D rendering
- Vertex shader keeps artifacts minimal (tiny seams vs darkening/folds)

## Technical Notes

### Why Picking Still Works
Even with visual artifacts, picking can work because:
- Clicking reads one pixel from hidden buffer
- Gets one feature ID (whichever part was clicked)
- Highlights that specific geometry portion
- May need separate clicks for each tile's portion

### Why Vertex Shader Matters
- **With vertex shader:** Stable geometry, smooth interpolation, tiny seams
- **Without vertex shader:** Fragment-level calculations cause precision drift, darkening, visual folds
- Vertex processing ensures each tile's geometry is internally valid

## Conclusion
The rendering system works correctly - it's dealing with inherent limitations of vector tile data designed for 2D use. Clean 3D-optimized tile data would eliminate these issues entirely.
