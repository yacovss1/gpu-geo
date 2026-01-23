# TODO: Architecture Improvements

## PRIORITY 0: Per-Viewport Feature ID Assignment (Architecture Limitation)
**Problem:** Current 24-bit feature IDs (16M range) exceed compute shader buffer capacity (65k slots)

**Current Workaround:** Modulo mapping `idx = (layerId * 255) + (fid % 255)` causes collisions
- Multiple features with same (layerId, fid%255) share marker slots
- Results in incorrect marker positioning and multi-feature highlights

**Proper Solution:** Per-viewport ID assignment
- Only assign feature IDs (1-65534) to features visible in current viewport
- Features outside viewport don't need IDs (no markers, no picking)
- Requires viewport culling pass before geometry upload
- Ensures 65k limit is never exceeded for reasonable viewports

**Implementation Steps:**
1. Add viewport frustum culling to tile processing
2. Assign sequential IDs (1-N) only to visible features per frame
3. Maintain feature→ID mapping for picking consistency
4. Clear and regenerate IDs on pan/zoom

**Estimated complexity:** High - requires significant tile processing refactor

**Status:** Not started - current modulo workaround functional but collision-prone

---

## ✅ PRIORITY 1: Fix Water Labels / Label Spam (COMPLETED)
**Problem:** Water labels duplicated ("Lake Lake Lake...") and scattered across tiles

**Root Cause:** Sequential feature IDs broke cross-tile feature merging
- Each tile assigned IDs 1, 2, 3... independently
- Same country/lake in different tiles got different IDs
- MultiPolygon case assigned different ID per polygon (Tunisia bug)

**Solution Implemented:**
1. ✅ Added `getSmartFeatureId()` in geojson.js:
   - Uses tile's `feature.id` when available (best case)
   - Falls back to `promoteId` property lookup
   - Hashes string IDs with murmur3 → 16-bit range
   - Modulo for large numbers with collision warning
   - Sequential fallback only as last resort

2. ✅ Fixed MultiPolygon ID assignment:
   - Changed: `polygonPickingId = getNextFeatureId()` (WRONG)
   - To: `polygonPickingId = clampedFeatureId` (CORRECT)
   - All polygons in MultiPolygon now share same ID

3. ✅ Enhanced label collision detection:
   - Reduced collision threshold from 5 to 3
   - Added text deduplication within 0.04 distance²
   - Hides labels within 0.2 clip units of duplicates

**Testing:** Tunisia (MultiPolygon with islands) now returns consistent featureId=73 across all polygons

**See:** docs/FEATURE-ID-IMPLEMENTATION.md for full technical details

---

## ✅ PRIORITY 2: Coordinate System Refactor (COMPLETED)
**Problem:** Inefficient pipeline: CPU (tile parse) → GPU (coordinate transform) → CPU (compute shaders)

**Status:** COMPLETED - November 2025

**Solution Implemented:**
- Created `vectorTileParser.js` with direct CPU coordinate transformation
- Eliminated GPU roundtrip entirely (6-14x performance improvement)
- Consolidated geojsonGPU.js functionality into geojson.js
- Removed ~2000 lines of obsolete GPU coordinate code
- All geometry types rendering correctly with proper styling

**Results:**
- ✅ Direct Protobuf→Mercator transform on CPU (10 decimal precision)
- ✅ Building extrusions with directional lighting (wall shading by orientation)
- ✅ Roads rendering at all zoom levels with proper filtering
- ✅ Coordinate precision fixed (prevents geometry collapse at high zoom)
- ✅ Single unified code path (no GPU/CPU branching)

**Known Issues:**
- Layer ID encoding in blue channel not implemented (low priority)
- Building outline rendering not implemented (visual preference)
- Water picking causes all water to highlight (separate bug - see Priority 1)

---

## ✅ PRIORITY 3: True 3D Rendering (COMPLETED)
**Problem:** Original renderer used orthographic projection with isometric shear hack for buildings

**Status:** COMPLETED - January 2026

**Solution Implemented:**
- True perspective projection using `mat4.perspective()` with 36.87° FOV
- Camera orbiting via `mat4.lookAt()` - pitch controls viewing angle
- Proper near/far planes (0.1 to 5× camera distance) for depth precision
- Uniform zoom scaling on all axes (no separate Z handling)
- Bearing rotation integrated into view matrix

**Results:**
- ✅ Perspective projection at all pitch values (0° = top-down, 60° = tilted)
- ✅ Buildings rendered with true 3D depth (no isometric shear)
- ✅ Proper depth buffer occlusion
- ✅ Pitch/bearing controls working correctly
- ✅ No Z-overwrite hack in shaders

---

## ✅ PRIORITY 4: GPU Terrain Projection (COMPLETED)
**Problem:** Flat map rendering - no elevation-based terrain

