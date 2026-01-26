/**
 * Polygon Terrain Compute Pipeline
 * 
 * Uses GPU compute shader to test which grid points are inside a polygon.
 * Much faster than CPU ray-casting for large grids.
 */

import { polygonTerrainComputeShader } from '../shaders/polygonTerrainCompute.js';

export class PolygonTerrainCompute {
    constructor(device) {
        this.device = device;
        this.pipeline = null;
        this.initialized = false;
    }

    async initialize() {
        if (this.initialized) return;

        const shaderModule = this.device.createShaderModule({
            code: polygonTerrainComputeShader
        });

        this.pipeline = this.device.createComputePipeline({
            layout: 'auto',
            compute: {
                module: shaderModule,
                entryPoint: 'main'
            }
        });

        this.initialized = true;
        console.log('🔧 Polygon terrain compute pipeline initialized');
    }

    /**
     * Run GPU point-in-polygon test for all grid points
     * @param {Object} polygon - { coords: [[x,y],...], color: [r,g,b,a] }
     * @param {Object} terrainData - { heights, width, height, bounds }
     * @param {number} z - Tile zoom
     * @param {number} x - Tile X
     * @param {number} y - Tile Y
     * @param {number} gridSize - Grid resolution
     * @param {number} exaggeration - Terrain exaggeration
     * @returns {Promise<Array>} - Array of { inside, clipX, clipY, height } for each grid point
     */
    async computePolygonGrid(polygon, terrainData, z, x, y, gridSize, exaggeration) {
        if (!this.initialized) {
            await this.initialize();
        }

        const { coords } = polygon;
        if (!coords || coords.length === 0) return null;

        const outerRing = coords[0];
        const holes = coords.slice(1);

        // Calculate bounding box
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        for (const [px, py] of outerRing) {
            minX = Math.min(minX, px);
            maxX = Math.max(maxX, px);
            minY = Math.min(minY, py);
            maxY = Math.max(maxY, py);
        }

        // Flatten hole vertices
        const holeVerts = [];
        const holeStarts = [];
        for (const hole of holes) {
            holeStarts.push(holeVerts.length / 2);
            for (const [hx, hy] of hole) {
                holeVerts.push(hx, hy);
            }
        }

        // Create buffers
        const totalGridPoints = (gridSize + 1) * (gridSize + 1);
        
        // Params uniform buffer
        const paramsData = new ArrayBuffer(80); // 20 x 4 bytes
        const paramsView = new DataView(paramsData);
        paramsView.setUint32(0, gridSize, true);
        paramsView.setUint32(4, outerRing.length, true);
        paramsView.setUint32(8, holeVerts.length / 2, true);
        paramsView.setUint32(12, holes.length, true);
        paramsView.setUint32(16, x, true);
        paramsView.setUint32(20, y, true);
        paramsView.setUint32(24, z, true);
        paramsView.setUint32(28, terrainData?.width || 256, true);
        paramsView.setUint32(32, terrainData?.height || 256, true);
        paramsView.setFloat32(36, exaggeration, true);
        paramsView.setFloat32(40, minX, true);
        paramsView.setFloat32(44, maxX, true);
        paramsView.setFloat32(48, minY, true);
        paramsView.setFloat32(52, maxY, true);
        paramsView.setFloat32(56, terrainData?.bounds?.minX || -1, true);
        paramsView.setFloat32(60, terrainData?.bounds?.maxX || 1, true);
        paramsView.setFloat32(64, terrainData?.bounds?.minY || -1, true);
        paramsView.setFloat32(68, terrainData?.bounds?.maxY || 1, true);
        // Padding to 80 bytes

        const paramsBuffer = this.device.createBuffer({
            size: 80,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        this.device.queue.writeBuffer(paramsBuffer, 0, paramsData);

        // Outer ring buffer
        const outerRingData = new Float32Array(outerRing.flat());
        const outerRingBuffer = this.device.createBuffer({
            size: Math.max(16, outerRingData.byteLength),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
        this.device.queue.writeBuffer(outerRingBuffer, 0, outerRingData);

        // Holes buffer (or empty)
        const holesData = holeVerts.length > 0 ? new Float32Array(holeVerts) : new Float32Array([0, 0]);
        const holesBuffer = this.device.createBuffer({
            size: Math.max(16, holesData.byteLength),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
        this.device.queue.writeBuffer(holesBuffer, 0, holesData);

        // Hole starts buffer
        const holeStartsData = holeStarts.length > 0 ? new Uint32Array(holeStarts) : new Uint32Array([0]);
        const holeStartsBuffer = this.device.createBuffer({
            size: Math.max(16, holeStartsData.byteLength),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
        this.device.queue.writeBuffer(holeStartsBuffer, 0, holeStartsData);

        // Terrain heights buffer
        const heightsData = terrainData?.heights || new Float32Array(256 * 256);
        const terrainBuffer = this.device.createBuffer({
            size: heightsData.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
        this.device.queue.writeBuffer(terrainBuffer, 0, heightsData);

        // Results buffer (read-write)
        const resultSize = totalGridPoints * 16; // 4 floats per result
        const resultsBuffer = this.device.createBuffer({
            size: resultSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        });

        // Staging buffer for readback
        const stagingBuffer = this.device.createBuffer({
            size: resultSize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        });

        // Create bind group
        const bindGroup = this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: paramsBuffer } },
                { binding: 1, resource: { buffer: outerRingBuffer } },
                { binding: 2, resource: { buffer: holesBuffer } },
                { binding: 3, resource: { buffer: holeStartsBuffer } },
                { binding: 4, resource: { buffer: terrainBuffer } },
                { binding: 5, resource: { buffer: resultsBuffer } }
            ]
        });

        // Run compute shader
        const commandEncoder = this.device.createCommandEncoder();
        const computePass = commandEncoder.beginComputePass();
        computePass.setPipeline(this.pipeline);
        computePass.setBindGroup(0, bindGroup);
        
        // Dispatch enough workgroups to cover grid
        const workgroupsX = Math.ceil((gridSize + 1) / 16);
        const workgroupsY = Math.ceil((gridSize + 1) / 16);
        computePass.dispatchWorkgroups(workgroupsX, workgroupsY);
        computePass.end();

        // Copy results to staging buffer
        commandEncoder.copyBufferToBuffer(resultsBuffer, 0, stagingBuffer, 0, resultSize);

        this.device.queue.submit([commandEncoder.finish()]);

        // Read back results
        await stagingBuffer.mapAsync(GPUMapMode.READ);
        const mappedRange = stagingBuffer.getMappedRange();
        const resultDataU32 = new Uint32Array(mappedRange.slice(0));
        const resultDataF32 = new Float32Array(mappedRange.slice(0));
        stagingBuffer.unmap();

        // Parse results - struct is { inside: u32, clipX: f32, clipY: f32, height: f32 }
        const results = [];
        for (let i = 0; i < totalGridPoints; i++) {
            const baseIdx = i * 4; // 4 elements per result (each 4 bytes)
            results.push({
                inside: resultDataU32[baseIdx] === 1, // Read as u32!
                clipX: resultDataF32[baseIdx + 1],
                clipY: resultDataF32[baseIdx + 2],
                height: resultDataF32[baseIdx + 3]
            });
        }

        // Cleanup
        paramsBuffer.destroy();
        outerRingBuffer.destroy();
        holesBuffer.destroy();
        holeStartsBuffer.destroy();
        terrainBuffer.destroy();
        resultsBuffer.destroy();
        stagingBuffer.destroy();

        return results;
    }
}
