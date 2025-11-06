import { mat4 } from 'gl-matrix';

export class Camera extends EventTarget {
    constructor(viewportWidth, viewportHeight) {
        super();
        this.position = [0, 0];
        this.trueZoom = 1;
        this.maxFetchZoom = 6;    // Maximum zoom level for fetching tiles
        this.maxZoom = 48;        // Increase from 24 to 48 for much higher zoom capability
        this.minZoom = 1;
        this.zoom = 1;
        this.zoomFactor = 1.25;   // INCREASED from 1.1 to 1.25 for faster zooming
        this.viewportWidth = viewportWidth;
        this.viewportHeight = viewportHeight;
        this.velocity = [0, 0];
        this.friction = 1.0;
        this.velocityFactor = 0.5;
        this.zoomSpeed = 0.1;
        this.zoomEndTimeout = null;
        this.zoomEndDelay = 250;
        this.mouseX = 0;
        this.mouseY = 0;
        this._cachedMatrix = null;
        this._lastState = { pos: [...this.position], zoom: this.zoom };
        this.mouseWorldPosition = [0, 0]; // Track mouse position in world coordinates
        this.lastZoomDisplay = -1; // Track the last displayed zoom for debugging

        // Add a debug variable to track what's happening with zoom levels
        this._zoomDebug = {
            raw: 0,
            visual: 0,
            lastUpdate: Date.now()
        };

        document.addEventListener('mousemove', (event) => this.updateMousePosition(event));
    }

    updateMousePosition(event) {
        const rect = event.target.getBoundingClientRect();
        const mouseClipX = ((event.clientX - rect.left) / rect.width) * 2 - 1; // Convert to clip space
        const mouseClipY = 1 - ((event.clientY - rect.top) / rect.height) * 2; // Convert to clip space (flip Y)

        // Convert mouse clip space position to world coordinates
        const aspectRatio = this.viewportWidth / this.viewportHeight;
        this.mouseWorldPosition[0] = this.position[0] + (mouseClipX / this.zoom) * aspectRatio;
        this.mouseWorldPosition[1] = this.position[1] + (mouseClipY / this.zoom);
    }

    getMatrix() {
        // Only recompute if position or zoom changed
        if (
            this._cachedMatrix &&
            this._lastState.pos[0] === this.position[0] &&
            this._lastState.pos[1] === this.position[1] &&
            this._lastState.zoom === this.zoom
        ) {
            return this._cachedMatrix;
        }

        // Store current zoom for debugging
        this._zoomDebug.raw = this.zoom;
        
        // CRITICAL FIX: Use completely linear scaling with NO logarithmic compression
        const aspectRatio = this.viewportWidth / this.viewportHeight;
        const matrix = mat4.create();
        
        // Translate by negative camera position (centering)
        mat4.translate(matrix, matrix, [-this.position[0], -this.position[1], 0]);
        
        // FIXED: Use direct linear zoom with no compression at all
        // This ensures that both features and textures scale at the same rate
        const effectiveZoom = this.zoom;
        
        // Store the visual zoom for UI display
        this._visualZoom = effectiveZoom;
        this._zoomDebug.visual = effectiveZoom;
        
        // Debug zoom state if it changed significantly
        if (Math.abs(this.zoom - this.lastZoomDisplay) > 0.5) {
            console.log(`ZOOM DEBUG - Raw: ${this.zoom.toFixed(2)}, Visual: ${effectiveZoom.toFixed(2)}, Ratio: 1.0`);
            this.lastZoomDisplay = this.zoom;
        }
        
        // Apply the zoom scale directly
        mat4.scale(matrix, matrix, [effectiveZoom / aspectRatio, effectiveZoom, 1]);
        
        this._cachedMatrix = matrix;
        this._lastState = { pos: [...this.position], zoom: this.zoom };
        
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
        // MODIFIED: Reduce panning speed at higher zoom levels
        // Apply a reducing factor that scales inversely with zoom
        
        // Start with base velocity factor
        let panSpeed = this.velocityFactor;
        
        // Apply speed reduction based on zoom level
        if (this.zoom > 4) {
            // Progressively reduce speed at higher zoom levels
            // At zoom 4+, start reducing speed, at zoom 10+ reduce to 1/3
            const reductionFactor = 1.0 / Math.max(1, this.zoom / 4);
            panSpeed *= Math.min(1.0, Math.max(0.33, reductionFactor * 1.5));
        }
        
        // Apply the pan with the new speed calculation
        this.position[0] -= dx * panSpeed;
        this.position[1] += dy * panSpeed; 
        
        this.clampPosition();
        
        // Also reduce momentum/velocity at higher zoom levels
        this.velocity[0] = dx * panSpeed;
        this.velocity[1] = -dy * panSpeed;
        
        // Generate pan event for tile loading
        this.triggerEvent('pan', { dx, dy });
    }

