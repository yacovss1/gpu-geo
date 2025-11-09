// GPU-Accelerated GeoJSON Parser
// This file provides enhanced parsing functions that use GPU compute shaders for coordinate transformation

import { hexToRgb } from '../core/utils.js';
import { getColorOfCountries } from '../core/utils.js';
import { getGlobalCoordinateTransformer } from '../core/coordinateGPU.js';
import earcut from 'earcut';
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
            isExtruded = true;
            const heightValue = getPaintProperty(extrusionLayer.id, 'fill-extrusion-height', feature, zoom);
            const baseValue = getPaintProperty(extrusionLayer.id, 'fill-extrusion-base', feature, zoom);
            extrusionHeight = typeof heightValue === 'number' ? heightValue : 0;
            extrusionBase = typeof baseValue === 'number' ? baseValue : 0;
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
        
        // Generate vertical walls for each edge
        for (let i = 0; i < outerRing.length - 1; i++) {
            const p1 = outerRing[i];
            const p2 = outerRing[i + 1];
            const [x1, y1] = getTransformedCoord(p1);
            const [x2, y2] = getTransformedCoord(p2);
            
            const baseIdx = vertices.length / 7;
            
            // Bottom-left, bottom-right, top-right, top-left
            vertices.push(x1, y1, base, ..._fillColor);
            vertices.push(x2, y2, base, ..._fillColor);
            vertices.push(x2, y2, height, ..._fillColor);
            vertices.push(x1, y1, height, ..._fillColor);
            
            // Two triangles for wall quad
            indices.push(baseIdx, baseIdx + 1, baseIdx + 2);
            indices.push(baseIdx, baseIdx + 2, baseIdx + 3);
        }
        
        // Generate roof (flat top polygon at height)
        const flatCoords = [];
        outerRing.forEach(coord => {
            flatCoords.push(coord[0], coord[1]);
        });
        
        const roofTriangles = earcut(flatCoords, []);
        const roofStartIdx = vertices.length / 7;
        
        outerRing.forEach(coord => {
            const [x, y] = getTransformedCoord(coord);
            vertices.push(x, y, height, ..._fillColor);
        });
        
        roofTriangles.forEach(idx => {
            indices.push(roofStartIdx + idx);
        });
        
        return { vertices, indices };
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
            
            // Use extrusion geometry if this is a 3D layer
            if (isExtruded && extrusionHeight > 0) {
                const extrusion = generateExtrusion(outerRing, extrusionHeight, extrusionBase);
                const vertexOffset = fillVertices.length / 7;
                extrusion.vertices.forEach(v => fillVertices.push(v));
                extrusion.indices.forEach(i => fillIndices.push(i + vertexOffset));
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
                    const extrusion = generateExtrusion(outerRing, extrusionHeight, extrusionBase);
                    const vertexOffset = fillVertices.length / 7;
                    extrusion.vertices.forEach(v => fillVertices.push(v));
                    extrusion.indices.forEach(i => fillIndices.push(i + vertexOffset));
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

    const transformer = getGlobalCoordinateTransformer(device);
    await transformer.initialize();

    // Extract all coordinates from all features
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

    // Process each feature using the batch-transformed coordinates
    const results = [];
    for (let i = 0; i < features.length; i++) {
        const feature = features[i];
        const coordMap = featureCoordMaps[i];
        
        // Create lookup function for this feature
        const getTransformedCoord = (coord) => {
            const key = `${coord[0]},${coord[1]}`;
            const globalIndex = coordMap.get(key);
            return globalIndex !== undefined ? transformedCoords[globalIndex] : [0, 0];
        };

        // Parse feature using transformed coordinates (reuse logic from parseGeoJSONFeatureGPU)
        const result = await parseFeatureWithTransformedCoords(feature, getTransformedCoord, fillColor, sourceId, zoom);
        if (result) {
            results.push(result);
        }
    }

    return results;
}

