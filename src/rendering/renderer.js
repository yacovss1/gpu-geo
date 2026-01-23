import { 
    vertexShaderCode, fragmentShaderCode, hiddenFragmentShaderCode, hiddenVertexShaderCode,
    edgeDetectionVertexShaderCode, edgeDetectionFragmentShaderCode,
    debugVertexShaderCode, debugFragmentShaderCode 
} from '../shaders/shaders.js';
import { GPUTextRenderer } from '../text/gpuTextRenderer.js';
import { ShaderEffectManager } from '../core/shaderEffectManager.js';
import { TubePipeline } from './tubePipeline.js';
import { ShadowMapRenderer } from './shadowMap.js';

// Cache shaders and layouts to avoid recreation
let cachedShaders = { 
    vertex: null, 
    fragment: null, 
    hiddenVertex: null,
    hiddenFragment: null, 
    edgeDetectionVertex: null, 
    edgeDetectionFragment: null,
    debugVertex: null,
    debugFragment: null,
    initialized: false
};

let cachedLayouts = {};

// Force shader recompilation (call when shader code changes)
export function clearShaderCache() {
    cachedShaders.initialized = false;
    cachedLayouts = {};
    console.log('🔄 Shader cache cleared');
}

// Initialize all shader modules that will be used
function initCachedShaders(device) {
    if (!cachedShaders.initialized) {
        console.log('🔧 Compiling shaders with 40-byte vertex stride (pos3+normal3+color4)');
        cachedShaders.vertex = device.createShaderModule({ code: vertexShaderCode });
        cachedShaders.fragment = device.createShaderModule({ code: fragmentShaderCode });
        cachedShaders.hiddenVertex = device.createShaderModule({ code: hiddenVertexShaderCode });
        cachedShaders.hiddenFragment = device.createShaderModule({ code: hiddenFragmentShaderCode });
        cachedShaders.edgeDetectionVertex = device.createShaderModule({ code: edgeDetectionVertexShaderCode });
        cachedShaders.edgeDetectionFragment = device.createShaderModule({ code: edgeDetectionFragmentShaderCode });
        cachedShaders.debugVertex = device.createShaderModule({ code: debugVertexShaderCode });
        cachedShaders.debugFragment = device.createShaderModule({ code: debugFragmentShaderCode });
        cachedShaders.initialized = true;
    }
}

// Create a standard rendering pipeline for map features
// disableDepthTest: true for flat 2D layers that should use painter's algorithm (no z-fighting)
export function createRenderPipeline(device, format, topology, isHidden = false, depthBias = 0, disableDepthTest = false) {
    initCachedShaders(device);
    
    // Create and cache layout for render pipelines
    // Group 0: Camera uniform only (compatible with effect shaders)
    if (!cachedLayouts.render) {
        cachedLayouts.render = device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: "uniform" }
                }
            ]
        });
    }
    
    // Group 1: Terrain data (optional - for GPU terrain projection)
    if (!cachedLayouts.terrain) {
        cachedLayouts.terrain = device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX,
                    texture: { sampleType: 'float' }
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.VERTEX,
                    sampler: { type: 'filtering' }
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: "uniform" }
                }
            ]
        });
    }
    
    // Group 2: Shadow map data (for shadow mapping)
    if (!cachedLayouts.shadow) {
        cachedLayouts.shadow = device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: "uniform" }  // Light space matrix
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'depth' }  // Shadow depth texture
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: { type: 'comparison' }  // Comparison sampler for shadow testing
                }
            ]
        });
    }
    
    // Choose layout based on whether this is hidden pass (no shadows) or visible pass (with shadows)
    const pipelineLayout = isHidden 
        ? device.createPipelineLayout({ bindGroupLayouts: [cachedLayouts.render, cachedLayouts.terrain] })
        : device.createPipelineLayout({ bindGroupLayouts: [cachedLayouts.render, cachedLayouts.terrain, cachedLayouts.shadow] });
    
    return device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: {
            module: isHidden ? cachedShaders.hiddenVertex : cachedShaders.vertex,
            entryPoint: "main",
            buffers: [{
                // Vertex format: position(3) + normal(3) + color(4) = 10 floats = 40 bytes
                arrayStride: 40,
                attributes: [
                    { shaderLocation: 0, offset: 0, format: 'float32x3' },   // position
                    { shaderLocation: 1, offset: 12, format: 'float32x3' },  // normal
                    { shaderLocation: 2, offset: 24, format: 'float32x4' }   // color
                ]
            }],
        },
        fragment: {
            module: isHidden ? cachedShaders.hiddenFragment : cachedShaders.fragment,
            entryPoint: "main",
            targets: [{
                format: format,
                // Standard alpha blending for proper layer compositing
                // Tile boundary seams are now prevented by clipping polygons to tile bounds
                // in vectorTileParser.js (Sutherland-Hodgman algorithm)
                blend: isHidden ? {
                    color: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
                    alpha: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' }
                } : {
                    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
                }
            }],
        },
        primitive: { topology, cullMode: 'none', frontFace: 'ccw' },
        depthStencil: {
            format: 'depth24plus',
            // For flat 2D layers: disable depth write/compare to use painter's algorithm (no z-fighting)
            // For 3D: use normal depth testing
            depthWriteEnabled: !disableDepthTest,
            depthCompare: disableDepthTest ? 'always' : 'less-equal',
            ...(depthBias !== 0 && topology !== 'line-list' && !disableDepthTest ? {
                depthBias: depthBias,
                depthBiasSlopeScale: 2.0,
                depthBiasClamp: 0.01
            } : {})
        },
        multisample: { count: isHidden ? 1 : 4 }
    });
}

