// GPU Coordinate Transform Pipeline
// This file provides utilities for batch processing coordinate transformations on GPU

import { coordinateTransformShaderCode, batchCoordinateTransformShaderCode } from '../shaders/coordinateShaders.js';

export class GPUCoordinateTransformer {
    constructor(device) {
        this.device = device;
        this.pipeline = null;
        this.batchPipeline = null;
        this.initialized = false;
    }

    async initialize() {
        if (this.initialized) return;

        // Create standard coordinate transform pipeline
        this.pipeline = this.device.createComputePipeline({
            layout: 'auto',
            compute: {
                module: this.device.createShaderModule({ code: coordinateTransformShaderCode }),
                entryPoint: 'main'
            }
        });

        // Create batch coordinate transform pipeline for larger datasets
        this.batchPipeline = this.device.createComputePipeline({
            layout: 'auto',
            compute: {
                module: this.device.createShaderModule({ code: batchCoordinateTransformShaderCode }),
                entryPoint: 'main'
            }
        });

        this.initialized = true;
    }

    // Transform coordinates using structured input/output buffers
    async transformCoordinates(coordinates) {
        if (!this.initialized) await this.initialize();
        if (coordinates.length === 0) return [];

        const coordinateCount = coordinates.length;
        const inputSize = coordinateCount * 8; // 2 float32s per coordinate
        const outputSize = coordinateCount * 8; // 2 float32s per coordinate

        // Create input buffer with coordinate data
        const inputBuffer = this.device.createBuffer({
            size: inputSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true
        });

        const inputData = new Float32Array(inputBuffer.getMappedRange());
        coordinates.forEach((coord, i) => {
            inputData[i * 2] = coord[0]; // longitude
            inputData[i * 2 + 1] = coord[1]; // latitude
        });
        inputBuffer.unmap();

        // Create output buffer
        const outputBuffer = this.device.createBuffer({
            size: outputSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        });

        // Create staging buffer for reading results
        const stagingBuffer = this.device.createBuffer({
            size: outputSize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        });

        // Set up compute pass
        const bindGroup = this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: inputBuffer } },
                { binding: 1, resource: { buffer: outputBuffer } }
            ]
        });

        const commandEncoder = this.device.createCommandEncoder();
        const computePass = commandEncoder.beginComputePass();
        
        computePass.setPipeline(this.pipeline);
        computePass.setBindGroup(0, bindGroup);
        
        // Dispatch workgroups (256 threads per workgroup)
        const workgroupCount = Math.ceil(coordinateCount / 256);
        computePass.dispatchWorkgroups(workgroupCount);
        
        computePass.end();

        // Copy output to staging buffer
        commandEncoder.copyBufferToBuffer(
            outputBuffer, 0,
            stagingBuffer, 0,
            outputSize
        );

        this.device.queue.submit([commandEncoder.finish()]);

        // Read results
        await stagingBuffer.mapAsync(GPUMapMode.READ);
        const outputData = new Float32Array(stagingBuffer.getMappedRange());
        
        // Convert back to coordinate pairs
        const transformedCoords = [];
        for (let i = 0; i < coordinateCount; i++) {
            transformedCoords.push([
                outputData[i * 2],     // x
                outputData[i * 2 + 1]  // y
            ]);
        }

        stagingBuffer.unmap();

        // Cleanup buffers
        inputBuffer.destroy();
        outputBuffer.destroy();
        stagingBuffer.destroy();

        return transformedCoords;
    }

    // Batch transform for very large datasets using flattened arrays
    async batchTransformCoordinates(flattenedCoords) {
        if (!this.initialized) await this.initialize();
        if (flattenedCoords.length === 0) return [];

        const coordinateCount = flattenedCoords.length / 2;
        const dataSize = flattenedCoords.length * 4; // float32 = 4 bytes

        // Create input buffer
        const inputBuffer = this.device.createBuffer({
            size: dataSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true
        });

        new Float32Array(inputBuffer.getMappedRange()).set(flattenedCoords);
        inputBuffer.unmap();

        // Create output buffer
        const outputBuffer = this.device.createBuffer({
            size: dataSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        });

        // Create count uniform buffer
        const countBuffer = this.device.createBuffer({
            size: 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        this.device.queue.writeBuffer(countBuffer, 0, new Uint32Array([coordinateCount]));

        // Create staging buffer
        const stagingBuffer = this.device.createBuffer({
            size: dataSize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        });

        // Set up compute pass
        const bindGroup = this.device.createBindGroup({
            layout: this.batchPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: inputBuffer } },
                { binding: 1, resource: { buffer: outputBuffer } },
                { binding: 2, resource: { buffer: countBuffer } }
            ]
        });

        const commandEncoder = this.device.createCommandEncoder();
        const computePass = commandEncoder.beginComputePass();
        
        computePass.setPipeline(this.batchPipeline);
        computePass.setBindGroup(0, bindGroup);
        
        const workgroupCount = Math.ceil(coordinateCount / 256);
        computePass.dispatchWorkgroups(workgroupCount);
        
        computePass.end();

        commandEncoder.copyBufferToBuffer(
            outputBuffer, 0,
            stagingBuffer, 0,
            dataSize
        );

        this.device.queue.submit([commandEncoder.finish()]);

        // Read results
        await stagingBuffer.mapAsync(GPUMapMode.READ);
        const outputData = new Float32Array(stagingBuffer.getMappedRange());
        const result = Array.from(outputData);
        
        stagingBuffer.unmap();

        // Cleanup
        inputBuffer.destroy();
        outputBuffer.destroy();
        countBuffer.destroy();
        stagingBuffer.destroy();

        return result;
    }

    // Utility function to extract all coordinates from a GeoJSON geometry
    extractCoordinatesFromGeometry(geometry) {
        const coords = [];
        
        const extractFromArray = (coordArray) => {
            if (typeof coordArray[0] === 'number') {
                // This is a coordinate pair [lon, lat]
                coords.push([coordArray[0], coordArray[1]]);
            } else {
                // This is an array of coordinates, recurse
                coordArray.forEach(extractFromArray);
            }
        };

        extractFromArray(geometry.coordinates);
        return coords;
    }

    destroy() {
        // Pipelines are automatically cleaned up by WebGPU
        this.initialized = false;
    }
}

// Singleton instance for global use
let globalTransformer = null;

export function getGlobalCoordinateTransformer(device) {
    if (!globalTransformer) {
        globalTransformer = new GPUCoordinateTransformer(device);
    }
    return globalTransformer;
}

// Helper function for easy integration with existing code
export async function gpuMercatorToClipSpace(coordinates, device) {
    const transformer = getGlobalCoordinateTransformer(device);
    await transformer.initialize();
    return await transformer.transformCoordinates(coordinates);
}
