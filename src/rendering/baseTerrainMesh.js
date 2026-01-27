/**
 * Base Terrain Mesh Generator
 * 
 * Generates a continuous terrain mesh for each tile to fill "negative space"
 * so features (buildings, roads) don't float in empty space.
 * 
 * This mesh covers the entire tile with terrain elevation and receives lighting.
 */

import { transformTileCoords } from '../tiles/vectorTileParser.js';

export class BaseTerrainMeshGenerator {
    constructor(gridSize = 32, exaggeration = 20) {
        this.gridSize = gridSize;
        this.exaggeration = exaggeration;
    }
    
    /**
     * Set exaggeration factor
     */
    setExaggeration(exaggeration) {
        this.exaggeration = exaggeration;
    }

    /**
     * Generate a terrain mesh covering an entire tile
     * @param {Object} terrainData - Terrain heightmap data
     * @param {number} z - Tile zoom level
     * @param {number} x - Tile X coordinate
     * @param {number} y - Tile Y coordinate
     * @param {Array} color - Base land color [r, g, b, a]
     * @returns {Object} - { vertices: Float32Array, indices: Uint32Array }
     */
    generateTileMesh(terrainData, z, x, y, color = [0.6, 0.5, 0.4, 1.0]) {
        const n = this.gridSize;
        const extent = 4096;
        const vertices = [];
        const indices = [];

        // Sample terrain heights for normal calculation
        const heights = [];
        for (let gy = 0; gy <= n; gy++) {
            heights[gy] = [];
            for (let gx = 0; gx <= n; gx++) {
                const u = gx / n;
                const v = gy / n;
                heights[gy][gx] = this.sampleTerrainHeight(u, v, terrainData);
            }
        }

        // Tiny Z offset to push base terrain just below other layers
        // This must be small enough to not be visually noticeable
        // but large enough to consistently lose depth test to other features
        const baseTerrainZOffset = -0.0000006;

        // Generate vertices with proper normals
        for (let gy = 0; gy <= n; gy++) {
            for (let gx = 0; gx <= n; gx++) {
                const tilePixelX = (gx / n) * extent;
                const tilePixelY = (gy / n) * extent;
                const [clipX, clipY] = transformTileCoords(tilePixelX, tilePixelY, x, y, z, extent);

                const height = heights[gy][gx] + baseTerrainZOffset;
                const normal = this.calculateNormal(gx, gy, n, heights);

                vertices.push(
                    clipX, clipY, height,
                    ...normal,
                    ...color
                );
            }
        }

        // Generate triangle indices
        for (let gy = 0; gy < n; gy++) {
            for (let gx = 0; gx < n; gx++) {
                const i00 = gy * (n + 1) + gx;
                const i10 = i00 + 1;
                const i01 = i00 + (n + 1);
                const i11 = i01 + 1;

                // Two triangles per quad
                indices.push(i00, i10, i11);
                indices.push(i00, i11, i01);
            }
        }

        return {
            vertices: new Float32Array(vertices),
            indices: new Uint32Array(indices)
        };
    }

    /**
     * Sample terrain height from heightmap
     */
    sampleTerrainHeight(u, v, terrainData) {
        if (!terrainData || !terrainData.heights) return 0;

        const tw = terrainData.width;
        const th = terrainData.height;

        // Clamp UV coordinates
        u = Math.max(0, Math.min(1, u));
        v = Math.max(0, Math.min(1, v));

        const x = u * (tw - 1);
        const y = v * (th - 1);

        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const x1 = Math.min(x0 + 1, tw - 1);
        const y1 = Math.min(y0 + 1, th - 1);

        const fx = x - x0;
        const fy = y - y0;

        // Bilinear interpolation
        const h00 = terrainData.heights[y0 * tw + x0] || 0;
        const h10 = terrainData.heights[y0 * tw + x1] || 0;
        const h01 = terrainData.heights[y1 * tw + x0] || 0;
        const h11 = terrainData.heights[y1 * tw + x1] || 0;

        const h0 = h00 * (1 - fx) + h10 * fx;
        const h1 = h01 * (1 - fx) + h11 * fx;

        const rawHeight = h0 * (1 - fy) + h1 * fy;
        
        // Apply exaggeration (same formula as terrainPolygonBuilder)
        return Math.max(0, rawHeight) / 50000000.0 * this.exaggeration;
    }

    /**
     * Calculate terrain normal from neighboring heights
     */
    calculateNormal(gx, gy, n, heights) {
        const getHeight = (x, y) => {
            if (x < 0 || x > n || y < 0 || y > n) return 0;
            return heights[y][x];
        };

        const hCenter = getHeight(gx, gy);
        const hRight = getHeight(gx + 1, gy);
        const hLeft = getHeight(gx - 1, gy);
        const hUp = getHeight(gx, gy + 1);
        const hDown = getHeight(gx, gy - 1);

        // Calculate gradient using central differences
        const dx = (hRight - hLeft) / 2.0;
        const dy = (hUp - hDown) / 2.0;

        // Normal is perpendicular to surface tangents
        const normal = [-dx, -dy, 1.0];

        // Normalize
        const len = Math.sqrt(normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]);
        return [normal[0] / len, normal[1] / len, normal[2] / len];
    }
}
