import { hexToRgb, mercatorToClipSpace } from './utils.js';
import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import earcut from 'earcut';
import { getColorOfCountries } from './utils.js';
import { TileCache } from './tileCache.js'; // Import the TileCache class

// Ensure tileCache is declared before use
const problemTiles = new Set(["4/12/15"]);

// Update these constants for optimal memory usage
const MAX_CACHE_SIZE_MB = 100; // Reduced from 200MB to 100MB
const MAX_TILES_PER_ZOOM = 50; // Reduced from 100 to 50
let CACHE_TILE_DATA = true;   // Force this to true to always store raw PBF data

const tileCache = new TileCache(); // Use the imported TileCache class

export function parseGeoJSONFeature(feature, fillColor = [0.0, 0.0, 0.0, 1.0]) {
    const fillVertices = [];
    const hiddenVertices = [];
    const fillIndices = [];
    const outlineIndices = [];
    const hiddenfillIndices = [];
    let isFilled = true;
    let isLine = true;

    // Get proper country color from properties
    const countryCode = feature?.properties?.ADM0_A3 || feature?.properties?.ISO_A3;
    const _fillColor = getColorOfCountries(countryCode, [0.7, 0.7, 0.7, 1.0]);
    const _borderColor = [0.0, 0.0, 0.0, 1.0];

    // Use a nonzero default if fid is missing.
    const getFeatureId = (id) => {
        const rawId = parseInt(id) || 1;
        const hashedId = ((rawId % 253) + 1); // Ensures range 1-254
        // if (feature.properties?.ADM0_A3) {
        //     console.log('Feature ID for', feature.properties.ADM0_A3, ':', {
        //         rawId,
        //         hashedId,
        //         fid: feature.properties.fid
        //     });
        // }
        return rawId; // Use raw ID instead of hashed to maintain direct mapping
    };

    // Create two separate vertex arrays for visible and hidden rendering
    const coordsToVertices = (coords, color, targetArray) => {
        const vertexStartIndex = targetArray.length / 6;
        coords.forEach(coord => {
            const [x, y] = mercatorToClipSpace(coord);
            targetArray.push(
                x, y,     // Position
                ...color  // Color
            );
        });
        return vertexStartIndex;
    };

    // Modify this function to ensure feature IDs are correctly stored in vertices
    const coordsToIdVertices = (coords, featureId, targetArray) => {
        const vertexStartIndex = targetArray.length / 6;
        
        // Ensure feature ID is non-zero and normalized to 0-1 range
        const safeId = Math.max(1, Math.min(254, featureId || 1));
        const normalizedId = safeId / 255.0;
        
        coords.forEach(coord => {
            const [x, y] = mercatorToClipSpace(coord);
            targetArray.push(
                x, y,             // Position
                normalizedId, 0.0, 0.0, 1.0  // ID in red, no polygon ID
            );
        });
        return vertexStartIndex;
    };

    // Deduplicate features by tracking processed feature IDs
    const processedFeatures = new Set();

    const featureId = feature.properties?.fid;
    if (processedFeatures.has(featureId)) {
        console.warn(`Feature with ID ${featureId} is already processed, skipping duplicate.`);
        return null;
    }
    processedFeatures.add(featureId);

    switch (feature.geometry.type) {
        case 'Polygon':
            // Combine all rings into a single array with holes
            const coordinates = feature.geometry.coordinates;
            const outerRing = coordinates[0];
            const holes = coordinates.slice(1);
            
            // Flatten coordinates for triangulation
            const flatCoords = [];
            const holeIndices = [];
            
            // Add outer ring
            outerRing.forEach(coord => {
                flatCoords.push(coord[0], coord[1]);
            });
            
            // Add holes and store their starting indices
            holes.forEach(hole => {
                holeIndices.push(flatCoords.length / 2);
                hole.forEach(coord => {
                    flatCoords.push(coord[0], coord[1]);
                });
            });

            // Triangulate with holes
            const triangles = earcut(flatCoords, holeIndices);

            // Add vertices for the entire polygon
            const allCoords = coordinates.flat(1);
            const fillStartIndex = coordsToVertices(allCoords, _fillColor, fillVertices);
            const hiddenStartIndex = coordsToIdVertices(allCoords, 
                getFeatureId(feature.properties.fid),
                hiddenVertices
            );

            // Add triangle indices
            triangles.forEach(index => {
                fillIndices.push(fillStartIndex + index);
                hiddenfillIndices.push(hiddenStartIndex + index);
            });
            break;

        case 'MultiPolygon':
            // Process each polygon's outer ring and holes
            feature.geometry.coordinates.forEach((polygon, polygonIndex) => {
                const outerRing = polygon[0];
                const holes = polygon.slice(1);
                
                // Flatten coordinates for triangulation
                const flatCoords = [];
                const holeIndices = [];
                
                // Add outer ring
                outerRing.forEach(coord => {
                    flatCoords.push(coord[0], coord[1]);
                });
                
                // Add holes and store their starting indices
                holes.forEach(hole => {
                    holeIndices.push(flatCoords.length / 2);
                    hole.forEach(coord => {
                        flatCoords.push(coord[0], coord[1]);
                    });
                });

                // Triangulate with holes
                const triangles = earcut(flatCoords, holeIndices);

                // Add vertices for this polygon part
                const allCoords = polygon.flat(1);
                const fillStartIndex = coordsToVertices(allCoords, _fillColor, fillVertices);
                const hiddenStartIndex = coordsToIdVertices(allCoords, 
                    getFeatureId(feature.properties.fid),
                    hiddenVertices
                );

                // Add triangle indices
                triangles.forEach(index => {
                    fillIndices.push(fillStartIndex + index);
                    hiddenfillIndices.push(hiddenStartIndex + index);
                });
            });
            break;
        case 'LineString':
            isFilled = false;
            isLine = true;
            const lineStartIndex = coordsToVertices(feature.geometry.coordinates, _borderColor, fillVertices);
            for (let i = 0; i < feature.geometry.coordinates.length - 1; i++) {
                outlineIndices.push(lineStartIndex + i, lineStartIndex + i + 1);
            }
            break;
        case 'MultiLineString':
            isFilled = false;
            isLine = true;
            feature.geometry.coordinates.forEach(line => {
                const lineStartIndex = coordsToVertices(line, _borderColor, fillVertices);
                for (let i = 0; i < line.length - 1; i++) {
                    outlineIndices.push(lineStartIndex + i, lineStartIndex + i + 1);
                }
            });
            break;
        case 'Point':
            const point = mercatorToClipSpace(feature.geometry.coordinates);
            fillVertices.push(point[0], point[1], ..._fillColor);
            break;
        default:
            console.warn(`Unsupported GeoJSON type: ${feature.geometry.type}`);
    }

    return {
        vertices: new Float32Array(fillVertices),
        hiddenVertices: new Float32Array(hiddenVertices),  // Return hidden vertices
        fillIndices: new Uint16Array(fillIndices),
        outlineIndices: new Uint16Array(outlineIndices),
        hiddenfillIndices: new Uint16Array(hiddenfillIndices),
        isFilled,
        isLine,
        properties: feature.properties  // Include properties here
    };
}

