// Shadow Map System
// Implements shadow mapping for real-time cast shadows from buildings

/**
 * ShadowMapRenderer - Manages shadow map generation and sampling
 * 
 * Shadow mapping works in two passes:
 * 1. Shadow pass: Render depth from sun's perspective into shadow map
 * 2. Main pass: Sample shadow map to determine if fragments are in shadow
 */
export class ShadowMapRenderer {
    constructor(device) {
        this.device = device;
        
        // Shadow map resolution (higher = sharper shadows, more GPU cost)
        // 2048 is a good balance for quality/performance
        this.shadowMapSize = 2048;
        
        // Shadow map textures and views
        this.shadowMapTexture = null;
        this.shadowMapView = null;
        this.shadowMapSampler = null;
        
        // Shadow pass pipeline (depth-only rendering)
        this.shadowPipeline = null;
        
        // Uniform buffer for light space matrix
        this.lightMatrixBuffer = null;
        this.shadowBindGroup = null;
        this.shadowBindGroupLayout = null;
        
        // Light space matrix (projects world coords into light/shadow space)
        this.lightViewMatrix = new Float32Array(16);
        this.lightProjMatrix = new Float32Array(16);
        this.lightSpaceMatrix = new Float32Array(16);
        
        // Scene bounds for shadow frustum
        this.sceneMin = [-1, -1, 0];
        this.sceneMax = [1, 1, 0.1];
        
        this.initialized = false;
    }
    
    /**
     * Initialize shadow map resources
     */
    initialize() {
        if (this.initialized) return;
        
        // Create shadow map depth texture
        this.shadowMapTexture = this.device.createTexture({
            size: [this.shadowMapSize, this.shadowMapSize, 1],
            format: 'depth32float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        
        this.shadowMapView = this.shadowMapTexture.createView();
        
        // Comparison sampler for shadow testing
        this.shadowMapSampler = this.device.createSampler({
            compare: 'less',
            magFilter: 'linear',
            minFilter: 'linear',
        });
        
        // Also create a regular sampler for debug visualization
        this.shadowMapSamplerRegular = this.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
        });
        
        // Light space matrix buffer (4x4 matrix = 64 bytes)
        this.lightMatrixBuffer = this.device.createBuffer({
            size: 64,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        
        // Create bind group layout for shadow pass
        this.shadowBindGroupLayout = this.device.createBindGroupLayout({
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                buffer: { type: 'uniform' }
            }]
        });
        
        // Create bind group for shadow pass
        this.shadowBindGroup = this.device.createBindGroup({
            layout: this.shadowBindGroupLayout,
            entries: [{
                binding: 0,
                resource: { buffer: this.lightMatrixBuffer }
            }]
        });
        
        // Create shadow pass pipeline
        this.createShadowPipeline();
        
        this.initialized = true;
        console.log(`🌑 Shadow map initialized: ${this.shadowMapSize}x${this.shadowMapSize}`);
    }
    
