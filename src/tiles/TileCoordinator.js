/**
 * TileCoordinator - Orchestrates terrain and vector tile loading
 * 
 * Ensures terrain is loaded before vector tiles are processed,
 * enabling CPU-side height baking for proper terrain conformance.
 * 
 * Pipeline:
 * 1. Request tile z/x/y
 * 2. Load terrain tile (or use cached)
 * 3. Load vector tile
 * 4. Process vector geometry with terrain heights baked in
 * 5. Return GPU-ready buffers
 */

import { transformTileCoords } from './vectorTileParser.js';

export class TileCoordinator {
    constructor() {
        // Terrain cache: Map<key, { heights, width, height, bounds }>
        this.terrainCache = new Map();
        this.terrainLoading = new Map(); // Map<key, Promise>
        this.terrainFailed = new Set();
        
        // Workers
        this.terrainWorker = null;
        this.workerReady = false;
        
        // Configuration
        this.terrainSource = 'aws';
        this.exaggeration = 1.5;
        this.terrainEnabled = true;
        
        // Pending requests waiting for terrain
        this.pendingRequests = new Map(); // Map<key, { resolve, reject }>
    }
    
    /**
     * Initialize the tile coordinator
     * Note: Web Worker disabled for now due to Vite MIME type issues
     * Using main thread fallback which works reliably
     */
    async initialize() {
        // For now, use main thread loading (worker can be added later as optimization)
        this.workerReady = false;
        console.log('🏔️ TileCoordinator initialized (main thread mode)');
    }
    
    /**
     * Handle terrain worker results
     */
    handleTerrainResult(result) {
        const { key, success, heights, width, height, bounds, error } = result;
        
        if (success) {
            // Cache the terrain data
            this.terrainCache.set(key, { heights, width, height, bounds });
            console.log(`🏔️ Terrain loaded: ${key}`);
        } else {
            console.warn(`🏔️ Terrain failed: ${key} - ${error}`);
            this.terrainFailed.add(key);
        }
        
        // Resolve pending promise
        const pending = this.terrainLoading.get(key);
        if (pending) {
            pending.resolve(success ? this.terrainCache.get(key) : null);
            this.terrainLoading.delete(key);
        }
    }
    
