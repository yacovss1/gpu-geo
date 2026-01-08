# MapLibre vs Our Implementation - Full Analysis

## CRITICAL FINDINGS

### 1. MapLibre's Matrix Construction (mercator_transform.ts lines 609-635)

```typescript
// Step 1: Create perspective projection
mat4.perspective(m, fov, width/height, nearZ, farZ);

// Step 2: Apply center offset (for padding/shifting viewport)
m[8] = -offset.x * 2 / width;
m[9] = offset.y * 2 / height;

// Step 3: Y-flip for coordinate system
mat4.scale(m, m, [1, -1, 1]);

// Step 4: Move camera back from origin
mat4.translate(m, m, [0, 0, -cameraToCenterDistance]);

// Step 5: Apply roll
mat4.rotateZ(m, m, -this.rollInRadians);

// Step 6: Apply pitch
mat4.rotateX(m, m, this.pitchInRadians);

// Step 7: Apply bearing
mat4.rotateZ(m, m, -this.bearingInRadians);

// Step 8: Translate to center position (in MERCATOR coordinates [0,1])
mat4.translate(m, m, [-x, -y, 0]);

// Step 9: Scale to worldSize (zoom-dependent)
this._mercatorMatrix = mat4.scale([], m, [worldSize, worldSize, worldSize]);

// Step 10: Scale Z by meters-per-pixel
mat4.scale(m, m, [1, 1, pixelPerMeter]);
```

### 2. Our Implementation (camera.js lines 110-145)

```javascript
// Step 1: Perspective projection
mat4.perspective(matrix, fov, aspectRatio, 1, cameraToCenterDistance * 4);

// Step 2: Y-flip
mat4.scale(matrix, matrix, [1, -1, 1]);

// Step 3: Move camera back
mat4.translate(matrix, matrix, [0, 0, -cameraToCenterDistance]);

// Step 4: Apply pitch
mat4.rotateX(matrix, matrix, pitchRadians);

// Step 5: Apply bearing
mat4.rotateZ(matrix, matrix, -bearingRadians);

// Step 6: Translate to center
mat4.translate(matrix, matrix, [-centerX, -centerY, 0]);

// Step 7: Scale by zoom
mat4.scale(matrix, matrix, [effectiveZoom, effectiveZoom, effectiveZoom]);
```

## KEY DIFFERENCES

### 1. **MISSING: Center Offset Correction**
MapLibre applies center offset IMMEDIATELY after perspective:
```typescript
m[8] = -offset.x * 2 / width;
m[9] = offset.y * 2 / height;
```
**We don't have this** - this is for viewport padding/shifting

### 2. **MISSING: Roll Rotation**
MapLibre applies roll rotation BEFORE pitch:
```typescript
mat4.rotateZ(m, m, -this.rollInRadians);
```
**We don't support roll** - but this is not critical

### 3. **MISSING: Separate mercatorMatrix**
MapLibre creates a separate `_mercatorMatrix` without the Z-scaling:
```typescript
this._mercatorMatrix = mat4.scale([], m, [worldSize, worldSize, worldSize]);
```
Then applies Z-scaling separately:
```typescript
mat4.scale(m, m, [1, 1, pixelPerMeter]);
```

**THIS IS CRITICAL** - Our Z coordinates might be scaled incorrectly!

### 4. **Coordinate System Mismatch**
MapLibre uses:
- Mercator coordinates [0, 1] for the world
- `worldSize = tileSize * 2^zoom` (typically 512 * 2^zoom)
- Building heights in METERS converted via `pixelPerMeter`

We use:
- Clip space [-1, 1] for world
- `effectiveZoom = 2^zoom`
- Building heights in clip units

## TILE COORDINATE TRANSFORMATION

### MapLibre's calculatePosMatrix (lines 413-424):
```typescript
const tileMatrix = calculateTileMatrix(tileID, this.worldSize);
mat4.multiply(tileMatrix, this._viewProjMatrix, tileMatrix);
```

