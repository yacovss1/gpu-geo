import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import earcut from 'earcut';
import { getColorOfCountries } from '../core/utils.js';
import { TileCache } from './tileCache.js';
import { parseVectorTile as parseVectorTileDirect } from './vectorTileParser.js';
import { tessellateLine, screenWidthToWorld, subdivideLine } from './line-tessellation-simple.js';
import { 
    getStyle, 
    getFeatureId as getStyleFeatureId, 
    getPaintProperty, 
    parseColor,
    evaluateFilter,
    getLayersBySource,
    isTileInBounds,
    getLayerIndex,
    getSourcePromoteId
} from '../core/style.js';
import { TERRAIN_CONFIG } from '../core/terrainConfig.js';

// Vertex format: position(3) + normal(3) + color(4) = 10 floats = 40 bytes
const VERTEX_STRIDE = 10;
// Default normal for flat surfaces (pointing up)
const UP_NORMAL = [0, 0, 1];

// Simple murmur3-like hash for strings (consistent with MapLibre's approach)
function murmur3Hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        h = ((h << 5) - h) + c;
        h = h & h; // Convert to 32-bit integer
    }
    return Math.abs(h);
}

/**
 * Get a usable feature ID for GPU indexing (1-65534 range)
 * Strategy:
 * 1. Check promoteId config (use property as ID)
 * 2. Use feature.id if present and valid
 * 3. Hash string IDs with murmur3
 * 4. Modulo large numeric IDs to fit 16-bit range
 * 5. Fall back to sequential ID
 */
function getSmartFeatureId(feature, sourceId) {
    // SIMPLE: Just use feature.id if it exists
    const featureId = feature.id;
    
    // DEBUG: Always log what we receive
    const name = feature.properties?.NAME || feature.properties?.name;
    if (name && name.includes('Tunisia')) {
        console.log(`� getSmartFeatureId Tunisia: feature.id=${featureId}, typeof=${typeof featureId}`);
    }
    
    // If we have a valid numeric feature.id in the 16-bit range, use it directly
    if (typeof featureId === 'number' && featureId >= 1 && featureId <= 65534) {
        return featureId;
    }
    
    // If we have a large numeric ID (like OSM IDs), use modulo to map into 16-bit range
    // This ensures the SAME feature across tiles gets the SAME ID
    if (typeof featureId === 'number' && featureId > 65534) {
        // Use modulo with prime number to reduce collisions, then ensure in valid range (1-65534)
        const mappedId = (featureId % 65521) + 1; // 65521 is largest prime < 65535
        return Math.min(mappedId, 65534);
    }
    
    // Fall back to sequential for features without IDs
    const seqId = getNextFeatureId();
    //console.log(`⚠️ No valid feature.id for ${name || 'unknown'}, using sequential: ${seqId}`);
    return seqId;
}

const tileCache = new TileCache();

// Global feature ID counter for unique picking IDs
// This ensures every feature rendered gets a unique ID for picking
// Using sequential IDs avoids hash collisions (tileset IDs are in the billions)
let globalFeatureIdCounter = 1;
const MAX_FEATURE_ID = 65534; // 16-bit limit (avoid 0 and 65535)

// Reset counter (call when clearing all tiles)
export function resetFeatureIdCounter() {
    globalFeatureIdCounter = 1;
}

// Get next unique feature ID
function getNextFeatureId() {
    const id = globalFeatureIdCounter;
    globalFeatureIdCounter++;
    if (globalFeatureIdCounter > MAX_FEATURE_ID) {
        globalFeatureIdCounter = 1; // Wrap around (unlikely with normal usage)
        console.warn('⚠️ Feature ID counter wrapped around - some IDs may duplicate');
    }
    return id;
}

// Create deterministic ID from country name (no collision resolution - let GPU handle duplicates)
function getCountryId(countryName) {
    let hash = 0;
    for (let i = 0; i < countryName.length; i++) {
        hash = ((hash << 5) - hash) + countryName.charCodeAt(i);
        hash = hash & hash;
    }
    // Map to 16-bit range (1-65533) for better distribution
    return ((Math.abs(hash) % 65533) + 1);
}

// Create deterministic ID from source-layer name for features that should merge across tiles
// This allows water features from different tiles to share the same ID and merge in compute shader
function getDeterministicLayerBasedId(sourceLayer) {
    if (!sourceLayer) return null;
    
    let hash = 0;
    for (let i = 0; i < sourceLayer.length; i++) {
        hash = ((hash << 5) - hash) + sourceLayer.charCodeAt(i);
        hash = hash & hash;
    }
    // Map to a small range (1-255) to encourage merging via modulo in compute shader
    // This means all "water" features will likely map to the same ID
    return ((Math.abs(hash) % 255) + 1);
}

/**
 * Sample terrain height from CPU-side terrain data
 * @param {number} x - X coordinate in clip space
 * @param {number} y - Y coordinate in clip space
 * @param {Object} terrainData - { heights, width, height, bounds, exaggeration }
 * @returns {number} Height value in clip space units
 */
function sampleTerrainHeight(x, y, terrainData) {
    if (!terrainData || !terrainData.heights) return 0;
    
    const { heights, width, height, bounds } = terrainData;
    const exaggeration = terrainData.exaggeration || TERRAIN_CONFIG.DEFAULT_EXAGGERATION;
    
    // Check bounds with small margin (matches GPU shader)
    const margin = 0.001;
    if (x < bounds.minX - margin || x > bounds.maxX + margin || 
        y < bounds.minY - margin || y > bounds.maxY + margin) {
        return 0;
    }
    
    // Quantize UV coordinates to match GPU shader
    // This helps prevent Z-fighting between adjacent vertices
    const uvScale = 256.0;
    
    // Convert to UV coordinates
    const rawU = (x - bounds.minX) / (bounds.maxX - bounds.minX);
    const rawV = 1 - (y - bounds.minY) / (bounds.maxY - bounds.minY);
    
    // Clamp to valid range (matches GPU shader - no quantization!)
    const u = Math.max(0.001, Math.min(0.999, rawU));
    const v = Math.max(0.001, Math.min(0.999, rawV));
    
    // Bilinear interpolation to match GPU textureSampleLevel behavior
    const fx = u * (width - 1);
    const fy = v * (height - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, width - 1);
    const y1 = Math.min(y0 + 1, height - 1);
    
    // Get 4 corner heights
    const h00 = heights[y0 * width + x0] || 0;
    const h10 = heights[y0 * width + x1] || 0;
    const h01 = heights[y1 * width + x0] || 0;
    const h11 = heights[y1 * width + x1] || 0;
    
    // Interpolation weights
    const wx = fx - x0;
    const wy = fy - y0;
    
    // Bilinear interpolation
    const h0 = h00 * (1 - wx) + h10 * wx;
    const h1 = h01 * (1 - wx) + h11 * wx;
    const rawHeight = h0 * (1 - wy) + h1 * wy;
    
    // Clamp to reasonable range and scale (same as GPU shader)
    const clampedHeight = Math.max(0, Math.min(9000, rawHeight));
    return (clampedHeight / 50000000.0) * exaggeration;
}

/**
 * Parse a GeoJSON feature into renderable vertices
 * @param {Object} feature - Feature with geometry
 * @param {Array} fillColor - Default fill color
 * @param {string} sourceId - Style source ID
 * @param {number} zoom - Current zoom level
 * @param {Object} terrainData - Optional terrain data for CPU height baking
 */
