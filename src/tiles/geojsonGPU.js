// GPU-Accelerated GeoJSON Parser
// This file provides enhanced parsing functions that use GPU compute shaders for coordinate transformation

import { hexToRgb } from '../core/utils.js';
import { getColorOfCountries } from '../core/utils.js';
import { getGlobalCoordinateTransformer } from '../core/coordinateGPU.js';
import earcut from 'earcut';
import { tessellateLine, screenWidthToWorld } from './line-tessellation-simple.js';
import { 
    getStyle, 
    getFeatureId as getStyleFeatureId, 
    getPaintProperty, 
    parseColor,
    evaluateFilter,
    getLayersBySource
} from '../core/style.js';

// Enhanced parseGeoJSONFeature that uses GPU coordinate transformation
export async function parseGeoJSONFeatureGPU(feature, device, fillColor = [0.0, 0.0, 0.0, 1.0], sourceId = null, zoom = 0) {
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
    
    // Extrusion properties (for 3D buildings)
    let extrusionHeight = 0;
    let extrusionBase = 0;
    let isExtruded = false;

    if (style && sourceId) {
        // Get layers for this source
        const layers = getLayersBySource(sourceId);
        
        // Find extrusion layer first (higher priority for 3D buildings)
        const extrusionLayer = layers.find(l => 
            l.type === 'fill-extrusion' && 
            (!l['source-layer'] || l['source-layer'] === feature.layer?.name)
        );
        
        // Find fill layer as fallback
        const fillLayer = extrusionLayer || layers.find(l => 
            l.type === 'fill' && 
            (!l['source-layer'] || l['source-layer'] === feature.layer?.name)
        );
        
        const lineLayer = layers.find(l => 
            l.type === 'line' && 
            (!l['source-layer'] || l['source-layer'] === feature.layer?.name)
        );

        // Get extrusion properties if this is a 3D layer
        if (extrusionLayer) {
            // Check minzoom/maxzoom constraints
            const minZoom = extrusionLayer.minzoom !== undefined ? extrusionLayer.minzoom : 0;
            const maxZoom = extrusionLayer.maxzoom !== undefined ? extrusionLayer.maxzoom : 24;
            
            if (zoom >= minZoom && zoom <= maxZoom) {
                isExtruded = true;
                const heightValue = getPaintProperty(extrusionLayer.id, 'fill-extrusion-height', feature, zoom);
                const baseValue = getPaintProperty(extrusionLayer.id, 'fill-extrusion-base', feature, zoom);
                extrusionHeight = typeof heightValue === 'number' ? heightValue : 0;
                extrusionBase = typeof baseValue === 'number' ? baseValue : 0;
            }
        }

        // Apply filter if layer has one
        if (fillLayer && fillLayer.filter && !evaluateFilter(fillLayer.filter, feature, zoom)) {
            return null; // Feature filtered out
        }

        // Get paint properties from style
        if (fillLayer) {
            const colorProperty = extrusionLayer ? 'fill-extrusion-color' : 'fill-color';
            const fillColorValue = getPaintProperty(fillLayer.id, colorProperty, feature, zoom);
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
        if (style && sourceId) {
            return getStyleFeatureId(feature, sourceId);
        }
        // Legacy fallback
        const rawId = parseInt(feature.properties?.fid || feature.id) || 1;
        return rawId;
    };

    // Get GPU coordinate transformer
    const transformer = getGlobalCoordinateTransformer(device);
    await transformer.initialize();

    // Extract all coordinates from the feature geometry
    const allCoordinates = transformer.extractCoordinatesFromGeometry(feature.geometry);
    
    // Transform all coordinates in a single GPU batch operation
    let transformedCoords = [];
    if (allCoordinates.length > 0) {
        transformedCoords = await transformer.transformCoordinates(allCoordinates);
    }

    // Create a mapping from original coordinates to transformed coordinates
    const coordMap = new Map();
    allCoordinates.forEach((originalCoord, index) => {
        const key = `${originalCoord[0]},${originalCoord[1]}`;
        coordMap.set(key, transformedCoords[index]);
    });

    // Helper function to get transformed coordinate
    const getTransformedCoord = (coord) => {
        const key = `${coord[0]},${coord[1]}`;
        return coordMap.get(key) || [0, 0]; // Fallback to origin if not found
    };

    // Create vertex arrays using transformed coordinates
    const coordsToVertices = (coords, color, targetArray) => {
        const vertexStartIndex = targetArray.length / 7;
        coords.forEach(coord => {
            const [x, y] = getTransformedCoord(coord);
            targetArray.push(
                x, y, 0.0, // Position (z=0 for flat map)
                ...color   // Color
            );
        });
        return vertexStartIndex;
    };

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
            const [x, y] = getTransformedCoord(coord);
            targetArray.push(
                x, y, 0.0,        // Position (z=0 for flat map)
                normalizedR, normalizedG, 0.0, 1.0  // 16-bit ID in R+G channels
            );
        });
        return vertexStartIndex;
    };

    // Helper function to generate 3D extrusion geometry (walls + roof)
    const generateExtrusion = (outerRing, height, base) => {
        const vertices = [];
        const indices = [];
        
        // Convert meters to world space units
        // At zoom 0, the entire world spans -1 to 1 (2 units total)
        // Earth circumference ≈ 40,000,000m, so at zoom 0: 1 unit = 20,000,000m
        // Scale factor: meters * (2.0 / 40000000) = meters * 0.00000005
        // But we want height to scale with zoom level, so we use a zoom-independent metric
        // Buildings should be visible but not dominate - use a moderate scale
        const metersToWorld = 0.00000008; // Tuned for visibility
        const heightZ = height * metersToWorld;
        const baseZ = base * metersToWorld;
        
       
        // Generate vertical walls for each edge
        for (let i = 0; i < outerRing.length - 1; i++) {
            const p1 = outerRing[i];
            const p2 = outerRing[i + 1];
            const [x1, y1] = getTransformedCoord(p1);
            const [x2, y2] = getTransformedCoord(p2);
            
            const baseIdx = vertices.length / 7;
            
            // Bottom-left, bottom-right, top-right, top-left
            vertices.push(x1, y1, baseZ, ..._fillColor);
            vertices.push(x2, y2, baseZ, ..._fillColor);
            vertices.push(x2, y2, heightZ, ..._fillColor);
            vertices.push(x1, y1, heightZ, ..._fillColor);
            
            // Two triangles for wall quad
            indices.push(baseIdx, baseIdx + 1, baseIdx + 2);
            indices.push(baseIdx, baseIdx + 2, baseIdx + 3);
        }
        
        // Generate roof (flat top polygon at height)
        // CRITICAL: Use transformed coordinates for BOTH earcut AND vertices
        const flatCoords = [];
        const transformedRoofCoords = [];
        
        outerRing.forEach(coord => {
            const [x, y] = getTransformedCoord(coord);
            flatCoords.push(x, y);  // Use transformed coords for earcut
            transformedRoofCoords.push([x, y]);
        });
        
        const roofTriangles = earcut(flatCoords, []);
        const roofStartIdx = vertices.length / 7;
        
        if (!window._roofDebug) {
            console.log(`🟢 ROOF: ${roofTriangles.length/3} triangles, heightZ=${heightZ.toFixed(6)}, vertices at z=${heightZ.toFixed(6)}`);
            window._roofDebug = true;
        }
        
        transformedRoofCoords.forEach(([x, y]) => {
            vertices.push(x, y, heightZ, ..._fillColor);
        });
        
        roofTriangles.forEach(idx => {
            indices.push(roofStartIdx + idx);
        });
        
        return { vertices, indices };
    };

    // Deduplicate features by tracking processed feature IDs
    const processedFeatures = new Set();
    const featureId = getFeatureId();
    
    // Clamp feature ID to valid range for 16-bit encoding (1-65534)
    const clampedFeatureId = Math.max(1, Math.min(65534, featureId));
    
    if (processedFeatures.has(featureId)) {
        return null;
    }
    processedFeatures.add(featureId);

    if (!window._geomTypeLogged) {
        console.log(`🔍 Feature geometry type: ${feature.geometry.type}`);
        window._geomTypeLogged = true;
    }

    switch (feature.geometry.type) {
        case 'Polygon':
            // Combine all rings into a single array with holes
            const coordinates = feature.geometry.coordinates;
            const outerRing = coordinates[0];
            const holes = coordinates.slice(1);
            
            // Use extrusion geometry if this is a 3D layer
            if (isExtruded && extrusionHeight > 0) {
                // Skip - batch parser handles buildings
                return null;
            } else {
                // Standard 2D fill
                if (!window._2dFillLogged) {
                    console.log(`📐 Taking 2D FILL path: isExtruded=${isExtruded}, height=${extrusionHeight}`);
                    window._2dFillLogged = true;
                }
                // Flatten TRANSFORMED coordinates for triangulation
                const flatCoords = [];
                const holeIndices = [];
                
                // Add outer ring with transformed coords
                outerRing.forEach(coord => {
                    const [x, y] = getTransformedCoord(coord);
                    flatCoords.push(x, y);
                });
                
                if (!window._coordCheckLogged && outerRing.length >= 7) {
                    console.log(`🔍 Polygon has ${outerRing.length} vertices in GeoJSON`);
                    console.log(`   First 5 raw coords:`, outerRing.slice(0, 5));
                    console.log(`   Transformed to ${flatCoords.length / 2} vertices`);
                    console.log(`   First 10 flatCoords:`, flatCoords.slice(0, 10));
                    window._coordCheckLogged = true;
                }
                
                // Add holes and store their starting indices
                holes.forEach(hole => {
                    holeIndices.push(flatCoords.length / 2);
                    hole.forEach(coord => {
                        const [x, y] = getTransformedCoord(coord);
                        flatCoords.push(x, y);
                    });
                });

                // Triangulate with holes
                if (!window._preEarcutLogged) {
                    console.log(`🔺 About to call earcut:`);
                    console.log(`   flatCoords length: ${flatCoords.length}, first 20:`, flatCoords.slice(0, 20));
                    console.log(`   holeIndices:`, holeIndices);
                    window._preEarcutLogged = true;
                }
                
                const triangles = earcut(flatCoords, holeIndices.length > 0 ? holeIndices : null);
                
                if (triangles.length === 0 && !window._earcutFailLogged) {
                    console.log(`🔺 Earcut FAILED: ${flatCoords.length / 2} vertices, flatCoords:`, flatCoords.slice(0, 20));
                    console.log(`   All unique?`, new Set(flatCoords).size, 'unique values out of', flatCoords.length);
                    window._earcutFailLogged = true;
                }
                
                if (!window._earcutLogged && flatCoords.length >= 18) {
                    console.log(`🔺 Earcut: ${flatCoords.length / 2} vertices → ${triangles.length / 3} triangles`);
                    console.log(`   First 10 coords:`, flatCoords.slice(0, 20));
                    window._earcutLogged = true;
                }

                // Add vertices for the entire polygon
                const allCoords = coordinates.flat(1);
                const fillStartIndex = coordsToVertices(allCoords, _fillColor, fillVertices);
                const hiddenStartIndex = coordsToIdVertices(allCoords, 
                    clampedFeatureId,  // Use clamped ID for consistency
                    hiddenVertices
                );

                // Add triangle indices
                triangles.forEach(index => {
                    fillIndices.push(fillStartIndex + index);
                    hiddenfillIndices.push(hiddenStartIndex + index);
                });
            }
            break;

        case 'MultiPolygon':
            // Process each polygon's outer ring and holes
            feature.geometry.coordinates.forEach((polygon, polygonIndex) => {
                const outerRing = polygon[0];
                const holes = polygon.slice(1);
                
                // Use extrusion geometry if this is a 3D layer
                if (isExtruded && extrusionHeight > 0) {
                    const extrusion = generateExtrusion(outerRing, extrusionHeight, extrusionBase, holes, zoom);
                    const vertexOffset = fillVertices.length / 7;
                    extrusion.vertices.forEach(v => fillVertices.push(v));
                    extrusion.indices.forEach(i => fillIndices.push(i + vertexOffset));
                    
                    // Also create hidden vertices for the footprint so markers can be computed
                    const allCoords = polygon.flat(1);
                    const hiddenStartIndex = coordsToIdVertices(allCoords, 
                        clampedFeatureId,
                        hiddenVertices
                    );
                    
                    // Triangulate the footprint for hidden buffer indices
                    const flatCoords = [];
                    outerRing.forEach(coord => {
                        flatCoords.push(coord[0], coord[1]);
                    });
                    const holeIndices = [];
                    holes.forEach(hole => {
                        holeIndices.push(flatCoords.length / 2);
                        hole.forEach(coord => {
                            flatCoords.push(coord[0], coord[1]);
                        });
                    });
                    const triangles = earcut(flatCoords, holeIndices);
                    triangles.forEach(index => {
                        hiddenfillIndices.push(hiddenStartIndex + index);
                    });
                } else {
                    // Standard 2D fill
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
                        featureId,
                        hiddenVertices
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
            
            // Get line width from style (default 1px if not specified)
            let lineWidth = 1;
            let lineCap = 'butt';
            let lineJoin = 'miter';
            let miterLimit = 2;
            
            if (style && sourceId) {
                const layers = getLayersBySource(sourceId);
                const lineLayer = layers.find(l => 
                    l.type === 'line' && 
                    (!l['source-layer'] || l['source-layer'] === feature.layer?.name)
                );
                
                if (lineLayer) {
                    const widthValue = getPaintProperty(lineLayer.id, 'line-width', feature, zoom);
                    lineWidth = typeof widthValue === 'number' ? widthValue : 1;
                    lineCap = lineLayer.layout?.['line-cap'] || 'round';
                    lineJoin = lineLayer.layout?.['line-join'] || 'round';
                    miterLimit = lineLayer.layout?.['line-miter-limit'] || 2;
                }
            }
            
            // Transform coordinates to screen space
            const transformedLineCoords = feature.geometry.coordinates.map(coord => getTransformedCoord(coord));
            
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
            
            // Add triangle indices (lines now render as filled triangles)
            tessellated.indices.forEach(idx => {
                fillIndices.push(lineStartIndex + idx);
            });
            break;
            
        case 'MultiLineString':
            isFilled = false;
            isLine = true;
            
            // Get line width from style (default 1px if not specified)
            let multiLineWidth = 1;
            let multiLineCap = 'butt';
            let multiLineJoin = 'miter';
            let multiMiterLimit = 2;
            
            if (style && sourceId) {
                const layers = getLayersBySource(sourceId);
                const lineLayer = layers.find(l => 
                    l.type === 'line' && 
                    (!l['source-layer'] || l['source-layer'] === feature.layer?.name)
                );
                
                if (lineLayer) {
                    const widthValue = getPaintProperty(lineLayer.id, 'line-width', feature, zoom);
                    multiLineWidth = typeof widthValue === 'number' ? widthValue : 1;
                    multiLineCap = lineLayer.layout?.['line-cap'] || 'round';
                    multiLineJoin = lineLayer.layout?.['line-join'] || 'round';
                    multiMiterLimit = lineLayer.layout?.['line-miter-limit'] || 2;
                }
            }
            
            feature.geometry.coordinates.forEach(line => {
                // Transform coordinates to screen space
                const transformedLineCoords = line.map(coord => getTransformedCoord(coord));
                
                // Convert line width from pixels to world space
                const worldWidth = screenWidthToWorld(multiLineWidth, zoom, 512);
                
                // Tessellate line into triangles
                const tessellated = tessellateLine(transformedLineCoords, worldWidth, multiLineCap, multiLineJoin, multiMiterLimit);
                
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
                
                // Add triangle indices (lines now render as filled triangles)
                tessellated.indices.forEach(idx => {
                    fillIndices.push(lineStartIndex + idx);
                });
            });
            break;
            
        case 'Point':
            const transformedPoint = getTransformedCoord(feature.geometry.coordinates);
            fillVertices.push(transformedPoint[0], transformedPoint[1], 0.0, ..._fillColor);
            break;
            
        default:
            // console.warn(`Unsupported GeoJSON type: ${feature.geometry.type}`);
    }

    return {
        vertices: new Float32Array(fillVertices),
        hiddenVertices: new Float32Array(hiddenVertices),
        fillIndices: new Uint32Array(fillIndices),
        outlineIndices: new Uint32Array(outlineIndices),
        hiddenfillIndices: new Uint32Array(hiddenfillIndices),
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
export async function batchParseGeoJSONFeaturesGPU(features, device, fillColor = [0.0, 0.0, 0.0, 1.0], sourceId = null, zoom = 0) {
    if (features.length === 0) return [];

    // Get style layers for filtering
    const style = getStyle();
    
    if (!window._batchDebug) {
        console.log('🔧 batchParse called: sourceId=', sourceId, ', style=', !!style, ', features=', features.length);
        if (style) console.log('🔧 style.sources=', Object.keys(style.sources || {}));
        window._batchDebug = true;
    }
    
    const layers = style && sourceId ? getLayersBySource(sourceId) : [];
    
    if (!window._layerDebugLogged) {
        console.log('🔍 Found', layers.length, 'layers for sourceId:', sourceId);
        if (layers.length > 0) {
            console.log('🔍 Layers:', layers.map(l => l.id + '(' + l.type + ')').join(', '));
        }
        window._layerDebugLogged = true;
    }

    const transformer = getGlobalCoordinateTransformer(device);
    await transformer.initialize();

    // Extract all coordinates from all features (once, for all layers)
    const allCoordinates = [];
    const featureCoordMaps = [];

    features.forEach((feature, featureIndex) => {
        const coords = transformer.extractCoordinatesFromGeometry(feature.geometry);
        const coordMap = new Map();
        
        coords.forEach((coord, coordIndex) => {
            const globalIndex = allCoordinates.length;
            allCoordinates.push(coord);
            coordMap.set(`${coord[0]},${coord[1]}`, globalIndex);
        });
        
        featureCoordMaps.push(coordMap);
    });

    // Transform all coordinates in a single GPU batch operation
    let transformedCoords = [];
    if (allCoordinates.length > 0) {
        transformedCoords = await transformer.transformCoordinates(allCoordinates);
    }

    // Process features PER LAYER (not per feature)
    const results = [];
    
    // If no style layers, fall back to processing all features with default styling
    if (layers.length === 0) {
        for (let i = 0; i < features.length; i++) {
            const feature = features[i];
            const coordMap = featureCoordMaps[i];
            
            const getTransformedCoord = (coord) => {
                const key = `${coord[0]},${coord[1]}`;
                const globalIndex = coordMap.get(key);
                if (globalIndex === undefined && !window._coordLookupFailLogged) {
                    console.log(`⚠️ Coord lookup failed for key: ${key}`);
                    console.log(`   CoordMap size:`, coordMap.size);
                    console.log(`   Available keys sample:`, Array.from(coordMap.keys()).slice(0, 5));
                    window._coordLookupFailLogged = true;
                }
                return globalIndex !== undefined ? transformedCoords[globalIndex] : [0, 0];
            };

            const result = await parseFeatureWithTransformedCoords(feature, getTransformedCoord, fillColor, sourceId, zoom, null);
            if (result) {
                results.push(result);
            }
        }
        return results;
    }

    // LAYER-FIRST: For each layer, process all matching features
    const allStyleLayers = style?.layers || [];
    
    for (let layerIndex = 0; layerIndex < layers.length; layerIndex++) {
        const layer = layers[layerIndex];
        // Skip invisible layers
        if (layer.layout?.visibility === 'none') continue;
        
        // Only process fill, fill-extrusion, and line layers
        if (!['fill', 'fill-extrusion', 'line'].includes(layer.type)) continue;
        
        let matchCount = 0;

        for (let i = 0; i < features.length; i++) {
            const feature = features[i];
            
            // IMPORTANT: Skip if geometry type doesn't match layer type
            const geomType = feature.geometry.type;
            if (layer.type === 'line' && !geomType.includes('LineString') && !geomType.includes('Polygon')) {
                continue; // Line layers render LineString OR Polygon boundaries
            }
            if ((layer.type === 'fill' || layer.type === 'fill-extrusion') && !geomType.includes('Polygon')) {
                continue; // Fill layers only render Polygon geometry
            }
            
            // Check source-layer match
            if (layer['source-layer'] && layer['source-layer'] !== feature.layer?.name) {
                continue;
            }

            // Check filter
            if (layer.filter && !evaluateFilter(layer.filter, feature, zoom)) {
                continue;
            }
            
            matchCount++;

            const coordMap = featureCoordMaps[i];
            
            const getTransformedCoord = (coord) => {
                const key = `${coord[0]},${coord[1]}`;
                const globalIndex = coordMap.get(key);
                return globalIndex !== undefined ? transformedCoords[globalIndex] : [0, 0];
            };

            // Parse feature for THIS SPECIFIC LAYER
            const result = await parseFeatureWithTransformedCoords(feature, getTransformedCoord, fillColor, sourceId, zoom, layer);
            if (result) {
                // Add layerId to result
                result.layerId = layer.id;
                results.push(result);
            }
        }

    }

    return results;
}

// Helper function to parse a feature when coordinates are already transformed
async function parseFeatureWithTransformedCoords(feature, getTransformedCoord, fillColor, sourceId = null, zoom = 0, layer = null) {
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
    
    // Extrusion properties (for 3D buildings)
    let extrusionHeight = 0;
    let extrusionBase = 0;
    let isExtruded = false;

    // Use the provided layer instead of searching for one
    if (layer) {
        const fillLayer = layer.type === 'fill' || layer.type === 'fill-extrusion' ? layer : null;
        const lineLayer = layer.type === 'line' ? layer : null;
        const extrusionLayer = layer.type === 'fill-extrusion' ? layer : null;

        // Get extrusion properties if this is a 3D layer
        if (extrusionLayer) {
            isExtruded = true;
            const heightValue = getPaintProperty(extrusionLayer.id, 'fill-extrusion-height', feature, zoom);
            const baseValue = getPaintProperty(extrusionLayer.id, 'fill-extrusion-base', feature, zoom);
            extrusionHeight = typeof heightValue === 'number' ? heightValue : 0;
            extrusionBase = typeof baseValue === 'number' ? baseValue : 0;
        }

        // Get paint properties from style
        if (fillLayer) {
            const colorProperty = extrusionLayer ? 'fill-extrusion-color' : 'fill-color';
            const fillColorValue = getPaintProperty(fillLayer.id, colorProperty, feature, zoom);
            
            if (fillColorValue) {
                _fillColor = parseColor(fillColorValue);
                
                // Apply opacity
                const opacityProperty = extrusionLayer ? 'fill-extrusion-opacity' : 'fill-opacity';
                const opacityValue = getPaintProperty(fillLayer.id, opacityProperty, feature, zoom);
                if (typeof opacityValue === 'number') {
                    _fillColor[3] = opacityValue;
                }
            }
        }

        if (lineLayer) {
            const lineColorValue = getPaintProperty(lineLayer.id, 'line-color', feature, zoom);
            if (lineColorValue) {
                _borderColor = parseColor(lineColorValue);
            }
        }
    } else if (style && sourceId) {
        // Fallback: find layer if not provided (legacy behavior)
        const layers = getLayersBySource(sourceId);
        
        const extrusionLayer = layers.find(l => 
            l.type === 'fill-extrusion' && 
            (!l['source-layer'] || l['source-layer'] === feature.layer?.name)
        );
        
        const fillLayer = extrusionLayer || layers.find(l => 
            l.type === 'fill' && 
            (!l['source-layer'] || l['source-layer'] === feature.layer?.name)
        );
        
        const lineLayer = layers.find(l => 
            l.type === 'line' && 
            (!l['source-layer'] || l['source-layer'] === feature.layer?.name)
        );

        // Get extrusion properties if this is a 3D layer
        if (extrusionLayer) {
            isExtruded = true;
            const heightValue = getPaintProperty(extrusionLayer.id, 'fill-extrusion-height', feature, zoom);
            const baseValue = getPaintProperty(extrusionLayer.id, 'fill-extrusion-base', feature, zoom);
            extrusionHeight = typeof heightValue === 'number' ? heightValue : 0;
            extrusionBase = typeof baseValue === 'number' ? baseValue : 0;
        }

        // Get paint properties from style
        if (fillLayer) {
            const colorProperty = extrusionLayer ? 'fill-extrusion-color' : 'fill-color';
            const fillColorValue = getPaintProperty(fillLayer.id, colorProperty, feature, zoom);
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
        if (style && sourceId) {
            return getStyleFeatureId(feature, sourceId);
        }
        // Legacy fallback
        const rawId = parseInt(feature.properties?.fid || feature.id) || 1;
        return rawId;
    };

    const featureId = getFeatureId();
    
    // Clamp feature ID to valid range for 16-bit encoding (1-65534)
    const clampedFeatureId = Math.max(1, Math.min(65534, featureId));

    // Vertex creation functions (same as above)
    const coordsToVertices = (coords, color, targetArray) => {
        const vertexStartIndex = targetArray.length / 7;
        coords.forEach(coord => {
            const [x, y] = getTransformedCoord(coord);
            targetArray.push(x, y, 0.0, ...color);
        });
        return vertexStartIndex;
    };

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
            const [x, y] = getTransformedCoord(coord);
            targetArray.push(x, y, 0.0, normalizedR, normalizedG, 0.0, 1.0);
        });
        return vertexStartIndex;
    };

    // Helper function to generate 3D extrusion geometry (walls + roof)
    // Helper function to generate 3D extrusion geometry (walls + roof) with holes support
    const generateExtrusion = (outerRing, height, base, holes = [], zoom = 14) => {
        const vertices = [];
        const indices = [];
        
        // Convert meters to world space units (same as above)
        const metersToWorld = 0.00000008; // Tuned for visibility
        const heightZ = height * metersToWorld;
        const baseZ = base * metersToWorld;
        
        // Generate vertical walls for outer ring
        for (let i = 0; i < outerRing.length - 1; i++) {
            const p1 = outerRing[i];
            const p2 = outerRing[i + 1];
            const [x1, y1] = getTransformedCoord(p1);
            const [x2, y2] = getTransformedCoord(p2);
            
            // Calculate wall direction for directional lighting
            const dx = x2 - x1;
            const dy = y2 - y1;
            const angle = Math.atan2(dy, dx);
            
            // Simulate sun from north-west
            const sunAngle = Math.PI * 0.75;
            const lightDot = Math.cos(angle - sunAngle);
            
            // Moderate lighting contrast
            const lightFactor = 0.4 + lightDot * 0.4; // Range 0.0 to 0.8
            
            // Wall color with directional lighting
            const wallColor = [
                _fillColor[0] * lightFactor,
                _fillColor[1] * lightFactor,
                _fillColor[2] * lightFactor,
                _fillColor[3]
            ];
            
            const baseIdx = vertices.length / 7;
            
            // Wall vertices
            vertices.push(x1, y1, baseZ, ...wallColor);
            vertices.push(x2, y2, baseZ, ...wallColor);
            vertices.push(x2, y2, heightZ, ...wallColor);
            vertices.push(x1, y1, heightZ, ...wallColor);
            
            // Two triangles for wall quad
            indices.push(baseIdx, baseIdx + 1, baseIdx + 2);
            indices.push(baseIdx, baseIdx + 2, baseIdx + 3);
        }
        
        // Generate walls for holes (inner courtyards)
        holes.forEach(hole => {
            for (let i = 0; i < hole.length - 1; i++) {
                const p1 = hole[i];
                const p2 = hole[i + 1];
                const [x1, y1] = getTransformedCoord(p1);
                const [x2, y2] = getTransformedCoord(p2);
                
                const dx = x2 - x1;
                const dy = y2 - y1;
                const angle = Math.atan2(dy, dx);
                const sunAngle = Math.PI * 0.75;
                const lightDot = Math.cos(angle - sunAngle);
                const lightFactor = 0.4 + lightDot * 0.4;
                
                const wallColor = [
                    _fillColor[0] * lightFactor,
                    _fillColor[1] * lightFactor,
                    _fillColor[2] * lightFactor,
                    _fillColor[3]
                ];
                
                const baseIdx = vertices.length / 7;
                
                // Wall vertices (reverse winding for inner walls)
                vertices.push(x2, y2, baseZ, ...wallColor);
                vertices.push(x1, y1, baseZ, ...wallColor);
                vertices.push(x1, y1, heightZ, ...wallColor);
                vertices.push(x2, y2, heightZ, ...wallColor);
                
                indices.push(baseIdx, baseIdx + 1, baseIdx + 2);
                indices.push(baseIdx, baseIdx + 2, baseIdx + 3);
            }
        });
        
        // Generate roof (flat top polygon at height with holes)
        // CRITICAL: Use transformed coordinates for triangulation to match vertex positions
        const flatCoords = [];
        const roofVertices = [];
        
        outerRing.forEach(coord => {
            const [x, y] = getTransformedCoord(coord);
            flatCoords.push(x, y);  // Use transformed coords for earcut
            roofVertices.push([x, y]);
        });
        
        const holeIndices = [];
        holes.forEach(hole => {
            holeIndices.push(flatCoords.length / 2);
            hole.forEach(coord => {
                const [x, y] = getTransformedCoord(coord);
                flatCoords.push(x, y);  // Use transformed coords for earcut
                roofVertices.push([x, y]);
            });
        });
        
        // Try triangulation, skip if it fails (invalid geometry)
        let roofTriangles;
        try {
            roofTriangles = earcut(flatCoords, holeIndices.length > 0 ? holeIndices : null);
            if (!roofTriangles || roofTriangles.length === 0) {
                console.warn('⚠️ Earcut returned no triangles');
                return { vertices, indices }; // Return just walls
            }
        } catch (error) {
            console.warn('⚠️ Earcut triangulation failed:', error.message);
            return { vertices, indices }; // Return just walls, skip roof
        }
        
        const roofStartIdx = vertices.length / 7;
        
        // Add all roof vertices (already transformed)
        roofVertices.forEach(([x, y]) => {
            vertices.push(x, y, heightZ, ..._fillColor);
        });
        
        roofTriangles.forEach(idx => {
            indices.push(roofStartIdx + idx);
        });
        
        return { vertices, indices };
    };

    // Process geometry (same logic as parseGeoJSONFeatureGPU)
    switch (feature.geometry.type) {
        case 'Polygon':
            const coordinates = feature.geometry.coordinates;
            const outerRing = coordinates[0];
            const holes = coordinates.slice(1);
            
            // SPECIAL CASE: Line layer rendering polygon boundaries (coastlines, borders)
            if (layer && layer.type === 'line') {
                // Treat polygon rings as LineStrings
                const rings = [outerRing, ...holes];
                for (const ring of rings) {
                    // Get line style from layer
                    const widthValue = getPaintProperty(layer.id, 'line-width', feature, zoom);
                    const lineWidth = typeof widthValue === 'number' ? widthValue : 1;
                    const lineCap = layer.layout?.['line-cap'] || 'butt';
                    const lineJoin = layer.layout?.['line-join'] || 'miter';
                    const miterLimit = layer.layout?.['line-miter-limit'] || 2;
                    
                    // Transform coordinates first, then tessellate
                    const transformedRing = ring.map(coord => getTransformedCoord(coord));
                    
                    // Tessellate the transformed ring as a line
                    const lineTessellation = tessellateLine(transformedRing, lineWidth, lineCap, lineJoin, miterLimit);
                    
                    if (lineTessellation.vertices.length > 0) {
                        const vertexOffset = fillVertices.length / 7;
                        // Vertices are already transformed, use them directly with depth offset
                        lineTessellation.vertices.forEach(coord => {
                            fillVertices.push(coord[0], coord[1], 0.0, ..._borderColor);
                            hiddenVertices.push(coord[0], coord[1], 0.0, 0, 0, 0, 1);
                        });
                        lineTessellation.indices.forEach(i => fillIndices.push(i + vertexOffset));
                        isFilled = false;
                        isLine = true;
                    }
                }
                break;
            }
            
            // Use extrusion geometry if this is a 3D layer
            if (isExtruded && extrusionHeight > 0) {
                if (!window._batchExtrusionLogged) {
                    console.log(`🏢 BATCH Taking EXTRUSION path: height=${extrusionHeight}`);
                    window._batchExtrusionLogged = true;
                }
                const extrusion = generateExtrusion(outerRing, extrusionHeight, extrusionBase);
                const vertexOffset = fillVertices.length / 7;
                extrusion.vertices.forEach(v => fillVertices.push(v));
                extrusion.indices.forEach(i => fillIndices.push(i + vertexOffset));
                
                // Also create hidden vertices for the footprint so markers can be computed
                const allCoords = [outerRing, ...holes].flat(1);
                const hiddenStartIndex = coordsToIdVertices(allCoords, 
                    clampedFeatureId, hiddenVertices);
                
                // Triangulate the footprint for hidden buffer indices
                const flatCoords = [];
                outerRing.forEach(coord => {
                    const [x, y] = getTransformedCoord(coord);
                    flatCoords.push(x, y);
                });
                const holeIndices = [];
                holes.forEach(hole => {
                    holeIndices.push(flatCoords.length / 2);
                    hole.forEach(coord => {
                        const [x, y] = getTransformedCoord(coord);
                        flatCoords.push(x, y);
                    });
                });
                const triangles = earcut(flatCoords, holeIndices.length > 0 ? holeIndices : null);
                triangles.forEach(index => {
                    hiddenfillIndices.push(hiddenStartIndex + index);
                });
            } else {
                // Standard 2D fill
                const flatCoords = [];
                const holeIndices = [];
                
                // Use TRANSFORMED coordinates for earcut (clip space, not raw lon/lat)
                outerRing.forEach(coord => {
                    const [x, y] = getTransformedCoord(coord);
                    flatCoords.push(x, y);
                });
                
                holes.forEach(hole => {
                    holeIndices.push(flatCoords.length / 2);
                    hole.forEach(coord => {
                        const [x, y] = getTransformedCoord(coord);
                        flatCoords.push(x, y);
                    });
                });

                const triangles = earcut(flatCoords, holeIndices.length > 0 ? holeIndices : null);
                
                // Add vertices in the same order as flatCoords (outer + holes)
                const allRings = [outerRing, ...holes];
                const allCoords = allRings.flat(1);
                const fillStartIndex = coordsToVertices(allCoords, _fillColor, fillVertices);
                const hiddenStartIndex = coordsToIdVertices(allCoords, 
                    featureId, hiddenVertices);

                triangles.forEach(index => {
                    fillIndices.push(fillStartIndex + index);
                    hiddenfillIndices.push(hiddenStartIndex + index);
                });
            }
            break;

        case 'MultiPolygon':
            feature.geometry.coordinates.forEach(polygon => {
                const outerRing = polygon[0];
                const holes = polygon.slice(1);
                
                // SPECIAL CASE: Line layer rendering polygon boundaries
                if (layer && layer.type === 'line') {
                    const rings = [outerRing, ...holes];
                    for (const ring of rings) {
                        // Get line style from layer
                        const widthValue = getPaintProperty(layer.id, 'line-width', feature, zoom);
                        const lineWidth = typeof widthValue === 'number' ? widthValue : 1;
                        const lineCap = layer.layout?.['line-cap'] || 'butt';
                        const lineJoin = layer.layout?.['line-join'] || 'miter';
                        const miterLimit = layer.layout?.['line-miter-limit'] || 2;
                        
                        // Transform coordinates first, then tessellate
                        const transformedRing = ring.map(coord => getTransformedCoord(coord));
                        
                        // Tessellate the transformed ring as a line
                        const lineTessellation = tessellateLine(transformedRing, lineWidth, lineCap, lineJoin, miterLimit);
                        
                        if (lineTessellation.vertices.length > 0) {
                            const vertexOffset = fillVertices.length / 7;
                            // Vertices are already transformed, use them directly with depth offset
                            lineTessellation.vertices.forEach(coord => {
                                fillVertices.push(coord[0], coord[1], 0.0, ..._borderColor);
                                hiddenVertices.push(coord[0], coord[1], 0.0, 0, 0, 0, 1);
                            });
                            lineTessellation.indices.forEach(i => fillIndices.push(i + vertexOffset));
                            isFilled = false;
                            isLine = true;
                        }
                    }
                    return; // Skip fill processing
                }
                
                // Use extrusion geometry if this is a 3D layer
                if (isExtruded && extrusionHeight > 0) {
                    const extrusion = generateExtrusion(outerRing, extrusionHeight, extrusionBase);
                    const vertexOffset = fillVertices.length / 7;
                    extrusion.vertices.forEach(v => fillVertices.push(v));
                    extrusion.indices.forEach(i => fillIndices.push(i + vertexOffset));
                    
                    // Also create hidden vertices for the footprint so markers can be computed
                    const allRings = [outerRing, ...holes];
                    const allCoords = allRings.flat(1);
                    const hiddenStartIndex = coordsToIdVertices(allCoords, 
                        clampedFeatureId, hiddenVertices);
                    
                    // Triangulate the footprint for hidden buffer indices
                    const flatCoords = [];
                    outerRing.forEach(coord => {
                        const [x, y] = getTransformedCoord(coord);
                        flatCoords.push(x, y);
                    });
                    const holeIndices = [];
                    holes.forEach(hole => {
                        holeIndices.push(flatCoords.length / 2);
                        hole.forEach(coord => {
                            const [x, y] = getTransformedCoord(coord);
                            flatCoords.push(x, y);
                        });
                    });
                    const triangles = earcut(flatCoords, holeIndices.length > 0 ? holeIndices : null);
                    triangles.forEach(index => {
                        hiddenfillIndices.push(hiddenStartIndex + index);
                    });
                } else {
                    // Standard 2D fill
                    const flatCoords = [];
                    const holeIndices = [];
                    
                    // Use TRANSFORMED coordinates for earcut (clip space, not raw lon/lat)
                    outerRing.forEach(coord => {
                        const [x, y] = getTransformedCoord(coord);
                        flatCoords.push(x, y);
                    });
                    
                    holes.forEach(hole => {
                        holeIndices.push(flatCoords.length / 2);
                        hole.forEach(coord => {
                            const [x, y] = getTransformedCoord(coord);
                            flatCoords.push(x, y);
                        });
                    });

                    const triangles = earcut(flatCoords, holeIndices.length > 0 ? holeIndices : null);
                    
                    // Add vertices in the same order as flatCoords (outer + holes)
                    const allRings = [outerRing, ...holes];
                    const allCoords = allRings.flat(1);
                    const fillStartIndex = coordsToVertices(allCoords, _fillColor, fillVertices);
                    const hiddenStartIndex = coordsToIdVertices(allCoords, 
                        featureId, hiddenVertices);

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
            
            // Get line width and style from layer
            let lineWidth2 = 1;
            let lineCap2 = 'butt';
            let lineJoin2 = 'miter';
            let miterLimit2 = 2;
            
            if (layer && layer.type === 'line') {
                const widthValue = getPaintProperty(layer.id, 'line-width', feature, zoom);
                lineWidth2 = typeof widthValue === 'number' ? widthValue : 1;
                lineCap2 = layer.layout?.['line-cap'] || 'butt';
                lineJoin2 = layer.layout?.['line-join'] || 'miter';
                miterLimit2 = layer.layout?.['line-miter-limit'] || 2;
            }
            
            // Transform coordinates to screen space
            const transformedLineCoords2 = feature.geometry.coordinates.map(coord => getTransformedCoord(coord));
            
            // Convert line width from pixels to world space
            const worldWidth2 = screenWidthToWorld(lineWidth2, zoom, 512);
            
            // Tessellate line into triangles
            const tessellated2 = tessellateLine(transformedLineCoords2, worldWidth2, lineCap2, lineJoin2, miterLimit2);
            
            // Add tessellated vertices and indices
            const lineStartIndex2 = fillVertices.length / 7;
            for (let i = 0; i < tessellated2.vertices.length; i += 2) {
                fillVertices.push(
                    tessellated2.vertices[i],     // x
                    tessellated2.vertices[i + 1], // y
                    0.0,                           // z
                    ..._borderColor                // color
                );
            }
            
            // Add triangle indices (lines now render as filled triangles)
            tessellated2.indices.forEach(idx => {
                fillIndices.push(lineStartIndex2 + idx);
            });
            break;
            
        case 'MultiLineString':
            isFilled = false;
            isLine = true;
            
            // Get line width and style from layer
            let multiLineWidth2 = 1;
            let multiLineCap2 = 'butt';
            let multiLineJoin2 = 'miter';
            let multiMiterLimit2 = 2;
            
            if (layer && layer.type === 'line') {
                const widthValue = getPaintProperty(layer.id, 'line-width', feature, zoom);
                multiLineWidth2 = typeof widthValue === 'number' ? widthValue : 1;
                multiLineCap2 = layer.layout?.['line-cap'] || 'butt';
                multiLineJoin2 = layer.layout?.['line-join'] || 'miter';
                multiMiterLimit2 = layer.layout?.['line-miter-limit'] || 2;
            }
            
            feature.geometry.coordinates.forEach(line => {
                // Transform coordinates to screen space
                const transformedLineCoords3 = line.map(coord => getTransformedCoord(coord));
                
                // Convert line width from pixels to world space
                const worldWidth3 = screenWidthToWorld(multiLineWidth2, zoom, 512);
                
                // Tessellate line into triangles
                const tessellated3 = tessellateLine(transformedLineCoords3, worldWidth3, multiLineCap2, multiLineJoin2, multiMiterLimit2);
                
                // Add tessellated vertices and indices
                const lineStartIndex3 = fillVertices.length / 7;
                for (let i = 0; i < tessellated3.vertices.length; i += 2) {
                    fillVertices.push(
                        tessellated3.vertices[i],     // x
                        tessellated3.vertices[i + 1], // y
                        0.0,                           // z
                        ..._borderColor                // color
                    );
                }
                
                // Add triangle indices (lines now render as filled triangles)
                tessellated3.indices.forEach(idx => {
                    fillIndices.push(lineStartIndex3 + idx);
                });
            });
            break;
            
        case 'Point':
            const transformedPoint = getTransformedCoord(feature.geometry.coordinates);
            fillVertices.push(transformedPoint[0], transformedPoint[1], 0.0, ..._fillColor);
            break;
            
        default:
            // console.warn(`Unsupported GeoJSON type: ${feature.geometry.type}`);
    }

    // Debug: Log if building has hidden geometry
    if (feature.layer?.name === 'building' && hiddenfillIndices.length > 0 && !window._buildingHiddenIndicesLogged) {
        console.log(`🏢 Building feature has ${hiddenfillIndices.length} hidden indices, ${hiddenVertices.length / 7} hidden vertices, fid: ${featureId} → ${clampedFeatureId}`);
        window._buildingHiddenIndicesLogged = true;
    }
    
    return {
        vertices: new Float32Array(fillVertices),
        hiddenVertices: new Float32Array(hiddenVertices),
        fillIndices: new Uint32Array(fillIndices),
        outlineIndices: new Uint32Array(outlineIndices),
        hiddenfillIndices: new Uint32Array(hiddenfillIndices),
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



