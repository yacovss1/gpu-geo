/**
 * RenderingUtils - Core rendering functions for map, markers, and compute passes
 * 
 * Responsibilities:
 * - Render map with hidden texture and edge detection
 * - Create compute marker encoders (3-pass centroid calculation)
 * - Render markers to encoder
 * - Initialize marker resources (pipelines, buffers)
 * - Read marker buffer data
 */

import { getStyle, getLayer, parseColor } from '../core/style.js';

// Constants for marker computation
const MAX_FEATURES = 65535;
const MARKER_BUFFER_SIZE = MAX_FEATURES * 40;

/**
 * Render the map with hidden texture and edge detection
 * @param {GPUDevice} device 
 * @param {MapRenderer} renderer 
 * @param {Map} tileBuffers 
 * @param {Map} hiddenTileBuffers 
 * @param {GPUTextureView} textureView 
 * @param {Camera} camera 
 * @param {Function} shouldRenderLayer 
 * @param {TerrainLayer} terrainLayer - Optional terrain layer to render first
 */
export function renderMap(device, renderer, tileBuffers, hiddenTileBuffers, textureView, camera, shouldRenderLayer, terrainLayer = null) {
    const mapCommandEncoder = device.createCommandEncoder();
    
    // Get style once for all render passes
    const style = getStyle();
    
    // First render pass: hidden texture for feature IDs (no MSAA - needs exact values)
    const hiddenPass = mapCommandEncoder.beginRenderPass({
        colorAttachments: [{
            view: renderer.textures.hidden.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
        }],
        depthStencilAttachment: {
            view: renderer.textures.depthHidden.createView(),
            depthClearValue: 1.0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
        }
    });
    
    const renderZoom = camera.zoom;
    
    // Check for fills with extrusions (need depth bias) - same logic as color pass
    const fillsWithExtrusions = new Set();
    if (style?.layers) {
        for (const extrusionLayer of style.layers.filter(l => l.type === 'fill-extrusion')) {
            const matchingFills = style.layers.filter(l => 
                l.type === 'fill' &&
                l.source === extrusionLayer.source &&
                l['source-layer'] === extrusionLayer['source-layer']
            );
            matchingFills.forEach(f => fillsWithExtrusions.add(f.id));
        }
    }
    
    // Render hidden buffers in style layer order (same as color pass)
    // CRITICAL: Must use matching depth bias as color pass for consistent depth testing
    if (style?.layers) {
        for (const layer of style.layers) {
            const layerId = layer.id;
            const layerType = layer.type;
            
            if (!shouldRenderLayer(layerId, renderZoom)) continue;
            
            const buffers = hiddenTileBuffers.get(layerId);
            if (!buffers) continue;
            
            // Determine if this layer needs depth bias (same logic as color pass)
            // 2D layers use flat pipeline (painter's algorithm) to avoid z-fighting on terrain
            const useBias = layerType === 'fill' && fillsWithExtrusions.has(layerId);
            const is3DLayer = layerType === 'fill-extrusion' || layerType === 'line-extrusion';
            const hiddenPipeline = useBias ? renderer.pipelines.hiddenWithBias : 
                                   (is3DLayer ? renderer.pipelines.hidden : renderer.pipelines.hiddenFlat);
            
            buffers.forEach(({ vertexBuffer, hiddenFillIndexBuffer, hiddenfillIndexCount }) => {
                if (hiddenfillIndexCount > 0) {
                    hiddenPass.setPipeline(hiddenPipeline);
                    hiddenPass.setVertexBuffer(0, vertexBuffer);
                    hiddenPass.setIndexBuffer(hiddenFillIndexBuffer, "uint32");
                    hiddenPass.setBindGroup(0, renderer.bindGroups.picking);
                    // Set terrain bind group for GPU terrain projection
                    if (renderer.bindGroups.pickingTerrain) {
                        hiddenPass.setBindGroup(1, renderer.bindGroups.pickingTerrain);
                    }
                    hiddenPass.drawIndexed(hiddenfillIndexCount);
                }
            });
        }
    }
    
    hiddenPass.end();
    
    // Get background color from style
    const currentMapStyle = getStyle();
    let clearColor = { r: 0.67, g: 0.83, b: 0.87, a: 1.0 };
    if (currentMapStyle?.layers) {
        const backgroundLayer = currentMapStyle.layers.find(l => l.type === 'background');
        if (backgroundLayer?.paint?.['background-color']) {
            const bgColorArray = parseColor(backgroundLayer.paint['background-color']);
            if (bgColorArray) {
                clearColor = {
                    r: bgColorArray[0],
                    g: bgColorArray[1],
                    b: bgColorArray[2],
                    a: bgColorArray[3]
                };
            }
        }
    }
    
    // Third render pass: color texture with map features (MSAA enabled)
    const colorPass = mapCommandEncoder.beginRenderPass({
        colorAttachments: [{
            view: renderer.textures.colorMSAA.createView(),
            resolveTarget: renderer.textures.color.createView(),
            clearValue: clearColor,
            loadOp: 'clear',
            storeOp: 'store',
        }],
        depthStencilAttachment: {
            view: renderer.textures.depth.createView(),
            depthClearValue: 1.0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
        }
    });
    
    // fillsWithExtrusions already computed above for hidden pass
    
    // Render ALL geometry in true style order
    if (style?.layers) {
        for (const layer of style.layers) {
            const layerId = layer.id;
            const layerType = layer.type;
            
            if (!shouldRenderLayer(layerId, renderZoom)) continue;
            
            const buffers = tileBuffers.get(layerId);
            if (!buffers) continue;
            
            // Check for shader effects in layer metadata
            const effectType = layer.metadata?.['shader-effects']?.type;
            
            buffers.forEach(({ vertexBuffer, fillIndexBuffer, fillIndexCount, isLine }) => {
                if ((layerType === 'fill-extrusion' || layerType === 'line-extrusion') && fillIndexCount > 0) {
                    // Check if extrusion has glass effect
                    let pipeline, bindGroup;
                    if (effectType === 'glass') {
                        pipeline = renderer.getOrCreateEffectPipeline('glass');
                        bindGroup = renderer.bindGroups.main; // Glass uses standard bind group
                    } else {
                        pipeline = renderer.pipelines.extrusion;
                        bindGroup = renderer.bindGroups.main;
                    }
                    
                    colorPass.setPipeline(pipeline);
                    colorPass.setVertexBuffer(0, vertexBuffer);
                    colorPass.setIndexBuffer(fillIndexBuffer, "uint32");
                    colorPass.setBindGroup(0, bindGroup);
                    // Set terrain bind group for GPU terrain projection
                    // Glass uses standard vertex shader which requires terrain bind group
                    if (renderer.bindGroups.terrain) {
                        colorPass.setBindGroup(1, renderer.bindGroups.terrain);
                    }
                    colorPass.drawIndexed(fillIndexCount);
                } else if (layerType === 'fill' && fillIndexCount > 0) {
                    // Check for water or grass effects
                    let pipeline, bindGroup;
                    if (effectType === 'animated-water' || effectType === 'grass') {
                        pipeline = renderer.getOrCreateEffectPipeline(effectType);
                        bindGroup = renderer.getOrCreateEffectBindGroup(effectType);
                    } else {
                        const useBias = fillsWithExtrusions.has(layerId);
                        // Use flat pipeline (no depth test) for 2D fills - painter's algorithm on terrain
                        pipeline = useBias ? renderer.pipelines.fillWithBias : renderer.pipelines.flat;
                        bindGroup = renderer.bindGroups.main;
                    }
                    
                    colorPass.setPipeline(pipeline);
                    colorPass.setVertexBuffer(0, vertexBuffer);
                    colorPass.setIndexBuffer(fillIndexBuffer, "uint32");
                    colorPass.setBindGroup(0, bindGroup);
                    // Set terrain bind group for GPU terrain projection (all fill layers need this)
                    if (renderer.bindGroups.terrain) {
                        colorPass.setBindGroup(1, renderer.bindGroups.terrain);
                    }
                    colorPass.drawIndexed(fillIndexCount);
                } else if (layerType === 'line' && isLine && fillIndexCount > 0) {
                    // Skip if this is a tube layer (will be rendered by tubePipeline)
                    const layer = style?.layers?.find(l => l.id === layerId);
                    const isTubeLayer = layer?.metadata?.['render-as-tubes'] === true;
                    
                    if (!isTubeLayer) {
                        // Use flat pipeline (no depth test) for 2D lines - painter's algorithm on terrain
                        colorPass.setPipeline(renderer.pipelines.flat);
                        colorPass.setVertexBuffer(0, vertexBuffer);
                        colorPass.setIndexBuffer(fillIndexBuffer, "uint32");
                        colorPass.setBindGroup(0, renderer.bindGroups.main);
                        // Set terrain bind group for GPU terrain projection
                        if (renderer.bindGroups.terrain) {
                            colorPass.setBindGroup(1, renderer.bindGroups.terrain);
                        }
                        colorPass.drawIndexed(fillIndexCount);
                    }
                }
            });
        }
    }
    
    // Render 3D tubes/pipes for layers with render-as-tubes metadata
    if (style?.layers && renderer.tubePipeline) {
        for (const layer of style.layers) {
            const hasTubeMetadata = layer.metadata?.['render-as-tubes'] === true;
            if (hasTubeMetadata && shouldRenderLayer(layer.id, renderZoom)) {
                renderer.tubePipeline.render(colorPass, tileBuffers, layer, renderZoom);
            }
        }
    }
    
    // Render terrain hillshade AFTER vectors as a multiplicative overlay
    // This applies shading (darken slopes, brighten ridges) on top of vector colors
    if (terrainLayer && terrainLayer.enabled) {
        terrainLayer.renderOverlay(colorPass, camera.getMatrix(), camera, renderZoom);
    }
    
    colorPass.end();
    
    // Fourth render pass: Apply edge detection to screen (DISABLED - skip outlines)
    // Just copy the color texture directly to screen without edge detection
    const mainPass = mapCommandEncoder.beginRenderPass({
        colorAttachments: [{
            view: textureView,
            clearValue: clearColor,
            loadOp: 'clear',
            storeOp: 'store',
        }],
    });
    
    // Draw color texture directly without edge detection
    mainPass.setPipeline(renderer.pipelines.edgeDetection);
    mainPass.setBindGroup(0, renderer.bindGroups.edgeDetection);
    mainPass.draw(3);
    mainPass.end();
    
    return mapCommandEncoder;
}

