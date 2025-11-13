# TODO - WebGPU Map Renderer

## 🎯 High Priority

### Marker/Label Positioning on 3D Buildings
- **Issue**: Markers on extruded buildings appear at edges instead of roof centers
- **Root Cause**: Hybrid approach uses visible buffer (walls+roof) for buildings in hidden pass. Compute shader sees wall edges instead of filled roof surface
- **Options**:
  1. Generate separate simple roof geometry specifically for hidden buffer (clean filled surface)
  2. Modify compute shader to ignore edge pixels when calculating centroids
  3. Accept edge placement and adjust marker rendering to compensate
- **Impact**: Medium - markers are visible but not optimally positioned

### Multiple Building Selection
- **Issue**: Clicking tall buildings can select multiple overlapping buildings at different Z-heights
- **Root Cause**: Hidden texture encodes feature ID but picking doesn't account for Z-order occlusion
- **Potential Solutions**:
  1. Use depth buffer during picking to only select topmost feature
  2. Sort features by Z-height and prioritize highest
  3. Ray-casting through 3D geometry for accurate intersection
- **Impact**: Low - picking works, just not always precise on overlapping geometry

## 🧹 Code Quality

### Dead Code Cleanup ✅ (Completed)
- ~~Remove unused outline index buffer system~~
- ~~Remove conditional hidden buffer creation for 3D features (now reuses visible buffers)~~
- ~~Remove outlineIndices from geojsonGPU.js returns~~

### CPU Fallback Path
- **Status**: geojson.js exists as CPU fallback when `PERFORMANCE_STATS.gpuEnabled = false`
- **Question**: Is CPU fallback ever used? If not, consider removing to reduce maintenance burden
- **Decision**: Keep for now, revisit if it causes confusion or maintenance issues

### Debug Logging
- **Status**: Extensive `window._*Logged` flags and console.log statements throughout codebase
- **Options**:
  1. Remove all debug code for cleaner production build
  2. Wrap in conditional debug flag (e.g., `if (DEBUG_MODE)`)
  3. Keep as-is for ongoing development
- **Decision**: Keep for now during active development

## ✨ Feature Enhancements

### Building Outline Quality
- **Current**: Edge detection shader finds Z-height discontinuities and draws black outlines
- **Improvement Ideas**:
  1. Anti-alias outline edges (currently hard edges)
  2. Configurable outline color per layer
  3. Outline thickness based on zoom level
  4. Detect and highlight selected building outline

### Performance Optimization
- **GPU Memory**: Building buffers now optimized (no duplicate hidden buffers)
- **Compute Shader**: Feature ID limits unified to 65535
- **MSAA**: 4x multisampling on all geometry (smooth edges)
- **Potential Gains**:
  1. Frustum culling for off-screen geometry
  2. LOD system for distant buildings (simplified geometry)
  3. Texture atlasing for reduced draw calls
  4. Instanced rendering for repeated geometry

### Style Implementation
- **Current**: Basic fill, fill-extrusion, and line layer support
- **Missing MapLibre Features**:
  1. Symbol layers (labels, icons)
  2. Circle layers
  3. Raster layers
  4. Heatmap layers
  5. Hillshade layers
  6. Fill patterns/textures
  7. Data-driven styling (expressions)
  8. Smooth zoom interpolation

### Camera Controls
- **Current**: Pan (left mouse), pitch/bearing (right mouse), zoom (wheel), keyboard controls (arrows, R to reset)
- **Enhancements**:
  1. Inertial panning (momentum after mouse release)
  2. Touch controls for mobile
  3. Programmatic camera animations (flyTo, easeTo)
  4. Camera bounds/limits
  5. Terrain following for pitched views

## 🐛 Known Issues

### Edge Cases
1. **High zoom edge rendering**: Some buildings show artifacts at extreme zoom levels (>20)
2. **Tile seams**: Occasional visible seams between tiles at certain zoom levels
3. **Memory growth**: Long sessions may accumulate GPU buffers without cleanup
4. **Feature ID overflow**: Feature IDs >65535 get clamped, potential for collisions

### Browser Compatibility
- **WebGPU Support**: Chrome/Edge 113+, Safari 17.4+
- **Fallback**: No fallback to WebGL/Canvas (shows error message)
- **Mobile**: Limited testing on mobile browsers

## 📚 Documentation Needs

1. Architecture overview (rendering pipeline, dual-pass system)
2. Coordinate system explanation (world space, tile space, screen space)
3. Hidden texture encoding format (R+G=feature ID, B=Z-height)
4. Style specification mapping (MapLibre → WebGPU)
5. Performance considerations and limitations
6. Contributing guidelines

## 🔬 Research/Experiments

1. **GPU-accelerated text rendering**: Current labels are placeholder
2. **Terrain/elevation data**: 3D terrain from DEM tiles
3. **Dynamic lighting**: Shadows, ambient occlusion for 3D buildings
4. **Post-processing effects**: Bloom, fog, color grading
5. **Multi-pass rendering**: Reflections, water effects

---

**Last Updated**: 2025-11-13  
**Next Review**: After addressing high-priority marker positioning
