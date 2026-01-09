import { mat4 } from 'gl-matrix';

export class Camera extends EventTarget {
    constructor(viewportWidth, viewportHeight) {
        super();
        this.position = [0, 0]; // Camera position in 2D
        this.trueZoom = 1;
        this.maxFetchZoom = 14;   // Tiles max at 14
        this.maxZoom = 22;        // Max zoom level (2^22 = ~4M scale, same as MapLibre)
        this.minZoom = 0;         // Start at 0 for exponential zoom (2^0 = 1x scale)
        this.zoom = 0;            // Start at zoom 0
        this.pitch = 0;           // No pitch
        this.bearing = 0;         // Rotation around Z axis (0 = north up)
        this.zoomFactor = 1.0;    // Zoom by 1 level at a time (reasonable speed)
        this.viewportWidth = viewportWidth;
        this.viewportHeight = viewportHeight;
        this.velocity = [0, 0];
        this.friction = 0.95;  // Increased for more momentum/drift
        this.velocityFactor = 0.5;
        this.zoomSpeed = 0.1;
        this.zoomEndTimeout = null;
        this.zoomEndDelay = 250;
        this._cachedMatrix = null;
        this._lastState = { pos: [...this.position], zoom: this.zoom, pitch: this.pitch, bearing: this.bearing };
        
        // Store mouse position in NORMALIZED screen coordinates (0-1 range)
        // This way it's independent of zoom level
        this.mouseScreenX = 0.5; // Center of screen
        this.mouseScreenY = 0.5;
        this.lastZoomDisplay = -1; // Track the last displayed zoom for debugging

        // Add a debug variable to track what's happening with zoom levels
        this._zoomDebug = {
            raw: 0,
            visual: 0,
            lastUpdate: Date.now()
        };
    }

    updateMousePosition(event, canvas = null) {
        const target = canvas || event.target;
        const rect = target.getBoundingClientRect();
        // Store normalized screen position (0 to 1)
        this.mouseScreenX = (event.clientX - rect.left) / rect.width;
        this.mouseScreenY = (event.clientY - rect.top) / rect.height;
        // console.log(`🖱️ Mouse updated: screen[${this.mouseScreenX.toFixed(3)}, ${this.mouseScreenY.toFixed(3)}]`);
    }

    updateDimensions(width, height) {
        this.viewportWidth = width;
        this.viewportHeight = height;
        this._cachedMatrix = null; // Invalidate cached matrix
    }

    // Convert current mouse screen position to world coordinates
    getMouseWorldPosition() {
        // Convert from screen (0-1) to clip space (-1 to 1)
        const mouseClipX = this.mouseScreenX * 2 - 1;
        const mouseClipY = 1 - this.mouseScreenY * 2; // Flip Y
        
        const aspectRatio = this.viewportWidth / this.viewportHeight;
        const worldX = this.position[0] + (mouseClipX / this.zoom) * aspectRatio;
        const worldY = this.position[1] + (mouseClipY / this.zoom);
        
        return [worldX, worldY];
    }

    getMatrix() {
        // Only recompute if position, zoom, pitch, or bearing changed
        if (
            this._cachedMatrix &&
            this._lastState.pos[0] === this.position[0] &&
            this._lastState.pos[1] === this.position[1] &&
            this._lastState.zoom === this.zoom &&
            this._lastState.pitch === this.pitch &&
            this._lastState.bearing === this.bearing
        ) {
            return this._cachedMatrix;
        }

        const aspectRatio = this.viewportWidth / this.viewportHeight;
        const effectiveZoom = Math.pow(2, this.zoom);
        const bearingRadians = this.bearing * Math.PI / 180;
        const pitchRadians = this.pitch * Math.PI / 180;

        let matrix;
        
        // Always use perspective - works at all pitch values including 0
        matrix = this._buildPerspectiveMatrix(aspectRatio, effectiveZoom, bearingRadians, pitchRadians);
        
        this._visualZoom = effectiveZoom;
        this._zoomDebug.visual = effectiveZoom;
        this._cachedMatrix = matrix;
        this._lastState = { 
            pos: [...this.position], 
            zoom: this.zoom,
            pitch: this.pitch,
            bearing: this.bearing
        };
        return matrix;
    }