/**
 * Create compute marker encoder (3-pass centroid calculation)
 */
export function createComputeMarkerEncoder(
    device,
    renderer,
    accumulatorPipeline,
    quadrantPipeline,
    centerPipeline,
    accumulatorBuffer,
    quadrantBuffer,
    markerBuffer,
    dimsBuffer,
    canvas,
    regionsBuffer
) {
    if (!window._computeStartLogged) {
        console.log('🎯 Starting marker compute passes...');
        window._computeStartLogged = true;
    }
    
    const ACCUMULATOR_BUFFER_SIZE = MAX_FEATURES * 28;
    const QUADRANT_BUFFER_SIZE = MAX_FEATURES * 108;
    
    // Reset buffers
    device.queue.writeBuffer(accumulatorBuffer, 0, new Uint8Array(ACCUMULATOR_BUFFER_SIZE));
    device.queue.writeBuffer(quadrantBuffer, 0, new Uint8Array(QUADRANT_BUFFER_SIZE));
    
    // Update dimensions
    const hiddenWidth = renderer.textures.hidden.width;
    const hiddenHeight = renderer.textures.hidden.height;
    device.queue.writeBuffer(dimsBuffer, 0, new Uint32Array([hiddenWidth, hiddenHeight]));
    
    const workgroupCountX = Math.ceil(canvas.width / 16);
    const workgroupCountY = Math.ceil(canvas.height / 16);
    
    // Pass 1: Accumulate centroid and bounding box
    const encoder1 = device.createCommandEncoder();
    const computePass1 = encoder1.beginComputePass();
    computePass1.setPipeline(accumulatorPipeline);
    computePass1.setBindGroup(0, device.createBindGroup({
        layout: accumulatorPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: renderer.textures.hidden.createView() },
            { binding: 1, resource: { buffer: accumulatorBuffer } }
        ]
    }));
    computePass1.dispatchWorkgroups(workgroupCountX, workgroupCountY);
    computePass1.end();
    device.queue.submit([encoder1.finish()]);
    
    // Pass 2: Calculate quadrant centroids
    const encoder2 = device.createCommandEncoder();
    const computePass2 = encoder2.beginComputePass();
    computePass2.setPipeline(quadrantPipeline);
    computePass2.setBindGroup(0, device.createBindGroup({
        layout: quadrantPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: renderer.textures.hidden.createView() },
            { binding: 1, resource: { buffer: accumulatorBuffer } },
            { binding: 2, resource: { buffer: quadrantBuffer } }
        ]
    }));
    computePass2.dispatchWorkgroups(workgroupCountX, workgroupCountY);
    computePass2.end();
    device.queue.submit([encoder2.finish()]);
    
    // Pass 3: Calculate final marker positions
    const encoder3 = device.createCommandEncoder();
    const computePass3 = encoder3.beginComputePass();
    computePass3.setPipeline(centerPipeline);
    computePass3.setBindGroup(0, device.createBindGroup({
        layout: centerPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: accumulatorBuffer } },
            { binding: 1, resource: { buffer: quadrantBuffer } },
            { binding: 2, resource: { buffer: markerBuffer } },
            { binding: 3, resource: { buffer: dimsBuffer } },
            { binding: 4, resource: renderer.textures.hidden.createView() }
            // Heights buffer removed - reading height from hiddenTex alpha channel
        ]
    }));
    const workgroupCount3 = Math.ceil(10000 / 64);
    computePass3.dispatchWorkgroups(workgroupCount3);
    computePass3.end();
    
    const commandBuffer = encoder3.finish();
    device.queue.submit([commandBuffer]);
    
    // Debug: Log marker computation completion
    if (!window._markerComputeLogged) {
        console.log(`🎯 Marker compute: Pass 1 (accumulator), Pass 2 (quadrants), Pass 3 (centers) - complete`);
        console.log(`   Texture size: hidden=${renderer.textures.hidden.width}x${renderer.textures.hidden.height}`);
        window._markerComputeLogged = true;
    }
}

