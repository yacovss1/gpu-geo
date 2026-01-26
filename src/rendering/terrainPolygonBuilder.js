/**
 * Terrain Polygon Builder
 * 
 * Extracts terrain mesh vertices that fall inside polygon boundaries
 * and builds polygon geometry using those terrain vertices.
 * 
 * This makes polygons true 3D features that follow terrain exactly.
 * 
 * Uses GPU compute for point-in-polygon testing (fast parallel).
 * Falls back to CPU if GPU compute not available.
 */

import { transformTileCoords } from '../tiles/vectorTileParser.js';
import { PolygonTerrainCompute } from './polygonTerrainCompute.js';

export class TerrainPolygonBuilder {
    constructor(device, gridSize = 32, exaggeration = 30) {
        this.device = device;
        this.gridSize = gridSize;
        this.exaggeration = exaggeration;
        this.gpuCompute = null;
        this.useGPU = !!device;
        
        // Initialize GPU compute if device available
        if (device) {
            this.gpuCompute = new PolygonTerrainCompute(device);
        }
    }
    
    /**
     * Set exaggeration factor
     */
    setExaggeration(exaggeration) {
        this.exaggeration = exaggeration;
    }

    /**
     * Build polygon geometry using terrain mesh vertices (GPU-accelerated)
     */
    async buildPolygonFromTerrainGPU(polygon, terrainData, z, x, y) {
        const { coords, color } = polygon;
        if (!coords || coords.length === 0) return null;

        const outerRing = coords[0];
        if (outerRing.length < 3) return null;

        const n = this.gridSize;
        const UP_NORMAL = [0, 0, 1];

        // Run GPU compute for point-in-polygon
        const results = await this.gpuCompute.computePolygonGrid(
            polygon, terrainData, z, x, y, n, this.exaggeration
        );

        if (!results) return null;

        // Build vertex map from GPU results
        const gridVertices = [];
        const vertexIndexMap = new Map();

        for (let gy = 0; gy <= n; gy++) {
            for (let gx = 0; gx <= n; gx++) {
                const idx = gy * (n + 1) + gx;
                const result = results[idx];
                
                if (result.inside) {
                    const vertIdx = gridVertices.length;
                    gridVertices.push({
                        gx, gy,
                        clipX: result.clipX,
                        clipY: result.clipY,
                        height: result.height
                    });
                    vertexIndexMap.set(`${gx},${gy}`, vertIdx);
                }
            }
        }

        if (gridVertices.length < 3) {
            return null;
        }

        // Build triangles from grid quads where all 4 corners are inside
        const indices = [];
        
        for (let gy = 0; gy < n; gy++) {
            for (let gx = 0; gx < n; gx++) {
                const key00 = `${gx},${gy}`;
                const key10 = `${gx+1},${gy}`;
                const key01 = `${gx},${gy+1}`;
                const key11 = `${gx+1},${gy+1}`;
                
                if (vertexIndexMap.has(key00) && vertexIndexMap.has(key10) &&
                    vertexIndexMap.has(key01) && vertexIndexMap.has(key11)) {
                    
                    const i00 = vertexIndexMap.get(key00);
                    const i10 = vertexIndexMap.get(key10);
                    const i01 = vertexIndexMap.get(key01);
                    const i11 = vertexIndexMap.get(key11);
                    
                    indices.push(i00, i10, i11);
                    indices.push(i00, i11, i01);
                }
            }
        }

        if (indices.length === 0) {
            return null;
        }

        // Build vertex buffer
        const vertices = [];
        for (const v of gridVertices) {
            vertices.push(
                v.clipX, v.clipY, v.height,
                ...UP_NORMAL,
                ...color
            );
        }

        return {
            vertices: new Float32Array(vertices),
            indices: new Uint32Array(indices)
        };
    }

