import { clipSpaceToTile } from './utils.js';

export const MAX_SERVER_ZOOM = 6; // Maximum zoom level supported by server

// Module-level variables for tracking state changes
let lastLoggedZoomDelta = -1;
let lastLoggedTileCount = -1;

// Add a function to detect when we're overzooming
export function isOverzoomed(camera) {
    return camera.zoom > camera.maxFetchZoom;
}

// Enhance getVisibleTiles to handle extreme overzooming
export function getVisibleTiles(camera, fetchZoom) {
    // Remove redundant logging, only log significant changes
    const displayZoom = camera.zoom;
    const zoomDelta = Math.max(0, displayZoom - fetchZoom);
    
    // Only log zoom deltas on significant changes
    if (Math.floor(lastLoggedZoomDelta) !== Math.floor(zoomDelta) && zoomDelta > 0) {
        console.log(`Overzooming by ${zoomDelta.toFixed(1)} levels`);
        lastLoggedZoomDelta = zoomDelta;
    }

    // Add extra padding when overzoomed
    const basePadding = 5;
    const overzoomPadding = zoomDelta > 0 ? 
        Math.min(20, basePadding + Math.floor(zoomDelta * 1.5)) : 
        basePadding;
    
    // Get the viewport bounds
    const viewport = camera.getViewport();
    const scale = 1 << fetchZoom; // 2^zoom
    
    // Add even more padding when overzoomed to ensure we have enough coverage
    const paddingFactor = 0.5 + (zoomDelta * 0.1);
    const paddedViewport = {
        left: viewport.left - paddingFactor, 
        right: viewport.right + paddingFactor,
        top: viewport.top + paddingFactor,
        bottom: viewport.bottom - paddingFactor
    };
    
    // Convert viewport corners to tile coordinates with extra padding
    const topLeftTile = worldToTile(paddedViewport.left, paddedViewport.top, fetchZoom);
    const bottomRightTile = worldToTile(paddedViewport.right, paddedViewport.bottom, fetchZoom);
    
    // IMPROVED: Much larger padding for tiles to prevent truncation
    const padding = overzoomPadding; // Use overzoom padding
    
    // Calculate Y bounds first
    const minTileY = Math.max(0, Math.floor(Math.min(topLeftTile[1], bottomRightTile[1])) - padding);
    const maxTileY = Math.min(scale - 1, Math.ceil(Math.max(topLeftTile[1], bottomRightTile[1])) + padding);
    
    // Calculate X bounds with wrapping consideration
    let minTileX = Math.floor(Math.min(topLeftTile[0], bottomRightTile[0])) - padding;
    let maxTileX = Math.ceil(Math.max(topLeftTile[0], bottomRightTile[0])) + padding;
    
    // Create arrays to hold tiles before and after wrapping is applied
    const allTiles = [];
    let wrappedTiles = [];
    
    // Handle wrapping for X coordinates
    if (minTileX < 0) {
        wrappedTiles = wrappedTiles.concat(
            createWrappedTiles(scale + minTileX, scale - 1, fetchZoom, minTileY, maxTileY)
        );
        minTileX = 0;
    }
    
    if (maxTileX >= scale) {
        wrappedTiles = wrappedTiles.concat(
            createWrappedTiles(0, maxTileX - scale, fetchZoom, minTileY, maxTileY)
        );
        maxTileX = scale - 1;
    }
    
    // Generate standard tiles in the range
    for (let y = minTileY; y <= maxTileY; y++) {
        for (let x = minTileX; x <= maxTileX; x++) {
            allTiles.push({x, y, z: fetchZoom});
        }
    }
    
    // Add wrapped tiles
    allTiles.push(...wrappedTiles);
    
    // Reduce logging to only show on significant changes
    const tileCount = allTiles.length;
    if (Math.abs(lastLoggedTileCount - tileCount) > 20) {
        console.log(`Tiles: ${tileCount} at zoom ${fetchZoom}`);
        lastLoggedTileCount = tileCount;
    }
    
    // Safety limit for huge viewports
    const MAX_TILES = 200; // Increased from 150 to 200 for better coverage
    if (tileCount > MAX_TILES) {
        console.warn(`Limiting tiles to ${MAX_TILES} (was ${tileCount})`);
        
        // Get center tile coordinates
        const centerTileX = Math.floor((minTileX + maxTileX) / 2);
        const centerTileY = Math.floor((minTileY + maxTileY) / 2);
        
        // Sort tiles by priority with proper wrapping handling
        allTiles.forEach(tile => {
            // Calculate proper X distance accounting for wrapping
            let dx = Math.abs(tile.x - centerTileX);
            if (dx > scale / 2) {
                dx = scale - dx; // Handle wrapping distance
            }
            
            // Calculate distance with more importance on Y (vertical) axis
            // This ensures tall features like Africa aren't truncated
            const dy = Math.abs(tile.y - centerTileY);
            tile.distance = Math.sqrt(dx * dx + dy * dy * 1.5); // Weight Y higher
            
            // Prioritize standard zoom level tiles
            if (tile.z !== fetchZoom) {
                tile.distance += 100; // Lower priority for non-standard zoom tiles
            }
        });
        
        // Sort by distance
        allTiles.sort((a, b) => a.distance - b.distance);
        return allTiles.slice(0, MAX_TILES);
    }
    
    return allTiles;
}

