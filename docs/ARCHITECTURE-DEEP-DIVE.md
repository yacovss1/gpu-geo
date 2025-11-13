# Architecture Deep Dive - Scalability Assessment

## Executive Summary

**Current State**: Working prototype with solid WebGPU foundations  
**Scalability**: Moderate - requires architectural refactoring for enterprise-scale usage  
**Next-Gen Readiness**: 60% - Core patterns established, but missing critical abstractions

---

## 🔴 Critical Architectural Issues

### 1. **Monolithic main.js (1905 lines)**

**Problem**: God object anti-pattern - everything in one file
- Initialization (~200 lines)
- Tile loading logic (~300 lines) 
- Buffer management (~200 lines)
- Rendering loop (~400 lines)
- Marker/label computation (~600 lines)
- Helper functions (~200 lines)

**Impact on Scalability**:
- ❌ Cannot parallelize development across teams
- ❌ Difficult to test individual components
- ❌ High coupling between unrelated systems
- ❌ Memory leaks hard to trace
- ❌ No clear API boundaries

**Recommended Refactoring**:
```
src/
  core/
    MapEngine.js           # Main orchestrator (< 300 lines)
    ResourceManager.js     # GPU buffer lifecycle
    RenderPipeline.js      # Rendering coordination
  
  layers/
    LayerManager.js        # Layer registry, z-index, visibility
    LayerRenderer.js       # Per-layer rendering strategy
    LayerStyler.js         # Style evaluation
  
  tiles/
    TileManager.js         # Tile loading, caching, LRU eviction
    TileLoader.js          # Network fetch + retry logic
    TileParser.js          # Vector tile → geometry pipeline
  
  geometry/
    GeometryBatcher.js     # Batch GPU buffer creation
    GeometryTransformer.js # Coordinate systems
  
  labels/
    LabelEngine.js         # Text rendering coordination
    CollisionDetector.js   # Label collision avoidance
    LabelPlacer.js         # Position optimization
```

### 2. **No Layer Abstraction**

**Current**: Layers are implicit strings in a Map
```javascript
tileBuffers.set('building-3d', buffers);  // String keys = fragile
```

**Problem**:
- No layer lifecycle management
- No render order control
- No layer-specific optimizations
- No dynamic layer addition/removal
- Cannot support multiple layer types (fill, line, symbol, raster, 3D)

**Required Architecture**:
```javascript
class Layer {
  id: string
  type: 'fill' | 'line' | 'symbol' | 'fill-extrusion' | 'raster' | 'model-3d'
  source: string
  sourceLayer?: string
  minzoom: number
  maxzoom: number
  layout: LayoutProperties
  paint: PaintProperties
  
  // Lifecycle
  load(): Promise<void>
  unload(): void
  update(properties: Partial<Layer>): void
  
  // Rendering
  prepareRender(context: RenderContext): void
  render(encoder: GPUCommandEncoder): void
  
  // Optimization
  getBounds(): BoundingBox
  getMemoryUsage(): number
  simplify(lod: number): void
}

class LayerManager {
  layers: Map<string, Layer>
  renderOrder: string[]
  
  addLayer(layer: Layer, beforeId?: string): void
  removeLayer(id: string): void
  moveLayer(id: string, beforeId?: string): void
  setLayerVisibility(id: string, visible: boolean): void
  queryRenderedFeatures(point: Point, options?: QueryOptions): Feature[]
}
```

### 3. **Geometry Parsers Are Duplicated**

**Files**: `geojson.js` (712 lines) + `geojsonGPU.js` (1288 lines) = **2000 lines of duplication**

**Problem**:
- Same logic implemented twice (CPU vs GPU)
- Polygon triangulation duplicated
- Extrusion logic duplicated
- Style evaluation duplicated
- Bug fixes must be applied twice

**Solution**: Abstract geometry operations
```javascript
// Single source of truth for geometry operations
class GeometryProcessor {
  triangulate(polygon: Polygon): Indices
  extrude(polygon: Polygon, height: number): Mesh3D
  tessellate Line(line: Line, width: number): Polygon
  
  // Strategy pattern for CPU vs GPU execution
  setExecutor(executor: CPUExecutor | GPUExecutor): void
}

class GPUExecutor {
  async transform(coordinates: Float32Array): Promise<Float32Array>
  // Delegates to compute shaders
}

class CPUExecutor {
  transform(coordinates: Float32Array): Float32Array
  // Fallback for unsupported hardware
}
```

### 4. **No Memory Management Strategy**

**Current Issues**:
- GPU buffers created but never destroyed
- Tile buffers accumulate indefinitely
- No LRU eviction policy
- No memory pressure detection
- Hidden buffers duplicated for flat features (partially fixed)

