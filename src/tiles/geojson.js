import { hexToRgb, mercatorToClipSpace } from '../core/utils.js';
import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import earcut from 'earcut';
import { getColorOfCountries } from '../core/utils.js';
import { TileCache } from './tileCache.js';
import { 
    getStyle, 
    getFeatureId as getStyleFeatureId, 
    getPaintProperty, 
    parseColor,
    evaluateFilter,
    getLayersBySource,
    isTileInBounds
} from '../core/style.js';

// Ensure tileCache is declared before use
const problemTiles = new Set(["4/12/15"]);

// Update these constants for optimal memory usage
const MAX_CACHE_SIZE_MB = 100; // Reduced from 200MB to 100MB
const MAX_TILES_PER_ZOOM = 50; // Reduced from 100 to 50
let CACHE_TILE_DATA = true;   // Force this to true to always store raw PBF data

const tileCache = new TileCache(); // Use the imported TileCache class

// Create deterministic ID from country name (no collision resolution - let GPU handle duplicates)
function getCountryId(countryName) {
    let hash = 0;
    for (let i = 0; i < countryName.length; i++) {
        hash = ((hash << 5) - hash) + countryName.charCodeAt(i);
        hash = hash & hash;
    }
    // Map to 1-9973 range (prime number for better distribution, under 10000 MAX_FEATURES)
    return ((Math.abs(hash) % 9973) + 1);
}

export function parseGeoJSONFeature(feature, fillColor = [0.0, 0.0, 0.0, 1.0], sourceId = null, zoom = 0) {
    const fillVertices = [];
    const hiddenVertices = [];
    const fillIndices = [];
    const outlineIndices = [];
    const hiddenfillIndices = [];
    let isFilled = true;
    let isLine = true;

    // Get style configuration
    const style = getStyle();
    let _fillColor = fillColor;
    let _borderColor = [0.0, 0.0, 0.0, 1.0];

    if (style && sourceId) {
        // Get layers for this source
        const layers = getLayersBySource(sourceId);
        // Find first VISIBLE fill layer for this source-layer
        const fillLayer = layers.find(l => 
            l.type === 'fill' && 
            (!l['source-layer'] || l['source-layer'] === feature.layer?.name) &&
            l.layout?.visibility !== 'none'
        );
        const lineLayer = layers.find(l => 
            l.type === 'line' && 
            (!l['source-layer'] || l['source-layer'] === feature.layer?.name) &&
            l.layout?.visibility !== 'none'
        );

        // If no visible fill layer found, skip this feature
        if (!fillLayer) {
            return null;
        }

        // Apply filter if layer has one
        if (fillLayer && fillLayer.filter && !evaluateFilter(fillLayer.filter, feature, zoom)) {
            return null; // Feature filtered out
        }

        // Get paint properties from style
        if (fillLayer) {
            const fillColorValue = getPaintProperty(fillLayer.id, 'fill-color', feature, zoom);
            if (fillColorValue) {
                _fillColor = parseColor(fillColorValue);
            }
        }

        if (lineLayer) {
            const lineColorValue = getPaintProperty(lineLayer.id, 'line-color', feature, zoom);
            if (lineColorValue) {
                _borderColor = parseColor(lineColorValue);
            }
        }
    } else {
        // Fallback to legacy hardcoded colors
        const countryCode = feature?.properties?.ADM0_A3 || feature?.properties?.ISO_A3;
        _fillColor = getColorOfCountries(countryCode, [0.7, 0.7, 0.7, 1.0]);
    }

    // Get feature ID using style configuration or fallback
    const getFeatureId = () => {
        // For country features, ALWAYS use our deterministic hash (ignore style system)
        const countryName = feature.properties?.NAME || feature.properties?.ADM0_A3 || feature.properties?.ISO_A3;
        
        if (countryName) {
            // Use hash-based ID for ANY feature with a country name
            const hashedId = getCountryId(countryName);
            return hashedId;
        }
        
        // For other features, use style-based ID or fallback
        if (style && sourceId) {
            return getStyleFeatureId(feature, sourceId);
        }
        // Legacy fallback
        const rawId = parseInt(feature.properties?.fid || feature.id) || 1;
        return rawId;
    };

    // Create two separate vertex arrays for visible and hidden rendering
    const coordsToVertices = (coords, color, targetArray) => {
        const vertexStartIndex = targetArray.length / 7;
        coords.forEach(coord => {
            const [x, y] = mercatorToClipSpace(coord);
            targetArray.push(
                x, y, 0.0, // Position (z=0 for flat map)
                ...color   // Color
            );
        });
        return vertexStartIndex;
    };

    // Modify this function to ensure feature IDs are correctly stored in vertices
    const coordsToIdVertices = (coords, featureId, targetArray) => {
        const vertexStartIndex = targetArray.length / 7;
        
        // Encode feature ID as 16-bit across red and green channels
        // R = high byte (bits 8-15), G = low byte (bits 0-7)
        const safeId = Math.max(1, Math.min(65534, featureId || 1)); // 16-bit range (avoid 0 and 65535)
        const highByte = Math.floor(safeId / 256); // Red channel
        const lowByte = safeId % 256;              // Green channel
        const normalizedR = highByte / 255.0;
        const normalizedG = lowByte / 255.0;
        
        coords.forEach(coord => {
            const [x, y] = mercatorToClipSpace(coord);
            targetArray.push(
                x, y, 0.0,        // Position (z=0 for flat map)
                normalizedR, normalizedG, 0.0, 1.0  // 16-bit ID in R+G channels
            );
        });
        return vertexStartIndex;
    };

    // Deduplicate features by tracking processed feature IDs
    const processedFeatures = new Set();

    const featureId = getFeatureId();
    
    // Clamp feature ID to valid range for rendering (1-9999)
    const clampedFeatureId = Math.max(1, Math.min(9999, featureId));
    
    if (processedFeatures.has(featureId)) {
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
                clampedFeatureId,  // Use clamped ID to match properties
                hiddenVertices
            );

            // Add triangle indices
            triangles.forEach(index => {
                fillIndices.push(fillStartIndex + index);
                hiddenfillIndices.push(hiddenStartIndex + index);
            });
            
            // Add outline indices for polygon borders (outer ring only)
            const outlineStartIndex = coordsToVertices(outerRing, _borderColor, fillVertices);
            for (let i = 0; i < outerRing.length - 1; i++) {
                outlineIndices.push(outlineStartIndex + i, outlineStartIndex + i + 1);
            }
            // Close the ring
            if (outerRing.length > 0) {
                outlineIndices.push(outlineStartIndex + outerRing.length - 1, outlineStartIndex);
            }
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
                    clampedFeatureId,  // Use clamped ID to match properties
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
            fillVertices.push(point[0], point[1], 0.0, ..._fillColor);
            break;
        default:
            // Unsupported geometry type - skip silently
            break;
    }

    return {
        vertices: new Float32Array(fillVertices),
        hiddenVertices: new Float32Array(hiddenVertices),  // Return hidden vertices
        fillIndices: new Uint16Array(fillIndices),
        outlineIndices: new Uint16Array(outlineIndices),
        hiddenfillIndices: new Uint16Array(hiddenfillIndices),
        isFilled,
        isLine,
        properties: {
            ...feature.properties,
            fid: featureId,           // Original feature ID
            clampedFid: clampedFeatureId,  // ID actually used in rendering (1-254)
            sourceLayer: feature.layer?.name  // Store source-layer for symbol layer matching
        }
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
    oldZoomKeys.forEach(key => tileCache.delete(key));
}

