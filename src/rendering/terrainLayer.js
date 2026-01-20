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
        this.bindGroupLayout = null;
        this.sampler = null;
        this.gridIndices = null; // Shared index buffer (same for all tiles)
        this.gridSize = 64; // Vertices per tile edge
        this.enabled = false;  // Disabled by default until properly fixed
        this.source = 'aws';
        this.exaggeration = 1.5; // Height exaggeration factor (1.0 = realistic, higher = more dramatic)
        this.minDisplayZoom = 8; // Only show terrain at this zoom level or higher
        this.cameraBuffer = null; // Set from main renderer
        this.initialized = false;
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
                { binding: 1, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'float' } },
                { binding: 2, visibility: GPUShaderStage.VERTEX, sampler: { type: 'filtering' } },
                { binding: 3, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } } // Tile info
            ]
        });
        
        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [this.bindGroupLayout]
        });
        
        // Create pipeline
        this.pipeline = this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: shaderModule,
                entryPoint: 'vs_main',
                buffers: [{
                    arrayStride: 16, // x, y, u, v
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x2' },
                        { shaderLocation: 1, offset: 8, format: 'float32x2' }
                    ]
                }]
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'fs_main',
                targets: [{
                    format: format,
                    blend: {
                        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
                    }
                }]
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'none'  // Disable culling for now - triangles may be wound incorrectly
            },
            depthStencil: {
                format: 'depth24plus',
                depthWriteEnabled: true,   // Write to depth buffer
                depthCompare: 'less-equal' // Standard depth test - terrain at Z<0 will be behind vector tiles at Z>=0
            },
            multisample: { count: 4 } // Match main renderer MSAA
        });
        
        // Grid mesh will be created per-tile with transformed coordinates
        this.gridSize = 64; // Vertices per tile edge
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
        
        // Create triangle indices
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
     */
    createTileMesh(z, x, y) {
        const vertices = [];
        const n = this.gridSize;
        const extent = 4096; // Standard tile extent
        
        // Create grid vertices with coordinates transformed using same math as vector tiles
        for (let gy = 0; gy <= n; gy++) {
            for (let gx = 0; gx <= n; gx++) {
                // Grid position -> tile pixel position (0 to extent)
                const tilePixelX = (gx / n) * extent;
                const tilePixelY = (gy / n) * extent;
                
                // Transform to clip space using EXACT same function as vector tiles
                const [clipX, clipY] = transformTileCoords(tilePixelX, tilePixelY, x, y, z, extent);
                
                // UV for texture sampling
                const u = gx / n;
                const v = gy / n;
                
                vertices.push(clipX, clipY, u, v);
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
            
            // Create GPU texture
            const texture = this.device.createTexture({
                size: [bitmap.width, bitmap.height],
                format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
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
                z, x, y
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

    setEnabled(enabled) {
        this.enabled = enabled;
        // Reset logging flags for fresh debug output
        this._loggedVisibleTiles = false;
        this._loggedRendering = false;
        this._loggedDrawCalls = false;
        this._loggedBounds = false;
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
}
