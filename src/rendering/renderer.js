import { 
    vertexShaderCode, fragmentShaderCode, hiddenFragmentShaderCode, hiddenVertexShaderCode,
    edgeDetectionVertexShaderCode, edgeDetectionFragmentShaderCode,
    debugVertexShaderCode, debugFragmentShaderCode 
} from '../shaders/shaders.js';
import { GPUTextRenderer } from '../text/gpuTextRenderer.js';
import { ShaderEffectManager } from '../core/shaderEffectManager.js';

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

// Initialize all shader modules that will be used
function initCachedShaders(device) {
    if (!cachedShaders.initialized) {
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
export function createRenderPipeline(device, format, topology, isHidden = false, depthBias = 0) {
    initCachedShaders(device);
    
    // Create and cache layout for render pipelines
    if (!cachedLayouts.render) {
        cachedLayouts.render = device.createBindGroupLayout({
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                buffer: { type: "uniform" }
            }]
        });
    }
    
    const pipelineLayout = device.createPipelineLayout({ 
        bindGroupLayouts: [cachedLayouts.render] 
    });
    
    return device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: {
            module: isHidden ? cachedShaders.hiddenVertex : cachedShaders.vertex,
            entryPoint: "main",
            buffers: [{
                arrayStride: 28,
                attributes: [
                    { shaderLocation: 0, offset: 0, format: 'float32x3' },
                    { shaderLocation: 1, offset: 12, format: 'float32x4' }
                ]
            }],
        },
        fragment: {
            module: isHidden ? cachedShaders.hiddenFragment : cachedShaders.fragment,
            entryPoint: "main",
            targets: [{
                format: format,
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
            depthWriteEnabled: true,
            depthCompare: 'less-equal',  // Allow equal depth to overwrite based on draw order
            ...(depthBias !== 0 && topology !== 'line-list' ? {
                depthBias: depthBias,
                depthBiasSlopeScale: 1.0
            } : {})
        },
        multisample: { count: isHidden ? 1 : 4 }  // No MSAA for hidden buffer (exact feature IDs needed)
    });
}

// Create edge detection pipeline
export function createEdgeDetectionPipeline(device, format) {
    initCachedShaders(device);
    
    // FORCE: Recreate layout due to new binding 6 (pickedLayerId)
    // Cache bind group layout for edge detection
    cachedLayouts.edgeDetection = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
            { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            { binding: 6, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }
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
        
        // Initialize shader effect manager
        this.effectManager = new ShaderEffectManager(device);
        this.effectBindGroups = new Map(); // Cache bind groups for effects
        
        // Initialize pipelines
        this.initializePipelines();
    }
    
    initializePipelines() {
        // Create main rendering pipelines
        // Regular fill pipeline - no depth bias for normal rendering
        this.pipelines.fill = createRenderPipeline(this.device, this.format, "triangle-list", false, 0);
        // Fill with depth bias - ONLY for fills that have a corresponding extrusion
        this.pipelines.fillWithBias = createRenderPipeline(this.device, this.format, "triangle-list", false, 100);
        // Extrusion pipeline without depth bias - renders at true depth
        this.pipelines.extrusion = createRenderPipeline(this.device, this.format, "triangle-list", false, 0);
        this.pipelines.outline = createRenderPipeline(this.device, this.format, "line-list", false, 0);
        this.pipelines.hidden = createRenderPipeline(this.device, this.format, "triangle-list", true, 0);
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
        
        // Create sampler
        this.sampler = this.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
        });
        
        // Create bind groups
        this.bindGroups.main = this.device.createBindGroup({
            layout: this.pipelines.fill.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: this.buffers.uniform } }],
        });
        
        this.bindGroups.picking = this.device.createBindGroup({
            layout: this.pipelines.hidden.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: this.buffers.uniform } }],
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
                { binding: 6, resource: { buffer: this.buffers.pickedLayerId } }
            ]
        });
        
        this.bindGroups.debug = this.device.createBindGroup({
            layout: this.pipelines.debug.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: this.textures.hidden.createView() }]
        });
        
        // Update initial camera transform
        this.updateCameraTransform(camera.getMatrix());
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
                { binding: 6, resource: { buffer: this.buffers.pickedLayerId } }
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
}
