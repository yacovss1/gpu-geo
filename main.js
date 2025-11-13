import { initWebGPU } from './src/core/webgpu-init.js';
import { Camera } from './src/core/camera.js';
import { MapRenderer } from './src/rendering/renderer.js';
import { TileManager } from './src/tiles/TileManager.js';
import { parseGeoJSONFeature, fetchVectorTile, clearTileCache, resetNotFoundTiles, setTileSource } from './src/tiles/geojson.js';
import { batchParseGeoJSONFeaturesGPU } from './src/tiles/geojsonGPU.js';
import { getStyle, setStyle, setLayerVisibility, getLayerVisibility, getLayer, parseColor, getSymbolLayers, getPaintProperty } from './src/core/style.js';
import { setupEventListeners } from './src/core/events.js';
import { getVisibleTiles } from './src/tiles/tile-utils.js';
import { createMarkerPipeline } from './src/rendering/markerPipeline.js';
import { createAccumulatorPipeline, createQuadrantPipeline, createCenterPipeline } from './src/rendering/markerCompute.js';
import { GPUTextRenderer } from './src/text/gpuTextRenderer.js';

// Define constants at file scope to ensure they're available everywhere
// 9-quadrant labeling system (center + 8 directional positions)
const MAX_FEATURES = 65535; // 16-bit encoding supports 1-65534, use 65535 as array size
const ACCUMULATOR_BUFFER_SIZE = MAX_FEATURES * 28; // Pass 1: 7 u32 per feature (sumX, sumY, count, minX, minY, maxX, maxY) = 28 bytes
const QUADRANT_BUFFER_SIZE = MAX_FEATURES * 108; // Pass 2: 9 quadrants × 3 u32 each = 108 bytes per feature
const REGIONS_BUFFER_SIZE = MAX_FEATURES * 16;   // For 4 atomic u32s per feature  
const MARKER_BUFFER_SIZE = MAX_FEATURES * 40;    // Per marker: vec2(8) + f32(4) + pad(4) + vec4(16) + u32(4) + pad(4) = 40 bytes

// Performance tracking and GPU acceleration toggle
const PERFORMANCE_STATS = {
    gpuEnabled: true, // Set to false to use CPU processing for comparison
    totalCoordinatesProcessed: 0,
    totalGPUTime: 0,
    totalCPUTime: 0,
    batchCount: 0,
    // New detailed stats
    gpuBatchCount: 0,
    cpuFeatureCount: 0,
    averageGPUBatchSize: 0,
    averageCPUTime: 0,
    lastSpeedupRatio: 0,
    coordinatesPerSecondGPU: 0,
    coordinatesPerSecondCPU: 0
};

// Global performance control object
window.mapPerformance = {
    // Runtime controls
    setGPUEnabled: (enabled) => {
        PERFORMANCE_STATS.gpuEnabled = enabled;
        console.log(`🔄 Switched to ${enabled ? 'GPU' : 'CPU'} coordinate processing`);
        
        // Force tile refresh to apply new processing mode
        clearTileCache();
        resetNotFoundTiles();
        
        // Trigger reload of visible tiles
        if (window.camera && window.device && window.tileBuffers && window.hiddenTileBuffers) {
            // CRITICAL FIX: Destroy GPU buffers before clearing
            window.tileBuffers.forEach((buffers) => {
                buffers.forEach(tile => {
                    if (tile.vertexBuffer) tile.vertexBuffer.destroy();
                    if (tile.fillIndexBuffer) tile.fillIndexBuffer.destroy();
                });
            });
            window.hiddenTileBuffers.forEach((buffers) => {
                buffers.forEach(tile => {
                    if (tile.vertexBuffer) tile.vertexBuffer.destroy();
                    if (tile.hiddenFillIndexBuffer) tile.hiddenFillIndexBuffer.destroy();
                });
            });
            
            window.tileBuffers.clear();
            window.hiddenTileBuffers.clear();
            const visibleTiles = getVisibleTiles(window.camera.zoom, window.camera.center);
            loadVisibleTiles(visibleTiles, window.device, window.tileBuffers, window.hiddenTileBuffers);
        }
    },
    
    // Status queries
    isGPUEnabled: () => PERFORMANCE_STATS.gpuEnabled,
    
    // Statistics
    getStats: () => {
        const stats = { ...PERFORMANCE_STATS };
        
        // Calculate derived statistics
        if (stats.totalGPUTime > 0 && stats.gpuBatchCount > 0) {
            stats.averageGPUBatchTime = stats.totalGPUTime / stats.gpuBatchCount;
            stats.coordinatesPerSecondGPU = (stats.totalCoordinatesProcessed / stats.totalGPUTime) * 1000;
        }
        
        if (stats.totalCPUTime > 0 && stats.cpuFeatureCount > 0) {
            stats.averageCPUTime = stats.totalCPUTime / stats.cpuFeatureCount;
            stats.coordinatesPerSecondCPU = (stats.totalCoordinatesProcessed / stats.totalCPUTime) * 1000;
        }
        
        if (stats.totalGPUTime > 0 && stats.totalCPUTime > 0) {
            stats.lastSpeedupRatio = stats.totalCPUTime / stats.totalGPUTime;
        }
        
        return stats;
    },
    
    // Reset statistics
    resetStats: () => {
        Object.keys(PERFORMANCE_STATS).forEach(key => {
            if (typeof PERFORMANCE_STATS[key] === 'number') {
                PERFORMANCE_STATS[key] = 0;
            }
        });
        PERFORMANCE_STATS.gpuEnabled = true; // Keep the mode setting
        console.log('📊 Performance statistics reset');
    },
    
    // Display formatted statistics
    logStats: () => {
        logPerformanceStats();
    },
    
    // Performance comparison
    runBenchmark: async (coordinates = 1000) => {
        if (!window.device) {
            console.error('WebGPU device not available for benchmark');
            return;
        }
        
        console.log(`🏁 Running benchmark with ${coordinates} coordinates...`);
        
        // Generate test coordinates
        const testCoords = [];
        for (let i = 0; i < coordinates; i++) {
            testCoords.push([
                Math.random() * 360 - 180, // longitude
                Math.random() * 170 - 85   // latitude
            ]);
        }
        
        // GPU benchmark
        const gpuStartTime = performance.now();
        const { gpuMercatorToClipSpace } = await import('./src/core/coordinateGPU.js');
        const gpuResults = await gpuMercatorToClipSpace(testCoords, window.device);
        const gpuTime = performance.now() - gpuStartTime;
        
        // CPU benchmark
        const cpuStartTime = performance.now();
        const { mercatorToClipSpace } = await import('./src/core/utils.js');
        const cpuResults = testCoords.map(coord => mercatorToClipSpace(coord[0], coord[1]));
        const cpuTime = performance.now() - cpuStartTime;
        
        // Results
        const speedup = cpuTime / gpuTime;
        const gpuThroughput = (coordinates / gpuTime) * 1000;
        const cpuThroughput = (coordinates / cpuTime) * 1000;
        
        console.log(`🚀 Benchmark Results:`);
        console.log(`  Coordinates: ${coordinates.toLocaleString()}`);
        console.log(`  GPU Time: ${gpuTime.toFixed(2)}ms (${gpuThroughput.toFixed(0)} coords/sec)`);
        console.log(`  CPU Time: ${cpuTime.toFixed(2)}ms (${cpuThroughput.toFixed(0)} coords/sec)`);
        console.log(`  Speedup: ${speedup.toFixed(1)}x`);
        
        // Verify results match
        let errorCount = 0;
        for (let i = 0; i < Math.min(10, coordinates); i++) {
            const gpuCoord = gpuResults[i];
            const cpuCoord = cpuResults[i];
            const diffX = Math.abs(gpuCoord[0] - cpuCoord[0]);
            const diffY = Math.abs(gpuCoord[1] - cpuCoord[1]);
            
            if (diffX > 1e-5 || diffY > 1e-5) {
                errorCount++;
                if (errorCount === 1) {
                    console.warn(`⚠️  Coordinate mismatch at index ${i}:`);
                    console.warn(`   GPU: [${gpuCoord[0]}, ${gpuCoord[1]}]`);
                    console.warn(`   CPU: [${cpuCoord[0]}, ${cpuCoord[1]}]`);
                }
            }
        }
        
        if (errorCount === 0) {
            console.log(`✅ Results verified: GPU and CPU outputs match`);
        } else {
            console.warn(`⚠️  Found ${errorCount} coordinate mismatches in sample`);
        }
        
        return {
            coordinates,
            gpuTime,
            cpuTime,
            speedup,
            gpuThroughput,
            cpuThroughput,
            errorCount
        };
    },
    
    // Enable live performance monitoring
    enableLiveMonitoring: (intervalMs = 5000) => {
        if (window.performanceMonitorInterval) {
            clearInterval(window.performanceMonitorInterval);
        }
        
        window.performanceMonitorInterval = setInterval(() => {
            const stats = window.mapPerformance.getStats();
            if (stats.totalCoordinatesProcessed > 0) {
                console.log(`📈 Live Stats: ${stats.totalCoordinatesProcessed.toLocaleString()} coords processed, ` +
                          `${stats.gpuEnabled ? 'GPU' : 'CPU'} mode, ` +
                          `${stats.lastSpeedupRatio ? stats.lastSpeedupRatio.toFixed(1) + 'x speedup' : 'no comparison'}`);
            }
        }, intervalMs);
        
        console.log(`📊 Live performance monitoring enabled (${intervalMs}ms interval)`);
    },
    
    // Disable live monitoring
    disableLiveMonitoring: () => {
        if (window.performanceMonitorInterval) {
            clearInterval(window.performanceMonitorInterval);
            delete window.performanceMonitorInterval;
            console.log('📊 Live performance monitoring disabled');
        }
    }
};