### calculateTileMatrix (mercator_utils.ts lines 75-85):
```typescript
const scale = worldSize / zoomScale(canonical.z);  // zoomScale = 2^z
const unwrappedX = canonical.x + Math.pow(2, canonical.z) * unwrappedTileID.wrap;

mat4.identity(worldMatrix);
mat4.translate(worldMatrix, worldMatrix, [unwrappedX * scale, canonical.y * scale, 0]);
mat4.scale(worldMatrix, worldMatrix, [scale / EXTENT, scale / EXTENT, 1]);
```

**EXTENT = 8192** (tile coordinate range)

So tile coordinates [0, EXTENT] get transformed to world coordinates.

## BUILDING HEIGHT CALCULATION

### MapLibre doesn't directly handle building heights in transform
- Heights are in source data (typically meters)
- Shaders/renderers apply heights using the projection matrix
- The `pixelPerMeter` scaling handles Z differently than XY

### Our Implementation (geojson.js lines 60-69):
```javascript
const tileScaleInClipSpace = Math.pow(2, 1 - zoom);
const metersPerTile = 40075000 / Math.pow(2, zoom);
const visualExaggeration = 1.5;
const zoomExtrusion = (tileScaleInClipSpace / metersPerTile) * visualExaggeration;
```

**PROBLEM**: We're scaling heights in clip space, but camera matrix applies additional scaling!

## ROOT CAUSE ANALYSIS

### Issue 1: Double Scaling of Z
1. We scale building heights by `tileScaleInClipSpace / metersPerTile`
2. Then camera matrix scales by `effectiveZoom` 
3. Result: Heights are scaled by BOTH factors = too tall

### Issue 2: Coordinate System Confusion
- MapLibre: Mercator [0,1] → worldSize → projection
- Us: Clip [-1,1] → zoom scaling → projection
- **Buildings expect one system, camera provides another**

### Issue 3: Missing Per-Tile Matrix
MapLibre calculates a SEPARATE matrix for each tile:
```typescript
calculatePosMatrix(tileID) {
    const tileMatrix = calculateTileMatrix(tileID, worldSize);
    mat4.multiply(tileMatrix, this._viewProjMatrix, tileMatrix);
    return tileMatrix;
}
```

**We apply ONE global camera matrix to all tiles!**

## SOLUTION PATHS

### Option A: Match MapLibre's Coordinate System
1. Switch from clip space [-1,1] to Mercator [0,1]
2. Use worldSize = 512 * 2^zoom
3. Calculate per-tile matrices
4. Apply pixelPerMeter scaling to Z

**PROS**: Would match MapLibre exactly
**CONS**: Major refactor of entire codebase

### Option B: Fix Our Coordinate System
1. Keep clip space [-1,1]
2. Remove zoom scaling from heights
3. Apply heights in WORLD space before camera transform
4. Ensure Z is NOT scaled by camera matrix

**PROS**: Minimal changes
**CONS**: Different from MapLibre, might have other issues

### Option C: Separate XY and Z Scaling
1. Keep current coordinate system
2. Build heights in meters (no zoom scaling)
3. Camera matrix: scale XY by zoom, Z by different factor
4. Match MapLibre's pixelPerMeter approach

**PROS**: Closest to MapLibre's separation of concerns
**CONS**: Requires understanding pixelPerMeter calculation

## IMMEDIATE FIX ATTEMPT

The issue "flat buildings, no render on tilt" suggests:

1. **Flat buildings** = heights are scaled to ZERO or very small
   - Likely: `tileScaleInClipSpace` at high zoom becomes tiny
   - At zoom 15: `2^(1-15) = 2^-14 = 0.000061` 
   - Buildings 10m tall: `0.000061 * 10 / 39000 ≈ 0.00000001` = invisible!

2. **No render on tilt** = vertices are outside frustum
   - Likely: Perspective projection + wrong Z values = clipped
   - Buildings at Z=0 with camera looking down = behind camera

## CORRECT APPROACH

Looking at MapLibre's actual usage:
- Tile vertices are in range [0, EXTENT] (typically [0, 8192])
- TileMatrix transforms [0, EXTENT] → worldSize coordinates
- ViewProjMatrix transforms worldSize → clip space
- Heights are added as Z values in tile space, then transformed

**We should**:
1. Generate vertices in tile space [0, EXTENT] 
2. Create per-tile transformation matrices
3. Let the matrix handle ALL scaling, including Z
