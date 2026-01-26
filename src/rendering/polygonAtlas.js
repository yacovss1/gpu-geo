/**
 * Polygon Atlas - Rasterizes flat polygons to a texture atlas
 * 
 * This allows the terrain mesh to render polygon colors without needing
 * sparse polygon geometry. The terrain mesh provides the 3D shape,
 * and this texture provides "what polygon is at this XY position?"
 * 
 * Texture format (per pixel):
 * - R: Polygon color R
 * - G: Polygon color G  
 * - B: Polygon color B
 * - A: 1.0 if polygon present, 0.0 if not
 */

export class PolygonAtlas {
    constructor(device) {
        this.device = device;
        this.atlasSize = 512;  // 512x512 texture per tile
        this.tileAtlases = new Map();  // Map<tileKey, GPUTexture>
        
        // Offscreen canvas for CPU rasterization
        this.canvas = null;
        this.ctx = null;
        
        // Sampler for the atlas
        this.sampler = device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge'
        });
    }
    
    /**
     * Initialize the offscreen canvas for rasterization
     */
    initCanvas() {
        if (this.canvas) return;
        
        this.canvas = new OffscreenCanvas(this.atlasSize, this.atlasSize);
        this.ctx = this.canvas.getContext('2d');
    }
    
    /**
     * Rasterize polygons for a tile into a texture
     * 
     * @param {string} tileKey - "z/x/y" tile key
     * @param {Array} polygons - Array of { coords: [[x,y],...], color: [r,g,b,a], type: string }
     * @param {Object} tileBounds - { minX, minY, maxX, maxY } in clip space
     * @returns {GPUTexture} - The polygon atlas texture for this tile
     */
    rasterizeTile(tileKey, polygons, tileBounds) {
        this.initCanvas();
        
        const ctx = this.ctx;
        const size = this.atlasSize;
        
        // Clear canvas (transparent)
        ctx.clearRect(0, 0, size, size);
        
        // Calculate transform from clip space to canvas pixels
        const scaleX = size / (tileBounds.maxX - tileBounds.minX);
        const scaleY = size / (tileBounds.maxY - tileBounds.minY);
        
        // Draw each polygon
        for (const polygon of polygons) {
            if (!polygon.coords || polygon.coords.length < 3) continue;
            
            const [r, g, b, a] = polygon.color || [0.5, 0.5, 0.5, 1.0];
            ctx.fillStyle = `rgba(${Math.floor(r*255)}, ${Math.floor(g*255)}, ${Math.floor(b*255)}, ${a})`;
            
            ctx.beginPath();
            
            // First point
            const startX = (polygon.coords[0][0] - tileBounds.minX) * scaleX;
            const startY = (polygon.coords[0][1] - tileBounds.minY) * scaleY;
            ctx.moveTo(startX, startY);
            
            // Remaining points
            for (let i = 1; i < polygon.coords.length; i++) {
                const px = (polygon.coords[i][0] - tileBounds.minX) * scaleX;
                const py = (polygon.coords[i][1] - tileBounds.minY) * scaleY;
                ctx.lineTo(px, py);
            }
            
            ctx.closePath();
            ctx.fill();
        }
        
        // Create GPU texture from canvas
        const texture = this.device.createTexture({
            size: [size, size],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
        });
        
        // Copy canvas to texture
        this.device.queue.copyExternalImageToTexture(
            { source: this.canvas },
            { texture: texture },
            [size, size]
        );
        
        // Store and return
        this.destroyTileAtlas(tileKey);  // Clean up old one if exists
        this.tileAtlases.set(tileKey, texture);
        
        return texture;
    }
    
    /**
     * Get the atlas texture for a tile (or null if not rasterized)
     */
    getTileAtlas(tileKey) {
        return this.tileAtlases.get(tileKey) || null;
    }
    
    /**
     * Build a combined atlas from multiple tiles
     * Returns the atlas texture and bounds for shader use
     */
    buildCombinedAtlas(visibleTileKeys) {
        // For now, just return first tile's atlas
        // TODO: Stitch multiple tiles into single atlas like terrain does
        for (const key of visibleTileKeys) {
            const atlas = this.tileAtlases.get(key);
            if (atlas) {
                return { texture: atlas, sampler: this.sampler };
            }
        }
        return null;
    }
    
    /**
     * Destroy atlas for a tile
     */
    destroyTileAtlas(tileKey) {
        const existing = this.tileAtlases.get(tileKey);
        if (existing) {
            existing.destroy();
            this.tileAtlases.delete(tileKey);
        }
    }
    
    /**
     * Clear all atlases
     */
    clear() {
        for (const [key, texture] of this.tileAtlases) {
            texture.destroy();
        }
        this.tileAtlases.clear();
    }
}
