// Style Specification Parser
// Implements Mapbox/MapLibre GL style specification support
// https://docs.mapbox.com/style-spec/reference/

let currentStyle = null;

/**
 * Set the map style using Mapbox/MapLibre style specification
 * @param {Object} style - Style JSON object
 * @returns {Promise<void>}
 */
export async function setStyle(style) {
    if (!style || typeof style !== 'object') {
        throw new Error('Style must be a valid object');
    }

    if (style.version !== 8) {
        console.warn('Only style specification version 8 is supported');
    }

    currentStyle = {
        version: style.version || 8,
        sources: style.sources || {},
        layers: style.layers || [],
        glyphs: style.glyphs,
        sprite: style.sprite
    };

    // Process sources to extract tile URLs and promoteId settings
    for (const [sourceId, source] of Object.entries(currentStyle.sources)) {
        if (source.type === 'vector') {
            // Handle both direct tiles URL and TileJSON URL
            if (source.url) {
                // Fetch TileJSON if URL is provided
                try {
                    const response = await fetch(source.url);
                    const tileJson = await response.json();
                    source.tiles = tileJson.tiles;
                    source.minzoom = tileJson.minzoom || 0;
                    source.maxzoom = tileJson.maxzoom || 14;
                    source.bounds = tileJson.bounds;
                    source.center = tileJson.center;
                    // Store the full TileJSON for reference
                    source._tileJson = tileJson;
                } catch (error) {
                    console.error(`Failed to fetch TileJSON for source ${sourceId}:`, error);
                }
            }
        }
    }

    return currentStyle;
}

/**
 * Get the current style configuration
 * @returns {Object|null}
 */
export function getStyle() {
    return currentStyle;
}

/**
 * Set layer visibility
 * @param {string} layerId - Layer ID
 * @param {boolean} visible - Visibility state
 */
export function setLayerVisibility(layerId, visible) {
    if (!currentStyle) return;
    
    const layer = currentStyle.layers.find(l => l.id === layerId);
    if (layer) {
        if (!layer.layout) layer.layout = {};
        layer.layout.visibility = visible ? 'visible' : 'none';
    }
}

/**
 * Get layer visibility
 * @param {string} layerId - Layer ID
 * @returns {boolean}
 */
export function getLayerVisibility(layerId) {
    if (!currentStyle) return false;
    
    const layer = currentStyle.layers.find(l => l.id === layerId);
    if (!layer) return false;
    
    return layer.layout?.visibility !== 'none';
}

/**
 * Get tile URL template for a specific source
 * @param {string} sourceId - Source ID from style
 * @returns {string|null}
 */
export function getSourceTileUrl(sourceId) {
    if (!currentStyle || !currentStyle.sources[sourceId]) {
        return null;
    }

    const source = currentStyle.sources[sourceId];
    if (source.tiles && source.tiles.length > 0) {
        return source.tiles[0]; // Return first tile URL
    }

    return null;
}

/**
 * Get promoteId setting for a source
 * @param {string} sourceId - Source ID from style
 * @returns {string|object|null}
 */
export function getSourcePromoteId(sourceId) {
    if (!currentStyle || !currentStyle.sources[sourceId]) {
        return null;
    }

    return currentStyle.sources[sourceId].promoteId || null;
}

/**
 * Get all layers that use a specific source
 * @param {string} sourceId - Source ID
 * @returns {Array}
 */
export function getLayersBySource(sourceId) {
    if (!currentStyle) {
        return [];
    }

    return currentStyle.layers.filter(layer => layer.source === sourceId);
}

/**
 * Get layer by ID
 * @param {string} layerId - Layer ID
 * @returns {Object|null}
 */
export function getLayer(layerId) {
    if (!currentStyle) {
        return null;
    }

    return currentStyle.layers.find(layer => layer.id === layerId) || null;
}

/**
 * Check if a tile coordinate is within the source bounds
 * @param {number} x - Tile X
 * @param {number} y - Tile Y  
 * @param {number} z - Tile Z
 * @param {string} sourceId - Source ID
 * @returns {boolean}
 */
