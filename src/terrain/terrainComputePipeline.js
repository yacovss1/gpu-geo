/**
 * Terrain Compute Pipeline
 * 
 * GPU-based geometry projection onto terrain for all feature types.
 * Handles adaptive subdivision, mesh generation, and terrain draping.
 * 
 * Flow:
 * 1. Input: Coarse geometry (centerlines, polygon vertices, points)
 * 2. Compute Pass 1: Adaptive subdivision based on terrain gradient
 * 3. Compute Pass 2: Mesh generation (lines → ribbons, points → billboards)
 * 4. Compute Pass 3: Terrain height sampling + normal calculation
 * 5. Output: Dense, terrain-projected geometry ready for rendering
 */

import {
    subdivisionShaderCode,
    meshGenerationShaderCode,
    terrainDrapingShaderCode,
    countSubdivisionsShaderCode
} from '../shaders/terrainComputeShaders.js';

// Maximum geometry limits
const MAX_INPUT_VERTICES = 100000;      // Input from CPU (coarse)
const MAX_OUTPUT_VERTICES = 1000000;    // Output after subdivision (dense)
const MAX_SEGMENTS = 200000;            // Line segments
const MAX_FEATURES = 50000;             // Feature count

// Workgroup size (must match shader)
const WORKGROUP_SIZE = 64;

export class TerrainComputePipeline {
    constructor(device) {
        this.device = device;
        this.initialized = false;
        
        // Pipelines
        this.countPipeline = null;      // Count required subdivisions
        this.subdivisionPipeline = null; // Adaptive subdivision
        this.meshGenPipeline = null;     // Line → ribbon, etc.
        this.drapingPipeline = null;     // Terrain height sampling
        
        // Buffers
        this.inputVertexBuffer = null;   // From CPU: coarse geometry
        this.inputSegmentBuffer = null;  // Segment definitions (start/end indices)
        this.inputFeatureBuffer = null;  // Feature metadata (type, width, color)
        
        this.subdivisionCountBuffer = null; // Per-segment subdivision counts
        this.subdivisionOffsetBuffer = null; // Prefix sum for output indexing
        
        this.subdividedVertexBuffer = null;  // After subdivision
        this.outputVertexBuffer = null;      // Final projected vertices
        this.outputIndexBuffer = null;       // Triangle indices
        
        // Indirect dispatch buffer (for variable workload)
        this.indirectDispatchBuffer = null;
        
        // Statistics buffer (for debugging)
        this.statsBuffer = null;
        
        // Bind groups
        this.terrainBindGroup = null;    // Terrain texture + sampler + bounds
        this.geometryBindGroup = null;   // Geometry buffers
        
        // Configuration
        this.config = {
            maxSubdivisionFactor: 16,    // Max subdivisions per segment
            terrainGradientThreshold: 0.001, // Min height delta to trigger subdivision
            defaultLineWidth: 0.0001,    // Default line width in clip space
            depthOffset: 0.00001,        // Z offset for roads above terrain
        };
    }
    
    /**
     * Initialize all compute pipelines and buffers
     */
    async initialize(terrainTexture, terrainSampler, terrainBoundsBuffer) {
        console.log('🏔️ Initializing TerrainComputePipeline...');
        
        // Create shader modules
        const countModule = this.device.createShaderModule({
            code: countSubdivisionsShaderCode,
            label: 'Count Subdivisions Shader'
        });
        
        const subdivisionModule = this.device.createShaderModule({
            code: subdivisionShaderCode,
            label: 'Subdivision Shader'
        });
        
        const meshGenModule = this.device.createShaderModule({
            code: meshGenerationShaderCode,
            label: 'Mesh Generation Shader'
        });
        
        const drapingModule = this.device.createShaderModule({
            code: terrainDrapingShaderCode,
            label: 'Terrain Draping Shader'
        });
        
        // Create buffers
        this.createBuffers();
        
        // Create bind group layouts
        const terrainBindGroupLayout = this.device.createBindGroupLayout({
            label: 'Terrain Compute Bind Group Layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }
            ]
        });
        