**Required**:
```javascript
class ResourceManager {
  private memoryBudget: number = 512 * 1024 * 1024; // 512MB
  private buffers: Map<string, GPUBuffer>
  private textures: Map<string, GPUTexture>
  
  allocate(size: number): GPUBuffer | null
  deallocate(buffer: GPUBuffer): void
  
  getMemoryUsage(): { used: number, available: number }
  evictLRU(bytesNeeded: number): void
  
  // Lifecycle hooks
  onLowMemory(callback: () => void): void
  onMemoryPressure(callback: (severity: 'low' | 'medium' | 'high') => void): void
}
```

### 5. **Style System Not Extensible**

**Current**: `style.js` (560 lines) - partial MapLibre support

**Missing**:
- Expression evaluation engine
- Data-driven styling
- Feature state management
- Smooth zoom interpolation
- Sprite/glyph management
- 3D style extensions

**Required for Next-Gen**:
```javascript
// Full MapLibre GL Style Spec compliance
interface StyleSpecification {
  version: 8
  name?: string
  metadata?: unknown
  center?: [number, number]
  zoom?: number
  bearing?: number
  pitch?: number
  light?: LightSpecification
  terrain?: TerrainSpecification  // NEW
  sky?: SkySpecification          // NEW
  sources: { [key: string]: SourceSpecification }
  sprite?: string
  glyphs?: string
  layers: LayerSpecification[]
  
  // EXTENSIONS for 3D
  models?: ModelSpecification[]   // 3D assets (glTF)
  materials?: MaterialLibrary[]   // PBR materials
  lighting?: LightingConfig       // Dynamic lighting
}

class ExpressionEvaluator {
  evaluate(expression: Expression, context: EvaluationContext): any
  
  // Support all MapLibre expressions
  // ["get", "property"]
  // ["interpolate", ["linear"], ["zoom"], ...]
  // ["case", condition, value, ...]
  // ["match", input, ...cases]
}
```

---

## ⚠️ Scalability Gaps

### Performance Bottlenecks

#### 1. **Tile Loading Not Streamed**
```javascript
// Current: Load all tiles, THEN create buffers
await Promise.allSettled(tilePromises);  // Blocks on slowest tile

// Should be: Stream tiles as they arrive
for await (const tile of tileStream) {
  createBuffersForTile(tile);  // Incremental rendering
}
```

#### 2. **No Level of Detail (LOD)**
- All geometry rendered at full resolution regardless of zoom
- Distant buildings have same vertex count as nearby buildings
- No geometry simplification pipeline

**Required**:
```javascript
class LODManager {
  generateLODs(geometry: Geometry, levels: number): Geometry[]
  selectLOD(geometry: Geometry, distance: number): Geometry
  
  // Mesh simplification for distant objects
  simplifyMesh(mesh: Mesh, targetTriangles: number): Mesh
}
```

#### 3. **No Frustum Culling**
- All tiles/features rendered even if off-screen
- GPU wastes time on invisible geometry

**Required**:
```javascript
class CullingSystem {
  frustumCull(features: Feature[], viewFrustum: Frustum): Feature[]
  occlusionCull(features: Feature[], depthTexture: GPUTexture): Feature[]
  
  // Spatial indexing for fast queries
  buildRTree(features: Feature[]): RTree
}
```

#### 4. **Single Render Pass**
- Cannot support advanced effects
- No depth-based sorting for transparency
- No post-processing pipeline

**Required Multi-Pass Architecture**:
```
Pass 1: Depth pre-pass (Z-buffer optimization)
Pass 2: Opaque geometry
Pass 3: Transparent geometry (sorted back-to-front)
Pass 4: 3D models with lighting
Pass 5: Post-processing (SSAO, bloom, etc)
Pass 6: UI/labels (always on top)
```

### Massive Layer Support

**Current Limits**:
- ~20-30 layers before performance degrades
- No layer virtualization
- All layers processed every frame

**Required for 1000+ Layers**:
```javascript
class LayerVirtualization {
  // Only prepare visible layers
  visibleLayers: Set<Layer>
  
  update(viewport: Viewport): void {
    this.visibleLayers.clear();
    for (const layer of this.allLayers) {
      if (this.isLayerVisible(layer, viewport)) {
        this.visibleLayers.add(layer);
      }
    }
  }
  
  isLayerVisible(layer: Layer, viewport: Viewport): boolean {
    // Check zoom range
    if (viewport.zoom < layer.minzoom || viewport.zoom > layer.maxzoom) {
      return false;
    }
    
    // Check spatial bounds
    if (!viewport.intersects(layer.bounds)) {
      return false;
    }
    
    // Check visibility
    if (layer.layout.visibility === 'none') {
      return false;
    }
    
    return true;
  }
}
```

