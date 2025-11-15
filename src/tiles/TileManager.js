/**
 * TileManager - Handles tile loading, caching, and GPU buffer lifecycle
 * 
 * Responsibilities:
 * - Load visible tiles based on viewport
 * - Manage tile cache (LRU eviction)
 * - Create and destroy GPU buffers for tiles
 * - Track tile memory usage
 * - Handle zoom level changes
 */

import { fetchVectorTile, clearTileCache, resetNotFoundTiles, parseGeoJSONFeature } from './geojson.js';
import { getVisibleTiles } from './tile-utils.js';

export class TileManager {
    constructor(device, performanceStats) {
        this.device = device;
        this.performanceStats = performanceStats;
        
        // Tile storage: Map<layerId, Array<tileBuffer>>
        this.visibleTileBuffers = new Map();
        this.hiddenTileBuffers = new Map();
        
        // Tracking
        this.lastFetchZoom = -1;
        this.currentAbortController = null;
        this.isTileLoadInProgress = false;
        
        // Memory management
        this.maxTilesPerLayer = 100; // Configurable limit
        this.totalBuffersCreated = 0;
        this.totalBuffersDestroyed = 0;
    }
    
    /**
     * Load tiles visible in the current viewport
     */
    async loadVisibleTiles(camera, fetchZoom, shouldClearOldTiles = false) {
        // Skip if already loading
        if (this.isTileLoadInProgress) {
            console.log('⏭️ Skipping tile load - already in progress');
            if (this.currentAbortController) {
                this.currentAbortController.abort();
                this.currentAbortController = null;
            }
            return;
        }
        
        this.isTileLoadInProgress = true;
        
        // Create new abort controller for this request
        this.currentAbortController = new AbortController();
        const abortSignal = this.currentAbortController.signal;
        
        try {
            const visibleTiles = getVisibleTiles(camera, fetchZoom);
            
            if (visibleTiles.length === 0) {
                return;
            }
            
            console.log(`📦 Loading ${visibleTiles.length} tiles at zoom ${fetchZoom}`);
            
            // Handle zoom changes or pan-based cleanup
            if (shouldClearOldTiles && this.lastFetchZoom !== fetchZoom) {
                this.destroyTilesAtWrongZoom(fetchZoom);
            } else if (!shouldClearOldTiles && this.lastFetchZoom === fetchZoom) {
                this.destroyOffscreenTiles(visibleTiles);
            }
            
            // Find tiles we need to fetch
            const existingTileKeys = this.getExistingTileKeys();
            const tilesToFetch = visibleTiles.filter(tile => 
                !existingTileKeys.has(`${tile.z}/${tile.x}/${tile.y}`)
            );
            
            console.log(`📦 Existing: ${existingTileKeys.size}, Fetching: ${tilesToFetch.length}`);
            
            if (tilesToFetch.length > 0) {
                await this.fetchAndCreateTileBuffers(tilesToFetch, abortSignal);
            }
            
            this.lastFetchZoom = fetchZoom;
            
        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('🛑 Tile loading aborted');
            } else {
                console.warn('Error loading tiles:', error);
            }
        } finally {
            this.isTileLoadInProgress = false;
            this.currentAbortController = null;
        }
    }
    
    /**
     * Fetch tiles and create GPU buffers
     */
    async fetchAndCreateTileBuffers(tilesToFetch, abortSignal) {
        const newTileBuffers = new Map();
        const newHiddenTileBuffers = new Map();
        
        // Load in batches
        const batchSize = 16;
        for (let i = 0; i < tilesToFetch.length; i += batchSize) {
            if (abortSignal?.aborted) {
                console.log('🛑 Batch loading cancelled');
                break;
            }
            
            const batch = tilesToFetch.slice(i, i + batchSize);
            await this.loadTileBatch(batch, newTileBuffers, newHiddenTileBuffers, abortSignal);
        }
        
        if (abortSignal?.aborted) {
            console.log('🛑 Skipping buffer update - aborted');
            return;
        }
        
        // Merge new buffers into existing
        this.mergeTileBuffers(newTileBuffers, newHiddenTileBuffers);
    }
    
    /**
     * Load a batch of tiles
     */
    async loadTileBatch(tiles, newTileBuffers, newHiddenTileBuffers, abortSignal) {
        const tilePromises = tiles.map(async ({ x, y, z }) => {
            try {
                if (abortSignal?.aborted) return;
                
                const vectorTile = await fetchVectorTile(x, y, z, abortSignal);
                
                if (abortSignal?.aborted || !vectorTile?.layers) return;
                
                // Parse features with pre-transformed coordinates from vectorTileParser
                const parsedFeatures = await this.parseVectorTile(vectorTile, x, y, z);
                
                if (abortSignal?.aborted) return;
                
                // Create GPU buffers for each feature
                parsedFeatures.forEach(feature => {
                    this.createBuffersForFeature(
                        feature,
                        z, x, y,
                        newTileBuffers,
                        newHiddenTileBuffers
                    );
                });
                
            } catch (err) {
                if (!abortSignal?.aborted) {
                    console.warn(`Error loading tile ${z}/${x}/${y}:`, err);
                }
            }
        });
        
        await Promise.allSettled(tilePromises);
    }
    
    /**
     * Parse vector tile into features using DIRECT coordinate transform
     * No toGeoJSON(), no GPU roundtrip - just pure CPU tile→Mercator transform
     */
    async parseVectorTile(vectorTile, x, y, z) {
        const parsedFeatures = [];
        
        // Get current style for sourceId
        const { getStyle } = await import('../core/style.js');
        const currentStyle = getStyle();
        const sourceId = currentStyle ? Object.keys(currentStyle.sources)[0] : null;
        
        // Parse all features with pre-transformed coordinates from vectorTileParser
        // Coordinates are already in Mercator clip space - no GPU roundtrip needed
        for (const layerName in vectorTile.layers) {
            const layer = vectorTile.layers[layerName];
            for (const feature of layer.features) {
                const parsed = parseGeoJSONFeature(feature, [0.0, 0.0, 0.0, 1.0], sourceId, z);
                if (parsed) {
                    parsedFeatures.push(parsed);
                }
            }
        }
        
        return parsedFeatures;
    }
    
    /**
     * Create GPU buffers for a single feature
     */
    createBuffersForFeature(parsedFeature, z, x, y, newTileBuffers, newHiddenTileBuffers) {
        const {
            vertices, hiddenVertices, fillIndices, hiddenfillIndices,
            isFilled, isLine, properties, layerId
        } = parsedFeature;
        
        if (vertices.length === 0 || fillIndices.length === 0) {
            return; // Skip empty geometry
        }
        
        // Determine if this is a 3D feature
        const use3DGeometry = layerId.includes('building') || layerId.includes('extrusion');
        
        // Create vertex buffer
        const vertexBuffer = this.device.createBuffer({
            size: this.alignBufferSize(vertices.byteLength),
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(vertexBuffer, 0, this.padToAlignment(vertices));
        this.totalBuffersCreated++;
        
        // Create hidden buffers only for flat features
        let hiddenVertexBuffer, hiddenFillIndexBuffer;
        if (!use3DGeometry) {
            hiddenVertexBuffer = this.device.createBuffer({
                size: this.alignBufferSize(hiddenVertices.byteLength),
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            this.device.queue.writeBuffer(hiddenVertexBuffer, 0, this.padToAlignment(hiddenVertices));
            
            hiddenFillIndexBuffer = this.device.createBuffer({
                size: this.alignBufferSize(hiddenfillIndices.byteLength),
                usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            });
            this.device.queue.writeBuffer(hiddenFillIndexBuffer, 0, this.padToAlignment(hiddenfillIndices));
            this.totalBuffersCreated += 2;
        }
        
        // Create fill index buffer
        const fillIndexBuffer = this.device.createBuffer({
            size: this.alignBufferSize(fillIndices.byteLength),
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(fillIndexBuffer, 0, this.padToAlignment(fillIndices));
        this.totalBuffersCreated++;
        
        // Add to visible tile buffers
        if (!newTileBuffers.has(layerId)) {
            newTileBuffers.set(layerId, []);
        }
        newTileBuffers.get(layerId).push({
            vertexBuffer,
            fillIndexBuffer,
            fillIndexCount: fillIndices.length,
            isFilled,
            isLine,
            properties,
            zoomLevel: z,
            tileX: x,
            tileY: y,
            vertices: vertices,
            layerId: layerId
        });
        
        // Add to hidden tile buffers
        if (!newHiddenTileBuffers.has(layerId)) {
            newHiddenTileBuffers.set(layerId, []);
        }
        newHiddenTileBuffers.get(layerId).push({
            vertexBuffer: use3DGeometry ? vertexBuffer : hiddenVertexBuffer,
            hiddenFillIndexBuffer: use3DGeometry ? fillIndexBuffer : hiddenFillIndexBuffer,
            hiddenfillIndexCount: use3DGeometry ? fillIndices.length : hiddenfillIndices.length,
            properties,
            zoomLevel: z,
            tileX: x,
            tileY: y,
            isFilled,
            layerId: layerId
        });
    }
    
    /**
     * Merge new tile buffers into existing
     */
    mergeTileBuffers(newTileBuffers, newHiddenTileBuffers) {
        for (const [layerId, buffers] of newTileBuffers) {
            if (!this.visibleTileBuffers.has(layerId)) {
                this.visibleTileBuffers.set(layerId, []);
            }
            this.visibleTileBuffers.get(layerId).push(...buffers);
        }
        
        for (const [layerId, buffers] of newHiddenTileBuffers) {
            if (!this.hiddenTileBuffers.has(layerId)) {
                this.hiddenTileBuffers.set(layerId, []);
            }
            this.hiddenTileBuffers.get(layerId).push(...buffers);
        }
    }
    
    /**
     * Destroy tiles not at current zoom level
     */
    destroyTilesAtWrongZoom(currentZoom) {
        console.log(`🗑️ Removing tiles from old zoom, keeping zoom ${currentZoom}`);
        
        let destroyedCount = 0;
        
        // Destroy visible tile buffers
        destroyedCount += this.destroyTilesWhere(
            this.visibleTileBuffers,
            tile => tile.zoomLevel !== currentZoom,
            ['vertexBuffer', 'fillIndexBuffer']
        );
        
        // Destroy hidden tile buffers
        destroyedCount += this.destroyTilesWhere(
            this.hiddenTileBuffers,
            tile => tile.zoomLevel !== currentZoom,
            ['vertexBuffer', 'hiddenFillIndexBuffer']
        );
        
        if (destroyedCount > 0) {
            console.log(`♻️ Freed ${destroyedCount} GPU buffers on zoom change`);
        }
    }
    
    /**
     * Destroy tiles outside visible viewport
     */
    destroyOffscreenTiles(visibleTiles) {
        const visibleKeys = new Set(visibleTiles.map(t => `${t.z}/${t.x}/${t.y}`));
        
        const destroyedCount = 
            this.destroyTilesWhere(
                this.visibleTileBuffers,
                tile => !visibleKeys.has(`${tile.zoomLevel}/${tile.tileX}/${tile.tileY}`),
                ['vertexBuffer', 'fillIndexBuffer']
            ) +
            this.destroyTilesWhere(
                this.hiddenTileBuffers,
                tile => !visibleKeys.has(`${tile.zoomLevel}/${tile.tileX}/${tile.tileY}`),
                ['vertexBuffer', 'hiddenFillIndexBuffer']
            );
        
        if (destroyedCount > 0) {
            console.log(`♻️ Freed ${destroyedCount} off-screen tile buffers during pan`);
        }
    }
    
    /**
     * Generic destroy method with predicate
     */
    destroyTilesWhere(tileMap, shouldDestroy, bufferNames) {
        let destroyedCount = 0;
        
        for (const [layerId, tiles] of tileMap) {
            const toKeep = [];
            const toDestroy = [];
            
            tiles.forEach(tile => {
                if (shouldDestroy(tile)) {
                    toDestroy.push(tile);
                } else {
                    toKeep.push(tile);
                }
            });
            
            // Destroy GPU buffers
            toDestroy.forEach(tile => {
                bufferNames.forEach(bufferName => {
                    if (tile[bufferName]) {
                        tile[bufferName].destroy();
                        destroyedCount++;
                        this.totalBuffersDestroyed++;
                    }
                });
            });
            
            if (toDestroy.length > 0) {
                tileMap.set(layerId, toKeep);
            }
        }
        
        return destroyedCount;
    }
    
    /**
     * Get set of existing tile keys
     */
    getExistingTileKeys() {
        const keys = new Set();
        this.visibleTileBuffers.forEach((tiles) => {
            tiles.forEach(tile => {
                keys.add(`${tile.zoomLevel}/${tile.tileX}/${tile.tileY}`);
            });
        });
        return keys;
    }
    
    /**
     * Clear all tiles and destroy buffers
     */
    clearAll() {
        console.log('🗑️ Clearing all tiles');
        
        // Destroy all visible buffers
        this.visibleTileBuffers.forEach((tiles) => {
            tiles.forEach(tile => {
                if (tile.vertexBuffer) tile.vertexBuffer.destroy();
                if (tile.fillIndexBuffer) tile.fillIndexBuffer.destroy();
                this.totalBuffersDestroyed += 2;
            });
        });
        
        // Destroy all hidden buffers
        this.hiddenTileBuffers.forEach((tiles) => {
            tiles.forEach(tile => {
                if (tile.vertexBuffer) tile.vertexBuffer.destroy();
                if (tile.hiddenFillIndexBuffer) tile.hiddenFillIndexBuffer.destroy();
                this.totalBuffersDestroyed += 2;
            });
        });
        
        this.visibleTileBuffers.clear();
        this.hiddenTileBuffers.clear();
        clearTileCache();
        resetNotFoundTiles();
        
        console.log(`♻️ Destroyed all tile buffers (created: ${this.totalBuffersCreated}, destroyed: ${this.totalBuffersDestroyed})`);
    }
    
    /**
     * Get memory statistics
     */
    getMemoryStats() {
        let tileCount = 0;
        let bufferCount = 0;
        
        this.visibleTileBuffers.forEach(tiles => {
            tileCount += tiles.length;
            bufferCount += tiles.length * 2; // vertex + index
        });
        
        return {
            tileCount,
            bufferCount,
            totalCreated: this.totalBuffersCreated,
            totalDestroyed: this.totalBuffersDestroyed,
            leaked: this.totalBuffersCreated - this.totalBuffersDestroyed
        };
    }
    
    // Helper methods
    alignBufferSize(size) {
        return Math.ceil(size / 4) * 4;
    }
    
    padToAlignment(typedArray) {
        const size = typedArray.byteLength;
        const alignedSize = this.alignBufferSize(size);
        if (size === alignedSize) {
            return typedArray;
        }
        const padded = new Uint8Array(alignedSize);
        padded.set(new Uint8Array(typedArray.buffer));
        return padded;
    }
    
    /**
     * Abort current tile loading
     */
    abort() {
        if (this.currentAbortController) {
            this.currentAbortController.abort();
            console.log('🛑 Aborted tile loading');
            this.currentAbortController = null;
        }
    }
}