        const geometryBindGroupLayout = this.device.createBindGroupLayout({
            label: 'Geometry Compute Bind Group Layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } }, // Input vertices
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } }, // Input segments
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } }, // Input features
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },           // Subdivision counts
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },           // Subdivision offsets
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },           // Subdivided vertices
                { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },           // Output vertices
                { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },           // Output indices
                { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }            // Stats
            ]
        });
        
        const configBindGroupLayout = this.device.createBindGroupLayout({
            label: 'Config Bind Group Layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }
            ]
        });
        
        // Create config buffer
        this.configBuffer = this.device.createBuffer({
            size: 32, // 8 floats
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        this.updateConfigBuffer();
        
        // Create pipeline layouts
        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [terrainBindGroupLayout, geometryBindGroupLayout, configBindGroupLayout]
        });
        
        // Create compute pipelines
        this.countPipeline = this.device.createComputePipeline({
            layout: pipelineLayout,
            compute: {
                module: countModule,
                entryPoint: 'main'
            }
        });
        
        this.subdivisionPipeline = this.device.createComputePipeline({
            layout: pipelineLayout,
            compute: {
                module: subdivisionModule,
                entryPoint: 'main'
            }
        });
        
        this.meshGenPipeline = this.device.createComputePipeline({
            layout: pipelineLayout,
            compute: {
                module: meshGenModule,
                entryPoint: 'main'
            }
        });
        
        this.drapingPipeline = this.device.createComputePipeline({
            layout: pipelineLayout,
            compute: {
                module: drapingModule,
                entryPoint: 'main'
            }
        });
        
        // Store bind group layouts for later
        this.terrainBindGroupLayout = terrainBindGroupLayout;
        this.geometryBindGroupLayout = geometryBindGroupLayout;
        this.configBindGroupLayout = configBindGroupLayout;
        
        // Create config bind group
        this.configBindGroup = this.device.createBindGroup({
            layout: configBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.configBuffer } }
            ]
        });
        
        // Update terrain bind group if resources provided
        if (terrainTexture && terrainSampler && terrainBoundsBuffer) {
            this.updateTerrainBindGroup(terrainTexture, terrainSampler, terrainBoundsBuffer);
        }
        
        this.initialized = true;
        console.log('✅ TerrainComputePipeline initialized');
    }
    
    /**
     * Create all GPU buffers
     */
    createBuffers() {
        // Input buffers (from CPU)
        // Vertex: x, y (2 floats per vertex)
        this.inputVertexBuffer = this.device.createBuffer({
            size: MAX_INPUT_VERTICES * 2 * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: 'Input Vertex Buffer'
        });
        
        // Segment: startIdx, endIdx, featureIdx (3 u32 per segment)
        this.inputSegmentBuffer = this.device.createBuffer({
            size: MAX_SEGMENTS * 3 * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: 'Input Segment Buffer'
        });
        
        // Feature: type, width, colorR, colorG, colorB, colorA, depthOffset, padding (8 floats)
        this.inputFeatureBuffer = this.device.createBuffer({
            size: MAX_FEATURES * 8 * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: 'Input Feature Buffer'
        });
        
        // Subdivision count per segment (1 u32 per segment)
        this.subdivisionCountBuffer = this.device.createBuffer({
            size: MAX_SEGMENTS * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: 'Subdivision Count Buffer'
        });
        
        // Subdivision offset (prefix sum) per segment (1 u32 per segment)
        this.subdivisionOffsetBuffer = this.device.createBuffer({
            size: MAX_SEGMENTS * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: 'Subdivision Offset Buffer'
        });
        
        // Subdivided vertices: x, y, z (3 floats per vertex)
        this.subdividedVertexBuffer = this.device.createBuffer({
            size: MAX_OUTPUT_VERTICES * 3 * 4,
            usage: GPUBufferUsage.STORAGE,
            label: 'Subdivided Vertex Buffer'
        });
        
        // Output vertices: x, y, z, nx, ny, nz, r, g, b, a (10 floats per vertex)
        // This is the final vertex buffer for rendering
        this.outputVertexBuffer = this.device.createBuffer({
            size: MAX_OUTPUT_VERTICES * 10 * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC,
            label: 'Output Vertex Buffer'
        });
        
        // Output index buffer (triangles)
        this.outputIndexBuffer = this.device.createBuffer({
            size: MAX_OUTPUT_VERTICES * 6 * 4, // Up to 6 indices per vertex (ribbon mesh)
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDEX | GPUBufferUsage.COPY_SRC,
            label: 'Output Index Buffer'
        });
        
        // Stats buffer: totalVertices, totalIndices, totalSegments, padding
        this.statsBuffer = this.device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
            label: 'Stats Buffer'
        });
        
        // Create geometry bind group (will be recreated when uploading new data)
        this.geometryBindGroup = this.device.createBindGroup({
            layout: this.geometryBindGroupLayout || this.createDefaultGeometryLayout(),
            entries: [
                { binding: 0, resource: { buffer: this.inputVertexBuffer } },
                { binding: 1, resource: { buffer: this.inputSegmentBuffer } },
                { binding: 2, resource: { buffer: this.inputFeatureBuffer } },
                { binding: 3, resource: { buffer: this.subdivisionCountBuffer } },
                { binding: 4, resource: { buffer: this.subdivisionOffsetBuffer } },
                { binding: 5, resource: { buffer: this.subdividedVertexBuffer } },
                { binding: 6, resource: { buffer: this.outputVertexBuffer } },
                { binding: 7, resource: { buffer: this.outputIndexBuffer } },
                { binding: 8, resource: { buffer: this.statsBuffer } }
            ]
        });
    }
    
    /**
     * Create default geometry layout (used before full init)
     */
    createDefaultGeometryLayout() {
        return this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
            ]
        });
    }
    
    /**
     * Update terrain bind group when terrain data changes
     */
    updateTerrainBindGroup(terrainTexture, terrainSampler, terrainBoundsBuffer) {
        if (!this.terrainBindGroupLayout) {
            console.warn('TerrainComputePipeline not initialized yet');
            return;
        }
        
        this.terrainBindGroup = this.device.createBindGroup({
            layout: this.terrainBindGroupLayout,
            entries: [
                { binding: 0, resource: terrainTexture.createView() },
                { binding: 1, resource: terrainSampler },
                { binding: 2, resource: { buffer: terrainBoundsBuffer } }
            ]
        });
    }
    
    /**
     * Update config buffer with current settings
     */
    updateConfigBuffer() {
        const data = new Float32Array([
            this.config.maxSubdivisionFactor,
            this.config.terrainGradientThreshold,
            this.config.defaultLineWidth,
            this.config.depthOffset,
            0, 0, 0, 0 // Padding
        ]);
        this.device.queue.writeBuffer(this.configBuffer, 0, data);
    }
    
    /**
     * Upload line centerlines for processing
     * @param {Array} lines - Array of line features: { coordinates: [[x,y], ...], width, color, depthOffset }
     * @returns {Object} - { vertexCount, segmentCount, featureCount }
     */
    uploadLines(lines) {
        const vertices = [];
        const segments = [];
        const features = [];
        
        let vertexOffset = 0;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const coords = line.coordinates;
            
            if (!coords || coords.length < 2) continue;
            
            // Add feature metadata
            const color = line.color || [0.5, 0.5, 0.5, 1.0];
            features.push(
                0, // type: 0 = line
                line.width || this.config.defaultLineWidth,
                color[0], color[1], color[2], color[3],
                line.depthOffset || this.config.depthOffset,
                0 // padding
            );
            
            const featureIdx = features.length / 8 - 1;
            
            // Add vertices
            for (let j = 0; j < coords.length; j++) {
                vertices.push(coords[j][0], coords[j][1]);
                
                // Add segment (between consecutive vertices)
                if (j > 0) {
                    segments.push(
                        vertexOffset + j - 1, // startIdx
                        vertexOffset + j,     // endIdx
                        featureIdx            // featureIdx
                    );
                }
            }
            
            vertexOffset += coords.length;
        }
        
        // Upload to GPU
        if (vertices.length > 0) {
            this.device.queue.writeBuffer(this.inputVertexBuffer, 0, new Float32Array(vertices));
        }
        if (segments.length > 0) {
            this.device.queue.writeBuffer(this.inputSegmentBuffer, 0, new Uint32Array(segments));
        }
        if (features.length > 0) {
            this.device.queue.writeBuffer(this.inputFeatureBuffer, 0, new Float32Array(features));
        }
        
        this.currentVertexCount = vertices.length / 2;
        this.currentSegmentCount = segments.length / 3;
        this.currentFeatureCount = features.length / 8;
        
        return {
            vertexCount: this.currentVertexCount,
            segmentCount: this.currentSegmentCount,
            featureCount: this.currentFeatureCount
        };
    }
    
    /**
     * Execute the compute pipeline
     * @param {GPUCommandEncoder} encoder - Command encoder to record commands
     * @returns {Object} - Output buffer info for rendering
     */
    execute(encoder) {
        if (!this.initialized || !this.terrainBindGroup) {
            console.warn('TerrainComputePipeline not ready');
            return null;
        }
        
        if (this.currentSegmentCount === 0) {
            return null;
        }
        
        const workgroups = Math.ceil(this.currentSegmentCount / WORKGROUP_SIZE);
        
        // Pass 1: Count subdivisions needed per segment
        const countPass = encoder.beginComputePass({ label: 'Count Subdivisions' });
        countPass.setPipeline(this.countPipeline);
        countPass.setBindGroup(0, this.terrainBindGroup);
        countPass.setBindGroup(1, this.geometryBindGroup);
        countPass.setBindGroup(2, this.configBindGroup);
        countPass.dispatchWorkgroups(workgroups);
        countPass.end();
        
        // Pass 2: Perform subdivision (interpolate vertices)
        const subdivisionPass = encoder.beginComputePass({ label: 'Subdivision' });
        subdivisionPass.setPipeline(this.subdivisionPipeline);
        subdivisionPass.setBindGroup(0, this.terrainBindGroup);
        subdivisionPass.setBindGroup(1, this.geometryBindGroup);
        subdivisionPass.setBindGroup(2, this.configBindGroup);
        subdivisionPass.dispatchWorkgroups(workgroups);
        subdivisionPass.end();
        
        // Pass 3: Generate mesh (line → ribbon)
        const meshPass = encoder.beginComputePass({ label: 'Mesh Generation' });
        meshPass.setPipeline(this.meshGenPipeline);
        meshPass.setBindGroup(0, this.terrainBindGroup);
        meshPass.setBindGroup(1, this.geometryBindGroup);
        meshPass.setBindGroup(2, this.configBindGroup);
        meshPass.dispatchWorkgroups(workgroups);
        meshPass.end();
        
        // Pass 4: Sample terrain and calculate normals
        const drapingPass = encoder.beginComputePass({ label: 'Terrain Draping' });
        drapingPass.setPipeline(this.drapingPipeline);
        drapingPass.setBindGroup(0, this.terrainBindGroup);
        drapingPass.setBindGroup(1, this.geometryBindGroup);
        drapingPass.setBindGroup(2, this.configBindGroup);
        // Use more workgroups for output vertices (which are more numerous)
        const outputWorkgroups = Math.ceil(this.currentSegmentCount * this.config.maxSubdivisionFactor * 2 / WORKGROUP_SIZE);
        drapingPass.dispatchWorkgroups(outputWorkgroups);
        drapingPass.end();
        
        return {
            vertexBuffer: this.outputVertexBuffer,
            indexBuffer: this.outputIndexBuffer,
            statsBuffer: this.statsBuffer
        };
    }
    
    /**
     * Get output buffers for rendering
     */
    getOutputBuffers() {
        return {
            vertexBuffer: this.outputVertexBuffer,
            indexBuffer: this.outputIndexBuffer,
            // Vertex layout: position(3) + normal(3) + color(4) = 10 floats = 40 bytes
            vertexStride: 40,
            vertexAttributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' },  // position
                { shaderLocation: 1, offset: 12, format: 'float32x3' }, // normal
                { shaderLocation: 2, offset: 24, format: 'float32x4' }  // color
            ]
        };
    }
    
    /**
     * Cleanup resources
     */
    destroy() {
        // Destroy all buffers
        this.inputVertexBuffer?.destroy();
        this.inputSegmentBuffer?.destroy();
        this.inputFeatureBuffer?.destroy();
        this.subdivisionCountBuffer?.destroy();
        this.subdivisionOffsetBuffer?.destroy();
        this.subdividedVertexBuffer?.destroy();
        this.outputVertexBuffer?.destroy();
        this.outputIndexBuffer?.destroy();
        this.statsBuffer?.destroy();
        this.configBuffer?.destroy();
        
        this.initialized = false;
    }
}
