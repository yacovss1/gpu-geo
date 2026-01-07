// GPU-Native Text Renderer using Instanced Rendering
// Generates all quads on GPU, single draw call for all labels

import { getSymbolLayers } from '../core/style.js';
import { textShaderCode } from '../shaders/textShaders.js';
import { LabelCollisionDetector } from './labelCollisionDetector.js';

const MAX_LABELS = 10000;
const MAX_CHARS_PER_LABEL = 32;
const MAX_TOTAL_CHARS = MAX_LABELS * MAX_CHARS_PER_LABEL;

// Label placement modes
export const LabelMode = {
    DIRECT: 0,      // Place directly on feature (no offset)
    OFFSET_3D: 1,   // Offset in 3D space with leader line
    HIDDEN: 2       // Don't render (too crowded)
};

/**
 * GPU-Native TextRenderer - all geometry generation happens on GPU
 */
export class GPUTextRenderer {
    constructor(device) {
        this.device = device;
        this.fontAtlas = null;
        this.fontMetrics = null;
        this.pipeline = null;
        this.bindGroup = null;
        this.labelBuffer = null;      // Storage: label metadata (position, length, etc.)
        this.textBuffer = null;        // Storage: packed character data
        this.charMetricsBuffer = null; // Storage: UV coords for each char
        this.initialized = false;
        this.labelCount = 0;
        this.totalCharCount = 0;  // Track actual character count
        this.collisionDetector = new LabelCollisionDetector();
        this.cachedMarkerPositions = new Map(); // Cache marker positions to avoid reading every frame
        this.isReadingMarkers = false;
    }

    /**
     * Initialize the GPU text renderer
     */
    async initialize(fontFamily = 'Arial', fontSize = 48) {
        try {
            // Generate font atlas texture
            const { texture, metrics } = await this.generateFontAtlas(fontFamily, fontSize);
            this.fontAtlas = texture;
            this.fontMetrics = metrics;
            
            // Create storage buffers
            // Label buffer layout (48 bytes per label):
            // - featureId: u32 (4 bytes)
            // - charStart: u32 (4 bytes)
            // - charCount: u32 (4 bytes)
            // - mode: u32 (4 bytes) - DIRECT, OFFSET_3D, or HIDDEN
            // - anchorPos: vec3<f32> (12 bytes) - feature's 3D position
            // - offsetVector: vec3<f32> (12 bytes) - displacement from anchor
            // - padding: vec2<f32> (8 bytes) - alignment
            this.labelBuffer = this.device.createBuffer({
                size: MAX_LABELS * 48, // 12 floats per label (expanded for 3D data)
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            });
            
            this.textBuffer = this.device.createBuffer({
                size: MAX_TOTAL_CHARS * 4, // 1 u32 per char (ASCII value)
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            });
            
            // Pack character metrics into buffer for GPU access
            const metricsData = new Float32Array(128 * 6); // 128 ASCII chars, 6 floats each (u0,v0,u1,v1,width,advance)
            for (let i = 32; i < 128; i++) {
                const char = String.fromCharCode(i);
                const m = metrics[char];
                if (m) {
                    const idx = i * 6;
                    metricsData[idx + 0] = m.u0;
                    metricsData[idx + 1] = m.v0;
                    metricsData[idx + 2] = m.u1;
                    metricsData[idx + 3] = m.v1;
                    metricsData[idx + 4] = m.width;
                    metricsData[idx + 5] = m.advance;
                }
            }
            
            this.charMetricsBuffer = this.device.createBuffer({
                size: metricsData.byteLength,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            });
            this.device.queue.writeBuffer(this.charMetricsBuffer, 0, metricsData);

            // Create shader module
            const shaderModule = this.device.createShaderModule({
                code: textShaderCode
            });

            // Create bind group layouts
            const textureBindGroupLayout = this.device.createBindGroupLayout({
                entries: [
                    { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
                    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }
                ]
            });

            const dataBindGroupLayout = this.device.createBindGroupLayout({
                entries: [
                    { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },          // camera matrix
                    { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }, // markers
                    { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }, // labels
                    { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }, // text
                    { binding: 4, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }, // char metrics
                ]
            });

            const pipelineLayout = this.device.createPipelineLayout({
                bindGroupLayouts: [textureBindGroupLayout, dataBindGroupLayout]
            });

            // Create pipeline (no vertex buffers! All data from storage buffers)
            this.pipeline = this.device.createRenderPipeline({
                layout: pipelineLayout,
                vertex: {
                    module: shaderModule,
                    entryPoint: 'vertexMain',
                    buffers: [] // No vertex buffers - generate geometry in shader!
                },
                fragment: {
                    module: shaderModule,
                    entryPoint: 'fragmentMain',
                    targets: [{
                        format: navigator.gpu.getPreferredCanvasFormat(),
                        blend: {
                            color: {
                                srcFactor: 'src-alpha',
                                dstFactor: 'one-minus-src-alpha',
                                operation: 'add'
                            },
                            alpha: {
                                srcFactor: 'one',
                                dstFactor: 'one-minus-src-alpha',
                                operation: 'add'
                            }
                        }
                    }]
                },
                primitive: {
                    topology: 'triangle-list',
                    cullMode: 'none'
                }
            });
            
            // Create sampler
            const sampler = this.device.createSampler({
                magFilter: 'linear',
                minFilter: 'linear'
            });

            this.textureBindGroup = this.device.createBindGroup({
                layout: textureBindGroupLayout,
                entries: [
                    { binding: 0, resource: sampler },
                    { binding: 1, resource: this.fontAtlas.createView() }
                ]
            });
            
            this.initialized = true;
            console.log('✅ GPU-Native TextRenderer initialized');
        } catch (error) {
            console.error('❌ GPUTextRenderer initialization failed:', error);
            throw error;
        }
    }

