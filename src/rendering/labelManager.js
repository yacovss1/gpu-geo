/**
 * LabelManager - Handles label extraction, text evaluation, and feature mapping
 * 
 * Responsibilities:
 * - Build feature name maps from tile buffers
 * - Evaluate text-field expressions from style
 * - Extract building heights
 * - Map feature IDs to labels
 */

import { getStyle, getPaintProperty } from '../core/style.js';

export class LabelManager {
    constructor() {
        // Track debug logging to avoid spam
        this.debugLogged = {
            symbolLayers: false,
            tileBufferLayers: false,
            buildingLabel: false,
            featureNames: false,
            buildingCheck: false,
            extrusionFound: false,
            sourceLayerCheck: false
        };
    }
    
    /**
     * Build map of feature IDs to names and metadata
     */
    buildFeatureNameMap(tileBuffers, currentZoom, verbose = false) {
        const featureNames = new Map();
        const style = getStyle();
        const symbolLayers = style?.layers?.filter(l => l.type === 'symbol') || [];
        
        if (!this.debugLogged.buildingCheck) {
            console.log('🏗️ Label Manager: Checking', tileBuffers.size, 'layers for labels');
            console.log('🏗️ Layer IDs:', Array.from(tileBuffers.keys()));
            this.debugLogged.buildingCheck = true;
        }
        
        // Iterate through all layers
        for (const [layerId, buffers] of tileBuffers) {
            for (const tileBuffer of buffers) {
                if (!tileBuffer.properties) continue;
                const clampedFid = tileBuffer.properties.clampedFid;
                const sourceLayer = tileBuffer.properties.sourceLayer;
                
                if (!this.debugLogged.sourceLayerCheck && sourceLayer) {
                    console.log(`🔍 Checking layer "${layerId}": sourceLayer="${sourceLayer}", fid=${clampedFid}`);
                    this.debugLogged.sourceLayerCheck = true;
                }
                
                // Find matching symbol layer for this feature's source-layer
                const matchingSymbolLayer = symbolLayers.find(layer => 
                    layer['source-layer'] === sourceLayer
                );
                
                let labelText = null;
                
                if (matchingSymbolLayer && matchingSymbolLayer.layout?.['text-field']) {
                    // Evaluate text-field expression
                    const textField = matchingSymbolLayer.layout['text-field'];
                    labelText = this.evaluateTextField(textField, tileBuffer.properties);
                } else {
                    // Fallback to legacy name properties
                    labelText = tileBuffer.properties.NAME || tileBuffer.properties.name || 
                               tileBuffer.properties.ADM0_A3 || tileBuffer.properties.ISO_A3;
                }
                
                // For buildings WITHOUT labels, create a synthetic label showing height
                if (!labelText && sourceLayer === 'building' && clampedFid) {
                    // Find the fill-extrusion layer for this source-layer to get height
                    const extrusionLayer = style?.layers?.find(layer => 
                        layer.type === 'fill-extrusion' && 
                        layer['source-layer'] === sourceLayer
                    );
                    
                    if (extrusionLayer) {
                        const heightValue = getPaintProperty(extrusionLayer.id, 'fill-extrusion-height', 
                            { properties: tileBuffer.properties }, currentZoom);
                        if (heightValue > 0) {
                            labelText = `${Math.round(heightValue)}m`; // Create synthetic label
                        }
                    }
                }
                
                if (clampedFid && labelText) {
                    // Extract building height from fill-extrusion paint properties
                    let totalHeight = 0;
                    
                    // Find the fill-extrusion layer for this source-layer
                    const extrusionLayer = style?.layers?.find(layer => 
                        layer.type === 'fill-extrusion' && 
                        layer['source-layer'] === sourceLayer
                    );
                    
                    if (extrusionLayer) {
                        // Evaluate the fill-extrusion-height expression
                        const heightValue = getPaintProperty(extrusionLayer.id, 'fill-extrusion-height', 
                            { properties: tileBuffer.properties }, currentZoom);
                        totalHeight = heightValue || 0;
                        
                        if (!this.debugLogged.extrusionFound && totalHeight > 0) {
                            console.log('🏢 Found extruded building:', labelText, 'height:', totalHeight, 'fid:', clampedFid);
                            this.debugLogged.extrusionFound = true;
                        }
                    }
                    
                    featureNames.set(clampedFid, { 
                        name: labelText, 
                        sourceLayer, 
                        properties: tileBuffer.properties,
                        height: totalHeight
                    });
                }
            }
        }
        
        return featureNames;
    }
    
    /**
     * Evaluate text-field expressions from MapLibre style spec
     */
    evaluateTextField(textField, properties) {
        if (typeof textField === 'string') {
            return textField;
        }
        
        if (Array.isArray(textField)) {
            const [operation, ...args] = textField;
            
            switch (operation) {
                case 'get':
                    return properties[args[0]];
                
                case 'to-string':
                    const value = this.evaluateTextField(args[0], properties);
                    return value != null ? String(value) : '';
                
                case 'concat':
                    return args.map(arg => {
                        const val = this.evaluateTextField(arg, properties);
                        return val != null ? String(val) : '';
                    }).join('');
                
                default:
                    return null;
            }
        }
        
        return textField;
    }
    
    /**
     * Calculate centroid from vertex array
     */
    calculateCentroid(vertices) {
        if (!vertices || vertices.length < 6) return null;
        
        let sumX = 0, sumY = 0;
        let count = 0;
        
        // Vertices are [x, y, r, g, b, a, ...]
        for (let i = 0; i < vertices.length; i += 6) {
            sumX += vertices[i];
            sumY += vertices[i + 1];
            count++;
        }
        
        if (count === 0) return null;
        
        return [sumX / count, sumY / count];
    }
}
