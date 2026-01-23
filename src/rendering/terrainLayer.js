/**
 * Terrain Layer - Loads and renders terrain tiles as 3D mesh
 * 
 * Supports:
 * - AWS Terrarium tiles (free, no API key)
 * - Mapbox Terrain-RGB tiles
 * - MapTiler terrain tiles
 * 
 * Can be combined with any vector style - independent layer system
 */

import { getVisibleTiles } from '../tiles/tile-utils.js';
import { transformTileCoords } from '../tiles/vectorTileParser.js';
import { terrainShaderCode } from '../shaders/terrainShaders.js';
import { TERRAIN_CONFIG } from '../core/terrainConfig.js';

// Terrain tile sources
const TERRAIN_SOURCES = {
    // AWS Terrarium - free, no API key
    // Encoding: height = (R * 256 + G + B / 256) - 32768
    aws: {
        url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
        encoding: 'terrarium',
        minZoom: 5,   // Tiles don't exist below zoom 5
        maxZoom: 15
    },
    // Mapbox Terrain-RGB (requires token)
    // Encoding: height = -10000 + ((R * 256 * 256 + G * 256 + B) * 0.1)
    mapbox: {
        url: 'https://api.mapbox.com/v4/mapbox.terrain-rgb/{z}/{x}/{y}.pngraw?access_token={token}',
        encoding: 'mapbox',
        minZoom: 0,
        maxZoom: 15
    }
};

export class TerrainLayer {
    constructor(device) {
        this.device = device;
        this.terrainTiles = new Map(); // "z/x/y" -> { texture, vertexBuffer, ... }
        this.loadingTiles = new Set(); // Track tiles currently loading
        this.failedTiles = new Set();  // Track tiles that failed to load (404s)
        this.pipeline = null;
        this.overlayPipeline = null;  // Multiply blend for hillshade overlay on top of vectors
        this.bindGroupLayout = null;
        this.sampler = null;
        this.gridIndices = null; // Shared index buffer (same for all tiles)
        this.gridSize = 128; // Higher resolution for better edge alignment
        this.enabled = true;  // Re-enabled after centerline fix for Z-fighting
        this.source = TERRAIN_CONFIG.DEFAULT_SOURCE;
        this.exaggeration = TERRAIN_CONFIG.DEFAULT_EXAGGERATION;
        this.minDisplayZoom = TERRAIN_CONFIG.DEFAULT_MIN_ZOOM;
        this.cameraBuffer = null; // Set from main renderer
        this.initialized = false;
        this.projectionTileKey = null; // Key of tile currently used for GPU projection (don't prune)
        this.atlasTileKeys = new Set(); // All tiles used in current atlas (don't prune any)
        
        // Terrain atlas for GPU projection
        this.atlasTexture = null;
        this.atlasBounds = null; // { minX, minY, maxX, maxY } in clip space
        this.atlasSize = 1024; // Atlas texture size (covers multiple tiles)
    }

    /**
     * Set the camera uniform buffer (shared with main renderer)
     */
    setCameraBuffer(buffer) {
        this.cameraBuffer = buffer;
        // Recreate bind groups for all cached tiles
        for (const [key, tile] of this.terrainTiles) {
            tile.bindGroup = this.createTileBindGroup(tile);
        }
    }