    /**
     * Generate font atlas (same as before - this part is fine on CPU)
     */
    async generateFontAtlas(fontFamily, fontSize) {
        let chars = '';
        for (let i = 32; i <= 127; i++) {
            chars += String.fromCharCode(i);
        }
        
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        
        const gridCols = 16;
        const gridRows = 6;
        const cellSize = 64;
        canvas.width = gridCols * cellSize;
        canvas.height = gridRows * cellSize;
        
        ctx.font = `${fontSize}px ${fontFamily}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'white';
        
        const metrics = {};
        
        for (let i = 0; i < chars.length; i++) {
            const char = chars[i];
            const col = i % gridCols;
            const row = Math.floor(i / gridCols);
            
            const x = col * cellSize + cellSize / 2;
            const y = row * cellSize + cellSize / 2;
            
            ctx.fillText(char, x, y);
            
            metrics[char] = {
                u0: col / gridCols,
                v0: row / gridRows,
                u1: (col + 1) / gridCols,
                v1: (row + 1) / gridRows,
                width: ctx.measureText(char).width / fontSize,
                advance: ctx.measureText(char).width / fontSize + 0.1
            };
        }
        
        const texture = this.device.createTexture({
            size: [canvas.width, canvas.height, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
        });
        
        this.device.queue.copyExternalImageToTexture(
            { source: canvas },
            { texture: texture },
            [canvas.width, canvas.height]
        );
        
        return { texture, metrics };
    }

    /**
     * Upload label data to GPU - called once per frame
     * Uses cached marker positions from previous frame for collision detection (non-blocking)
     */
    uploadLabelData(featureNames, camera, sourceId = null, markerBuffer = null) {
        if (!this.initialized || featureNames.size === 0) {
            this.labelCount = 0;
            return;
        }

        // Filter labels based on zoom and symbol-placement
        const symbolLayers = sourceId ? getSymbolLayers(sourceId) : [];
        const currentZoom = camera ? camera.zoom : 0;
        
        // First pass: collect label candidates for collision detection
        const labelCandidates = [];
        const textData = [];
        let charOffset = 0;
        
        // Collect label candidates
        for (const [featureId, featureData] of featureNames) {
            const name = typeof featureData === 'string' ? featureData : featureData.name;
            const sourceLayer = typeof featureData === 'object' ? featureData.sourceLayer : null;
            
            // Check zoom-based filtering and symbol-placement
            let shouldRender = true;
            if (symbolLayers.length > 0) {
                const matchingLayer = symbolLayers.find(layer => {
                    // Only render point-placed symbols (not line-placed)
                    const isPointPlacement = layer.symbolPlacement === 'point';
                    // Match by source-layer directly
                    const layerMatches = layer.sourceLayer === sourceLayer;
                    const zoomMatches = currentZoom >= layer.minzoom && currentZoom <= layer.maxzoom;
                    return isPointPlacement && layerMatches && zoomMatches;
                });
                shouldRender = !!matchingLayer;
                
                // Debug building labels
                if (!window._buildingLabelFilterLogged && sourceLayer === 'building') {
                    console.log('🏷️ Building label filter check:', {
                        sourceLayer,
                        currentZoom,
                        symbolLayers: symbolLayers.map(l => ({ 
                            id: l.id, 
                            sourceLayer: l.sourceLayer, 
                            symbolPlacement: l.symbolPlacement,
                            minzoom: l.minzoom, 
                            maxzoom: l.maxzoom 
                        })),
                        matchingLayer: matchingLayer?.id,
                        shouldRender
                    });
                    window._buildingLabelFilterLogged = true;
                }
            } else {
                shouldRender = currentZoom > 2;
            }
            
            if (!shouldRender) continue;
            
            // Limit label length
            const labelText = name.substring(0, MAX_CHARS_PER_LABEL);
            
            labelCandidates.push({
                featureId,
                text: labelText,
                sourceLayer,
                priority: 0  // Will be set by collision detector
            });
            
            if (labelCandidates.length >= MAX_LABELS) break;
        }
        
        // Update cached marker positions asynchronously (non-blocking)
        if (markerBuffer && labelCandidates.length > 0 && !this.isReadingMarkers) {
            this.isReadingMarkers = true;
            
            // Read marker positions in background without blocking render
            (async () => {
                try {
                    const stagingBuffer = this.device.createBuffer({
                        size: markerBuffer.size,
                        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
                    });
                    
                    const encoder = this.device.createCommandEncoder();
                    encoder.copyBufferToBuffer(markerBuffer, 0, stagingBuffer, 0, markerBuffer.size);
                    this.device.queue.submit([encoder.finish()]);
                    
                    await this.device.queue.onSubmittedWorkDone();
                    await stagingBuffer.mapAsync(GPUMapMode.READ);
                    
                    const markerData = new Float32Array(stagingBuffer.getMappedRange());
                    const newPositions = new Map();
                    
                    const MARKER_STRIDE = 10;
                    for (let i = 0; i < Math.min(65535, markerData.length / MARKER_STRIDE); i++) {
                        const offset = i * MARKER_STRIDE;
                        const centerX = markerData[offset];
                        const centerY = markerData[offset + 1];
                        const height = markerData[offset + 2];
                        const featureId = Math.round(markerData[offset + 8]);
                        
                        if (centerX !== 0 || centerY !== 0) {
                            newPositions.set(featureId, {
                                x: centerX,
                                y: centerY,
                                z: height
                            });
                        }
                    }
                    
                    this.cachedMarkerPositions = newPositions;
                    stagingBuffer.unmap();
                    stagingBuffer.destroy();
                } catch (error) {
                    console.error('❌ Failed to read marker buffer:', error);
                } finally {
                    this.isReadingMarkers = false;
                }
            })();
        }
        
        // Run collision detection with cached marker positions (from previous frame)
        const processedLabels = this.collisionDetector.detectCollisions(labelCandidates, this.cachedMarkerPositions);
        
        // Build final label data with collision-resolved modes and offsets
        const labelData = [];
        for (const label of processedLabels) {
            const labelText = label.text;
            const charCount = labelText.length;
            
            // Store label metadata (48 bytes = 12 floats):
            // u32: featureId, charStart, charCount, mode
            // vec3: anchorPos
            // vec3: offsetVector
            // vec2: padding
            const featureIdBits = new Float32Array(new Uint32Array([label.featureId]).buffer)[0];
            const charStartBits = new Float32Array(new Uint32Array([charOffset]).buffer)[0];
            const charCountBits = new Float32Array(new Uint32Array([charCount]).buffer)[0];
            const modeBits = new Float32Array(new Uint32Array([label.mode]).buffer)[0];
            
            labelData.push(
                featureIdBits,           // u32 as float bits
                charStartBits,           // u32 as float bits
                charCountBits,           // u32 as float bits
                modeBits,                // u32 as float bits
                label.anchorPos[0],      // anchor X
                label.anchorPos[1],      // anchor Y
                label.anchorPos[2],      // anchor Z
                0,                       // padding
                label.offsetVector[0],   // offset X
                label.offsetVector[1],   // offset Y
                label.offsetVector[2],   // offset Z
                0                        // padding
            );
            
            // Store character ASCII values
            for (let i = 0; i < charCount; i++) {
                textData.push(labelText.charCodeAt(i));
            }
            
            charOffset += charCount;
        }
        
        this.labelCount = labelData.length / 12;  // 12 floats per label now
        this.totalCharCount = charOffset;  // Store actual total
        
        if (this.labelCount === 0) return 0;
        
        // Upload label and text data to GPU
        this.device.queue.writeBuffer(
            this.labelBuffer, 
            0, 
            new Float32Array(labelData)  // Use Float32Array since we have mixed float/u32 data
        );
        
        this.device.queue.writeBuffer(
            this.textBuffer,
            0,
            new Uint32Array(textData)
        );
        
        return this.labelCount;
    }

    /**
     * Render all labels in a single GPU draw call
     */
    render(encoder, textureView, markerBuffer, cameraUniformBuffer) {
        if (!this.initialized || this.labelCount === 0) {
            return;
        }

        // Create data bind group with marker buffer and camera uniform
        const dataBindGroup = this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(1),
            entries: [
                { binding: 0, resource: { buffer: cameraUniformBuffer } },
                { binding: 1, resource: { buffer: markerBuffer } },
                { binding: 2, resource: { buffer: this.labelBuffer } },
                { binding: 3, resource: { buffer: this.textBuffer } },
                { binding: 4, resource: { buffer: this.charMetricsBuffer } }
            ]
        });

        const renderPass = encoder.beginRenderPass({
            colorAttachments: [{
                view: textureView,
                loadOp: 'load',
                storeOp: 'store'
            }]
        });

        renderPass.setPipeline(this.pipeline);
        renderPass.setBindGroup(0, this.textureBindGroup);
        renderPass.setBindGroup(1, dataBindGroup);
        
        // Draw: 6 vertices per character quad (2 triangles)
        // Instance per character (using actual total)
        renderPass.draw(6, this.totalCharCount, 0, 0);
        
        renderPass.end();
    }
    
    /**
     * Cleanup GPU resources
     */
    destroy() {
        if (this.fontAtlas) this.fontAtlas.destroy();
        if (this.labelBuffer) this.labelBuffer.destroy();
        if (this.textBuffer) this.textBuffer.destroy();
        if (this.charMetricsBuffer) this.charMetricsBuffer.destroy();
        
        this.fontAtlas = null;
        this.labelBuffer = null;
        this.textBuffer = null;
        this.charMetricsBuffer = null;
        this.initialized = false;
    }
}
