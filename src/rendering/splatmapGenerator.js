/**
 * Splatmap Generator
 * 
 * Rasterizes vector polygons to a texture (splatmap) for terrain rendering.
 * This allows polygons to be "painted" onto the terrain mesh without
 * requiring polygon geometry to follow terrain vertices.
 * 
 * Output:
 * - Color splatmap: Pre-composited RGBA color per pixel
 * - Feature ID splatmap: Feature ID for picking/selection
 */

export class SplatmapGenerator {
    /**
     * @param {number} resolution - Splatmap texture size (e.g., 256)
     */
    constructor(resolution = 256) {
        this.resolution = resolution;
        
        // Pre-allocate buffers
        this.colorBuffer = null;
        this.featureIdBuffer = null;
        this.reset();
    }
    
    /**
     * Reset buffers for a new tile
     */
    reset() {
        const size = this.resolution * this.resolution;
        
        // RGBA color buffer (pre-composited)
        this.colorBuffer = new Float32Array(size * 4);
        
        // Feature ID buffer (16-bit ID stored as two 8-bit values)
        this.featureIdBuffer = new Uint16Array(size);
        
        // Initialize with transparent
        for (let i = 0; i < size * 4; i += 4) {
            this.colorBuffer[i] = 0;     // R
            this.colorBuffer[i + 1] = 0; // G
            this.colorBuffer[i + 2] = 0; // B
            this.colorBuffer[i + 3] = 0; // A
        }
        
        for (let i = 0; i < size; i++) {
            this.featureIdBuffer[i] = 0;
        }
    }
    
    /**
     * Rasterize a polygon to the splatmap
     * @param {Array} coords - Polygon coordinates [[outerRing], [hole1], [hole2], ...]
     *                         Each ring is array of [x, y] in clip space (-1 to 1)
     * @param {Array} color - RGBA color [r, g, b, a] (0-1 range)
     * @param {number} featureId - Feature ID for picking
     * @param {Object} tileBounds - { minX, maxX, minY, maxY } in clip space
     */
    rasterizePolygon(coords, color, featureId, tileBounds) {
        if (!coords || coords.length === 0) return;
        
        const outerRing = coords[0];
        const holes = coords.slice(1);
        
        if (outerRing.length < 3) return;
        
        // Convert clip space to pixel coordinates
        // Note: Y is flipped because texture row 0 is at top (maxY), row 255 is at bottom (minY)
        const toPixel = (clipX, clipY) => {
            const u = (clipX - tileBounds.minX) / (tileBounds.maxX - tileBounds.minX);
            const v = 1.0 - (clipY - tileBounds.minY) / (tileBounds.maxY - tileBounds.minY);
            const px = Math.floor(u * this.resolution);
            const py = Math.floor(v * this.resolution);
            return [px, py];
        };
        
        // Convert rings to pixel space
        const outerPixels = outerRing.map(([x, y]) => toPixel(x, y));
        const holePixels = holes.map(hole => hole.map(([x, y]) => toPixel(x, y)));
        
        // Get bounding box
        let minPx = this.resolution, maxPx = 0;
        let minPy = this.resolution, maxPy = 0;
        for (const [px, py] of outerPixels) {
            minPx = Math.min(minPx, px);
            maxPx = Math.max(maxPx, px);
            minPy = Math.min(minPy, py);
            maxPy = Math.max(maxPy, py);
        }
        
        // Clamp to valid range
        minPx = Math.max(0, minPx);
        maxPx = Math.min(this.resolution - 1, maxPx);
        minPy = Math.max(0, minPy);
        maxPy = Math.min(this.resolution - 1, maxPy);
        
        // Scanline fill
        for (let py = minPy; py <= maxPy; py++) {
            for (let px = minPx; px <= maxPx; px++) {
                // Point-in-polygon test
                if (this.pointInPolygon(px + 0.5, py + 0.5, outerPixels, holePixels)) {
                    this.setPixel(px, py, color, featureId);
                }
            }
        }
    }
    