    /**
     * Load terrain for a tile (returns Promise)
     * Uses cache if available, otherwise fetches via worker
     */
    async loadTerrain(z, x, y) {
        if (!this.terrainEnabled) return null;
        
        const key = `${z}/${x}/${y}`;
        
        // Return cached
        if (this.terrainCache.has(key)) {
            return this.terrainCache.get(key);
        }
        
        // Return null for failed tiles
        if (this.terrainFailed.has(key)) {
            return null;
        }
        
        // Return existing promise if loading
        if (this.terrainLoading.has(key)) {
            return this.terrainLoading.get(key).promise;
        }
        
        // Create promise and start loading
        let resolve, reject;
        const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });
        
        this.terrainLoading.set(key, { promise, resolve, reject });
        
        if (this.workerReady && this.terrainWorker) {
            // Load via worker
            this.terrainWorker.postMessage({
                type: 'loadTerrain',
                z, x, y,
                source: this.terrainSource
            });
        } else {
            // Fallback: load on main thread
            this.loadTerrainMainThread(z, x, y).then(resolve).catch(reject);
        }
        
        return promise;
    }
    
    /**
     * Fallback terrain loading on main thread
     */
    async loadTerrainMainThread(z, x, y) {
        const key = `${z}/${x}/${y}`;
        const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
        
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            
            const blob = await response.blob();
            const bitmap = await createImageBitmap(blob);
            
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bitmap, 0, 0);
            const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
            
            const width = bitmap.width;
            const height = bitmap.height;
            const heights = new Float32Array(width * height);
            
            for (let i = 0; i < heights.length; i++) {
                const idx = i * 4;
                const r = imageData.data[idx];
                const g = imageData.data[idx + 1];
                const b = imageData.data[idx + 2];
                heights[i] = (r * 256 + g + b / 256) - 32768;
            }
            
            // Use EXACT same coordinate transform as vector tiles for bounds
            // This ensures CPU terrain sampling matches GPU terrain sampling
            const extent = 4096;
            const [minX, maxY] = transformTileCoords(0, 0, x, y, z, extent);
            const [maxX, minY] = transformTileCoords(extent, extent, x, y, z, extent);
            const bounds = { minX, minY, maxX, maxY };
            
            const terrainData = { heights, width, height, bounds };
            this.terrainCache.set(key, terrainData);
            
            return terrainData;
            
        } catch (error) {
            console.warn(`Terrain load failed ${key}:`, error.message);
            this.terrainFailed.add(key);
            return null;
        }
    }
    
    /**
     * Get terrain data for a tile (cached only, no fetch)
     */
    getTerrainData(z, x, y) {
        return this.terrainCache.get(`${z}/${x}/${y}`) || null;
    }
    
    /**
     * Check if terrain is available for a tile
     */
    hasTerrainData(z, x, y) {
        return this.terrainCache.has(`${z}/${x}/${y}`);
    }
    
    /**
     * Sample terrain height at clip-space coordinates
     * Searches all cached terrain tiles
     */
    sampleHeight(clipX, clipY) {
        const margin = 0.001;
        const uvScale = 256.0;
        
        for (const [key, terrain] of this.terrainCache) {
            const { heights, width, height, bounds } = terrain;
            
            // Bounds check with margin (matches GPU shader)
            if (clipX >= bounds.minX - margin && clipX <= bounds.maxX + margin &&
                clipY >= bounds.minY - margin && clipY <= bounds.maxY + margin) {
                
                // Convert to UV with quantization (matches GPU shader)
                const rawU = (clipX - bounds.minX) / (bounds.maxX - bounds.minX);
                const rawV = 1 - (clipY - bounds.minY) / (bounds.maxY - bounds.minY);
                
                const u = Math.max(0.001, Math.min(0.999, Math.floor(rawU * uvScale) / uvScale));
                const v = Math.max(0.001, Math.min(0.999, Math.floor(rawV * uvScale) / uvScale));
                
                const px = Math.floor(u * (width - 1));
                const py = Math.floor(v * (height - 1));
                
                const idx = py * width + px;
                const rawHeight = heights[idx] || 0;
                const clampedHeight = Math.max(0, Math.min(9000, rawHeight));
                
                return (clampedHeight / 50000000.0) * this.exaggeration;
            }
        }
        
        return 0;
    }
    
    /**
     * Pre-load terrain tiles for visible area
     * Call this before loading vector tiles
     */
    async preloadTerrain(visibleTiles) {
        if (!this.terrainEnabled) return;
        
        const promises = visibleTiles.map(({ z, x, y }) => this.loadTerrain(z, x, y));
        await Promise.allSettled(promises);
    }
    
    /**
     * Clear terrain cache
     */
    clearCache() {
        this.terrainCache.clear();
        this.terrainFailed.clear();
        this.terrainLoading.clear();
    }
    
    /**
     * Prune terrain tiles not in visible set
     */
    pruneCache(visibleTiles) {
        const visibleKeys = new Set(visibleTiles.map(t => `${t.z}/${t.x}/${t.y}`));
        
        for (const key of this.terrainCache.keys()) {
            if (!visibleKeys.has(key)) {
                this.terrainCache.delete(key);
            }
        }
    }
    
    /**
     * Set terrain exaggeration
     */
    setExaggeration(value) {
        this.exaggeration = value;
    }
    
    /**
     * Enable/disable terrain
     */
    setEnabled(enabled) {
        this.terrainEnabled = enabled;
    }
    
    /**
     * Terminate workers
     */
    dispose() {
        if (this.terrainWorker) {
            this.terrainWorker.terminate();
            this.terrainWorker = null;
        }
        this.clearCache();
    }
}

// Singleton instance
let coordinatorInstance = null;

export function getTileCoordinator() {
    if (!coordinatorInstance) {
        coordinatorInstance = new TileCoordinator();
    }
    return coordinatorInstance;
}

export async function initializeTileCoordinator() {
    const coordinator = getTileCoordinator();
    await coordinator.initialize();
    return coordinator;
}
