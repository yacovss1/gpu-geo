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

import { fetchVectorTile, clearTileCache, resetNotFoundTiles } from './geojson.js';
import { batchParseGeoJSONFeaturesGPU } from './geojsonGPU.js';
import { parseGeoJSONFeature } from './geojson.js';
import { getVisibleTiles } from './tile-utils.js';

export class TileManager {
    constructor(device, performanceStats) {
        this.device = device;
        this.performanceStats = performanceStats;
        
        // Tile storage: Map<layerId, Array<tileBuffer>>
        this.visibleTileBuffers = new Map();
        this.hiddenTileBuffers = new Map();
        this.roofTileBuffers = new Map();  // Roof geometry for marker offset buffer
        
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
        const newRoofTileBuffers = new Map();
        
        // Load in batches
        const batchSize = 16;
        for (let i = 0; i < tilesToFetch.length; i += batchSize) {
            if (abortSignal?.aborted) {
                console.log('🛑 Batch loading cancelled');
                break;
            }
            
            const batch = tilesToFetch.slice(i, i + batchSize);
            await this.loadTileBatch(batch, newTileBuffers, newHiddenTileBuffers, newRoofTileBuffers, abortSignal);
        }
        
        if (abortSignal?.aborted) {
            console.log('🛑 Skipping buffer update - aborted');
            return;
        }
        
        // Merge new buffers into existing
        this.mergeTileBuffers(newTileBuffers, newHiddenTileBuffers, newRoofTileBuffers);
    }
    