    /**
     * Set a pixel with alpha blending
     */
    setPixel(px, py, color, featureId) {
        if (px < 0 || px >= this.resolution || py < 0 || py >= this.resolution) {
            return;
        }
        
        const idx = py * this.resolution + px;
        const colorIdx = idx * 4;
        
        const srcR = color[0];
        const srcG = color[1];
        const srcB = color[2];
        const srcA = color[3];
        
        const dstR = this.colorBuffer[colorIdx];
        const dstG = this.colorBuffer[colorIdx + 1];
        const dstB = this.colorBuffer[colorIdx + 2];
        const dstA = this.colorBuffer[colorIdx + 3];
        
        // Standard alpha composite (src over dst)
        const outA = srcA + dstA * (1 - srcA);
        
        if (outA > 0) {
            this.colorBuffer[colorIdx] = (srcR * srcA + dstR * dstA * (1 - srcA)) / outA;
            this.colorBuffer[colorIdx + 1] = (srcG * srcA + dstG * dstA * (1 - srcA)) / outA;
            this.colorBuffer[colorIdx + 2] = (srcB * srcA + dstB * dstA * (1 - srcA)) / outA;
            this.colorBuffer[colorIdx + 3] = outA;
        }
        
        // Store top-most feature ID (for picking)
        if (srcA > 0.1) {  // Only update if mostly opaque
            this.featureIdBuffer[idx] = featureId & 0xFFFF;
        }
    }
    
    /**
     * Point-in-polygon test using ray casting
     */
    pointInPolygon(x, y, outerRing, holes) {
        // Must be inside outer ring
        if (!this.pointInRing(x, y, outerRing)) {
            return false;
        }
        
        // Must NOT be inside any hole
        for (const hole of holes) {
            if (this.pointInRing(x, y, hole)) {
                return false;
            }
        }
        
        return true;
    }
    
    /**
     * Ray casting algorithm for point-in-ring
     */
    pointInRing(x, y, ring) {
        let inside = false;
        const n = ring.length;
        
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const xi = ring[i][0], yi = ring[i][1];
            const xj = ring[j][0], yj = ring[j][1];
            
            if (((yi > y) !== (yj > y)) &&
                (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        
        return inside;
    }
    
    /**
     * Generate splatmap for a tile from multiple polygons
     * @param {Array} polygons - Array of { coords, color, featureId, layerIndex }
     * @param {Object} tileBounds - { minX, maxX, minY, maxY } in clip space
     * @returns {Object} - { colorData, featureIdData }
     */
    generateSplatmap(polygons, tileBounds) {
        this.reset();
        
        // Sort polygons by layer index (bottom to top)
        const sorted = [...polygons].sort((a, b) => a.layerIndex - b.layerIndex);
        
        // Rasterize each polygon
        for (const polygon of sorted) {
            this.rasterizePolygon(
                polygon.coords,
                polygon.color,
                polygon.featureId,
                tileBounds
            );
        }
        
        return {
            colorData: this.colorBuffer,
            featureIdData: this.featureIdBuffer,
            resolution: this.resolution
        };
    }
    
    /**
     * Create GPU textures from splatmap data
     * @param {GPUDevice} device
     * @param {Object} splatmapData - From generateSplatmap()
     * @returns {Object} - { colorTexture, featureIdTexture }
     */
    createGPUTextures(device, splatmapData) {
        const { colorData, featureIdData, resolution } = splatmapData;
        
        // Color texture (RGBA8) - needs COPY_SRC for atlas building
        const colorTexture = device.createTexture({
            size: [resolution, resolution],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC
        });
        
        // Convert float color to uint8
        const colorBytes = new Uint8Array(resolution * resolution * 4);
        for (let i = 0; i < colorData.length; i++) {
            colorBytes[i] = Math.round(Math.min(1, Math.max(0, colorData[i])) * 255);
        }
        
        device.queue.writeTexture(
            { texture: colorTexture },
            colorBytes,
            { bytesPerRow: resolution * 4 },
            { width: resolution, height: resolution }
        );
        
        // Feature ID texture (RG8 = 16-bit ID) - needs COPY_SRC for atlas building
        const featureIdTexture = device.createTexture({
            size: [resolution, resolution],
            format: 'rg8uint',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC
        });
        
        // Convert uint16 to two uint8
        const idBytes = new Uint8Array(resolution * resolution * 2);
        for (let i = 0; i < featureIdData.length; i++) {
            const id = featureIdData[i];
            idBytes[i * 2] = id & 0xFF;       // Low byte
            idBytes[i * 2 + 1] = (id >> 8) & 0xFF;  // High byte
        }
        
        device.queue.writeTexture(
            { texture: featureIdTexture },
            idBytes,
            { bytesPerRow: resolution * 2 },
            { width: resolution, height: resolution }
        );
        
        return { colorTexture, featureIdTexture };
    }
}
