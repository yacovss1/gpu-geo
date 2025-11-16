# Layer ID Implementation & Rendering Issues

## Summary
Implemented layer ID encoding in hidden buffer blue channel and whitelist filtering in compute shaders. Attempted to fix building marker centering but encountered fundamental architecture limitation.

## Layer ID Encoding Changes

### What Was Implemented
1. **Blue Channel Encoding** (`src/tiles/geojson.js`)
   - Changed from djb2 hash (collision-prone) to array index (deterministic)
   - Blue channel now encodes position in `style.layers` array (0-255)
   - 255 = layer not found

2. **Layer Index Lookup** (`src/core/style.js`)
   ```javascript
   export function getLayerIndex(layerId) {
       const index = currentStyle.layers.findIndex(l => l.id === layerId);
       return index >= 0 ? index : 255;
   }
   ```

3. **Whitelist Filtering** (`src/shaders/computeShaders.js`)
   - Added `FilterConfig` uniform buffer with whitelist array (up to 8 layer indices)
   - Compute shader Pass 1 & 2 check if pixel's layerId is whitelisted before accumulating
   - Allows selective processing of specific layers (e.g., only flat polygons, not 3D walls)

4. **Auto-Whitelist Generation** (`src/rendering/renderingUtils.js`)
   - Scans symbol layers with `text-field` property
   - Extracts their `source-layer` values
   - Finds corresponding fill layers (NOT fill-extrusion)
   - Builds whitelist dynamically each frame

## The Building Marker Problem

### Goal
Center building markers on footprints, not on 3D wall edges/faces.

### Why It Failed
The architecture has a fundamental constraint:

**The "hidden" buffer is NOT actually hidden from the screen!**

1. **Hidden Render Pass** → renders to `renderer.textures.hidden`
2. **Color Render Pass** → renders to `renderer.textures.color` (3D buildings)
3. **Edge Detection Pass** → reads BOTH textures, draws black outlines based on hidden texture feature boundaries

### The Problem
- Edge detection shader draws black borders where feature IDs change in the **hidden texture**
- Changing hidden buffer geometry changes what outlines appear on screen
- When flat base polygons added to hidden buffer → flat outlines show through 3D buildings
- When removed → 3D buildings render correctly but markers on edges

### What Was Attempted
1. **Separate "building" fill layer** - tried to encode flat base with different layer ID than 3D walls
2. **Dual hidden buffers** - tried to add BOTH 3D walls (for edges) AND flat base (for compute)
3. **Complex TileManager logic** - conditionally creating different hidden buffers

All attempts broke visual rendering because edge detection depends on hidden buffer geometry matching visible geometry.

## Current State

### What Works
- ✅ Layer ID encoding (index-based, no collisions)
- ✅ Whitelist infrastructure in place
- ✅ Auto-whitelist from symbol layers
- ✅ 3D buildings render correctly
- ✅ Water/park markers work

### What Doesn't Work
- ❌ Building markers still on edges (can't fix without architecture change)
- ❌ Whitelist doesn't help buildings (3D walls and base have same feature ID)

## Solution Path Forward

To properly fix building marker centering would require:

1. **Separate compute texture** - render flat base polygons to a dedicated texture ONLY for compute shader, independent of edge detection
2. **Decoupled edge detection** - make edge detection use color texture geometry instead of hidden texture
3. **Or accept edge placement** - acknowledge architectural limitation and move on

## Files Modified
- `src/core/style.js` - added `getLayerIndex()`
- `src/tiles/geojson.js` - changed blue channel from hash to index
- `src/shaders/computeShaders.js` - added FilterConfig and whitelist filtering
- `src/rendering/renderingUtils.js` - added whitelist building logic
- `src/tiles/TileManager.js` - attempted hidden buffer changes (REVERT THIS)

## Recommendation
Keep the layer ID encoding and whitelist infrastructure (simple, beneficial). Revert the complex TileManager and geojson.js changes that tried to create separate flat base polygons. Accept that building markers will be on edges until a proper architecture refactor.