// Map style API
window.mapStyle = {
    // Set map style using Mapbox/MapLibre style specification
    setStyle: async (style) => {
        try {
            await setStyle(style);
            console.log('✅ Map style set successfully');
            
            // Extract tile source from style and configure
            const currentStyle = getStyle();
            if (currentStyle && currentStyle.sources) {
                const firstVectorSource = Object.entries(currentStyle.sources).find(
                    ([_, source]) => source.type === 'vector'
                );
                
                if (firstVectorSource) {
                    const [sourceId, source] = firstVectorSource;
                    if (source.tiles && source.tiles.length > 0) {
                        setTileSource({
                            url: source.tiles[0],
                            maxZoom: source.maxzoom || 14,
                            timeout: 10000
                        });
                        console.log(`🗺️  Configured tile source: ${sourceId}`);
                    }
                }
            }
            
            // Reload tiles with new style
            clearTileCache();
            resetNotFoundTiles();
            
            if (window.camera && window.device && window.tileBuffers && window.hiddenTileBuffers) {
                // CRITICAL FIX: Wait for GPU to finish before destroying buffers
                await window.device.queue.onSubmittedWorkDone();
                
                // CRITICAL FIX: Destroy GPU buffers before clearing
                window.tileBuffers.forEach((buffers) => {
                    buffers.forEach(tile => {
                        if (tile.vertexBuffer) tile.vertexBuffer.destroy();
                        if (tile.fillIndexBuffer) tile.fillIndexBuffer.destroy();
                    });
                });
                window.hiddenTileBuffers.forEach((buffers) => {
                    buffers.forEach(tile => {
                        if (tile.vertexBuffer) tile.vertexBuffer.destroy();
                        if (tile.hiddenFillIndexBuffer) tile.hiddenFillIndexBuffer.destroy();
                    });
                });
                
                window.tileBuffers.clear();
                window.hiddenTileBuffers.clear();
                
                // Trigger a tile reload by firing the zoomend event
                window.camera.triggerEvent('zoomend');
            }
        } catch (error) {
            console.error('❌ Failed to set map style:', error);
        }
    },
    
    // Get current style
    getStyle: () => {
        return getStyle();
    },
    
    // Helper to load a style from URL
    loadStyleFromURL: async (url) => {
        try {
            const response = await fetch(url);
            const style = await response.json();
            await window.mapStyle.setStyle(style);
        } catch (error) {
            console.error(`❌ Failed to load style from ${url}:`, error);
        }
    },
    
    // Layer visibility controls
    setLayerVisibility: async (layerId, visible) => {
        console.log(`🎨 Setting layer ${layerId} visibility to ${visible}`);
        setLayerVisibility(layerId, visible);
        
        // CRITICAL FIX: Wait for GPU to finish before destroying buffers
        await device.queue.onSubmittedWorkDone();
        
        // CRITICAL FIX: Destroy GPU buffers before clearing
        tileBuffers.forEach((buffers) => {
            buffers.forEach(tile => {
                if (tile.vertexBuffer) tile.vertexBuffer.destroy();
                if (tile.fillIndexBuffer) tile.fillIndexBuffer.destroy();
            });
        });
        hiddenTileBuffers.forEach((buffers) => {
            buffers.forEach(tile => {
                if (tile.vertexBuffer) tile.vertexBuffer.destroy();
                if (tile.hiddenFillIndexBuffer) tile.hiddenFillIndexBuffer.destroy();
            });
        });
        
        // Force re-render by clearing everything
        tileBuffers.clear();
        hiddenTileBuffers.clear();
        clearTileCache(); // Clear the tile data cache
        resetNotFoundTiles(); // Clear the 404 cache
        
        // Re-trigger tile loading which will re-fetch and re-parse with new visibility
        console.log('🔄 Re-loading tiles with new visibility...');
        window.camera.triggerEvent('zoomend');
    },
    
    getLayerVisibility: (layerId) => {
        return getLayerVisibility(layerId);
    },
    
    // List all layers
    listLayers: () => {
        const style = getStyle();
        return style?.layers.map(l => ({ 
            id: l.id, 
            type: l.type, 
            sourceLayer: l['source-layer'],
            visible: l.layout?.visibility !== 'none'
        })) || [];
    }
};

// Convenience aliases for console usage
window.gpuMode = () => window.mapPerformance.setGPUEnabled(true);
window.cpuMode = () => window.mapPerformance.setGPUEnabled(false);
window.perfStats = () => window.mapPerformance.logStats();
window.benchmark = (coords) => window.mapPerformance.runBenchmark(coords);
window.clearCache = () => {
    clearTileCache();
    resetNotFoundTiles();
    console.log('🗑️ Tile cache cleared - reloading tiles...');
    window.camera.triggerEvent('zoomend');
};

// Module-level variable for tracking zoom changes
let lastLoggedZoom = -1;
let frameCount = 0;

// Helper function to check if layer should render at current zoom
function shouldRenderLayer(layerId, zoom) {
    if (!getLayerVisibility(layerId)) return false;
    
    const layer = getLayer(layerId);
    if (!layer) return false;
    
    // Check minzoom
    if (layer.minzoom !== undefined && zoom < layer.minzoom) return false;
    
    // Check maxzoom
    if (layer.maxzoom !== undefined && zoom > layer.maxzoom) return false;
    
    return true;
}