// Helper function to parse a feature when coordinates are already transformed
async function parseFeatureWithTransformedCoords(feature, getTransformedCoord, fillColor, sourceId = null, zoom = 0) {
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
            isExtruded = true;
            const heightValue = getPaintProperty(extrusionLayer.id, 'fill-extrusion-height', feature, zoom);
            const baseValue = getPaintProperty(extrusionLayer.id, 'fill-extrusion-base', feature, zoom);
            extrusionHeight = typeof heightValue === 'number' ? heightValue : 0;
            extrusionBase = typeof baseValue === 'number' ? baseValue : 0;
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

    const featureId = getFeatureId();
    
    // Clamp feature ID to valid range for rendering (1-9999)
    const clampedFeatureId = Math.max(1, Math.min(9999, featureId));

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
    const generateExtrusion = (outerRing, height, base) => {
        const vertices = [];
        const indices = [];
        
        // Generate vertical walls for each edge
        for (let i = 0; i < outerRing.length - 1; i++) {
            const p1 = outerRing[i];
            const p2 = outerRing[i + 1];
            const [x1, y1] = getTransformedCoord(p1);
            const [x2, y2] = getTransformedCoord(p2);
            
            const baseIdx = vertices.length / 7;
            
            // Bottom-left, bottom-right, top-right, top-left
            vertices.push(x1, y1, base, ..._fillColor);
            vertices.push(x2, y2, base, ..._fillColor);
            vertices.push(x2, y2, height, ..._fillColor);
            vertices.push(x1, y1, height, ..._fillColor);
            
            // Two triangles for wall quad
            indices.push(baseIdx, baseIdx + 1, baseIdx + 2);
            indices.push(baseIdx, baseIdx + 2, baseIdx + 3);
        }
        
        // Generate roof (flat top polygon at height)
        const flatCoords = [];
        outerRing.forEach(coord => {
            flatCoords.push(coord[0], coord[1]);
        });
        
        const roofTriangles = earcut(flatCoords, []);
        const roofStartIdx = vertices.length / 7;
        
        outerRing.forEach(coord => {
            const [x, y] = getTransformedCoord(coord);
            vertices.push(x, y, height, ..._fillColor);
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
            
            // Use extrusion geometry if this is a 3D layer
            if (isExtruded && extrusionHeight > 0) {
                const extrusion = generateExtrusion(outerRing, extrusionHeight, extrusionBase);
                const vertexOffset = fillVertices.length / 7;
                extrusion.vertices.forEach(v => fillVertices.push(v));
                extrusion.indices.forEach(i => fillIndices.push(i + vertexOffset));
            } else {
                // Standard 2D fill
                const flatCoords = [];
                const holeIndices = [];
                
                outerRing.forEach(coord => {
                    flatCoords.push(coord[0], coord[1]);
                });
                
                holes.forEach(hole => {
                    holeIndices.push(flatCoords.length / 2);
                    hole.forEach(coord => {
                        flatCoords.push(coord[0], coord[1]);
                    });
                });

                const triangles = earcut(flatCoords, holeIndices);
                
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
                
                // Use extrusion geometry if this is a 3D layer
                if (isExtruded && extrusionHeight > 0) {
                    const extrusion = generateExtrusion(outerRing, extrusionHeight, extrusionBase);
                    const vertexOffset = fillVertices.length / 7;
                    extrusion.vertices.forEach(v => fillVertices.push(v));
                    extrusion.indices.forEach(i => fillIndices.push(i + vertexOffset));
                } else {
                    // Standard 2D fill
                    const flatCoords = [];
                    const holeIndices = [];
                    
                    outerRing.forEach(coord => {
                        flatCoords.push(coord[0], coord[1]);
                    });
                    
                    holes.forEach(hole => {
                        holeIndices.push(flatCoords.length / 2);
                        hole.forEach(coord => {
                            flatCoords.push(coord[0], coord[1]);
                        });
                    });

                    const triangles = earcut(flatCoords, holeIndices);
                    
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
            const transformedPoint = getTransformedCoord(feature.geometry.coordinates);
            fillVertices.push(transformedPoint[0], transformedPoint[1], 0.0, ..._fillColor);
            break;
            
        default:
            // console.warn(`Unsupported GeoJSON type: ${feature.geometry.type}`);
    }

    if (feature.properties?.ADM0_A3 === 'USA' || feature.properties?.ADM0_A3 === 'CAN') { console.log('?? ' + feature.properties.ADM0_A3 + ': verts=' + fillVertices.length + ', idx=' + fillIndices.length); }
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



