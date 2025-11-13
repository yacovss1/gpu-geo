/**
 * StyleManager - High-level interface for map style management
 * 
 * Responsibilities:
 * - Load and set map styles
 * - Configure tile sources from style
 * - Manage layer visibility
 * - List available layers
 */

import { getStyle, setStyle, setLayerVisibility, getLayerVisibility, getLayer } from './style.js';
import { clearTileCache, resetNotFoundTiles, setTileSource } from '../tiles/geojson.js';

export class StyleManager {
    constructor() {
        this.tileReloadCallback = null;
    }
    
    /**
     * Set callback function to trigger tile reload
     */
    setTileReloadCallback(callback) {
        this.tileReloadCallback = callback;
    }
    
    /**
     * Set map style using Mapbox/MapLibre style specification
     */
    async setStyle(style) {
        await setStyle(style);
        
        // Extract tile source from style and configure
        const currentStyle = getStyle();
        if (currentStyle && currentStyle.sources) {
            const firstVectorSource = Object.entries(currentStyle.sources).find(
                ([_, source]) => source.type === 'vector'
            );
            
            if (firstVectorSource) {
                const [sourceId, source] = firstVectorSource;
                if (source.tiles && source.tiles.length > 0) {
                    setTileSource({
                        url: source.tiles[0],
                        maxZoom: source.maxzoom || 14,
                        timeout: 10000
                    });
                }
            }
        }
        
        // Reload tiles with new style
        clearTileCache();
        resetNotFoundTiles();
        
        if (this.tileReloadCallback) {
            this.tileReloadCallback();
        }
    }
    
    /**
     * Get current style
     */
    getStyle() {
        return getStyle();
    }
    
    /**
     * Load a style from URL
     */
    async loadStyleFromURL(url) {
        const response = await fetch(url);
        const style = await response.json();
        await this.setStyle(style);
    }
    
    /**
     * Set layer visibility
     */
    async setLayerVisibility(layerId, visible) {
        setLayerVisibility(layerId, visible);
        
        // Force re-render by triggering tile reload
        clearTileCache();
        resetNotFoundTiles();
        
        if (this.tileReloadCallback) {
            this.tileReloadCallback();
        }
    }
    
    /**
     * Get layer visibility
     */
    getLayerVisibility(layerId) {
        return getLayerVisibility(layerId);
    }
    
    /**
     * List all layers with metadata
     */
    listLayers() {
        const style = getStyle();
        return style?.layers.map(l => ({ 
            id: l.id, 
            type: l.type, 
            sourceLayer: l['source-layer'],
            visible: l.layout?.visibility !== 'none'
        })) || [];
    }
    
    /**
     * Check if layer should render at current zoom
     */
    shouldRenderLayer(layerId, zoom) {
        if (!getLayerVisibility(layerId)) return false;
        
        const layer = getLayer(layerId);
        if (!layer) return false;
        
        // Check minzoom
        if (layer.minzoom !== undefined && zoom < layer.minzoom) return false;
        
        // Check maxzoom
        if (layer.maxzoom !== undefined && zoom > layer.maxzoom) return false;
        
        return true;
    }
}
