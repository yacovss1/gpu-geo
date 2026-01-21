/**
 * Line tessellation with proper miter/bevel joins matching MapLibre approach
 */

/**
 * Subdivide line segments to ensure terrain height sampling at regular intervals
 * This prevents roads from "tunneling" through terrain when segments are long
 * @param {Array} coordinates - Array of [x, y] coordinate pairs
 * @param {number} maxSegmentLength - Maximum length before subdivision (in clip space units)
 * @returns {Array} - Subdivided coordinate array
 */
export function subdivideLine(coordinates, maxSegmentLength = 0.02) {
    if (!coordinates || coordinates.length < 2) {
        return coordinates;
    }
    
    const result = [coordinates[0]];
    
    for (let i = 1; i < coordinates.length; i++) {
        const prev = coordinates[i - 1];
        const curr = coordinates[i];
        
        const dx = curr[0] - prev[0];
        const dy = curr[1] - prev[1];
        const segmentLength = Math.sqrt(dx * dx + dy * dy);
        
        if (segmentLength > maxSegmentLength) {
            // Subdivide this segment
            const numDivisions = Math.ceil(segmentLength / maxSegmentLength);
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

export function tessellateLine(coordinates, width, cap = 'butt', join = 'bevel', miterLimit = 2) {
    if (!coordinates || coordinates.length < 2) {
        return { vertices: new Float32Array(0), indices: new Uint32Array(0) };
    }

    const halfWidth = width / 2;
    const vertices = [];
    const indices = [];
    
    let e1 = -1; // Last left vertex index
    let e2 = -1; // Last right vertex index

    for (let i = 0; i < coordinates.length; i++) {
        const curr = coordinates[i];
        const prev = i > 0 ? coordinates[i - 1] : null;
        const next = i < coordinates.length - 1 ? coordinates[i + 1] : null;

        let leftX, leftY, rightX, rightY;

        if (!prev) {
            // First point - simple perpendicular
            const dx = next[0] - curr[0];
            const dy = next[1] - curr[1];
            const len = Math.sqrt(dx * dx + dy * dy);
            const nx = -dy / len;
            const ny = dx / len;
            
            leftX = curr[0] - nx * halfWidth;
            leftY = curr[1] - ny * halfWidth;
            rightX = curr[0] + nx * halfWidth;
            rightY = curr[1] + ny * halfWidth;
        } else if (!next) {
            // Last point - simple perpendicular
            const dx = curr[0] - prev[0];
            const dy = curr[1] - prev[1];
            const len = Math.sqrt(dx * dx + dy * dy);
            const nx = -dy / len;
            const ny = dx / len;
            
            leftX = curr[0] - nx * halfWidth;
            leftY = curr[1] - ny * halfWidth;
            rightX = curr[0] + nx * halfWidth;
            rightY = curr[1] + ny * halfWidth;
        } else {
            // Middle point - calculate join
            // Get vectors for both segments
            const dx1 = curr[0] - prev[0];
            const dy1 = curr[1] - prev[1];
            const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
            const prevDirX = dx1 / len1;
            const prevDirY = dy1 / len1;
            
            const dx2 = next[0] - curr[0];
            const dy2 = next[1] - curr[1];
            const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
            const nextDirX = dx2 / len2;
            const nextDirY = dy2 / len2;
            
            // Get normals for both segments
            const prevNormX = -prevDirY;
            const prevNormY = prevDirX;
            const nextNormX = -nextDirY;
            const nextNormY = nextDirX;
            
            // Calculate bisector (average of the two normals)
            let bisectorX = prevNormX + nextNormX;
            let bisectorY = prevNormY + nextNormY;
            const bisectorLen = Math.sqrt(bisectorX * bisectorX + bisectorY * bisectorY);
            
            if (bisectorLen < 0.0001) {
                // 180 degree turn - use bevel
                leftX = curr[0] - nextNormX * halfWidth;
                leftY = curr[1] - nextNormY * halfWidth;
                rightX = curr[0] + nextNormX * halfWidth;
                rightY = curr[1] + nextNormY * halfWidth;
            } else {
                // Normalize bisector
                bisectorX /= bisectorLen;
                bisectorY /= bisectorLen;
                
                // MapLibre's approach: miter length = 1 / cos(halfAngle)
                // cos(halfAngle) = dot product of bisector with either normal
                const cosHalfAngle = Math.abs(bisectorX * prevNormX + bisectorY * prevNormY);
                
                // Avoid division by zero
                if (cosHalfAngle < 0.01) {
                    // Very sharp turn - use simple perpendicular
                    leftX = curr[0] - nextNormX * halfWidth;
                    leftY = curr[1] - nextNormY * halfWidth;
                    rightX = curr[0] + nextNormX * halfWidth;
                    rightY = curr[1] + nextNormY * halfWidth;
                } else {
                    const miterLength = 1.0 / cosHalfAngle;
                    
                    // Limit miter length to avoid spikes
                    const limitedMiterLength = Math.min(miterLength, 3.0);
                    
                    // Use bisector with miter length
                    leftX = curr[0] - bisectorX * halfWidth * limitedMiterLength;
                    leftY = curr[1] - bisectorY * halfWidth * limitedMiterLength;
                    rightX = curr[0] + bisectorX * halfWidth * limitedMiterLength;
                    rightY = curr[1] + bisectorY * halfWidth * limitedMiterLength;
                }
            }
        }

        // Add vertices
        const leftIdx = vertices.length / 2;
        vertices.push(leftX, leftY);
        const rightIdx = vertices.length / 2;
        vertices.push(rightX, rightY);

        // Create triangles
        if (e1 >= 0 && e2 >= 0) {
            // Triangle 1: previous-left, current-left, previous-right
            indices.push(e1, leftIdx, e2);
            // Triangle 2: previous-right, current-left, current-right
            indices.push(e2, leftIdx, rightIdx);
        }

        e1 = leftIdx;
        e2 = rightIdx;
    }

    return {
        vertices: new Float32Array(vertices),
        indices: new Uint32Array(indices)
    };
}

export function screenWidthToWorld(screenWidthPixels, zoom, tileSize = 512) {
    // At zoom 0, the world is 2 units wide (from -1 to 1)
    // Each zoom level doubles the resolution
    const worldSize = 2;
    const scale = Math.pow(2, zoom);
    const pixelsPerWorldUnit = (window.innerWidth / worldSize) * scale;
    return screenWidthPixels / pixelsPerWorldUnit;
}
