/**
 * Terrain Worker - Fetches and decodes terrain tiles in a Web Worker
 * 
 * Decodes AWS Terrarium format terrain tiles into height arrays
 * that can be used for CPU-side vertex height baking.
 */

// Terrain tile sources
const TERRAIN_SOURCES = {
    aws: {
        url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
        encoding: 'terrarium'
    }
};

/**
 * Decode Terrarium height encoding
 * Height = (R * 256 + G + B / 256) - 32768
 */
function decodeTerrarium(r, g, b) {
    return (r * 256 + g + b / 256) - 32768;
}

/**
 * Convert tile coordinates to clip space bounds
 */
function getTileBoundsClipSpace(z, x, y) {
    const n = Math.pow(2, z);
    
    // Tile bounds in 0-1 range
    const x0 = x / n;
    const x1 = (x + 1) / n;
    const y0 = y / n;
    const y1 = (y + 1) / n;
    
    // Convert to clip space (-1 to 1)
    return {
        minX: x0 * 2 - 1,
        maxX: x1 * 2 - 1,
        minY: 1 - y1 * 2,  // Flip Y
        maxY: 1 - y0 * 2
    };
}

/**
 * Load and decode a terrain tile
 * Returns height data array and bounds for sampling
 */
async function loadTerrainTile(z, x, y, source = 'aws') {
    const sourceConfig = TERRAIN_SOURCES[source];
    const url = sourceConfig.url
        .replace('{z}', z)
        .replace('{x}', x)
        .replace('{y}', y);
    
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const blob = await response.blob();
        const bitmap = await createImageBitmap(blob);
        
        // Extract pixel data
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
        
        // Decode heights into Float32Array
        const width = bitmap.width;
        const height = bitmap.height;
        const heights = new Float32Array(width * height);
        
        for (let i = 0; i < heights.length; i++) {
            const idx = i * 4;
            const r = imageData.data[idx];
            const g = imageData.data[idx + 1];
            const b = imageData.data[idx + 2];
            heights[i] = decodeTerrarium(r, g, b);
        }
        
        const bounds = getTileBoundsClipSpace(z, x, y);
        
        return {
            success: true,
            key: `${z}/${x}/${y}`,
            z, x, y,
            width,
            height,
            heights,  // Float32Array of decoded heights
            bounds    // Clip space bounds for this tile
        };
        
    } catch (error) {
        return {
            success: false,
            key: `${z}/${x}/${y}`,
            z, x, y,
            error: error.message
        };
    }
}

// Web Worker message handler
self.onmessage = async function(e) {
    const { type, z, x, y, source } = e.data;
    
    if (type === 'loadTerrain') {
        const result = await loadTerrainTile(z, x, y, source);
        
        // Transfer the heights array for zero-copy performance
        if (result.success) {
            self.postMessage(result, [result.heights.buffer]);
        } else {
            self.postMessage(result);
        }
    }
};