export function isTileInBounds(x, y, z, sourceId) {
    if (!currentStyle || !sourceId) return true;
    
    const source = currentStyle.sources[sourceId];
    if (!source || !source.bounds) return true;
    
    const [minLng, minLat, maxLng, maxLat] = source.bounds;
    
    // Convert tile coordinates to lat/lng bounds
    const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
    const maxTileLat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    const minTileLng = (x / Math.pow(2, z)) * 360 - 180;
    
    const n2 = Math.PI - (2 * Math.PI * (y + 1)) / Math.pow(2, z);
    const minTileLat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n2) - Math.exp(-n2)));
    const maxTileLng = ((x + 1) / Math.pow(2, z)) * 360 - 180;
    
    // Check if tile overlaps with source bounds
    return !(maxTileLng < minLng || minTileLng > maxLng || maxTileLat < minLat || minTileLat > maxLat);
}

/**
 * Evaluate a style expression (simplified implementation)
 * @param {*} expression - Style expression (literal, get, match, etc.)
 * @param {Object} feature - GeoJSON feature
 * @param {number} zoom - Current zoom level
 * @returns {*}
 */
export function evaluateExpression(expression, feature, zoom) {
    // Handle literal values
    if (!Array.isArray(expression)) {
        return expression;
    }

    const [operator, ...args] = expression;

    switch (operator) {
        case 'get':
            // ["get", "property_name"]
            return feature.properties?.[args[0]];

        case 'literal':
            // ["literal", value]
            return args[0];

        case 'match':
            // ["match", input, label1, output1, label2, output2, ..., fallback]
            const input = evaluateExpression(args[0], feature, zoom);
            for (let i = 1; i < args.length - 1; i += 2) {
                const label = args[i];
                // Check if label is an array - if so, check if input is in the array
                if (Array.isArray(label)) {
                    if (label.includes(input)) {
                        return evaluateExpression(args[i + 1], feature, zoom);
                    }
                } else {
                    // Direct equality check
                    if (input === label) {
                        return evaluateExpression(args[i + 1], feature, zoom);
                    }
                }
            }
            return evaluateExpression(args[args.length - 1], feature, zoom);

        case 'case':
            // ["case", condition1, output1, condition2, output2, ..., fallback]
            for (let i = 0; i < args.length - 1; i += 2) {
                if (evaluateExpression(args[i], feature, zoom)) {
                    return evaluateExpression(args[i + 1], feature, zoom);
                }
            }
            return evaluateExpression(args[args.length - 1], feature, zoom);

        case '==':
            return evaluateExpression(args[0], feature, zoom) === evaluateExpression(args[1], feature, zoom);

        case '!=':
            return evaluateExpression(args[0], feature, zoom) !== evaluateExpression(args[1], feature, zoom);

        case '>':
            return evaluateExpression(args[0], feature, zoom) > evaluateExpression(args[1], feature, zoom);

        case '>=':
            return evaluateExpression(args[0], feature, zoom) >= evaluateExpression(args[1], feature, zoom);

        case '<':
            return evaluateExpression(args[0], feature, zoom) < evaluateExpression(args[1], feature, zoom);

        case '<=':
            return evaluateExpression(args[0], feature, zoom) <= evaluateExpression(args[1], feature, zoom);

        case 'all':
            return args.every(arg => evaluateExpression(arg, feature, zoom));

        case 'any':
            return args.some(arg => evaluateExpression(arg, feature, zoom));

        case '!':
            return !evaluateExpression(args[0], feature, zoom);

        case 'has':
            return feature.properties?.hasOwnProperty(args[0]);

        case 'in':
            const value = evaluateExpression(args[0], feature, zoom);
            const array = evaluateExpression(args[1], feature, zoom);
            return Array.isArray(array) && array.includes(value);

        case 'interpolate':
            // ["interpolate", interpolation, input, stop1, output1, stop2, output2, ...]
            // Simplified: only supports linear interpolation
            const interpolationType = args[0];
            const input2 = evaluateExpression(args[1], feature, zoom);
            
            // Find the two stops to interpolate between
            for (let i = 2; i < args.length - 2; i += 2) {
                const stop1 = args[i];
                const stop2 = args[i + 2];
                
                if (input2 >= stop1 && input2 <= stop2) {
                    const output1 = args[i + 1];
                    const output2 = args[i + 3];
                    const t = (input2 - stop1) / (stop2 - stop1);
                    
                    // Linear interpolation for numbers
                    if (typeof output1 === 'number' && typeof output2 === 'number') {
                        return output1 + t * (output2 - output1);
                    }
                    
                    // For colors and other types, return the nearest
                    return t < 0.5 ? output1 : output2;
                }
            }
            
            // Return first or last output if outside range
            return input2 < args[2] ? args[3] : args[args.length - 1];

        case 'step':
            // ["step", input, default, stop1, output1, stop2, output2, ...]
            const stepInput = evaluateExpression(args[0], feature, zoom);
            let stepOutput = args[1]; // default value
            
            for (let i = 2; i < args.length; i += 2) {
                if (stepInput >= args[i]) {
                    stepOutput = args[i + 1];
                } else {
                    break;
                }
            }
            
            return stepOutput;

        case 'zoom':
            return zoom;

        default:
            console.warn(`Unknown expression operator: ${operator}`);
            return null;
    }
}