// Cache the triangle buffer so we don't recreate it every frame
let cachedTriangleBuffer = null;

/**
 * Render markers using pre-computed positions
 */
export function renderMarkersToEncoder(
    encoder,
    textureView,
    device,
    markerPipeline,
    markerBuffer,
    markerBindGroupLayout,
    cameraUniformBuffer,
    zoomInfoBuffer
) {
    // Create triangle buffer once and reuse it
    if (!cachedTriangleBuffer) {
        const triangleData = new Float32Array([
            -0.5,  0.5,  // Top-left
             0.5,  0.5,  // Top-right
             0.0, -0.5   // Bottom point (pointing down)
        ]);
        
        const bufferSize = Math.max(256, triangleData.byteLength);
        cachedTriangleBuffer = device.createBuffer({
            size: bufferSize,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true
        });
        new Float32Array(cachedTriangleBuffer.getMappedRange()).set(triangleData);
        cachedTriangleBuffer.unmap();
    }
    
    const markerPass = encoder.beginRenderPass({
        colorAttachments: [{
            view: textureView,
            loadOp: 'load',
            storeOp: 'store'
        }]
    });
    
    markerPass.setPipeline(markerPipeline);
    markerPass.setVertexBuffer(0, cachedTriangleBuffer);
    markerPass.setVertexBuffer(1, markerBuffer);
    markerPass.setBindGroup(0, device.createBindGroup({
        layout: markerBindGroupLayout,
        entries: [
            { binding: 0, resource: { buffer: cameraUniformBuffer } },
            { binding: 1, resource: { buffer: markerBuffer } },
            { binding: 2, resource: { buffer: zoomInfoBuffer } }
        ]
    }));
    markerPass.draw(3, MAX_FEATURES, 0, 0);
    markerPass.end();
    
    // Debug: Log marker rendering
    if (!window._markerRenderLogged) {
        console.log(`🎨 Marker render pass: drawing ${MAX_FEATURES} instances`);
        window._markerRenderLogged = true;
    }
}

