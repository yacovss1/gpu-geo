/**
 * Geometry Worker - Processes vector tiles with terrain height baking
 * 
 * Receives:
 * - Vector tile data (protobuf)
 * - Terrain height data from TerrainWorker
 * 
 * Returns:
 * - Vertices with Z values baked from terrain
 * - Normals computed from triangulated mesh
 */

import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import earcut from 'earcut';

/**
 * Sample terrain height at a clip-space coordinate
 * @param {number} clipX - X in clip space (-1 to 1)
 * @param {number} clipY - Y in clip space (-1 to 1)
 * @param {Object} terrainData - { heights, width, height, bounds }
 * @param {number} exaggeration - Height exaggeration factor
 * @returns {number} Height in clip space units
 */
function sampleTerrainHeight(clipX, clipY, terrainData, exaggeration = 1.5) {
    if (!terrainData || !terrainData.heights) return 0;
    
    const { heights, width, height, bounds } = terrainData;
    
    // Check if point is within terrain bounds
    if (clipX < bounds.minX || clipX > bounds.maxX ||
        clipY < bounds.minY || clipY > bounds.maxY) {
        return 0;
    }
    
    // Convert clip coords to UV (0-1)
    const u = (clipX - bounds.minX) / (bounds.maxX - bounds.minX);
    const v = 1 - (clipY - bounds.minY) / (bounds.maxY - bounds.minY);
    
    // Clamp to valid range
    const clampedU = Math.max(0, Math.min(1, u));
    const clampedV = Math.max(0, Math.min(1, v));
    
    // Convert to pixel coordinates
    const px = Math.floor(clampedU * (width - 1));
    const py = Math.floor(clampedV * (height - 1));
    
    // Sample height
    const idx = py * width + px;
    const rawHeight = heights[idx] || 0;
    
    // Clamp height to reasonable range (0-9000m)
    const clampedHeight = Math.max(0, Math.min(9000, rawHeight));
    
    // Scale to clip space (same as GPU shader)
    return (clampedHeight / 50000000.0) * exaggeration;
}

/**
 * Subdivide a line/ring to ensure adequate terrain sampling
 * @param {Array} coords - Array of [x, y] coordinates
 * @param {number} maxLength - Max segment length in clip space
 * @returns {Array} Subdivided coordinates
 */
function subdivideCoords(coords, maxLength = 0.02) {
    if (!coords || coords.length < 2) return coords;
    
    const result = [coords[0]];
    
    for (let i = 1; i < coords.length; i++) {
        const prev = coords[i - 1];
        const curr = coords[i];
        
        const dx = curr[0] - prev[0];
        const dy = curr[1] - prev[1];
        const len = Math.sqrt(dx * dx + dy * dy);
        
        if (len > maxLength) {
            const numDivisions = Math.ceil(len / maxLength);
            for (let j = 1; j < numDivisions; j++) {
                const t = j / numDivisions;
                result.push([
                    prev[0] + dx * t,
                    prev[1] + dy * t
                ]);
            }
        }
        
        result.push(curr);
    }
    
    return result;
}

/**
 * Compute face normal from three vertices
 */
function computeNormal(v0, v1, v2) {
    const edge1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
    const edge2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
    
    // Cross product
    const nx = edge1[1] * edge2[2] - edge1[2] * edge2[1];
    const ny = edge1[2] * edge2[0] - edge1[0] * edge2[2];
    const nz = edge1[0] * edge2[1] - edge1[1] * edge2[0];
    
    // Normalize
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 0.0001) return [0, 0, 1];
    
    return [nx / len, ny / len, nz / len];
}

/**
 * Process polygon with terrain height baking
 * @param {Array} rings - Array of rings (outer ring first, then holes)
 * @param {Object} terrainData - Terrain height data
 * @param {number} exaggeration - Height exaggeration
 * @returns {Object} { vertices, indices } with baked heights
 */
