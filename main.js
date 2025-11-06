import { initWebGPU } from './src/webgpu-init.js';
import { Camera } from './src/camera.js';
import { MapRenderer } from './src/renderer.js';
import { parseGeoJSONFeature, fetchVectorTile, clearTileCache, resetNotFoundTiles } from './src/geojson.js';
import { parseGeoJSONFeatureGPU, batchParseGeoJSONFeaturesGPU } from './src/geojsonGPU.js';
import { setupEventListeners } from './src/events.js';
import { getVisibleTiles } from './src/tile-utils.js'; 
import { createMarkerPipeline } from './src/markerPipeline.js';
import { createAccumulatorPipeline, createCenterPipeline } from './src/markerCompute.js';
import {WebGPUTranslationLayer} from './src/core/translation/WebGPUTranslationLayer.ts';

// Define constants at file scope to ensure they're available everywhere
// Expanded to accommodate compound IDs (feature ID + polygon ID)
const ACCUMULATOR_BUFFER_SIZE = 256 * (8 + 4); // Unchanged - we'll just use the first 256 entries
const REGIONS_BUFFER_SIZE = 256 * 16;          // For 4 atomic u32s per feature
const MARKER_BUFFER_SIZE = 256 * 24;           // Same, 256 markers maximum

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
        const { gpuMercatorToClipSpace } = await import('./src/coordinateGPU.js');
        const gpuResults = await gpuMercatorToClipSpace(testCoords, window.device);
        const gpuTime = performance.now() - gpuStartTime;
        
        // CPU benchmark
        const cpuStartTime = performance.now();
        const { mercatorToClipSpace } = await import('./src/utils.js');
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

// Convenience aliases for console usage
window.gpuMode = () => window.mapPerformance.setGPUEnabled(true);
window.cpuMode = () => window.mapPerformance.setGPUEnabled(false);
window.perfStats = () => window.mapPerformance.logStats();
window.benchmark = (coords) => window.mapPerformance.runBenchmark(coords);