**Status:** COMPLETED - January 2026

**Solution Implemented:**
- AWS Terrain Tiles (Terrarium PNG encoding) loaded via terrainLayer.js
- Terrain atlas combines all visible tiles into single GPU texture
- All shaders sample terrain height in vertex shader for 3D projection
- Effect shaders (water, grass, glass) updated with terrain bindings
- Hillshade overlay renders AFTER vectors with transparency

**Architecture:**
- Bind Group 0: Camera uniform buffer
- Bind Group 1: Terrain (texture + sampler + bounds/exaggeration)
- Height encoding: Terrarium format `(R*256 + G + B/256) - 32768` meters
- Height scale: `height / 50000000.0 * exaggeration` for subtle relief

**Results:**
- ✅ Terrain texture atlas for full viewport coverage
- ✅ All layer types (fills, lines, buildings) project onto terrain
- ✅ Water/grass/glass effects include terrain sampling
- ✅ Hillshade overlay provides visual depth cues
- ✅ UV clamping (0.001-0.999) prevents edge artifacts
- ✅ Height clamping (0-9000m) prevents extreme spikes

---

## PRIORITY 5: Code Cleanup (Future)
- Add unit tests for coordinate transforms
- Simplify TileManager if needed

---

## KNOWN ARCHITECTURAL ISSUES

### 1. Duplicate Terrain Tile Loading (CPU & GPU paths)
**Problem:** Two separate terrain loading systems exist:
- `terrainLayer.js` → Loads tiles into `this.terrainTiles` Map for GPU overlay rendering
- `TileCoordinator.js` → Loads tiles into `this.terrainCache` Map for CPU height baking

**Impact:**
- Same terrain tiles may be loaded twice (memory waste)
- Different tile caches with no sharing
- When terrain overlay disabled, `terrainLayer.terrainTiles` is empty but `TileCoordinator.terrainCache` has tiles

**Why it exists:**
- terrainLayer was built for visible hillshade mesh rendering
- TileCoordinator was added later for CPU-side vertex height baking
- No refactor was done to unify them

**Proper solution:** Share terrain cache between both systems OR load terrain once and route to both

### 2. setExaggeration() API Doesn't Work on Vector Features
**Problem:** `window.mapTerrain.setExaggeration(N)` does NOT affect vector feature heights in real-time

**Root cause:**
- Vector features bake terrain heights at tile parse time (CPU-side in `geojson.js`)
- The baked height uses `TileCoordinator.exaggeration` at parse time
- After parsing, vertex Z values are fixed in GPU buffers
- Changing exaggeration later doesn't re-parse tiles

**When terrain overlay was enabled:** Overlay mesh responded to exaggeration changes, but vectors didn't

**When terrain overlay is disabled (current):**
- `terrainLayer.terrainTiles` is empty (tiles not loaded)
- `buildTerrainAtlas()` returns null
- GPU shader gets `enabled=0`, disabling height sampling
- Even GPU-based height sampling (for z=0 vertices) doesn't work

**Workaround:** Set default exaggeration in `src/core/terrainConfig.js` before app starts

**Proper solution:** Either:
1. Share terrain tiles between terrainLayer and TileCoordinator
2. Trigger full tile reload when exaggeration changes
3. Move ALL height projection to GPU (no CPU baking)

### 3. Tile Boundary Seams with Semi-Transparent Fills
**Problem:** Vector tiles include overlapping buffer zones at edges. With alpha blending, overlaps cause visible seams.

**Current workaround:** Force `alpha = 1.0` in fragment shader (breaks true transparency)

**Proper solutions (not yet implemented):**
1. **Stencil-based rendering:** Render each tile with stencil to prevent double-draw
2. **Hidden buffer merge:** Merge tile boundaries in post-processing
3. **Polygon clipping:** Clip to exact tile bounds (tried, broke rendering)

**Status:** Using alpha=1.0 workaround; transparency solution is PRIORITY TODO

### 4. CPU vs GPU Height Projection Split
**Problem:** Some geometry gets CPU-baked heights, some gets GPU-sampled heights

**Current behavior:**
- **Roads/Lines:** CPU bakes terrain height at centerline, stored in vertex Z
- **Fills/Polygons:** Vertex Z=0, GPU samples terrain at runtime

**Why:**
- Roads need consistent height along width (left/right edges at same elevation)
- CPU baking samples once at centerline, applies to all vertices
- GPU sampling would give different heights for left vs right edges

**Issue:** If terrain overlay disabled, GPU sampling doesn't work (enabled=0), so fills stay flat

**This is by design** but confusing. The shader checks `if (abs(inPosition.z) < 0.0000001)` to decide CPU vs GPU path.

