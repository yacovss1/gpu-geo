/**
 * Main Entry Point - GPU-Accelerated Web Map Renderer
 * 
 * This file initializes and orchestrates all map components:
 * - WebGPU initialization
 * - Camera and event handling
 * - Tile management
 * - Style management
 * - Performance monitoring
 * - Render loop coordination
 */

import { initWebGPU } from './src/core/webgpu-init.js';
import { Camera } from './src/core/camera.js';
import { MapRenderer } from './src/rendering/renderer.js';
import { TileManager } from './src/tiles/TileManager.js';
import { clearTileCache, resetNotFoundTiles } from './src/tiles/geojson.js';
import { setupEventListeners } from './src/core/events.js';
import { getVisibleTiles } from './src/tiles/tile-utils.js';
import { createAccumulatorPipeline, createQuadrantPipeline, createCenterPipeline } from './src/rendering/markerCompute.js';
import { createMarkerPipeline } from './src/rendering/markerPipeline.js';
import { GPUTextRenderer } from './src/text/gpuTextRenderer.js';
import { PerformanceManager } from './src/core/performance.js';
import { StyleManager } from './src/core/styleManager.js';
import { LabelManager } from './src/rendering/labelManager.js';
import { 
    renderMap, 
    createComputeMarkerEncoder, 
    renderMarkersToEncoder, 
    readMarkerBufferSync, 
    initMarkerResources 
} from './src/rendering/renderingUtils.js';
import { destroyAllBuffers } from './src/core/bufferUtils.js';

// Constants
const MAX_FEATURES = 65535;
const MIN_ZOOM_FOR_LABELS = 4;

/**
 * Main application entry point
 */
