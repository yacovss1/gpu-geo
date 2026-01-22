/**
 * Terrain Compute Integration
 * 
 * Integrates the GPU terrain compute pipeline with the existing tile and rendering system.
 * Handles collecting centerlines from parsed features and running the compute pipeline.
 */

import { TerrainComputePipeline } from './terrainComputePipeline.js';

/**
 * TerrainComputeManager
 * 
 * Manages the terrain compute pipeline lifecycle and integration with tile loading.
 */
export class TerrainComputeManager {
    constructor(device) {
        this.device = device;
        this.pipeline = null;
        this.enabled = false; // Disabled by default until fully tested
        this.pendingCenterlines = []; // Centerlines waiting to be processed
        this.processedCenterlines = new Map(); // tileKey -> processed centerline data
        this.lastTerrainTexture = null;
        this.lastTerrainSampler = null;
        this.lastTerrainBoundsBuffer = null;
    }
    
    /**
     * Initialize the terrain compute pipeline
     */
    async initialize() {
        this.pipeline = new TerrainComputePipeline(this.device);
        // Note: Full initialization happens when terrain resources are provided
        console.log('🏔️ TerrainComputeManager created (pending terrain resources)');
    }
    
    /**
     * Enable/disable GPU terrain compute
     */
    setEnabled(enabled) {
        this.enabled = enabled;
        console.log(`🏔️ Terrain compute ${enabled ? 'ENABLED' : 'DISABLED'}`);
    }
    
    /**
     * Update terrain resources (call when terrain atlas changes)
     * @param {GPUTexture} terrainTexture - Terrain atlas texture
     * @param {GPUSampler} terrainSampler - Sampler for terrain texture
     * @param {GPUBuffer} terrainBoundsBuffer - Uniform buffer with terrain bounds
     */
    async updateTerrainResources(terrainTexture, terrainSampler, terrainBoundsBuffer) {
        if (!terrainTexture || !terrainSampler || !terrainBoundsBuffer) {
            return;
        }
        
        // Check if resources changed
        const resourcesChanged = 
            this.lastTerrainTexture !== terrainTexture ||
            this.lastTerrainSampler !== terrainSampler ||
            this.lastTerrainBoundsBuffer !== terrainBoundsBuffer;
        
        if (!resourcesChanged && this.pipeline?.initialized) {
            return;
        }
        
        this.lastTerrainTexture = terrainTexture;
        this.lastTerrainSampler = terrainSampler;
        this.lastTerrainBoundsBuffer = terrainBoundsBuffer;
        
        // Initialize or update the pipeline
        if (!this.pipeline?.initialized) {
            await this.pipeline.initialize(terrainTexture, terrainSampler, terrainBoundsBuffer);
        } else {
            this.pipeline.updateTerrainBindGroup(terrainTexture, terrainSampler, terrainBoundsBuffer);
        }
    }
    
    /**
     * Collect centerlines from parsed features for a tile
     * @param {string} tileKey - Tile identifier (z/x/y)
     * @param {Array} parsedFeatures - Array of parsed features with lineCenterlines
     */
    collectCenterlines(tileKey, parsedFeatures) {
        if (!this.enabled) return;
        
        const centerlines = [];
        
        for (const feature of parsedFeatures) {
            if (feature.lineCenterlines && feature.lineCenterlines.length > 0) {
                for (const line of feature.lineCenterlines) {
                    centerlines.push({
                        coordinates: line.coordinates,
                        width: line.width,
                        color: line.color,
                        featureId: line.featureId,
                        layerId: line.layerId,
                        tileKey: tileKey
                    });
                }
            }
        }
        
        if (centerlines.length > 0) {
            this.processedCenterlines.set(tileKey, centerlines);
            console.log(`🛣️ Collected ${centerlines.length} centerlines for tile ${tileKey}`);
        }
    }
    
    /**
     * Remove centerlines for a tile (when tile is unloaded)
     * @param {string} tileKey - Tile identifier
     */
    removeTileCenterlines(tileKey) {
        this.processedCenterlines.delete(tileKey);
    }
    
    /**
     * Clear all cached centerlines
     */
    clearAllCenterlines() {
        this.processedCenterlines.clear();
        this.pendingCenterlines = [];
    }
    
    /**
     * Get all visible centerlines for processing
     * @param {Set} visibleTileKeys - Set of currently visible tile keys
     * @returns {Array} - Array of centerline objects
     */
    getVisibleCenterlines(visibleTileKeys) {
        const visibleCenterlines = [];
        
        for (const [tileKey, centerlines] of this.processedCenterlines) {
            if (visibleTileKeys.has(tileKey)) {
                visibleCenterlines.push(...centerlines);
            }
        }
        
        return visibleCenterlines;
    }
    
    /**
     * Execute the compute pipeline for visible centerlines
     * @param {GPUCommandEncoder} encoder - Command encoder to record compute commands
     * @param {Set} visibleTileKeys - Set of currently visible tile keys
     * @returns {Object|null} - Output buffers for rendering, or null if not ready
     */
    execute(encoder, visibleTileKeys) {
        if (!this.enabled || !this.pipeline?.initialized) {
            return null;
        }
        
        // Get visible centerlines
        const centerlines = this.getVisibleCenterlines(visibleTileKeys);
        
        if (centerlines.length === 0) {
            return null;
        }
        
        // Format centerlines for pipeline
        const formattedLines = centerlines.map(c => ({
            coordinates: c.coordinates,
            width: c.width,
            color: c.color,
            depthOffset: 0.00001 // Small offset to prevent z-fighting with terrain
        }));
        
        // Upload and execute
        const stats = this.pipeline.uploadLines(formattedLines);
        console.log(`🏔️ Processing ${stats.segmentCount} line segments, ${stats.featureCount} features`);
        
        return this.pipeline.execute(encoder);
    }
    
    /**
     * Get the output buffers from the last compute pass
     * @returns {Object} - Buffer info for rendering
     */
    getOutputBuffers() {
        if (!this.pipeline) {
            return null;
        }
        return this.pipeline.getOutputBuffers();
    }
    
    /**
     * Check if pipeline is ready for compute
     */
    isReady() {
        return this.enabled && this.pipeline?.initialized;
    }
    
    /**
     * Cleanup resources
     */
    destroy() {
        this.pipeline?.destroy();
        this.processedCenterlines.clear();
        this.pendingCenterlines = [];
    }
}

/**
 * Factory function to create and initialize the terrain compute manager
 * @param {GPUDevice} device 
 * @returns {Promise<TerrainComputeManager>}
 */
export async function createTerrainComputeManager(device) {
    const manager = new TerrainComputeManager(device);
    await manager.initialize();
    return manager;
}