// Keep track of successful and failed tiles
//const tileCache = new Map();

// Add at top of file if needed
const activeFetchingTiles = new Set();
const tileErrors = new Map(); // Track failed tiles to avoid repeated fetches
const notFoundTiles = new Set(); // Keep track of tiles that failed with 404 to avoid repeating requests

// Configurable tile source
let tileSourceConfig = {
    url: 'https://demotiles.maplibre.org/tiles/{z}/{x}/{y}.pbf',
    maxZoom: 6,
    timeout: 5000
};

// Function to configure tile source
export function setTileSource(config) {
    tileSourceConfig = {
        url: config.url || tileSourceConfig.url,
        maxZoom: config.maxZoom !== undefined ? config.maxZoom : tileSourceConfig.maxZoom,
        timeout: config.timeout || tileSourceConfig.timeout
    };
}

// Completely rewritten for much higher reliability
export async function fetchVectorTile(x, y, z) {
    // Validate tile coordinates
    const scale = 1 << z;
    if (x < 0 || x >= scale || y < 0 || y >= scale) {
        return null;
    }
    
    // Ensure valid zoom level
    if (z < 0 || z > tileSourceConfig.maxZoom) {
        return null;
    }
    
    const tileKey = `${z}/${x}/${y}`;
    
    // Check if tile is within source bounds (prevents 404s on sparse tilesets)
    const currentStyle = getStyle();
    if (currentStyle && currentStyle.sources) {
        const sourceId = Object.keys(currentStyle.sources)[0];
        if (!isTileInBounds(x, y, z, sourceId)) {
            notFoundTiles.add(tileKey); // Cache as not found
            return null;
        }
    }
    
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
            fetch(url, options).catch(err => {
                // Suppress console errors for 404s as they're expected for sparse tilesets
                if (!err.message?.includes('404')) {
                    console.error('Tile fetch error:', err);
                }
                throw err;
            }),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Fetch timeout')), timeout)
            )
        ]);
    };
    
    try {
        // Build URL from template
        let url = tileSourceConfig.url
            .replace('{z}', z)
            .replace('{x}', x)
            .replace('{y}', y);
        
        const response = await fetchWithTimeout(url, {
            method: 'GET',
            cache: 'force-cache', // Use browser cache aggressively
            headers: { 'Accept': 'application/x-protobuf' }
        }, tileSourceConfig.timeout);

        if (!response.ok) {
            // If we get a 404, mark as permanently not found
            if (response.status === 404) {
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
}

// Add a helper function to reset the system
export function resetTileFetchingSystem() {
    tileCache.clear();
    problemTiles.clear();
}

// Increase cache size to avoid frequent refetching

// Clear cache when it gets too large
export function maintainTileCache(maxSize = 100) {
    if (tileCache.size > maxSize) {
        const keysToDelete = [...tileCache.keys()].slice(0, tileCache.size - Math.floor(maxSize/2));
        keysToDelete.forEach(key => tileCache.delete(key));
    }
}

// Add an exported function to control caching strategy
export function setCachingStrategy(cacheRawData = true)  {
    CACHE_TILE_DATA = cacheRawData;
}

// Add this function to reset the not-found cache
export function resetNotFoundTiles() {
    notFoundTiles.clear();
}