    /**
     * Load a batch of tiles
     */
    async loadTileBatch(tiles, newTileBuffers, newHiddenTileBuffers, newRoofTileBuffers, abortSignal) {
        const tilePromises = tiles.map(async ({ x, y, z }) => {
            try {
                if (abortSignal?.aborted) return;
                
                const vectorTile = await fetchVectorTile(x, y, z, abortSignal);
                
                if (abortSignal?.aborted || !vectorTile?.layers) return;
                
                // Parse features (GPU or CPU based on performanceStats.gpuEnabled)
                const parsedFeatures = await this.parseVectorTile(vectorTile, x, y, z);
                
                if (abortSignal?.aborted) return;
                
                // Create GPU buffers for each feature
                parsedFeatures.forEach(feature => {
                    this.createBuffersForFeature(
                        feature,
                        z, x, y,
                        newTileBuffers,
                        newHiddenTileBuffers,
                        newRoofTileBuffers
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
     * Parse vector tile into features
     */
    async parseVectorTile(vectorTile, x, y, z) {
        const parsedFeatures = [];
        
        // Get current style for sourceId
        const { getStyle } = await import('../core/style.js');
        const currentStyle = getStyle();
        const sourceId = currentStyle ? Object.keys(currentStyle.sources)[0] : null;
        
        if (this.performanceStats.gpuEnabled) {
            // GPU path - process all layers together
            const features = [];
            for (const layerName in vectorTile.layers) {
                const layer = vectorTile.layers[layerName];
                for (let i = 0; i < layer.length; i++) {
                    const rawFeature = layer.feature(i);
                    const feature = rawFeature.toGeoJSON(x, y, z);
                    // Set layer name for style matching
                    feature.layer = { name: layerName };
                    features.push(feature);
                }
            }
            
            // batchParseGeoJSONFeaturesGPU(features, device, fillColor, sourceId, zoom, tileX, tileY, tileZ)
            const result = await batchParseGeoJSONFeaturesGPU(
                features,
                this.device,
                [0.0, 0.0, 0.0, 1.0], // fillColor
                sourceId,
                z,    // zoom
                x,    // tileX
                y,    // tileY
                z     // tileZ
            );
            
            parsedFeatures.push(...result);
            
        } else {
            // CPU fallback
            for (const layerName in vectorTile.layers) {
                const layer = vectorTile.layers[layerName];
                for (let i = 0; i < layer.length; i++) {
                    const rawFeature = layer.feature(i);
                    const feature = rawFeature.toGeoJSON(x, y, z);
                    feature.layer = { name: layerName };
                    const parsed = parseGeoJSONFeature(feature, [0.0, 0.0, 0.0, 1.0], sourceId, z);
                    if (parsed) {
                        parsedFeatures.push(parsed);
                    }
                }
            }
        }
        
        return parsedFeatures;
    }
    
    /**
     * Create GPU buffers for a single feature
     */
    createBuffersForFeature(parsedFeature, z, x, y, newTileBuffers, newHiddenTileBuffers, newRoofTileBuffers) {
        const {
            vertices, hiddenVertices, roofVertices, fillIndices, hiddenfillIndices, roofIndices,
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
        
        // Create hidden buffers (always needed for feature identification)
        let hiddenVertexBuffer, hiddenFillIndexBuffer;
        
        if (use3DGeometry) {
            // For 3D features, create hidden vertex buffer if we have any hidden vertices
            if (hiddenVertices.length > 0) {
                hiddenVertexBuffer = this.device.createBuffer({
                    size: this.alignBufferSize(hiddenVertices.byteLength),
                    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                });
                this.device.queue.writeBuffer(hiddenVertexBuffer, 0, this.padToAlignment(hiddenVertices));
                this.totalBuffersCreated++;
            }
            
            // Create hidden fill index buffer if we have footprint indices
            if (hiddenfillIndices.length > 0) {
                hiddenFillIndexBuffer = this.device.createBuffer({
                    size: this.alignBufferSize(hiddenfillIndices.byteLength),
                    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
                });
                this.device.queue.writeBuffer(hiddenFillIndexBuffer, 0, this.padToAlignment(hiddenfillIndices));
                this.totalBuffersCreated++;
            }
        } else {
            // For 2D features, create separate hidden buffers
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
        
        // DISABLED: Roof buffers completely disabled until we fix the rendering issue
        /*
        // Create roof buffers for 3D buildings (separate vertex buffer + index buffer)
        let roofVertexBuffer, roofIndexBuffer;
        if (use3DGeometry && roofVertices && roofVertices.length > 0 && roofIndices && roofIndices.length > 0) {
            // Create SEPARATE vertex buffer for roof geometry
            roofVertexBuffer = this.device.createBuffer({
                size: this.alignBufferSize(roofVertices.byteLength),
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            this.device.queue.writeBuffer(roofVertexBuffer, 0, this.padToAlignment(roofVertices));
            this.totalBuffersCreated++;
            
            // Create roof index buffer
            roofIndexBuffer = this.device.createBuffer({
                size: this.alignBufferSize(roofIndices.byteLength),
                usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            });
            this.device.queue.writeBuffer(roofIndexBuffer, 0, this.padToAlignment(roofIndices));
            this.totalBuffersCreated++;
        }
        */
        let roofVertexBuffer = null;
        let roofIndexBuffer = null;
        
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
        
        // Only add if we have valid hidden buffers
        if (hiddenVertexBuffer && hiddenFillIndexBuffer) {
            newHiddenTileBuffers.get(layerId).push({
                vertexBuffer: hiddenVertexBuffer,
                hiddenFillIndexBuffer: hiddenFillIndexBuffer,
                hiddenfillIndexCount: use3DGeometry ? hiddenfillIndices.length : hiddenfillIndices.length,
                properties,
                zoomLevel: z,
                tileX: x,
                tileY: y,
                isFilled,
                layerId: layerId
            });
        }
        
        // Add to roof tile buffers (only for 3D buildings with roof geometry)
        if (roofVertexBuffer && roofIndexBuffer && use3DGeometry) {
            if (!newRoofTileBuffers.has(layerId)) {
                newRoofTileBuffers.set(layerId, []);
            }
            newRoofTileBuffers.get(layerId).push({
                vertexBuffer: roofVertexBuffer,  // Use SEPARATE roof vertex buffer with encoded IDs!
                roofIndexBuffer,
                roofIndexCount: roofIndices.length,
                properties,
                zoomLevel: z,
                tileX: x,
                tileY: y,
                layerId: layerId
            });
            
            if (!window._roofBufferDebug) {
                console.log(`🏗️ Created roof buffer: layer=${layerId}, roofIndexCount=${roofIndices.length}, tile=${z}/${x}/${y}`);
                window._roofBufferDebug = true;
            }
        }
    }
    
    /**
     * Merge new tile buffers into existing
     */
    mergeTileBuffers(newTileBuffers, newHiddenTileBuffers, newRoofTileBuffers) {
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
        
        for (const [layerId, buffers] of newRoofTileBuffers) {
            if (!this.roofTileBuffers.has(layerId)) {
                this.roofTileBuffers.set(layerId, []);
            }
            this.roofTileBuffers.get(layerId).push(...buffers);
        }
    }
    
    /**
     * Destroy tiles not at current zoom level
     */
    destroyTilesAtWrongZoom(currentZoom) {
        console.log(`🗑️ Removing tiles from old zoom, keeping zoom ${currentZoom}`);
        
        let destroyedCount = 0;
        
        // Destroy visible tile buffers (including shared vertex buffers)
        destroyedCount += this.destroyTilesWhere(
            this.visibleTileBuffers,
            tile => tile.zoomLevel !== currentZoom,
            ['vertexBuffer', 'fillIndexBuffer']
        );
        
        // Destroy hidden tile buffers (only index buffers, vertex already destroyed)
        destroyedCount += this.destroyTilesWhere(
            this.hiddenTileBuffers,
            tile => tile.zoomLevel !== currentZoom,
            ['hiddenFillIndexBuffer']
        );
        
        // Destroy roof tile buffers (only index buffers, vertex already destroyed)
        destroyedCount += this.destroyTilesWhere(
            this.roofTileBuffers,
            tile => tile.zoomLevel !== currentZoom,
            ['roofIndexBuffer']
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
                ['hiddenFillIndexBuffer']  // Don't destroy vertexBuffer - shared and already destroyed
            ) +
            this.destroyTilesWhere(
                this.roofTileBuffers,
                tile => !visibleKeys.has(`${tile.zoomLevel}/${tile.tileX}/${tile.tileY}`),
                ['roofIndexBuffer']  // Don't destroy vertexBuffer - shared and already destroyed
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
        
        // Destroy all visible buffers (including shared vertex buffers)
        this.visibleTileBuffers.forEach((tiles) => {
            tiles.forEach(tile => {
                if (tile.vertexBuffer) tile.vertexBuffer.destroy();
                if (tile.fillIndexBuffer) tile.fillIndexBuffer.destroy();
                this.totalBuffersDestroyed += 2;
            });
        });
        
        // Destroy all hidden buffers (vertex buffer already destroyed above, just destroy indices)
        this.hiddenTileBuffers.forEach((tiles) => {
            tiles.forEach(tile => {
                // Don't destroy vertexBuffer - it's shared with visible buffers and already destroyed
                if (tile.hiddenFillIndexBuffer) tile.hiddenFillIndexBuffer.destroy();
                this.totalBuffersDestroyed += 1;
            });
        });
        
        // Destroy all roof buffers (vertex buffer already destroyed above, just destroy indices)
        this.roofTileBuffers.forEach((tiles) => {
            tiles.forEach(tile => {
                if (tile.roofIndexBuffer) tile.roofIndexBuffer.destroy();
                this.totalBuffersDestroyed += 1;
            });
        });
        
        this.visibleTileBuffers.clear();
        this.hiddenTileBuffers.clear();
        this.roofTileBuffers.clear();
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
