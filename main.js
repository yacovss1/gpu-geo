import { initWebGPU } from './src/core/webgpu-init.js';
import { Camera } from './src/core/camera.js';
import { MapRenderer } from './src/rendering/renderer.js';
import { parseGeoJSONFeature, fetchVectorTile, clearTileCache, resetNotFoundTiles, setTileSource } from './src/tiles/geojson.js';
import { batchParseGeoJSONFeaturesGPU } from './src/tiles/geojsonGPU.js';
import { getStyle, setStyle, setLayerVisibility, getLayerVisibility } from './src/core/style.js';
import { setupEventListeners } from './src/core/events.js';
import { getVisibleTiles } from './src/tiles/tile-utils.js'; 
import { createMarkerPipeline } from './src/rendering/markerPipeline.js';
import { createAccumulatorPipeline, createQuadrantPipeline, createCenterPipeline } from './src/rendering/markerCompute.js';
import { GPUTextRenderer } from './src/text/gpuTextRenderer.js';

// Define constants at file scope to ensure they're available everywhere
// 9-quadrant labeling system (center + 8 directional positions)
const MAX_FEATURES = 10000; // Scaled up from 256, can go to 65536 with 16-bit encoding
const ACCUMULATOR_BUFFER_SIZE = MAX_FEATURES * 28; // Pass 1: 7 u32 per feature (sumX, sumY, count, minX, minY, maxX, maxY) = 28 bytes
const QUADRANT_BUFFER_SIZE = MAX_FEATURES * 108; // Pass 2: 9 quadrants × 3 u32 each = 108 bytes per feature
const REGIONS_BUFFER_SIZE = MAX_FEATURES * 16;   // For 4 atomic u32s per feature  
const MARKER_BUFFER_SIZE = MAX_FEATURES * 24;    // 6 floats per marker: vec2 center + vec4 color

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
            window.tileBuffers.length = 0;
            window.hiddenTileBuffers.length = 0;
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
                window.tileBuffers.length = 0;
                window.hiddenTileBuffers.length = 0;
                
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
    setLayerVisibility: (layerId, visible) => {
        console.log(`🎨 Setting layer ${layerId} visibility to ${visible}`);
        setLayerVisibility(layerId, visible);
        // Force re-render by clearing everything
        tileBuffers.length = 0;
        hiddenTileBuffers.length = 0;
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
    camera.zoom = 2; // Start at zoom 2 so labels are visible (countries-label minzoom: 2)
    
    // Handle window resize
    window.addEventListener('resize', () => {
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
        
        // Recreate textures and bind groups
        renderer.createTextures(canvas.width, canvas.height);
        renderer.updateTextureBindGroups();
    });
    
    // Initialize GPU-native text renderer
    const textRenderer = new GPUTextRenderer(device);
    await textRenderer.initialize('Arial', 48);
    
    // Start at world center [0, 0] (Greenwich/Equator)
    camera.position = [0, 0];
    
    renderer.createResources(canvas, camera);

    // Store loaded tiles
    const tileBuffers = [];
    const hiddenTileBuffers = [];
    
    // Expose global variables for performance controls
    window.device = device;
    window.camera = camera;
    window.tileBuffers = tileBuffers;
    window.hiddenTileBuffers = hiddenTileBuffers;

    // Load the official MapLibre style from the demotiles server
    try {
        await window.mapStyle.loadStyleFromURL('https://demotiles.maplibre.org/style.json');
        console.log('✅ MapLibre style loaded successfully');
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
        markerUniformBuffer,
        markerBindGroup,
        regionsBuffer
    } = initMarkerResources(device, format, canvas, camera);

    // Handle zoom events for loading tiles
    camera.addEventListener('zoomend', async (event) => {
        // Extract both zoom levels properly
        const displayZoom = camera.zoom;
        let fetchZoom = event.detail?.fetchZoom || Math.min(displayZoom, camera.maxFetchZoom);
        
        // Respect style maxzoom if available
        const currentStyle = getStyle();
        if (currentStyle && currentStyle.sources) {
            const sourceId = Object.keys(currentStyle.sources)[0];
            const source = currentStyle.sources[sourceId];
            if (source && source.maxzoom !== undefined) {
                fetchZoom = Math.min(fetchZoom, source.maxzoom);
            }
        }
        
        // Always update the renderer with both zoom levels
        renderer.updateZoomInfo(camera.zoom, fetchZoom);
        
        // Get visible tiles for the fetch zoom level only
        const visibleTiles = getVisibleTiles(camera, fetchZoom);
        
        if (visibleTiles.length === 0) {
            return;
        }
        
        // Create database of all existing tiles (by key)
        const existingTilesByKey = {};
        tileBuffers.forEach((tile, index) => {
            const key = `${tile.zoomLevel}/${tile.tileX}/${tile.tileY}`;
            existingTilesByKey[key] = {
                tile,
                hiddenTile: hiddenTileBuffers[index],
                index
            };
        });
        
        // Only fetch tiles we don't already have
        const tilesToFetch = visibleTiles.filter(tile => 
            !existingTilesByKey[`${tile.z}/${tile.x}/${tile.y}`]
        );
        
        // If no tiles to fetch, still update the rendering scale for overzooming
        if (tilesToFetch.length === 0) {
            // Apply overzooming by updating the transform uniforms
            // This happens automatically via camera.getMatrix() already
        }
        
        // Create new buffers for incoming tiles
        const newTileBuffers = [];
        const newHiddenTileBuffers = [];
        
        if (tilesToFetch.length > 0) {
            try {
                // Load tiles in larger batches for better throughput
                const batchSize = 16;  // Increased batch size for faster loading
                for (let i = 0; i < tilesToFetch.length; i += batchSize) {
                    const batch = tilesToFetch.slice(i, i + batchSize);
                    await loadVisibleTiles(batch, device, newTileBuffers, newHiddenTileBuffers);
                }
                
                // Only add new tiles, never clear existing tiles unless explicitly requested
                // This ensures we always have full coverage even if some tiles fail to load
                if (newTileBuffers.length > 0) {
                    // Get current zoom level from existing tiles
                    const currentTileZoom = tileBuffers.length > 0 ? tileBuffers[0].zoomLevel : -1;
                    
                    // First, calculate how much of the viewport is covered by the new tiles
                    const newTileKeys = new Set(newTileBuffers.map(
                        t => `${t.zoomLevel}/${t.tileX}/${t.tileY}`
                    ));
                    
                    // Number of visible tiles we have now (existing + new)
                    const coveragePct = (newTileKeys.size / visibleTiles.length) * 100;
                    
                    // If we have good coverage with new tiles (90%+) AND the zoom changed,
                    // we can safely remove old tiles from previous zoom levels
                    if (fetchZoom !== currentTileZoom && coveragePct >= 90) {
                        console.log(`Good coverage with zoom ${fetchZoom}, removing old tiles from zoom ${currentTileZoom}`);
                        
                        // Remove tiles from previous zoom level only
                        const updatedTileBuffers = tileBuffers.filter(t => 
                            t.zoomLevel === fetchZoom || t.zoomLevel > currentTileZoom
                        );
                        const updatedHiddenTileBuffers = hiddenTileBuffers.filter(t => 
                            t.zoomLevel === fetchZoom || t.zoomLevel > currentTileZoom  
                        );
                        
                        // Update tile arrays with filtered tiles
                        tileBuffers.length = 0;
                        hiddenTileBuffers.length = 0;
                        tileBuffers.push(...updatedTileBuffers);
                        hiddenTileBuffers.push(...updatedHiddenTileBuffers);
                    }
                    
                    // Always add new tiles
                    tileBuffers.push(...newTileBuffers);
                    hiddenTileBuffers.push(...newHiddenTileBuffers);
                }
            } catch (error) {
                // Error loading tiles - keep existing tiles
            }
        } else {
            // No new tiles to fetch
        }
    });

    // Pan handler with strict throttling and debouncing
    camera.addEventListener('pan', () => {
        // Track time to prevent excessive triggers
        const now = performance.now();
        if (camera.lastPanTime && (now - camera.lastPanTime < 500)) {
            // Skip if less than 500ms since last pan event
            return;
        }
        camera.lastPanTime = now;
        
        // Only trigger on significant movement
        const velocityMag = Math.sqrt(
            camera.velocity[0] * camera.velocity[0] + 
            camera.velocity[1] * camera.velocity[1]
        );
        
        if (velocityMag > 0.05) { // Much higher threshold than before
            console.log(`Triggering tile update on pan, velocity: ${velocityMag.toFixed(3)}`);
            
            // Throttle pan triggers using timeout
            if (camera.panTriggerTimeout) {
                clearTimeout(camera.panTriggerTimeout);
            }
            
            camera.panTriggerTimeout = setTimeout(() => {
                camera.triggerEvent('zoomend');
                camera.panTriggerTimeout = null;
            }, 250); // Wait 250ms to trigger tile fetch
        }
    });

    // Trigger initial tile fetch
    camera.triggerEvent('zoomend');

    // Set up event listeners
    setupEventListeners(canvas, camera, device, renderer.textures.hidden, tileBuffers, renderer.buffers.pickedId);

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
        device.queue.writeBuffer(markerUniformBuffer, 0, transformMatrix);

        // Get the current texture ONCE for this frame
        const currentTexture = context.getCurrentTexture();
        const textureView = currentTexture.createView();

        // Render map - returns encoder without submitting
        const mapEncoder = renderMap(device, renderer, tileBuffers, hiddenTileBuffers, textureView, camera);
        
        // MUST submit map first so hidden texture is populated before compute reads it
        device.queue.submit([mapEncoder.finish()]);
        
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
            regionsBuffer
        );
        
        // Create encoder for marker and label render passes
        const overlayEncoder = device.createCommandEncoder();
        
        // Render markers
        renderMarkersToEncoder(overlayEncoder, textureView, device, markerPipeline, markerBindGroup, markerBuffer);
        
        // Render labels using cached positions from PREVIOUS frame
        // (One frame delay is acceptable - labels will catch up)
        if (markerPositionCache) {
            //renderLabelsToEncoder(overlayEncoder, textureView, textRenderer, tileBuffers, markerPositionCache, camera);
        }
        
        // NEW: Render labels directly from GPU marker buffer
        const featureNames = buildFeatureNameMap(tileBuffers);
        
        // Create bind group for marker buffer (same as markers use at group 1)
        const markerDataBindGroup = device.createBindGroup({
            layout: markerPipeline.getBindGroupLayout(1),
            entries: [{ binding: 0, resource: { buffer: markerBuffer } }]
        });
        
        // Get source ID from style (use first vector source)
        const style = getStyle();
        const sourceId = style && style.sources ? Object.keys(style.sources).find(key => style.sources[key].type === 'vector') : null;
        
        // Upload label data to GPU
        textRenderer.uploadLabelData(featureNames, camera, sourceId);
        
        // Render all labels in one GPU call
        textRenderer.render(overlayEncoder, textureView, markerBuffer);
        
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
    
    // Create marker pipeline
    const markerPipeline = createMarkerPipeline(device, format);
    const markerUniformBuffer = device.createBuffer({
        size: 64,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(markerUniformBuffer, 0, camera.getMatrix());
    
    const markerBindGroup = device.createBindGroup({
        layout: markerPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: markerUniformBuffer } }]
    });

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
        markerUniformBuffer,
        markerBindGroup,
        regionsBuffer
    };
}