    async initialize(format) {
        this.format = format;
        
        // Create shader from imported shader code
        const shaderModule = this.device.createShaderModule({ code: terrainShaderCode });
        
        // Create sampler
        this.sampler = this.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge'
        });
        
        // Create bind group layout
        this.bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
                { binding: 3, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } } // Tile info
            ]
        });
        
        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [this.bindGroupLayout]
        });
        
        // Create pipeline for hillshade overlay
        this.pipeline = this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: shaderModule,
                entryPoint: 'vs_main',
                buffers: [{
                    arrayStride: 20, // x, y, u, v, isSkirt (5 floats)
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x2' },  // clipPos
                        { shaderLocation: 1, offset: 8, format: 'float32x2' },  // uv
                        { shaderLocation: 2, offset: 16, format: 'float32' }    // isSkirt
                    ]
                }]
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'fs_main',
                targets: [{
                    format: format
                    // No blend - opaque land surface
                }]
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'none'
            },
            depthStencil: {
                format: 'depth24plus',
                depthWriteEnabled: true,   // Write depth - solid surface
                depthCompare: 'less'       // Normal depth test
            },
            multisample: { count: 4 } // Match main renderer MSAA
        });
        
        // Create overlay pipeline with alpha blend for hillshade on top of vectors
        // Uses fs_overlay which outputs black with alpha to darken shaded slopes
        this.overlayPipeline = this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: shaderModule,
                entryPoint: 'vs_main',
                buffers: [{
                    arrayStride: 20, // x, y, u, v, isSkirt (5 floats)
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x2' },  // clipPos
                        { shaderLocation: 1, offset: 8, format: 'float32x2' },  // uv
                        { shaderLocation: 2, offset: 16, format: 'float32' }    // isSkirt
                    ]
                }]
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'fs_overlay',  // Use overlay fragment shader
                targets: [{
                    format: format,
                    blend: {
                        // Alpha blend: black with alpha darkens underlying colors
                        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
                    }
                }]
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'none'
            },
            depthStencil: {
                format: 'depth24plus',
                depthWriteEnabled: false,  // Don't write depth - overlay only
                depthCompare: 'always'     // Always render on top as overlay
            },
            multisample: { count: 4 } // Match main renderer MSAA
        });
        
        // Grid mesh will be created per-tile with transformed coordinates
        this.gridSize = 128; // Higher resolution for better edge alignment
        this.gridIndices = this.createGridIndices();
        this.initialized = true;
        console.log('🏔️ TerrainLayer initialized');
    }

    /**
     * Create grid index buffer (same for all tiles)
     */
    createGridIndices() {
        const indices = [];
        const n = this.gridSize;
        
        // Create triangle indices for grid
        for (let y = 0; y < n; y++) {
            for (let x = 0; x < n; x++) {
                const i = y * (n + 1) + x;
                indices.push(i, i + 1, i + n + 1);
                indices.push(i + 1, i + n + 2, i + n + 1);
            }
        }
        
        const indexBuffer = this.createBuffer(new Uint32Array(indices), GPUBufferUsage.INDEX);
        return { buffer: indexBuffer, count: indices.length };
    }

    /**
     * Create grid mesh for a specific tile with pre-transformed Mercator coordinates
     * Simple grid mesh - no overlap, no skirts
     */
    createTileMesh(z, x, y) {
        const vertices = [];
        const n = this.gridSize;
        const extent = 4096; // Standard tile extent
        
        // Create grid vertices at exact tile boundaries
        // Vertex format: clipX, clipY, u, v, unused (kept for compatibility)
        for (let gy = 0; gy <= n; gy++) {
            for (let gx = 0; gx <= n; gx++) {
                // Grid position -> tile pixel position (0 to extent exactly)
                const tilePixelX = (gx / n) * extent;
                const tilePixelY = (gy / n) * extent;
                
                // Transform to clip space
                const [clipX, clipY] = transformTileCoords(tilePixelX, tilePixelY, x, y, z, extent);
                
                // UV for texture sampling
                const u = gx / n;
                const v = gy / n;
                
                vertices.push(clipX, clipY, u, v, 0.0);
            }
        }
        
        return this.createBuffer(new Float32Array(vertices), GPUBufferUsage.VERTEX);
    }

    createBuffer(data, usage) {
        const buffer = this.device.createBuffer({
            size: data.byteLength,
            usage: usage | GPUBufferUsage.COPY_DST
        });
        this.device.queue.writeBuffer(buffer, 0, data);
        return buffer;
    }

    async loadTerrainTile(z, x, y) {
        const key = `${z}/${x}/${y}`;
        
        // Already loaded, loading, or failed
        if (this.terrainTiles.has(key)) {
            return this.terrainTiles.get(key);
        }
        if (this.loadingTiles.has(key) || this.failedTiles.has(key)) {
            return null;
        }
        
        this.loadingTiles.add(key);
        
        const sourceConfig = TERRAIN_SOURCES[this.source];
        const url = sourceConfig.url
            .replace('{z}', z)
            .replace('{x}', x)
            .replace('{y}', y);
        
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            
            const blob = await response.blob();
            const bitmap = await createImageBitmap(blob);
            
            // Extract raw pixel data for CPU-side height sampling
            // Create offscreen canvas to read pixels
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bitmap, 0, 0);
            const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
            
            // Create GPU texture (include COPY_SRC for atlas building)
            const texture = this.device.createTexture({
                size: [bitmap.width, bitmap.height],
                format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT
            });
            
            this.device.queue.copyExternalImageToTexture(
                { source: bitmap },
                { texture },
                [bitmap.width, bitmap.height]
            );
            
            // Create per-tile vertex buffer with pre-transformed Mercator coordinates
            const vertexBuffer = this.createTileMesh(z, x, y);
            
            // Create tile info buffer (exaggeration only - 16 bytes for alignment)
            // TileInfo struct: exaggeration(f32) + 3 padding(f32) = 16 bytes
            const tileInfoBuffer = this.device.createBuffer({
                size: 16,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
            });
            
            const tileData = {
                texture,
                vertexBuffer,
                tileInfoBuffer,
                bindGroup: null,
                z, x, y,
                imageData,  // Store for CPU height sampling
                width: bitmap.width,
                height: bitmap.height
            };
            
            // Create bind group if camera buffer is available
            if (this.cameraBuffer) {
                tileData.bindGroup = this.createTileBindGroup(tileData);
            }
            
            this.terrainTiles.set(key, tileData);
            this.loadingTiles.delete(key);
            // Silently load - only log errors
            return tileData;
            
        } catch (error) {
            this.loadingTiles.delete(key);
            this.failedTiles.add(key); // Don't retry failed tiles
            // Only log non-404 errors
            if (!error.message.includes('404')) {
                console.warn(`Failed to load terrain tile ${key}:`, error.message);
            }
            return null;
        }
    }

    /**
     * Get visible terrain tiles - simple approach matching vector tile coverage
     */
    getVisibleTerrainTiles(camera, zoom) {
        const source = TERRAIN_SOURCES[this.source];
        
        // Only show terrain at configured min zoom or higher
        if (zoom < this.minDisplayZoom) {
            return [];
        }
        
        // Clamp to terrain source limits
        const tileZoom = Math.min(
            Math.max(Math.floor(zoom), source.minZoom), 
            source.maxZoom
        );
        
        // Debug: log zoom levels once
        if (!this._loggedZoomLevels) {
            console.log(`🏔️ Terrain zoom: view=${zoom.toFixed(1)}, tileZoom=${tileZoom}, source range=${source.minZoom}-${source.maxZoom}`);
            this._loggedZoomLevels = true;
        }
        
        // Use the same visible tiles function as vector tiles
        // This ensures terrain loads exactly where vector tiles load
        return getVisibleTiles(camera, tileZoom);
    }

    /**
     * Calculate tile bounds in clip space using EXACT same transform as vector tiles
     * Uses transformTileCoords from vectorTileParser for tile corners
     */
    getTileBounds(z, x, y) {
        // Use the SAME coordinate transform as vector tiles
        // transformTileCoords(x, y, tileX, tileY, zoom, extent)
        // For tile corners: x=0,y=0 is top-left, x=extent,y=extent is bottom-right
        const extent = 4096;
        
        // Top-left corner (x=0, y=0 in tile coords)
        const [minX, maxY] = transformTileCoords(0, 0, x, y, z, extent);
        
        // Bottom-right corner (x=extent, y=extent in tile coords)
        const [maxX, minY] = transformTileCoords(extent, extent, x, y, z, extent);
        
        return { minX, minY, maxX, maxY };
    }

    /**
     * Render terrain tiles
     */
    render(pass, cameraMatrix, camera, zoom) {
        // Multiple safety checks
        if (!this.enabled) return;
        if (!this.initialized) return;
        if (!this.pipeline) return;
        if (!this.cameraBuffer) return;
        if (!this.gridIndices || !this.gridIndices.buffer) return;
        
        const visibleTiles = this.getVisibleTerrainTiles(camera, zoom);
        if (visibleTiles.length === 0) {
            return; // Silently return - no spam
        }
        
        // Prune invisible tiles to prevent memory buildup
        // Only do this occasionally to avoid performance hit
        if (!this._lastPruneTime || (performance.now() - this._lastPruneTime) > 5000) {
            this.pruneInvisibleTiles(visibleTiles);
            this._lastPruneTime = performance.now();
        }
        
        // Log once when tiles are requested
        if (!this._loggedVisibleTiles) {
          //  console.log('🏔️ Visible tiles:', visibleTiles.map(t => `${t.z}/${t.x}/${t.y}`).join(', '));
            this._loggedVisibleTiles = true;
        }
        
        // Check if we have any loaded tiles to render
        let hasLoadedTiles = false;
        let loadedCount = 0;
        for (const tile of visibleTiles) {
            const tileData = this.terrainTiles.get(`${tile.z}/${tile.x}/${tile.y}`);
            if (tileData && tileData.bindGroup) {
                hasLoadedTiles = true;
                loadedCount++;
            }
        }
        
        // If no tiles loaded yet, just queue them for loading and return
        if (!hasLoadedTiles) {
            for (const tile of visibleTiles) {
                const key = `${tile.z}/${tile.x}/${tile.y}`;
                if (!this.terrainTiles.has(key) && !this.loadingTiles.has(key)) {
                    this.loadTerrainTile(tile.z, tile.x, tile.y);
                }
            }
            return;
        }
        
        // Log when we start rendering
        if (!this._loggedRendering) {
           // console.log(`🏔️ Rendering ${loadedCount}/${visibleTiles.length} terrain tiles`);
            this._loggedRendering = true;
        }
        
        pass.setPipeline(this.pipeline);
        pass.setIndexBuffer(this.gridIndices.buffer, 'uint32');
        
        let renderedCount = 0;
        for (const tile of visibleTiles) {
            const tileData = this.terrainTiles.get(`${tile.z}/${tile.x}/${tile.y}`);
            if (!tileData) {
                // Queue tile for loading
                this.loadTerrainTile(tile.z, tile.x, tile.y);
                continue;
            }
            
            // Ensure bind group exists (may have been created before camera buffer was set)
            if (!tileData.bindGroup) {
                tileData.bindGroup = this.createTileBindGroup(tileData);
            }
            if (!tileData.bindGroup) continue;
            if (!tileData.vertexBuffer) continue;
            
            // Update tile info buffer with exaggeration only
            const tileInfo = new Float32Array([
                this.exaggeration, 0, 0, 0  // exaggeration + padding
            ]);
            this.device.queue.writeBuffer(tileData.tileInfoBuffer, 0, tileInfo);
            
            // Use per-tile vertex buffer with pre-transformed coordinates
            pass.setVertexBuffer(0, tileData.vertexBuffer);
            pass.setBindGroup(0, tileData.bindGroup);
            pass.drawIndexed(this.gridIndices.count);
            renderedCount++;
        }
        
        // Log draw call count once per enable
        if (!this._loggedDrawCalls && renderedCount > 0) {
            console.log(`🏔️ Drew ${renderedCount} terrain tiles with ${this.gridIndices.count} indices each`);
            this._loggedDrawCalls = true;
        }
    }

    /**
     * Render terrain as a multiply overlay on top of vector layers
     * Uses multiply blend to apply hillshade (darken slopes, preserve lit areas)
     */
    renderOverlay(pass, cameraMatrix, camera, zoom) {
        // Multiple safety checks
        if (!this.enabled) return;
        if (!this.initialized) return;
        if (!this.overlayPipeline) return;
        if (!this.cameraBuffer) return;
        if (!this.gridIndices || !this.gridIndices.buffer) return;
        
        const visibleTiles = this.getVisibleTerrainTiles(camera, zoom);
        if (visibleTiles.length === 0) return;
        
        pass.setPipeline(this.overlayPipeline);
        pass.setIndexBuffer(this.gridIndices.buffer, 'uint32');
        
        for (const tile of visibleTiles) {
            const tileData = this.terrainTiles.get(`${tile.z}/${tile.x}/${tile.y}`);
            if (!tileData) {
                // Queue tile for loading
                this.loadTerrainTile(tile.z, tile.x, tile.y);
                continue;
            }
            
            if (!tileData.bindGroup) {
                tileData.bindGroup = this.createTileBindGroup(tileData);
            }
            if (!tileData.bindGroup) continue;
            if (!tileData.vertexBuffer) continue;
            
            // Update tile info buffer with exaggeration
            const tileInfo = new Float32Array([
                this.exaggeration, 0, 0, 0
            ]);
            this.device.queue.writeBuffer(tileData.tileInfoBuffer, 0, tileInfo);
            
            pass.setVertexBuffer(0, tileData.vertexBuffer);
            pass.setBindGroup(0, tileData.bindGroup);
            pass.drawIndexed(this.gridIndices.count);
        }
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        // Reset logging flags for fresh debug output
        this._loggedVisibleTiles = false;
        this._loggedRendering = false;
        this._loggedDrawCalls = false;
        this._loggedBounds = false;
        // Clear old tiles when toggling to free memory
        if (!enabled) {
            this.clearTileCache();
        }
    }
    
    /**
     * Clear terrain tile cache and free GPU resources
     * Waits for GPU operations to complete before destroying textures
     */
    async clearTileCache() {
        // Wait for any pending GPU work before destroying textures
        await this.device.queue.onSubmittedWorkDone();
        
        this.projectionTileKey = null; // Clear projection reference first
        this.atlasTileKeys.clear(); // Clear atlas tile tracking
        
        for (const [key, tile] of this.terrainTiles) {
            if (tile.texture) tile.texture.destroy();
            if (tile.vertexBuffer) tile.vertexBuffer.destroy();
            if (tile.tileInfoBuffer) tile.tileInfoBuffer.destroy();
        }
        this.terrainTiles.clear();
        this.loadingTiles.clear();
        this.failedTiles.clear();
        console.log('🏔️ Terrain tile cache cleared');
    }
    
    /**
     * Clear terrain tiles that are no longer visible
     * Call this on zoom change to prevent memory buildup
     * Skips the tile currently used for GPU projection to prevent destroyed texture errors
     */
    pruneInvisibleTiles(visibleTiles) {
        const visibleKeys = new Set(visibleTiles.map(t => `${t.z}/${t.x}/${t.y}`));
        const keysToRemove = [];
        
        for (const [key, tile] of this.terrainTiles) {
            // Don't prune the tile currently used for GPU projection
            if (key === this.projectionTileKey) continue;
            
            // Don't prune any tiles used in the current atlas
            if (this.atlasTileKeys.has(key)) continue;
            
            if (!visibleKeys.has(key)) {
                keysToRemove.push(key);
            }
        }
        
        for (const key of keysToRemove) {
            const tile = this.terrainTiles.get(key);
            if (tile.texture) tile.texture.destroy();
            if (tile.vertexBuffer) tile.vertexBuffer.destroy();
            if (tile.tileInfoBuffer) tile.tileInfoBuffer.destroy();
            this.terrainTiles.delete(key);
        }
        
        if (keysToRemove.length > 0) {
            console.log(`🏔️ Pruned ${keysToRemove.length} terrain tiles, ${this.terrainTiles.size} remaining`);
        }
    }

    /**
     * Get the first available terrain tile (for GPU projection)
     * Returns the tile data including texture and bounds info
     * Marks the tile as in-use to prevent pruning while referenced
     */
    getFirstAvailableTile() {
        for (const [key, tileData] of this.terrainTiles) {
            if (tileData.texture) {
                // Track this tile as in-use for projection
                this.projectionTileKey = key;
                return tileData;
            }
        }
        this.projectionTileKey = null;
        return null;
    }

    setExaggeration(factor) {
        this.exaggeration = factor;
    }

    setMinDisplayZoom(zoom) {
        this.minDisplayZoom = zoom;
    }

    getMinDisplayZoom() {
        return this.minDisplayZoom;
    }

    setSource(source) {
        if (TERRAIN_SOURCES[source]) {
            this.source = source;
            this.terrainTiles.clear(); // Clear cached tiles when source changes
        }
    }

    /**
     * Create a bind group for a terrain tile
     */
    createTileBindGroup(tileData) {
        if (!this.cameraBuffer) return null;
        
        return this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.cameraBuffer } },
                { binding: 1, resource: tileData.texture.createView() },
                { binding: 2, resource: this.sampler },
                { binding: 3, resource: { buffer: tileData.tileInfoBuffer } }
            ]
        });
    }

    destroy() {
        for (const [key, tile] of this.terrainTiles) {
            tile.texture.destroy();
            if (tile.vertexBuffer) tile.vertexBuffer.destroy();
        }
        this.terrainTiles.clear();
        if (this.gridIndices) {
            this.gridIndices.buffer.destroy();
        }
    }

    /**
     * Get terrain height data for vector shader projection
     * Returns the terrain texture and bounds info for a specific tile
     * This allows vector layers to sample terrain height
     */
    getTerrainForTile(z, x, y) {
        const key = `${z}/${x}/${y}`;
        const tileData = this.terrainTiles.get(key);
        if (!tileData) return null;
        
        return {
            texture: tileData.texture,
            sampler: this.sampler,
            bounds: this.getTileBounds(z, x, y),
            exaggeration: this.exaggeration
        };
    }

    /**
     * Get the height scaling factor used in terrain rendering
     * This should match the shader's height calculation
     */
    getHeightScale() {
        // Must match shader: (height / 50000000.0) * exaggeration
        return this.exaggeration / 50000000.0;
    }

    /**
     * Build a terrain atlas texture from all visible tiles
     * This combines multiple terrain tiles into a single texture for GPU sampling
     * Returns { texture, bounds } or null if no tiles available
     */
    buildTerrainAtlas(visibleTiles) {
        // Clear previous atlas tile tracking
        this.atlasTileKeys.clear();
        
        // Get all loaded terrain tiles
        const loadedTiles = [];
        for (const tile of visibleTiles) {
            const key = `${tile.z}/${tile.x}/${tile.y}`;
            const tileData = this.terrainTiles.get(key);
            if (tileData && tileData.texture) {
                // Track this tile as being used in the atlas
                this.atlasTileKeys.add(key);
                loadedTiles.push({
                    ...tileData,
                    bounds: this.getTileBounds(tile.z, tile.x, tile.y)
                });
            }
        }
        
        if (loadedTiles.length === 0) return null;
        
        // Calculate combined bounds
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const tile of loadedTiles) {
            minX = Math.min(minX, tile.bounds.minX);
            minY = Math.min(minY, tile.bounds.minY);
            maxX = Math.max(maxX, tile.bounds.maxX);
            maxY = Math.max(maxY, tile.bounds.maxY);
        }
        
        this.atlasBounds = { minX, minY, maxX, maxY };
        
        // For single tile, just return it directly (no atlas needed)
        if (loadedTiles.length === 1) {
            return {
                texture: loadedTiles[0].texture,
                bounds: this.atlasBounds,
                tilesX: 1,
                tilesY: 1
            };
        }
        
        // For multiple tiles, create atlas texture
        // Calculate atlas dimensions based on tile arrangement
        const boundsWidth = maxX - minX;
        const boundsHeight = maxY - minY;
        
        // Safety check for degenerate bounds
        if (boundsWidth <= 0 || boundsHeight <= 0) {
            return {
                texture: loadedTiles[0].texture,
                bounds: this.atlasBounds
            };
        }
        
        // Determine tile size in atlas based on first tile
        const tilePixelSize = 256; // Standard terrain tile size
        
        // Calculate how many tiles fit in each direction
        const firstTile = loadedTiles[0];
        const tileClipWidth = firstTile.bounds.maxX - firstTile.bounds.minX;
        const tileClipHeight = firstTile.bounds.maxY - firstTile.bounds.minY;
        
        // Safety check
        if (tileClipWidth <= 0 || tileClipHeight <= 0) {
            return {
                texture: loadedTiles[0].texture,
                bounds: this.atlasBounds,
                tilesX: 1,
                tilesY: 1
            };
        }
        
        const tilesX = Math.max(1, Math.ceil(boundsWidth / tileClipWidth));
        const tilesY = Math.max(1, Math.ceil(boundsHeight / tileClipHeight));
        
        const atlasWidth = tilesX * tilePixelSize;
        const atlasHeight = tilesY * tilePixelSize;
        
        // Create or recreate atlas texture if needed
        if (!this.atlasTexture || 
            this.atlasTexture.width !== atlasWidth || 
            this.atlasTexture.height !== atlasHeight) {
            
            if (this.atlasTexture) {
                this.atlasTexture.destroy();
            }
            
            this.atlasTexture = this.device.createTexture({
                size: [atlasWidth, atlasHeight],
                format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
            });
        }
        
        // Copy each tile into the atlas at the correct position
        const commandEncoder = this.device.createCommandEncoder();
        
        for (const tile of loadedTiles) {
            // Calculate position in atlas (as integers)
            const atlasX = Math.round(((tile.bounds.minX - minX) / boundsWidth) * atlasWidth);
            const atlasY = Math.round(((maxY - tile.bounds.maxY) / boundsHeight) * atlasHeight);
            
            commandEncoder.copyTextureToTexture(
                { texture: tile.texture },
                { texture: this.atlasTexture, origin: { x: atlasX, y: atlasY, z: 0 } },
                { width: tilePixelSize, height: tilePixelSize, depthOrArrayLayers: 1 }
            );
        }
        
        this.device.queue.submit([commandEncoder.finish()]);
        
        return {
            texture: this.atlasTexture,
            bounds: this.atlasBounds,
            tilesX: tilesX,
            tilesY: tilesY
        };
    }

    /**
     * Check if terrain is ready for a given viewport
     */
    hasTerrainForViewport(visibleTiles) {
        for (const tile of visibleTiles) {
            const key = `${tile.z}/${tile.x}/${tile.y}`;
            if (this.terrainTiles.has(key)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Sample terrain height at a clip-space coordinate
     */
    sampleHeightAtClipCoord(clipX, clipY) {
        if (!this.enabled) return 0;
        
        for (const [key, tileData] of this.terrainTiles) {
            if (!tileData.imageData) continue;
            
            const bounds = this.getTileBounds(tileData.z, tileData.x, tileData.y);
            
            if (clipX >= bounds.minX && clipX <= bounds.maxX &&
                clipY >= bounds.minY && clipY <= bounds.maxY) {
                
                const u = (clipX - bounds.minX) / (bounds.maxX - bounds.minX);
                const v = (clipY - bounds.minY) / (bounds.maxY - bounds.minY);
                
                const px = Math.floor(u * (tileData.width - 1));
                const py = Math.floor((1 - v) * (tileData.height - 1));
                
                const idx = (py * tileData.width + px) * 4;
                const r = tileData.imageData.data[idx];
                const g = tileData.imageData.data[idx + 1];
                const b = tileData.imageData.data[idx + 2];
                
                const rawHeight = (r * 256 + g + b / 256) - 32768;
                const height = Math.max(rawHeight, 0);
                
                return (height / 50000000.0) * this.exaggeration;
            }
        }
        
        return 0;
    }
    /**
     * Sample terrain height for an array of vertices
     * 
     * @param {Float32Array} vertices - Vertex array with stride 7 (x,y,z,r,g,b,a)
     * @param {number} stride - Vertex stride in floats (default 7)
     * @returns {Float32Array} New vertex array with Z values adjusted for terrain
     */
    applyTerrainToVertices(vertices, stride = 7) {
        if (!this.enabled) return vertices;
        
        const result = new Float32Array(vertices.length);
        result.set(vertices);
        
        const vectorZOffset = 0.00005;
        
        for (let i = 0; i < vertices.length; i += stride) {
            const x = vertices[i];
            const y = vertices[i + 1];
            const z = vertices[i + 2];
            
            if (z === 0) {
                const terrainHeight = this.sampleHeightAtClipCoord(x, y);
                result[i + 2] = terrainHeight + vectorZOffset;
            } else {
                const terrainHeight = this.sampleHeightAtClipCoord(x, y);
                result[i + 2] = z + terrainHeight;
            }
        }
        
        return result;
    }
}