async function main() {
    // Initialize document and canvas
    document.body.style.margin = "0";
    document.body.style.padding = "0";

    const canvas = document.getElementById('canvas');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + "px";
    canvas.style.height = rect.height + "px";
    
    // Initialize WebGPU
    const { device, context } = await initWebGPU(canvas);
    const format = navigator.gpu.getPreferredCanvasFormat();

    // Initialize renderer and camera
    const renderer = new MapRenderer(device, context, format);
    const camera = new Camera(canvas.width, canvas.height);
    camera.position = [0, 0]; // Center at origin
    camera.zoom = 1;
    
    // Handle window resize
    window.addEventListener('resize', async () => {
        const dpr = window.devicePixelRatio || 1;
        const width = window.innerWidth;
        const height = window.innerHeight;
        
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = width + "px";
        canvas.style.height = height + "px";
        
        // Reconfigure the canvas context for the new size
        context.configure({
            device: device,
            format: format,
            alphaMode: 'premultiplied',
        });
        
        // Update camera
        camera.updateDimensions(canvas.width, canvas.height);
        
        // Update canvas size buffer
        device.queue.writeBuffer(renderer.buffers.canvasSize, 0, new Float32Array([canvas.width, canvas.height]));
        
        // Recreate textures and bind groups (wait for GPU to finish first)
        await renderer.createTextures(canvas.width, canvas.height);
        renderer.updateTextureBindGroups();
    });
    
    // Initialize GPU-native text renderer
    const textRenderer = new GPUTextRenderer(device);
    await textRenderer.initialize('Arial', 48);
    
    // Start at world center [0, 0] (Greenwich/Equator)
    camera.position = [0, 0];
    
    await renderer.createResources(canvas, camera);

    // Initialize TileManager
    const tileManager = new TileManager(device, PERFORMANCE_STATS);
    
    // Expose global variables for performance controls and backwards compatibility
    window.device = device;
    window.camera = camera;
    window.tileBuffers = tileManager.visibleTileBuffers;
    window.hiddenTileBuffers = tileManager.hiddenTileBuffers;
    window.tileManager = tileManager;

    // Load the custom OpenFreeMap style optimized for our parser
    try {
        //await window.mapStyle.loadStyleFromURL('https://demotiles.maplibre.org/style.json')
        
        await window.mapStyle.loadStyleFromURL('./openfreemap-style.json')
        console.log('✅ OpenFreeMap style loaded successfully');
    } catch (error) {
        console.warn('⚠️ Could not load style, using default colors:', error.message);
    }

    // Initialize marker rendering resources
    const { 
        accumulatorPipeline,
        quadrantPipeline,
        centerPipeline,
        markerPipeline,
        markerBuffer,
        accumulatorBuffer,
        quadrantBuffer,
        dimsBuffer,
        regionsBuffer,
        markerBindGroupLayout
    } = initMarkerResources(device, format, canvas, camera);

    // Handle zoom events for loading tiles
    let lastFetchZoom = -1;
    let currentAbortController = null; // Track ongoing fetch requests
    let isTileLoadInProgress = false; // Track if tile loading is in progress
    
    // Abort ongoing requests when actively zooming
    camera.addEventListener('zoom', () => {
        if (currentAbortController && !isTileLoadInProgress) {
            currentAbortController.abort();
            console.log('🛑 Cancelled tile requests due to zoom');
            currentAbortController = null;
        }
    });
    
    camera.addEventListener('zoomend', async (event) => {
        // Skip if already loading tiles
        if (isTileLoadInProgress) {
            console.log('⏭️ Skipping tile load - already in progress');
            // But still abort the previous one
            if (currentAbortController) {
                currentAbortController.abort();
                console.log('🛑 Aborting previous in-progress tile load');
            }
            return;
        }
        
        // Cancel any ongoing tile fetches (in case zoom event didn't fire)
        if (currentAbortController) {
            currentAbortController.abort();
            console.log('🛑 Cancelled previous tile requests (zoomend)');
        }
        currentAbortController = new AbortController();
        console.log('✅ Created new AbortController for tile fetch');
        
        // Extract both zoom levels properly
        const displayZoom = camera.zoom;
        let fetchZoom = event.detail?.fetchZoom || Math.min(displayZoom, camera.maxFetchZoom);
        
        console.log(`📊 Zoom calculation: display=${displayZoom.toFixed(2)}, fetchZoom from event=${event.detail?.fetchZoom}, maxFetchZoom=${camera.maxFetchZoom}`);
        
        // Respect style maxzoom if available
        const currentStyle = getStyle();
        if (currentStyle && currentStyle.sources) {
            const sourceId = Object.keys(currentStyle.sources)[0];
            const source = currentStyle.sources[sourceId];
            if (source && source.maxzoom !== undefined) {
                fetchZoom = Math.min(fetchZoom, source.maxzoom);
                console.log(`📊 After style maxzoom (${source.maxzoom}): fetchZoom=${fetchZoom}`);
            }
        }
        
        // If fetch zoom changed (by even 1 level), clear old tiles immediately
        let shouldClearOldTiles = false;
        if (lastFetchZoom !== -1 && fetchZoom !== lastFetchZoom) {
            console.log(`🔄 Zoom changed ${lastFetchZoom} → ${fetchZoom}, destroying all GPU buffers`);
            shouldClearOldTiles = true;
            clearTileCache(); // Clear fetch cache
            
            // CRITICAL FIX: Wait for GPU to finish before destroying buffers
            await device.queue.onSubmittedWorkDone();
            
            // CRITICAL FIX: Destroy GPU buffers before clearing
            let destroyedCount = 0;
            tileBuffers.forEach((buffers) => {
                buffers.forEach(tile => {
                    if (tile.vertexBuffer) tile.vertexBuffer.destroy();
                    if (tile.fillIndexBuffer) tile.fillIndexBuffer.destroy();
                    destroyedCount += 2;
                });
            });
            hiddenTileBuffers.forEach((buffers) => {
                buffers.forEach(tile => {
                    if (tile.vertexBuffer) tile.vertexBuffer.destroy();
                    if (tile.hiddenFillIndexBuffer) tile.hiddenFillIndexBuffer.destroy();
                    destroyedCount += 2;
                });
            });
            console.log(`♻️ Destroyed ${destroyedCount} GPU buffers on zoom change`);
            
            tileBuffers.clear(); // Clear GPU buffers
            hiddenTileBuffers.clear(); // Clear hidden GPU buffers
            // Reset logging flags
            window._parsedLogged = false;
            window._lineBufferLogged = false;
            window._zoomFilterLogged = false;
            window._renderLogged = false;
            window._lineDrawLogged = false;
            window._totalLineDrawLogged = false;
            window._tileLayersLogged = false;
        }
        lastFetchZoom = fetchZoom;
        
        // Always update the renderer with both zoom levels
        renderer.updateZoomInfo(camera.zoom, fetchZoom);
        
        // Get visible tiles for the fetch zoom level only
        const visibleTiles = getVisibleTiles(camera, fetchZoom);
        
        const viewport = camera.getViewport();
        console.log(`🔍 Zoom ${displayZoom.toFixed(1)}, fetch ${fetchZoom}, visibleTiles: ${visibleTiles.length}`);
        console.log(`👁️ Viewport: X [${viewport.left.toFixed(3)}, ${viewport.right.toFixed(3)}], Y [${viewport.bottom.toFixed(3)}, ${viewport.top.toFixed(3)}]`);
        
        if (visibleTiles.length === 0) {
            return;
        }
        
        // Build database of existing tiles (empty if we just cleared)
        const existingTilesByKey = {};
        tileBuffers.forEach((layerTiles, layerId) => {
            layerTiles.forEach((tile, index) => {
                const key = `${tile.zoomLevel}/${tile.tileX}/${tile.tileY}`;
                existingTilesByKey[key] = {
                    tile,
                    layerId,
                    index
                };
            });
        });
        
        // Only fetch tiles we don't already have
        const tilesToFetch = visibleTiles.filter(tile => 
            !existingTilesByKey[`${tile.z}/${tile.x}/${tile.y}`]
        );
        
        console.log(`📦 Existing tiles: ${Object.keys(existingTilesByKey).length}, Need to fetch: ${tilesToFetch.length}`);
        
        // If no tiles to fetch, still update the rendering scale for overzooming
        if (tilesToFetch.length === 0) {
            // Apply overzooming by updating the transform uniforms
            // This happens automatically via camera.getMatrix() already
        }
        
        // Create new buffers for incoming tiles, grouped by layer
        const newTileBuffers = new Map();
        const newHiddenTileBuffers = new Map();
        
        if (tilesToFetch.length > 0) {
            try {
                // Load tiles in larger batches for better throughput
                const batchSize = 16;  // Increased batch size for faster loading
                for (let i = 0; i < tilesToFetch.length; i += batchSize) {
                    // Check if aborted before starting each batch
                    if (currentAbortController.signal.aborted) {
                        console.log('🛑 Batch loading cancelled');
                        break;
                    }
                    const batch = tilesToFetch.slice(i, i + batchSize);
                    await loadVisibleTiles(batch, device, newTileBuffers, newHiddenTileBuffers, currentAbortController.signal);
                }
                
                // Check if aborted before adding new tiles
                if (currentAbortController.signal.aborted) {
                    console.log('🛑 Skipping buffer update - request was aborted');
                    return;
                }
                
                // Only add new tiles, never clear existing tiles unless explicitly requested
                // This ensures we always have full coverage even if some tiles fail to load
                if (newTileBuffers.size > 0) {
                    // SMART CLEARING: Remove tiles from wrong zoom levels only
                    if (shouldClearOldTiles && lastFetchZoom !== fetchZoom) {
                        console.log(`🗑️ Removing tiles from old zoom ${lastFetchZoom}, keeping zoom ${fetchZoom}`);
                        
                        // CRITICAL FIX: Destroy GPU buffers before removing tiles
                        let destroyedBuffers = 0;
                        
                        // Filter out tiles that aren't at current fetchZoom
                        for (const [layerId, buffers] of tileBuffers) {
                            const toKeep = [];
                            const toDestroy = [];
                            
                            buffers.forEach(tile => {
                                if (tile.zoomLevel === fetchZoom) {
                                    toKeep.push(tile);
                                } else {
                                    toDestroy.push(tile);
                                }
                            });
                            
                            // Destroy GPU buffers for removed tiles
                            toDestroy.forEach(tile => {
                                if (tile.vertexBuffer) tile.vertexBuffer.destroy();
                                if (tile.fillIndexBuffer) tile.fillIndexBuffer.destroy();
                                destroyedBuffers += 2;
                            });
                            
                            if (toDestroy.length > 0) {
                                console.log(`  Layer ${layerId}: ${buffers.length} → ${toKeep.length} tiles (destroyed ${toDestroy.length * 2} buffers)`);
                                tileBuffers.set(layerId, toKeep);
                            }
                        }
                        
                        // Same for hidden buffers
                        for (const [layerId, buffers] of hiddenTileBuffers) {
                            const toKeep = [];
                            const toDestroy = [];
                            
                            buffers.forEach(tile => {
                                if (tile.zoomLevel === fetchZoom) {
                                    toKeep.push(tile);
                                } else {
                                    toDestroy.push(tile);
                                }
                            });
                            
                            // Destroy GPU buffers for removed hidden tiles
                            toDestroy.forEach(tile => {
                                if (tile.vertexBuffer) tile.vertexBuffer.destroy();
                                if (tile.hiddenFillIndexBuffer) tile.hiddenFillIndexBuffer.destroy();
                                destroyedBuffers += 2;
                            });
                            
                            if (toDestroy.length > 0) {
                                hiddenTileBuffers.set(layerId, toKeep);
                            }
                        }
                        
                        if (destroyedBuffers > 0) {
                            console.log(`♻️ Freed ${destroyedBuffers} GPU buffers from memory`);
                        }
                    } else if (!shouldClearOldTiles && lastFetchZoom === fetchZoom) {
                        // PAN at same zoom: Remove off-screen tiles to prevent memory accumulation
                        const visibleTileKeys = new Set(visibleTiles.map(t => `${t.z}/${t.x}/${t.y}`));
                        let offscreenDestroyed = 0;
                        
                        for (const [layerId, buffers] of tileBuffers) {
                            const toKeep = [];
                            const toDestroy = [];
                            
                            buffers.forEach(tile => {
                                const key = `${tile.zoomLevel}/${tile.tileX}/${tile.tileY}`;
                                if (visibleTileKeys.has(key)) {
                                    toKeep.push(tile);
                                } else {
                                    toDestroy.push(tile);
                                }
                            });
                            
                            // Destroy off-screen tile buffers
                            toDestroy.forEach(tile => {
                                if (tile.vertexBuffer) tile.vertexBuffer.destroy();
                                if (tile.fillIndexBuffer) tile.fillIndexBuffer.destroy();
                                offscreenDestroyed += 2;
                            });
                            
                            if (toDestroy.length > 0) {
                                tileBuffers.set(layerId, toKeep);
                            }
                        }
                        
                        for (const [layerId, buffers] of hiddenTileBuffers) {
                            const toKeep = [];
                            const toDestroy = [];
                            
                            buffers.forEach(tile => {
                                const key = `${tile.zoomLevel}/${tile.tileX}/${tile.tileY}`;
                                if (visibleTileKeys.has(key)) {
                                    toKeep.push(tile);
                                } else {
                                    toDestroy.push(tile);
                                }
                            });
                            
                            toDestroy.forEach(tile => {
                                if (tile.vertexBuffer) tile.vertexBuffer.destroy();
                                if (tile.hiddenFillIndexBuffer) tile.hiddenFillIndexBuffer.destroy();
                                offscreenDestroyed += 2;
                            });
                            
                            if (toDestroy.length > 0) {
                                hiddenTileBuffers.set(layerId, toKeep);
                            }
                        }
                        
                        if (offscreenDestroyed > 0) {
                            console.log(`♻️ Freed ${offscreenDestroyed} off-screen tile buffers during pan`);
                        }
                    }
                    
                    // Merge new layer-grouped buffers into existing buffers
                    for (const [layerId, buffers] of newTileBuffers) {
                        if (!tileBuffers.has(layerId)) {
                            tileBuffers.set(layerId, []);
                        }
                        tileBuffers.get(layerId).push(...buffers);
                    }
                    
                    for (const [layerId, buffers] of newHiddenTileBuffers) {
                        if (!hiddenTileBuffers.has(layerId)) {
                            hiddenTileBuffers.set(layerId, []);
                        }
                        hiddenTileBuffers.get(layerId).push(...buffers);
                    }
                }
            } catch (error) {
                // Silently ignore aborted requests
                if (error.name === 'AbortError') {
                    console.log('🛑 Tile loading aborted');
                    return;
                }
                // Error loading tiles - keep existing tiles
                console.warn('Error loading tiles:', error);
            } finally {
                isTileLoadInProgress = false; // Clear loading flag
            }
        } else {
            // No new tiles to fetch
        }
    });

    // Pan handler with strict throttling and debouncing
    camera.addEventListener('pan', () => {
        // Immediately abort ongoing tile requests when panning starts
        if (currentAbortController) {
            currentAbortController.abort();
            console.log('🛑 Cancelled tile requests due to pan');
            currentAbortController = null; // Clear it so we don't double-abort
        }
        
        // Clear any pending pan trigger
        if (camera.panTriggerTimeout) {
            clearTimeout(camera.panTriggerTimeout);
            camera.panTriggerTimeout = null;
        }
        
        // Trigger tile fetch after pan settles (reduced delay for better responsiveness)
        camera.panTriggerTimeout = setTimeout(() => {
            camera.triggerEvent('zoomend');
            camera.panTriggerTimeout = null;
        }, 150); // Reduced from 500ms to 150ms for faster tile loading
    });

    // Trigger initial tile fetch
    camera.triggerEvent('zoomend');

    // Set up event listeners - pass renderer object so texture reference stays current
    setupEventListeners(canvas, camera, device, renderer, tileBuffers);

    // Marker position cache - updated after each frame
    let markerPositionCache = null;
    let isReadingMarkers = false;

    // Main rendering loop
    async function frame() {
        // Update camera and transform matrices
        camera.updatePosition();
        
        const transformMatrix = camera.getMatrix();
        
        // Update transform matrices
        renderer.updateCameraTransform(transformMatrix);

        // Get the current texture ONCE for this frame
        const currentTexture = context.getCurrentTexture();
        const textureView = currentTexture.createView();

        // Render map - returns encoder without submitting
        const mapEncoder = renderMap(device, renderer, tileBuffers, hiddenTileBuffers, textureView, camera);
        
        // MUST submit map first so hidden texture is populated before compute reads it
        device.queue.submit([mapEncoder.finish()]);
        
        // Only compute markers/labels at zoom 14+ to avoid GPU overload
        if (camera.zoom >= 4) {
            // Build feature names and extract heights BEFORE computing markers
            const featureNames = buildFeatureNameMap(tileBuffers, camera.zoom);
            
            // Create heights array from featureNames
            const heightsArray = new Float32Array(MAX_FEATURES);
            let buildingHeightCount = 0;
            for (const [fid, feature] of featureNames.entries()) {
                if (fid < MAX_FEATURES) {
                    heightsArray[fid] = feature.height || 0;
                    if (feature.height && feature.height > 0 && feature.sourceLayer === 'building') {
                        buildingHeightCount++;
  
                    }
                }
            }
            if (!window._heightsDebugLogged) {
                console.log(`📏 Heights: ${buildingHeightCount} buildings with height data`);
                console.log(`📏 Sample heights buffer [1933]=${heightsArray[1933]}, [31252]=${heightsArray[31252]}, [43501]=${heightsArray[43501]}`);
                window._heightsDebugLogged = true;
            }
            
            // Upload heights to GPU buffer (create if not exists)
            if (!window._heightsBuffer) {
                window._heightsBuffer = device.createBuffer({
                    size: MAX_FEATURES * 4, // 4 bytes per float
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                });
            }
            device.queue.writeBuffer(window._heightsBuffer, 0, heightsArray);
            
            // Compute marker positions (submits 3 passes internally, reads from hidden texture)
            createComputeMarkerEncoder(
                device, 
                renderer,
                accumulatorPipeline,
                quadrantPipeline,
                centerPipeline, 
                accumulatorBuffer,
                quadrantBuffer,
                markerBuffer, 
                dimsBuffer, 
                canvas,
                regionsBuffer,
                window._heightsBuffer
            );
            
            // DEBUG: Read back marker buffer disabled due to WebGPU validation errors
            // The async buffer mapping conflicts with the render pipeline texture lifecycle
            if (false && !window._markerDebugLogged) {
                const markerReadBuffer = device.createBuffer({
                    size: 4 * 8 * 10, // First 10 markers
                    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
                });
                const debugEncoder = device.createCommandEncoder();
                debugEncoder.copyBufferToBuffer(markerBuffer, 0, markerReadBuffer, 0, markerReadBuffer.size);
                device.queue.submit([debugEncoder.finish()]);
                
                await markerReadBuffer.mapAsync(GPUMapMode.READ);
                const markerData = new Float32Array(markerReadBuffer.getMappedRange());
                console.log('🎯 First 10 marker positions:');
                for (let i = 0; i < 10; i++) {
                    const offset = i * 8; // Marker struct is 8 floats
                    console.log(`  Marker ${i}: center=(${markerData[offset].toFixed(3)}, ${markerData[offset+1].toFixed(3)}), height=${markerData[offset+2].toFixed(3)}`);
                }
                markerReadBuffer.unmap();
                window._markerDebugLogged = true;
            }
        }
        
        // Create encoder for marker and label render passes
        const overlayEncoder = device.createCommandEncoder();
        
        // Only render markers/labels at zoom 14+ 
        if (camera.zoom >= 4) {
            // Render markers
            renderMarkersToEncoder(overlayEncoder, textureView, device, markerPipeline, markerBuffer, markerBindGroupLayout, renderer.buffers.uniform);
            
            // Build feature names for labels (already done above for heights)
            const featureNames = buildFeatureNameMap(tileBuffers, camera.zoom);
            
            if (!window._labelDebugLogged) {
                console.log('📝 Feature names map size:', featureNames.size);
                if (featureNames.size > 0) {
                    const firstEntry = Array.from(featureNames.entries())[0];
                    console.log('📝 First feature:', firstEntry);
                }
                window._labelDebugLogged = true;
            }
            
            // Get source ID from style (use first vector source)
            const style = getStyle();
            const sourceId = style && style.sources ? Object.keys(style.sources).find(key => style.sources[key].type === 'vector') : null;
            
            // Upload label data to GPU
            const labelCount = textRenderer.uploadLabelData(featureNames, camera, sourceId);
            
            if (!window._labelUploadLogged) {
                console.log(`📤 Uploaded ${labelCount} labels to GPU`);
                window._labelUploadLogged = true;
            }
            
            // Render all labels in one GPU call
            textRenderer.render(overlayEncoder, textureView, markerBuffer, renderer.buffers.uniform);
        }
        
        // Submit overlay rendering (map and compute already submitted)
        device.queue.submit([overlayEncoder.finish()]);
        
        // Asynchronously read marker buffer for NEXT frame
        if (!isReadingMarkers) {
            isReadingMarkers = true;
            readMarkerBufferSync(device, markerBuffer).then(positions => {
                if (positions) {
                    // Count non-zero markers
                    let nonZeroCount = 0;
                    for (let i = 0; i < MAX_FEATURES; i++) {
                        const offset = i * 6;
                        if (positions[offset + 5] > 0) { // Check alpha
                            nonZeroCount++;
                        }
                    }

                    markerPositionCache = positions;
                }
                isReadingMarkers = false;
            }).catch(err => {
                console.error('Error reading markers:', err);
                isReadingMarkers = false;
            });
        }
        
        frameCount++;
        requestAnimationFrame(frame);
    }

    // Start the rendering loop
    requestAnimationFrame(frame);

    // Debug visualization on key press
    document.addEventListener('keydown', (e) => {
        if (e.key === 'd') {
            renderer.renderDebugView();
        } else if (e.key === 'c') {
            clearTileCache(); // Clear the tile cache on 'c' key press
            resetNotFoundTiles(); // Also reset not-found tiles cache
            camera.triggerEvent('zoomend');
        }
    });
}

