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

## PRIORITY 1: Fix Water Labels (Actual Bug)
**Problem:** Water labels disappear at zoom 7+ when rendered over land due to landuse occlusion

**Solution:** Multi-pass rendering + proper RGBA encoding

**Progress:**
1. ✅ Implement standardized RGBA vertex encoding:
   - R+G = 16-bit feature ID (0-65535) ✅ DONE
   - B = 8-bit layer ID (0-255) ✅ DONE (djb2 hash of layer name)
   - A = normalized height (0-1) ✅ DONE (heightMeters / 300, clamped)
   
2. ✅ Update compute shaders (Pass 1, 2, 3):
   - Remove hash function hack: `((layerId * 257u) ^ fid) % 65535u` ✅ DONE
   - Read layer ID directly from pixel.b ✅ DONE
   - Read height directly from pixel.a ✅ DONE
   - Use feature ID directly as marker index ✅ DONE
   
3. ❌ Implement multi-pass rendering in main.js:
   - Pass 1: Render hidden buffer with ONLY symbol layers (water, poi, etc.)
     → Run compute pipeline on this to generate markers
   - Pass 2: Render hidden buffer with ALL layers (including landuse)
     → Use for selection picking and edge detection only
   
4. ❌ Validate: Water labels should appear at zoom 7-10 over land

**Status:** Phase 1+2 complete (RGBA encoding + hash removal). Phase 3 (multi-pass rendering) not started.

**Estimated complexity:** Medium - well-defined problem with clear solution

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

## PRIORITY 3: Code Cleanup (Future)
Once labels work and coordinates are refactored:
- Consolidate duplicate code between geojson.js and geojsonGPU.js
- Consider removing GPU path entirely if CPU is fast enough
- Simplify TileManager
- Add unit tests for coordinate transforms