// Improve memory management by cleaning up old tiles
export function clearOldTileCache(activeZoom, maxSize = 100) {
    // Find all keys in the cache
    const allKeys = [...tileCache.keys()];
    
    // Filter for keys that are not at the active zoom level
    const oldZoomKeys = allKeys.filter(key => {
        const [z] = key.split('/');
        return parseInt(z) !== activeZoom;
    });
    
    // Keep the most recently accessed keys for the current zoom
    const currentZoomKeys = allKeys.filter(key => {
        const [z] = key.split('/');
        return parseInt(z) === activeZoom;
    });
    
    if (currentZoomKeys.length > maxSize) {
        // If we have too many at the current zoom, remove older ones
        const keysToRemove = currentZoomKeys.slice(0, currentZoomKeys.length - maxSize);
        keysToRemove.forEach(key => tileCache.delete(key));
    }
    
    // Remove all tiles from other zoom levels
    console.log(`Clearing ${oldZoomKeys.length} tiles from non-active zoom levels`);
    oldZoomKeys.forEach(key => tileCache.delete(key));
}

// Keep track of successful and failed tiles
//const tileCache = new Map();

// Add at top of file if needed
const activeFetchingTiles = new Set();
const tileErrors = new Map(); // Track failed tiles to avoid repeated fetches
const notFoundTiles = new Set(); // Keep track of tiles that failed with 404 to avoid repeating requests