// Module-level variable for tracking zoom changes
let lastLoggedZoom = -1;
let frameCount = 0; // Define frameCount variable that was missing

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
    canvas.style.height = rect.height + "px";    // Initialize WebGPU
    const { device, context } = await initWebGPU(canvas);
    const format = navigator.gpu.getPreferredCanvasFormat();

    // Initialize renderer and camera
    const renderer = new MapRenderer(device, context, format);
    const camera = new Camera(canvas.width, canvas.height);
    renderer.createResources(canvas, camera);

    // Store loaded tiles
    const tileBuffers = [];
    const hiddenTileBuffers = [];
    
    // Expose global variables for performance controls
    window.device = device;
    window.camera = camera;
    window.tileBuffers = tileBuffers;
    window.hiddenTileBuffers = hiddenTileBuffers;

    // Initialize marker rendering resources
    const { 
        accumulatorPipeline, 
        centerPipeline,
        markerPipeline,
        markerBuffer,
        accumulatorBuffer,
        dimsBuffer,
        markerUniformBuffer,
        markerBindGroup,
        regionsBuffer
    } = initMarkerResources(device, format, canvas, camera);

    // Handle zoom events for loading tiles
    camera.addEventListener('zoomend', async (event) => {
        // Extract both zoom levels properly
        const displayZoom = event.detail?.displayZoom || Math.floor(camera.zoom);
        const fetchZoom = event.detail?.fetchZoom || Math.min(displayZoom, camera.maxFetchZoom);
        
        // Only log when zoom level changes significantly
        if (lastLoggedZoom !== displayZoom) {
            console.log(`Zoom levels: display=${displayZoom}, fetch=${fetchZoom}`);
            lastLoggedZoom = displayZoom;
        }
        
        // Always update the renderer with both zoom levels
        renderer.updateZoomInfo(camera.zoom, fetchZoom);
        
        // Get visible tiles for the fetch zoom level only
        const visibleTiles = getVisibleTiles(camera, fetchZoom);
        
        // Debugging: Confirm overzooming when applicable
        if (displayZoom > fetchZoom) {
            console.log(`🔍 OVERZOOMING: Using zoom ${displayZoom} display with zoom ${fetchZoom} tiles`);
        }
        
        if (visibleTiles.length === 0) {
            console.warn("No visible tiles at zoom level " + fetchZoom);
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
            console.log(`No new tiles to fetch at zoom ${fetchZoom}. Applying overzooming to display zoom ${displayZoom}`);
        }
        
        // Create new buffers for incoming tiles
        const newTileBuffers = [];
        const newHiddenTileBuffers = [];
        
        if (tilesToFetch.length > 0) {
            console.log(`Fetching ${tilesToFetch.length} new tiles at zoom ${fetchZoom}`);
            
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
                    console.log(`Loaded ${newTileBuffers.length} new tiles at zoom ${fetchZoom}`);
                    
                    // Get current zoom level from existing tiles
                    const currentTileZoom = tileBuffers.length > 0 ? tileBuffers[0].zoomLevel : -1;
                    
                    // First, calculate how much of the viewport is covered by the new tiles
                    const newTileKeys = new Set(newTileBuffers.map(
                        t => `${t.zoomLevel}/${t.tileX}/${t.tileY}`
                    ));
                    
                    // Number of visible tiles we have now (existing + new)
                    const coveragePct = (newTileKeys.size / visibleTiles.length) * 100;
                    console.log(`New coverage: ${coveragePct.toFixed(1)}% of viewport`);
                    
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
                console.error("Error loading tiles:", error);
            }
        } else {
            console.log(`No new tiles to fetch at zoom ${fetchZoom}`);
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
    console.log('Triggering initial tile fetch.'); // Debug log
    camera.triggerEvent('zoomend');

    // Set up event listeners
    setupEventListeners(canvas, camera, device, renderer.textures.hidden, tileBuffers, renderer.buffers.pickedId);

    // Main rendering loop
    async function frame() {
        // Update camera and transform matrices
        camera.updatePosition();
        const transformMatrix = camera.getMatrix();
        
        // Update transform matrices
        renderer.updateCameraTransform(transformMatrix);
        device.queue.writeBuffer(markerUniformBuffer, 0, transformMatrix);

        // Render map with camera parameter
        renderMap(device, renderer, tileBuffers, hiddenTileBuffers, context, camera);
        
        // Process and render markers
        renderMarkers(
            device, 
            renderer, 
            context, 
            accumulatorPipeline, 
            centerPipeline, 
            markerPipeline, 
            accumulatorBuffer, 
            markerBuffer, 
            dimsBuffer, 
            markerBindGroup, 
            canvas,
            regionsBuffer
        );

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
    // Create compute pipelines for marker centers
    const accumulatorPipeline = createAccumulatorPipeline(device);
    const centerPipeline = createCenterPipeline(device);
    
    // Create storage buffers
    const accumulatorBuffer = device.createBuffer({
        size: ACCUMULATOR_BUFFER_SIZE,
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
        centerPipeline,
        markerPipeline,
        accumulatorBuffer,
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
                
                if (features.length === 0) continue;

                let parsedFeatures = [];
                const parseStartTime = performance.now();
                  if (PERFORMANCE_STATS.gpuEnabled) {
                    // Use GPU batch processing for coordinate transformation
                    console.log(`GPU batch processing ${features.length} features in layer ${layerName} for tile ${z}/${x}/${y}`);
                    parsedFeatures = await batchParseGeoJSONFeaturesGPU(features, device);
                    
                    const parseEndTime = performance.now();
                    const gpuTime = parseEndTime - parseStartTime;
                    PERFORMANCE_STATS.totalGPUTime += gpuTime;
                    PERFORMANCE_STATS.batchCount++;
                    PERFORMANCE_STATS.gpuBatchCount++;
                    PERFORMANCE_STATS.averageGPUBatchSize = 
                        (PERFORMANCE_STATS.averageGPUBatchSize * (PERFORMANCE_STATS.gpuBatchCount - 1) + features.length) / PERFORMANCE_STATS.gpuBatchCount;
                    
                    console.log(`GPU batch parsing took ${gpuTime.toFixed(2)}ms for ${features.length} features`);                } else {
                    // Use CPU processing for comparison
                    console.log(`CPU processing ${features.length} features in layer ${layerName} for tile ${z}/${x}/${y}`);
                    
                    for (const feature of features) {
                        const parsed = parseGeoJSONFeature(feature);
                        if (parsed) {
                            parsedFeatures.push(parsed);
                        }
                    }
                    
                    const parseEndTime = performance.now();
                    const cpuTime = parseEndTime - parseStartTime;
                    PERFORMANCE_STATS.totalCPUTime += cpuTime;
                    PERFORMANCE_STATS.cpuFeatureCount += features.length;
                    
                    console.log(`CPU parsing took ${cpuTime.toFixed(2)}ms for ${features.length} features`);
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
    
    // Log performance statistics periodically
    if (PERFORMANCE_STATS.batchCount > 0 && PERFORMANCE_STATS.batchCount % 10 === 0) {
        logPerformanceStats();
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
function renderMap(device, renderer, tileBuffers, hiddenTileBuffers, context, camera) {
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
    
    colorPass.end();
    
    // Third render pass: Apply edge detection to screen
    const mainPass = mapCommandEncoder.beginRenderPass({
        colorAttachments: [{
            view: context.getCurrentTexture().createView(),
            clearValue: { r: 0.15, g: 0.35, b: 0.6, a: 1.0 },
            loadOp: 'clear',
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
    
    // Submit map drawing commands
    device.queue.submit([mapCommandEncoder.finish()]);
}

// Process and render markers
function renderMarkers(
    device,
    renderer,
    context,
    accumulatorPipeline,
    centerPipeline,
    markerPipeline,
    accumulatorBuffer,
    markerBuffer,
    dimsBuffer,
    markerBindGroup,
    canvas,
    regionsBuffer
) {
    // Reset accumulator buffer for new frame
    device.queue.writeBuffer(accumulatorBuffer, 0, new Uint8Array(ACCUMULATOR_BUFFER_SIZE));
    
    // Update dimensions from the actual texture
    device.queue.writeBuffer(dimsBuffer, 0, new Uint32Array([
        renderer.textures.hidden.width,
        renderer.textures.hidden.height
    ]));
    
    // Compute marker positions
    const markerComputeEncoder = device.createCommandEncoder();
    
    // First compute pass: Accumulate pixels by feature ID
    const computeEncoder = markerComputeEncoder.beginComputePass();
    computeEncoder.setPipeline(accumulatorPipeline);
    computeEncoder.setBindGroup(0, device.createBindGroup({
        layout: accumulatorPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: renderer.textures.hidden.createView() },
            { binding: 1, resource: { buffer: accumulatorBuffer } }
        ]
    }));
    
    const workgroupCountX = Math.ceil(canvas.width / 16);
    const workgroupCountY = Math.ceil(canvas.height / 16);
    computeEncoder.dispatchWorkgroups(workgroupCountX, workgroupCountY);
    computeEncoder.end();
    
    // Second compute pass: Calculate marker centers
    const computeEncoder2 = markerComputeEncoder.beginComputePass();
    computeEncoder2.setPipeline(centerPipeline);
    computeEncoder2.setBindGroup(0, device.createBindGroup({
        layout: centerPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: accumulatorBuffer } },
            { binding: 1, resource: { buffer: markerBuffer } },
            { binding: 2, resource: { buffer: dimsBuffer } },
            { binding: 3, resource: renderer.textures.hidden.createView() }
        ]
    }));
    computeEncoder2.dispatchWorkgroups(4);
    computeEncoder2.end();
    
    device.queue.submit([markerComputeEncoder.finish()]);
    
    // Render markers
    const markerRenderEncoder = device.createCommandEncoder();
    const triangleData = new Float32Array([
        -0.5, -0.5,
         0.5, -0.5,
         0.0,  0.5
    ]);
    
    const triangleBuffer = device.createBuffer({
        size: triangleData.byteLength,
        usage: GPUBufferUsage.VERTEX,
        mappedAtCreation: true
    });
    new Float32Array(triangleBuffer.getMappedRange()).set(triangleData);
    triangleBuffer.unmap();
    
    const markerPass = markerRenderEncoder.beginRenderPass({
        colorAttachments: [{
            view: context.getCurrentTexture().createView(),
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
    markerPass.draw(3, 256);
    markerPass.end();
    
    device.queue.submit([markerRenderEncoder.finish()]);
}

// Start application
main();