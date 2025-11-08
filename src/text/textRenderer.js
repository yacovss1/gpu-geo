// WebGPU Text Renderer using SDF (Signed Distance Field) fonts
// Renders crisp text at any zoom level

import { getSymbolLayers } from '../core/style.js';

/**
 * TextRenderer handles generating font atlases and rendering text labels
 */
export class TextRenderer {
    constructor(device) {
        this.device = device;
        this.fontAtlas = null;
        this.fontMetrics = null;
        this.pipeline = null;
        this.bindGroup = null;
        this.vertexBuffer = null;
        this.indexBuffer = null;
        this.cameraBuffer = null;
        this.labels = [];
        this.initialized = false;
    }

    /**
     * Initialize the text renderer with a font
     * @param {string} fontFamily - Font family name (e.g., 'Arial')
     * @param {number} fontSize - Base font size for atlas generation
     */
    async initialize(fontFamily = 'Arial', fontSize = 48) {
        try {
            // Generate font atlas texture
            const { texture, metrics } = await this.generateFontAtlas(fontFamily, fontSize);
            this.fontAtlas = texture;
            this.fontMetrics = metrics;
            
            // Create camera uniform buffer
            this.cameraBuffer = this.device.createBuffer({
                size: 64, // mat4x4 = 16 floats = 64 bytes
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
            });

            // Create shader module
            const shaderModule = this.device.createShaderModule({
                code: this.getTextShaderCode()
            });

            // Create bind group layouts explicitly
            const textureBindGroupLayout = this.device.createBindGroupLayout({
                entries: [
                    { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
                    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }
                ]
            });

            const markerBindGroupLayout = this.device.createBindGroupLayout({
                entries: [
                    { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }
                ]
            });

            const pipelineLayout = this.device.createPipelineLayout({
                bindGroupLayouts: [textureBindGroupLayout, markerBindGroupLayout]
            });

            // Create pipeline
            this.pipeline = this.device.createRenderPipeline({
                layout: pipelineLayout,
                vertex: {
                    module: shaderModule,
                    entryPoint: 'vertexMain',
                    buffers: [{
                        arrayStride: 32, // 2 floats (pos) + 2 floats (uv) + 4 floats (padding) = 8 floats = 32 bytes
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: 'float32x2' },  // position
                            { shaderLocation: 1, offset: 8, format: 'float32x2' },  // texCoord
                        ]
                    }]
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
            
            this.initialized = true;
        } catch (error) {
            console.error('❌ TextRenderer initialization failed:', error);
            throw error;
        }
    }

    /**
     * Generate a font atlas texture with SDF
     */
    async generateFontAtlas(fontFamily, fontSize) {
        // Generate all printable ASCII characters (32-127) in order
        let chars = '';
        for (let i = 32; i <= 127; i++) {
            chars += String.fromCharCode(i);
        }
        
        // Create canvas for rendering
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        
        // Set canvas size (16 columns x 6 rows for 96 printable ASCII chars)
        const gridCols = 16;
        const gridRows = 6;
        const cellSize = 64;
        canvas.width = gridCols * cellSize;
        canvas.height = gridRows * cellSize;
        
        // Configure font
        ctx.font = `${fontSize}px ${fontFamily}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'white';
        
        const metrics = {};
        
        // Render each character
        for (let i = 0; i < chars.length; i++) {
            const char = chars[i];
            const col = i % gridCols;
            const row = Math.floor(i / gridCols);
            
            const x = col * cellSize + cellSize / 2;
            const y = row * cellSize + cellSize / 2;
            
            ctx.fillText(char, x, y);
            
            // Store UV coordinates
            metrics[char] = {
                u0: col / gridCols,
                v0: row / gridRows,
                u1: (col + 1) / gridCols,
                v1: (row + 1) / gridRows,
                width: ctx.measureText(char).width / fontSize,
                advance: ctx.measureText(char).width / fontSize + 0.1 // Add spacing
            };
        }
        
        // Create texture from canvas
        const texture = this.device.createTexture({
            size: [canvas.width, canvas.height, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
        });
        
        // Copy canvas to texture
        this.device.queue.copyExternalImageToTexture(
            { source: canvas },
            { texture: texture },
            [canvas.width, canvas.height]
        );
        
        return { texture, metrics };
    }

    /**
     * Add a text label to be rendered
     */
    addLabel(text, x, y, size = 1.0, color = [1, 1, 1, 1]) {
        this.labels.push({ text, x, y, size, color });
    }

    /**
     * Clear all labels
     */
    clearLabels() {
        this.labels = [];
    }

    /**
     * Render all labels using marker buffer directly on GPU
     * Filters labels based on symbol layer zoom ranges from MapLibre style
     */
    renderFromMarkerBuffer(encoder, textureView, markerBuffer, markerBindGroup, featureNames, camera, sourceId = null) {
        if (!this.initialized || featureNames.size === 0) {
            return;
        }

        // Get symbol layers from style if available
        const symbolLayers = sourceId ? getSymbolLayers(sourceId) : [];
        const currentZoom = camera ? camera.zoom : 0;

        // Render country labels with zoom-based filtering
        const allVertices = [];
        const allIndices = [];
        const labelData = []; // {featureId, indexStart, indexCount}
        
        const charHeight = 0.04;
        const charWidth = 0.024;
        
        for (const [featureId, featureData] of featureNames) {
            // Extract name and sourceLayer from feature data
            const name = typeof featureData === 'string' ? featureData : featureData.name;
            const sourceLayer = typeof featureData === 'object' ? featureData.sourceLayer : null;
            
            // Check if any symbol layer allows this label at current zoom
            let shouldRender = true;
            
            if (symbolLayers.length > 0) {
                // If we have a marker for this feature, we computed a centroid
                // So look for symbol layers that reference centroid/point layers
                // Otherwise match by the feature's actual source-layer
                const matchingLayer = symbolLayers.find(layer => {
                    // Check if this symbol layer is for centroids/points (common names)
                    const isCentroidLayer = layer.sourceLayer && 
                        (layer.sourceLayer.includes('centroid') || 
                         layer.sourceLayer.includes('point') ||
                         layer.sourceLayer.includes('label'));
                    
                    // If we computed a marker/centroid, prefer centroid layers
                    // Otherwise match by actual sourceLayer
                    const layerMatches = isCentroidLayer || layer.sourceLayer === sourceLayer;
                    
                    return layerMatches && 
                           currentZoom >= layer.minzoom && 
                           currentZoom <= layer.maxzoom;
                });
                
                shouldRender = !!matchingLayer;
            } else {
                // No style information - render at zoom > 2
                shouldRender = currentZoom > 2;
            }
            
            if (!shouldRender) continue;
            
            const indexStart = allIndices.length;
            const vertexStart = allVertices.length / 8;
            
            // Generate geometry for FULL country name
            for (let i = 0; i < name.length; i++) {
                const char = name[i];
                const charCode = char.charCodeAt(0);
                
                // Calculate texture coordinates for 16x6 grid (96 chars)
                const charIndex = charCode - 32;
                const col = charIndex % 16;
                const row = Math.floor(charIndex / 16);
                
                const u0 = col / 16.0;
                const v0 = row / 6.0;
                const u1 = (col + 1) / 16.0;
                const v1 = (row + 1) / 6.0;
                
                const x0 = i * charWidth;
                const x1 = x0 + charWidth;
                const y0 = 0;
                const y1 = charHeight;
                
                const currentVertex = (allVertices.length / 8);
                
                // 4 vertices per character quad (swap v0 and v1 to flip vertically)
                allVertices.push(
                    x0, y0, u0, v1, 0, 0, 0, 0,
                    x1, y0, u1, v1, 0, 0, 0, 0,
                    x1, y1, u1, v0, 0, 0, 0, 0,
                    x0, y1, u0, v0, 0, 0, 0, 0
                );
                
                // 2 triangles per character
                allIndices.push(
                    currentVertex + 0, currentVertex + 1, currentVertex + 2,
                    currentVertex + 0, currentVertex + 2, currentVertex + 3
                );
            }
            
            labelData.push({
                featureId,
                indexStart,
                indexCount: allIndices.length - indexStart
            });
        }
        
        this._loggedCountries = true;
        
        if (allVertices.length === 0) return;
        
        const vertexArray = new Float32Array(allVertices);
        const indexArray = new Uint16Array(allIndices);
        
        // Create/update buffers
        if (!this.vertexBuffer || this.vertexBuffer.size < vertexArray.byteLength) {
            this.vertexBuffer?.destroy();
            this.vertexBuffer = this.device.createBuffer({
                size: Math.max(vertexArray.byteLength, 65536),
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
            });
        }
        this.device.queue.writeBuffer(this.vertexBuffer, 0, vertexArray);
        
        if (!this.indexBuffer || this.indexBuffer.size < indexArray.byteLength) {
            this.indexBuffer?.destroy();
            this.indexBuffer = this.device.createBuffer({
                size: Math.max(indexArray.byteLength, 65536),
                usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
            });
        }
        this.device.queue.writeBuffer(this.indexBuffer, 0, indexArray);
        
        if (!this.bindGroup) {
            const sampler = this.device.createSampler({
                magFilter: 'linear',
                minFilter: 'linear'
            });

            this.bindGroup = this.device.createBindGroup({
                layout: this.pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: sampler },
                    { binding: 1, resource: this.fontAtlas.createView() }
                ]
            });
        }

        // Render all labels with separate draw calls for each (to use different instance IDs)
        const renderPass = encoder.beginRenderPass({
            colorAttachments: [{
                view: textureView,
                loadOp: 'load',
                storeOp: 'store'
            }]
        });

        renderPass.setPipeline(this.pipeline);
        renderPass.setBindGroup(0, this.bindGroup);
        renderPass.setBindGroup(1, markerBindGroup);
        renderPass.setVertexBuffer(0, this.vertexBuffer);
        renderPass.setIndexBuffer(this.indexBuffer, 'uint16');
        
        // Draw each label separately with its featureId as the instance
        for (const label of labelData) {
            renderPass.drawIndexed(label.indexCount, 1, label.indexStart, 0, label.featureId);
        }
        
        renderPass.end();
    }
    
    /**
     * Render a single label at a marker position
     */
    renderSingleLabel(encoder, textureView, markerBindGroup, featureId, text) {
        
        // Generate geometry for the label
        const charHeight = 0.04;  // Smaller text
        const charWidth = 0.024;  // Smaller text
        
        const vertices = [];
        const indices = [];
        
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            const charCode = char.charCodeAt(0);
            
            // Calculate texture coordinates (simplified)
            const u = ((charCode - 32) % 16) / 16;
            const v = Math.floor((charCode - 32) / 16) / 6;
            
            const x0 = i * charWidth;
            const x1 = x0 + charWidth;
            const y0 = 0;
            const y1 = charHeight;
            
            const baseVertex = vertices.length / 8;
            
            // 4 vertices per character quad (x, y, u, v, padding...)
            vertices.push(
                x0, y0, u, v, 0, 0, 0, 0,
                x1, y0, u + 1/16, v, 0, 0, 0, 0,
                x1, y1, u + 1/16, v + 1/6, 0, 0, 0, 0,
                x0, y1, u, v + 1/6, 0, 0, 0, 0
            );
            
            // 2 triangles per character
            indices.push(
                baseVertex, baseVertex + 1, baseVertex + 2,
                baseVertex, baseVertex + 2, baseVertex + 3
            );
        }
        
        const vertexArray = new Float32Array(vertices);
        const indexArray = new Uint16Array(indices);
        
        // Create/update buffers
        if (!this.vertexBuffer || this.vertexBuffer.size < vertexArray.byteLength) {
            this.vertexBuffer?.destroy();
            this.vertexBuffer = this.device.createBuffer({
                size: Math.max(vertexArray.byteLength, 4096),
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
            });
        }
        this.device.queue.writeBuffer(this.vertexBuffer, 0, vertexArray);
        
        if (!this.indexBuffer || this.indexBuffer.size < indexArray.byteLength) {
            this.indexBuffer?.destroy();
            this.indexBuffer = this.device.createBuffer({
                size: Math.max(indexArray.byteLength, 4096),
                usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
            });
        }
        this.device.queue.writeBuffer(this.indexBuffer, 0, indexArray);
        
        // Create sampler and bind group
        if (!this.bindGroup) {
            const sampler = this.device.createSampler({
                magFilter: 'linear',
                minFilter: 'linear'
            });

            this.bindGroup = this.device.createBindGroup({
                layout: this.pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: sampler },
                    { binding: 1, resource: this.fontAtlas.createView() }
                ]
            });
        }

        // Render
        const renderPass = encoder.beginRenderPass({
            colorAttachments: [{
                view: textureView,
                loadOp: 'load',
                storeOp: 'store'
            }]
        });

        renderPass.setPipeline(this.pipeline);
        renderPass.setBindGroup(0, this.bindGroup);
        renderPass.setBindGroup(1, markerBindGroup); // Marker buffer with positions
        renderPass.setVertexBuffer(0, this.vertexBuffer);
        renderPass.setIndexBuffer(this.indexBuffer, 'uint16');
        renderPass.drawIndexed(indexArray.length, 1, 0, 0, featureId); // instance = featureId
        renderPass.end();
    }

    /**
     * Render all labels (OLD CPU-based approach)
     */
    render(encoder, textureView, camera) {
        if (!this.initialized || this.labels.length === 0) {
            return;
        }

        // Generate geometry for all labels
        const { vertices, indices } = this.generateTextGeometry(camera);
        
        if (vertices.length === 0 || indices.length === 0) {
            console.error('TextRenderer: No geometry generated!');
            return;
        }

        // Create/update vertex buffer
        if (!this.vertexBuffer || this.vertexBuffer.size < vertices.byteLength) {
            this.vertexBuffer?.destroy();
            this.vertexBuffer = this.device.createBuffer({
                size: Math.max(vertices.byteLength, 4096),
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
            });
        }
        this.device.queue.writeBuffer(this.vertexBuffer, 0, vertices);

        // Create/update index buffer
        if (!this.indexBuffer || this.indexBuffer.size < indices.byteLength) {
            this.indexBuffer?.destroy();
            this.indexBuffer = this.device.createBuffer({
                size: Math.max(indices.byteLength, 4096),
                usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
            });
        }
        this.device.queue.writeBuffer(this.indexBuffer, 0, indices);

        // Create bind group if needed
        if (!this.bindGroup) {
            const sampler = this.device.createSampler({
                magFilter: 'linear',
                minFilter: 'linear'
            });

            this.bindGroup = this.device.createBindGroup({
                layout: this.pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: sampler },
                    { binding: 1, resource: this.fontAtlas.createView() }
                ]
            });
        }

        // Render
        const renderPass = encoder.beginRenderPass({
            colorAttachments: [{
                view: textureView,
                loadOp: 'load',
                storeOp: 'store'
            }]
        });

        renderPass.setPipeline(this.pipeline);
        renderPass.setBindGroup(0, this.bindGroup);
        renderPass.setVertexBuffer(0, this.vertexBuffer);
        renderPass.setIndexBuffer(this.indexBuffer, 'uint16');
        renderPass.drawIndexed(indices.length);
        renderPass.end();
    }
    
    /**
     * Render labels using marker buffer - reads buffer on GPU synchronously
     */
    async renderUsingMarkerBuffer(device, markerBuffer, featureNames, camera, context) {
        if (!this.initialized || featureNames.size === 0) return;
        
        this.clearLabels();
        
        // Read marker buffer synchronously (blocking but necessary for correct positions)
        const readBuffer = device.createBuffer({
            size: markerBuffer.size,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });
        
        const copyEncoder = device.createCommandEncoder();
        copyEncoder.copyBufferToBuffer(markerBuffer, 0, readBuffer, 0, markerBuffer.size);
        device.queue.submit([copyEncoder.finish()]);
        
        await readBuffer.mapAsync(GPUMapMode.READ);
        const markerData = new Float32Array(readBuffer.getMappedRange());
        
        // Parse markers and add labels
        const markerStride = 6; // vec2 center + vec4 color = 6 floats
        for (let i = 0; i < 256; i++) {
            const offset = i * markerStride;
            const x = markerData[offset];
            const y = markerData[offset + 1];
            const colorA = markerData[offset + 5];
            
            if (colorA > 0 && featureNames.has(i)) {
                const name = featureNames.get(i);
                this.addLabel(name, x + 0.01, y + 0.01, 0.6);
            }
        }
        
        readBuffer.unmap();
        readBuffer.destroy();
        
        // Get a NEW texture for label rendering
        const labelTexture = context.getCurrentTexture();
        const labelView = labelTexture.createView();
        
        // Create encoder and render
        const encoder = device.createCommandEncoder();
        this.render(encoder, labelView, camera);
        device.queue.submit([encoder.finish()]);
    }

    /**
     * Get WGSL shader code for text rendering
     */
    generateTextGeometry(camera) {
        const vertices = [];
        const indices = [];
        let vertexOffset = 0;

        for (const label of this.labels) {
            const { text, x, y, size } = label;
            
            let cursorX = 0;

            for (let i = 0; i < text.length; i++) {
                const char = text[i];
                const metric = this.fontMetrics[char];
                if (!metric) continue;

                const charWidth = metric.width * size * 0.05;
                const charHeight = size * 0.05;

                // Clip space position - center the text vertically on the marker
                const x0 = x + cursorX;
                const x1 = x + cursorX + charWidth;
                const y0 = y + charHeight / 2.0;  // Top of char is half-height above marker
                const y1 = y - charHeight / 2.0;  // Bottom of char is half-height below marker

                // Create quad vertices (position + texCoord + padding to 32 bytes)
                // Vertices go: bottom-left, bottom-right, top-right, top-left
                vertices.push(
                    x0, y1, metric.u0, metric.v1, 0, 0, 0, 0,  // bottom-left
                    x1, y1, metric.u1, metric.v1, 0, 0, 0, 0,  // bottom-right
                    x1, y0, metric.u1, metric.v0, 0, 0, 0, 0,  // top-right
                    x0, y0, metric.u0, metric.v0, 0, 0, 0, 0   // top-left
                );

                // Add indices for two triangles (counter-clockwise winding)
                indices.push(
                    vertexOffset, vertexOffset + 1, vertexOffset + 2,
                    vertexOffset, vertexOffset + 2, vertexOffset + 3
                );

                vertexOffset += 4;
                cursorX += metric.advance * size * 0.05;
            }
        }

        const vertexArray = new Float32Array(vertices);
        const indexArray = new Uint16Array(indices);
        
        return {
            vertices: vertexArray,
            indices: indexArray
        };
    }

    /**
     * Get WGSL shader code for text rendering
     */
    getTextShaderCode() {
        return `
            @group(0) @binding(0) var fontSampler: sampler;
            @group(0) @binding(1) var fontTexture: texture_2d<f32>;
            
            struct Marker {
                center: vec2<f32>,
                color: vec4<f32>,
            };
            
            @group(1) @binding(0) var<storage, read> markers: array<Marker>;

            struct VertexInput {
                @location(0) position: vec2f,
                @location(1) texCoord: vec2f,
                @builtin(instance_index) instanceIndex: u32,
            }

            struct VertexOutput {
                @builtin(position) position: vec4f,
                @location(0) texCoord: vec2f,
            }

            @vertex
            fn vertexMain(input: VertexInput) -> VertexOutput {
                var output: VertexOutput;
                
                // Read marker position from GPU buffer directly
                let marker = markers[input.instanceIndex];
                
                // Skip rendering if marker is invalid (alpha = 0 or position = 0,0)
                if (marker.color.a == 0.0 || (marker.center.x == 0.0 && marker.center.y == 0.0)) {
                    output.position = vec4f(-100.0, -100.0, 0.0, 1.0); // Off-screen
                    output.texCoord = input.texCoord;
                    return output;
                }
                
                // Position text at marker center + vertex offset
                output.position = vec4f(marker.center + input.position, 0.0, 1.0);
                output.texCoord = input.texCoord;
                return output;
            }

            @fragment
            fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
                let sample = textureSample(fontTexture, fontSampler, input.texCoord);
                let alpha = sample.r;
                
                // Black text with proper alpha
                return vec4f(0.0, 0.0, 0.0, alpha);
            }
        `;
    }

    destroy() {
        this.vertexBuffer?.destroy();
        this.indexBuffer?.destroy();
        this.fontAtlas?.destroy();
    }
}
