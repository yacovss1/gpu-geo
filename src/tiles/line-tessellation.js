/**
 * Line Tessellation Utility
 * Converts line segments into triangle strips for GPU rendering
 * Supports configurable line width, caps, and joins
 */

/**
 * Tessellate a LineString into triangles with width
 * @param {Array<Array<number>>} coordinates - Array of [x, y] coordinates
 * @param {number} width - Line width in pixels (screen space)
 * @param {string} cap - Line cap style: 'butt', 'round', 'square'
 * @param {string} join - Line join style: 'miter', 'round', 'bevel'
 * @param {number} miterLimit - Miter limit for sharp angles
 * @returns {Object} { vertices: Float32Array, indices: Uint32Array }
 */
export function tessellateLine(coordinates, width, cap = 'butt', join = 'miter', miterLimit = 2) {
    if (!coordinates || coordinates.length < 2) {
        return { vertices: new Float32Array(0), indices: new Uint32Array(0) };
    }

    const halfWidth = width / 2;
    const vertices = [];
    const indices = [];
    
    // Process each line segment
    for (let i = 0; i < coordinates.length - 1; i++) {
        const p0 = coordinates[i];
        const p1 = coordinates[i + 1];
        
        // Skip zero-length segments
        if (p0[0] === p1[0] && p0[1] === p1[1]) {
            continue;
        }
        
        // Calculate segment direction and perpendicular
        const dx = p1[0] - p0[0];
        const dy = p1[1] - p0[1];
        const len = Math.sqrt(dx * dx + dy * dy);
        
        // Normalized direction
        const dirX = dx / len;
        const dirY = dy / len;
        
        // Perpendicular (normal) for width offset
        const perpX = -dirY;
        const perpY = dirX;
        
        // Get previous and next segments for join calculations
        const hasPrev = i > 0;
        const hasNext = i < coordinates.length - 2;
        
        let startOffset = [perpX * halfWidth, perpY * halfWidth];
        let endOffset = [perpX * halfWidth, perpY * halfWidth];
        
        // Handle line joins
        if (hasPrev && join !== 'bevel') {
            const p_prev = coordinates[i - 1];
            const prevDx = p0[0] - p_prev[0];
            const prevDy = p0[1] - p_prev[1];
            const prevLen = Math.sqrt(prevDx * prevDx + prevDy * prevDy);
            
            if (prevLen > 0) {
                const prevDirX = prevDx / prevLen;
                const prevDirY = prevDy / prevLen;
                const prevPerpX = -prevDirY;
                const prevPerpY = prevDirX;
                
                // Calculate miter offset
                startOffset = calculateMiterOffset(
                    prevPerpX, prevPerpY,
                    perpX, perpY,
                    halfWidth,
                    join,
                    miterLimit
                );
            }
        }
        
        if (hasNext && join !== 'bevel') {
            const p_next = coordinates[i + 2];
            const nextDx = p_next[0] - p1[0];
            const nextDy = p_next[1] - p1[1];
            const nextLen = Math.sqrt(nextDx * nextDx + nextDy * nextDy);
            
            if (nextLen > 0) {
                const nextDirX = nextDx / nextLen;
                const nextDirY = nextDy / nextLen;
                const nextPerpX = -nextDirY;
                const nextPerpY = nextDirX;
                
                // Calculate miter offset
                endOffset = calculateMiterOffset(
                    perpX, perpY,
                    nextPerpX, nextPerpY,
                    halfWidth,
                    join,
                    miterLimit
                );
            }
        }
        
        // Create quad vertices (2 triangles) for this segment
        const baseIndex = vertices.length / 2;
        
        // Left side of line segment
        vertices.push(p0[0] - startOffset[0], p0[1] - startOffset[1]);
        // Right side of line segment
        vertices.push(p0[0] + startOffset[0], p0[1] + startOffset[1]);
        // Left side of next point
        vertices.push(p1[0] - endOffset[0], p1[1] - endOffset[1]);
        // Right side of next point
        vertices.push(p1[0] + endOffset[0], p1[1] + endOffset[1]);
        
        // Create two triangles for the quad
        // Triangle 1: bottom-left, bottom-right, top-left
        indices.push(baseIndex, baseIndex + 1, baseIndex + 2);
        // Triangle 2: bottom-right, top-right, top-left
        indices.push(baseIndex + 1, baseIndex + 3, baseIndex + 2);
    }
    
    // Add line caps at start and end
    if (cap !== 'butt' && coordinates.length >= 2) {
        addLineCap(vertices, indices, coordinates[0], coordinates[1], halfWidth, cap, true);
        addLineCap(vertices, indices, coordinates[coordinates.length - 1], coordinates[coordinates.length - 2], halfWidth, cap, false);
    }
    
    return {
        vertices: new Float32Array(vertices),
        indices: new Uint32Array(indices)
    };
}