    _buildOrthographicMatrix(aspectRatio, effectiveZoom, bearingRadians) {
        // Original orthographic with isometric shear for buildings
        const matrix = mat4.create();
        
        // Scale XY by zoom, Z stays constant
        mat4.scale(matrix, matrix, [effectiveZoom / aspectRatio, effectiveZoom, 1.0]);
        
        // Apply bearing rotation
        if (this.bearing !== 0) {
            mat4.rotateZ(matrix, matrix, bearingRadians);
        }
        
        // Translate to camera position
        mat4.translate(matrix, matrix, [-this.position[0], -this.position[1], 0]);
        
        // Apply isometric shear for building extrusion
        const totalShear = 0.5;
        const shear = mat4.create();
        const shearY = -totalShear * Math.cos(bearingRadians);
        const shearX = -totalShear * Math.sin(bearingRadians);
        shear[8] = shearX;
        shear[9] = shearY;
        mat4.multiply(matrix, matrix, shear);
        
        return matrix;
    }

    _buildPerspectiveMatrix(aspectRatio, effectiveZoom, bearingRadians, pitchRadians) {
        // TRUE 3D PERSPECTIVE using lookAt for clarity
        //
        // Our world: XY plane is the map, +Z is up (buildings)
        // Camera orbits around the look-at point based on pitch
        //
        // At pitch=0: camera directly above, looking straight down
        // At pitch=60: camera tilted back, showing horizon
        
        const matrix = mat4.create();
        
        // Field of view
        const fov = 0.6435011087932844; // ~36.87 degrees
        const cameraDistance = 1.0 / Math.tan(fov / 2);
        
        // Near/far planes - tighter ratio improves depth precision
        // This reduces z-fighting artifacts on pitched views
        const nearZ = cameraDistance * 0.1;
        const farZ = cameraDistance * 5;
        
        // === PROJECTION ===
        const proj = mat4.create();
        mat4.perspective(proj, fov, aspectRatio, nearZ, farZ);
        
        // === VIEW MATRIX using lookAt ===
        // Camera position: orbits around origin based on pitch
        // At pitch=0: directly above at (0, 0, distance)
        // At pitch=60: in front and above, looking back at origin
        
        // Camera position in world space (before bearing rotation)
        const camX = 0;
        const camY = cameraDistance * Math.sin(pitchRadians);
        const camZ = cameraDistance * Math.cos(pitchRadians);
        
        // Look at origin, with +Y being "up" on screen initially
        // But our world has +Z as up (buildings), so we need to handle this
        
        // The "up" vector for the camera
        // At pitch=0: up is +Y (north = up on screen)  
        // As pitch increases, up tilts toward -Z (so buildings appear to go up)
        const upX = 0;
        const upY = Math.cos(pitchRadians);
        const upZ = -Math.sin(pitchRadians);
        
        const view = mat4.create();
        mat4.lookAt(view, 
            [camX, camY, camZ],  // Camera position
            [0, 0, 0],            // Look at origin
            [upX, upY, upZ]       // Up vector
        );
        
        // Apply bearing rotation (rotate world before camera view)
        const bearingMat = mat4.create();
        mat4.rotateZ(bearingMat, bearingMat, bearingRadians);
        mat4.multiply(view, view, bearingMat);
        
        // Apply zoom (scale the world)
        mat4.scale(view, view, [effectiveZoom, effectiveZoom, effectiveZoom]);
        
        // Translate to world position
        mat4.translate(view, view, [-this.position[0], -this.position[1], 0]);
        
        // Combine: projection * view
        mat4.multiply(matrix, proj, view);
        
        return matrix;
    }

