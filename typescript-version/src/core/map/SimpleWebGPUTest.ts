// Simple WebGPU test to debug rendering issues
export class SimpleWebGPUTest {
  private device: GPUDevice;
  private canvas: HTMLCanvasElement;
  private context: GPUCanvasContext;
  private renderPipeline: GPURenderPipeline | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;

  constructor(device: GPUDevice, canvas: HTMLCanvasElement) {
    this.device = device;
    this.canvas = canvas;
    
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('No WebGPU context');
    this.context = context;
    
    // Configure context
    this.context.configure({
      device: this.device,
      format: 'bgra8unorm',
      alphaMode: 'premultiplied'
    });
    
    console.log('🧪 Simple WebGPU test initialized');
  }
  
  async initialize(): Promise<void> {
    await this.createPipeline();
    this.createBuffers();
    this.createBindGroup();
    this.render();
  }
  
  private async createPipeline(): Promise<void> {
    const vertexShader = `
      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) color: vec4<f32>,
      }
      
      @vertex
      fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
        var pos = array<vec2<f32>, 3>(
          vec2<f32>(-0.5, -0.5),
          vec2<f32>( 0.5, -0.5),
          vec2<f32>( 0.0,  0.5)
        );
        
        var colors = array<vec3<f32>, 3>(
          vec3<f32>(1.0, 0.0, 0.0), // Red
          vec3<f32>(0.0, 1.0, 0.0), // Green
          vec3<f32>(0.0, 0.0, 1.0)  // Blue
        );
        
        var output: VertexOutput;
        output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
        output.color = vec4<f32>(colors[vertexIndex], 1.0);
        return output;
      }
    `;
    
    const fragmentShader = `
      @fragment
      fn fs_main(@location(0) color: vec4<f32>) -> @location(0) vec4<f32> {
        return color;
      }
    `;
    
    const vertexShaderModule = this.device.createShaderModule({
      code: vertexShader
    });
    
    const fragmentShaderModule = this.device.createShaderModule({
      code: fragmentShader
    });
    
    this.renderPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: vertexShaderModule,
        entryPoint: 'vs_main',
      },
      fragment: {
        module: fragmentShaderModule,
        entryPoint: 'fs_main',
        targets: [{
          format: 'bgra8unorm'
        }]
      },
      primitive: {
        topology: 'triangle-list',
      }
    });
    
    console.log('🧪 Created simple test pipeline');
  }
  
  private createBuffers(): void {
    // No buffers needed for this simple test - using vertex_index
  }
  
  private createBindGroup(): void {
    const bindGroupLayout = this.renderPipeline!.getBindGroupLayout(0);
    this.bindGroup = this.device.createBindGroup({
      layout: bindGroupLayout,
      entries: []
    });
  }
  
  private render(): void {
    const commandEncoder = this.device.createCommandEncoder();
    
    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.1, g: 0.1, b: 0.3, a: 1.0 }, // Dark blue background
        loadOp: 'clear',
        storeOp: 'store'
      }]
    });
    
    if (this.renderPipeline && this.bindGroup) {
      renderPass.setPipeline(this.renderPipeline);
      renderPass.setBindGroup(0, this.bindGroup);
      renderPass.draw(3); // Draw 3 vertices (triangle)
      
      console.log('🧪 Drew simple triangle');
    }
    
    renderPass.end();
    this.device.queue.submit([commandEncoder.finish()]);
    
    console.log('🧪 Simple WebGPU test render complete - you should see a colored triangle!');
  }
}