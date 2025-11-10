// GPU-Native Text Renderer using Instanced Rendering
// Generates all quads on GPU, single draw call for all labels

import { getSymbolLayers } from '../core/style.js';
import { textShaderCode } from '../shaders/textShaders.js';

const MAX_LABELS = 10000;
const MAX_CHARS_PER_LABEL = 32;
const MAX_TOTAL_CHARS = MAX_LABELS * MAX_CHARS_PER_LABEL;

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
            this.labelBuffer = this.device.createBuffer({
                size: MAX_LABELS * 16, // 4 floats per label: vec2 position (unused, from marker), u32 charStart, u32 charCount
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
                    { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }, // markers
                    { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }, // labels
                    { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }, // text
                    { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }, // char metrics
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
     */
    uploadLabelData(featureNames, camera, sourceId = null) {
        if (!this.initialized || featureNames.size === 0) {
            this.labelCount = 0;
            return;
        }

        // Get symbol layers from style
        const symbolLayers = sourceId ? getSymbolLayers(sourceId) : [];
        const currentZoom = camera ? camera.zoom : 0;
        
        if (!this._loggedOnce) {
            console.log('📝 Symbol layers found:', symbolLayers.length);
            symbolLayers.forEach((layer, i) => {
                console.log(`📝 Symbol layer ${i}:`, layer);
            });
            this._loggedOnce = true;
        }
        
        const labelData = [];
        const textData = [];
        let charOffset = 0;
        
        for (const [featureId, featureData] of featureNames) {
            // Handle both old format (has .name directly) and new format (has .properties)
            const properties = featureData.properties || {};
            const sourceLayer = featureData.sourceLayer;
            const name = featureData.name; // Fallback to direct name if available
            
            if (!this._propsLogged) {
                console.log('📝 Feature data:', featureData);
                console.log('📝 Feature sourceLayer:', sourceLayer);
                this._propsLogged = true;
            }
            
            // Find matching symbol layer for this feature's source-layer
            const matchingLayer = symbolLayers.find(layer => {
                const layerSourceLayer = layer.sourceLayer;
                
                // Direct match
                if (layerSourceLayer === sourceLayer) return true;
                
                // Smart matching: Symbol layers asking for point/centroid/label layers
                // should match polygon/geometry layers (we compute centroids in real-time)
                const isSymbolLookingForPoints = layerSourceLayer && (
                    layerSourceLayer.includes('centroid') ||
                    layerSourceLayer.includes('point') ||
                    layerSourceLayer.includes('label')
                );
                
                const isGeometryLayer = sourceLayer && (
                    sourceLayer.includes('countries') ||
                    sourceLayer.includes('states') ||
                    sourceLayer.includes('regions') ||
                    sourceLayer.includes('places') ||
                    !sourceLayer.includes('line') && !sourceLayer.includes('boundary')
                );
                
                // If symbol layer wants centroids and we have geometry, match it
                if (isSymbolLookingForPoints && isGeometryLayer) {
                    // Must be within zoom range
                    if (currentZoom < layer.minzoom || currentZoom > layer.maxzoom) return false;
                    return true;
                }
                
                // Must be within zoom range for direct matches
                if (currentZoom < layer.minzoom || currentZoom > layer.maxzoom) return false;
                
                return false;
            });
            
            if (!matchingLayer) {
                continue;
            }
            
            // Parse text-field template to get the property name(s)
            let labelText = this.evaluateTextField(matchingLayer.textField, properties, currentZoom);
            
            // Fallback to direct name if text-field parsing didn't work
            if (!labelText && name) {
                labelText = name;
            }
            
            if (!labelText) {
                continue;
            }
            
            if (!this._textLogged) {
                console.log('📝 First label text:', labelText, 'from textField:', matchingLayer.textField);
                this._textLogged = true;
            }
            
            // Apply text-transform if specified
            const textTransform = this.evaluateProperty(matchingLayer.textTransform, currentZoom);
            if (textTransform === 'uppercase') {
                labelText = labelText.toUpperCase();
            } else if (textTransform === 'lowercase') {
                labelText = labelText.toLowerCase();
            }
            
            // Limit label length
            labelText = labelText.substring(0, MAX_CHARS_PER_LABEL);
            const charCount = labelText.length;
            
            // Store label metadata: featureId, charStart, charCount, padding
            labelData.push(
                featureId,           // Will index into marker buffer
                charOffset,          // Where this label's text starts
                charCount,           // How many chars
                0                    // Padding
            );
            
            // Store character ASCII values
            for (let i = 0; i < charCount; i++) {
                textData.push(labelText.charCodeAt(i));
            }
            
            charOffset += charCount;
            
            if (labelData.length / 4 >= MAX_LABELS) break;
        }
        
        this.labelCount = labelData.length / 4;
        this.totalCharCount = charOffset;  // Store actual total
        
        if (this.labelCount === 0) return;
        
        // Upload to GPU
        this.device.queue.writeBuffer(
            this.labelBuffer, 
            0, 
            new Uint32Array(labelData)
        );
        
        this.device.queue.writeBuffer(
            this.textBuffer,
            0,
            new Uint32Array(textData)
        );
    }
    
    /**
     * Evaluate text-field template with property substitution
     * Supports: {PROPERTY}, literal strings, and stops
     */
    evaluateTextField(textField, properties, zoom) {
        if (!textField) return null;
        
        // Handle stops (zoom-based values)
        const value = this.evaluateProperty(textField, zoom);
        
        if (typeof value !== 'string') return null;
        
        // Replace {PROPERTY} with actual property value
        return value.replace(/\{([^}]+)\}/g, (match, propName) => {
            return properties[propName] || '';
        });
    }
    
    /**
     * Evaluate a property that may have stops (zoom functions)
     */
    evaluateProperty(property, zoom) {
        if (!property) return property;
        
        // If it's already a simple value, return it
        if (typeof property !== 'object') return property;
        
        // Handle stops array
        if (property.stops && Array.isArray(property.stops)) {
            // Find the appropriate stop for current zoom
            let value = property.stops[0][1]; // Default to first
            
            for (let i = 0; i < property.stops.length; i++) {
                const [stopZoom, stopValue] = property.stops[i];
                if (zoom >= stopZoom) {
                    value = stopValue;
                } else {
                    break;
                }
            }
            
            return value;
        }
        
        return property;
    }

    /**
     * Render all labels in a single GPU draw call
     */
    render(encoder, textureView, markerBuffer) {
        if (!this.initialized || this.labelCount === 0) {
            return;
        }

        // Create data bind group with marker buffer
        const dataBindGroup = this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(1),
            entries: [
                { binding: 0, resource: { buffer: markerBuffer } },
                { binding: 1, resource: { buffer: this.labelBuffer } },
                { binding: 2, resource: { buffer: this.textBuffer } },
                { binding: 3, resource: { buffer: this.charMetricsBuffer } }
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
}
