// Event handlers for map interactions
//
// Controls:
// - Left mouse drag: Pan the map
// - Right mouse drag: Adjust pitch (tilt) and bearing (rotation)
// - Mouse wheel: Zoom in/out
// - Arrow keys: Up/Down = pitch, Left/Right = bearing
// - R key: Reset camera to top-down view (pitch=0, bearing=0)
//
// At module scope, add a shared read buffer for click events. Note: Ensure its size (16) matches usage.
let sharedReadBuffer = null;
let bufferIsMapped = false; // Track buffer mapping state

export function setupEventListeners(canvas, camera, device, renderer, tileBuffers) {
    let isPanning = false;
    let isPitching = false; // Track if we're adjusting pitch with right mouse button
    let lastX = 0;
    let lastY = 0;

    // FIXED: Much more aggressive zooming
    canvas.addEventListener('wheel', (event) => {
        event.preventDefault();  // Prevent page scrolling
        
        // CRITICAL FIX: Update mouse world position BEFORE zooming
        // Pass canvas explicitly to ensure correct bounding rect
        camera.updateMousePosition(event, canvas);
        
        // Use a smoother zoom factor that varies with zoom level
        // Lower zoom factor at higher zoom levels for more control
        const baseZoomFactor = 1.3;  
        let wheelZoomFactor;
        
        if (camera.zoom > 15) {
            wheelZoomFactor = 1.1;  // Finer control at high zoom
        } else if (camera.zoom > 10) {
            wheelZoomFactor = 1.2;  // Medium control at medium zoom
        } else {
            wheelZoomFactor = baseZoomFactor;  // Normal zooming at low zoom
        }
        
        // Display current zoom level before zoom
        const beforeZoom = camera.zoom;
        
        if (event.deltaY < 0) {
            camera.zoomIn(wheelZoomFactor);
        } else {
            camera.zoomOut(wheelZoomFactor);
        }
        
        // Add debug visualization to verify zoom is working
        const zoomLevel = camera.zoom.toFixed(1);
        const visualZoom = camera.getVisualZoom().toFixed(1);
        
        // Create a temporary overlay showing the zoom level
        const overlay = document.createElement('div');
        overlay.textContent = `Zoom: ${camera.zoom.toFixed(2)}`;
        overlay.style.position = 'absolute';
        overlay.style.top = '10px';
        overlay.style.left = '10px';
        overlay.style.background = 'rgba(0,0,0,0.7)';
        overlay.style.color = 'white';
        overlay.style.padding = '5px 10px';
        overlay.style.borderRadius = '5px';
        overlay.style.fontSize = '16px';
        document.body.appendChild(overlay);
        
        // Remove after 1.5 seconds
        setTimeout(() => {
            document.body.removeChild(overlay);
        }, 1500);
        
    }, { passive: false });  // Important for preventDefault to work

    // Start panning on mouse down
    canvas.addEventListener('mousedown', (event) => {
        if (event.button === 0) { // Left mouse button
            isPanning = true;
            lastX = event.clientX;
            lastY = event.clientY;
        } else if (event.button === 2) { // Right mouse button for pitch/bearing
            isPitching = true;
            lastX = event.clientX;
            lastY = event.clientY;
            event.preventDefault(); // Prevent context menu
        }
    });

    // Stop panning/pitching on mouse up
    canvas.addEventListener('mouseup', (event) => {
        if (event.button === 0) {
            isPanning = false;
        } else if (event.button === 2) {
            isPitching = false;
        }
    });

    // Prevent context menu on right click
    canvas.addEventListener('contextmenu', (event) => {
        event.preventDefault();
    });

    // Pan the camera on mouse move
    canvas.addEventListener('mousemove', (event) => {
        // CRITICAL FIX: Always update mouse world position for accurate zoom-to-mouse
        camera.updateMousePosition(event, canvas);
        
        if (isPanning) {
            // Calculate effective zoom (2^zoom) for proper pan scaling
            const effectiveZoom = Math.pow(2, camera.zoom);
            const dx = (event.clientX - lastX) / canvas.clientWidth * effectiveZoom;
            const dy = (lastY - event.clientY) / canvas.clientHeight * effectiveZoom;
            camera.pan(dx, dy);
            lastX = event.clientX;
            lastY = event.clientY;
        } else if (isPitching) {
            // Adjust pitch with vertical mouse movement
            const dy = event.clientY - lastY;
            camera.adjustPitch(dy * 0.3); // Scale factor for smooth control
            
            // Adjust bearing with horizontal mouse movement
            const dx = event.clientX - lastX;
            camera.adjustBearing(dx * 0.3);
            
            lastX = event.clientX;
            lastY = event.clientY;
        }
    });

    // Handle click events for feature picking
    canvas.addEventListener('click', async (event) => {
        if (isPanning) return;

        // Don't proceed if buffer is already mapped
        if (bufferIsMapped) {
            console.warn("Previous buffer mapping still in progress, skipping click");
            return;
        }

        const rect = canvas.getBoundingClientRect();
        const pixelX = Math.floor((event.clientX - rect.left) * canvas.width / rect.width);
        const pixelY = canvas.height - Math.floor((event.clientY - rect.top) * canvas.height / rect.height); // Flip Y

        // Reuse shared read buffer
        if (!sharedReadBuffer) {
            sharedReadBuffer = device.createBuffer({
                size: 16,
                usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
            });
        }

        const commandEncoder = device.createCommandEncoder();
        commandEncoder.copyTextureToBuffer(
            {
                texture: renderer.textures.hidden,  // Always use current texture from renderer
                origin: { x: pixelX, y: pixelY, z: 0 },
                mipLevel: 0,
                aspect: 'all'
            },
            {
                buffer: sharedReadBuffer,
                offset: 0,
                bytesPerRow: 256,  // Must be 256-aligned
                rowsPerImage: 1
            },
            { width: 1, height: 1, depthOrArrayLayers: 1 }
        );

        device.queue.submit([commandEncoder.finish()]);

        try {
            bufferIsMapped = true; // Set mapping flag
            await sharedReadBuffer.mapAsync(GPUMapMode.READ);
            
            const data = new Uint8Array(sharedReadBuffer.getMappedRange());
            
            // Decode 24-bit feature ID from R+G+B channels (format is BGRA, so indices are reversed)
            // BGRA format: B=data[0], G=data[1], R=data[2], A=data[3]
            const redChannel = data[2];    // High byte (bits 16-23)
            const greenChannel = data[1];  // Mid byte (bits 8-15)
            const blueChannel = data[0];   // Low byte (bits 0-7)
            const alphaChannel = data[3];  // Layer ID
            const featureId = redChannel * 65536 + greenChannel * 256 + blueChannel;
            const layerId = alphaChannel;
            
            console.log('🖱️ Click pixel data:', {
                red: redChannel,
                green: greenChannel,
                blue: blueChannel,
                alpha: alphaChannel,
                featureId: featureId,
                layerId: layerId,
                hexColor: `rgba(${redChannel}, ${greenChannel}, ${blueChannel}, ${alphaChannel})`
            });
            
            // Ignore clicks where there's no feature
            if (!featureId) {
                sharedReadBuffer.unmap();
                bufferIsMapped = false; // Clear mapping flag
                return;
            }

            // Find feature across all layers
            let feature = null;
            for (const [layerId, buffers] of tileBuffers) {
                feature = buffers.find(b => b.properties?.fid === featureId || b.properties?.clampedFid === featureId);
                if (feature) break;
            }
            
            if (feature) {
                // Log feature properties on click
                console.log('🎯 Clicked feature:', {
                    featureId,
                    layerId: layerId,
                    properties: feature.properties,
                    sourceLayer: feature.properties?.sourceLayer
                });
                
                // Write the raw values directly - feature ID (24-bit) and layer ID (8-bit)
                console.log('📤 Setting uniforms:', { pickedId: featureId, pickedLayerId: layerId });
                device.queue.writeBuffer(renderer.buffers.pickedId, 0, new Float32Array([featureId]));
                device.queue.writeBuffer(renderer.buffers.pickedLayerId, 0, new Float32Array([layerId]));
            } else {
                // Clear selection
                console.log('❌ No feature found, clearing selection');
                device.queue.writeBuffer(renderer.buffers.pickedId, 0, new Float32Array([0]));
                device.queue.writeBuffer(renderer.buffers.pickedLayerId, 0, new Float32Array([0]));
            }

            sharedReadBuffer.unmap();
            bufferIsMapped = false; // Clear mapping flag
            
        } catch (err) {
            console.error("Error mapping buffer:", err);
            // Make sure we clear the flag even if there's an error
            if (sharedReadBuffer && bufferIsMapped) {
                try {
                    sharedReadBuffer.unmap();
                } catch (e) {
                    console.warn("Error unmapping buffer:", e);
                }
                bufferIsMapped = false;
            }
        }
    });

    // Keyboard controls for pitch and bearing
    window.addEventListener('keydown', (event) => {
        const step = 2; // Degrees per key press
        
        switch(event.key) {
            case 'ArrowUp':
                event.preventDefault();
                camera.adjustPitch(step);
                console.log(`⬆️ Pitch: ${camera.pitch.toFixed(1)}°`);
                break;
            case 'ArrowDown':
                event.preventDefault();
                camera.adjustPitch(-step);
                console.log(`⬇️ Pitch: ${camera.pitch.toFixed(1)}°`);
                break;
            case 'ArrowLeft':
                event.preventDefault();
                camera.adjustBearing(-step);
                console.log(`⬅️ Bearing: ${camera.bearing.toFixed(1)}°`);
                break;
            case 'ArrowRight':
                event.preventDefault();
                camera.adjustBearing(step);
                console.log(`➡️ Bearing: ${camera.bearing.toFixed(1)}°`);
                break;
            case 'r':
            case 'R':
                // Reset pitch and bearing
                camera.setPitch(0);
                camera.setBearing(0);
                console.log('🔄 Reset camera to top-down view');
                break;
        }
    });
}