// Add the initMarkerResources function that was referenced but not defined
function initMarkerResources(device, format, canvas, camera) {
    // Create compute pipelines for 3-pass marker calculation
    const accumulatorPipeline = createAccumulatorPipeline(device);
    const quadrantPipeline = createQuadrantPipeline(device);
    const centerPipeline = createCenterPipeline(device);
    
    // Create storage buffers
    const accumulatorBuffer = device.createBuffer({
        size: ACCUMULATOR_BUFFER_SIZE,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    
    const quadrantBuffer = device.createBuffer({
        size: QUADRANT_BUFFER_SIZE,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    
    const markerBuffer = device.createBuffer({
        size: MARKER_BUFFER_SIZE,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC,
    });
    
    const dimsBuffer = device.createBuffer({
        size: 8,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(dimsBuffer, 0, new Uint32Array([canvas.width, canvas.height]));
    
    // Create marker pipeline (no longer needs camera uniform)
    const { pipeline: markerPipeline, bindGroupLayout: markerBindGroupLayout } = createMarkerPipeline(device, format);

    // Add regions buffer
    const regionsBuffer = device.createBuffer({
        size: REGIONS_BUFFER_SIZE,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    return {
        accumulatorPipeline,
        quadrantPipeline,
        centerPipeline,
        markerPipeline,
        accumulatorBuffer,
        quadrantBuffer,
        markerBuffer,
        dimsBuffer,
        regionsBuffer,
        markerBindGroupLayout
    };
}

// Convert raw tile coordinates to lon/lat with full precision
function convertTileCoordinates(geometry, featureType, tileX, tileY, tileZ, extent = 4096) {
    const size = extent;
    const x0 = extent * tileX;
    const y0 = extent * tileY;
    const scale = extent * (1 << tileZ);  // 2^z * extent
    
    // Convert point from tile coordinates to lon/lat
    const projectPoint = (point) => {
        const lon = 360 * (point.x + x0) / scale - 180;
        const y2 = 180 - 360 * (point.y + y0) / scale;
        const lat = 360 / Math.PI * Math.atan(Math.exp(y2 * Math.PI / 180)) - 90;
        return [lon, lat];
    };
    
    // Handle different geometry types
    if (featureType === 1) {
        // Point or MultiPoint
        if (geometry.length === 1 && geometry[0].length === 1) {
            // Single point
            return projectPoint(geometry[0][0]);
        } else {
            // MultiPoint
            const points = [];
            for (const ring of geometry) {
                for (const point of ring) {
                    points.push(projectPoint(point));
                }
            }
            return points;
        }
    } else if (featureType === 2) {
        // LineString or MultiLineString
        return geometry.map(ring => ring.map(projectPoint));
    } else if (featureType === 3) {
        // Polygon (outer ring + holes)
        return geometry.map(ring => ring.map(projectPoint));
    }
    
    return [];
}

// Load all visible tiles with GPU-accelerated coordinate transformation
async function loadVisibleTiles(visibleTiles, device, newTileBuffers, newHiddenTileBuffers, abortSignal = null) {

    
    // Log tile coordinates for debugging

    
    const tilePromises = visibleTiles.map(async (tile) => {
        const { x, y, z } = tile;
    
        try {
            // Check if aborted before starting
            if (abortSignal?.aborted) {
                return;
            }
            
            const vectorTile = await fetchVectorTile(x, y, z, abortSignal);
            
            // Check if aborted after fetch
            if (abortSignal?.aborted) {
                return;
            }
            
            if (!vectorTile || !vectorTile.layers) {
                console.warn(`⚠️ No layers in tile ${z}/${x}/${y}`);
                return;
            }
            
            // Removed verbose tile rendering logs
            
            if (z >= 14 && !window._tileLayersLogged) {
                console.log(`📦 Tile ${z}/${x}/${y} layers:`, Object.keys(vectorTile.layers));
                window._tileLayersLogged = true;
            }
            
            // Process each layer
            for (const layerName in vectorTile.layers) {
                // Check if aborted before processing each layer
                if (abortSignal?.aborted) {
                    return;
                }
                
                const layer = vectorTile.layers[layerName];
                
                // Collect all features from this layer for batch processing
                const features = [];
                for (let i = 0; i < layer.length; i++) {
                    const feature = layer.feature(i).toGeoJSON(x, y, z);
                    features.push(feature);
                }
                
                // IMPORTANT: Set layer name on ALL features BEFORE GPU processing
                // This ensures the style system can match source-layer correctly
                features.forEach(feature => {
                    feature.layer = { name: layerName };
                });
                
                if (features.length === 0) continue;

                // Check if aborted before processing features
                if (abortSignal?.aborted) {
                    return;
                }

                let parsedFeatures = [];
                const parseStartTime = performance.now();
                if (PERFORMANCE_STATS.gpuEnabled) {
                    // Use GPU batch processing for coordinate transformation
                    const currentStyle = getStyle();
                    const sourceId = currentStyle ? Object.keys(currentStyle.sources)[0] : null;
                    // Use the TILE's zoom level, not the camera zoom, for style evaluation
                    const tileZoom = z;
                    
                    try {
                        parsedFeatures = await batchParseGeoJSONFeaturesGPU(features, device, [0.0, 1.0, 0.0, 1.0], sourceId, tileZoom, x, y, z);
                        if (!window._parseSuccessLogged) {
                            console.log('✅ GPU parsing succeeded:', parsedFeatures.length, 'features');
                            window._parseSuccessLogged = true;
                        }
                    } catch (error) {
                        console.error('❌ GPU parsing failed:', error);
                        return;
                    }
                    
                    const parseEndTime = performance.now();
                    const gpuTime = parseEndTime - parseStartTime;
                    PERFORMANCE_STATS.totalGPUTime += gpuTime;
                    PERFORMANCE_STATS.batchCount++;
                    PERFORMANCE_STATS.gpuBatchCount++;
                    PERFORMANCE_STATS.averageGPUBatchSize = 
                        (PERFORMANCE_STATS.averageGPUBatchSize * (PERFORMANCE_STATS.gpuBatchCount - 1) + features.length) / PERFORMANCE_STATS.gpuBatchCount;
                } else {
                    // Use CPU processing for comparison
                    const currentStyle = getStyle();
                    const sourceId = currentStyle ? Object.keys(currentStyle.sources)[0] : null;
                    const zoom = camera.zoom;
                    
                    for (const feature of features) {
                        const parsed = parseGeoJSONFeature(feature, [0.0, 0.0, 0.0, 1.0], sourceId, zoom);
                        if (parsed) {
                            parsedFeatures.push(parsed);
                        }
                    }
                    
                    const parseEndTime = performance.now();
                    const cpuTime = parseEndTime - parseStartTime;
                    PERFORMANCE_STATS.totalCPUTime += cpuTime;
                    PERFORMANCE_STATS.cpuFeatureCount += features.length;
                }
                
                // Check if aborted after parsing
                if (abortSignal?.aborted) {
                    return;
                }
                
                PERFORMANCE_STATS.totalCoordinatesProcessed += features.length;
                
                // Create buffers for each parsed feature, grouped by layer
                parsedFeatures.forEach(parsedFeature => {
                    const { 
                        vertices, hiddenVertices, fillIndices, hiddenfillIndices,
                        isFilled, isLine, properties, layerId 
                    } = parsedFeature;
                    
                    if (!window._tileBufferLogged) {
                        console.log(`📦 Adding tile ${z}/${x}/${y} to buffers: ${parsedFeatures.length} features, layer: ${layerId}`);
                        window._tileBufferLogged = true;
                    }
                    
                    if (vertices.length === 0 || fillIndices.length === 0) {
                        if (!window._emptyGeomLogged) {
                            console.log('⚠️ EMPTY GEOMETRY:', { 
                                verts: vertices.length, 
                                fillIdx: fillIndices.length,
                                isLine,
                                layerId 
                            });
                            window._emptyGeomLogged = true;
                        }
                        return;
                    }
                    
                    if (isLine && !window._lineBufferLogged) {
                        console.log('📏 Creating LINE buffer:', {
                            layerId,
                            vertices: vertices.length,
                            fillIndices: fillIndices.length
                        });
                        window._lineBufferLogged = true;
                    }
                    
                    if (layerId === 'building-3d' && !window._buildingBufferLogged) {
                        console.log('🏢 Creating BUILDING buffer:', {
                            layerId,
                            vertices: vertices.length,
                            hiddenVertices: hiddenVertices.length,
                            fillIndices: fillIndices.length,
                            hiddenfillIndices: hiddenfillIndices.length
                        });
                        window._buildingBufferLogged = true;
                    }
                    
                    createAndAddBuffers(
                        device,
                        vertices,
                        hiddenVertices,
                        fillIndices,
                        hiddenfillIndices,
                        isFilled,
                        isLine,
                        properties,
                        z,
                        x,
                        y,
                        layerId || 'default',
                        newTileBuffers,
                        newHiddenTileBuffers
                    );
                });
            }
        } catch (err) {
            // Don't log errors if aborted
            if (!abortSignal?.aborted) {
                console.warn(`Error loading tile ${z}/${x}/${y}:`, err);
            }
        }
    });
    
    // Check if aborted before processing results
    if (abortSignal?.aborted) {
        console.log('🛑 Tile loading aborted before starting');
        return;
    }
    
    // Create an abort promise that rejects when the signal is aborted
    const abortPromise = abortSignal ? new Promise((_, reject) => {
        if (abortSignal.aborted) {
            reject(new Error('Aborted'));
        } else {
            abortSignal.addEventListener('abort', () => reject(new Error('Aborted')));
        }
    }) : null;
    
    try {
        if (abortPromise) {
            // Race between tile loading and abort signal
            await Promise.race([
                Promise.allSettled(tilePromises),
                abortPromise
            ]);
        } else {
            await Promise.allSettled(tilePromises);
        }
    } catch (err) {
        if (err.message === 'Aborted') {
            console.log('🛑 Tile loading aborted during fetch');
            return;
        }
        throw err;
    }
    
    // Final check if aborted after loading
    if (abortSignal?.aborted) {
        console.log('🛑 Tile loading aborted after fetch');
        return;
    }
}

// Function to log and compare performance statistics
function logPerformanceStats() {
    const stats = PERFORMANCE_STATS;
    
    if (stats.gpuEnabled && stats.totalGPUTime > 0) {
        const avgGPUTime = stats.totalGPUTime / stats.batchCount;
        const coordsPerSecond = (stats.totalCoordinatesProcessed / stats.totalGPUTime) * 1000;
        
        console.log(`🚀 GPU Performance Stats:`);
        console.log(`  Total coordinates: ${stats.totalCoordinatesProcessed.toLocaleString()}`);
        console.log(`  Total GPU time: ${stats.totalGPUTime.toFixed(2)}ms`);
        console.log(`  Average batch time: ${avgGPUTime.toFixed(2)}ms`);
        console.log(`  Coordinates/second: ${coordsPerSecond.toFixed(0)}`);
    }
    
    if (stats.totalCPUTime > 0) {
        const coordsPerSecond = (stats.totalCoordinatesProcessed / stats.totalCPUTime) * 1000;
        
        console.log(`💻 CPU Performance Stats:`);
        console.log(`  Total coordinates: ${stats.totalCoordinatesProcessed.toLocaleString()}`);
        console.log(`  Total CPU time: ${stats.totalCPUTime.toFixed(2)}ms`);
        console.log(`  Coordinates/second: ${coordsPerSecond.toFixed(0)}`);
    }
    
    if (stats.totalGPUTime > 0 && stats.totalCPUTime > 0) {
        const speedup = stats.totalCPUTime / stats.totalGPUTime;
        console.log(`⚡ GPU Speedup: ${speedup.toFixed(1)}x faster than CPU`);
    }
}

// Helper to align buffer size to 4 bytes (WebGPU requirement)
function alignBufferSize(size) {
    return Math.max(4, Math.ceil(size / 4) * 4);
}

// Helper to pad typed array to aligned size
function padToAlignment(typedArray) {
    const alignedSize = alignBufferSize(typedArray.byteLength);
    if (typedArray.byteLength === alignedSize) {
        return typedArray;
    }
    // Create new array with padded size
    const Constructor = typedArray.constructor;
    const elementsPerByte = typedArray.BYTES_PER_ELEMENT;
    const paddedArray = new Constructor(alignedSize / elementsPerByte);
    paddedArray.set(typedArray);
    return paddedArray;
}

// Create and add buffers for a feature
function createAndAddBuffers(
    device,
    vertices,
    hiddenVertices,
    fillIndices,
    hiddenfillIndices,
    isFilled,
    isLine,
    properties,
    z,
    x,
    y,
    layerId,
    newTileBuffers,
    newHiddenTileBuffers
) {
    if (layerId === 'building-3d' && !window._createBufferLogged) {
        console.log(`🔧 createAndAddBuffers for ${layerId}: hiddenfillIndices.length=${hiddenfillIndices.length}, hiddenVertices.length=${hiddenVertices.length}`);
        window._createBufferLogged = true;
    }
    
    // Create vertex buffer
    const vertexBuffer = device.createBuffer({
        size: alignBufferSize(vertices.byteLength),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vertexBuffer, 0, padToAlignment(vertices));
    
    // HYBRID APPROACH: 
    // - For 3D buildings: use VISIBLE buffer (complex geometry creates edge artifacts for edge detection)
    // - For flat features: use HIDDEN buffer (simple filled surface for clean marker computation)
    const use3DGeometry = layerId.includes('building') || layerId.includes('extrusion');
    
    // Only create hidden buffers for flat features (buildings reuse visible buffers)
    let hiddenVertexBuffer, hiddenFillIndexBuffer;
    if (!use3DGeometry) {
        hiddenVertexBuffer = device.createBuffer({
            size: alignBufferSize(hiddenVertices.byteLength),
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(hiddenVertexBuffer, 0, padToAlignment(hiddenVertices));
        
        hiddenFillIndexBuffer = device.createBuffer({
            size: alignBufferSize(hiddenfillIndices.byteLength),
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(hiddenFillIndexBuffer, 0, padToAlignment(hiddenfillIndices));
    }
    
    // Create index buffers (already Uint32Array from parsing)
    const fillIndexBuffer = device.createBuffer({
        size: alignBufferSize(fillIndices.byteLength),
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(fillIndexBuffer, 0, padToAlignment(fillIndices));
    
    // Add to tile buffers grouped by layer
    if (!newTileBuffers.has(layerId)) {
        newTileBuffers.set(layerId, []);
    }
    if (!newHiddenTileBuffers.has(layerId)) {
        newHiddenTileBuffers.set(layerId, []);
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
    
    // DEBUG: Check what we're adding to hidden buffer
    if (layerId.includes('water') && !window._waterHiddenLogged) {
        console.log(`💧 Water hidden buffer: fillIndices=${fillIndices.length}, hiddenfillIndices=${hiddenfillIndices.length}, isFilled=${isFilled}`);
        window._waterHiddenLogged = true;
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

// Render the map with hidden texture and edge detection
function renderMap(device, renderer, tileBuffers, hiddenTileBuffers, textureView, camera) {
    const mapCommandEncoder = device.createCommandEncoder();
    
    // First render pass: hidden texture for feature IDs (MSAA enabled)
    const hiddenPass = mapCommandEncoder.beginRenderPass({
        colorAttachments: [{
            view: renderer.textures.hiddenMSAA.createView(),  // Render to MSAA texture
            resolveTarget: renderer.textures.hidden.createView(),  // Resolve to regular texture
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
        }],
        depthStencilAttachment: {
            view: renderer.textures.depth.createView(),
            depthClearValue: 1.0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
        }
    });
    
    // Render hidden buffers layer by layer
    if (!window._renderLogged) {
        console.log('🎨 Render buffers:', {
            hiddenLayers: Array.from(hiddenTileBuffers.keys()),
            hiddenCount: Array.from(hiddenTileBuffers.values()).reduce((sum, arr) => sum + arr.length, 0),
            visibleLayers: Array.from(tileBuffers.keys()),
            visibleCount: Array.from(tileBuffers.values()).reduce((sum, arr) => sum + arr.length, 0)
        });
        window._renderLogged = true;
    }
    
    const renderZoom = camera.zoom;
    
    if (!window._zoomFilterLogged) {
        console.log(`🔍 Render zoom: ${renderZoom.toFixed(2)}`);
        console.log('Layer checks:');
        for (const [layerId] of tileBuffers) {
            const shouldRender = shouldRenderLayer(layerId, renderZoom);
            const layer = getLayer(layerId);
            console.log(`  ${layerId}: ${shouldRender ? '✅' : '❌'} (minzoom: ${layer?.minzoom || 0}, maxzoom: ${layer?.maxzoom || 24})`);
        }
        console.log('🔍 Hidden tile buffer layer IDs:', Array.from(hiddenTileBuffers.keys()));
        window._zoomFilterLogged = true;
    }
    
    for (const [layerId, buffers] of hiddenTileBuffers) {
        // Check layer visibility and zoom range
        if (!shouldRenderLayer(layerId, renderZoom)) continue;
        
        // Render ALL hidden geometry for picking to work
        // The geometry will be at roof height if the layer is extruded
        const layer = getLayer(layerId);
        const isExtruded = layer?.paint?.['fill-extrusion-height'] !== undefined;
        
        if (!window._hiddenCheckLogged) {
            console.log(`Hidden rendering ${layerId}: isExtruded=${isExtruded}`);
        }
        
        buffers.forEach(({ vertexBuffer, hiddenFillIndexBuffer, hiddenfillIndexCount }) => {
            if (hiddenfillIndexCount > 0) {
                if (!window._hiddenRenderLogged) {
                    console.log(`🎯 Rendering hidden buffer for ${layerId}: ${hiddenfillIndexCount} indices`);
                    console.log(`   Buffer details:`, {
                        vertexBuffer: vertexBuffer.label || 'unlabeled',
                        indexBuffer: hiddenFillIndexBuffer.label || 'unlabeled',
                        indexCount: hiddenfillIndexCount
                    });
                }
                hiddenPass.setPipeline(renderer.pipelines.hidden);
                hiddenPass.setVertexBuffer(0, vertexBuffer);
                hiddenPass.setIndexBuffer(hiddenFillIndexBuffer, "uint32");
                hiddenPass.setBindGroup(0, renderer.bindGroups.picking);
                hiddenPass.drawIndexed(hiddenfillIndexCount);
            } else {
                if (!window._hiddenRenderLogged) {
                    console.log(`⚠️ Skipping ${layerId}: hiddenfillIndexCount = 0`);
                }
            }
        });
    }
    
    window._hiddenCheckLogged = true;
    window._hiddenRenderLogged = true;
    
    hiddenPass.end();
    
    // Get background color from style or use default
    const currentMapStyle = getStyle();
    let clearColor = { r: 0.67, g: 0.83, b: 0.87, a: 1.0 }; // Default light blue
    if (currentMapStyle?.layers) {
        const backgroundLayer = currentMapStyle.layers.find(l => l.type === 'background');
        if (backgroundLayer?.paint?.['background-color']) {
            const bgColorArray = parseColor(backgroundLayer.paint['background-color']);
            if (bgColorArray) {
                clearColor = {
                    r: bgColorArray[0],
                    g: bgColorArray[1],
                    b: bgColorArray[2],
                    a: bgColorArray[3]
                };
            }
        }
    }
    
    // Second render pass: color texture with map features (MSAA enabled)
    const colorPass = mapCommandEncoder.beginRenderPass({
        colorAttachments: [{
            view: renderer.textures.colorMSAA.createView(),  // Render to MSAA texture
            resolveTarget: renderer.textures.color.createView(),  // Resolve to regular texture
            clearValue: clearColor,
            loadOp: 'clear',
            storeOp: 'store',
        }],
        depthStencilAttachment: {
            view: renderer.textures.depth.createView(),
            depthClearValue: 1.0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
        }
    });
    
    // Get style to check for extrusion layers
    const style = getStyle();
    const extrusionLayers = style?.layers?.filter(l => l.type === 'fill-extrusion').map(l => l.id) || [];
    
    // Check which fills have corresponding extrusions (need depth bias)
    const fillsWithExtrusions = new Set();
    if (style?.layers) {
        for (const extrusionLayer of style.layers.filter(l => l.type === 'fill-extrusion')) {
            // Find matching fill layers with same source/source-layer/filter
            const matchingFills = style.layers.filter(l => 
                l.type === 'fill' &&
                l.source === extrusionLayer.source &&
                l['source-layer'] === extrusionLayer['source-layer']
            );
            matchingFills.forEach(f => fillsWithExtrusions.add(f.id));
        }
    }
    
    // Render ALL geometry in true style order (fills, extrusions, and lines mixed)
    let lineDrawCount = 0;
    if (style?.layers) {
        for (const layer of style.layers) {
            const layerId = layer.id;
            const layerType = layer.type;
            
            // Check layer visibility and zoom range
            if (!shouldRenderLayer(layerId, renderZoom)) continue;
            
            // Get buffers for this layer
            const buffers = tileBuffers.get(layerId);
            if (!buffers) continue;
            
            buffers.forEach(({ vertexBuffer, fillIndexBuffer, fillIndexCount, isLine }) => {
                // Render based on layer type
                if (layerType === 'fill-extrusion' && fillIndexCount > 0) {
                    // 3D building extrusions
                    colorPass.setPipeline(renderer.pipelines.extrusion);
                    colorPass.setVertexBuffer(0, vertexBuffer);
                    colorPass.setIndexBuffer(fillIndexBuffer, "uint32");
                    colorPass.setBindGroup(0, renderer.bindGroups.main);
                    colorPass.drawIndexed(fillIndexCount);
                } else if (layerType === 'fill' && fillIndexCount > 0) {
                    // Regular polygon fills (landuse, water, etc)
                    const useBias = fillsWithExtrusions.has(layerId);
                    const pipeline = useBias ? renderer.pipelines.fillWithBias : renderer.pipelines.fill;
                    colorPass.setPipeline(pipeline);
                    colorPass.setVertexBuffer(0, vertexBuffer);
                    colorPass.setIndexBuffer(fillIndexBuffer, "uint32");
                    colorPass.setBindGroup(0, renderer.bindGroups.main);
                    colorPass.drawIndexed(fillIndexCount);
                } else if (layerType === 'line' && isLine && fillIndexCount > 0) {
                    // Lines (roads, waterways, boundaries)
                    lineDrawCount++;
                    colorPass.setPipeline(renderer.pipelines.fill);
                    colorPass.setVertexBuffer(0, vertexBuffer);
                    colorPass.setIndexBuffer(fillIndexBuffer, "uint32");
                    colorPass.setBindGroup(0, renderer.bindGroups.main);
                    colorPass.drawIndexed(fillIndexCount);
                }
            });
        }
    }
    
    if (!window._totalLineDrawLogged && lineDrawCount > 0) {
        console.log(`🎨 Drew ${lineDrawCount} line/outline buffers`);
        window._totalLineDrawLogged = true;
    }
    
    colorPass.end();
    
    // Third render pass: Apply edge detection to screen
    const mainPass = mapCommandEncoder.beginRenderPass({
        colorAttachments: [{
            view: textureView,  // Use passed texture view instead of calling getCurrentTexture again
            clearValue: clearColor,  // Use the same background color from style
            loadOp: 'load',  // Load existing content, don't clear!
            storeOp: 'store',
        }],
    });
    
    // Now camera parameter is available
    const currentZoom = Math.floor(camera.zoom);
    
    // Update the edge detection bind group with zoom level
    if (currentZoom > 15) {
        // Add special effects for super-zoomed view (if this method exists)
        if (typeof renderer.updateZoomEffects === 'function') {
            renderer.updateZoomEffects(currentZoom);
        }
    }
    
    mainPass.setPipeline(renderer.pipelines.edgeDetection);
    mainPass.setBindGroup(0, renderer.bindGroups.edgeDetection);
    mainPass.draw(3);
    
    mainPass.end();
    
    // DON'T submit here - let caller submit
    return mapCommandEncoder;
}

// Process and render markers - COMPUTE ONLY, submits directly (no return)
function createComputeMarkerEncoder(
    device,
    renderer,
    accumulatorPipeline,
    quadrantPipeline,
    centerPipeline,
    accumulatorBuffer,
    quadrantBuffer,
    markerBuffer,
    dimsBuffer,
    canvas,
    regionsBuffer,
    heightsBuffer
) {
    // Reset buffers for new frame
    device.queue.writeBuffer(accumulatorBuffer, 0, new Uint8Array(ACCUMULATOR_BUFFER_SIZE));
    device.queue.writeBuffer(quadrantBuffer, 0, new Uint8Array(QUADRANT_BUFFER_SIZE));
    
    // Update dimensions from the actual texture
    const hiddenWidth = renderer.textures.hidden.width;
    const hiddenHeight = renderer.textures.hidden.height;
    
    device.queue.writeBuffer(dimsBuffer, 0, new Uint32Array([
        hiddenWidth,
        hiddenHeight
    ]));
    
    // Compute marker positions with 3 passes - MUST submit between passes for atomic visibility
    
    const workgroupCountX = Math.ceil(canvas.width / 16);
    const workgroupCountY = Math.ceil(canvas.height / 16);
    
    // Pass 1: Accumulate centroid and bounding box
    const encoder1 = device.createCommandEncoder();
    const computePass1 = encoder1.beginComputePass();
    computePass1.setPipeline(accumulatorPipeline);
    computePass1.setBindGroup(0, device.createBindGroup({
        layout: accumulatorPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: renderer.textures.hidden.createView() },
            { binding: 1, resource: { buffer: accumulatorBuffer } }
        ]
    }));
    computePass1.dispatchWorkgroups(workgroupCountX, workgroupCountY);
    computePass1.end();
    device.queue.submit([encoder1.finish()]);
    
    
    // Pass 2: Calculate quadrant centroids using stable centroid from pass 1
    const encoder2 = device.createCommandEncoder();
    const computePass2 = encoder2.beginComputePass();
    computePass2.setPipeline(quadrantPipeline);
    computePass2.setBindGroup(0, device.createBindGroup({
        layout: quadrantPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: renderer.textures.hidden.createView() },
            { binding: 1, resource: { buffer: accumulatorBuffer } },
            { binding: 2, resource: { buffer: quadrantBuffer } }
        ]
    }));
    computePass2.dispatchWorkgroups(workgroupCountX, workgroupCountY);
    computePass2.end();
    device.queue.submit([encoder2.finish()]);
    
    // Pass 3: Calculate final marker positions from quadrant data
    const encoder3 = device.createCommandEncoder();
    const computePass3 = encoder3.beginComputePass();
    computePass3.setPipeline(centerPipeline);
    computePass3.setBindGroup(0, device.createBindGroup({
        layout: centerPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: accumulatorBuffer } },
            { binding: 1, resource: { buffer: quadrantBuffer } },
            { binding: 2, resource: { buffer: markerBuffer } },
            { binding: 3, resource: { buffer: dimsBuffer } },
            { binding: 4, resource: renderer.textures.hidden.createView() },
            { binding: 5, resource: { buffer: heightsBuffer } }
        ]
    }));
    const workgroupCount3 = Math.ceil(10000 / 64);
    computePass3.dispatchWorkgroups(workgroupCount3);
    computePass3.end();
    device.queue.submit([encoder3.finish()]);
    
    // All passes submitted, nothing to return
}

// Render markers using pre-computed positions - adds to existing encoder
function renderMarkersToEncoder(
    encoder,
    textureView,
    device,
    markerPipeline,
    markerBuffer,
    markerBindGroupLayout,
    cameraUniformBuffer  // ADD camera uniform
) {
    // Render triangles for markers (pointing downward)
    const triangleData = new Float32Array([
        -0.5,  0.5,  // Top-left
         0.5,  0.5,  // Top-right
         0.0, -0.5   // Bottom point (pointing down)
    ]);
    
    const bufferSize = Math.max(256, triangleData.byteLength); // Minimum 256 bytes
    const triangleBuffer = device.createBuffer({
        size: bufferSize,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true
    });
    new Float32Array(triangleBuffer.getMappedRange()).set(triangleData);
    triangleBuffer.unmap();
    
    const markerPass = encoder.beginRenderPass({
        colorAttachments: [{
            view: textureView,
            loadOp: 'load',
            storeOp: 'store'
        }]
    });
    
    markerPass.setPipeline(markerPipeline);
    markerPass.setVertexBuffer(0, triangleBuffer);
    
    const markerDataBindGroup = device.createBindGroup({
        layout: markerBindGroupLayout,
        entries: [
            { binding: 0, resource: { buffer: cameraUniformBuffer } },  // Camera matrix
            { binding: 1, resource: { buffer: markerBuffer } }           // Marker data
        ]
    });
    
    markerPass.setBindGroup(0, markerDataBindGroup);
    markerPass.draw(3, MAX_FEATURES); // Draw one triangle per feature
    markerPass.end();
}

// Build feature name map from tile buffers
function buildFeatureNameMap(tileBuffers, currentZoom) {
    const featureNames = new Map();
    const style = getStyle();
    const symbolLayers = style?.layers?.filter(l => l.type === 'symbol') || [];
    
    if (!window._symbolLayersLogged) {
        console.log('📝 Symbol layers:', symbolLayers.map(l => ({ id: l.id, sourceLayer: l['source-layer'] })));
        window._symbolLayersLogged = true;
    }
    
    // Debug: what layers do we have in tileBuffers?
    if (!window._tileBufferLayersLogged) {
        const layersInBuffers = Array.from(tileBuffers.keys());
        console.log('📦 Layers in tileBuffers:', layersInBuffers);
        
        // Check if we have building features
        for (const [layerId, buffers] of tileBuffers) {
            const firstBuffer = buffers[0];
            if (firstBuffer?.properties?.sourceLayer === 'building') {
                console.log('🏢 Found building layer:', layerId, 'with', buffers.length, 'buffers');
                console.log('🏢 First building properties:', firstBuffer.properties);
                break;
            }
        }
        window._tileBufferLayersLogged = true;
    }
    
    // Iterate through all layers
    for (const [layerId, buffers] of tileBuffers) {
        for (const tileBuffer of buffers) {
            if (!tileBuffer.properties) continue;
            const clampedFid = tileBuffer.properties.clampedFid;
            const sourceLayer = tileBuffer.properties.sourceLayer;
            
            // Find matching symbol layer for this feature's source-layer
            const matchingSymbolLayer = symbolLayers.find(layer => 
                layer['source-layer'] === sourceLayer
            );
            
            let labelText = null;
            
            if (matchingSymbolLayer && matchingSymbolLayer.layout?.['text-field']) {
                // Evaluate text-field expression
                const textField = matchingSymbolLayer.layout['text-field'];
                labelText = evaluateTextField(textField, tileBuffer.properties);
                
                if (!window._buildingLabelLogged && sourceLayer === 'building') {
                    console.log('🏢 Building label matched:', {
                        sourceLayer,
                        matchingLayer: matchingSymbolLayer.id,
                        textField,
                        properties: tileBuffer.properties,
                        labelText
                    });
                    window._buildingLabelLogged = true;
                }
            } else {
                // Fallback to legacy name properties
                labelText = tileBuffer.properties.NAME || tileBuffer.properties.name || 
                           tileBuffer.properties.ADM0_A3 || tileBuffer.properties.ISO_A3;
            }
            
            if (clampedFid && labelText) {
                // Extract building height from fill-extrusion paint properties
                let totalHeight = 0;
                
                // Find the fill-extrusion layer for this source-layer
                const style = getStyle();
                const extrusionLayer = style?.layers?.find(layer => 
                    layer.type === 'fill-extrusion' && 
                    layer['source-layer'] === sourceLayer
                );
                
                if (extrusionLayer) {
                    // Evaluate the fill-extrusion-height expression
                    const heightValue = getPaintProperty(extrusionLayer.id, 'fill-extrusion-height', 
                        { properties: tileBuffer.properties }, currentZoom);
                    totalHeight = heightValue || 0;
                }
                
                featureNames.set(clampedFid, { 
                    name: labelText, 
                    sourceLayer, 
                    properties: tileBuffer.properties,
                    height: totalHeight
                });
            }
        }
    }
    
    if (!window._featureNamesLogged) {
        console.log('📝 Total features with names:', featureNames.size);
        const buildingLabels = Array.from(featureNames.values()).filter(f => f.sourceLayer === 'building');
        console.log('🏢 Building labels:', buildingLabels.length);
        if (buildingLabels.length > 0) {
            console.log('🏢 First building label:', buildingLabels[0]);
        }
        window._featureNamesLogged = true;
    }
    
    return featureNames;
}

// Simple evaluator for text-field expressions
function evaluateTextField(textField, properties) {
    if (typeof textField === 'string') {
        return textField;
    }
    
    if (Array.isArray(textField)) {
        const [operation, ...args] = textField;
        
        switch (operation) {
            case 'get':
                return properties[args[0]];
            
            case 'to-string':
                const value = evaluateTextField(args[0], properties);
                return value != null ? String(value) : '';
            
            case 'concat':
                return args.map(arg => {
                    const val = evaluateTextField(arg, properties);
                    return val != null ? String(val) : '';
                }).join('');
            
            default:
                return null;
        }
    }
    
    return textField;
}

function renderLabelsToEncoder(encoder, textureView, textRenderer, tileBuffers, markerPositions, camera) {
    if (!textRenderer || !textRenderer.initialized || !markerPositions) return;
    
    textRenderer.clearLabels();
    
    // Build feature name map using CLAMPED feature ID as key
    const featureNames = new Map();
    
    for (const [layerId, buffers] of tileBuffers) {
        for (const tileBuffer of buffers) {
            if (!tileBuffer.properties) continue;
            const clampedFid = tileBuffer.properties.clampedFid;
            const name = tileBuffer.properties.NAME || tileBuffer.properties.ADM0_A3 || tileBuffer.properties.ISO_A3;
            
            if (clampedFid && name) {
                featureNames.set(clampedFid, name);
            }
        }
    }
    
    // Marker buffer format: [centerX, centerY, colorR, colorG, colorB, colorA] = 6 floats per marker
    const markerStride = 6;
    const maxMarkers = 256;
    
    let labelCount = 0;
   
    
    // Render labels for ALL countries
    for (let i = 0; i < maxMarkers; i++) {
        const offset = i * markerStride;
        const x = markerPositions[offset];
        const y = markerPositions[offset + 1];
        const colorA = markerPositions[offset + 5];
        
        if (colorA > 0 && featureNames.has(i)) {
            const name = featureNames.get(i);
            if (name) {
                textRenderer.addLabel(name, x, y, 0.6);
            }
        }
    }
    
    // Render using the passed encoder
    textRenderer.render(encoder, textureView, camera);
}

// Synchronously read marker buffer (blocking but ensures labels match current frame)
async function readMarkerBufferSync(device, markerBuffer) {
    try {
        const readBuffer = device.createBuffer({
            size: MARKER_BUFFER_SIZE,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });
        
        const copyEncoder = device.createCommandEncoder();
        copyEncoder.copyBufferToBuffer(markerBuffer, 0, readBuffer, 0, MARKER_BUFFER_SIZE);
        device.queue.submit([copyEncoder.finish()]);
        
        await readBuffer.mapAsync(GPUMapMode.READ);
        const data = new Float32Array(readBuffer.getMappedRange()).slice();
        readBuffer.unmap();
        readBuffer.destroy();
        
        // Debug: Check Russia (ID 48) specifically
        if (frameCount % 60 === 0) {
            const id = 48;
            const offset = id * 6;
            
            
            // Count total markers
            let count = 0;
            for (let i = 0; i < MAX_FEATURES; i++) {
                if (data[i * 6 + 5] > 0) count++;
            }
            
        }
        
        return data;
    } catch (err) {
        console.error('Error reading markers sync:', err);
        return null;
    }
}

// Asynchronously read marker buffer (doesn't block rendering)
let pendingRead = null;
async function readMarkerBufferAsync(device, markerBuffer) {
    // Skip if there's already a read in progress
    if (pendingRead) {
        return pendingRead;
    }
    
    pendingRead = (async () => {
        try {
            const readBuffer = device.createBuffer({
                size: MARKER_BUFFER_SIZE,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
            });
            
            const copyEncoder = device.createCommandEncoder();
            copyEncoder.copyBufferToBuffer(markerBuffer, 0, readBuffer, 0, MARKER_BUFFER_SIZE);
            device.queue.submit([copyEncoder.finish()]);
            
            await readBuffer.mapAsync(GPUMapMode.READ);
            const data = new Float32Array(readBuffer.getMappedRange()).slice(); // Copy the data
            readBuffer.unmap();
            readBuffer.destroy();
            
            return data;
        } finally {
            pendingRead = null;
        }
    })();
    
    return pendingRead;
}

// OLD function - not used
function renderLabels_OLD(device, textureView, textRenderer, tileBuffers, camera, canvas, markerBuffer) {
    if (!textRenderer || !textRenderer.initialized) return;
    
    // Clear previous labels
    textRenderer.clearLabels();
    
    // Extract labels from visible features using the same centroid calculation as before
    const labeledFeatures = new Map();
    
    for (const [layerId, buffers] of tileBuffers) {
        for (const tileBuffer of buffers) {
            if (!tileBuffer.properties) continue;
            
            const featureId = tileBuffer.properties.fid;
            const name = tileBuffer.properties.NAME || tileBuffer.properties.ADM0_A3 || tileBuffer.properties.ISO_A3;
            
            if (!featureId || !name || labeledFeatures.has(featureId)) continue;
            
            // Calculate centroid from vertices - these are in clip space after GPU transformation
            const clipPos = calculateCentroid(tileBuffer.vertices);
            if (!clipPos) continue;
            
            labeledFeatures.set(featureId, { name, clipPos });
        }
    }
    
    if (labeledFeatures.size === 0) return;
    
    // Add labels to renderer at centroid positions
    for (const [featureId, data] of labeledFeatures) {
        const baseSize = Math.max(0.8, Math.min(2.0, camera.zoom / 4));
        textRenderer.addLabel(data.name, data.clipPos[0], data.clipPos[1], baseSize);
    }
    
    // Render all labels
    const encoder = device.createCommandEncoder();
    textRenderer.render(encoder, textureView, camera);
    device.queue.submit([encoder.finish()]);
}

// Calculate centroid from vertex array
function calculateCentroid(vertices) {
    if (!vertices || vertices.length < 6) return null;
    
    let sumX = 0, sumY = 0;
    let count = 0;
    
    // Vertices are [x, y, r, g, b, a, ...]
    for (let i = 0; i < vertices.length; i += 6) {
        sumX += vertices[i];
        sumY += vertices[i + 1];
        count++;
    }
    
    if (count === 0) return null;
    
    return [sumX / count, sumY / count];
}

// Start application
main();