    getVisualZoom() {
        if (this._visualZoom !== undefined) {
            return this._visualZoom;
        }
        
        // Use the same calculation as in getMatrix for consistency
        if (this.zoom <= 6) {
            return this.zoom;
        } else if (this.zoom <= 20) {
            const linearComponent = this.zoom - 6;
            const logComponent = 2 * Math.log2(this.zoom / 6);
            return 6 + linearComponent * 0.8 + logComponent * 0.2;
        } else {
            const baseZoom = 6 + (20 - 6) * 0.8 + 2 * Math.log2(20 / 6) * 0.2;
            const linearComponent = (this.zoom - 20) * 0.6;
            const logComponent = 3 * Math.log2(this.zoom / 20) * 0.4;
            return baseZoom + linearComponent + logComponent;
        }
    }

    pan(dx, dy) {
        const effectiveZoom = Math.pow(2, this.zoom);
        // Add extra damping at high zoom levels to prevent excessive speed
        const zoomDamping = Math.min(1.0, 50 / effectiveZoom);
        const panSpeed = (this.velocityFactor / effectiveZoom) * zoomDamping;
        
        this.position[0] -= dx * panSpeed;
        this.position[1] += dy * panSpeed; 
        
        this.clampPosition();
        
        // Also set velocity for momentum
        this.velocity[0] = dx * panSpeed;
        this.velocity[1] = -dy * panSpeed;
        
        // Generate pan event for tile loading
        this.triggerEvent('pan', { dx, dy });
    }

    updatePosition() {
        const hadVelocity = Math.abs(this.velocity[0]) > 0.01 || Math.abs(this.velocity[1]) > 0.01;
        const posBefore = [...this.position];
        
        this.position[0] -= this.velocity[0];
        this.position[1] -= this.velocity[1];  // Keep negative since velocity is now negative
        this.velocity[0] *= this.friction;
        this.velocity[1] *= this.friction;
        this.clampPosition();
        if (Math.abs(this.velocity[0]) < 0.01) this.velocity[0] = 0;
        if (Math.abs(this.velocity[1]) < 0.01) this.velocity[1] = 0;
        
        // Debug if position changed
        if (hadVelocity && (this.position[0] !== posBefore[0] || this.position[1] !== posBefore[1])) {
            // console.log('⚡ updatePosition moved camera from', posBefore[0].toFixed(3), posBefore[1].toFixed(3), 
            //            'to', this.position[0].toFixed(3), this.position[1].toFixed(3),
            //            'velocity:', this.velocity[0].toFixed(3), this.velocity[1].toFixed(3));
        }
    }
    
    zoomIn(factor = null) {
        // console.log('🔍 ZOOM IN CALLED');
        const prevZoom = this.zoom;
        const zoomFactor = factor || this.zoomFactor;
        
        // HARD CLAMP: Never allow zoom beyond maxZoom
        if (this.zoom >= this.maxZoom) {
            //console.warn(`🚫 Already at max zoom ${this.maxZoom}`);
            return;
        }
        
        if (this.zoom < this.maxZoom) {
            // Get mouse position in clip space (-1 to 1)
            const mouseClipX = this.mouseScreenX * 2 - 1;
            const mouseClipY = this.mouseScreenY * 2 - 1;  // Screen Y already goes down, clip Y goes down too
            const aspectRatio = this.viewportWidth / this.viewportHeight;
            
            // Use standard 2^zoom
            const prevEffectiveZoom = Math.pow(2, prevZoom);
            
            // Calculate the point in world space that is under the mouse BEFORE zoom
            const worldX = this.position[0] + (mouseClipX * aspectRatio) / prevEffectiveZoom;
            const worldY = this.position[1] + mouseClipY / prevEffectiveZoom;
            
            // Apply zoom (increment zoom level by 1 for each zoom in)
            this.zoom = Math.min(this.maxZoom, prevZoom + 1);
            const nextEffectiveZoom = Math.pow(2, this.zoom);
            
            console.log(`📈 ZOOM IN: ${prevZoom.toFixed(2)} → ${this.zoom.toFixed(2)} (scale: ${prevEffectiveZoom.toFixed(1)} → ${nextEffectiveZoom.toFixed(1)})`);
            
            // Move camera so that worldX,worldY is still under the mouse AFTER zoom
            this.position[0] = worldX - (mouseClipX * aspectRatio) / nextEffectiveZoom;
            this.position[1] = worldY - mouseClipY / nextEffectiveZoom;
            
            const beforeClamp = [...this.position];
            this.clampPosition();
            
            // CRITICAL: Stop any velocity/momentum during zoom
            this.velocity[0] = 0;
            this.velocity[1] = 0;
            
            this.triggerEvent('zoom', { factor: zoomFactor });
            this.scheduleZoomEnd();
        }
    }

