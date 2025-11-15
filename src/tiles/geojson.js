import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import earcut from 'earcut';
import { getColorOfCountries } from '../core/utils.js';
import { TileCache } from './tileCache.js';
import { parseVectorTile as parseVectorTileDirect } from './vectorTileParser.js';
import { tessellateLine, screenWidthToWorld } from './line-tessellation-simple.js';
import { 
    getStyle, 
    getFeatureId as getStyleFeatureId, 
    getPaintProperty, 
    parseColor,
    evaluateFilter,
    getLayersBySource,
    isTileInBounds
} from '../core/style.js';

const tileCache = new TileCache();

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
    let layerId = feature.layer?.name || 'unknown'; // Default layerId

    // Track extrusion properties
    let extrusionHeight = 0;
    let extrusionBase = 0;
    let isExtruded = false;

    // CRITICAL: Calculate zoom-dependent scale for extrusions
    // Buildings need to be visible but proportional to their footprint
    // 
    // At zoom Z, the entire world (360° longitude) fits in 2 clip units
    // Each tile represents (360 / 2^Z) degrees
    // In clip space, each tile = (2 / 2^Z) clip units = 2^(1-Z) clip units
    // 
    // For extrusion height to be proportional:
    // - At zoom 14, tile = 2^(-13) ≈ 0.000122 clip units wide
    // - A 5m building on a 20m×20m footprint should be 25% of footprint height
    // - So 5m should map to roughly 0.25 * (footprint_size_in_clip_space)
    // 
    // Simpler approach: Scale extrusion by (2^-zoom) to match tile size
    // Then apply a constant multiplier for visual appeal
    const tileScaleInClipSpace = Math.pow(2, 1 - zoom); // Size of one tile in clip units
    const metersPerTile = 40075000 / Math.pow(2, zoom); // Meters covered by one tile
    const metersToClipSpace = tileScaleInClipSpace / metersPerTile;
    const visualExaggeration = 3; // Make buildings 3x taller for visibility
    const zoomExtrusion = metersToClipSpace * visualExaggeration;

    if (style && sourceId) {
        // Get layers for this source
        const layers = getLayersBySource(sourceId);
        
        // Check for fill-extrusion layer first (3D buildings)
        const extrusionLayer = layers.find(l => 
            l.type === 'fill-extrusion' && 
            (!l['source-layer'] || l['source-layer'] === feature.layer?.name) &&
            l.layout?.visibility !== 'none'
        );
        
        if (extrusionLayer) {
            console.log(`✅ Found extrusion layer "${extrusionLayer.id}" for feature at zoom ${zoom}, minzoom: ${extrusionLayer.minzoom}`);
        }
        
        // Find first VISIBLE fill layer for this source-layer
        const fillLayer = layers.find(l => 
            l.type === 'fill' && 
            (!l['source-layer'] || l['source-layer'] === feature.layer?.name) &&
            l.layout?.visibility !== 'none' &&
            (!l.filter || evaluateFilter(l.filter, feature, zoom))
        );
        const lineLayer = layers.find(l => 
            l.type === 'line' && 
            (!l['source-layer'] || l['source-layer'] === feature.layer?.name) &&
            l.layout?.visibility !== 'none' &&
            (!l.filter || evaluateFilter(l.filter, feature, zoom))
        );

        // Prefer fill-extrusion over fill, then line
        const activeLayer = extrusionLayer || fillLayer || lineLayer;
        
        // If no visible layer found, skip this feature silently
        if (!activeLayer) {
            return null;
        }
        
        // Store the active layer ID
        layerId = activeLayer.id;
        
        // Handle fill-extrusion properties
        if (extrusionLayer) {
            const heightValue = getPaintProperty(extrusionLayer.id, 'fill-extrusion-height', feature, zoom);
            const baseValue = getPaintProperty(extrusionLayer.id, 'fill-extrusion-base', feature, zoom);
            
            extrusionHeight = heightValue !== undefined ? heightValue : 0;
            extrusionBase = baseValue !== undefined ? baseValue : 0;
            
            // Only mark as extruded if height is actually > 0
            if (extrusionHeight > 0) {
                isExtruded = true;
                console.log(`📐 Extrusion props: height=${extrusionHeight}m, base=${extrusionBase}m, layer="${extrusionLayer.id}", feature source-layer="${feature.layer?.name}"`);
            }
        }

        // Note: Filter already checked during layer finding, no need to check again

        // Get paint properties from style based on layer type
        if (fillLayer || extrusionLayer) {
            const fillColorValue = getPaintProperty(activeLayer.id, 
                extrusionLayer ? 'fill-extrusion-color' : 'fill-color', 
                feature, zoom);
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
    
    // Helper to generate extruded building geometry (walls + roof)
    const generateExtrusion = (allCoords, outerRing, height, base, fillColor, targetVertices, targetIndices, targetOutlineIndices) => {
        const startIndex = targetVertices.length / 7;
        
        // Use zoom-dependent scaling passed from parent scope
        const heightZ = height * zoomExtrusion;
        const baseZ = base * zoomExtrusion;
        
        console.log(`Building extrusion at zoom ${zoom}: ${height}m -> Z=${heightZ.toFixed(8)}`);
        
        // Generate wall quads for each edge of outer ring only
        for (let i = 0; i < outerRing.length - 1; i++) {
            const curr = outerRing[i];
            const next = outerRing[i + 1];
            const [x1, y1] = curr; // Coordinates already transformed!
            const [x2, y2] = next;
            
            // Calculate wall direction for directional lighting
            const dx = x2 - x1;
            const dy = y2 - y1;
            const angle = Math.atan2(dy, dx);
            
            // Simulate sun from north-west
            const sunAngle = Math.PI * 0.75;
            const lightDot = Math.cos(angle - sunAngle);
            
            // Moderate lighting contrast (range 0.0 to 0.8)
            const lightFactor = 0.4 + lightDot * 0.4;
            
            // Wall color with directional lighting
            const wallColor = [
                fillColor[0] * lightFactor,
                fillColor[1] * lightFactor,
                fillColor[2] * lightFactor,
                fillColor[3]
            ];
            
            // Wall quad vertices (2 triangles = 6 vertices for quad)
            const vertexOffset = (targetVertices.length / 7);
            
            // Bottom-left, bottom-right, top-right, top-left - use WALL color
            targetVertices.push(x1, y1, baseZ, ...wallColor);       // 0
            targetVertices.push(x2, y2, baseZ, ...wallColor);       // 1
            targetVertices.push(x2, y2, heightZ, ...wallColor);     // 2
            targetVertices.push(x1, y1, heightZ, ...wallColor);     // 3
            
            // Two triangles for the wall quad
            targetIndices.push(
                vertexOffset, vertexOffset + 1, vertexOffset + 2,  // Triangle 1
                vertexOffset, vertexOffset + 2, vertexOffset + 3   // Triangle 2
            );
        }
        
        // Generate roof (top polygon at height) - use ALL coords including holes
        const roofStartIndex = targetVertices.length / 7;
        allCoords.forEach(coord => {
            const [x, y] = coord; // Coordinates already transformed!
            targetVertices.push(x, y, heightZ, ...fillColor);
        });
        
        return roofStartIndex;
    };

    // Create two separate vertex arrays for visible and hidden rendering
    // NOTE: Coordinates are PRE-TRANSFORMED by vectorTileParser - use directly!
    const coordsToVertices = (coords, color, targetArray) => {
        const vertexStartIndex = targetArray.length / 7;
        coords.forEach(coord => {
            const [x, y] = coord; // Coordinates already in Mercator clip space!
            targetArray.push(
                x, y, 0.0, // Position (z=0 for flat map)
                ...color   // Color
            );
        });
        return vertexStartIndex;
    };

    // NOTE: Coordinates are PRE-TRANSFORMED - use directly!
    // Encode feature ID, layer ID, and height into RGBA channels for hidden buffer
    const coordsToIdVertices = (coords, featureId, targetArray, zHeight = 0.0, layerName = 'unknown', heightMeters = 0) => {
        const vertexStartIndex = targetArray.length / 7;
        
        // Encode feature ID as 16-bit across red and green channels
        // R = high byte (bits 8-15), G = low byte (bits 0-7)
        const safeId = Math.max(1, Math.min(65534, featureId || 1)); // 16-bit range (avoid 0 and 65535)
        const highByte = Math.floor(safeId / 256); // Red channel
        const lowByte = safeId % 256;              // Green channel
        const normalizedR = highByte / 255.0;
        const normalizedG = lowByte / 255.0;
        
        // Encode layer ID in blue channel (hash of layer name)
        let layerIdHash = 0;
        if (layerName && typeof layerName === 'string') {
            for (let i = 0; i < layerName.length; i++) {
                layerIdHash = ((layerIdHash << 5) - layerIdHash) + layerName.charCodeAt(i);
                layerIdHash = layerIdHash & layerIdHash; // Convert to 32-bit integer
            }
            layerIdHash = Math.abs(layerIdHash) % 256; // 0-255 range
        }
        const normalizedB = layerIdHash / 255.0;
        
        // Encode normalized height in alpha channel (0-300m range)
        const MAX_HEIGHT_METERS = 300;
        const normalizedHeight = Math.min(1.0, Math.max(0.0, heightMeters / MAX_HEIGHT_METERS));
        
        coords.forEach(coord => {
            const [x, y] = coord; // Coordinates already in Mercator clip space!
            targetArray.push(
                x, y, zHeight,    // Position with optional Z height
                normalizedR, normalizedG, normalizedB, normalizedHeight  // R+G=ID, B=layerID, A=height
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

            // Get all coordinates for both fill and hidden buffers
            const allCoords = coordinates.flat(1);

            // Check if this is an extruded building
            if (isExtruded && extrusionHeight > 0) {
                console.log(`🏢 EXTRUSION: ${extrusionHeight}m for feature ${clampedFeatureId}`);
                console.log(`  Outer ring coords sample:`, outerRing.slice(0, 3));
                console.log(`  Vertices before:`, fillVertices.length / 7, 'indices before:', fillIndices.length);
                
                // Generate 3D building geometry (walls + roof)
                const roofStartIndex = generateExtrusion(
                    allCoords,
                    outerRing, 
                    extrusionHeight, 
                    extrusionBase, // No offset - let depth testing handle it
                    _fillColor, 
                    fillVertices, 
                    fillIndices,
                    [] // Don't generate outline indices for buildings - causes visual artifacts
                );
                
                console.log(`  Vertices after:`, fillVertices.length / 7, 'indices after:', fillIndices.length);
                // Triangulate the roof
                triangles.forEach(index => {
                    fillIndices.push(roofStartIndex + index);
                });
                
                // CRITICAL: For extruded buildings, create hidden geometry at ROOF height
                // This allows the compute shader to calculate the centroid of the TOP CAP
                // instead of the base polygon, ensuring markers appear on building roofs
                const heightZ = extrusionHeight * zoomExtrusion;
                const hiddenRoofStartIndex = coordsToIdVertices(allCoords, 
                    clampedFeatureId,
                    hiddenVertices,
                    heightZ,  // Render hidden polygon at roof height
                    layerId,  // Pass layer name for blue channel encoding
                    extrusionHeight  // Pass actual height in meters for alpha channel
                );
                
                // Add hidden triangle indices for the roof
                triangles.forEach(index => {
                    hiddenfillIndices.push(hiddenRoofStartIndex + index);
                });
            } else {
                // Flat polygon at z=0
                const fillStartIndex = coordsToVertices(allCoords, _fillColor, fillVertices);
                
                // Add triangle indices
                triangles.forEach(index => {
                    fillIndices.push(fillStartIndex + index);
                });
                
                // Hidden buffer (for picking) - flat at z=0
                const hiddenStartIndex = coordsToIdVertices(allCoords, 
                    clampedFeatureId,
                    hiddenVertices,
                    0.0,  // Flat features at ground level
                    layerId,  // Pass layer name for blue channel encoding  
                    0  // No height for flat polygons
                );
                
                // Add hidden triangle indices
                triangles.forEach(index => {
                    hiddenfillIndices.push(hiddenStartIndex + index);
                });
            }
            
            // Note: Outlines for extruded buildings are now generated inside generateExtrusion()
            // For flat polygons, add ground-level outline
            if (!isExtruded || extrusionHeight === 0) {
                const outlineStartIndex = coordsToVertices(outerRing, _borderColor, fillVertices);
                for (let i = 0; i < outerRing.length - 1; i++) {
                    outlineIndices.push(outlineStartIndex + i, outlineStartIndex + i + 1);
                }
                // Close the ring
                if (outerRing.length > 0) {
                    outlineIndices.push(outlineStartIndex + outerRing.length - 1, outlineStartIndex);
                }
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

                // Get all coordinates for both fill and hidden buffers
                const allCoords = polygon.flat(1);
                
                // Check if this is an extruded building (same logic as Polygon)
                if (isExtruded && extrusionHeight > 0) {
                    console.log(`🏢 MultiPolygon EXTRUSION: ${extrusionHeight}m for polygon ${polygonIndex}`);
                    
                    // Generate 3D building geometry (walls + roof)
                    const roofStartIndex = generateExtrusion(
                        allCoords,
                        outerRing, 
                        extrusionHeight, 
                        extrusionBase, 
                        _fillColor, 
                        fillVertices, 
                        fillIndices,
                        outlineIndices  // Pass outline array to generate 3D edges
                    );
                    
                    // Triangulate the roof
                    triangles.forEach(index => {
                        fillIndices.push(roofStartIndex + index);
                    });
                    
                    // Hidden geometry at ROOF height for marker positioning
                    const heightZ = extrusionHeight * zoomExtrusion;
                    const hiddenRoofStartIndex = coordsToIdVertices(allCoords, 
                        clampedFeatureId,
                        hiddenVertices,
                        heightZ,
                        layerId,
                        extrusionHeight
                    );
                    
                    triangles.forEach(index => {
                        hiddenfillIndices.push(hiddenRoofStartIndex + index);
                    });
                } else {
                    // Flat polygon rendering
                    const fillStartIndex = coordsToVertices(allCoords, _fillColor, fillVertices);
                    const hiddenStartIndex = coordsToIdVertices(allCoords, 
                        clampedFeatureId,
                        hiddenVertices,
                        0.0,
                        layerId,
                        0
                    );

                    // Add triangle indices
                    triangles.forEach(index => {
                        fillIndices.push(fillStartIndex + index);
                        hiddenfillIndices.push(hiddenStartIndex + index);
                    });
                }
            });
            break;
        case 'LineString':
            isFilled = false;
            isLine = true;
            
            // Get line width and style properties
            let lineWidth = 1;
            let lineCap = 'round';
            let lineJoin = 'round';
            let miterLimit = 2;
            
            if (style && sourceId) {
                const layers = getLayersBySource(sourceId);
                const lineLayer = layers.find(l => 
                    l.type === 'line' && 
                    (!l['source-layer'] || l['source-layer'] === feature.layer?.name) &&
                    l.layout?.visibility !== 'none'
                );
                
                if (!lineLayer) {
                    // Road not matching any visible line layer - log for debugging
                    if (feature.layer?.name === 'transportation') {
                        console.log(`⚠️ LineString in 'transportation' not matching any layer. Properties:`, feature.properties, `zoom: ${zoom}`);
                    }
                }
                
                if (lineLayer) {
                    const widthValue = getPaintProperty(lineLayer.id, 'line-width', feature, zoom);
                    lineWidth = typeof widthValue === 'number' ? widthValue : 1;
                    lineCap = lineLayer.layout?.['line-cap'] || 'round';
                    lineJoin = lineLayer.layout?.['line-join'] || 'round';
                    miterLimit = lineLayer.layout?.['line-miter-limit'] || 2;
                }
            }
            
            // Coordinates are already transformed - use directly
            const transformedLineCoords = feature.geometry.coordinates;
            
            // Convert line width from pixels to world space
            const worldWidth = screenWidthToWorld(lineWidth, zoom, 512);
            
            // Tessellate line into triangles
            const tessellated = tessellateLine(transformedLineCoords, worldWidth, lineCap, lineJoin, miterLimit);
            
            // Add tessellated vertices and indices
            const lineStartIndex = fillVertices.length / 7;
            for (let i = 0; i < tessellated.vertices.length; i += 2) {
                fillVertices.push(
                    tessellated.vertices[i],     // x
                    tessellated.vertices[i + 1], // y
                    0.0,                          // z
                    ..._borderColor               // color
                );
            }
            
            // Add triangle indices (lines render as filled triangles)
            tessellated.indices.forEach(idx => {
                fillIndices.push(lineStartIndex + idx);
            });
            break;
        case 'MultiLineString':
            isFilled = false;
            isLine = true;
            
            console.log(`🛣️ MultiLineString with ${feature.geometry.coordinates.length} lines`);
            
            // Get line width and style properties for MultiLineString
            let multiLineWidth = 1;
            let multiLineCap = 'round';
            let multiLineJoin = 'round';
            let multiMiterLimit = 2;
            
            if (style && sourceId) {
                const layers = getLayersBySource(sourceId);
                const lineLayer = layers.find(l => 
                    l.type === 'line' && 
                    (!l['source-layer'] || l['source-layer'] === feature.layer?.name) &&
                    l.layout?.visibility !== 'none'
                );
                
                if (lineLayer) {
                    const widthValue = getPaintProperty(lineLayer.id, 'line-width', feature, zoom);
                    multiLineWidth = typeof widthValue === 'number' ? widthValue : 1;
                    multiLineCap = lineLayer.layout?.['line-cap'] || 'round';
                    multiLineJoin = lineLayer.layout?.['line-join'] || 'round';
                    multiMiterLimit = lineLayer.layout?.['line-miter-limit'] || 2;
                }
            }
            
            // Convert line width from pixels to world space
            const multiWorldWidth = screenWidthToWorld(multiLineWidth, zoom, 512);
            
            feature.geometry.coordinates.forEach(line => {
                // Coordinates are already transformed
                const transformedLine = line;
                
                // Tessellate each line
                const lineTessellated = tessellateLine(transformedLine, multiWorldWidth, multiLineCap, multiLineJoin, multiMiterLimit);
                
                // Add tessellated vertices
                const multiLineStartIndex = fillVertices.length / 7;
                for (let i = 0; i < lineTessellated.vertices.length; i += 2) {
                    fillVertices.push(
                        lineTessellated.vertices[i],
                        lineTessellated.vertices[i + 1],
                        0.0,
                        ..._borderColor
                    );
                }
                
                // Add triangle indices
                lineTessellated.indices.forEach(idx => {
                    fillIndices.push(multiLineStartIndex + idx);
                });
            });
            break;
        case 'Point':
            const point = feature.geometry.coordinates; // Already transformed!
            fillVertices.push(point[0], point[1], 0.0, ..._fillColor);
            break;
        default:
            // Unsupported geometry type - skip silently
            break;
    }

    return {
        vertices: new Float32Array(fillVertices),
        hiddenVertices: new Float32Array(hiddenVertices),  // Return hidden vertices
        fillIndices: new Uint32Array(fillIndices),
        outlineIndices: new Uint32Array(outlineIndices),
        hiddenfillIndices: new Uint32Array(hiddenfillIndices),
        isFilled,
        isLine,
        layerId,  // Add layerId to return object
        properties: {
            ...feature.properties,
            fid: featureId,           // Original feature ID
            clampedFid: clampedFeatureId,  // ID actually used in rendering (1-254)
            sourceLayer: feature.layer?.name  // Store source-layer for symbol layer matching
        }
    };
}

// Tile fetching infrastructure
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
export async function fetchVectorTile(x, y, z, abortSignal = null) {
    // Validate tile coordinates
    const scale = 1 << z;
    if (x < 0 || x >= scale || y < 0 || y >= scale) {
        return null;
    }
    
    // Check if request was aborted
    if (abortSignal?.aborted) {
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

    // Check if request was aborted
    if (abortSignal?.aborted) {
        return null;
    }
    
    // Check if already fetching
    if (activeFetchingTiles.has(tileKey)) {
        return null; // Don't wait for tiles already being fetched
    }
    
    // Check if request was aborted again before starting fetch
    if (abortSignal?.aborted) {
        return null;
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
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        
        try {
            // Combine abort signals if one was passed in
            const signal = options.signal 
                ? combineAbortSignals([options.signal, controller.signal])
                : controller.signal;
                
            const response = await fetch(url, { ...options, signal });
            clearTimeout(timeoutId);
            return response;
        } catch (err) {
            clearTimeout(timeoutId);
            throw err;
        }
    };
    
    // Helper to combine multiple abort signals
    const combineAbortSignals = (signals) => {
        const controller = new AbortController();
        for (const signal of signals) {
            if (signal.aborted) {
                controller.abort();
                break;
            }
            signal.addEventListener('abort', () => controller.abort());
        }
        return controller.signal;
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
            headers: { 'Accept': 'application/x-protobuf' },
            signal: abortSignal // Will be combined with timeout signal
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
        
        // NEW: Use direct parser with pre-transformed coordinates
        // This skips toGeoJSON() and GPU roundtrip - much faster!
        const parsedTile = parseVectorTileDirect(arrayBuffer, x, y, z);
        
        // Only cache valid tiles
        if (parsedTile && parsedTile.layers && Object.keys(parsedTile.layers).length > 0) {
            tileCache.set(tileKey, parsedTile);
            activeFetchingTiles.delete(tileKey);
            
            // Clear error count on success
            if (tileErrors.has(tileKey)) {
                tileErrors.delete(tileKey);
            }
            
            return parsedTile;
        } else {
            throw new Error("Tile has no layers");
        }
    } catch (err) {
        // Handle abort errors silently
        if (err.name === 'AbortError' || abortSignal?.aborted) {
            activeFetchingTiles.delete(tileKey);
            return null;
        }
        
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

// Helper function to clear tile cache
export function clearTileCache() {
    tileCache.clear();
}

// Reset the not-found tiles tracking
export function resetNotFoundTiles() {
    notFoundTiles.clear();
}