function processPolygonWithTerrain(rings, terrainData, exaggeration) {
    // Subdivide all rings for terrain conformance
    const subdividedRings = rings.map(ring => subdivideCoords(ring, 0.02));
    
    // Flatten for earcut
    const coords = [];
    const holes = [];
    
    subdividedRings.forEach((ring, ringIndex) => {
        if (ringIndex > 0) {
            holes.push(coords.length / 2);
        }
        ring.forEach(coord => {
            coords.push(coord[0], coord[1]);
        });
    });
    
    // Triangulate
    const indices = earcut(coords, holes.length > 0 ? holes : null);
    
    // Build vertices with terrain heights
    const vertices = [];
    for (let i = 0; i < coords.length; i += 2) {
        const x = coords[i];
        const y = coords[i + 1];
        const z = sampleTerrainHeight(x, y, terrainData, exaggeration);
        vertices.push(x, y, z);
    }
    
    return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}

/**
 * Process line with terrain height baking
 * Returns a tessellated ribbon mesh
 */
function processLineWithTerrain(coords, width, terrainData, exaggeration) {
    // Subdivide for terrain conformance
    const subdividedCoords = subdivideCoords(coords, 0.02);
    
    if (subdividedCoords.length < 2) {
        return { vertices: new Float32Array(0), indices: new Uint32Array(0) };
    }
    
    const halfWidth = width / 2;
    const vertices = [];
    const indices = [];
    
    let lastLeft = -1, lastRight = -1;
    
    for (let i = 0; i < subdividedCoords.length; i++) {
        const curr = subdividedCoords[i];
        const prev = i > 0 ? subdividedCoords[i - 1] : null;
        const next = i < subdividedCoords.length - 1 ? subdividedCoords[i + 1] : null;
        
        // Calculate perpendicular direction
        let dx, dy;
        if (prev && next) {
            // Average of incoming and outgoing directions
            dx = next[0] - prev[0];
            dy = next[1] - prev[1];
        } else if (next) {
            dx = next[0] - curr[0];
            dy = next[1] - curr[1];
        } else {
            dx = curr[0] - prev[0];
            dy = curr[1] - prev[1];
        }
        
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 0.00001) continue;
        
        const nx = -dy / len;
        const ny = dx / len;
        
        // Sample terrain height at center
        const z = sampleTerrainHeight(curr[0], curr[1], terrainData, exaggeration);
        
        // Add left and right vertices
        const leftIdx = vertices.length / 3;
        vertices.push(curr[0] - nx * halfWidth, curr[1] - ny * halfWidth, z);
        
        const rightIdx = vertices.length / 3;
        vertices.push(curr[0] + nx * halfWidth, curr[1] + ny * halfWidth, z);
        
        // Create triangles
        if (lastLeft >= 0) {
            indices.push(lastLeft, leftIdx, lastRight);
            indices.push(lastRight, leftIdx, rightIdx);
        }
        
        lastLeft = leftIdx;
        lastRight = rightIdx;
    }
    
    return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}

// Export for potential module use
export {
    sampleTerrainHeight,
    subdivideCoords,
    computeNormal,
    processPolygonWithTerrain,
    processLineWithTerrain
};

// Web Worker message handler (if running as worker)
if (typeof self !== 'undefined' && self.onmessage !== undefined) {
    self.onmessage = async function(e) {
        const { type, data } = e.data;
        
        if (type === 'processGeometry') {
            const { geometryType, coords, terrainData, exaggeration, width } = data;
            
            let result;
            if (geometryType === 'Polygon' || geometryType === 'MultiPolygon') {
                result = processPolygonWithTerrain(coords, terrainData, exaggeration);
            } else if (geometryType === 'LineString' || geometryType === 'MultiLineString') {
                result = processLineWithTerrain(coords, width || 0.001, terrainData, exaggeration);
            }
            
            if (result) {
                self.postMessage({
                    type: 'geometryResult',
                    vertices: result.vertices,
                    indices: result.indices
                }, [result.vertices.buffer, result.indices.buffer]);
            }
        }
    };
}