/**
 * Read marker buffer synchronously (for next frame caching)
 */
export async function readMarkerBufferSync(device, markerBuffer) {
    try {
        const readBuffer = device.createBuffer({
            size: MARKER_BUFFER_SIZE,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });
        
        const copyEncoder = device.createCommandEncoder();
        copyEncoder.copyBufferToBuffer(markerBuffer, 0, readBuffer, 0, MARKER_BUFFER_SIZE);
        device.queue.submit([copyEncoder.finish()]);
        
        await readBuffer.mapAsync(GPUMapMode.READ);
        const data = new Float32Array(readBuffer.getMappedRange()).slice();
        readBuffer.unmap();
        readBuffer.destroy();
        
        // DEBUG: Check for valid markers
        if (!window._markerDataLogged) {
            let validCount = 0;
            const MARKER_STRIDE = 10; // 10 floats per marker
            for (let i = 0; i < 100; i++) { // Check first 100 features
                const offset = i * MARKER_STRIDE;
                const centerX = data[offset];
                const centerY = data[offset + 1];
                const height = data[offset + 2];
                const featureId = data[offset + 8];
                
                if (centerX > -10 && centerX < 10 && centerY > -10 && centerY < 10) {
                    validCount++;
                    if (validCount <= 5) {
                        console.log(`  Marker ${i}: center=(${centerX.toFixed(3)}, ${centerY.toFixed(3)}) height=${height.toFixed(1)}m fid=${featureId}`);
                    }
                }
            }
            console.log(`📊 Marker buffer: ${validCount} valid markers found (first 100 checked)`);
            window._markerDataLogged = true;
        }
        
        return data;
    } catch (err) {
        console.error('Error reading markers:', err);
        return null;
    }
}

