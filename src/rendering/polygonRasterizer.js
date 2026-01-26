/**
 * Polygon Rasterizer
 * 
 * Rasterizes flat polygons to a texture atlas that the terrain shader can sample.
 * This allows terrain mesh to render with polygon colors, making polygons follow terrain.
 * 
 * Each pixel in the texture stores:
 * - R: Polygon color R
 * - G: Polygon color G  
 * - B: Polygon color B
 * - A: 1.0 if inside polygon, 0.0 if outside
 */

export class PolygonRasterizer {
    constructor(device) {
        this.device = device;
        this.textureSize = 512;  // Texture resolution per tile
        
        // Cache of rasterized polygon textures per tile
        // Key: "z/x/y", Value: GPUTexture
        this.tileTextures = new Map();
        
        // Offscreen canvas for CPU rasterization
        this.canvas = new OffscreenCanvas(this.textureSize, this.textureSize);
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
        
        // Sampler for polygon textures
        this.sampler = device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge'
        });
        
        console.log('🎨 Polygon rasterizer initialized');
    }
    
    /**
     * Rasterize polygons for a tile to a GPU texture
     * @param {number} z - Tile zoom
     * @param {number} x - Tile X
     * @param {number} y - Tile Y
     * @param {Array} polygons - Array of {coords, color, type} for flat polygons
     * @returns {GPUTexture} - Texture with rasterized polygons
     */
    rasterizeTile(z, x, y, polygons) {
        const key = `${z}/${x}/${y}`;
        
        console.log(`🎨 Rasterizing ${polygons.length} polygons for tile ${key}`);
        
        // Clear canvas
        this.ctx.clearRect(0, 0, this.textureSize, this.textureSize);
        
        // Draw debug background to verify texture is being used
        this.ctx.fillStyle = 'rgba(255, 0, 255, 0.3)'; // Magenta for debug
        this.ctx.fillRect(0, 0, this.textureSize, this.textureSize);
        
        // Draw each polygon
        let drawnCount = 0;
        for (const polygon of polygons) {
            this.drawPolygon(polygon, z, x, y);
            drawnCount++;
        }
        
        console.log(`🎨 Drew ${drawnCount} polygons to canvas for tile ${key}`);
        
        // Create GPU texture from canvas
        const texture = this.createTextureFromCanvas();
        
        // Cache it
        if (this.tileTextures.has(key)) {
            this.tileTextures.get(key).destroy();
        }
        this.tileTextures.set(key, texture);
        
        return texture;
    }
    
    /**
     * Draw a single polygon to the canvas
     */
    drawPolygon(polygon, tileZ, tileX, tileY) {
        const { coords, color, type } = polygon;
        if (!coords || coords.length === 0) return;
        
        // Convert clip-space coords to canvas pixel coords
        // Clip space for this tile: calculate bounds
        const tileCount = Math.pow(2, tileZ);
        
        // Tile bounds in clip space (Mercator -1 to 1)
        const tileMinX = (tileX / tileCount) * 2 - 1;
        const tileMaxX = ((tileX + 1) / tileCount) * 2 - 1;
        const tileMinY = 1 - ((tileY + 1) / tileCount) * 2;
        const tileMaxY = 1 - (tileY / tileCount) * 2;
        
        const tileWidth = tileMaxX - tileMinX;
        const tileHeight = tileMaxY - tileMinY;
        
        // Convert coords to canvas space
        const toCanvasX = (clipX) => ((clipX - tileMinX) / tileWidth) * this.textureSize;
        const toCanvasY = (clipY) => ((tileMaxY - clipY) / tileHeight) * this.textureSize;
        
        // Set fill color
        const [r, g, b, a] = color;
        this.ctx.fillStyle = `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
        
        // Draw polygon path
        this.ctx.beginPath();
        
        // Handle both simple rings and complex polygons with holes
        const rings = Array.isArray(coords[0][0]) ? coords : [coords];
        
        for (let ringIdx = 0; ringIdx < rings.length; ringIdx++) {
            const ring = rings[ringIdx];
            if (ring.length < 3) continue;
            
            // Move to first point
            const firstX = toCanvasX(ring[0][0]);
            const firstY = toCanvasY(ring[0][1]);
            this.ctx.moveTo(firstX, firstY);
            
            // Line to remaining points
            for (let i = 1; i < ring.length; i++) {
                const px = toCanvasX(ring[i][0]);
                const py = toCanvasY(ring[i][1]);
                this.ctx.lineTo(px, py);
            }
            
            this.ctx.closePath();
        }
        
        // Fill with even-odd rule for holes
        this.ctx.fill('evenodd');
    }
    
    /**
     * Create GPU texture from canvas content
     */
    createTextureFromCanvas() {
        const texture = this.device.createTexture({
            size: [this.textureSize, this.textureSize],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
        });
        
        // Copy canvas to texture
        const imageData = this.ctx.getImageData(0, 0, this.textureSize, this.textureSize);
        
        this.device.queue.writeTexture(
            { texture },
            imageData.data,
            { bytesPerRow: this.textureSize * 4 },
            { width: this.textureSize, height: this.textureSize }
        );
        
        return texture;
    }
    
    /**
     * Get texture for a tile (or null if not rasterized)
     */
    getTileTexture(z, x, y) {
        return this.tileTextures.get(`${z}/${x}/${y}`) || null;
    }
    
    /**
     * Build an atlas texture from multiple tiles
     */
    buildAtlas(tiles) {
        // For simplicity, just return first tile's texture for now
        // TODO: Build proper atlas for multiple tiles
        for (const tile of tiles) {
            const tex = this.getTileTexture(tile.z, tile.x, tile.y);
            if (tex) return { texture: tex, bounds: this.getTileBounds(tile.z, tile.x, tile.y) };
        }
        return null;
    }
    
    /**
     * Get tile bounds in clip space
     */
    getTileBounds(z, x, y) {
        const tileCount = Math.pow(2, z);
        return {
            minX: (x / tileCount) * 2 - 1,
            maxX: ((x + 1) / tileCount) * 2 - 1,
            minY: 1 - ((y + 1) / tileCount) * 2,
            maxY: 1 - (y / tileCount) * 2
        };
    }
    
    /**
     * Clean up texture for a tile
     */
    removeTile(z, x, y) {
        const key = `${z}/${x}/${y}`;
        const tex = this.tileTextures.get(key);
        if (tex) {
            tex.destroy();
            this.tileTextures.delete(key);
        }
    }
    
    /**
     * Clear all cached textures
     */
    clear() {
        for (const tex of this.tileTextures.values()) {
            tex.destroy();
        }
        this.tileTextures.clear();
    }
}
