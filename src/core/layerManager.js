/**
 * Layer Manager - Manages multiple independent rendering layers
 * 
 * Unlike Mapbox/MapLibre's single-style approach, this allows:
 * - Multiple vector tile sources with different styles
 * - Terrain layer independent of vector style
 * - Custom data layers (GeoJSON, etc.)
 * - Each layer has its own rendering pipeline
 * 
 * Similar to ESRI's layer system
 */

import { TerrainLayer } from '../rendering/terrainLayer.js';

export class LayerManager {
    constructor(device, format) {
        this.device = device;
        this.format = format;
        this.layers = new Map();
        this.layerOrder = []; // Render order (bottom to top)
    }

    /**
     * Add a terrain layer
     */
    async addTerrainLayer(id, options = {}) {
        const layer = new TerrainLayer(this.device);
        await layer.initialize(this.format);
        
        layer.setEnabled(options.enabled !== false);
        if (options.exaggeration) layer.setExaggeration(options.exaggeration);
        if (options.source) layer.setSource(options.source);
        
        this.layers.set(id, {
            type: 'terrain',
            instance: layer,
            visible: options.visible !== false,
            opacity: options.opacity ?? 1.0,
            order: options.order ?? this.layerOrder.length
        });
        
        this.updateLayerOrder();
        return layer;
    }

    /**
     * Add a vector tile layer (uses existing TileManager)
     * Each vector layer can have its own style
     */
    addVectorLayer(id, options = {}) {
        this.layers.set(id, {
            type: 'vector',
            styleUrl: options.styleUrl,
            style: options.style,
            visible: options.visible !== false,
            opacity: options.opacity ?? 1.0,
            order: options.order ?? this.layerOrder.length,
            tileManager: options.tileManager // Reference to TileManager
        });
        
        this.updateLayerOrder();
    }

    /**
     * Add a custom data layer (GeoJSON, etc.)
     */
    addDataLayer(id, options = {}) {
        this.layers.set(id, {
            type: 'data',
            data: options.data,
            style: options.style,
            visible: options.visible !== false,
            opacity: options.opacity ?? 1.0,
            order: options.order ?? this.layerOrder.length
        });
        
        this.updateLayerOrder();
    }

    /**
     * Remove a layer
     */
    removeLayer(id) {
        const layer = this.layers.get(id);
        if (layer) {
            if (layer.instance?.destroy) {
                layer.instance.destroy();
            }
            this.layers.delete(id);
            this.updateLayerOrder();
        }
    }

    /**
     * Set layer visibility
     */
    setLayerVisibility(id, visible) {
        const layer = this.layers.get(id);
        if (layer) {
            layer.visible = visible;
            if (layer.instance?.setEnabled) {
                layer.instance.setEnabled(visible);
            }
        }
    }

    /**
     * Set layer opacity
     */
    setLayerOpacity(id, opacity) {
        const layer = this.layers.get(id);
        if (layer) {
            layer.opacity = Math.max(0, Math.min(1, opacity));
        }
    }

    /**
     * Reorder layers
     */
    setLayerOrder(id, order) {
        const layer = this.layers.get(id);
        if (layer) {
            layer.order = order;
            this.updateLayerOrder();
        }
    }

    /**
     * Move layer to top
     */
    moveToTop(id) {
        const maxOrder = Math.max(...Array.from(this.layers.values()).map(l => l.order));
        this.setLayerOrder(id, maxOrder + 1);
    }

    /**
     * Move layer to bottom
     */
    moveToBottom(id) {
        const minOrder = Math.min(...Array.from(this.layers.values()).map(l => l.order));
        this.setLayerOrder(id, minOrder - 1);
    }

    /**
     * Update sorted layer order
     */
    updateLayerOrder() {
        this.layerOrder = Array.from(this.layers.entries())
            .sort((a, b) => a[1].order - b[1].order)
            .map(([id]) => id);
    }

    /**
     * Get layer by ID
     */
    getLayer(id) {
        return this.layers.get(id);
    }

    /**
     * Get all layers in render order
     */
    getLayersInOrder() {
        return this.layerOrder.map(id => ({
            id,
            ...this.layers.get(id)
        }));
    }

    /**
     * Render all visible layers in order
     */
    render(pass, context) {
        for (const id of this.layerOrder) {
            const layer = this.layers.get(id);
            if (!layer || !layer.visible) continue;
            
            switch (layer.type) {
                case 'terrain':
                    layer.instance.render(
                        pass,
                        context.cameraMatrix,
                        context.camera,
                        context.zoom
                    );
                    break;
                    
                case 'vector':
                    // Vector layers rendered by existing TileManager/renderer
                    // This is handled separately in the main render loop
                    break;
                    
                case 'data':
                    // Custom data layer rendering
                    // TODO: Implement
                    break;
            }
        }
    }

    /**
     * Get terrain layer (convenience method)
     */
    getTerrain(id = 'terrain') {
        const layer = this.layers.get(id);
        return layer?.type === 'terrain' ? layer.instance : null;
    }

    /**
     * Enable/disable terrain globally
     */
    setTerrainEnabled(enabled, id = 'terrain') {
        const terrain = this.getTerrain(id);
        if (terrain) {
            terrain.setEnabled(enabled);
        }
    }

    /**
     * Set terrain exaggeration
     */
    setTerrainExaggeration(factor, id = 'terrain') {
        const terrain = this.getTerrain(id);
        if (terrain) {
            terrain.setExaggeration(factor);
        }
    }

    destroy() {
        for (const [id, layer] of this.layers) {
            if (layer.instance?.destroy) {
                layer.instance.destroy();
            }
        }
        this.layers.clear();
        this.layerOrder = [];
    }
}
