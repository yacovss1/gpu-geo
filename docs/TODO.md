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

## PRIORITY 4: Code Cleanup (Future)
- Add unit tests for coordinate transforms
- Simplify TileManager if needed