/**
 * Evaluate a filter expression to determine if a feature should be included
 * @param {Array} filter - Filter expression
 * @param {Object} feature - GeoJSON feature
 * @param {number} zoom - Current zoom level
 * @returns {boolean}
 */
export function evaluateFilter(filter, feature, zoom) {
    if (!filter || !Array.isArray(filter)) {
        return true; // No filter means include all
    }

    return evaluateExpression(filter, feature, zoom);
}

/**
 * Get paint property value for a layer and feature
 * @param {string} layerId - Layer ID
 * @param {string} property - Paint property name (e.g., 'fill-color')
 * @param {Object} feature - GeoJSON feature
 * @param {number} zoom - Current zoom level
 * @returns {*}
 */
export function getPaintProperty(layerId, property, feature, zoom) {
    const layer = getLayer(layerId);
    if (!layer || !layer.paint) {
        return null;
    }

    const value = layer.paint[property];
    if (value === undefined) {
        return null;
    }

    return evaluateExpression(value, feature, zoom);
}

/**
 * Convert a color value to RGBA array
 * @param {string|Array} color - Color string (hex, rgb, rgba) or array
 * @returns {Array<number>} RGBA array [r, g, b, a] with values 0-1
 */
export function parseColor(color) {
    if (Array.isArray(color)) {
        // Already an array, ensure it has 4 components
        return color.length === 4 ? color : [...color, 1.0];
    }

    if (typeof color === 'string') {
        // Hex color
        if (color.startsWith('#')) {
            const hex = color.slice(1);
            const r = parseInt(hex.slice(0, 2), 16) / 255;
            const g = parseInt(hex.slice(2, 4), 16) / 255;
            const b = parseInt(hex.slice(4, 6), 16) / 255;
            const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1.0;
            return [r, g, b, a];
        }

        // RGB/RGBA
        if (color.startsWith('rgb')) {
            const match = color.match(/[\d.]+/g);
            if (match) {
                const r = parseFloat(match[0]) / 255;
                const g = parseFloat(match[1]) / 255;
                const b = parseFloat(match[2]) / 255;
                const a = match[3] !== undefined ? parseFloat(match[3]) : 1.0;
                return [r, g, b, a];
            }
        }

        // Named colors (simplified)
        const namedColors = {
            'black': [0, 0, 0, 1],
            'white': [1, 1, 1, 1],
            'red': [1, 0, 0, 1],
            'green': [0, 1, 0, 1],
            'blue': [0, 0, 1, 1],
            'gray': [0.5, 0.5, 0.5, 1],
            'grey': [0.5, 0.5, 0.5, 1],
            'transparent': [0, 0, 0, 0]
        };

        if (namedColors[color.toLowerCase()]) {
            return namedColors[color.toLowerCase()];
        }
    }

    // Default fallback
    return [0.7, 0.7, 0.7, 1.0];
}

/**
 * Get feature ID based on promoteId configuration
 * @param {Object} feature - GeoJSON feature
 * @param {string} sourceId - Source ID
 * @returns {number|string}
 */
export function getFeatureId(feature, sourceId) {
    const promoteId = getSourcePromoteId(sourceId);
    
    if (promoteId) {
        // If promoteId is a string, use that property
        if (typeof promoteId === 'string') {
            return feature.properties?.[promoteId] || feature.id || generateFeatureId(feature);
        }
        
        // If promoteId is an object with source-layer keys
        if (typeof promoteId === 'object' && feature.layer) {
            const propertyName = promoteId[feature.layer.name];
            if (propertyName) {
                return feature.properties?.[propertyName] || feature.id || generateFeatureId(feature);
            }
        }
    }

    // Fall back to feature.id if present
    if (feature.id !== undefined) {
        return feature.id;
    }

    // Generate a stable ID from feature properties
    return generateFeatureId(feature);
}

/**
 * Generate a stable feature ID from feature properties
 * @param {Object} feature - GeoJSON feature
 * @returns {number}
 */
function generateFeatureId(feature) {
    // Simple hash of stringified properties
    const str = JSON.stringify(feature.properties || {});
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash) || 1;
}