// Create edge detection pipeline
export function createEdgeDetectionPipeline(device, format) {
    initCachedShaders(device);
    
    // Cache bind group layout for edge detection
    // binding 2 = linear sampler for color, binding 7 = nearest sampler for IDs
    cachedLayouts.edgeDetection = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
            { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            { binding: 6, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            { binding: 7, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'non-filtering' } }
        ]
    });
    
    const pipelineLayout = device.createPipelineLayout({ 
        bindGroupLayouts: [cachedLayouts.edgeDetection] 
    });
    
    return device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { 
            module: cachedShaders.edgeDetectionVertex, 
            entryPoint: "main" 
        },
        fragment: { 
            module: cachedShaders.edgeDetectionFragment, 
            entryPoint: "main", 
            targets: [{ format }] 
        },
        primitive: { topology: "triangle-list" },
        multisample: { count: 1 }  // No MSAA for post-process
    });
}

// Create debug texture pipeline for visualizing the hidden buffer
export function createDebugTexturePipeline(device, format) {
    initCachedShaders(device);
    
    // Cache bind group layout for debug visualization
    if (!cachedLayouts.debug) {
        cachedLayouts.debug = device.createBindGroupLayout({
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT,
                texture: { sampleType: 'unfilterable-float' }
            }]
        });
    }
    
    const pipelineLayout = device.createPipelineLayout({ 
        bindGroupLayouts: [cachedLayouts.debug] 
    });
    
    return device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: {
            module: cachedShaders.debugVertex,
            entryPoint: 'main'
        },
        fragment: {
            module: cachedShaders.debugFragment,
            entryPoint: 'main',
            targets: [{ format }]
        },
        primitive: { topology: 'triangle-list' }
    });
}

// Create edge detection bind group
export function createEdgeDetectionBindGroup(device, pipeline, colorTexture, hiddenTexture, sampler, canvasSizeBuffer, pickedIdBuffer, zoomInfoBuffer) {
    return device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: colorTexture.createView() },
            { binding: 1, resource: hiddenTexture.createView() },
            { binding: 2, resource: sampler },
            { binding: 3, resource: { buffer: canvasSizeBuffer } },
            { binding: 4, resource: { buffer: pickedIdBuffer } },
            { binding: 5, resource: { buffer: zoomInfoBuffer } }
        ]
    });
}

// Create a debug view bind group
export function createDebugBindGroup(device, pipeline, hiddenTexture) {
    return device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{
            binding: 0,
            resource: hiddenTexture.createView()
        }]
    });
}