/**
 * Initialize marker resources (pipelines, buffers)
 */
export function initMarkerResources(device, format, canvas, camera, createAccumulatorPipeline, createQuadrantPipeline, createCenterPipeline, createMarkerPipeline) {
    const ACCUMULATOR_BUFFER_SIZE = MAX_FEATURES * 28;
    const QUADRANT_BUFFER_SIZE = MAX_FEATURES * 108;
    const REGIONS_BUFFER_SIZE = MAX_FEATURES * 16;
    
    // Create compute pipelines
    const accumulatorPipeline = createAccumulatorPipeline(device);
    const quadrantPipeline = createQuadrantPipeline(device);
    const centerPipeline = createCenterPipeline(device);
    
    // Create storage buffers
    const accumulatorBuffer = device.createBuffer({
        size: ACCUMULATOR_BUFFER_SIZE,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    
    const quadrantBuffer = device.createBuffer({
        size: QUADRANT_BUFFER_SIZE,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    
    const markerBuffer = device.createBuffer({
        size: MARKER_BUFFER_SIZE,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC,
    });
    
    const dimsBuffer = device.createBuffer({
        size: 8,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(dimsBuffer, 0, new Uint32Array([canvas.width, canvas.height]));
    
    const { pipeline: markerPipeline, bindGroupLayout: markerBindGroupLayout } = createMarkerPipeline(device, format);
    
    const regionsBuffer = device.createBuffer({
        size: REGIONS_BUFFER_SIZE,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    return {
        accumulatorPipeline,
        quadrantPipeline,
        centerPipeline,
        markerPipeline,
        markerBuffer,
        accumulatorBuffer,
        quadrantBuffer,
        dimsBuffer,
        regionsBuffer,
        markerBindGroupLayout
    };
}