    updatePosition() {
        this.position[0] -= this.velocity[0];
        this.position[1] -= this.velocity[1];  // Keep negative since velocity is now negative
        this.velocity[0] *= this.friction;
        this.velocity[1] *= this.friction;
        this.clampPosition();
        if (Math.abs(this.velocity[0]) < 0.01) this.velocity[0] = 0;
        if (Math.abs(this.velocity[1]) < 0.01) this.velocity[1] = 0;
    }
    
    zoomIn(factor = null) {
        const prevZoom = this.zoom;
        
        // FIXED: Use a more aggressive zoom factor and remove the adjustment that slows at high zoom
        const zoomFactor = factor || this.zoomFactor;
        
        // NEW: Calculate next zoom with checks to prevent getting stuck at the limit
        const nextZoom = prevZoom * zoomFactor;
        
        // Apply zoom with safeguards to prevent sticking at limit
        if (nextZoom > this.maxZoom * 0.99) {
            // If we're very close to max, set to exactly max to prevent floating point issues
            this.zoom = this.maxZoom;
        } else {
            this.zoom = Math.min(this.maxZoom, nextZoom);
        }
        
        // CRITICAL: Log every zoom step
        console.log(`ZOOM: ${prevZoom.toFixed(2)} → ${this.zoom.toFixed(2)}`);

        if (this.zoom !== prevZoom) {
            // NEW: Add enhanced logging to track zoom behavior
            console.log(
                `ZOOM IN: ${prevZoom.toFixed(2)} → ${this.zoom.toFixed(2)} ` +
                `[factor: ${zoomFactor.toFixed(2)}, max: ${this.maxZoom}]`
            );
        
            // Adjust position to zoom toward the mouse pointer
            const aspectRatio = this.viewportWidth / this.viewportHeight;
            const dx = (this.mouseWorldPosition[0] - this.position[0]) * (1 - prevZoom / this.zoom);
            const dy = (this.mouseWorldPosition[1] - this.position[1]) * (1 - prevZoom / this.zoom);
            this.position[0] += dx;
            this.position[1] += dy;
            this.clampPosition();
            this.triggerEvent('zoom', { factor: zoomFactor });

            // Always trigger zoomend on any zoom change
            this.scheduleZoomEnd();
        } else if (this.zoom >= this.maxZoom) {
            // Add a clear message when at max zoom
            console.log(`AT MAX ZOOM: ${this.zoom.toFixed(2)} (limit: ${this.maxZoom})`);
        }
    }

    zoomOut(factor = null) {
        const prevZoom = this.zoom;
        
        // FIXED: Use a more aggressive zoom factor
        const zoomFactor = factor || this.zoomFactor;
        
        this.zoom = Math.max(this.minZoom, this.zoom / zoomFactor);
        
        // CRITICAL: Log every zoom step
        console.log(`ZOOM OUT: ${prevZoom.toFixed(2)} → ${this.zoom.toFixed(2)}`);

        if (this.zoom !== prevZoom) {
            // Adjust position to zoom toward the mouse pointer
            const aspectRatio = this.viewportWidth / this.viewportHeight;
            const dx = (this.mouseWorldPosition[0] - this.position[0]) * (1 - prevZoom / this.zoom);
            const dy = (this.mouseWorldPosition[1] - this.position[1]) * (1 - prevZoom / this.zoom);
            this.position[0] += dx;
            this.position[1] += dy;
            this.clampPosition();
            this.triggerEvent('zoom', { factor: zoomFactor });

            // Always trigger zoomend on any zoom change
            this.scheduleZoomEnd(this.zoom);
        }
    }

    clampPosition() {
        const halfViewportWidth = this.viewportWidth / (2 * this.zoom);
        const halfViewportHeight = this.viewportHeight / (2 * this.zoom);
        const worldScale = 1000;
        const worldBounds = {
            minX: -1 * worldScale,
            maxX: 1 * worldScale,
            minY: -1 * worldScale,
            maxY: 1 * worldScale
        };
        const minX = worldBounds.minX / halfViewportWidth;
        const maxX = worldBounds.maxX / halfViewportWidth;
        const minY = worldBounds.minY / halfViewportHeight;
        const maxY = worldBounds.maxY / halfViewportHeight;
        this.position[0] = Math.max(minX, Math.min(maxX, this.position[0]));
        this.position[1] = Math.max(minY, Math.min(maxY, this.position[1]));
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
        const halfWidth = this.viewportWidth / 2 / this.zoom;
        const halfHeight = this.viewportHeight / 2 / this.zoom;
        
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
}

function wrapTileCoordinate(coord, scale) {
    return ((coord % scale) + scale) % scale;
}