    zoomOut(factor = null) {
        const prevZoom = this.zoom;
        const zoomFactor = factor || this.zoomFactor;
        
        if (this.zoom > this.minZoom) {
            // Get mouse position in clip space (-1 to 1)
            const mouseClipX = this.mouseScreenX * 2 - 1;
            const mouseClipY = this.mouseScreenY * 2 - 1;  // Screen Y already goes down, clip Y goes down too
            const aspectRatio = this.viewportWidth / this.viewportHeight;
            
            // Use standard 2^zoom for consistency
            const prevEffectiveZoom = Math.pow(2, prevZoom);
            
            // Calculate the point in world space that is under the mouse BEFORE zoom
            const worldX = this.position[0] + (mouseClipX * aspectRatio) / prevEffectiveZoom;
            const worldY = this.position[1] + mouseClipY / prevEffectiveZoom;
            
            // Apply zoom (decrement zoom level by 1 for each zoom out)
            this.zoom = Math.max(this.minZoom, prevZoom - 1);
            const nextEffectiveZoom = Math.pow(2, this.zoom);
            
            // Move camera so that worldX,worldY is still under the mouse AFTER zoom
            this.position[0] = worldX - (mouseClipX * aspectRatio) / nextEffectiveZoom;
            this.position[1] = worldY - mouseClipY / nextEffectiveZoom;
            
            // CRITICAL: Stop any velocity/momentum during zoom
            this.velocity[0] = 0;
            this.velocity[1] = 0;
            
            this.clampPosition();
            this.triggerEvent('zoom', { factor: zoomFactor });
            this.scheduleZoomEnd();
        }
    }

    clampPosition() {
        // Define world bounds (these are in world coordinates, not screen)
        const worldBounds = {
            minX: -2,
            maxX: 2,
            minY: -2,
            maxY: 2
        };
        
        // Clamp camera position to stay within world bounds
        this.position[0] = Math.max(worldBounds.minX, Math.min(worldBounds.maxX, this.position[0]));
        this.position[1] = Math.max(worldBounds.minY, Math.min(worldBounds.maxY, this.position[1]));
    }

    scheduleZoomEnd() {
        if (this.zoomEndTimeout) {
            clearTimeout(this.zoomEndTimeout);
        }

        // Wait a bit longer for pan events to settle
        this.zoomEndTimeout = setTimeout(() => {
            // Get both zoom levels without excessive logging
            const displayZoom = Math.floor(this.zoom);
            const fetchZoom = Math.min(displayZoom, this.maxFetchZoom);
            
            this.triggerEvent('zoomend', { 
                displayZoom: displayZoom,
                fetchZoom: fetchZoom
            });
        }, 150); // 150ms delay
    }

    triggerEvent(eventName, detail) {
        const event = new CustomEvent(eventName, { detail });
        this.dispatchEvent(event);
    }