### Real-Time Labeling at Scale

**Current Issues**:
- Compute shader runs for ALL features (65k limit)
- No label collision detection
- Labels regenerated every frame
- No label priority/ranking

**Required**:
```javascript
class LabelEngine {
  private labelCache: Map<featureId, Label>
  private collisionIndex: RBush
  
  // Incremental label placement
  async placeLabels(features: Feature[], viewport: Viewport): Promise<Label[]> {
    const candidates = this.generateCandidates(features);
    const sorted = this.prioritize(candidates);
    const placed = [];
    
    for (const candidate of sorted) {
      if (!this.collisionIndex.collides(candidate.bounds)) {
        placed.push(candidate);
        this.collisionIndex.insert(candidate);
      }
    }
    
    return placed;
  }
  
  prioritize(labels: Label[]): Label[] {
    // Rank by: feature importance, area, zoom level
    return labels.sort((a, b) => b.priority - a.priority);
  }
}
```

### 3D Asset Support

**Currently Missing**:
- No 3D model loader (glTF/glb)
- No material system (PBR)
- No lighting engine
- No skeletal animation
- No instanced rendering for repeated objects

**Required Architecture**:
```javascript
interface Model3DLayer extends Layer {
  type: 'model-3d'
  source: string  // Points to glTF URL or source
  modelId: string // Reference to loaded model
  
  // Placement
  anchor: [lon, lat, altitude]
  rotati[heading, pitch, roll]
  scale: [x, y, z]
  
  // Rendering
  material?: MaterialOverride
  castShadows: boolean
  receiveShadows: boolean
}

class ModelLoader {
  async load(url: string): Promise<Model3D>
  cache: Map<string, Model3D>
  
  // Optimize for GPU
  convertToGPUFormat(gltf: GLTF): GPUModel
}

class Material {
  albedo: GPUTexture
  metallic: number
  roughness: number
  normal: GPUTexture
  emissive: [r, g, b]
  
  // PBR rendering
  createPipeline(device: GPUDevice): GPURenderPipeline
}
```

---

## ✅ Architectural Strengths

### 1. **WebGPU Foundation**
- ✅ Modern GPU API (future-proof)
- ✅ Compute shader infrastructure in place
- ✅ Multi-pass rendering established

### 2. **Dual-Pass Rendering**
- ✅ Hidden texture for picking/markers
- ✅ Edge detection shader
- ✅ Feature ID encoding working

### 3. **GPU-Accelerated Coordinates**
- ✅ Compute shaders for coordinate transformation
- ✅ Performance tracking infrastructure
- ✅ CPU fallback option

### 4. **Camera System**
- ✅ Pitch and bearing support
- ✅ Zoom-to-mouse working
- ✅ View frustum calculations

### 5. **Style System Started**
- ✅ Basic MapLibre style parsing
- ✅ Paint property evaluation
- ✅ Layer filtering by zoom

---

## 📋 Refactoring Roadmap

### Phase 1: Critical Decomposition (2-3 weeks)
1. **Extract LayerManager** from main.js
   - Move layer registry logic
   - Implement add/remove/reorder API
   - Add layer lifecycle hooks

2. **Extract TileManager** from main.js
   - Centralize tile loading logic
   - Implement LRU cache with size limits
   - Add tile streaming

3. **Extract RenderPipeline** from main.js
   - Separate render loop from business logic
   - Create RenderContext abstraction
   - Move marker/label rendering to separate systems

4. **Unify Geometry Parsers**
   - Create GeometryProcessor abstraction
   - Merge geojson.js + geojsonGPU.js
   - Strategy pattern for CPU vs GPU

### Phase 2: Scalability Foundations (3-4 weeks)
5. **Implement ResourceManager**
   - Track GPU memory usage
   - LRU eviction for buffers/textures
   - Memory pressure detection

6. **Add Spatial Indexing**
   - R-tree for features
   - Frustum culling
   - Layer virtualization

7. **LOD System**
   - Geometry simplification
   - Distance-based switching
   - Tile pyramid caching

8. **Expression Evaluator**
   - Full MapLibre expression support
   - Data-driven styling
   - Smooth interpolation

### Phase 3: Advanced Features (4-6 weeks)
9. **3D Model Support**
   - glTF loader
   - PBR material system
   - Lighting engine
   - Shadow mapping

10. **Real-Time Label Engine**
    - Collision detection
    - Priority-based placement
    - Label caching
    - Symbol layers