// Load all visible tiles with GPU-accelerated coordinate transformation
async function loadVisibleTiles(visibleTiles, device, newTileBuffers, newHiddenTileBuffers) {
    const tilePromises = visibleTiles.map(async (tile) => {
        const { x, y, z } = tile;
        try {
            const vectorTile = await fetchVectorTile(x, y, z);
            if (!vectorTile || !vectorTile.layers) return;
            
            // Process each layer
            for (const layerName in vectorTile.layers) {
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

                let parsedFeatures = [];
                const parseStartTime = performance.now();
                  if (PERFORMANCE_STATS.gpuEnabled) {
                    // Use GPU batch processing for coordinate transformation
                    const currentStyle = getStyle();
                    const sourceId = currentStyle ? Object.keys(currentStyle.sources)[0] : null;
                    const zoom = camera.zoom;
                    
                    parsedFeatures = await batchParseGeoJSONFeaturesGPU(features, device, [0.0, 0.0, 0.0, 1.0], sourceId, zoom);
                    
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
                
                PERFORMANCE_STATS.totalCoordinatesProcessed += features.length;
                
                // Create buffers for each parsed feature
                parsedFeatures.forEach(parsedFeature => {
                    const { 
                        vertices, hiddenVertices, fillIndices, hiddenfillIndices,
                        outlineIndices, isFilled, isLine, properties 
                    } = parsedFeature;
                    
                    if (vertices.length === 0 || (fillIndices.length === 0 && outlineIndices.length === 0)) {
                        return;
                    }
                    
                    createAndAddBuffers(
                        device,
                        vertices,
                        hiddenVertices,
                        fillIndices,
                        outlineIndices,
                        hiddenfillIndices,
                        isFilled,
                        isLine,
                        properties,
                        z,
                        x,
                        y,
                        newTileBuffers,
                        newHiddenTileBuffers
                    );
                });
            }
        } catch (err) {
            console.warn(`Error loading tile ${z}/${x}/${y}:`, err);
        }
    });
    
    await Promise.all(tilePromises);
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

// Create and add buffers for a feature
function createAndAddBuffers(
    device,
    vertices,
    hiddenVertices,
    fillIndices,
    outlineIndices,
    hiddenfillIndices,
    isFilled,
    isLine,
    properties,
    z,
    x,
    y,
    newTileBuffers,
    newHiddenTileBuffers
) {
    // Create vertex buffer
    const vertexBuffer = device.createBuffer({
        size: vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vertexBuffer, 0, vertices);
    
    const hiddenVertexBuffer = device.createBuffer({
        size: hiddenVertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(hiddenVertexBuffer, 0, hiddenVertices);
    
    // Ensure index buffers are padded correctly
    const paddedFillIndices = fillIndices.length % 2 === 0 ? fillIndices : new Uint16Array([...fillIndices, 0]);
    const fillIndexBuffer = device.createBuffer({
        size: paddedFillIndices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(fillIndexBuffer, 0, paddedFillIndices);
    
    const paddedOutlineIndices = outlineIndices.length % 2 === 0 ? outlineIndices : new Uint16Array([...outlineIndices, 0]);
    const outlineIndexBuffer = device.createBuffer({
        size: paddedOutlineIndices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(outlineIndexBuffer, 0, paddedOutlineIndices);
    
    const paddedHiddenFillIndices = hiddenfillIndices.length % 2 === 0 ? hiddenfillIndices : new Uint16Array([...hiddenfillIndices, 0]);
    const hiddenFillIndexBuffer = device.createBuffer({
        size: paddedHiddenFillIndices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(hiddenFillIndexBuffer, 0, paddedHiddenFillIndices);
    
    // Add to tile buffers
    newTileBuffers.push({
        vertexBuffer,
        fillIndexBuffer,
        outlineIndexBuffer,
        fillIndexCount: fillIndices.length,
        outlineIndexCount: outlineIndices.length,
        isFilled,
        isLine,
        properties,
        zoomLevel: z,
        tileX: x,
        tileY: y,
        vertices: vertices
    });
    
    newHiddenTileBuffers.push({
        vertexBuffer: hiddenVertexBuffer,
        hiddenFillIndexBuffer,
        hiddenfillIndexCount: hiddenfillIndices.length,
        properties,
        zoomLevel: z,
        tileX: x,
        tileY: y,
        isFilled,
    });
}

// Render the map with hidden texture and edge detection
function renderMap(device, renderer, tileBuffers, hiddenTileBuffers, textureView, camera) {
    const mapCommandEncoder = device.createCommandEncoder();
    
    // First render pass: hidden texture for feature IDs
    const hiddenPass = mapCommandEncoder.beginRenderPass({
        colorAttachments: [{
            view: renderer.textures.hidden.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
        }],
    });
    
    hiddenTileBuffers.forEach(({ vertexBuffer, hiddenFillIndexBuffer, hiddenfillIndexCount }) => {
        if (hiddenfillIndexCount > 0) {
            hiddenPass.setPipeline(renderer.pipelines.hidden);
            hiddenPass.setVertexBuffer(0, vertexBuffer);
            hiddenPass.setIndexBuffer(hiddenFillIndexBuffer, "uint16");
            hiddenPass.setBindGroup(0, renderer.bindGroups.picking);
            hiddenPass.drawIndexed(hiddenfillIndexCount);
        }
    });
    
    hiddenPass.end();
    
    // Second render pass: color texture with map features
    const colorPass = mapCommandEncoder.beginRenderPass({
        colorAttachments: [{
            view: renderer.textures.color.createView(),
            clearValue: { r: 0.15, g: 0.35, b: 0.6, a: 1.0 },
            loadOp: 'clear',
            storeOp: 'store',
        }],
    });
    
    tileBuffers.forEach(({ vertexBuffer, fillIndexBuffer, fillIndexCount }) => {
        if (fillIndexCount > 0) {
            colorPass.setPipeline(renderer.pipelines.fill);
            colorPass.setVertexBuffer(0, vertexBuffer);
            colorPass.setIndexBuffer(fillIndexBuffer, "uint16");
            colorPass.setBindGroup(0, renderer.bindGroups.main);
            colorPass.drawIndexed(fillIndexCount);
        }
    });
    
    // Draw outlines (borders) after fills
    tileBuffers.forEach(({ vertexBuffer, outlineIndexBuffer, outlineIndexCount }) => {
        if (outlineIndexCount > 0) {
            colorPass.setPipeline(renderer.pipelines.outline);
            colorPass.setVertexBuffer(0, vertexBuffer);
            colorPass.setIndexBuffer(outlineIndexBuffer, "uint16");
            colorPass.setBindGroup(0, renderer.bindGroups.main);
            colorPass.drawIndexed(outlineIndexCount);
        }
    });
    
    colorPass.end();
    
    // Third render pass: Apply edge detection to screen
    const mainPass = mapCommandEncoder.beginRenderPass({
        colorAttachments: [{
            view: textureView,  // Use passed texture view instead of calling getCurrentTexture again
            clearValue: { r: 0.15, g: 0.35, b: 0.6, a: 1.0 },
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
    regionsBuffer
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
            { binding: 4, resource: renderer.textures.hidden.createView() }
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
    markerBindGroup,
    markerBuffer
) {
    // Render triangles for markers (pointing downward)
    const triangleData = new Float32Array([
        -0.5,  0.5,  // Top-left
         0.5,  0.5,  // Top-right
         0.0, -0.5   // Bottom point (pointing down)
    ]);
    
    const triangleBuffer = device.createBuffer({
        size: triangleData.byteLength,
        usage: GPUBufferUsage.VERTEX,
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
    markerPass.setBindGroup(0, markerBindGroup);
    markerPass.setVertexBuffer(0, triangleBuffer);
    
    const markerDataBindGroup = device.createBindGroup({
        layout: markerPipeline.getBindGroupLayout(1),
        entries: [{ binding: 0, resource: { buffer: markerBuffer } }]
    });
    
    markerPass.setBindGroup(1, markerDataBindGroup);
    markerPass.draw(3, MAX_FEATURES); // Draw one triangle per feature
    markerPass.end();
}

// Build feature name map from tile buffers
function buildFeatureNameMap(tileBuffers) {
    const featureNames = new Map();
    for (const tileBuffer of tileBuffers) {
        if (!tileBuffer.properties) continue;
        const clampedFid = tileBuffer.properties.clampedFid;
        const name = tileBuffer.properties.NAME || tileBuffer.properties.ADM0_A3 || tileBuffer.properties.ISO_A3;
        const sourceLayer = tileBuffer.properties.sourceLayer;
        if (clampedFid && name) {
            featureNames.set(clampedFid, { name, sourceLayer });
        }
    }
    return featureNames;
}

function renderLabelsToEncoder(encoder, textureView, textRenderer, tileBuffers, markerPositions, camera) {
    if (!textRenderer || !textRenderer.initialized || !markerPositions) return;
    
    textRenderer.clearLabels();
    
    // Build feature name map using CLAMPED feature ID as key
    const featureNames = new Map();
    
    for (const tileBuffer of tileBuffers) {
        if (!tileBuffer.properties) continue;
        const clampedFid = tileBuffer.properties.clampedFid;
        const name = tileBuffer.properties.NAME || tileBuffer.properties.ADM0_A3 || tileBuffer.properties.ISO_A3;
        
        if (clampedFid && name) {
            featureNames.set(clampedFid, name);
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
    
    for (const tileBuffer of tileBuffers) {
        if (!tileBuffer.properties) continue;
        
        const featureId = tileBuffer.properties.fid;
        const name = tileBuffer.properties.NAME || tileBuffer.properties.ADM0_A3 || tileBuffer.properties.ISO_A3;
        
        if (!featureId || !name || labeledFeatures.has(featureId)) continue;
        
        // Calculate centroid from vertices - these are in clip space after GPU transformation
        const clipPos = calculateCentroid(tileBuffer.vertices);
        if (!clipPos) continue;
        
        labeledFeatures.set(featureId, { name, clipPos });
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