    getViewport() {
        // Calculate the viewport extents in world coordinates  
        const aspectRatio = this.viewportWidth / this.viewportHeight;
        
        // Use standard 2^zoom
        const effectiveZoom = Math.pow(2, this.zoom);
        
        // Viewport in world space
        const halfWidth = aspectRatio / effectiveZoom;
        const halfHeight = 1.0 / effectiveZoom;
        
        // Get raw viewport coordinates
        const rawViewport = {
            left: this.position[0] - halfWidth,
            right: this.position[0] + halfWidth,
            top: this.position[1] + halfHeight,
            bottom: this.position[1] - halfHeight,
            zoom: this.zoom,
            aspectRatio: this.viewportWidth / this.viewportHeight
        };
        
        // Clamp viewport to reasonable range
        const MAX_WORLD_RANGE = 10; // Limit how far the viewport can extend
        
        return {
            left: Math.max(-MAX_WORLD_RANGE, Math.min(MAX_WORLD_RANGE, rawViewport.left)),
            right: Math.max(-MAX_WORLD_RANGE, Math.min(MAX_WORLD_RANGE, rawViewport.right)),
            top: Math.max(-MAX_WORLD_RANGE, Math.min(MAX_WORLD_RANGE, rawViewport.top)),
            bottom: Math.max(-MAX_WORLD_RANGE, Math.min(MAX_WORLD_RANGE, rawViewport.bottom)),
            zoom: rawViewport.zoom,
            aspectRatio: rawViewport.aspectRatio
        };
    }

    getTileCoordinates(tileSize, zoom) {
        const scale = 2 ** zoom;
        const x = wrapTileCoordinate(Math.floor((this.position[0] * scale) / tileSize), scale);
        const y = wrapTileCoordinate(Math.floor((this.position[1] * scale) / tileSize), scale);
        return { x, y };
    }

    isTileVisible(tileX, tileY, tileSize) {
        const viewport = this.getViewport();
        const tileLeft = tileX * tileSize;
        const tileRight = tileLeft + tileSize;
        const tileTop = tileY * tileSize;
        const tileBottom = tileTop + tileSize;
        return (
            tileRight > viewport.left &&
            tileLeft < viewport.right &&
            tileBottom > viewport.top &&
            tileTop < viewport.bottom
        );
    }

    getVisibleTileRange(tileSize, zoom) {
        const scale = 1 << zoom; // 2^zoom
        
        // Get the viewport bounds
        const viewport = this.getViewport();
        
        // Convert viewport bounds to tile coordinates with proper Y-axis handling
        const viewMinX = Math.max(0, Math.floor((viewport.left + 1) / 2 * scale - 1));
        const viewMaxX = Math.min(scale - 1, Math.ceil((viewport.right + 1) / 2 * scale + 1));
        
        // Use consistent Y calculation with tile-utils.js
        const viewMinY = Math.max(0, Math.floor((1 - viewport.top) / 2 * scale - 1));
        const viewMaxY = Math.min(scale - 1, Math.ceil((1 - viewport.bottom) / 2 * scale + 1));
        
        return {
            minTileX: viewMinX,
            maxTileX: viewMaxX,
            minTileY: viewMinY,
            maxTileY: viewMaxY,
            zoom
        };
    }

    setPitch(pitchDegrees) {
        // Clamp pitch between 0 (top-down) and 60 degrees (maximum tilt)
        this.pitch = Math.max(0, Math.min(60, pitchDegrees));
        this._cachedMatrix = null; // Invalidate cache
        this.triggerEvent('pitch', { pitch: this.pitch });
    }

    adjustPitch(deltaDegrees) {
        this.setPitch(this.pitch + deltaDegrees);
    }

    setBearing(bearingDegrees) {
        // Normalize bearing to 0-360 range
        this.bearing = ((bearingDegrees % 360) + 360) % 360;
        this._cachedMatrix = null; // Invalidate cache
        this.triggerEvent('bearing', { bearing: this.bearing });
    }

    adjustBearing(deltaDegrees) {
        this.setBearing(this.bearing + deltaDegrees);
    }
}

function wrapTileCoordinate(coord, scale) {
    return ((coord % scale) + scale) % scale;
}
