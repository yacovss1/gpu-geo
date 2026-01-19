# Feature ID Implementation

## Overview

Feature IDs are critical for:
1. **Picking** - Click detection identifies which feature was clicked
2. **Highlighting** - Shader highlights features by ID
3. **Label Deduplication** - Same feature across tiles gets one label
4. **Feature Merging** - Compute shader merges geometry by ID

## The 16-bit Constraint

GPU picking uses a hidden buffer where feature IDs are encoded in the red+green channels:
- **Red channel**: High byte (bits 8-15)
- **Green channel**: Low byte (bits 0-7)
- **Valid range**: 1-65534 (16-bit, avoiding 0 and 65535)

## ID Assignment Strategies

### 1. Direct `feature.id` from Tile (PREFERRED)

```javascript
// Best case: tile has proper numeric ID
if (typeof feature.id === 'number' && feature.id >= 1 && feature.id <= 65534) {
    return feature.id;
}
```

**Works with:**
- MapLibre demo tiles (countries have IDs like Tunisia=73, France=22)
- MapTiler tiles with proper ID assignment
- Custom tilesets generated with `tippecanoe --generate-ids`

**Fails with:**
- OpenFreeMap/OSM tiles (IDs are OSM node/way IDs in billions)
- Tiles without feature.id

### 2. promoteId (MapLibre Compatible)

Use a feature property as the ID:

```json
{
  "sources": {
    "openmaptiles": {
      "type": "vector",
      "url": "...",
      "promoteId": "osm_id"
    }
  }
}
```

Or per source-layer:
```json
"promoteId": {
  "buildings": "building_id",
  "roads": "road_id"
}
```

**Implementation:**
```javascript
const promoteId = getSourcePromoteId(sourceId);
if (promoteId && feature.properties?.[promoteId]) {
    rawId = feature.properties[promoteId];
}
```

### 3. String Hash (murmur3)

For string IDs, hash to 16-bit range:
```javascript
function murmur3Hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h) + str.charCodeAt(i);
        h = h & h;
    }
    return Math.abs(h);
}
// Map to 1-65534
const id = ((hash % 65533) + 1);
```

### 4. Large Number Modulo

For IDs > 65534, use modulo to fit:
```javascript
const id = ((Math.abs(Math.floor(rawId) - 1) % 65533) + 1);
```

**Warning:** This can cause collisions (different features get same ID).

### 5. Sequential Fallback

When all else fails, assign sequential IDs:
```javascript
let globalFeatureIdCounter = 1;
function getNextFeatureId() {
    const id = globalFeatureIdCounter++;
    if (globalFeatureIdCounter > 65534) globalFeatureIdCounter = 1;
    return id;
}
```

**Problem:** IDs differ across tiles, so same feature in different tiles gets different IDs → no merging, duplicate labels.

## Critical Bug Fixed: MultiPolygon ID Assignment

### The Problem

Countries like Tunisia have MultiPolygon geometry (mainland + islands). The original code assigned **different sequential IDs to each polygon**:

```javascript
// WRONG: Each polygon gets unique ID
feature.geometry.coordinates.forEach((polygon, polygonIndex) => {
    const polygonPickingId = getNextFeatureId(); // 11, 12, 13, 14...
});
```

This caused:
- Clicking different parts of Tunisia returned different IDs
- Each island got its own label
- Feature couldn't be highlighted as a whole

### The Fix

All polygons in a MultiPolygon share the same ID:

```javascript
// CORRECT: Use shared feature ID
const clampedFeatureId = getSmartFeatureId(feature, sourceId); // 73 for Tunisia
feature.geometry.coordinates.forEach((polygon, polygonIndex) => {
    const polygonPickingId = clampedFeatureId; // Always 73
});
```

## Debugging Feature IDs

Add console logging to trace ID assignment:
```javascript
const name = feature.properties?.NAME;
if (name && name.includes('Tunisia')) {
    console.log(`getSmartFeatureId: feature.id=${feature.id}, result=${pickingId}`);
}
```

Check what's written to hidden buffer:
```javascript
console.log(`coordsToIdVertices: featureId=${featureId}, layer=${layerName}`);
```

## Tile Source Compatibility Matrix

| Source | feature.id | Strategy | Merging Works? |
|--------|------------|----------|----------------|
| MapLibre demo tiles | ✓ Small numbers | Direct | ✓ Yes |
| MapTiler | ✓ Small numbers | Direct | ✓ Yes |
| OpenFreeMap | ✗ OSM IDs (billions) | Modulo/Sequential | ⚠️ Collisions |
| Custom tippecanoe | Configurable | `--generate-ids` | ✓ Yes |

## Style Parser Improvements

### Legacy Zoom Functions

Many styles use the legacy format instead of expressions:
```json
{
  "fill-color": {
    "base": 1,
    "stops": [[12, "#f2eae2"], [16, "#dfdbd7"]]
  }
}
```

The parser now handles this:
```javascript
if (typeof expression === 'object' && !Array.isArray(expression) && expression.stops) {
    // Legacy zoom function
    const stops = expression.stops;
    const base = expression.base || 1;
    // Interpolate based on zoom...
}
```

### HSL Color Support

Added parsing for `hsl()` and `hsla()` colors:
```javascript
if (color.startsWith('hsl')) {
    // Convert HSL to RGB
    const h = parseFloat(match[0]) / 360;
    const s = parseFloat(match[1]) / 100;
    const l = parseFloat(match[2]) / 100;
    // ... hue2rgb conversion
}
```

## Recommendations

1. **Use tilesets with proper feature IDs** - MapLibre demo tiles, MapTiler, or custom tippecanoe output
2. **Configure promoteId** if your tiles have unique string/number properties
3. **Test picking** by clicking features and checking console for consistent IDs
4. **Watch for label spam** - indicates ID mismatch across tiles