// Helper function to create wrapped tiles
function createWrappedTiles(minX, maxX, zoom, minTileY, maxTileY) {
    const wrappedTiles = [];
    
    for (let y = minTileY; y <= maxTileY; y++) {
        for (let x = minX; x <= maxX; x++) {
            wrappedTiles.push({x, y, z: zoom});
        }
    }
    
    return wrappedTiles;
}

// IMPROVED: Better worldToTile function to handle edge cases
function worldToTile(worldX, worldY, zoom) {
    // Normalize coordinates to ensure proper wrapping
    // This is critical for handling edge cases at the poles and date line
    
    // Handle world wrapping (multiple world copies)
    // For longitude/X: Wrap to [-180, 180] then convert
    let lon = ((worldX * 180) % 360 + 540) % 360 - 180;
    
    // For latitude/Y: Clamp to safe range to avoid singularities
    // Moving from 0.97 to 0.92 gives us much better pole coverage
    let lat;
    if (worldY >= 0.92) { // More aggressive threshold for better pole handling
        lat = -75; // Less extreme cutoff for southern regions
    } else if (worldY <= -0.92) {
        lat = 75;  // Less extreme cutoff for northern regions
    } else {
        const latRadian = Math.atan(Math.sinh(Math.PI * -worldY));
        lat = latRadian * 180 / Math.PI;
        
        // Add extra safety clamping
        if (lat < -85) lat = -85;
        if (lat > 85) lat = 85;
    }
    
    // Standard Web Mercator formula
    const scale = 1 << zoom;
    const tileX = ((lon + 180) / 360) * scale;
    const tileY = ((1 - Math.log(Math.tan((lat * Math.PI / 180) / 2 + Math.PI/4)) / Math.PI) / 2) * scale;
    
    return [tileX, tileY];
}

// Keep the debug helper function
export function debugTileCoordinates(camera) {
    const viewport = camera.getViewport();
    const zoom = Math.floor(camera.zoom);
    
    // Calculate tile coordinates for each corner
    const topLeft = clipSpaceToTile(viewport.left, viewport.top, zoom);
    const topRight = clipSpaceToTile(viewport.right, viewport.top, zoom);
    const bottomLeft = clipSpaceToTile(viewport.left, viewport.bottom, zoom);
    const bottomRight = clipSpaceToTile(viewport.right, viewport.bottom, zoom);
    
    return {
        zoom,
        corners: {
            topLeft,
            topRight,
            bottomLeft,
            bottomRight
        },
        tiles: getVisibleTiles(camera, zoom)
    };
}