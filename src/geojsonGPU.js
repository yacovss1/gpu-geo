// GPU-Accelerated GeoJSON Parser
// This file provides enhanced parsing functions that use GPU compute shaders for coordinate transformation

import { hexToRgb } from './utils.js';
import { getColorOfCountries } from './utils.js';
import { getGlobalCoordinateTransformer } from './coordinateGPU.js';
import earcut from 'earcut';
import { 
    getStyle, 
    getFeatureId as getStyleFeatureId, 
    getPaintProperty, 
    parseColor,
    evaluateFilter,
    getLayersBySource
} from './style.js';

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

    if (style && sourceId) {
        // Get layers for this source
        const layers = getLayersBySource(sourceId);
        const fillLayer = layers.find(l => l.type === 'fill' && (!l['source-layer'] || l['source-layer'] === feature.layer?.name));
        const lineLayer = layers.find(l => l.type === 'line' && (!l['source-layer'] || l['source-layer'] === feature.layer?.name));

        // Debug once per batch
        if (!window._gpuStyleDebugLogged && layers.length > 0) {
            console.log('🎨 [GPU] Style has', layers.length, 'layers for source', sourceId);
            console.log('🎨 [GPU] Looking for feature layer:', feature.layer?.name);
            console.log('🎨 [GPU] Fill layer found?', fillLayer ? fillLayer.id : 'NO');
            if (fillLayer) {
                console.log('🎨 [GPU] Fill layer source-layer:', fillLayer['source-layer']);
                const testColor = getPaintProperty(fillLayer.id, 'fill-color', feature, zoom);
                console.log('🎨 [GPU] Test color value:', testColor);
                console.log('🎨 [GPU] Sample feature ISO_A3:', feature.properties?.ISO_A3);
            }
            window._gpuStyleDebugLogged = true;
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
        const vertexStartIndex = targetArray.length / 6;
        coords.forEach(coord => {
            const [x, y] = getTransformedCoord(coord);
            targetArray.push(
                x, y,     // Position
                ...color  // Color
            );
        });
        return vertexStartIndex;
    };

    const coordsToIdVertices = (coords, featureId, targetArray) => {
        const vertexStartIndex = targetArray.length / 6;
        
        // Ensure feature ID is non-zero and normalized to 0-1 range
        const safeId = Math.max(1, Math.min(254, featureId || 1));
        const normalizedId = safeId / 255.0;
        
        coords.forEach(coord => {
            const [x, y] = getTransformedCoord(coord);
            targetArray.push(
                x, y,             // Position
                normalizedId, 0.0, 0.0, 1.0  // ID in red, no polygon ID
            );
        });
        return vertexStartIndex;
    };

    // Deduplicate features by tracking processed feature IDs
    const processedFeatures = new Set();
    const featureId = getFeatureId();
    
    // Clamp feature ID to valid range for rendering (1-254)
    const clampedFeatureId = Math.max(1, Math.min(254, featureId));
    
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
                featureId,
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
                    featureId,
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
            const transformedPoint = getTransformedCoord(feature.geometry.coordinates);
            fillVertices.push(transformedPoint[0], transformedPoint[1], ..._fillColor);
            break;
            
        default:
            // console.warn(`Unsupported GeoJSON type: ${feature.geometry.type}`);
    }

    return {
        vertices: new Float32Array(fillVertices),
        hiddenVertices: new Float32Array(hiddenVertices),
        fillIndices: new Uint16Array(fillIndices),
        outlineIndices: new Uint16Array(outlineIndices),
        hiddenfillIndices: new Uint16Array(hiddenfillIndices),
        isFilled,
        isLine,
        properties: {
            ...feature.properties,
            fid: featureId,           // Original feature ID
            clampedFid: clampedFeatureId  // ID actually used in rendering (1-254)
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
        if (style && sourceId) {
            return getStyleFeatureId(feature, sourceId);
        }
        // Legacy fallback
        const rawId = parseInt(feature.properties?.fid || feature.id) || 1;
        return rawId;
    };

    const featureId = getFeatureId();
    
    // Clamp feature ID to valid range for rendering (1-254)
    const clampedFeatureId = Math.max(1, Math.min(254, featureId));

    // Vertex creation functions (same as above)
    const coordsToVertices = (coords, color, targetArray) => {
        const vertexStartIndex = targetArray.length / 6;
        coords.forEach(coord => {
            const [x, y] = getTransformedCoord(coord);
            targetArray.push(x, y, ...color);
        });
        return vertexStartIndex;
    };

    const coordsToIdVertices = (coords, featureId, targetArray) => {
        const vertexStartIndex = targetArray.length / 6;
        const safeId = Math.max(1, Math.min(254, featureId || 1));
        const normalizedId = safeId / 255.0;
        
        coords.forEach(coord => {
            const [x, y] = getTransformedCoord(coord);
            targetArray.push(x, y, normalizedId, 0.0, 0.0, 1.0);
        });
        return vertexStartIndex;
    };

    // Process geometry (same logic as parseGeoJSONFeatureGPU)
    switch (feature.geometry.type) {
        case 'Polygon':
            const coordinates = feature.geometry.coordinates;
            const outerRing = coordinates[0];
            const holes = coordinates.slice(1);
            
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
            const allCoords = coordinates.flat(1);
            const fillStartIndex = coordsToVertices(allCoords, _fillColor, fillVertices);
            const hiddenStartIndex = coordsToIdVertices(allCoords, 
                featureId, hiddenVertices);

            triangles.forEach(index => {
                fillIndices.push(fillStartIndex + index);
                hiddenfillIndices.push(hiddenStartIndex + index);
            });
            break;

        case 'MultiPolygon':
            feature.geometry.coordinates.forEach(polygon => {
                const outerRing = polygon[0];
                const holes = polygon.slice(1);
                
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
                const allCoords = polygon.flat(1);
                const fillStartIndex = coordsToVertices(allCoords, _fillColor, fillVertices);
                const hiddenStartIndex = coordsToIdVertices(allCoords, 
                    featureId, hiddenVertices);

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
            const transformedPoint = getTransformedCoord(feature.geometry.coordinates);
            fillVertices.push(transformedPoint[0], transformedPoint[1], ..._fillColor);
            break;
            
        default:
            // console.warn(`Unsupported GeoJSON type: ${feature.geometry.type}`);
    }

    return {
        vertices: new Float32Array(fillVertices),
        hiddenVertices: new Float32Array(hiddenVertices),
        fillIndices: new Uint16Array(fillIndices),
        outlineIndices: new Uint16Array(outlineIndices),
        hiddenfillIndices: new Uint16Array(hiddenfillIndices),
        isFilled,
        isLine,
        properties: {
            ...feature.properties,
            fid: featureId,           // Original feature ID
            clampedFid: clampedFeatureId  // ID actually used in rendering (1-254)
        }
    };
}
