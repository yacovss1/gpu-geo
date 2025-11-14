/**
 * BufferUtils - GPU buffer creation and manipulation utilities
 * 
 * Responsibilities:
 * - Buffer size alignment (WebGPU requirement)
 * - Typed array padding
 * - GPU buffer creation for tile features
 * - Buffer lifecycle management helpers
 */

/**
 * Align buffer size to 4 bytes (WebGPU requirement)
 */
export function alignBufferSize(size) {
    return Math.max(4, Math.ceil(size / 4) * 4);
}

/**
 * Pad typed array to aligned size
 */
export function padToAlignment(typedArray) {
    const alignedSize = alignBufferSize(typedArray.byteLength);
    if (typedArray.byteLength === alignedSize) {
        return typedArray;
    }
    // Create new array with padded size
    const Constructor = typedArray.constructor;
    const elementsPerByte = typedArray.BYTES_PER_ELEMENT;
    const paddedArray = new Constructor(alignedSize / elementsPerByte);
    paddedArray.set(typedArray);
    return paddedArray;
}

/**
 * Create and add buffers for a feature to tile buffer collections
 */
export function createAndAddBuffers(
    device,
    vertices,
    hiddenVertices,
    fillIndices,
    hiddenfillIndices,
    isFilled,
    isLine,
    properties,
    z,
    x,
    y,
    layerId,
    newTileBuffers,
    newHiddenTileBuffers
) {
    // Create vertex buffer
    const vertexBuffer = device.createBuffer({
        size: alignBufferSize(vertices.byteLength),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vertexBuffer, 0, padToAlignment(vertices));
    
    // HYBRID APPROACH: 
    // - For 3D buildings: use VISIBLE buffer (complex geometry creates edge artifacts for edge detection)
    // - For flat features: use HIDDEN buffer (simple filled surface for clean marker computation)
    const use3DGeometry = layerId.includes('building') || layerId.includes('extrusion');
    
    // Only create hidden buffers for flat features (buildings reuse visible buffers)
    let hiddenVertexBuffer, hiddenFillIndexBuffer;
    if (!use3DGeometry) {
        hiddenVertexBuffer = device.createBuffer({
            size: alignBufferSize(hiddenVertices.byteLength),
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(hiddenVertexBuffer, 0, padToAlignment(hiddenVertices));
        
        hiddenFillIndexBuffer = device.createBuffer({
            size: alignBufferSize(hiddenfillIndices.byteLength),
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(hiddenFillIndexBuffer, 0, padToAlignment(hiddenfillIndices));
    }
    
    // Create index buffers (already Uint32Array from parsing)
    const fillIndexBuffer = device.createBuffer({
        size: alignBufferSize(fillIndices.byteLength),
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(fillIndexBuffer, 0, padToAlignment(fillIndices));
    
    // Add to tile buffers grouped by layer
    if (!newTileBuffers.has(layerId)) {
        newTileBuffers.set(layerId, []);
    }
    if (!newHiddenTileBuffers.has(layerId)) {
        newHiddenTileBuffers.set(layerId, []);
    }
    
    newTileBuffers.get(layerId).push({
        vertexBuffer,
        fillIndexBuffer,
        fillIndexCount: fillIndices.length,
        isFilled,
        isLine,
        properties,
        zoomLevel: z,
        tileX: x,
        tileY: y,
        vertices: vertices,
        layerId: layerId
    });
    
    newHiddenTileBuffers.get(layerId).push({
        vertexBuffer: use3DGeometry ? vertexBuffer : hiddenVertexBuffer,
        hiddenFillIndexBuffer: use3DGeometry ? fillIndexBuffer : hiddenFillIndexBuffer,
        hiddenfillIndexCount: use3DGeometry ? fillIndices.length : hiddenfillIndices.length,
        properties,
        zoomLevel: z,
        tileX: x,
        tileY: y,
        isFilled,
        layerId: layerId
    });
}

/**
 * Destroy GPU buffers for a tile
 */
export function destroyTileBuffers(tile) {
    if (tile.vertexBuffer) tile.vertexBuffer.destroy();
    if (tile.fillIndexBuffer) tile.fillIndexBuffer.destroy();
    if (tile.hiddenFillIndexBuffer) tile.hiddenFillIndexBuffer.destroy();
}

/**
 * Destroy all GPU buffers in a collection
 */
export async function destroyAllBuffers(device, tileBuffers, hiddenTileBuffers, roofTileBuffers) {
    // Wait for GPU to finish
    await device.queue.onSubmittedWorkDone();
    
    let destroyedCount = 0;
    
    // Destroy visible buffers
    tileBuffers.forEach((buffers) => {
        buffers.forEach(tile => {
            if (tile.vertexBuffer) tile.vertexBuffer.destroy();
            if (tile.fillIndexBuffer) tile.fillIndexBuffer.destroy();
            destroyedCount += 2;
        });
    });
    
    // Destroy hidden buffers
    hiddenTileBuffers.forEach((buffers) => {
        buffers.forEach(tile => {
            if (tile.vertexBuffer) tile.vertexBuffer.destroy();
            if (tile.hiddenFillIndexBuffer) tile.hiddenFillIndexBuffer.destroy();
            destroyedCount += 2;
        });
    });
    
    // Destroy roof buffers
    if (roofTileBuffers) {
        roofTileBuffers.forEach((buffers) => {
            buffers.forEach(tile => {
                if (tile.roofIndexBuffer) tile.roofIndexBuffer.destroy();
                destroyedCount += 1;
            });
        });
    }
    
    tileBuffers.clear();
    hiddenTileBuffers.clear();
    if (roofTileBuffers) roofTileBuffers.clear();
    
    return destroyedCount;
}