    /**
     * Create the depth-only shadow pass pipeline
     */
    createShadowPipeline() {
        const shadowVertexShader = this.device.createShaderModule({
            code: `
struct LightSpace {
    matrix: mat4x4<f32>
};

@group(0) @binding(0) var<uniform> light: LightSpace;

@vertex
fn main(@location(0) inPosition: vec3<f32>, 
        @location(1) inNormal: vec3<f32>, 
        @location(2) inColor: vec4<f32>) -> @builtin(position) vec4<f32> {
    // Transform vertex to light space
    return light.matrix * vec4<f32>(inPosition, 1.0);
}
`
        });
        
        // No fragment shader needed - we only write depth
        // But WebGPU requires a fragment shader, so minimal one
        const shadowFragmentShader = this.device.createShaderModule({
            code: `
@fragment
fn main() -> @location(0) vec4<f32> {
    return vec4<f32>(1.0, 1.0, 1.0, 1.0);
}
`
        });
        
        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [this.shadowBindGroupLayout]
        });
        
        this.shadowPipeline = this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: shadowVertexShader,
                entryPoint: 'main',
                buffers: [{
                    // Same vertex format as main render: pos(3) + normal(3) + color(4)
                    arrayStride: 40,
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x3' },
                        { shaderLocation: 1, offset: 12, format: 'float32x3' },
                        { shaderLocation: 2, offset: 24, format: 'float32x4' }
                    ]
                }]
            },
            fragment: {
                module: shadowFragmentShader,
                entryPoint: 'main',
                targets: [] // No color output - depth only
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'back', // Cull back faces to reduce shadow acne
                frontFace: 'ccw'
            },
            depthStencil: {
                format: 'depth32float',
                depthWriteEnabled: true,
                depthCompare: 'less',
                depthBias: 2,           // Reduce shadow acne
                depthBiasSlopeScale: 2,
                depthBiasClamp: 0.01
            }
        });
    }
    
    /**
     * Update scene bounds for shadow frustum calculation
     * @param {number[]} min - [minX, minY, minZ] in clip space
     * @param {number[]} max - [maxX, maxY, maxZ] in clip space
     */
    updateSceneBounds(min, max) {
        this.sceneMin = min;
        this.sceneMax = max;
    }
    
    /**
     * Calculate light space matrix based on sun direction
     * @param {number[]} sunDir - Normalized sun direction [x, y, z]
     * @param {number[]} cameraCenter - Camera look-at point in world space
     * @param {number} viewRadius - Radius of area to cover with shadows
     */
    updateLightMatrix(sunDir, cameraCenter, viewRadius) {
        // Normalize sun direction
        const len = Math.sqrt(sunDir[0]**2 + sunDir[1]**2 + sunDir[2]**2);
        const sun = [sunDir[0]/len, sunDir[1]/len, sunDir[2]/len];
        
        // Light position: far away in sun direction from scene center
        const lightDist = viewRadius * 2;
        const lightPos = [
            cameraCenter[0] + sun[0] * lightDist,
            cameraCenter[1] + sun[1] * lightDist,
            cameraCenter[2] + sun[2] * lightDist
        ];
        
        // Light view matrix (look from light toward scene center)
        this.lookAt(this.lightViewMatrix, lightPos, cameraCenter, [0, 0, 1]);
        
        // Orthographic projection to cover the scene
        // Ortho bounds based on view radius
        const left = -viewRadius;
        const right = viewRadius;
        const bottom = -viewRadius;
        const top = viewRadius;
        const near = 0.0;
        const far = lightDist * 2;
        
        this.ortho(this.lightProjMatrix, left, right, bottom, top, near, far);
        
        // Combine into light space matrix
        this.multiplyMatrices(this.lightSpaceMatrix, this.lightProjMatrix, this.lightViewMatrix);
        
        // Upload to GPU
        this.device.queue.writeBuffer(this.lightMatrixBuffer, 0, this.lightSpaceMatrix);
    }
    
    /**
     * Render shadow pass - generates shadow map from all shadow-casting geometry
     * @param {GPUCommandEncoder} encoder - Command encoder to use
     * @param {Map} tileBuffers - Tile buffers containing geometry
     * @param {Function} shouldRenderLayer - Filter function for layers
     */
    renderShadowPass(encoder, tileBuffers, shouldRenderLayer) {
        if (!this.initialized) {
            this.initialize();
        }
        
        const shadowPass = encoder.beginRenderPass({
            colorAttachments: [], // No color output
            depthStencilAttachment: {
                view: this.shadowMapView,
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            }
        });
        
        shadowPass.setPipeline(this.shadowPipeline);
        shadowPass.setBindGroup(0, this.shadowBindGroup);
        
        // Render all shadow-casting geometry (buildings mainly)
        // tileBuffers is a Map: layerId -> Array of buffer objects
        tileBuffers.forEach((buffers, layerId) => {
            // Only render 3D geometry that casts shadows
            const is3D = layerId?.includes('building') || 
                         layerId?.includes('extrusion') ||
                         layerId?.includes('3d');
            
            if (!is3D || !shouldRenderLayer(layerId)) return;
            
            buffers.forEach(({ vertexBuffer, fillIndexBuffer, fillIndexCount }) => {
                if (fillIndexCount > 0) {
                    shadowPass.setVertexBuffer(0, vertexBuffer);
                    shadowPass.setIndexBuffer(fillIndexBuffer, 'uint32');
                    shadowPass.drawIndexed(fillIndexCount);
                }
            });
        });
        
        shadowPass.end();
    }
    
    /**
     * Get shadow map texture view for sampling in main pass
     */
    getShadowMapView() {
        return this.shadowMapView;
    }
    
    /**
     * Get shadow map sampler (comparison sampler for shadow testing)
     */
    getShadowMapSampler() {
        return this.shadowMapSampler;
    }
    
    /**
     * Get light space matrix for shadow coordinate calculation
     */
    getLightSpaceMatrix() {
        return this.lightSpaceMatrix;
    }
    
    /**
     * Get the light matrix buffer for bind groups
     */
    getLightMatrixBuffer() {
        return this.lightMatrixBuffer;
    }
    
    // ===== Matrix Math Utilities =====
    
    /**
     * Create a look-at view matrix
     */
    lookAt(out, eye, center, up) {
        const zx = eye[0] - center[0];
        const zy = eye[1] - center[1];
        const zz = eye[2] - center[2];
        let len = Math.sqrt(zx*zx + zy*zy + zz*zz);
        const z = [zx/len, zy/len, zz/len];
        
        // x = up cross z
        let xx = up[1]*z[2] - up[2]*z[1];
        let xy = up[2]*z[0] - up[0]*z[2];
        let xz = up[0]*z[1] - up[1]*z[0];
        len = Math.sqrt(xx*xx + xy*xy + xz*xz);
        const x = [xx/len, xy/len, xz/len];
        
        // y = z cross x
        const y = [
            z[1]*x[2] - z[2]*x[1],
            z[2]*x[0] - z[0]*x[2],
            z[0]*x[1] - z[1]*x[0]
        ];
        
        out[0] = x[0]; out[1] = y[0]; out[2] = z[0]; out[3] = 0;
        out[4] = x[1]; out[5] = y[1]; out[6] = z[1]; out[7] = 0;
        out[8] = x[2]; out[9] = y[2]; out[10] = z[2]; out[11] = 0;
        out[12] = -(x[0]*eye[0] + x[1]*eye[1] + x[2]*eye[2]);
        out[13] = -(y[0]*eye[0] + y[1]*eye[1] + y[2]*eye[2]);
        out[14] = -(z[0]*eye[0] + z[1]*eye[1] + z[2]*eye[2]);
        out[15] = 1;
    }
    
    /**
     * Create orthographic projection matrix
     */
    ortho(out, left, right, bottom, top, near, far) {
        const lr = 1 / (left - right);
        const bt = 1 / (bottom - top);
        const nf = 1 / (near - far);
        
        out[0] = -2 * lr; out[1] = 0; out[2] = 0; out[3] = 0;
        out[4] = 0; out[5] = -2 * bt; out[6] = 0; out[7] = 0;
        out[8] = 0; out[9] = 0; out[10] = 2 * nf; out[11] = 0;
        out[12] = (left + right) * lr;
        out[13] = (top + bottom) * bt;
        out[14] = (far + near) * nf;
        out[15] = 1;
    }
    
    /**
     * Multiply two 4x4 matrices
     */
    multiplyMatrices(out, a, b) {
        const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
        const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
        const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
        const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
        
        let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
        out[0] = b0*a00 + b1*a10 + b2*a20 + b3*a30;
        out[1] = b0*a01 + b1*a11 + b2*a21 + b3*a31;
        out[2] = b0*a02 + b1*a12 + b2*a22 + b3*a32;
        out[3] = b0*a03 + b1*a13 + b2*a23 + b3*a33;
        
        b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
        out[4] = b0*a00 + b1*a10 + b2*a20 + b3*a30;
        out[5] = b0*a01 + b1*a11 + b2*a21 + b3*a31;
        out[6] = b0*a02 + b1*a12 + b2*a22 + b3*a32;
        out[7] = b0*a03 + b1*a13 + b2*a23 + b3*a33;
        
        b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
        out[8] = b0*a00 + b1*a10 + b2*a20 + b3*a30;
        out[9] = b0*a01 + b1*a11 + b2*a21 + b3*a31;
        out[10] = b0*a02 + b1*a12 + b2*a22 + b3*a32;
        out[11] = b0*a03 + b1*a13 + b2*a23 + b3*a33;
        
        b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
        out[12] = b0*a00 + b1*a10 + b2*a20 + b3*a30;
        out[13] = b0*a01 + b1*a11 + b2*a21 + b3*a31;
        out[14] = b0*a02 + b1*a12 + b2*a22 + b3*a32;
        out[15] = b0*a03 + b1*a13 + b2*a23 + b3*a33;
    }
    
    /**
     * Clean up GPU resources
     */
    destroy() {
        if (this.shadowMapTexture) {
            this.shadowMapTexture.destroy();
        }
        if (this.lightMatrixBuffer) {
            this.lightMatrixBuffer.destroy();
        }
        this.initialized = false;
    }
}
