// GPU-accelerated label manager for map features

import { FontAtlasGenerator } from './fontAtlas.js';

export class LabelManager {
    constructor(device, format) {
        this.device = device;
        this.format = format;
        this.labels = [];
        this.fontAtlas = null;
        this.labelBuffer = null;
        this.pipeline = null;
        this.maxLabels = 1000;
        this.initialized = false;
    }
    
    // Initialize the label manager
    async initialize() {
        this.initialized = true;
        
        try {
            // Create font atlas for text rendering
            this.fontAtlas = new FontAtlasGenerator('Arial', 24);
            await this.fontAtlas.initialize(this.device);
            
            console.log("Label manager initialized with font atlas");
            
            return true;
        } catch(error) {
            console.error("Failed to initialize label manager:", error);
            throw error;
        }
    }

    // Render text with font atlas - basic implementation
    renderText(commandEncoder, textureView) {
        if (!this.fontAtlas || !this.fontAtlas.texture) {
            console.warn("Font atlas texture not available");
            return;
        }
        
        try {
            // Only create pipeline if needed
            if (!this.pipeline) {
                const vertexShader = `
                    struct VertexOutput {
                        @builtin(position) position: vec4<f32>,
                        @location(0) texCoord: vec2<f32>
                    };

                    @vertex
                    fn main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
                        // Top-right corner display for text atlas
                        var positions = array<vec2<f32>, 6>(
                            vec2<f32>(0.7, -0.7), vec2<f32>(1.0, -0.7), vec2<f32>(0.7, -0.4),
                            vec2<f32>(0.7, -0.4), vec2<f32>(1.0, -0.7), vec2<f32>(1.0, -0.4)
                        );
                        
                        var texCoords = array<vec2<f32>, 6>(
                            vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 0.0),
                            vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(1.0, 0.0)
                        );
                        
                        var output: VertexOutput;
                        output.position = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
                        output.texCoord = texCoords[vertexIndex];
                        return output;
                    }
                `;
                
                const fragmentShader = `
                    @group(0) @binding(0) var texSampler: sampler;
                    @group(0) @binding(1) var tex: texture_2d<f32>;
                    
                    @fragment
                    fn main(@location(0) texCoord: vec2<f32>) -> @location(0) vec4<f32> {
                        let color = textureSample(tex, texSampler, texCoord).r;
                        return vec4<f32>(color, color, color, color);
                    }
                `;
                
                this.pipeline = this.device.createRenderPipeline({
                    layout: 'auto',
                    vertex: {
                        module: this.device.createShaderModule({ code: vertexShader }),
                        entryPoint: 'main'
                    },
                    fragment: {
                        module: this.device.createShaderModule({ code: fragmentShader }),
                        entryPoint: 'main',
                        targets: [{ format: this.format }]
                    },
                    primitive: { topology: 'triangle-list' }
                });
                
                this.sampler = this.device.createSampler({
                    addressModeU: 'clamp-to-edge',
                    addressModeV: 'clamp-to-edge',
                    magFilter: 'linear',
                    minFilter: 'linear'
                });
            }
            
            // Create bind group for rendering
            const bindGroup = this.device.createBindGroup({
                layout: this.pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: this.sampler },
                    { binding: 1, resource: this.fontAtlas.texture.createView() }
                ]
            });
            
            // Render in small corner
            const pass = commandEncoder.beginRenderPass({
                colorAttachments: [{
                    view: textureView,
                    loadOp: 'load',
                    storeOp: 'store'
                }]
            });
            
            pass.setPipeline(this.pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.draw(6);
            pass.end();
            
        } catch(error) {
            console.error("Error in text rendering:", error);
        }
    }

    // Simple wrapper to ensure consistent API
    renderDirectText(commandEncoder, textureView) {
        this.renderText(commandEncoder, textureView);
    }
    
    // Empty methods for API compatibility
    updateTransform() {}
    clearLabels() {}
    addLabel() {}
}