// Completely rewritten for much higher reliability
export async function fetchVectorTile(x, y, z) {
    // Validate tile coordinates
    const scale = 1 << z;
    if (x < 0 || x >= scale || y < 0 || y >= scale) {
        console.warn(`Skipping invalid tile coordinates: ${z}/${x}/${y}`);
        return null;
    }
    
    // Ensure valid zoom level
    if (z < 0 || z > 6) {
        console.warn(`Skipping invalid zoom level: ${z}`);
        return null;
    }
    
    const tileKey = `${z}/${x}/${y}`;
    
    // Don't retry tiles we know don't exist
    if (notFoundTiles.has(tileKey)) {
        return null;
    }
    
    // Check if already failed multiple times
    if (tileErrors.has(tileKey) && tileErrors.get(tileKey) >= 3) {
        return null; // Skip after 3 failures
    }

    // Check if already fetching
    if (activeFetchingTiles.has(tileKey)) {
        // For higher zoom levels, don't wait to avoid UI blocking
        if (z >= 5) return null;
        
        // For lower zoom levels, wait a bit
        try {
            return await Promise.race([
                new Promise(resolve => {
                    setTimeout(() => {
                        resolve(null); // Timeout after 2 seconds
                    }, 2000);
                }),
                new Promise(resolve => {
                    const interval = setInterval(() => {
                        if (!activeFetchingTiles.has(tileKey)) {
                            clearInterval(interval);
                            resolve(tileCache.get(tileKey));
                        }
                    }, 100);
                })
            ]);
        } catch (e) {
            console.warn(`Error waiting for tile ${tileKey}:`, e);
            return null;
        }
    }
    
    // Mark as being fetched
    activeFetchingTiles.add(tileKey);
    
    // Check cache
    const cachedTile = tileCache.get(tileKey);
    if (cachedTile) {
        activeFetchingTiles.delete(tileKey);
        return cachedTile;
    }
    
    // Fetch with a timeout for higher reliability
    const fetchWithTimeout = async (url, options, timeout = 5000) => {
        return Promise.race([
            fetch(url, options),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Fetch timeout')), timeout)
            )
        ]);
    };
    
    try {
        // For zoom level 6, add special handling
        let url = `https://demotiles.maplibre.org/tiles/${z}/${x}/${y}.pbf`;
        
        // Show what we're fetching in console
        console.log(`Fetching tile: ${tileKey}`);
        
        const response = await fetchWithTimeout(url, {
            method: 'GET',
            cache: 'force-cache', // Use browser cache aggressively
            headers: { 'Accept': 'application/x-protobuf' }
        }, z >= 5 ? 3000 : 5000); // Shorter timeout for high zoom

        if (!response.ok) {
            // If we get a 404, mark as permanently not found
            if (response.status === 404) {
                console.log(`Tile not found (404): ${tileKey}`);
                notFoundTiles.add(tileKey);
                return null;
            }
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength === 0) {
            throw new Error("Empty tile data");
        }
        
        const pbf = new Pbf(arrayBuffer);
        const tile = new VectorTile(pbf);
        
        // Only cache valid tiles
        if (tile && tile.layers && Object.keys(tile.layers).length > 0) {
            tileCache.set(tileKey, tile);
            console.log(`Successfully fetched tile: ${tileKey}`);
            activeFetchingTiles.delete(tileKey);
            
            // Clear error count on success
            if (tileErrors.has(tileKey)) {
                tileErrors.delete(tileKey);
            }
            
            return tile;
        } else {
            throw new Error("Tile has no layers");
        }
    } catch (err) {
        console.warn(`Error fetching tile ${tileKey}:`, err.message);
        
        // If it's a 404, mark as permanently not found
        if (err.message.includes('404')) {
            notFoundTiles.add(tileKey);
        }
        
        // Increment error count
        const errorCount = (tileErrors.get(tileKey) || 0) + 1;
        tileErrors.set(tileKey, errorCount);
        
        // Store null in cache to prevent repeated failures
        tileCache.set(tileKey, null);
        activeFetchingTiles.delete(tileKey);
        return null;
    }
}

// Helper function to clear error tracking
export function resetTileErrors() {
    tileErrors.clear();
    activeFetchingTiles.clear();
}

// Add a tracking set for in-progress high-zoom tiles
//const activeFetchingTiles = new Set();

// Utilities for diagnostics and cache management
export function getTileCacheStats() {
    return tileCache.getStats();
}

// Helper function to clear tile cache
export function clearTileCache() {
    tileCache.clear();
    console.log("Tile cache cleared");
}

// Add a helper function to reset the system
export function resetTileFetchingSystem() {
    tileCache.clear();
    problemTiles.clear();
    console.log("Tile fetching system reset");
}

// Increase cache size to avoid frequent refetching

// Clear cache when it gets too large
export function maintainTileCache(maxSize = 100) {
    if (tileCache.size > maxSize) {
        console.log(`Pruning tile cache from ${tileCache.size} to ${Math.floor(maxSize/2)}`);
        const keysToDelete = [...tileCache.keys()].slice(0, tileCache.size - Math.floor(maxSize/2));
        keysToDelete.forEach(key => tileCache.delete(key));
    }
}

// Add an exported function to control caching strategy
export function setCachingStrategy(cacheRawData = true)  {
    CACHE_TILE_DATA = cacheRawData;
    console.log(`Tile caching strategy: ${CACHE_TILE_DATA ? 'Raw PBF data' : 'Processed Vector Tiles'}`);console.log(`Tile caching strategy: ${CACHE_TILE_DATA ? 'Raw PBF data' : 'Processed Vector Tiles'}`);
}

// Add this function to reset the not-found cache
export function resetNotFoundTiles() {
    const count = notFoundTiles.size;
    notFoundTiles.clear();
    console.log(`Reset ${count} not-found tiles`);
}