/**
 * Calculate miter offset for line joins
 * @param {number} perp1X - Previous perpendicular X
 * @param {number} perp1Y - Previous perpendicular Y
 * @param {number} perp2X - Current perpendicular X
 * @param {number} perp2Y - Current perpendicular Y
 * @param {number} halfWidth - Half of line width
 * @param {string} join - Join style
 * @param {number} miterLimit - Miter limit
 * @returns {Array<number>} [offsetX, offsetY]
 */
function calculateMiterOffset(perp1X, perp1Y, perp2X, perp2Y, halfWidth, join, miterLimit) {
    // Average the two perpendiculars for miter
    const miterX = (perp1X + perp2X) / 2;
    const miterY = (perp1Y + perp2Y) / 2;
    const miterLen = Math.sqrt(miterX * miterX + miterY * miterY);
    
    if (miterLen < 0.01) {
        // Perpendiculars are opposite, use bevel
        return [perp2X * halfWidth, perp2Y * halfWidth];
    }
    
    // Calculate miter length
    const cosHalfAngle = (perp1X * perp2X + perp1Y * perp2Y);
    const miterRatio = 1 / miterLen;
    
    // Check miter limit
    if (join === 'miter' && miterRatio > miterLimit) {
        // Miter is too sharp, use bevel instead
        return [perp2X * halfWidth, perp2Y * halfWidth];
    }
    
    // Apply miter
    return [miterX * halfWidth * miterRatio, miterY * halfWidth * miterRatio];
}

/**
 * Add a line cap (round, square, or butt)
 * @param {Array<number>} vertices - Vertices array to append to
 * @param {Array<number>} indices - Indices array to append to
 * @param {Array<number>} point - End point [x, y]
 * @param {Array<number>} prevPoint - Previous point for direction [x, y]
 * @param {number} halfWidth - Half of line width
 * @param {string} cap - Cap style
 * @param {boolean} isStart - Whether this is the start cap
 */
function addLineCap(vertices, indices, point, prevPoint, halfWidth, cap, isStart) {
    const dx = point[0] - prevPoint[0];
    const dy = point[1] - prevPoint[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    
    if (len === 0) return;
    
    const dirX = dx / len;
    const dirY = dy / len;
    const perpX = -dirY;
    const perpY = dirX;
    
    // Flip direction for start cap
    const capDirX = isStart ? -dirX : dirX;
    const capDirY = isStart ? -dirY : dirY;
    
    const baseIndex = vertices.length / 2;
    
    if (cap === 'square') {
        // Extend the line by half-width
        const extendX = point[0] + capDirX * halfWidth;
        const extendY = point[1] + capDirY * halfWidth;
        
        vertices.push(extendX - perpX * halfWidth, extendY - perpY * halfWidth);
        vertices.push(extendX + perpX * halfWidth, extendY + perpY * halfWidth);
        vertices.push(point[0] - perpX * halfWidth, point[1] - perpY * halfWidth);
        vertices.push(point[0] + perpX * halfWidth, point[1] + perpY * halfWidth);
        
        indices.push(baseIndex, baseIndex + 1, baseIndex + 2);
        indices.push(baseIndex + 1, baseIndex + 3, baseIndex + 2);
        
    } else if (cap === 'round') {
        // Create a semi-circle cap with multiple segments
        const segments = 8;
        const angleStep = Math.PI / segments;
        
        // Center of the cap
        vertices.push(point[0], point[1]);
        const centerIndex = baseIndex;
        
        for (let i = 0; i <= segments; i++) {
            const angle = i * angleStep + (isStart ? Math.PI : 0);
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            
            // Rotate perpendicular to create circle
            const offsetX = perpX * cos * halfWidth - capDirX * sin * halfWidth;
            const offsetY = perpY * cos * halfWidth - capDirY * sin * halfWidth;
            
            vertices.push(point[0] + offsetX, point[1] + offsetY);
            
            if (i > 0) {
                indices.push(centerIndex, baseIndex + i, baseIndex + i + 1);
            }
        }
    }
    // 'butt' cap requires no additional geometry
}

/**
 * Convert screen-space line width to world-space width based on zoom
 * @param {number} screenWidth - Width in pixels
 * @param {number} zoom - Current zoom level
 * @param {number} canvasHeight - Canvas height in pixels
 * @returns {number} World-space width
 */
export function screenWidthToWorld(screenWidth, zoom, canvasHeight = 512) {
    // Convert screen pixels to world coordinates
    // At zoom level z, tiles span: 2 / (2^z) world units
    // Each tile is 512 pixels, so world units per pixel = (2 / 2^z) / 512
    // However, we need to account for the actual tile we're rendering in
    // Add a zoom-dependent scaling factor to keep lines thin
    const tileWorldSize = 2.0 / Math.pow(2, zoom);
    const worldUnitsPerPixel = tileWorldSize / 512.0;
    
    // Apply additional scaling to prevent lines from getting too thick
    // Lines should get thinner as you zoom in (higher zoom = smaller scale factor)
    const scaleFactor = 0.1; // Constant to keep lines consistently thin
    
    return screenWidth * worldUnitsPerPixel * scaleFactor;
}
