// At module scope, add a shared read buffer for click events. Note: Ensure its size (16) matches usage.
let sharedReadBuffer = null;
let bufferIsMapped = false; // Track buffer mapping state

export function setupEventListeners(canvas, camera, device, hiddenTexture, tileBuffers, pickedIdBuffer) {
    let isPanning = false;
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
        isPanning = true;
        lastX = event.clientX;
        lastY = event.clientY;
    });

    // Stop panning on mouse up
    canvas.addEventListener('mouseup', () => {
        isPanning = false;
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
                texture: hiddenTexture,
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
            
            // Decode 16-bit feature ID from red and green channels (format is BGRA, so indices are reversed)
            // BGRA format: B=data[0], G=data[1], R=data[2], A=data[3]
            const redChannel = data[2];   // High byte
            const greenChannel = data[1]; // Low byte
            const featureId = redChannel * 256 + greenChannel;
            
            // Ignore clicks on ocean (where there's no feature)
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
                // Write the raw value directly
                device.queue.writeBuffer(pickedIdBuffer, 0, new Float32Array([featureId]));
            } else {
                // Clear selection
                device.queue.writeBuffer(pickedIdBuffer, 0, new Float32Array([0]));
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
}