export function parseGeoJSONFeature(feature, fillColor = [0.0, 0.0, 0.0, 1.0], sourceId = null, zoom = 0, terrainData = null) {
    const fillVertices = [];
    const hiddenVertices = [];
    const fillIndices = [];
    const outlineIndices = [];
    const hiddenfillIndices = [];
    const lineSegments = []; // For line-extrusion 3D tube rendering
    const lineCenterlines = []; // For GPU compute terrain projection
    const terrainPolygons = []; // For terrain-based polygon rendering (flat polygons that follow terrain)
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
        
        const lineExtrusionLayer = layers.find(l => 
            l.type === 'line-extrusion' && 
            (!l['source-layer'] || l['source-layer'] === feature.layer?.name) &&
            l.layout?.visibility !== 'none' &&
            (!l.filter || evaluateFilter(l.filter, feature, zoom))
        );

        // Prefer fill-extrusion over fill, then line-extrusion, then line
        const activeLayer = extrusionLayer || fillLayer || lineExtrusionLayer || lineLayer;
        
        // If no visible layer found, skip this feature silently
        if (!activeLayer) {
            return null;
        }
        
        // Store the active layer ID for rendering and hidden buffer
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
            
            // Get opacity separately (defaults to 1.0 if not specified)
            const opacityValue = getPaintProperty(activeLayer.id,
                extrusionLayer ? 'fill-extrusion-opacity' : 'fill-opacity',
                feature, zoom);
            if (opacityValue !== null && opacityValue !== undefined) {
                _fillColor[3] = opacityValue; // Set alpha channel
            }
        }

        if (lineLayer || lineExtrusionLayer) {
            const activeLineLayer = lineExtrusionLayer || lineLayer;
            const lineColorValue = getPaintProperty(activeLineLayer.id, 'line-color', feature, zoom);
            if (lineColorValue) {
                _borderColor = parseColor(lineColorValue);
            }
        }
    } else {
        // Fallback to legacy hardcoded colors
        const countryCode = feature?.properties?.ADM0_A3 || feature?.properties?.ISO_A3;
        _fillColor = getColorOfCountries(countryCode, [0.7, 0.7, 0.7, 1.0]);
    }

    // Use smart feature ID selection:
    // 1. promoteId from style config
    // 2. feature.id from tile (consistent across tiles for same feature)
    // 3. hash strings, modulo large numbers
    // 4. sequential fallback
    const pickingId = getSmartFeatureId(feature, sourceId);
    
    // Store original feature ID for reference (can be used to look up feature properties)
    const originalFeatureId = feature.id ?? feature.properties?.id;
    
    // pickingId is already in valid range (1-65534)
    const clampedFeatureId = pickingId;
    
    // Deduplicate by coordinates+layer (not by tileset ID which may span tiles)
    // Note: processedFeatures is local per parseGeoJSONFeature call, so no global dedup
    
    // Helper to calculate terrain height at building centroid
    // Returns 0 if no terrain data available
    const getBuildingTerrainZ = (outerRing) => {
        if (!terrainData || outerRing.length < 2) return 0;
        let centroidX = 0, centroidY = 0;
        const count = outerRing.length - 1; // Exclude closing point
        for (let i = 0; i < count; i++) {
            centroidX += outerRing[i][0];
            centroidY += outerRing[i][1];
        }
        centroidX /= count;
        centroidY /= count;
        return sampleTerrainHeight(centroidX, centroidY, terrainData);
    };
    
    // Helper to generate extruded building geometry (walls + roof)
    // Vertex format: position(3) + normal(3) + color(4) = 10 floats = 40 bytes
    // buildingTerrainZ: pre-computed terrain height at building centroid
    const generateExtrusion = (allCoords, outerRing, height, base, fillColor, targetVertices, targetIndices, targetOutlineIndices, buildingTerrainZ = 0) => {
        const startIndex = targetVertices.length / VERTEX_STRIDE;
        
        // Use zoom-dependent scaling passed from parent scope
        const heightZ = height * zoomExtrusion;
        const baseZ = base * zoomExtrusion;
        
        // Layer Z offset for proper stacking (must match hidden buffer)
        const layerIdx = getLayerIndex(layerId);
        const layerZOffset = layerIdx * 0.00000005;
        
        // Generate wall quads for each edge of outer ring only
        for (let i = 0; i < outerRing.length - 1; i++) {
            const curr = outerRing[i];
            const next = outerRing[i + 1];
            const [x1, y1] = curr; // Coordinates already transformed!
            const [x2, y2] = next;
            
            // Sanity check: skip corrupted coordinates
            if (!isFinite(x1) || !isFinite(y1) || !isFinite(x2) || !isFinite(y2) ||
                Math.abs(x1) > 10 || Math.abs(y1) > 10 || Math.abs(x2) > 10 || Math.abs(y2) > 10) {
                console.warn(`⚠️ Skipping corrupted wall edge: (${x1},${y1}) to (${x2},${y2})`);
                continue;
            }
            
            // Use building centroid terrain height for ALL vertices
            // This keeps walls vertical instead of stretching on slopes
            
            // Calculate wall normal (perpendicular to wall, pointing outward)
            const dx = x2 - x1;
            const dy = y2 - y1;
            const len = Math.sqrt(dx * dx + dy * dy);
            // Normal is perpendicular to the wall edge, pointing outward (right-hand rule)
            const wallNormal = len > 0 ? [-dy / len, dx / len, 0] : [1, 0, 0];
            
            // Wall quad vertices: position(3) + normal(3) + color(4) = 10 floats
            const vertexOffset = (targetVertices.length / VERTEX_STRIDE);
            
            // Bottom-left, bottom-right, top-right, top-left
            // All vertices use the SAME terrain height (from centroid) + layer offset
            // All 4 vertices share the same wall normal
            targetVertices.push(x1, y1, baseZ + buildingTerrainZ + layerZOffset, ...wallNormal, ...fillColor);
            targetVertices.push(x2, y2, baseZ + buildingTerrainZ + layerZOffset, ...wallNormal, ...fillColor);
            targetVertices.push(x2, y2, heightZ + buildingTerrainZ + layerZOffset, ...wallNormal, ...fillColor);
            targetVertices.push(x1, y1, heightZ + buildingTerrainZ + layerZOffset, ...wallNormal, ...fillColor);
            
            // Two triangles for the wall quad
            targetIndices.push(
                vertexOffset, vertexOffset + 1, vertexOffset + 2,  // Triangle 1
                vertexOffset, vertexOffset + 2, vertexOffset + 3   // Triangle 2
            );
        }
        
        // Generate roof (top polygon at height) - use ALL coords including holes
        const roofStartIndex = targetVertices.length / VERTEX_STRIDE;
        allCoords.forEach(coord => {
            const [x, y] = coord; // Coordinates already transformed!
            
            // Sanity check for roof vertices
            if (!isFinite(x) || !isFinite(y) || Math.abs(x) > 10 || Math.abs(y) > 10) {
                console.warn(`⚠️ Skipping corrupted roof vertex: (${x},${y})`);
                return;
            }
            
            // Use building centroid terrain height for roof (consistent with walls) + layer offset
            
            // Roof: position(3) + normal(3) + color(4) - normal points up
            targetVertices.push(x, y, heightZ + buildingTerrainZ + layerZOffset, ...UP_NORMAL, ...fillColor);
        });
        
        return roofStartIndex;
    };

    // Create two separate vertex arrays for visible and hidden rendering
    // NOTE: Coordinates are PRE-TRANSFORMED by vectorTileParser - use directly!
    // If terrainData is provided, bake terrain height into Z coordinate
    // Layer Z offset ensures proper stacking via z-buffer (later layers appear on top)
    // Vertex format: position(3) + normal(3) + color(4) = 10 floats
    const coordsToVertices = (coords, color, targetArray) => {
        const vertexStartIndex = targetArray.length / VERTEX_STRIDE;
        // Get layer Z offset for proper stacking (later style layers render on top)
        const layerIdx = getLayerIndex(layerId);
        const layerZOffset = layerIdx * 0.00000005; // Tiny offset per layer for z-buffer ordering
        
        coords.forEach(coord => {
            const [x, y] = coord; // Coordinates already in Mercator clip space!
            // Sample terrain height if available, otherwise 0
            const terrainZ = terrainData ? sampleTerrainHeight(x, y, terrainData) : 0.0;
            // Add layer offset so later layers appear on top
            const z = terrainZ + layerZOffset;
            targetArray.push(
                x, y, z,       // Position with terrain height + layer offset
                ...UP_NORMAL,  // Normal (pointing up for flat surfaces)
                ...color       // Color
            );
        });
        return vertexStartIndex;
    };

    // NOTE: Coordinates are PRE-TRANSFORMED - use directly!
    // Encode feature ID and layer ID into RGBA channels for hidden buffer
    // If terrainData is provided, bake terrain height into Z coordinate
    // If baseTerrainZ is provided (for buildings), use that instead of per-vertex sampling
    // Layer Z offset ensures proper stacking via z-buffer (later layers appear on top)
    // Vertex format: position(3) + normal(3) + color(4) = 10 floats
    const coordsToIdVertices = (coords, featureId, targetArray, zHeight = 0.0, layerName = 'unknown', baseTerrainZ = null) => {
        const vertexStartIndex = targetArray.length / VERTEX_STRIDE;
        
        // Encode feature ID as 16-bit across red and green channels
        // R = high byte (bits 8-15), G = low byte (bits 0-7)
        const safeId = Math.max(1, Math.min(65534, featureId || 1)); // 16-bit range (avoid 0 and 65535)
        const highByte = Math.floor(safeId / 256); // Red channel
        const lowByte = safeId % 256;              // Green channel
        const normalizedR = highByte / 255.0;
        const normalizedG = lowByte / 255.0;
        // Get proper layer ID index (0-255) using getLayerIndex
        const layerIdx = getLayerIndex(layerName);
        const normalizedB = layerIdx / 255.0;
        // Layer Z offset for proper stacking (same as visible pass)
        const layerZOffset = layerIdx * 0.00000005;
        
        // Alpha channel can be used for other purposes if needed (currently unused)
        const normalizedA = 1.0;
        
        coords.forEach(coord => {
            const [x, y] = coord; // Coordinates already in Mercator clip space!
            // For buildings with pre-computed centroid terrain height, use that
            // Otherwise sample terrain per-vertex (for non-building features)
            let z = zHeight;
            if (baseTerrainZ !== null) {
                // Building: use pre-computed centroid terrain height
                z = zHeight + baseTerrainZ;
            } else if (terrainData) {
                // Non-building: sample terrain at each vertex
                const terrainZ = sampleTerrainHeight(x, y, terrainData);
                z = zHeight + terrainZ;
            }
            // Add layer offset so later layers appear on top
            z += layerZOffset;
            targetArray.push(
                x, y, z,       // Position with terrain + extrusion height + layer offset
                ...UP_NORMAL,  // Normal (pointing up for flat/hidden surfaces)
                normalizedR, normalizedG, normalizedB, normalizedA  // R+G=ID, B=layerID, A=unused
            );
        });
        return vertexStartIndex;
    };
    
    // Helper to subdivide a ring/line for terrain conformance
    const subdivideRing = (coords, maxLength = 0.005) => {
        if (coords.length < 2) return coords;
        
        const result = [coords[0]];
        for (let i = 1; i < coords.length; i++) {
            const prev = coords[i - 1];
            const curr = coords[i];
            const dx = curr[0] - prev[0];
            const dy = curr[1] - prev[1];
            const len = Math.sqrt(dx * dx + dy * dy);
            
            if (len > maxLength) {
                const numDivisions = Math.ceil(len / maxLength);
                for (let j = 1; j < numDivisions; j++) {
                    const t = j / numDivisions;
                    result.push([prev[0] + dx * t, prev[1] + dy * t]);
                }
            }
            result.push(curr);
        }
        return result;
    };

    switch (feature.geometry.type) {
        case 'Polygon':
            // Combine all rings into a single array with holes
            const coordinates = feature.geometry.coordinates;
            
            // Subdivide rings for terrain conformance (when terrain data available)
            const outerRing = subdivideRing(coordinates[0]);
            const holes = coordinates.slice(1).map(hole => subdivideRing(hole));
            
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
            // Use subdivided coordinates for proper terrain sampling
            const allCoords = [outerRing, ...holes].flat(1);

            // Check if this is an extruded building
            if (isExtruded && extrusionHeight > 0) {
                // Skip degenerate buildings with too few points (need at least 4 to close a polygon)
                if (outerRing.length < 4) {
                    console.warn(`⚠️ Skipping degenerate building with only ${outerRing.length} points`);
                    return null;
                }
                
                // Calculate terrain height at building centroid ONCE for both visible and hidden geometry
                const buildingTerrainZ = getBuildingTerrainZ(outerRing);
                
                // Generate 3D building geometry (walls + roof)
                const roofStartIndex = generateExtrusion(
                    allCoords,
                    outerRing, 
                    extrusionHeight, 
                    extrusionBase,
                    _fillColor, 
                    fillVertices, 
                    fillIndices,
                    [], // Don't generate outline indices for buildings
                    buildingTerrainZ
                );
                
                // Triangulate the roof
                triangles.forEach(index => {
                    fillIndices.push(roofStartIndex + index);
                });
                
                // For hidden buffer: Use actual roof triangulation (includes holes/courtyards)
                // Use same triangulated coordinates but elevated to roof height
                // Pass buildingTerrainZ to ensure hidden geometry matches visible geometry
                const hiddenStartIndex = coordsToIdVertices(
                    allCoords,
                    clampedFeatureId,
                    hiddenVertices,
                    extrusionHeight * zoomExtrusion,  // Z coordinate = roof height
                    layerId,
                    buildingTerrainZ  // Use same terrain height as visible geometry
                );
                
                // Add hidden triangle indices - same triangulation as visible roof
                triangles.forEach(index => {
                    hiddenfillIndices.push(hiddenStartIndex + index);
                });
            } else {
                // Flat polygon at z=0
                const fillStartIndex = coordsToVertices(allCoords, _fillColor, fillVertices);
                
                // Add triangle indices
                triangles.forEach(index => {
                    fillIndices.push(fillStartIndex + index);
                });
                
                // Collect polygon data for terrain-based rendering
                // This allows flat polygons to follow terrain mesh
                console.log(`🔷 Collecting terrain polygon: ${layerId} with ${outerRing.length} points, color:`, _fillColor);
                terrainPolygons.push({
                    coords: [outerRing, ...holes], // Outer ring + holes
                    color: _fillColor.slice(), // Copy color array
                    type: layerId
                });
                
                // Hidden buffer (for picking) - flat at z=0
                const hiddenStartIndex = coordsToIdVertices(allCoords, 
                    clampedFeatureId,
                    hiddenVertices,
                    0.0,  // Flat features at ground level
                    layerId
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
            // All polygons in a MultiPolygon belong to the SAME feature (e.g., Tunisia includes islands)
            // so they all share the same feature ID for picking/labeling
            feature.geometry.coordinates.forEach((polygon, polygonIndex) => {
                // Subdivide rings for terrain conformance
                const outerRing = subdivideRing(polygon[0]);
                const holes = polygon.slice(1).map(hole => subdivideRing(hole));
                
                // Use the shared feature ID - all parts of Tunisia should have the same ID
                const polygonPickingId = clampedFeatureId;
                
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
                // Use subdivided coordinates for proper terrain sampling
                const allCoords = [outerRing, ...holes].flat(1);
                
                // Check if this is an extruded building (same logic as Polygon)
                if (isExtruded && extrusionHeight > 0) {
                   // console.log(`🏢 MultiPolygon EXTRUSION: ${extrusionHeight}m for polygon ${polygonIndex}`);
                    
                    // Calculate terrain height at building centroid ONCE for both visible and hidden geometry
                    const buildingTerrainZ = getBuildingTerrainZ(outerRing);
                    
                    // Generate 3D building geometry (walls + roof)
                    const roofStartIndex = generateExtrusion(
                        allCoords,
                        outerRing, 
                        extrusionHeight, 
                        extrusionBase, 
                        _fillColor, 
                        fillVertices, 
                        fillIndices,
                        [], // Don't generate outline indices
                        buildingTerrainZ
                    );
                    
                    // Triangulate the roof
                    triangles.forEach(index => {
                        fillIndices.push(roofStartIndex + index);
                    });
                    
                    // For hidden buffer: base polygon at roof height
                    // Use same terrain height as visible geometry
                    const hiddenStartIndex = coordsToIdVertices(
                        allCoords,
                        polygonPickingId,  // Use per-polygon ID, not shared feature ID
                        hiddenVertices,
                        extrusionHeight * zoomExtrusion,  // Z coordinate = roof height
                        layerId,
                        buildingTerrainZ  // Use same terrain height as visible geometry
                    );
                    
                    // Add hidden triangle indices for flat base
                    triangles.forEach(index => {
                        hiddenfillIndices.push(hiddenStartIndex + index);
                    });
                } else {
                    // Flat polygon rendering
                    const fillStartIndex = coordsToVertices(allCoords, _fillColor, fillVertices);
                    const hiddenStartIndex = coordsToIdVertices(allCoords, 
                        polygonPickingId,  // Use per-polygon ID, not shared feature ID
                        hiddenVertices,
                        0.0,
                        layerId
                    );

                    // Add triangle indices
                    triangles.forEach(index => {
                        fillIndices.push(fillStartIndex + index);
                        hiddenfillIndices.push(hiddenStartIndex + index);
                    });
                    
                    // Collect polygon data for terrain-based rendering
                    terrainPolygons.push({
                        coords: [outerRing, ...holes],
                        color: _fillColor.slice(),
                        type: layerId
                    });
                }
            });
            break;
        case 'LineString':
            isFilled = false;
            isLine = true;
            
            // Calculate layer Z offset for proper stacking
            const lineLayerIdx = getLayerIndex(layerId);
            const lineLayerZOffset = lineLayerIdx * 0.00000005;
            
            // Get line width and style properties
            let lineWidth = 1;
            let lineCap = 'round';
            let lineJoin = 'round';
            let miterLimit = 2;
            
            if (style && sourceId) {
                const layers = getLayersBySource(sourceId);
                const lineLayer = layers.find(l => 
                    (l.type === 'line' || l.type === 'line-extrusion') && 
                    (!l['source-layer'] || l['source-layer'] === feature.layer?.name) &&
                    l.layout?.visibility !== 'none'
                );
                
                if (!lineLayer) {
                    // Road not matching any visible line layer - skip silently
                    // (many transportation features are filtered by zoom/style)
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
            // Subdivide long segments for proper terrain height sampling
            // Calculate zoom-dependent threshold: at zoom Z, tile = 2/(2^Z), we want ~20 points per tile
            // So maxSegmentLength = 2/(2^Z * 20) = 1/(2^(Z-1) * 10)
            const subdivisionThreshold = 1 / (Math.pow(2, zoom - 1) * 10);
            const subdividedCoords = subdivideLine(feature.geometry.coordinates, subdivisionThreshold);
            const transformedLineCoords = subdividedCoords;
            
            // Check if this is a line-extrusion layer (needs 3D tube geometry)
            const isLineExtrusion = style && sourceId && getLayersBySource(sourceId).some(l =>
                (l.type === 'line-extrusion' || l.metadata?.['render-as-tubes'] === true) &&
                l.id === layerId
            );
            
            // Convert line width from pixels to world space
            const worldWidth = screenWidthToWorld(lineWidth, zoom, 512);
            
            // Store centerline for GPU compute terrain projection
            // This allows the GPU to do adaptive subdivision based on actual terrain
            lineCenterlines.push({
                coordinates: feature.geometry.coordinates, // Raw coordinates (not subdivided)
                width: worldWidth,
                color: _borderColor,
                featureId: clampedFeatureId,
                layerId: layerId
            });
            
            // Tessellate line into triangles
            const tessellated = tessellateLine(transformedLineCoords, worldWidth, lineCap, lineJoin, miterLimit);
            
            if (isLineExtrusion && tessellated.vertices.length > 0) {
                // Check tube shape from metadata
                const tubeShape = style?.layers?.find(l => l.id === layerId)?.metadata?.['tube-shape'] || 'rectangular';
                
                // Generate 3D extruded TUBE geometry with WIDTH (not just a thin ribbon)
                const lineExtrusionHeight = getPaintProperty(style, layerId, 'line-extrusion-height', {}) || 10;
                const lineExtrusionBase = getPaintProperty(style, layerId, 'line-extrusion-base', {}) || 0;
                const lineWidth = getPaintProperty(style, layerId, 'line-width', {}) || 3.0;
                
                // IMPORTANT: Width should use worldWidth (clip space), NOT zoomExtrusion scaling
                // worldWidth is already calculated above for 2D lines - reuse it for tube width
                // This keeps tubes visually consistent with non-extruded lines
                const radius = worldWidth / 2;
                
                // Height uses zoomExtrusion to convert meters to clip space
                const heightZ = lineExtrusionHeight * zoomExtrusion;
                const baseZ = lineExtrusionBase * zoomExtrusion;
                
                if (tubeShape === 'circular') {
                    // ===== CIRCULAR TUBE GEOMETRY =====
                    const segments = 12; // Number of sides around the circle (12 = dodecagon)
                    
                    // Step 1: Generate all circle cross-sections along the line path
                    const circles = [];
                    for (let i = 0; i < transformedLineCoords.length; i++) {
                        const [cx, cy] = transformedLineCoords[i];
                        
                        // Calculate perpendicular direction at this point
                        let perpX, perpY;
                        if (i === 0) {
                            // First point
                            const [nx, ny] = transformedLineCoords[i + 1];
                            const dx = nx - cx, dy = ny - cy;
                            const len = Math.sqrt(dx * dx + dy * dy);
                            perpX = -dy / len;
                            perpY = dx / len;
                        } else if (i === transformedLineCoords.length - 1) {
                            // Last point
                            const [px, py] = transformedLineCoords[i - 1];
                            const dx = cx - px, dy = cy - py;
                            const len = Math.sqrt(dx * dx + dy * dy);
                            perpX = -dy / len;
                            perpY = dx / len;
                        } else {
                            // Middle point - average direction
                            const [px, py] = transformedLineCoords[i - 1];
                            const [nx, ny] = transformedLineCoords[i + 1];
                            const dx1 = cx - px, dy1 = cy - py;
                            const dx2 = nx - cx, dy2 = ny - cy;
                            const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
                            const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
                            perpX = -(dy1 / len1 + dy2 / len2) / 2;
                            perpY = (dx1 / len1 + dx2 / len2) / 2;
                            const perpLen = Math.sqrt(perpX * perpX + perpY * perpY);
                            perpX /= perpLen;
                            perpY /= perpLen;
                        }
                        
                        // Sample terrain height at this point
                        const terrainZ = terrainData ? sampleTerrainHeight(cx, cy, terrainData) : 0;
                        
                        circles.push({ cx, cy, perpX, perpY, terrainZ });
                    }
                    
                    // Step 2: Generate vertices for all circles
                    const circleStartIdx = fillVertices.length / VERTEX_STRIDE;
                    for (let i = 0; i < circles.length; i++) {
                        const { cx, cy, perpX, perpY } = circles[i];
                        
                        // Create ring of vertices around circle
                        for (let s = 0; s < segments; s++) {
                            const angle = (s / segments) * Math.PI * 2;
                            
                            // Circle in horizontal plane (XY) and vertical (Z)
                            const horizontalOffset = Math.cos(angle) * radius;
                            const verticalOffset = Math.sin(angle) * radius;
                            
                            // Apply horizontal offset perpendicular to path
                            const vx = cx + perpX * horizontalOffset;
                            const vy = cy + perpY * horizontalOffset;
                            
                            // Sample terrain at actual vertex position for consistency with polygons
                            const terrainZ = terrainData ? sampleTerrainHeight(vx, vy, terrainData) : 0;
                            
                            // Tube sits on terrain at baseZ, extends upward to heightZ
                            const vz = baseZ + verticalOffset + terrainZ + lineLayerZOffset;
                            
                            // Calculate surface normal for lighting
                            const normalX = perpX * Math.cos(angle);
                            const normalY = perpY * Math.cos(angle);
                            const normalZ = Math.sin(angle);
                            const tubeNormal = [normalX, normalY, normalZ];
                            
                            // Push vertex: position(3) + normal(3) + color(4)
                            fillVertices.push(vx, vy, vz, ...tubeNormal, ..._borderColor);
                        }
                    }
                    
                    // Step 3: Connect adjacent circles with quad strips
                    for (let i = 0; i < circles.length - 1; i++) {
                        const ring1Start = circleStartIdx + i * segments;
                        const ring2Start = circleStartIdx + (i + 1) * segments;
                        
                        for (let s = 0; s < segments; s++) {
                            const next = (s + 1) % segments;
                            const v1 = ring1Start + s;
                            const v2 = ring1Start + next;
                            const v3 = ring2Start + next;
                            const v4 = ring2Start + s;
                            
                            // Two triangles per quad
                            fillIndices.push(v1, v2, v3);
                            fillIndices.push(v1, v3, v4);
                        }
                    }
                    
                } else if (tubeShape === 'half-ellipse') {
                    // ===== HALF-ELLIPSE (DOME) TUBE GEOMETRY =====
                    // Creates a rounded road surface - flat bottom touching terrain, domed top
                    // Flatter ellipse: height is 1/4 of width for a more road-like appearance
                    const segments = 8; // Half-circle segments (top half only)
                    const heightRatio = 0.25; // Height is 25% of width (flatter dome)
                    
                    // Step 1: Generate all half-ellipse arch cross-sections along the line path
                    const arches = [];
                    for (let i = 0; i < transformedLineCoords.length; i++) {
                        const [cx, cy] = transformedLineCoords[i];
                        
                        // Calculate perpendicular direction at this point
                        let perpX, perpY;
                        if (i === 0) {
                            const [nx, ny] = transformedLineCoords[i + 1];
                            const dx = nx - cx, dy = ny - cy;
                            const len = Math.sqrt(dx * dx + dy * dy);
                            perpX = -dy / len;
                            perpY = dx / len;
                        } else if (i === transformedLineCoords.length - 1) {
                            const [px, py] = transformedLineCoords[i - 1];
                            const dx = cx - px, dy = cy - py;
                            const len = Math.sqrt(dx * dx + dy * dy);
                            perpX = -dy / len;
                            perpY = dx / len;
                        } else {
                            const [px, py] = transformedLineCoords[i - 1];
                            const [nx, ny] = transformedLineCoords[i + 1];
                            const dx1 = cx - px, dy1 = cy - py;
                            const dx2 = nx - cx, dy2 = ny - cy;
                            const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
                            const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
                            perpX = -(dy1 / len1 + dy2 / len2) / 2;
                            perpY = (dx1 / len1 + dx2 / len2) / 2;
                            const perpLen = Math.sqrt(perpX * perpX + perpY * perpY);
                            perpX /= perpLen;
                            perpY /= perpLen;
                        }
                        
                        arches.push({ cx, cy, perpX, perpY });
                    }
                    
                    // Step 2: Generate vertices for all half-ellipse arches
                    // segments+1 points from angle 0 to PI (left edge to right edge over the top)
                    const archStartIdx = fillVertices.length / VERTEX_STRIDE;
                    const pointsPerArch = segments + 1;
                    
                    for (let i = 0; i < arches.length; i++) {
                        const { cx, cy, perpX, perpY } = arches[i];
                        
                        for (let s = 0; s <= segments; s++) {
                            // Angle from 0 (right edge at ground) to PI (left edge at ground)
                            // Going over the top at PI/2
                            const angle = (s / segments) * Math.PI;
                            const horizontalOffset = Math.cos(angle) * radius; // -radius to +radius
                            const verticalOffset = Math.sin(angle) * radius * heightRatio; // Flatter dome
                            
                            const vx = cx + perpX * horizontalOffset;
                            const vy = cy + perpY * horizontalOffset;
                            
                            // Sample terrain at actual vertex position
                            const terrainZ = terrainData ? sampleTerrainHeight(vx, vy, terrainData) : 0;
                            
                            // Base sits on terrain, dome rises above
                            const vz = baseZ + verticalOffset + terrainZ + lineLayerZOffset;
                            
                            // Normal for ellipse: scale z component by heightRatio for correct lighting
                            const normalX = perpX * Math.cos(angle);
                            const normalY = perpY * Math.cos(angle);
                            const normalZ = Math.sin(angle) / heightRatio; // Adjust for flat ellipse
                            // Normalize the normal vector
                            const nLen = Math.sqrt(normalX * normalX + normalY * normalY + normalZ * normalZ);
                            const archNormal = [normalX / nLen, normalY / nLen, normalZ / nLen];
                            
                            fillVertices.push(vx, vy, vz, ...archNormal, ..._borderColor);
                        }
                    }
                    
                    // Step 3: Connect adjacent arches with quad strips (the dome surface)
                    for (let i = 0; i < arches.length - 1; i++) {
                        const arch1Start = archStartIdx + i * pointsPerArch;
                        const arch2Start = archStartIdx + (i + 1) * pointsPerArch;
                        
                        for (let s = 0; s < segments; s++) {
                            const v1 = arch1Start + s;
                            const v2 = arch1Start + s + 1;
                            const v3 = arch2Start + s + 1;
                            const v4 = arch2Start + s;
                            
                            fillIndices.push(v1, v2, v3);
                            fillIndices.push(v1, v3, v4);
                        }
                    }
                    
                } else {
                    // ===== RECTANGULAR TUBE GEOMETRY (existing code) =====
                    const leftEdge = [];
                    const rightEdge = [];
                
                    for (let i = 0; i < transformedLineCoords.length; i++) {
                        const [x, y] = transformedLineCoords[i];
                        
                        // Calculate perpendicular direction
                        let perpX, perpY;
                        if (i === 0) {
                            // First point - use direction to next point
                            const [nx, ny] = transformedLineCoords[i + 1];
                            const dx = nx - x;
                            const dy = ny - y;
                            const len = Math.sqrt(dx * dx + dy * dy);
                            perpX = -dy / len;
                            perpY = dx / len;
                        } else if (i === transformedLineCoords.length - 1) {
                            // Last point - use direction from previous point
                            const [px, py] = transformedLineCoords[i - 1];
                            const dx = x - px;
                            const dy = y - py;
                            const len = Math.sqrt(dx * dx + dy * dy);
                            perpX = -dy / len;
                            perpY = dx / len;
                        } else {
                            // Middle point - average of incoming and outgoing directions
                            const [px, py] = transformedLineCoords[i - 1];
                            const [nx, ny] = transformedLineCoords[i + 1];
                            const dx1 = x - px, dy1 = y - py;
                            const dx2 = nx - x, dy2 = ny - y;
                            const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
                            const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
                            perpX = -(dy1 / len1 + dy2 / len2) / 2;
                            perpY = (dx1 / len1 + dx2 / len2) / 2;
                            const perpLen = Math.sqrt(perpX * perpX + perpY * perpY);
                            perpX /= perpLen;
                            perpY /= perpLen;
                        }
                        
                        // Sample terrain height at this point
                        const terrainZ = terrainData ? sampleTerrainHeight(x, y, terrainData) : 0;
                        
                        leftEdge.push([x + perpX * radius, y + perpY * radius, terrainZ]);
                        rightEdge.push([x - perpX * radius, y - perpY * radius, terrainZ]);
                    }
                    
                    // Now create the tube geometry using the left/right edges as a closed polygon
                    // Bottom face, top face, and walls around perimeter
                    const tubeStartIndex = fillVertices.length / VERTEX_STRIDE;
                    
                    // Bottom face vertices (left edge + right edge reversed)
                    // Bottom faces point down: normal = [0, 0, -1]
                    const DOWN_NORMAL = [0, 0, -1];
                    const bottomVerts = [];
                    leftEdge.forEach(([x, y, tz]) => {
                        fillVertices.push(x, y, baseZ + tz + lineLayerZOffset, ...DOWN_NORMAL, ..._borderColor);
                        bottomVerts.push(fillVertices.length / VERTEX_STRIDE - 1);
                    });
                    rightEdge.slice().reverse().forEach(([x, y, tz]) => {
                        fillVertices.push(x, y, baseZ + tz + lineLayerZOffset, ...DOWN_NORMAL, ..._borderColor);
                        bottomVerts.push(fillVertices.length / VERTEX_STRIDE - 1);
                    });
                    
                    // Top face vertices (same outline at heightZ + terrain)
                    // Top faces point up: normal = [0, 0, 1]
                    const topVerts = [];
                    leftEdge.forEach(([x, y, tz]) => {
                        fillVertices.push(x, y, heightZ + tz + lineLayerZOffset, ...UP_NORMAL, ..._borderColor);
                        topVerts.push(fillVertices.length / VERTEX_STRIDE - 1);
                    });
                    rightEdge.slice().reverse().forEach(([x, y, tz]) => {
                        fillVertices.push(x, y, heightZ + tz + lineLayerZOffset, ...UP_NORMAL, ..._borderColor);
                        topVerts.push(fillVertices.length / VERTEX_STRIDE - 1);
                    });
                    
                    // Triangulate bottom and top faces using triangle fan from center
                    // This is more robust than earcut for potentially self-intersecting polygons
                    
                    // Calculate center point for bottom face
                    let bottomCenterX = 0, bottomCenterY = 0;
                    const allBottomEdgePoints = [...leftEdge, ...rightEdge];
                    allBottomEdgePoints.forEach(([x, y]) => {
                        bottomCenterX += x;
                        bottomCenterY += y;
                    });
                    bottomCenterX /= allBottomEdgePoints.length;
                    bottomCenterY /= allBottomEdgePoints.length;
                    
                    // Sample terrain at center
                    const centerTerrainZ = terrainData ? sampleTerrainHeight(bottomCenterX, bottomCenterY, terrainData) : 0;
                    
                    // Add center vertices for bottom and top
                    const bottomCenterIdx = fillVertices.length / VERTEX_STRIDE;
                    fillVertices.push(bottomCenterX, bottomCenterY, baseZ + centerTerrainZ + lineLayerZOffset, ...DOWN_NORMAL, ..._borderColor);
                    const topCenterIdx = fillVertices.length / VERTEX_STRIDE;
                    fillVertices.push(bottomCenterX, bottomCenterY, heightZ + centerTerrainZ + lineLayerZOffset, ...UP_NORMAL, ..._borderColor);
                    
                    // Create bottom face triangles (center to each edge, reversed winding for downward)
                    const numBottomVerts = bottomVerts.length;
                    for (let i = 0; i < numBottomVerts; i++) {
                        const next = (i + 1) % numBottomVerts;
                        fillIndices.push(bottomCenterIdx, bottomVerts[next], bottomVerts[i]);
                    }
                    
                    // Create top face triangles (center to each edge, normal winding for upward)
                    const numTopVerts = topVerts.length;
                    for (let i = 0; i < numTopVerts; i++) {
                        const next = (i + 1) % numTopVerts;
                        fillIndices.push(topCenterIdx, topVerts[i], topVerts[next]);
                    }
                    
                    // Create walls around the perimeter with proper normals
                    const createWall = (edge, isLeftSide) => {
                        for (let i = 0; i < edge.length - 1; i++) {
                            const [x1, y1, tz1] = edge[i];
                            const [x2, y2, tz2] = edge[i + 1];
                            
                            // Calculate wall normal (perpendicular to wall edge, pointing outward)
                            const dx = x2 - x1, dy = y2 - y1;
                            const len = Math.sqrt(dx * dx + dy * dy);
                            // Left wall normals point left, right wall normals point right
                            const sign = isLeftSide ? 1 : -1;
                            const wallNormal = len > 0 ? [-dy / len * sign, dx / len * sign, 0] : [1, 0, 0];
                            
                            const vOff = fillVertices.length / VERTEX_STRIDE;
                            // Add terrain height and layer offset to wall vertices
                            fillVertices.push(x1, y1, baseZ + tz1 + lineLayerZOffset, ...wallNormal, ..._borderColor);
                            fillVertices.push(x2, y2, baseZ + tz2 + lineLayerZOffset, ...wallNormal, ..._borderColor);
                            fillVertices.push(x2, y2, heightZ + tz2 + lineLayerZOffset, ...wallNormal, ..._borderColor);
                            fillVertices.push(x1, y1, heightZ + tz1 + lineLayerZOffset, ...wallNormal, ..._borderColor);
                            
                            fillIndices.push(vOff, vOff + 1, vOff + 2, vOff, vOff + 2, vOff + 3);
                        }
                    };
                    
                    createWall(leftEdge, true);
                    createWall(rightEdge, false);
                    
                    // Add front and back cap walls to close the tube
                    if (leftEdge.length > 0 && rightEdge.length > 0) {
                        // Front cap (start of tube)
                        const [lx0, ly0, ltz0] = leftEdge[0];
                        const [rx0, ry0, rtz0] = rightEdge[0];
                        const frontVOff = fillVertices.length / VERTEX_STRIDE;
                        // Calculate front normal (pointing backward along path)
                        const [lx1, ly1] = leftEdge[1];
                        const fdx = lx0 - lx1, fdy = ly0 - ly1;
                        const flen = Math.sqrt(fdx * fdx + fdy * fdy);
                        const frontNormal = flen > 0 ? [fdx / flen, fdy / flen, 0] : [-1, 0, 0];
                        
                        fillVertices.push(lx0, ly0, baseZ + ltz0 + lineLayerZOffset, ...frontNormal, ..._borderColor);
                        fillVertices.push(rx0, ry0, baseZ + rtz0 + lineLayerZOffset, ...frontNormal, ..._borderColor);
                        fillVertices.push(rx0, ry0, heightZ + rtz0 + lineLayerZOffset, ...frontNormal, ..._borderColor);
                        fillVertices.push(lx0, ly0, heightZ + ltz0 + lineLayerZOffset, ...frontNormal, ..._borderColor);
                        fillIndices.push(frontVOff, frontVOff + 1, frontVOff + 2, frontVOff, frontVOff + 2, frontVOff + 3);
                        
                        // Back cap (end of tube)
                        const lastIdx = leftEdge.length - 1;
                        const [lxN, lyN, ltzN] = leftEdge[lastIdx];
                        const [rxN, ryN, rtzN] = rightEdge[lastIdx];
                        const backVOff = fillVertices.length / VERTEX_STRIDE;
                        // Calculate back normal (pointing forward along path)
                        const [lxP, lyP] = leftEdge[lastIdx - 1];
                        const bdx = lxN - lxP, bdy = lyN - lyP;
                        const blen = Math.sqrt(bdx * bdx + bdy * bdy);
                        const backNormal = blen > 0 ? [bdx / blen, bdy / blen, 0] : [1, 0, 0];
                        
                        fillVertices.push(lxN, lyN, baseZ + ltzN + lineLayerZOffset, ...backNormal, ..._borderColor);
                        fillVertices.push(rxN, ryN, baseZ + rtzN + lineLayerZOffset, ...backNormal, ..._borderColor);
                        fillVertices.push(rxN, ryN, heightZ + rtzN + lineLayerZOffset, ...backNormal, ..._borderColor);
                        fillVertices.push(lxN, lyN, heightZ + ltzN + lineLayerZOffset, ...backNormal, ..._borderColor);
                        fillIndices.push(backVOff, backVOff + 2, backVOff + 1, backVOff, backVOff + 3, backVOff + 2);
                    }
                }
                
            } else {
                // Regular flat 2D line rendering - sample terrain at CENTERLINE for each vertex
                // This prevents Z-fighting: left and right edges share the same terrain height
                // Layer Z offset ensures proper stacking via z-buffer
                const lineStartIndex = fillVertices.length / VERTEX_STRIDE;
                const lineLayerIdx = getLayerIndex(layerId);
                const lineLayerZOffset = lineLayerIdx * 0.00000005;
                
                for (let i = 0; i < tessellated.vertices.length; i += 2) {
                    const x = tessellated.vertices[i];
                    const y = tessellated.vertices[i + 1];
                    // Sample terrain at centerline position, not at vertex edge position
                    const centerlineX = tessellated.centerlines[i];
                    const centerlineY = tessellated.centerlines[i + 1];
                    const terrainZ = terrainData ? sampleTerrainHeight(centerlineX, centerlineY, terrainData) : 0.0;
                    // Add layer offset for proper z-buffer ordering
                    const z = terrainZ + lineLayerZOffset;
                    fillVertices.push(
                        x,             // x (edge position)
                        y,             // y (edge position)
                        z,             // z sampled at centerline + layer offset
                        ...UP_NORMAL,  // Normal (flat lines point up)
                        ..._borderColor               // color
                    );
                }
                
                // Add indices for flat line
                for (let i = 0; i < tessellated.indices.length; i++) {
                    fillIndices.push(lineStartIndex + tessellated.indices[i]);
                }
                
                // Generate hidden buffer for line picking (CRITICAL - was missing!)
                const hiddenLineStartIndex = hiddenVertices.length / VERTEX_STRIDE;
                const safeId = Math.max(1, Math.min(65534, clampedFeatureId || 1));
                const highByte = Math.floor(safeId / 256);
                const lowByte = safeId % 256;
                const normalizedR = highByte / 255.0;
                const normalizedG = lowByte / 255.0;
                const hiddenLayerIdx = getLayerIndex(layerId);
                const normalizedB = hiddenLayerIdx / 255.0;
                const hiddenLayerZOffset = hiddenLayerIdx * 0.00000005;
                
                for (let i = 0; i < tessellated.vertices.length; i += 2) {
                    // Sample terrain at centerline for hidden buffer too
                    const centerlineX = tessellated.centerlines[i];
                    const centerlineY = tessellated.centerlines[i + 1];
                    const terrainZ = terrainData ? sampleTerrainHeight(centerlineX, centerlineY, terrainData) : 0.0;
                    // Add layer offset for consistent z-buffer ordering
                    const z = terrainZ + hiddenLayerZOffset;
                    hiddenVertices.push(
                        tessellated.vertices[i],     // x
                        tessellated.vertices[i + 1], // y
                        z,                           // z from centerline terrain + layer offset
                        ...UP_NORMAL,                // Normal
                        normalizedR, normalizedG, normalizedB, 1.0  // R+G=ID, B=layerID
                    );
                }
                
                // Add hidden indices for line picking
                for (let i = 0; i < tessellated.indices.length; i++) {
                    hiddenfillIndices.push(hiddenLineStartIndex + tessellated.indices[i]);
                }
            }
            break;
        case 'MultiLineString':
            isFilled = false;
            isLine = true;
            
            //console.log(`🛣️ MultiLineString with ${feature.geometry.coordinates.length} lines`);
            
            // Get line width and style properties for MultiLineString
            let multiLineWidth = 1;
            let multiLineCap = 'round';
            let multiLineJoin = 'round';
            let multiMiterLimit = 2;
            
            if (style && sourceId) {
                const layers = getLayersBySource(sourceId);
                const lineLayer = layers.find(l => 
                    (l.type === 'line' || l.type === 'line-extrusion') &&  // Check for BOTH line types
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
            
            // Check if this is a line-extrusion layer (needs 3D tube geometry)
            const isMultiLineExtrusion = style && sourceId && getLayersBySource(sourceId).some(l =>
                (l.type === 'line-extrusion' || l.metadata?.['render-as-tubes'] === true) &&
                l.id === layerId
            );
            
            // Convert line width from pixels to world space
            const multiWorldWidth = screenWidthToWorld(multiLineWidth, zoom, 512);
            
            // Store centerlines for GPU compute terrain projection
            feature.geometry.coordinates.forEach(line => {
                lineCenterlines.push({
                    coordinates: line, // Raw coordinates (not subdivided)
                    width: multiWorldWidth,
                    color: _borderColor,
                    featureId: clampedFeatureId,
                    layerId: layerId
                });
            });
            
            // Pre-compute ID encoding for hidden buffer (same for all lines in this feature)
            const multiSafeId = Math.max(1, Math.min(65534, clampedFeatureId || 1));
            const multiHighByte = Math.floor(multiSafeId / 256);
            const multiLowByte = multiSafeId % 256;
            const multiNormalizedR = multiHighByte / 255.0;
            const multiNormalizedG = multiLowByte / 255.0;
            const multiLayerIdx = getLayerIndex(layerId);
            const multiNormalizedB = multiLayerIdx / 255.0;
            const multiLayerZOffset = multiLayerIdx * 0.00000005;
            
            if (isMultiLineExtrusion) {
                // Get extrusion parameters for MultiLineString
                const tubeShape = style?.layers?.find(l => l.id === layerId)?.metadata?.['tube-shape'] || 'rectangular';
                const lineExtrusionHeight = getPaintProperty(layerId, 'line-extrusion-height', feature, zoom) || 10;
                const lineExtrusionBase = getPaintProperty(layerId, 'line-extrusion-base', feature, zoom) || 0;
                
                // Use multiWorldWidth for proper tube width
                const radius = multiWorldWidth / 2;
                const heightZ = lineExtrusionHeight * zoomExtrusion;
                const baseZ = lineExtrusionBase * zoomExtrusion;
                
                // Process each line in the MultiLineString with extrusion
                feature.geometry.coordinates.forEach(line => {
                    // Subdivide for terrain sampling - zoom-dependent threshold (~20 points per tile)
                    const subdivisionThreshold = 1 / (Math.pow(2, zoom - 1) * 10);
                    const transformedLine = subdivideLine(line, subdivisionThreshold);
                    
                    if (tubeShape === 'circular') {
                        // ===== CIRCULAR TUBE for MultiLineString =====
                        const segments = 12;
                        
                        // Generate circle cross-sections along the line
                        const circles = [];
                        for (let i = 0; i < transformedLine.length; i++) {
                            const [cx, cy] = transformedLine[i];
                            
                            let perpX, perpY;
                            if (i === 0) {
                                const [nx, ny] = transformedLine[i + 1];
                                const dx = nx - cx, dy = ny - cy;
                                const len = Math.sqrt(dx * dx + dy * dy);
                                perpX = -dy / len;
                                perpY = dx / len;
                            } else if (i === transformedLine.length - 1) {
                                const [px, py] = transformedLine[i - 1];
                                const dx = cx - px, dy = cy - py;
                                const len = Math.sqrt(dx * dx + dy * dy);
                                perpX = -dy / len;
                                perpY = dx / len;
                            } else {
                                const [px, py] = transformedLine[i - 1];
                                const [nx, ny] = transformedLine[i + 1];
                                const dx1 = cx - px, dy1 = cy - py;
                                const dx2 = nx - cx, dy2 = ny - cy;
                                const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
                                const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
                                perpX = -(dy1 / len1 + dy2 / len2) / 2;
                                perpY = (dx1 / len1 + dx2 / len2) / 2;
                                const perpLen = Math.sqrt(perpX * perpX + perpY * perpY);
                                perpX /= perpLen;
                                perpY /= perpLen;
                            }
                            
                            const terrainZ = terrainData ? sampleTerrainHeight(cx, cy, terrainData) : 0;
                            circles.push({ cx, cy, perpX, perpY, terrainZ });
                        }
                        
                        // Generate vertices for all circles
                        const circleStartIdx = fillVertices.length / VERTEX_STRIDE;
                        for (let i = 0; i < circles.length; i++) {
                            const { cx, cy, perpX, perpY } = circles[i];
                            
                            for (let s = 0; s < segments; s++) {
                                const angle = (s / segments) * Math.PI * 2;
                                const horizontalOffset = Math.cos(angle) * radius;
                                const verticalOffset = Math.sin(angle) * radius;
                                
                                const vx = cx + perpX * horizontalOffset;
                                const vy = cy + perpY * horizontalOffset;
                                
                                // Sample terrain at actual vertex position for consistency with polygons
                                const terrainZ = terrainData ? sampleTerrainHeight(vx, vy, terrainData) : 0;
                                
                                const vz = (baseZ + heightZ) / 2 + verticalOffset + terrainZ + multiLayerZOffset;
                                
                                const normalX = perpX * Math.cos(angle);
                                const normalY = perpY * Math.cos(angle);
                                const normalZ = Math.sin(angle);
                                const tubeNormal = [normalX, normalY, normalZ];
                                
                                fillVertices.push(vx, vy, vz, ...tubeNormal, ..._borderColor);
                            }
                        }
                        
                        // Connect adjacent circles with quad strips
                        for (let i = 0; i < circles.length - 1; i++) {
                            const ring1Start = circleStartIdx + i * segments;
                            const ring2Start = circleStartIdx + (i + 1) * segments;
                            
                            for (let s = 0; s < segments; s++) {
                                const next = (s + 1) % segments;
                                const v1 = ring1Start + s;
                                const v2 = ring1Start + next;
                                const v3 = ring2Start + next;
                                const v4 = ring2Start + s;
                                
                                fillIndices.push(v1, v2, v3);
                                fillIndices.push(v1, v3, v4);
                            }
                        }
                        
                    } else if (tubeShape === 'half-ellipse') {
                        // ===== HALF-ELLIPSE (DOME) TUBE for MultiLineString =====
                        // Creates a rounded road surface - flat bottom, domed top
                        // Flatter ellipse: height is 1/4 of width for a more road-like appearance
                        const segments = 8; // Half-circle segments (top half only)
                        const heightRatio = 0.25; // Height is 25% of width (flatter dome)
                        
                        // Generate half-ellipse cross-sections along the line
                        const arches = [];
                        for (let i = 0; i < transformedLine.length; i++) {
                            const [cx, cy] = transformedLine[i];
                            
                            let perpX, perpY;
                            if (i === 0) {
                                const [nx, ny] = transformedLine[i + 1];
                                const dx = nx - cx, dy = ny - cy;
                                const len = Math.sqrt(dx * dx + dy * dy);
                                perpX = -dy / len;
                                perpY = dx / len;
                            } else if (i === transformedLine.length - 1) {
                                const [px, py] = transformedLine[i - 1];
                                const dx = cx - px, dy = cy - py;
                                const len = Math.sqrt(dx * dx + dy * dy);
                                perpX = -dy / len;
                                perpY = dx / len;
                            } else {
                                const [px, py] = transformedLine[i - 1];
                                const [nx, ny] = transformedLine[i + 1];
                                const dx1 = cx - px, dy1 = cy - py;
                                const dx2 = nx - cx, dy2 = ny - cy;
                                const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
                                const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
                                perpX = -(dy1 / len1 + dy2 / len2) / 2;
                                perpY = (dx1 / len1 + dx2 / len2) / 2;
                                const perpLen = Math.sqrt(perpX * perpX + perpY * perpY);
                                perpX /= perpLen;
                                perpY /= perpLen;
                            }
                            
                            const terrainZ = terrainData ? sampleTerrainHeight(cx, cy, terrainData) : 0;
                            arches.push({ cx, cy, perpX, perpY, terrainZ });
                        }
                        
                        // Generate vertices for all half-ellipse arches
                        // segments+1 points from angle 0 to PI (left edge to right edge over the top)
                        const archStartIdx = fillVertices.length / VERTEX_STRIDE;
                        const pointsPerArch = segments + 1;
                        
                        for (let i = 0; i < arches.length; i++) {
                            const { cx, cy, perpX, perpY } = arches[i];
                            
                            for (let s = 0; s <= segments; s++) {
                                // Angle from 0 (right/left edge at ground) to PI (other edge at ground)
                                // Going over the top at PI/2
                                const angle = (s / segments) * Math.PI;
                                const horizontalOffset = Math.cos(angle) * radius; // -radius to +radius
                                const verticalOffset = Math.sin(angle) * radius * heightRatio; // Flatter dome
                                
                                const vx = cx + perpX * horizontalOffset;
                                const vy = cy + perpY * horizontalOffset;
                                
                                // Sample terrain at actual vertex position
                                const terrainZ = terrainData ? sampleTerrainHeight(vx, vy, terrainData) : 0;
                                
                                // Base sits on terrain, dome rises above
                                const vz = baseZ + verticalOffset + terrainZ + multiLayerZOffset;
                                
                                // Normal for ellipse: scale z component by heightRatio for correct lighting
                                const normalX = perpX * Math.cos(angle);
                                const normalY = perpY * Math.cos(angle);
                                const normalZ = Math.sin(angle) / heightRatio; // Adjust for flat ellipse
                                // Normalize the normal vector
                                const nLen = Math.sqrt(normalX * normalX + normalY * normalY + normalZ * normalZ);
                                const archNormal = [normalX / nLen, normalY / nLen, normalZ / nLen];
                                
                                fillVertices.push(vx, vy, vz, ...archNormal, ..._borderColor);
                            }
                        }
                        
                        // Connect adjacent arches with quad strips (the dome surface)
                        for (let i = 0; i < arches.length - 1; i++) {
                            const arch1Start = archStartIdx + i * pointsPerArch;
                            const arch2Start = archStartIdx + (i + 1) * pointsPerArch;
                            
                            for (let s = 0; s < segments; s++) {
                                const v1 = arch1Start + s;
                                const v2 = arch1Start + s + 1;
                                const v3 = arch2Start + s + 1;
                                const v4 = arch2Start + s;
                                
                                fillIndices.push(v1, v2, v3);
                                fillIndices.push(v1, v3, v4);
                            }
                        }
                        
                    } else if (tubeShape === 'rectangular') {
                        // Generate rectangular tube for each line segment
                        const leftEdge = [];
                        const rightEdge = [];
                        
                        for (let i = 0; i < transformedLine.length; i++) {
                            const [x, y] = transformedLine[i];
                            let perpX, perpY;
                            
                            if (i === 0) {
                                const [nx, ny] = transformedLine[i + 1];
                                const dx = nx - x, dy = ny - y;
                                const len = Math.sqrt(dx * dx + dy * dy);
                                perpX = -dy / len;
                                perpY = dx / len;
                            } else if (i === transformedLine.length - 1) {
                                const [px, py] = transformedLine[i - 1];
                                const dx = x - px, dy = y - py;
                                const len = Math.sqrt(dx * dx + dy * dy);
                                perpX = -dy / len;
                                perpY = dx / len;
                            } else {
                                const [px, py] = transformedLine[i - 1];
                                const [nx, ny] = transformedLine[i + 1];
                                const dx1 = x - px, dy1 = y - py;
                                const dx2 = nx - x, dy2 = ny - y;
                                const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
                                const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
                                perpX = -(dy1 / len1 + dy2 / len2) / 2;
                                perpY = (dx1 / len1 + dx2 / len2) / 2;
                                const perpLen = Math.sqrt(perpX * perpX + perpY * perpY);
                                perpX /= perpLen;
                                perpY /= perpLen;
                            }
                            
                            const terrainZ = terrainData ? sampleTerrainHeight(x, y, terrainData) : 0;
                            leftEdge.push([x + perpX * radius, y + perpY * radius, terrainZ]);
                            rightEdge.push([x - perpX * radius, y - perpY * radius, terrainZ]);
                        }
                        
                        // Create tube walls
                        const createWall = (edge, isLeftSide) => {
                            for (let i = 0; i < edge.length - 1; i++) {
                                const [x1, y1, tz1] = edge[i];
                                const [x2, y2, tz2] = edge[i + 1];
                                const dx = x2 - x1, dy = y2 - y1;
                                const len = Math.sqrt(dx * dx + dy * dy);
                                const sign = isLeftSide ? 1 : -1;
                                const wallNormal = len > 0 ? [-dy / len * sign, dx / len * sign, 0] : [1, 0, 0];
                                
                                const vOff = fillVertices.length / VERTEX_STRIDE;
                                fillVertices.push(x1, y1, baseZ + tz1 + multiLayerZOffset, ...wallNormal, ..._borderColor);
                                fillVertices.push(x2, y2, baseZ + tz2 + multiLayerZOffset, ...wallNormal, ..._borderColor);
                                fillVertices.push(x2, y2, heightZ + tz2 + multiLayerZOffset, ...wallNormal, ..._borderColor);
                                fillVertices.push(x1, y1, heightZ + tz1 + multiLayerZOffset, ...wallNormal, ..._borderColor);
                                
                                fillIndices.push(vOff, vOff + 1, vOff + 2, vOff, vOff + 2, vOff + 3);
                            }
                        };
                        
                        createWall(leftEdge, true);
                        createWall(rightEdge, false);
                    }
                });
            } else {
                // Flat 2D rendering for MultiLineString
                feature.geometry.coordinates.forEach(line => {
                // Coordinates are already transformed
                // Subdivide long segments for proper terrain height sampling - zoom-dependent (~20 points per tile)
                const subdivisionThreshold = 1 / (Math.pow(2, zoom - 1) * 10);
                const transformedLine = subdivideLine(line, subdivisionThreshold);
                
                // Tessellate each line
                const lineTessellated = tessellateLine(transformedLine, multiWorldWidth, multiLineCap, multiLineJoin, multiMiterLimit);
                
                // Add tessellated vertices with terrain height sampled at CENTERLINE + layer offset
                const multiLineStartIndex = fillVertices.length / VERTEX_STRIDE;
                for (let i = 0; i < lineTessellated.vertices.length; i += 2) {
                    const x = lineTessellated.vertices[i];
                    const y = lineTessellated.vertices[i + 1];
                    // Sample terrain at centerline position, not at vertex edge position
                    const centerlineX = lineTessellated.centerlines[i];
                    const centerlineY = lineTessellated.centerlines[i + 1];
                    const terrainZ = terrainData ? sampleTerrainHeight(centerlineX, centerlineY, terrainData) : 0.0;
                    const z = terrainZ + multiLayerZOffset;
                    fillVertices.push(x, y, z, ...UP_NORMAL, ..._borderColor);
                }
                
                // Add triangle indices
                lineTessellated.indices.forEach(idx => {
                    fillIndices.push(multiLineStartIndex + idx);
                });
                
                // Generate hidden buffer for line picking with terrain height + layer offset
                const hiddenMultiLineStartIndex = hiddenVertices.length / VERTEX_STRIDE;
                for (let i = 0; i < lineTessellated.vertices.length; i += 2) {
                    const x = lineTessellated.vertices[i];
                    const y = lineTessellated.vertices[i + 1];
                    const centerlineX = lineTessellated.centerlines[i];
                    const centerlineY = lineTessellated.centerlines[i + 1];
                    const terrainZ = terrainData ? sampleTerrainHeight(centerlineX, centerlineY, terrainData) : 0.0;
                    const z = terrainZ + multiLayerZOffset;
                    hiddenVertices.push(x, y, z, ...UP_NORMAL, multiNormalizedR, multiNormalizedG, multiNormalizedB, 1.0);
                }
                
                // Add hidden indices for line picking
                lineTessellated.indices.forEach(idx => {
                    hiddenfillIndices.push(hiddenMultiLineStartIndex + idx);
                });
            });
            } // End of flat 2D rendering for MultiLineString
            break;
        case 'Point':
            const point = feature.geometry.coordinates; // Already transformed!
            const pointZ = terrainData ? sampleTerrainHeight(point[0], point[1], terrainData) : 0.0;
            fillVertices.push(point[0], point[1], pointZ, ...UP_NORMAL, ..._fillColor);
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
        lineSegments: lineSegments.length > 0 ? lineSegments : null, // For 3D tube rendering
        lineCenterlines: lineCenterlines.length > 0 ? lineCenterlines : null, // For GPU compute terrain projection
        terrainPolygons: terrainPolygons.length > 0 ? terrainPolygons : null, // For terrain-based polygon rendering
        isFilled,
        isLine,
        layerId,  // Add layerId to return object
        extrusionHeight: isExtruded ? extrusionHeight : 0,  // Return height for tracking
        featureId: clampedFeatureId,  // Return feature ID for max height tracking
        properties: {
            ...feature.properties,
            fid: originalFeatureId,           // Original feature ID from tileset
            clampedFid: clampedFeatureId,  // ID actually used in rendering (1-65534)
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
    resetFeatureIdCounter(); // Reset IDs when cache is cleared
}

// Reset the not-found tiles tracking
export function resetNotFoundTiles() {
    notFoundTiles.clear();
}
