# Style Specification Migration Guide

## Overview

Version 2.0 introduces Mapbox/MapLibre style specification support, making the library fully generic and compatible with any vector tile source.

## What Changed

### Before (Hardcoded)

```javascript
// Limited to MapLibre demo tiles
// Hardcoded colors based on ADM0_A3/ISO_A3 properties
// Fixed feature ID based on 'fid' property
```

### After (Configurable)

```javascript
// Any vector tile source
// Data-driven styling with expressions
// Configurable feature IDs via promoteId
await window.mapStyle.setStyle({
  version: 8,
  sources: { ... },
  layers: [ ... ]
});
```

## Migration Path

### Option 1: Use Legacy Mode (No Changes Required)

The library maintains backwards compatibility. Without setting a style, it uses:
- Default MapLibre demo tiles
- Hardcoded country colors based on `ADM0_A3`/`ISO_A3`
- Feature ID from `properties.fid`

### Option 2: Adopt Style Specification

```javascript
// Load the included example style
await window.mapStyle.loadStyleFromURL('./example-style.json');

// Or create your own style
await window.mapStyle.setStyle({
  version: 8,
  sources: {
    "my-tiles": {
      type: "vector",
      tiles: ["https://my-server.com/{z}/{x}/{y}.pbf"],
      promoteId: "osm_id"  // Use osm_id as feature identifier
    }
  },
  layers: [
    {
      id: "water",
      type: "fill",
      source: "my-tiles",
      "source-layer": "water",
      paint: {
        "fill-color": "#0080ff"
      }
    }
  ]
});
```

## Supported Features

### Style Specification v8

- ✅ Vector tile sources
- ✅ Fill and line layers
- ✅ Layer filters
- ✅ Paint properties (fill-color, line-color, fill-opacity)
- ✅ Data-driven expressions
- ✅ Feature ID configuration (promoteId)

### Expression Support

- `get` - Get feature property
- `match` - Conditional matching
- `case` - Boolean conditions
- `interpolate` - Numeric interpolation
- `step` - Step functions
- `zoom` - Current zoom level
- Comparison: `==`, `!=`, `>`, `>=`, `<`, `<=`
- Logical: `all`, `any`, `!`
- Property: `has`, `in`

### Not Yet Supported

- ⏳ Symbol layers (text/icons)
- ⏳ Circle, heatmap, hillshade layers
- ⏳ Sprite sheets
- ⏳ Layout properties
- ⏳ Advanced expressions (coalesce, let, etc.)

## Examples

### Example 1: Basic Choropleth Map

```javascript
await window.mapStyle.setStyle({
  version: 8,
  sources: {
    "countries": {
      type: "vector",
      tiles: ["https://demotiles.maplibre.org/tiles/{z}/{x}/{y}.pbf"],
      promoteId: "fid"
    }
  },
  layers: [{
    id: "population",
    type: "fill",
    source: "countries",
    paint: {
      "fill-color": [
        "step",
        ["get", "pop_est"],
        "#fff5f0",
        1000000, "#fee0d2",
        10000000, "#fcbba1",
        50000000, "#fc9272",
        100000000, "#fb6a4a",
        200000000, "#de2d26"
      ]
    }
  }]
});
```

### Example 2: Filtered Layers

```javascript
await window.mapStyle.setStyle({
  version: 8,
  sources: {
    "boundaries": {
      type: "vector",
      tiles: ["https://your-server.com/{z}/{x}/{y}.pbf"]
    }
  },
  layers: [
    {
      id: "countries",
      type: "fill",
      source: "boundaries",
      filter: ["==", ["get", "admin_level"], 2],
      paint: { "fill-color": "#e0e0e0" }
    },
    {
      id: "states",
      type: "line",
      source: "boundaries",
      filter: ["==", ["get", "admin_level"], 4],
      paint: { "line-color": "#757575" }
    }
  ]
});
```

### Example 3: Zoom-based Styling

```javascript
await window.mapStyle.setStyle({
  version: 8,
  sources: { "tiles": {...} },
  layers: [{
    id: "roads",
    type: "line",
    source: "tiles",
    paint: {
      "line-width": [
        "interpolate",
        ["linear"],
        ["zoom"],
        5, 0.5,
        10, 2,
        15, 8
      ]
    }
  }]
});
```

## Troubleshooting

### Colors Not Showing
- Ensure `fill-color` values are valid CSS colors, hex codes, or color expressions
- Check that your property names match the data in your tiles

### Features Not Rendering
- Verify `source-layer` matches the layer name in your vector tiles
- Check filter expressions are correctly evaluating
- Inspect tile data in browser devtools network tab

### Feature Picking Not Working
- Set `promoteId` in your source configuration
- Ensure the property exists in your feature data
- Feature IDs must be unique within each tile

## Resources

- [Mapbox Style Specification](https://docs.mapbox.com/style-spec/)
- [MapLibre Style Specification](https://maplibre.org/maplibre-style-spec/)
- [Expression Reference](https://docs.mapbox.com/style-spec/reference/expressions/)
