/**
 * TileManager - Handles tile loading, caching, and GPU buffer lifecycle
 * 
 * Responsibilities:
 * - Load visible tiles based on viewport
 * - Manage tile cache (LRU eviction)
 * - Create and destroy GPU buffers for tiles
 * - Track tile memory usage
 * - Handle zoom level changes
 * - Coordinate terrain loading for CPU-side height baking
 */

import { fetchVectorTile, clearTileCache, resetNotFoundTiles, parseGeoJSONFeature } from './geojson.js';
import { getVisibleTiles } from './tile-utils.js';
import { getTileCoordinator } from './TileCoordinator.js';
import { TerrainPolygonBuilder } from '../rendering/terrainPolygonBuilder.js';

export class TileManager {
    constructor(device, performanceStats) {
        this.device = device;
        this.performanceStats = performanceStats;
        
        // Tile coordinator for terrain sync
        this.tileCoordinator = getTileCoordinator();
        
        // Terrain layer reference for terrain-based polygon rendering
        this.terrainLayer = null;
        
        // Terrain polygon builder - extracts terrain mesh vertices for polygons
        // Pass device for GPU compute acceleration
        this.terrainPolygonBuilder = new TerrainPolygonBuilder(device, 32);
        
        // Tile storage: Map<layerId, Array<tileBuffer>>
        this.visibleTileBuffers = new Map();
        this.hiddenTileBuffers = new Map();
        
        // Centerline storage for GPU terrain compute: Map<tileKey, Array<centerline>>
        this.tileCenterlines = new Map();
        
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
     * Set terrain layer for polygon rasterization
     */
    setTerrainLayer(terrainLayer) {
        this.terrainLayer = terrainLayer;
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
     * Pre-loads terrain for the batch before processing vectors
     */
    async loadTileBatch(tiles, newTileBuffers, newHiddenTileBuffers, abortSignal) {
        // Pre-load terrain for all tiles in this batch first
        // This ensures terrain height data is available for CPU-side baking
        await this.tileCoordinator.preloadTerrain(tiles);
        
        const tilePromises = tiles.map(async ({ x, y, z }) => {
            try {
                if (abortSignal?.aborted) return;
                
                // Get terrain data for this tile (should be cached from preload)
                const terrainData = this.tileCoordinator.getTerrainData(z, x, y);
                
                const vectorTile = await fetchVectorTile(x, y, z, abortSignal);
                
                if (abortSignal?.aborted || !vectorTile?.layers) return;
                
                // Parse features with pre-transformed coordinates from vectorTileParser
                // Pass terrain data for CPU-side height baking
                const parsedFeatures = await this.parseVectorTile(vectorTile, x, y, z, terrainData);
                
                if (abortSignal?.aborted) return;
                
                // Collect centerlines for GPU terrain compute
                const tileKey = `${z}/${x}/${y}`;
                const tileCenterlines = [];
                const tileTerrainPolygons = []; // Collect flat polygons for terrain-based geometry
                
                // Determine if we should build terrain-based polygon geometry
                // Only active at zoom 13+ where terrain detail is meaningful
                const minTerrainPolygonZoom = 13;
                const useTerrainPolygons = this.terrainLayer && 
                    this.terrainLayer.enabled && 
                    terrainData && 
                    z >= minTerrainPolygonZoom;
                
                // Create GPU buffers for each feature
                parsedFeatures.forEach(feature => {
                    // Collect terrain polygons BEFORE creating buffers
                    if (feature.terrainPolygons && feature.terrainPolygons.length > 0) {
                        tileTerrainPolygons.push(...feature.terrainPolygons.map(p => ({
                            ...p,
                            layerId: feature.layerId,
                            featureId: feature.featureId
                        })));
                    }
                    
                    // Skip flat polygon buffer creation if using terrain-based geometry
                    const skipThisPolygon = useTerrainPolygons && 
                        feature.terrainPolygons && 
                        feature.terrainPolygons.length > 0;
                    
                    if (!skipThisPolygon) {
                        this.createBuffersForFeature(
                            feature,
                            z, x, y,
                            newTileBuffers,
                            newHiddenTileBuffers,
                            false
                        );
                    }
                    
                    // Collect centerlines from line features
                    if (feature.lineCenterlines && feature.lineCenterlines.length > 0) {
                        tileCenterlines.push(...feature.lineCenterlines);
                    }
                });
                
                // Store centerlines for this tile (for GPU compute pipeline)
                if (tileCenterlines.length > 0) {
                    this.tileCenterlines.set(tileKey, tileCenterlines);
                }
                
                // Build terrain-based polygon geometry
                if (tileTerrainPolygons.length > 0 && useTerrainPolygons) {
                    console.log(`🏔️ Building ${tileTerrainPolygons.length} terrain polygons for tile ${tileKey}`);
                    
                    // Update exaggeration from terrain layer
                    if (this.terrainLayer) {
                        this.terrainPolygonBuilder.setExaggeration(this.terrainLayer.exaggeration);
                    }
                    
                    // Use CPU - GPU compute has too much readback overhead
                    for (const polygon of tileTerrainPolygons) {
                        const geometry = this.terrainPolygonBuilder.buildPolygonFromTerrain(
                            polygon, terrainData, z, x, y
                        );
                        
                        if (geometry && geometry.vertices.length > 0 && geometry.indices.length > 0) {
                            // Create GPU buffers for terrain-based polygon
                            this.createTerrainPolygonBuffers(
                                geometry,
                                polygon.layerId,
                                z, x, y,
                                newTileBuffers
                            );
                        }
                    }
                }
                
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
     * @param {Object} terrainData - Optional terrain data for height baking
     */
    async parseVectorTile(vectorTile, x, y, z, terrainData = null) {
        const parsedFeatures = [];
        
        // Get current style for sourceId
        const { getStyle } = await import('../core/style.js');
        const currentStyle = getStyle();
        const sourceId = currentStyle ? Object.keys(currentStyle.sources)[0] : null;
        
        // Parse all features with pre-transformed coordinates from vectorTileParser
        // Coordinates are already in Mercator clip space - no GPU roundtrip needed
        // If terrainData available, heights are baked into vertices
        for (const layerName in vectorTile.layers) {
            const layer = vectorTile.layers[layerName];
            for (const feature of layer.features) {
                const parsed = parseGeoJSONFeature(feature, [0.0, 0.0, 0.0, 1.0], sourceId, z, terrainData);
                if (parsed) {
                    parsedFeatures.push(parsed);
                }
            }
        }
        
        return parsedFeatures;
    }
    
    /**
     * Create GPU buffers for a single feature
     * @param {boolean} skipFlatPolygons - If true, skip flat polygons (rendered via terrain mesh)
     */
    createBuffersForFeature(parsedFeature, z, x, y, newTileBuffers, newHiddenTileBuffers, skipFlatPolygons = false) {
        const {
            vertices, hiddenVertices, fillIndices, hiddenfillIndices,
            isFilled, isLine, properties, layerId, terrainPolygons
        } = parsedFeature;
        
        // Skip flat polygons if they're being rendered via terrain mesh
        if (skipFlatPolygons && terrainPolygons && terrainPolygons.length > 0) {
            // This polygon will be rendered via terrain mesh texture sampling
            return;
        }
        
        if (vertices.length === 0 || fillIndices.length === 0) {
            return; // Skip empty geometry
        }
        
        // Terrain projection is now done in GPU vertex shader
        
        // Determine if this is a 3D feature
        const use3DGeometry = layerId.includes('building') || layerId.includes('extrusion');
        
        // Create vertex buffer
        const vertexBuffer = this.device.createBuffer({
            size: this.alignBufferSize(vertices.byteLength),
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(vertexBuffer, 0, this.padToAlignment(vertices));
        this.totalBuffersCreated++;
        
        // Create hidden buffers (separate geometry for picking/compute)
        // For buildings: flat base polygon at roof height (z coordinate)
        // For flat features: same as visible geometry
        let hiddenVertexBuffer, hiddenFillIndexBuffer;
        if (hiddenVertices.length > 0 && hiddenfillIndices.length > 0) {
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
            layerId: layerId,
            lineSegments: parsedFeature.lineSegments // Add line segment data for 3D tubes
        });
        
        // Add to hidden tile buffers
        if (!newHiddenTileBuffers.has(layerId)) {
            newHiddenTileBuffers.set(layerId, []);
        }
        newHiddenTileBuffers.get(layerId).push({
            vertexBuffer: hiddenVertexBuffer || vertexBuffer,
            hiddenFillIndexBuffer: hiddenFillIndexBuffer || fillIndexBuffer,
            hiddenfillIndexCount: hiddenFillIndexBuffer ? hiddenfillIndices.length : fillIndices.length,
            properties,
            zoomLevel: z,
            tileX: x,
            tileY: y,
            isFilled,
            layerId: layerId
        });
    }
    
    /**
     * Create GPU buffers for terrain-based polygon geometry
     * These polygons use vertices extracted from the terrain mesh
     */
    createTerrainPolygonBuffers(geometry, layerId, z, x, y, newTileBuffers) {
        const { vertices, indices } = geometry;
        
        if (vertices.length === 0 || indices.length === 0) {
            return;
        }
        
        // Create vertex buffer
        const vertexBuffer = this.device.createBuffer({
            size: this.alignBufferSize(vertices.byteLength),
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(vertexBuffer, 0, this.padToAlignment(vertices));
        this.totalBuffersCreated++;
        
        // Create index buffer
        const fillIndexBuffer = this.device.createBuffer({
            size: this.alignBufferSize(indices.byteLength),
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(fillIndexBuffer, 0, this.padToAlignment(indices));
        this.totalBuffersCreated++;
        
        // Add to tile buffers
        if (!newTileBuffers.has(layerId)) {
            newTileBuffers.set(layerId, []);
        }
        
        newTileBuffers.get(layerId).push({
            vertexBuffer,
            fillIndexBuffer,
            fillIndexCount: indices.length,
            isFilled: true,
            isLine: false,
            properties: {},
            zoomLevel: z,
            tileX: x,
            tileY: y,
            isTerrainPolygon: true, // Mark as terrain-based
            layerId: layerId
        });
        
        console.log(`🏔️ Created terrain polygon buffer: ${indices.length / 3} triangles for ${layerId}`);
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
     * Get all centerlines from currently visible tiles
     * @param {Array} visibleTiles - Array of { x, y, z } for visible tiles
     * @returns {Array} - Flat array of all centerline objects
     */
    getVisibleCenterlines(visibleTiles) {
        const centerlines = [];
        const visibleKeys = new Set(visibleTiles.map(t => `${t.z}/${t.x}/${t.y}`));
        
        for (const [tileKey, tileCenterlines] of this.tileCenterlines) {
            if (visibleKeys.has(tileKey)) {
                centerlines.push(...tileCenterlines);
            }
        }
        
        return centerlines;
    }
    
    /**
     * Get the set of tile keys that have centerlines
     * @returns {Set<string>}
     */
    getCenterlineTileKeys() {
        return new Set(this.tileCenterlines.keys());
    }
    
    /**
     * Get the set of all visible tile keys (z/x/y format)
     * @returns {Set<string>}
     */
    getVisibleTileKeys() {
        return this.getExistingTileKeys();
    }
    
    /**
     * Get all centerlines from all visible tiles (no parameter needed)
     * Uses internally tracked visible tiles
     * @returns {Array} - Flat array of all centerline objects
     */
    getAllVisibleCenterlines() {
        const visibleKeys = this.getVisibleTileKeys();
        const centerlines = [];
        
        for (const [tileKey, tileCenterlines] of this.tileCenterlines) {
            if (visibleKeys.has(tileKey)) {
                centerlines.push(...tileCenterlines);
            }
        }
        
        return centerlines;
    }

    /**
     * Clean up centerlines for tiles that are no longer visible
     * @param {Array} visibleTiles - Array of { x, y, z } for visible tiles
     */
    cleanupOldCenterlines(visibleTiles) {
        const visibleKeys = new Set(visibleTiles.map(t => `${t.z}/${t.x}/${t.y}`));
        
        for (const tileKey of this.tileCenterlines.keys()) {
            if (!visibleKeys.has(tileKey)) {
                this.tileCenterlines.delete(tileKey);
            }
        }
    }
    
    /**
     * Clear all cached centerlines
     */
    clearCenterlines() {
        this.tileCenterlines.clear();
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
