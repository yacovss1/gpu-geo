/**
 * Global terrain configuration
 * Central place to manage terrain settings across the codebase
 * 
 * NOTE: setExaggeration() API does NOT work on vector features in real-time!
 * The terrain overlay layer (when enabled) responds to exaggeration changes,
 * but vector features bake heights at tile parse time using TileCoordinator.
 * When overlay is disabled, terrainLayer.terrainTiles is empty, so buildTerrainAtlas()
 * returns null, and GPU shader gets enabled=0. This is a known architectural issue.
 * TODO: Either share terrain tiles between terrainLayer and tileCoordinator,
 * or trigger full tile reload when exaggeration changes.
 */

export const TERRAIN_CONFIG = {
    // Default terrain exaggeration factor
    DEFAULT_EXAGGERATION: 15,
    
    // Minimum zoom level to display terrain
    DEFAULT_MIN_ZOOM: 8,
    
    // Default terrain source
    DEFAULT_SOURCE: 'aws'
};