    /**
     * Build polygon geometry using terrain mesh vertices (CPU fallback)
     */
    buildPolygonFromTerrain(polygon, terrainData, z, x, y) {
        const { coords, color } = polygon;
        if (!coords || coords.length === 0) return null;

        const outerRing = coords[0];
        const holes = coords.slice(1);
        
        if (outerRing.length < 3) return null;

        const n = this.gridSize;
        const extent = 4096;
        const UP_NORMAL = [0, 0, 1];

        // Calculate bounding box in clip space for faster culling
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        for (const [px, py] of outerRing) {
            minX = Math.min(minX, px);
            maxX = Math.max(maxX, px);
            minY = Math.min(minY, py);
            maxY = Math.max(maxY, py);
        }

        // Convert clip-space bounds back to grid indices
        // We need to find which grid cells overlap the polygon
        const gridVertices = [];
        const vertexIndexMap = new Map();

        // Iterate grid and check only points that could be in bounds
        for (let gy = 0; gy <= n; gy++) {
            for (let gx = 0; gx <= n; gx++) {
                const tilePixelX = (gx / n) * extent;
                const tilePixelY = (gy / n) * extent;
                const [clipX, clipY] = transformTileCoords(tilePixelX, tilePixelY, x, y, z, extent);

                // Quick bounding box check first
                if (clipX < minX || clipX > maxX || clipY < minY || clipY > maxY) {
                    continue;
                }

                // Full point-in-polygon check
                if (this.pointInPolygon(clipX, clipY, outerRing, holes)) {
                    const height = this.sampleTerrainHeight(gx, gy, n, terrainData);
                    
                    const idx = gridVertices.length;
                    gridVertices.push({ gx, gy, clipX, clipY, height });
                    vertexIndexMap.set(`${gx},${gy}`, idx);
                }
            }
        }

        if (gridVertices.length < 3) {
            return null;
        }

        // Build triangles from grid quads where all 4 corners are inside
        const indices = [];
        
        for (let gy = 0; gy < n; gy++) {
            for (let gx = 0; gx < n; gx++) {
                const key00 = `${gx},${gy}`;
                const key10 = `${gx+1},${gy}`;
                const key01 = `${gx},${gy+1}`;
                const key11 = `${gx+1},${gy+1}`;
                
                if (vertexIndexMap.has(key00) && vertexIndexMap.has(key10) &&
                    vertexIndexMap.has(key01) && vertexIndexMap.has(key11)) {
                    
                    const i00 = vertexIndexMap.get(key00);
                    const i10 = vertexIndexMap.get(key10);
                    const i01 = vertexIndexMap.get(key01);
                    const i11 = vertexIndexMap.get(key11);
                    
                    indices.push(i00, i10, i11);
                    indices.push(i00, i11, i01);
                }
            }
        }

        if (indices.length === 0) {
            return null;
        }

        // Build vertex buffer
        const vertices = [];
        for (const v of gridVertices) {
            vertices.push(
                v.clipX, v.clipY, v.height,
                ...UP_NORMAL,
                ...color
            );
        }

        return {
            vertices: new Float32Array(vertices),
            indices: new Uint32Array(indices)
        };
    }
    
    /**
     * Sample terrain height at grid position
     */
    sampleTerrainHeight(gx, gy, gridSize, terrainData) {
        if (!terrainData || !terrainData.heights) {
            return 0;
        }

        const { heights, width, height } = terrainData;
        const tx = Math.floor((gx / gridSize) * (width - 1));
        const ty = Math.floor((gy / gridSize) * (height - 1));
        const idx = ty * width + tx;
        const rawHeight = heights[idx] || 0;

        return Math.max(0, rawHeight) / 50000000.0 * this.exaggeration;
    }

    /**
     * Point-in-polygon test using ray casting
     */
    pointInPolygon(x, y, outerRing, holes = []) {
        if (!this.pointInRing(x, y, outerRing)) {
            return false;
        }
        for (const hole of holes) {
            if (this.pointInRing(x, y, hole)) {
                return false;
            }
        }
        return true;
    }

    /**
     * Ray casting algorithm for point in ring
     */
    pointInRing(x, y, ring) {
        let inside = false;
        const n = ring.length;

        for (let i = 0, j = n - 1; i < n; j = i++) {
            const xi = ring[i][0], yi = ring[i][1];
            const xj = ring[j][0], yj = ring[j][1];

            if (((yi > y) !== (yj > y)) &&
                (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }

        return inside;
    }
}