// Helper for MSAA rendering setup if needed
export function createMSAATexture(device, canvas, sampleCount, format) {
    return device.createTexture({
        size: [canvas.width, canvas.height, 1],
        sampleCount: sampleCount,
        format: format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
}

// FIX: Simplify the MapRenderer class to preserve original functionality
export class MapRenderer {
    constructor(device, context, format) {
        this.device = device;
        this.context = context;
        this.format = format;
        this.pipelines = {};
        this.bindGroups = {};
        this.textures = {};
        this.buffers = {};
        this._lastLoggedVisualZoom = -1;
        
        // Terrain layer reference (set via setTerrainLayer)
        this.terrainLayer = null;
        
        // Global lighting state
        this.lighting = {
            // Sun direction (normalized, in world space: +X=east, +Y=north, +Z=up)
            // Good horizontal component to light building walls
            sunDirection: [0.6, 0.5, 0.5],  // Default: from southeast, 45 degree elevation
            // Ambient light color (always present, shadows)
            ambientColor: [0.3, 0.35, 0.45],  // Slightly blue for cool shadows
            // Diffuse light color (direct sunlight)
            diffuseColor: [1.0, 0.95, 0.85],  // Warm sunlight
            // Overall light intensity (0-1)
            intensity: 1.0,
            // Time of day (0-24, for presets)
            timeOfDay: 12,
            // Is nighttime
            isNight: false,
            // Shadows enabled
            shadowsEnabled: true
        };
        
        // Initialize shader effect manager
        this.effectManager = new ShaderEffectManager(device);
        this.effectBindGroups = new Map(); // Cache bind groups for effects
        
        // Initialize tube/pipe renderer
        this.tubePipeline = new TubePipeline(device, format);
        
        // Initialize shadow map renderer
        this.shadowRenderer = new ShadowMapRenderer(device);
        
        // Initialize pipelines
        this.initializePipelines();
    }
    
    setTerrainLayer(terrainLayer) {
        this.terrainLayer = terrainLayer;
    }
    
    /**
     * Update shadow map for current frame
     * Call this before rendering the main pass
     */
    updateShadows(encoder, tileBuffers, shouldRenderLayer, cameraCenter, viewRadius) {
        if (!this.lighting.shadowsEnabled || this.lighting.isNight) {
            return; // No shadows at night or when disabled
        }
        
        // Update light space matrix based on sun direction
        this.shadowRenderer.updateLightMatrix(
            this.lighting.sunDirection,
            cameraCenter,
            viewRadius
        );
        
        // Render shadow pass
        this.shadowRenderer.renderShadowPass(encoder, tileBuffers, shouldRenderLayer);
    }
    
    /**
     * Get shadow map resources for main render pass
     */
    getShadowResources() {
        if (!this.shadowRenderer.initialized) {
            this.shadowRenderer.initialize();
        }
        return {
            shadowMapView: this.shadowRenderer.getShadowMapView(),
            shadowMapSampler: this.shadowRenderer.getShadowMapSampler(),
            lightMatrixBuffer: this.shadowRenderer.getLightMatrixBuffer()
        };
    }
    
    initializePipelines() {
        // Clear cached layouts to ensure fresh creation (important for hot reload)
        cachedLayouts = {};
        
        // Create main rendering pipelines
        // Regular fill pipeline - depth tested for 3D geometry
        this.pipelines.fill = createRenderPipeline(this.device, this.format, "triangle-list", false, 0);
        // Flat 2D pipeline - NO depth testing, uses painter's algorithm for 2D layers on terrain
        this.pipelines.flat = createRenderPipeline(this.device, this.format, "triangle-list", false, 0, true);
        // Fill with depth bias - ONLY for fills that have a corresponding extrusion
        this.pipelines.fillWithBias = createRenderPipeline(this.device, this.format, "triangle-list", false, 100);
        // Extrusion pipeline - small depth bias to reduce z-fighting between adjacent walls
        this.pipelines.extrusion = createRenderPipeline(this.device, this.format, "triangle-list", false, 2);
        this.pipelines.outline = createRenderPipeline(this.device, this.format, "line-list", false, 0);
        // Hidden pipelines - MUST match depth bias of corresponding color pipelines
        // to ensure consistent depth test results between passes
        this.pipelines.hidden = createRenderPipeline(this.device, this.format, "triangle-list", true, 0);
        this.pipelines.hiddenFlat = createRenderPipeline(this.device, this.format, "triangle-list", true, 0, true);
        this.pipelines.hiddenWithBias = createRenderPipeline(this.device, this.format, "triangle-list", true, 100);
        this.pipelines.edgeDetection = createEdgeDetectionPipeline(this.device, this.format);
        this.pipelines.debug = createDebugTexturePipeline(this.device, this.format);
    }
    
    async createResources(canvas, camera) {
        // Create textures - ENSURE they match canvas dimensions exactly
        await this.createTextures(canvas.width, canvas.height);
        
        // Create uniform buffers
        this.buffers.uniform = this.device.createBuffer({
            size: 64, // 4x4 matrix
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        
        this.buffers.canvasSize = this.device.createBuffer({
            size: 8,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(this.buffers.canvasSize, 0, new Float32Array([canvas.width, canvas.height]));
        
        this.buffers.pickedId = this.device.createBuffer({
            size: 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(this.buffers.pickedId, 0, new Float32Array([0]));
        
        this.buffers.pickedLayerId = this.device.createBuffer({
            size: 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(this.buffers.pickedLayerId, 0, new Float32Array([0]));
        
        // Add zoom info buffer - increase to hold 4 values instead of just 2
        this.buffers.zoomInfo = this.device.createBuffer({
            size: 16, // 4 float32 values (4 bytes each)
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        
        // Initialize with starting values
        this.updateZoomInfo(camera.zoom, Math.min(Math.floor(camera.zoom), camera.maxFetchZoom));
        
        // Add layer config buffer for marker and outline filtering
        // Layout: [markerLayers[8], outlineLayers[8]] as u32 (4 bytes each)
        // Total: 16 * 4 = 64 bytes
        this.buffers.layerConfig = this.device.createBuffer({
            size: 64,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        // Initialize with 255 (no layers whitelisted)
        const initialConfig = new Uint32Array(16).fill(255);
        this.device.queue.writeBuffer(this.buffers.layerConfig, 0, initialConfig);
        
        // Create sampler for color texture (linear filtering for smooth appearance)
        this.sampler = this.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
        });
        
        // Create nearest-neighbor sampler for ID texture (no interpolation - exact values needed)
        this.samplerNearest = this.device.createSampler({
            magFilter: 'nearest',
            minFilter: 'nearest',
        });
        
        // Create terrain sampler for vector shaders
        this.terrainSampler = this.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge'
        });
        
        // Create dummy 1x1 terrain texture (used when terrain is disabled)
        this.dummyTerrainTexture = this.device.createTexture({
            size: [1, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
        });
        // Initialize with sea level (R=128, G=0, B=0 = height 0 in Terrarium encoding)
        this.device.queue.writeTexture(
            { texture: this.dummyTerrainTexture },
            new Uint8Array([128, 0, 0, 255]),
            { bytesPerRow: 4 },
            [1, 1]
        );
        
        // Create terrain bounds uniform buffer (64 bytes = 16 floats)
        // Layout: terrainBounds (8 floats) + lighting (8 floats)
        this.buffers.terrainBounds = this.device.createBuffer({
            size: 64,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        // Initialize with disabled terrain and default lighting
        this.device.queue.writeBuffer(this.buffers.terrainBounds, 0, new Float32Array([
            // Terrain bounds (8 floats)
            -1, -1, 1, 1,  // minX, minY, maxX, maxY
            30,            // exaggeration - match terrainLayer default
            0,             // enabled (0 = disabled)
            0, 0,          // padding
            // Lighting data (8 floats)
            0.5, 0.5, 0.7, 1.0,    // sunDirection.xyz, intensity
            0.3, 0.35, 0.45, 0.0,  // ambientColor.rgb, isNight (0 = day)
        ]));
        
        // Create bind groups - separate camera (group 0) and terrain (group 1)
        this.bindGroups.main = this.device.createBindGroup({
            layout: this.pipelines.fill.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.buffers.uniform } }
            ],
        });
        
        this.bindGroups.terrain = this.device.createBindGroup({
            layout: this.pipelines.fill.getBindGroupLayout(1),
            entries: [
                { binding: 0, resource: this.dummyTerrainTexture.createView() },
                { binding: 1, resource: this.terrainSampler },
                { binding: 2, resource: { buffer: this.buffers.terrainBounds } }
            ],
        });
        
        // Initialize shadow renderer and create shadow bind group
        this.shadowRenderer.initialize();
        this.bindGroups.shadow = this.device.createBindGroup({
            layout: this.pipelines.fill.getBindGroupLayout(2),
            entries: [
                { binding: 0, resource: { buffer: this.shadowRenderer.getLightMatrixBuffer() } },
                { binding: 1, resource: this.shadowRenderer.getShadowMapView() },
                { binding: 2, resource: this.shadowRenderer.getShadowMapSampler() }
            ],
        });
        
        this.bindGroups.picking = this.device.createBindGroup({
            layout: this.pipelines.hidden.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.buffers.uniform } }
            ],
        });
        
        this.bindGroups.pickingTerrain = this.device.createBindGroup({
            layout: this.pipelines.hidden.getBindGroupLayout(1),
            entries: [
                { binding: 0, resource: this.dummyTerrainTexture.createView() },
                { binding: 1, resource: this.terrainSampler },
                { binding: 2, resource: { buffer: this.buffers.terrainBounds } }
            ],
        });
        
        this.bindGroups.edgeDetection = this.device.createBindGroup({
            layout: this.pipelines.edgeDetection.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: this.textures.color.createView() },
                { binding: 1, resource: this.textures.hidden.createView() },
                { binding: 2, resource: this.sampler },
                { binding: 3, resource: { buffer: this.buffers.canvasSize } },
                { binding: 4, resource: { buffer: this.buffers.pickedId } },
                { binding: 5, resource: { buffer: this.buffers.zoomInfo } },
                { binding: 6, resource: { buffer: this.buffers.pickedLayerId } },
                { binding: 7, resource: this.samplerNearest }  // Nearest sampler for ID texture
            ]
        });
        
        this.bindGroups.debug = this.device.createBindGroup({
            layout: this.pipelines.debug.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: this.textures.hidden.createView() }]
        });
        
        // Initialize tube pipeline with camera buffer
        await this.tubePipeline.initialize(this.buffers.uniform);
        
        // Update initial camera transform
        this.updateCameraTransform(camera.getMatrix());
    }
    
    /**
     * Update terrain data for GPU-based vector projection
     * Call this each frame to update terrain texture and bounds
     * Note: Always update terrain for vector Z heights, regardless of whether
     * the terrain overlay layer is rendered. The 'enabled' flag on terrainLayer
     * controls overlay rendering, not height projection.
     */
    updateTerrainForProjection(camera, zoom) {
        if (!this.terrainLayer) {
            // No terrain layer at all - disable terrain in shader
            this.device.queue.writeBuffer(this.buffers.terrainBounds, 0, new Float32Array([
                -1, -1, 1, 1,
                30, 0, 0, 0  // enabled = 0, default exaggeration
            ]));
            return;
        }
        
        // Get visible terrain tiles and build atlas
        // Always do this regardless of terrainLayer.enabled - vectors need heights
        const visibleTiles = this.terrainLayer.getVisibleTerrainTiles(camera, zoom);
        const atlas = this.terrainLayer.buildTerrainAtlas(visibleTiles);
        
        if (!atlas) {
            console.log(`🏔️ No atlas - terrain tiles not loaded. Exaggeration: ${this.terrainLayer.exaggeration}`);
            this.device.queue.writeBuffer(this.buffers.terrainBounds, 0, new Float32Array([
                -1, -1, 1, 1,
                this.terrainLayer.exaggeration, 0, 0, 0
            ]));
            return;
        }
        
        // Update bounds uniform with atlas bounds and tile count
        const exagg = this.terrainLayer.exaggeration;
        console.log(`🏔️ Writing exaggeration to GPU: ${exagg}`);
        this.device.queue.writeBuffer(this.buffers.terrainBounds, 0, new Float32Array([
            atlas.bounds.minX, atlas.bounds.minY, atlas.bounds.maxX, atlas.bounds.maxY,
            exagg,
            1.0,  // enabled
            atlas.tilesX || 1,  // number of tiles in X
            atlas.tilesY || 1   // number of tiles in Y
        ]));
        
        // Recreate terrain bind groups with atlas texture
        this.bindGroups.terrain = this.device.createBindGroup({
            layout: this.pipelines.fill.getBindGroupLayout(1),
            entries: [
                { binding: 0, resource: atlas.texture.createView() },
                { binding: 1, resource: this.terrainSampler },
                { binding: 2, resource: { buffer: this.buffers.terrainBounds } }
            ],
        });
        
        this.bindGroups.pickingTerrain = this.device.createBindGroup({
            layout: this.pipelines.hidden.getBindGroupLayout(1),
            entries: [
                { binding: 0, resource: atlas.texture.createView() },
                { binding: 1, resource: this.terrainSampler },
                { binding: 2, resource: { buffer: this.buffers.terrainBounds } }
            ],
        });
    }
    
    // Add method to create textures with specific dimensions
    async createTextures(width, height) {
        // Store current dimensions
        this.textureWidth = width;
        this.textureHeight = height;
        
        // Wait for GPU to finish any pending operations before destroying textures
        if (this.textures.hidden) {
            await this.device.queue.onSubmittedWorkDone();
        }
        
        if (this.textures.hidden) {
            this.textures.hidden.destroy();
        }
        
        this.textures.hidden = this.device.createTexture({
            size: [width, height, 1],
            format: this.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
        });
        
        if (this.textures.color) {
            this.textures.color.destroy();
        }
        
        this.textures.color = this.device.createTexture({
            size: [width, height, 1],
            format: this.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        
        // Create MSAA color texture (4x multisampling)
        if (this.textures.colorMSAA) {
            this.textures.colorMSAA.destroy();
        }
        
        this.textures.colorMSAA = this.device.createTexture({
            size: [width, height, 1],
            format: this.format,
            sampleCount: 4,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        
        // Create depth texture for 3D rendering with MSAA
        if (this.textures.depth) {
            this.textures.depth.destroy();
        }
        
        this.textures.depth = this.device.createTexture({
            size: [width, height, 1],
            format: 'depth24plus',
            sampleCount: 4,  // Match MSAA sample count for color pass
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        
        // Create separate depth texture for hidden pass (no MSAA)
        if (this.textures.depthHidden) {
            this.textures.depthHidden.destroy();
        }
        
        this.textures.depthHidden = this.device.createTexture({
            size: [width, height, 1],
            format: 'depth24plus',
            sampleCount: 1,  // No MSAA for hidden buffer
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
    }
    
    // Add method to update texture dimensions when canvas size changes
    updateTextureDimensions(width, height) {
        // Only recreate if dimensions changed
        if (this.textureWidth !== width || this.textureHeight !== height) {
            this.createTextures(width, height);
            // Recreate any bind groups that reference the textures
            this.updateTextureBindGroups();
        }
    }
    
    // Update bind groups that use textures
    updateTextureBindGroups() {
        // Update the edgeDetection bind group
        this.bindGroups.edgeDetection = this.device.createBindGroup({
            layout: this.pipelines.edgeDetection.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: this.textures.color.createView() },
                { binding: 1, resource: this.textures.hidden.createView() },
                { binding: 2, resource: this.sampler },
                { binding: 3, resource: { buffer: this.buffers.canvasSize } },
                { binding: 4, resource: { buffer: this.buffers.pickedId } },
                { binding: 5, resource: { buffer: this.buffers.zoomInfo } },
                { binding: 6, resource: { buffer: this.buffers.pickedLayerId } },
                { binding: 7, resource: this.samplerNearest }  // Nearest sampler for ID texture
            ]
        });
        
        // Update debug bind group
        this.bindGroups.debug = this.device.createBindGroup({
            layout: this.pipelines.debug.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: this.textures.hidden.createView() }]
        });
    }
    
    // Fix the updateCameraTransform method to properly handle zoom levels
    updateCameraTransform(matrix) {
        // Debug only on significant changes
        if (!this._lastMatrix || Math.abs(matrix[0] - this._lastMatrix[0]) > 0.1 || Math.abs(matrix[12] - this._lastMatrix[12]) > 0.05) {
            // console.log('🎬 Matrix sent to GPU: translate[' + matrix[12].toFixed(3) + ', ' + matrix[13].toFixed(3) + '] scale[' + matrix[0].toFixed(3) + ', ' + matrix[5].toFixed(3) + ']');
            this._lastMatrix = Array.from(matrix);
        }
        
        // FIXED: Ensure we're using a plain array for logging
        const matrixArray = Array.from(matrix);
        
        // Skip excessive logging and only log on significant changes
        if (this._debugScale && Math.abs(this._debugScale - matrix[5]) > 0.5) {
            // Use readable format for debugging the matrix
          //  console.log(`Matrix scale changed from ${this._debugScale} to ${matrix[5]}`);
            this._debugScale = matrix[5];
        } else if (!this._debugScale) {
            this._debugScale = matrix[5];
        }
        
        // FIXED: Correctly log the matrix diagonal for debugging
        //console.log(`Matrix diagonal: [${matrix[0]}, ${matrix[5]}, ${matrix[10]}, ${matrix[15]}]`);
        
        // FIXED: Convert to Float32Array properly to ensure correct memory layout
        const matrixData = new Float32Array(matrix);
        
        // Write the matrix to the uniform buffer
        this.device.queue.writeBuffer(this.buffers.uniform, 0, matrixData);
        
        // Don't extract zoom from matrix - we don't have camera access here
        // This function should only update the matrix, zoom info updated elsewhere
    }
    
    // Add a new method to update zoom info
    updateZoomInfo(displayZoom, fetchZoom) {
        if (this.buffers.zoomInfo) {
            // Get the visual zoom from camera if possible - ensure we use the proper visual zoom
            let visualZoom = displayZoom;
            
            // Log significant visual zoom changes
            const logVisualZoom = Math.floor(visualZoom * 2) / 2; // Round to nearest 0.5
            
            if (this._lastLoggedVisualZoom !== logVisualZoom) {
                this._lastLoggedVisualZoom = logVisualZoom;
                
                // Update UI indicator with accurate values
                this.updateZoomIndicator(visualZoom, fetchZoom, displayZoom);
            }
            
            // CRITICAL FIX: Delay effect strength until much higher zoom (20+)
            // Scale from 0 at zoom 20 to 1.0 at zoom 35
            const effectStrength = Math.min(1.0, Math.max(0, (displayZoom - 20) / 15));
            
            // Always include zoom effect strength in the buffer
            this.device.queue.writeBuffer(
                this.buffers.zoomInfo, 
                0, 
                new Float32Array([
                    displayZoom,                  // Raw zoom value
                    fetchZoom,                    // Fetch zoom level
                    effectStrength,               // Effect strength for visual effects
                    displayZoom > 28 ? 1.0 : 0.0  // Flag for extreme zoom (increased from 20)
                ])
            );
        }
    }
    
    // Update the zoom indicator method to show both raw and visual zoom
    updateZoomIndicator(visualZoom, fetchZoom, rawZoom) {
        let indicator = document.getElementById('zoom-indicator');
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.id = 'zoom-indicator';
            indicator.style.position = 'absolute';
            indicator.style.bottom = '10px';
            indicator.style.right = '10px';
            indicator.style.backgroundColor = 'rgba(0,0,0,0.7)';
            indicator.style.color = 'white';
            indicator.style.padding = '5px 10px';
            indicator.style.borderRadius = '4px';
            indicator.style.fontFamily = 'monospace';
            indicator.style.fontSize = '16px';
            document.body.appendChild(indicator);
        }
        
        // Include both raw and effective visual zoom with better formatting
        const scalingFactor = visualZoom / rawZoom;
        indicator.textContent = `Zoom: ${rawZoom.toFixed(1)} → ${visualZoom.toFixed(1)} [${(scalingFactor*100).toFixed(0)}%]`;
        
        // Color-code the indicator based on zoom range
        let color = 'rgba(50,120,200,0.8)';  // Default blue
        if (rawZoom > 40) {
            color = 'rgba(200,50,50,0.8)';   // Red for very high zoom
        } else if (rawZoom > 24) {
            color = 'rgba(200,150,50,0.8)';  // Orange for high zoom
        }
        
        // Make it pulse briefly when zoom changes
        indicator.style.backgroundColor = color;
        setTimeout(() => {
            indicator.style.backgroundColor = 'rgba(0,0,0,0.7)';
        }, 300);
        
        // Add better visual indicator of zoom scale
        const zoomBar = document.createElement('div');
        zoomBar.style.marginTop = '4px';
        zoomBar.style.height = '4px';
        zoomBar.style.background = 'rgba(255,255,255,0.3)';
        zoomBar.style.position = 'relative';
        
        const zoomFill = document.createElement('div');
        zoomFill.style.position = 'absolute';
        zoomFill.style.left = '0';
        zoomFill.style.top = '0';
        zoomFill.style.height = '100%';
        zoomFill.style.width = `${Math.min(100, (rawZoom / 48) * 100)}%`;
        zoomFill.style.background = color;
        
        // Only update the bar if it doesn't exist
        if (!indicator.querySelector('.zoom-bar')) {
            zoomBar.classList.add('zoom-bar');
            zoomBar.appendChild(zoomFill);
            indicator.appendChild(zoomBar);
        } else {
            // Update existing bar
            const existingFill = indicator.querySelector('.zoom-bar > div');
            if (existingFill) {
                existingFill.style.width = `${Math.min(100, (rawZoom / 48) * 100)}%`;
                existingFill.style.background = color;
            }
        }
    }
    
    updatePickedFeature(featureId) {
        this.device.queue.writeBuffer(this.buffers.pickedId, 0, new Float32Array([featureId]));
    }
    
    // Add zoom effects for high zoom levels
    updateZoomEffects(zoomLevel) {
        // Implement visual effects for very high zoom levels
       // console.log(`Applying special effects for zoom level ${zoomLevel}`);
        
        // Calculate a scalar between 0 and 1 based on how far we are past zoom 15
        const effectStrength = Math.min(1.0, Math.max(0, (zoomLevel - 15) / 9));
        
        // Apply different visual effects based on zoom level ranges
        if (zoomLevel > 15 && this.buffers.zoomInfo) {
            // Store the effect strength in the zoomInfo buffer (in position 2 after the two zoom levels)
            // This will make it accessible to our shader
            const zoomData = new Float32Array([
                zoomLevel,                      // Display zoom level
                Math.min(Math.floor(zoomLevel), 6), // Fetch zoom level 
                effectStrength,                 // Effect strength for shader
                zoomLevel > 20 ? 1.0 : 0.0      // Boolean flag for extreme zoom
            ]);
            
            this.device.queue.writeBuffer(this.buffers.zoomInfo, 0, zoomData);
            
            // Update the UI with current zoom effect strength
            const indicator = document.getElementById('zoom-indicator');
            if (indicator) {
                indicator.style.borderLeft = `4px solid rgba(255,100,0,${effectStrength})`;
            }
        }
    }
    
    /**
     * Get or create an effect pipeline
     */
    getOrCreateEffectPipeline(effectType) {
        const pipelineKey = `effect-${effectType}`;
        
        if (!this.pipelines[pipelineKey]) {
            this.pipelines[pipelineKey] = this.effectManager.createEffectPipeline(effectType, this.format);
        }
        
        return this.pipelines[pipelineKey];
    }
    
    /**
     * Get or create bind group for effect pipeline
     */
    getOrCreateEffectBindGroup(effectType) {
        if (!this.effectBindGroups.has(effectType)) {
            const pipeline = this.getOrCreateEffectPipeline(effectType);
            if (pipeline) {
                this.effectBindGroups.set(
                    effectType,
                    this.effectManager.createEffectBindGroup(pipeline, this.buffers.uniform)
                );
            }
        }
        return this.effectBindGroups.get(effectType);
    }
    
    /**
     * Update animation time for effects
     */
    updateEffectTime(deltaTime) {
        this.effectManager.updateTime(deltaTime);
    }
    
    // Simplified rendering method for debug view
    renderDebugView() {
        const debugEncoder = this.device.createCommandEncoder();
        const debugPass = debugEncoder.beginRenderPass({
            colorAttachments: [{
                view: this.context.getCurrentTexture().createView(),
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
        });
        
        debugPass.setPipeline(this.pipelines.debug);
        debugPass.setBindGroup(0, this.bindGroups.debug);
        debugPass.draw(6);
        
        debugPass.end();
        this.device.queue.submit([debugEncoder.finish()]);
    }

    // After each render, force a validation for zoom scaling
    renderFrame(tileBuffers, camera) {
        // Validate that features are properly scaled with current zoom
        const scale = camera.getMatrix()[5]; // Y-scale from matrix
        
        // Ensure the vertex shader is using the correct matrix
        this.updateCameraTransform(camera.getMatrix());
        
        // Regular rendering code continues...
    }
    
    /**
     * Set global lighting parameters
     * @param {Object} options - Lighting options
     */
    setLighting(options) {
        if (options.sunDirection) {
            // Normalize sun direction
            const [x, y, z] = options.sunDirection;
            const len = Math.sqrt(x*x + y*y + z*z);
            this.lighting.sunDirection = [x/len, y/len, z/len];
        }
        if (options.ambientColor) {
            this.lighting.ambientColor = options.ambientColor;
        }
        if (options.diffuseColor) {
            this.lighting.diffuseColor = options.diffuseColor;
        }
        if (options.intensity !== undefined) {
            this.lighting.intensity = Math.max(0, Math.min(1, options.intensity));
        }
        if (options.timeOfDay !== undefined) {
            this.lighting.timeOfDay = options.timeOfDay;
        }
        if (options.isNight !== undefined) {
            this.lighting.isNight = options.isNight;
        }
        
        // Update the lighting portion of the terrain bounds buffer
        this.updateLightingBuffer();
    }
    
    /**
     * Update lighting data in GPU buffer
     */
    updateLightingBuffer() {
        const lightData = new Float32Array([
            this.lighting.sunDirection[0],
            this.lighting.sunDirection[1],
            this.lighting.sunDirection[2],
            this.lighting.intensity,
            this.lighting.ambientColor[0],
            this.lighting.ambientColor[1],
            this.lighting.ambientColor[2],
            this.lighting.isNight ? 1.0 : 0.0
        ]);
        // Write to offset 32 (after terrain bounds data)
        this.device.queue.writeBuffer(this.buffers.terrainBounds, 32, lightData);
    }
    
    /**
     * Set time of day with lighting presets
     * @param {number} hour - Hour of day (0-24)
     */
    setTimeOfDay(hour) {
        this.lighting.timeOfDay = hour;
        
        // Calculate sun position based on hour
        // Simplified: sun rises in east, sets in west
        // hour 6 = sunrise (east), hour 12 = noon (overhead-ish), hour 18 = sunset (west)
        const sunAngle = ((hour - 6) / 12) * Math.PI; // 0 at sunrise, PI at sunset
        
        if (hour >= 6 && hour <= 18) {
            // Daytime
            this.lighting.isNight = false;
            
            // Sun direction: more horizontal to light building walls
            // At noon, sun is at ~60 degrees elevation (not straight up)
            const maxElevation = Math.PI / 3;  // 60 degrees max elevation at noon
            const elevation = Math.sin(sunAngle) * maxElevation;  // 0 at sunrise/sunset, max at noon
            
            const sunX = -Math.cos(sunAngle) * Math.cos(elevation);  // East to West, reduced at noon
            const sunY = 0.4 * Math.cos(elevation);                   // From south
            const sunZ = Math.sin(elevation);                         // Up based on elevation
            
            // Normalize
            const len = Math.sqrt(sunX*sunX + sunY*sunY + sunZ*sunZ);
            this.lighting.sunDirection = [sunX/len, sunY/len, sunZ/len];
            
            // Color temperature based on sun height
            if (hour < 8 || hour > 16) {
                // Golden hour - warm light
                this.lighting.diffuseColor = [1.0, 0.85, 0.6];
                this.lighting.ambientColor = [0.35, 0.3, 0.35];
                this.lighting.intensity = 0.85;
            } else {
                // Midday - neutral to slightly cool
                this.lighting.diffuseColor = [1.0, 0.98, 0.92];
                this.lighting.ambientColor = [0.35, 0.38, 0.45];
                this.lighting.intensity = 1.0;
            }
        } else {
            // Nighttime
            this.lighting.isNight = true;
            // Moon-like direction (low angle from upper right)
            this.lighting.sunDirection = [0.5, 0.3, 0.4];
            // Cool, blue-tinted night
            this.lighting.diffuseColor = [0.2, 0.25, 0.4];
            this.lighting.ambientColor = [0.08, 0.1, 0.18];
            this.lighting.intensity = 0.3;
        }
        
        this.updateLightingBuffer();
    }
    
    /**
     * Get current lighting state
     */
    getLighting() {
        return { ...this.lighting };
    }
}