async function main() {
    // ===== Initialize Canvas =====
    document.body.style.margin = "0";
    document.body.style.padding = "0";

    const canvas = document.getElementById('canvas');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + "px";
    canvas.style.height = rect.height + "px";
    
    // ===== Initialize WebGPU =====
    const { device, context } = await initWebGPU(canvas);
    const format = navigator.gpu.getPreferredCanvasFormat();

    // ===== Initialize Core Components =====
    const renderer = new MapRenderer(device, context, format);
    const camera = new Camera(canvas.width, canvas.height);
    const performanceManager = new PerformanceManager();
    const styleManager = new StyleManager();
    const labelManager = new LabelManager();
    const textRenderer = new GPUTextRenderer(device);
    
    camera.position = [0, 0]; // Start at world center (Greenwich/Equator)
    camera.zoom = 1;
    
    await textRenderer.initialize('Arial', 48);
    await renderer.createResources(canvas, camera);

    // ===== Initialize TileManager =====
    const tileManager = new TileManager(device, performanceManager.stats);
    
    // ===== Initialize Marker Resources =====
    const markerResources = initMarkerResources(
        device, format, canvas, camera,
        createAccumulatorPipeline,
        createQuadrantPipeline,
        createCenterPipeline,
        createMarkerPipeline
    );

    // Create heights buffer for building extrusions
    const heightsBuffer = device.createBuffer({
        size: MAX_FEATURES * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // ===== Setup Global API =====
    setupGlobalAPI(
        device, camera, tileManager, 
        performanceManager, styleManager,
        renderer
    );

    // ===== Load Initial Style =====
    try {
        await styleManager.loadStyleFromURL('./openfreemap-style.json');
    } catch (error) {
        console.warn('⚠️ Could not load style, using default colors:', error.message);
    }

    // ===== Setup Tile Loading Events =====
    setupTileLoadingEvents(
        camera, tileManager, renderer, 
        styleManager, device
    );

    // ===== Setup Event Listeners =====
    setupEventListeners(canvas, camera, device, renderer, tileManager.visibleTileBuffers);

    // ===== Setup Keyboard Shortcuts =====
    setupKeyboardShortcuts(renderer, camera);

    // ===== Rendering State =====
    let isReadingMarkers = false;

    // ===== Render Loop =====
    async function frame() {
        camera.updatePosition();
        const transformMatrix = camera.getMatrix();
        renderer.updateCameraTransform(transformMatrix);

        const currentTexture = context.getCurrentTexture();
        const textureView = currentTexture.createView();

        // Render map geometry
        const mapEncoder = renderMap(
            device, renderer, 
            tileManager.visibleTileBuffers, 
            tileManager.hiddenTileBuffers, 
            textureView, camera,
            (layerId, zoom) => styleManager.shouldRenderLayer(layerId, zoom)
        );
        device.queue.submit([mapEncoder.finish()]);
        
        // Render markers and labels at higher zoom levels
        if (camera.zoom >= MIN_ZOOM_FOR_LABELS) {
            // Build feature names and extract heights
            const featureNames = labelManager.buildFeatureNameMap(tileManager.visibleTileBuffers, camera.zoom);
            
            // Upload heights to GPU
            const heightsArray = new Float32Array(MAX_FEATURES);
            for (const [fid, feature] of featureNames.entries()) {
                if (fid < MAX_FEATURES) {
                    heightsArray[fid] = feature.height || 0;
                }
            }
            device.queue.writeBuffer(heightsBuffer, 0, heightsArray);
            
            // Compute marker positions (3-pass GPU compute)
            createComputeMarkerEncoder(
                device, renderer,
                markerResources.accumulatorPipeline,
                markerResources.quadrantPipeline,
                markerResources.centerPipeline,
                markerResources.accumulatorBuffer,
                markerResources.quadrantBuffer,
                markerResources.markerBuffer,
                markerResources.dimsBuffer,
                canvas,
                markerResources.regionsBuffer,
                heightsBuffer
            );
            
            // Render markers and labels
            const overlayEncoder = device.createCommandEncoder();
            
            renderMarkersToEncoder(
                overlayEncoder, textureView, device,
                markerResources.markerPipeline,
                markerResources.markerBuffer,
                markerResources.markerBindGroupLayout,
                renderer.buffers.uniform
            );
            
            // Upload and render labels
            const sourceId = styleManager.getStyle()?.sources 
                ? Object.keys(styleManager.getStyle().sources).find(key => styleManager.getStyle().sources[key].type === 'vector') 
                : null;
            textRenderer.uploadLabelData(featureNames, camera, sourceId);
            textRenderer.render(overlayEncoder, textureView, markerResources.markerBuffer, renderer.buffers.uniform);
            
            device.queue.submit([overlayEncoder.finish()]);
        }
        
        // Async marker buffer reading for next frame
        if (!isReadingMarkers) {
            isReadingMarkers = true;
            readMarkerBufferSync(device, markerResources.markerBuffer)
                .then(() => { isReadingMarkers = false; })
                .catch(() => { isReadingMarkers = false; });
        }
        
        requestAnimationFrame(frame);
    }

    // ===== Handle Window Resize =====
    window.addEventListener('resize', async () => {
        const dpr = window.devicePixelRatio || 1;
        const width = window.innerWidth;
        const height = window.innerHeight;
        
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = width + "px";
        canvas.style.height = height + "px";
        
        context.configure({
            device: device,
            format: format,
            alphaMode: 'premultiplied',
        });
        
        camera.updateDimensions(canvas.width, canvas.height);
        device.queue.writeBuffer(renderer.buffers.canvasSize, 0, new Float32Array([canvas.width, canvas.height]));
        
        await renderer.createTextures(canvas.width, canvas.height);
        renderer.updateTextureBindGroups();
    });

    // ===== Start Rendering =====
    requestAnimationFrame(frame);
}

/**
 * Setup global API for console access
 */
function setupGlobalAPI(device, camera, tileManager, performanceManager, styleManager, renderer) {
    // Expose core objects
    window.device = device;
    window.camera = camera;
    window.tileManager = tileManager;
    window.tileBuffers = tileManager.visibleTileBuffers;
    window.hiddenTileBuffers = tileManager.hiddenTileBuffers;
    
    // Performance API
    window.mapPerformance = {
        setGPUEnabled: async (enabled) => {
            performanceManager.setGPUEnabled(enabled);
            await destroyAllBuffers(device, tileManager.visibleTileBuffers, tileManager.hiddenTileBuffers);
            clearTileCache();
            resetNotFoundTiles();
            camera.triggerEvent('zoomend');
        },
        isGPUEnabled: () => performanceManager.isGPUEnabled(),
        getStats: () => performanceManager.getStats(),
        resetStats: () => performanceManager.resetStats(),
        logStats: () => performanceManager.logStats(),
        runBenchmark: (coords) => performanceManager.runBenchmark(device, coords),
        enableLiveMonitoring: (interval) => performanceManager.enableLiveMonitoring(interval),
        disableLiveMonitoring: () => performanceManager.disableLiveMonitoring()
    };
    
    // Style API
    window.mapStyle = {
        setStyle: async (style) => {
            await styleManager.setStyle(style);
            await destroyAllBuffers(device, tileManager.visibleTileBuffers, tileManager.hiddenTileBuffers);
            camera.triggerEvent('zoomend');
        },
        getStyle: () => styleManager.getStyle(),
        loadStyleFromURL: (url) => styleManager.loadStyleFromURL(url),
        setLayerVisibility: async (layerId, visible) => {
            await device.queue.onSubmittedWorkDone();
            await styleManager.setLayerVisibility(layerId, visible);
            await destroyAllBuffers(device, tileManager.visibleTileBuffers, tileManager.hiddenTileBuffers);
            camera.triggerEvent('zoomend');
        },
        getLayerVisibility: (layerId) => styleManager.getLayerVisibility(layerId),
        listLayers: () => styleManager.listLayers()
    };
    
    // Convenience aliases
    window.gpuMode = () => window.mapPerformance.setGPUEnabled(true);
    window.cpuMode = () => window.mapPerformance.setGPUEnabled(false);
    window.perfStats = () => window.mapPerformance.logStats();
    window.benchmark = (coords) => window.mapPerformance.runBenchmark(coords);
    window.clearCache = () => {
        clearTileCache();
        resetNotFoundTiles();
        camera.triggerEvent('zoomend');
    };
    
    // Set tile reload callback
    styleManager.setTileReloadCallback(() => camera.triggerEvent('zoomend'));
}

/**
 * Setup tile loading event handlers
 */
function setupTileLoadingEvents(camera, tileManager, renderer, styleManager, device) {
    let lastFetchZoom = -1;

    // Abort ongoing loads when zooming
    camera.addEventListener('zoom', () => {
        tileManager.abort();
    });

    // Load tiles when zoom ends
    camera.addEventListener('zoomend', async (event) => {
        const displayZoom = camera.zoom;
        let fetchZoom = event.detail?.fetchZoom || Math.min(displayZoom, camera.maxFetchZoom);
        
        // Respect style maxzoom
        const currentStyle = styleManager.getStyle();
        if (currentStyle?.sources) {
            const sourceId = Object.keys(currentStyle.sources)[0];
            const source = currentStyle.sources[sourceId];
            if (source?.maxzoom !== undefined) {
                fetchZoom = Math.min(fetchZoom, source.maxzoom);
            }
        }
        
        // Clear tiles on zoom change
        const shouldClearOldTiles = lastFetchZoom !== -1 && fetchZoom !== lastFetchZoom;
        if (shouldClearOldTiles) {
            await device.queue.onSubmittedWorkDone();
            await destroyAllBuffers(device, tileManager.visibleTileBuffers, tileManager.hiddenTileBuffers);
            clearTileCache();
        }
        lastFetchZoom = fetchZoom;
        
        // Update renderer zoom info
        renderer.updateZoomInfo(camera.zoom, fetchZoom);
        
        // Load visible tiles
        await tileManager.loadVisibleTiles(camera, fetchZoom, shouldClearOldTiles);
    });

    // Handle panning with debounce
    let panTimeout = null;
    camera.addEventListener('pan', () => {
        tileManager.abort();
        
        if (panTimeout) clearTimeout(panTimeout);
        panTimeout = setTimeout(() => {
            camera.triggerEvent('zoomend');
        }, 150);
    });

    // Trigger initial tile load
    camera.triggerEvent('zoomend');
}

/**
 * Setup keyboard shortcuts
 */
function setupKeyboardShortcuts(renderer, camera) {
    document.addEventListener('keydown', (e) => {
        if (e.key === 'd') {
            renderer.renderDebugView();
        } else if (e.key === 'c') {
            clearTileCache();
            resetNotFoundTiles();
            camera.triggerEvent('zoomend');
        }
    });
}

// ===== Start Application =====
main().catch(error => {
    console.error('Failed to initialize map:', error);
});
