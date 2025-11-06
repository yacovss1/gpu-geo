import { calculateFeatureCenter, mercatorToClipSpace } from './utils.js';

export class LabelManager {
    constructor(canvas, device, hiddenTexture) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.device = device;
        this.hiddenTexture = hiddenTexture;
        this.labels = new Map();
        this.style = {
            font: '12px Arial',
            color: 'rgba(0, 0, 0, 0.9)',
            background: 'rgba(255, 255, 255, 0.7)',
            padding: 3
        };
    }
    
    // Reset canvas size to match WebGPU canvas
    resizeCanvas(width, height) {
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
            return true;
        }
        return false;
    }
    
    // Reset labels when loading new tiles
    clearLabels() {
        this.labels.clear();
    }
    
    // Add a label from tile buffers directly
    addLabelFromFeature(tileBuffer) {
        if (!tileBuffer || !tileBuffer.properties) return;
        
        const featureId = tileBuffer.properties.fid;
        const countryName = tileBuffer.properties.NAME || tileBuffer.properties.ADM0_A3 || tileBuffer.properties.ISO_A3;
        
        if (!featureId || !countryName) return;
        
        // Calculate center from the actual vertices array
        const center = this.calculateCenterFromVertices(tileBuffer.vertices);
        if (!center) return;
        
        // Store label data
        this.labels.set(featureId, {
            id: featureId,
            name: countryName,
            clipPosition: center,
            screenPosition: null
        });
    }
    
    // Improved vertex-based label placement that's more resilient
    calculateCenterFromVertices(vertices) {
        if (!vertices || vertices.length < 6) {
            return null;
        }
        
        // For more stable placement, use the centroid plus bounding box approach
        let sumX = 0, sumY = 0;
        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;
        let count = 0;
        
        // Extract positions from vertex buffer and compute bounds
        for (let i = 0; i < vertices.length; i += 6) {
            const x = vertices[i];
            const y = vertices[i + 1];
            
            // Accumulate for centroid
            sumX += x;
            sumY += y;
            count++;
            
            // Track bounds
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
        }
        
        if (count === 0) return null;
        
        // Use centroid (weighted to center of bounding box for better stability)
        const centroidX = sumX / count;
        const centroidX_bbox = (minX + maxX) / 2;
        const centroidY = sumY / count;
        const centroidY_bbox = (minY + maxY) / 2;
        
        // Use a weighted combination for better placement
        const finalX = (centroidX + centroidX_bbox) / 2;
        const finalY = (centroidY + centroidY_bbox) / 2;
        
        return [finalX, finalY];
    }
    
    // Find the center of a feature using the hidden ID buffer
    async calculateCenterFromPixels(featureId, width, height) {
        // Ensure width alignment to 256 (WebGPU requirement)
        const alignedBytesPerRow = Math.ceil(width * 4 / 256) * 256;
        
        try {
            const commandEncoder = this.device.createCommandEncoder();
            
            // Create a buffer to read the texture data
            const readBuffer = this.device.createBuffer({
                size: alignedBytesPerRow * height, // Using aligned row stride
                usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
            });
            
            // Copy the entire texture to the buffer with proper alignment
            commandEncoder.copyTextureToBuffer(
                { texture: this.hiddenTexture },
                { 
                    buffer: readBuffer,
                    bytesPerRow: alignedBytesPerRow, // Properly aligned
                    rowsPerImage: height
                },
                { width, height, depthOrArrayLayers: 1 }
            );
            
            this.device.queue.submit([commandEncoder.finish()]);
            
            // Map the buffer to read the data
            await readBuffer.mapAsync(GPUMapMode.READ);
            const data = new Uint8Array(readBuffer.getMappedRange());
            
            // Find all pixels matching the feature ID
            let sumX = 0, sumY = 0, count = 0;
            const targetId = Math.round(featureId);
            
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    // Account for the padded rows in our calculations
                    const offset = y * alignedBytesPerRow + x * 4;
                    const pixelId = data[offset]; // Read from first channel
                    
                    if (pixelId === targetId) {
                        sumX += x;
                        sumY += y;
                        count++;
                    }
                }
            }
            
            readBuffer.unmap();
            
            if (count === 0) return null;
            
            // Calculate center of pixels with this ID
            // Convert to normalized coordinates (-1 to 1)
            const centerX = (sumX / count / width) * 2 - 1;
            const centerY = 1 - (sumY / count / height) * 2; // Flip Y
            
            return [centerX, centerY];
        } catch (error) {
            console.error("Buffer alignment error:", error);
            return null;
        }
    }
    
    // Optimize label creation to avoid huge texture reads
    async createLabelsFromScene(featureProperties) {
        this.clearLabels();
        
        // Use a more manageable size for texture reading
        const chunkSize = 256; // Read in 256x256 chunks
        const width = this.canvas.width;
        const height = this.canvas.height;
        
        // Prepare property lookup
        const featureLookup = {};
        featureProperties.forEach(prop => {
            if (prop.fid) {
                featureLookup[prop.fid] = {
                    name: prop.NAME || prop.ADM0_A3 || prop.ISO_A3,
                    pixels: { count: 0, sumX: 0, sumY: 0 }
                };
            }
        });
        
        // Process texture in chunks
        for (let y = 0; y < height; y += chunkSize) {
            for (let x = 0; x < width; x += chunkSize) {
                // Calculate actual chunk dimensions (handle edge cases)
                const chunkWidth = Math.min(chunkSize, width - x);
                const chunkHeight = Math.min(chunkSize, height - y);
                
                // Skip tiny chunks
                if (chunkWidth < 16 || chunkHeight < 16) continue;
                
                try {
                    await this.processTextureChunk(x, y, chunkWidth, chunkHeight, featureLookup);
                } catch (error) {
                    console.warn(`Error processing chunk at ${x},${y}:`, error);
                }
            }
        }
        
        // Create labels from accumulated data
        for (const [featureId, data] of Object.entries(featureLookup)) {
            if (data.pixels.count > 0) {
                const centerX = (data.pixels.sumX / data.pixels.count / width) * 2 - 1;
                const centerY = 1 - (data.pixels.sumY / data.pixels.count / height) * 2;
                
                this.labels.set(parseInt(featureId), {
                    id: parseInt(featureId),
                    name: data.name,
                    clipPosition: [centerX, centerY],
                    screenPosition: null
                });
            }
        }
    }
    
    // Process a single chunk of the texture
    async processTextureChunk(x, y, width, height, featureLookup) {
        // Ensure bytes per row is properly aligned to 256
        const alignedBytesPerRow = Math.ceil(width * 4 / 256) * 256;
        
        const commandEncoder = this.device.createCommandEncoder();
        const readBuffer = this.device.createBuffer({
            size: alignedBytesPerRow * height,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        
        // Copy just this chunk
        commandEncoder.copyTextureToBuffer(
            { 
                texture: this.hiddenTexture,
                origin: { x, y, z: 0 }
            },
            { 
                buffer: readBuffer,
                bytesPerRow: alignedBytesPerRow,
                rowsPerImage: height
            },
            { width, height, depthOrArrayLayers: 1 }
        );
        
        this.device.queue.submit([commandEncoder.finish()]);
        
        try {
            await readBuffer.mapAsync(GPUMapMode.READ);
            const data = new Uint8Array(readBuffer.getMappedRange());
            
            // Process pixels in this chunk
            for (let localY = 0; localY < height; localY++) {
                for (let localX = 0; localX < width; localX++) {
                    const offset = localY * alignedBytesPerRow + localX * 4;
                    const pixelId = data[offset];
                    
                    if (pixelId > 0 && featureLookup[pixelId]) {
                        featureLookup[pixelId].pixels.count++;
                        featureLookup[pixelId].pixels.sumX += (x + localX);
                        featureLookup[pixelId].pixels.sumY += (y + localY);
                    }
                }
            }
        } finally {
            readBuffer.unmap();
        }
    }
    
    // Update label positions based on camera - exact mapping to shader transformation
    updateLabels(camera) {
        const aspectRatio = this.canvas.width / this.canvas.height;
        
        for (const label of this.labels.values()) {
            if (!label.clipPosition) continue;
            
            const [x, y] = label.clipPosition;
            
            // Apply exactly the same transformation used in the vertex shader
            // This must match shader.js vertexShaderCode transformation
            const clipX = (x - camera.position[0]) * camera.zoom / aspectRatio;
            const clipY = (y - camera.position[1]) * camera.zoom;
            
            // Convert to screen coordinates with correct orientation
            const screenX = (clipX + 1) * this.canvas.width / 2;
            const screenY = (1 - clipY) * this.canvas.height / 2;
            
            label.screenPosition = [screenX, screenY];
        }
    }
    
    // Render the labels on canvas
    render(camera) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Only show labels when zoomed in enough - adjust threshold as needed
        if (camera.zoom < 1.5) return;
        
        // Set label style
        this.ctx.font = this.style.font;
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        
        // Sort labels by y-position for better overlap handling
        const sortedLabels = [...this.labels.values()]
            .filter(label => label.screenPosition)
            .sort((a, b) => a.screenPosition[1] - b.screenPosition[1]);
        
        // Limit number of labels to avoid clutter
        const maxLabels = Math.min(100, sortedLabels.length);
        
        // Track occupied areas to prevent overlap
        const occupiedAreas = [];
        
        for (let i = 0; i < maxLabels; i++) {
            const label = sortedLabels[i];
            const [x, y] = label.screenPosition;
            
            // Skip if outside canvas
            if (x < 0 || x > this.canvas.width || y < 0 || y > this.canvas.height) {
                continue;
            }
            
            // Measure text
            const metrics = this.ctx.measureText(label.name);
            const padding = this.style.padding;
            const labelWidth = metrics.width + padding * 2;
            const labelHeight = 16 + padding * 2;
            
            // Check for overlaps
            const labelBox = {
                left: x - labelWidth / 2,
                right: x + labelWidth / 2,
                top: y - labelHeight / 2,
                bottom: y + labelHeight / 2
            };
            
            let overlaps = false;
            for (const area of occupiedAreas) {
                if (this.boxesOverlap(labelBox, area)) {
                    overlaps = true;
                    break;
                }
            }
            
            if (overlaps) continue;
            
            // Removed background drawing; only draw the text
            this.ctx.fillStyle = this.style.color;
            this.ctx.fillText(label.name, x, y);
            
            // Mark area as occupied
            occupiedAreas.push(labelBox);
        }
    }
    
    // Check if two bounding boxes overlap
    boxesOverlap(a, b) {
        return !(
            a.right < b.left ||
            a.left > b.right ||
            a.bottom < b.top ||
            a.top > b.bottom
        );
    }
    
    // Add to LabelManager class
    setLabelStyle(options = {}) {
        this.style = {
            font: options.font || '12px Arial',
            color: options.color || 'rgba(0, 0, 0, 0.9)',
            background: options.background || 'rgba(255, 255, 255, 0.7)',
            padding: options.padding || 3
        };
    }

    renderMarkers(markers) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.font = this.style.font;
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        for (const marker of markers) {
            if (!marker.countryName || !marker.screenPosition) continue;
            const [x, y] = marker.screenPosition;
            // Invert Y coordinate for canvas (origin at top-left)
            const adjustedY = this.canvas.height - y;
            this.ctx.fillStyle = this.style.color;
            this.ctx.fillText(marker.countryName, x, adjustedY);
        }
    }
}