11. **Multi-Pass Rendering**
    - Depth pre-pass
    - Transparency sorting
    - Post-processing effects
    - SSAO, bloom, fog

12. **Extended Tile Spec**
    - 3D tile support (Cesium 3D Tiles)
    - Mesh compression
    - Texture atlasing
    - Instanced geometry

---

## 🎯 Target Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     MapEngine                           │
│  - Initialization                                       │
│  - Event coordination                                   │
│  - Public API                                           │
└───────────────┬─────────────────────────────────────────┘
                │
        ┌───────┴──────┐
        │              │
┌───────▼────────┐ ┌──▼──────────────┐
│  LayerManager  │ │ ResourceManager │
│  - Registry    │ │ - GPU buffers   │
│  - Z-index     │ │ - Textures      │
│  - Visibility  │ │ - Memory limits │
└───────┬────────┘ └──┬──────────────┘
        │              │
┌───────▼──────────────▼──────────┐
│       RenderPipeline            │
│  - Frame orchestration          │
│  - Multi-pass rendering         │
│  - Culling & LOD                │
└───────┬─────────────────────────┘
        │
    ┌───┴───┐
    │       │
┌───▼───┐ ┌─▼──────────┐
│ Tiles │ │ Geometry   │
│ Cache │ │ Processing │
│ LRU   │ │ CPU/GPU    │
└───┬───┘ └─┬──────────┘
    │       │
    └───┬───┘
        │
┌───────▼────────────────────────┐
│      Specialized Systems       │
│  - LabelEngine                 │
│  - CollisionDetector           │
│  - ModelLoader (3D assets)     │
│  - MaterialSystem (PBR)        │
│  - LightingEngine              │
│  - PostProcessor (effects)     │
└────────────────────────────────┘
```

---

## 🔬 Scalability Benchmarks (Target)

| Metric | Current | Target | Gap |
|--------|---------|--------|-----|
| **Max Layers** | ~30 | 1000+ | Need virtualization |
| **Features/Frame** | ~10k | 100k+ | Need culling + LOD |
| **Tile Load Time** | ~500ms | <100ms | Need streaming |
| **Memory Usage** | Unbounded | <512MB | Need eviction |
| **Label Placement** | Basic | Collision-free | Need engine |
| **3D Models** | None | Unlimited | Need loader |
| **Draw Calls** | ~100 | <20 | Need batching |
| **FPS (1000 layers)** | N/A | 60fps | Full rewrite needed |

---

## 💡 Recommendations

### Immediate Actions (This Week)
1. Create `src/core/MapEngine.js` - extract initialization
2. Create `src/layers/LayerManager.js` - extract layer logic
3. Create `src/tiles/TileManager.js` - extract tile loading
4. Add memory tracking to ResourceManager

### Short Term (This Month)
5. Merge geojson.js + geojsonGPU.js into single abstraction
6. Implement LRU cache with memory limits
7. Add spatial indexing (R-tree) for features
8. Implement frustum culling

### Medium Term (Next Quarter)
9. Full Expression evaluator for data-driven styling
10. LOD system with mesh simplification
11. Label collision detection and placement
12. glTF model loader + PBR materials

### Long Term (6-12 Months)
13. Extended 3D tile format support
14. Dynamic lighting + shadow mapping
15. Post-processing effects pipeline
16. WebWorker parallelization for tile parsing

---

## 🚨 Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **Refactoring breaks features** | High | High | Incremental changes + comprehensive tests |
| **Performance regression** | Medium | High | Benchmark suite + profiling |
| **Memory leaks** | Medium | High | Resource tracking + automated tests |
| **WebGPU compatibility** | Low | High | Fallback to WebGL2 (future) |
| **Complexity explosion** | High | Medium | Clear abstractions + documentation |

---

## Conclusion

**Current Architecture Grade: C+**
- Solid technical foundation (WebGPU, compute shaders)
- Functional prototype with working features
- **Critical flaw**: Monolithic structure prevents scaling

**Path to A+ (Next-Gen Ready)**:
1. Decompose main.js into focused modules (4-6 weeks)
2. Implement resource management + spatial indexing (3-4 weeks)
3. Add LOD + culling systems (2-3 weeks)
4. Extend style system for full MapLibre compliance (4-6 weeks)
5. 3D asset pipeline (6-8 weeks)

**Total Estimated Refactoring Time**: 4-6 months for production-ready architecture

**Bottom Line**: The bones are good, but the structure needs a complete reorganization before adding advanced features. Current code cannot scale to 1000+ layers or handle massive real-time labeling without fundamental changes.
