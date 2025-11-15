# Tile Parser Inventory & Refactor Plan

## Current Files Analysis

### geojsonGPU.js (~1364 lines)

**KEEP (Core Logic):**
- Style layer matching & filtering (lines 36-92)
- Feature ID extraction from style (lines 93-116)
- Extrusion geometry generation (lines 186-234, 893-1108)
  - `generateExtrusion()` - creates walls + roof triangles
  - Roof tessellation with earcut
  - Wall quad generation
- Line tessellation (uses `tessellateLine`)
- Vertex/index buffer building
- earcut triangulation for polygons
- Hidden buffer vertex encoding (needs fixing for consistency)

**DELETE (Replace with direct parsing):**
- `getGlobalCoordinateTransformer()` import (line 6)
- GPU batch coordinate transformation (lines 118-142, 583-615)
- `transformer.transform()` calls throughout
- `getTransformedCoord()` closures that call GPU transformer

**FIX (Encoding Inconsistency):**
- `coordsToIdVertices()` - currently uses B=layerID, A=1.0 (flat features)
- Building extrusion uses B=height, A=1.0 (line 1090)
- Need to standardize: B=layerID, A=height for ALL

---

### geojson.js (~755 lines)

**KEEP (Fallback/Validation):**
- Style layer matching logic (similar to GPU version)
- `mercatorToClipSpace()` - useful reference for projection math
- Line width calculation logic
- Feature filtering

**DELETE (Redundant with GPU version):**
- Entire CPU coordinate transformation
- Duplicate extrusion logic (consolidate with GPU version)
- `coordsToIdVertices()` - inconsistent encoding (B=0.0 always)

**FIX:**
- Hidden buffer encoding uses B=0.0 (no layer ID!)
- No height encoding at all

---

## Dependencies to Remove

**togeojson/togeojson.ts:**
- Currently converts Protobuf → GeoJSON (EPSG:4326)
- Adds unnecessary lon/lat conversion step
- **Replace with:** `@mapbox/vector-tile` for direct Protobuf parsing

**coordinateGPU.js:**
- GPU batch coordinate transformation
- **Replace with:** Simple CPU math (tile-local → world → clip)
- Formula: `worldX = (tileX + localX/extent) * tileSize / worldSize`

---

## What Actually Needs to Stay

### 1. Geometry Processing (CPU)
```javascript
// Keep and consolidate
- Polygon triangulation (earcut)
- Line tessellation (screenWidthToWorld, tessellateLine)  
- Building extrusion (walls + roof generation)
- Coordinate clamping/validation
```

### 2. Style Integration
```javascript
// Keep
- Layer matching by source-layer
- Filter evaluation
- Paint property extraction (colors, heights, widths)
- Feature ID extraction from style promoteId
```

### 3. Buffer Building
```javascript
// Keep
- Vertex array construction
- Index array construction  
- Interleaved vertex format (pos + color/id)
- GPU buffer creation via device.createBuffer()
```

### 4. Hidden Buffer Encoding
```javascript
// Keep but FIX
- Feature ID → R+G (16-bit)
- Layer ID → B (8-bit) ← FIX: currently inconsistent
- Height → A (normalized) ← FIX: currently unused
```

---

## New Architecture Plan

### Phase 1: Direct Protobuf Parser
```javascript
// NEW FILE: src/tiles/vectorTileParser.js

import { VectorTile } from '@mapbox/vector-tile';
import Protobuf from 'pbf';

export function parseVectorTile(buffer, z, x, y, device, camera) {
    const tile = new VectorTile(new Protobuf(buffer));
    const features = [];
    
    for (const layerName in tile.layers) {
        const layer = tile.layers[layerName];
        
        for (let i = 0; i < layer.length; i++) {
            const vt_feature = layer.feature(i);
            const geometry = vt_feature.loadGeometry(); // tile-local coords
            
            // Simple transform: tile → world → clip (CPU)
            const transformed = transformTileCoords(geometry, z, x, y, camera);
            
            // Process based on type
            const processed = processFeature(vt_feature, transformed, layerName, z);
            if (processed) features.push(processed);
        }
    }
    
    return features;
}

function transformTileCoords(geometry, z, x, y, camera) {
    const extent = 4096; // MVT standard
    const scale = 1 / (extent * Math.pow(2, z));
    
    return geometry.map(ring => 
        ring.map(([localX, localY]) => {
            // Tile-local → world coordinates
            const worldX = (x + localX / extent) * scale;
            const worldY = (y + localY / extent) * scale;
            
            // World → clip space (apply camera transform)
            return camera.worldToClip(worldX, worldY);
        })
    );
}
```

### Phase 2: Unified Geometry Processor
```javascript
// NEW FILE: src/tiles/geometryProcessor.js

export function processFeature(vt_feature, coords, layerName, zoom) {
    const type = vt_feature.type; // 1=Point, 2=LineString, 3=Polygon
    const properties = vt_feature.properties;
    
    // Get style for this layer
    const style = getStyleForLayer(layerName);
    const featureId = extractFeatureId(vt_feature, style);
    const layerId = hashLayerName(layerName);
    
    switch (type) {
        case 3: // Polygon
            if (style.type === 'fill-extrusion') {
                return processExtrusion(coords, properties, featureId, layerId, style, zoom);
            } else {
                return processFlatPolygon(coords, featureId, layerId, style);
            }
        case 2: // LineString
            return processLine(coords, featureId, layerId, style, zoom);
        case 1: // Point
            return processPoint(coords, featureId, layerId, style);
    }
}
```

### Phase 3: Standardized Encoding
```javascript
// NEW FILE: src/tiles/vertexEncoding.js

const MAX_HEIGHT = 300; // meters, for normalization

export function encodeHiddenVertex(x, y, z, featureId, layerId, height = 0) {
    // Feature ID: 16-bit across R+G
    const r = ((featureId >> 8) & 0xFF) / 255.0;  // High byte
    const g = (featureId & 0xFF) / 255.0;         // Low byte
    
    // Layer ID: 8-bit in B
    const b = (layerId & 0xFF) / 255.0;
    
    // Height: normalized in A
    const a = Math.min(1.0, Math.max(0.0, height / MAX_HEIGHT));
    
    return [x, y, z, r, g, b, a]; // 7 floats per vertex
}

export function encodeVisibleVertex(x, y, z, color) {
    return [x, y, z, ...color]; // [x, y, z, r, g, b, a]
}
```

---

## Migration Steps

1. ✅ **Create inventory** (this document)
2. ⏳ **Add @mapbox/vector-tile dependency**
3. ⏳ **Implement vectorTileParser.js** (direct Protobuf parsing)
4. ⏳ **Extract & consolidate extrusion code** from both files
5. ⏳ **Create vertexEncoding.js** (standardized RGBA encoding)
6. ⏳ **Update TileManager** to use new parser
7. ⏳ **Remove togeojson dependency**
8. ⏳ **Remove coordinateGPU.js**
9. ⏳ **Delete geojson.js and geojsonGPU.js**
10. ⏳ **Update compute shaders** to read layerID+height from B+A
11. ⏳ **Implement multi-pass rendering**
12. ⏳ **Test everything**

---

## Expected Benefits

- **Simpler**: Single code path, no CPU/GPU ping-pong
- **Faster**: No unnecessary coordinate conversions
- **Maintainable**: Clear separation of concerns
- **Correct**: Consistent encoding enables proper label positioning
- **Scalable**: Easy to add new feature types

---

## Risk Mitigation

- Keep old files during migration
- Test each phase independently
- Fallback to old code if issues arise
- Incremental feature migration (water → buildings → roads)
