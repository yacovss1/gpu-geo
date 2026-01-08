# True 3D Implementation Plan

## Current System Understanding

### Coordinate Flow

```
VectorTile (tile-local 0-4096)
    ↓
transformTileCoords() in vectorTileParser.js
    ↓
Mercator Clip Space (X: -1 to 1, Y: ~-1 to 1)
    ↓
Building heights added as Z (in clip space units via zoomExtrusion)
    ↓
Vertex buffer: [X, Y, Z] in clip space
    ↓
Shader: uniforms * vec4(X, Y, Z, 1.0)
    ↓
Shader OVERWRITES Z: output.position.z = 0.5 - inPosition.z * 100.0
    ↓
Screen
```

### Key Values

**World Coordinates**: Mercator clip space [-1, 1]
- X: lon/180 (so -180° → -1, 180° → 1)
- Y: -log(tan(π/4 + lat*π/360)) / π

**Building Heights (geojson.js lines 60-69)**:
```javascript
const tileScaleInClipSpace = Math.pow(2, 1 - zoom);  // Tile size in clip units
const metersPerTile = 40075000 / Math.pow(2, zoom);  // Meters per tile
const metersToClipSpace = tileScaleInClipSpace / metersPerTile;
const visualExaggeration = 3;
const zoomExtrusion = metersToClipSpace * visualExaggeration;
// Example at zoom 14: zoomExtrusion ≈ 3e-8 (TINY!)
```

**Camera Matrix (camera.js)**:
- scale(effectiveZoom/aspect, effectiveZoom, 1.0)
- rotateZ(bearing)
- translate(-camX, -camY, 0)
- shear matrix (Z affects Y for isometric)

### The Fundamental Problem

The shader line `output.position.z = 0.5 - inPosition.z * 100.0` completely ignores the matrix's Z output. This works for orthographic (we don't care about Z after transform), but **breaks perspective projection** because:

1. Perspective requires Z for the W divide (depth → size reduction)
2. By overwriting Z, we lose all perspective information
3. The matrix's Z calculations become meaningless

---

## MapLibre's System

### Coordinate Flow

```
VectorTile (tile-local 0-EXTENT, EXTENT=8192)
    ↓
Per-tile matrix: calculatePosMatrix(tileID)
    ↓
World pixel coordinates (0 to worldSize, worldSize = 512 * 2^zoom)
    ↓
ViewProjMatrix transforms to clip space
    ↓
Building heights scaled by pixelsPerMeter
    ↓
GPU: result = projMatrix * viewMatrix * tileMatrix * vertex
    ↓
Screen
```

### Key Functions

**_calcMatrices() in mercator_transform.ts**:
```typescript
// 1. Perspective projection
mat4.perspective(m, fov, width/height, nearZ, farZ);

// 2. Flip Y for GL
mat4.scale(m, m, [1, -1, 1]);

// 3. Position camera back from center
mat4.translate(m, m, [0, 0, -cameraToCenterDistance]);

// 4. Apply rotations
mat4.rotateZ(m, m, -rollInRadians);
mat4.rotateX(m, m, pitchInRadians);  // POSITIVE pitch!
mat4.rotateZ(m, m, -bearingInRadians);

// 5. Translate to world position
mat4.translate(m, m, [-x, -y, 0]);

// 6. Create mercator matrix (scales to worldSize)
this._mercatorMatrix = mat4.scale([], m, [worldSize, worldSize, worldSize]);

// 7. Scale Z by pixels per meter
mat4.scale(m, m, [1, 1, pixelPerMeter]);
```

**Key Values**:
- `worldSize = 512 * 2^zoom` (at zoom 0: 512, at zoom 14: 8,388,608)
- `cameraToCenterDistance = (height/2) / tan(fov/2)`
- `pixelsPerMeter` varies by latitude

---

## Why Our Perspective Attempts Failed

### Attempt 1: Just add mat4.perspective()
**Problem**: Our coordinates are in clip space [-1,1], not world space. The perspective projection expects coordinates at reasonable distances from the camera, not already in clip range.

### Attempt 2: Adjust near/far planes
**Problem**: Still overwriting Z in shader with depth bias.

### Attempt 3: Remove Z overwrite
**Problem**: Orthographic mode then broke because it relied on the fixed Z for depth ordering.

### Attempt 4: Copy MapLibre's exact matrix order
**Problem**: Coordinate systems don't match. MapLibre uses worldSize pixels, we use clip space. The math doesn't translate directly.

---

## Correct Implementation Path

### Option A: Full MapLibre-Compatible Refactor (Recommended)

1. **Change coordinate system to world pixels**:
   - Instead of clip space [-1,1], use [0, worldSize]
   - worldSize = 512 * 2^zoom (or simplified: just use effectiveZoom as worldSize)

2. **Per-tile matrices**:
   - Each tile gets its own posMatrix
   - Tile vertices stay in local space [0, EXTENT]
   - Matrix transforms tile→world→clip

3. **Proper Z handling**:
   - Heights in meters from data
   - Convert to world units via pixelsPerMeter
   - Let the projection matrix handle depth

4. **Shader changes**:
   - Remove the Z overwrite hack
   - Use proper depth buffer for ordering
   - Enable depth test with LESS comparison

5. **Camera changes**:
   - Implement cameraToCenterDistance calculation
   - Proper near/far plane computation
   - pixelsPerMeter for latitude

### Option B: Minimal Fix (Compromise)

Keep current coordinate system but:

1. **Add a camera mode uniform** to shader:
   ```wgsl
   @group(0) @binding(1) var<uniform> cameraMode: u32; // 0=ortho, 1=perspective
   
   if (cameraMode == 0u) {
       // Orthographic: use fixed depth for ordering
       output.position.z = 0.5 - inPosition.z * 100.0;
   } else {
       // Perspective: preserve matrix Z for depth
       // Just apply small bias for building ordering
       output.position.z = output.position.z - inPosition.z * 0.001;
   }
   ```

2. **Scale building heights differently for perspective**:
   - In perspective, heights should be in world units, not clip units
   - Apply height scaling in the matrix, not in geometry generation

3. **Fix the perspective matrix**:
   - Don't scale by effectiveZoom in perspective mode
   - Use camera distance + FOV to achieve zoom effect

---

## Recommended Next Steps

1. **Document the current working state** (orthographic + isometric shear)
2. **Create a branch for 3D experimentation**
3. **Start with Option B** (minimal fix) to validate the approach
4. **If Option B works**, consider full refactor (Option A) later

---

## Critical Insight from MapLibre

The key realization: **MapLibre separates XY scaling from Z scaling**.

```typescript
// XY scaled by worldSize (for zoom)
this._mercatorMatrix = mat4.scale([], m, [worldSize, worldSize, worldSize]);

// Z scaled by pixelsPerMeter (for building heights)
mat4.scale(m, m, [1, 1, pixelPerMeter]);
```

Our current approach scales XY by `effectiveZoom` but Z by `1.0`. This is correct for isometric but wrong for perspective because buildings need to be visible at the camera distance, not in clip space.

For true 3D, we need:
- XY in world coordinates that the perspective matrix can project
- Z in consistent world units (meters → pixels → clip space)
- The perspective matrix handles the "shrinking with distance" effect
