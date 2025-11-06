import { SimpleWebGPUTest } from '../core/map/SimpleWebGPUTest';

/**
 * Simple WebGPU rendering test
 */
export class SimpleRenderingTest {
  private canvas: HTMLCanvasElement;
  private device: GPUDevice | null = null;
  private adapter: GPUAdapter | null = null;
  private isInitialized = false;

  constructor() {
    // Create canvas element
    this.canvas = document.createElement('canvas');
    this.canvas.width = 800;
    this.canvas.height = 600;
    this.canvas.style.border = '2px solid #00ff00';
    this.canvas.style.display = 'block';
    this.canvas.style.margin = '20px auto';
    
    console.log('🧪 Simple Rendering Test created');
  }

  /**
   * Initialize WebGPU and run test
   */
  async initialize(): Promise<void> {
    console.log('🧪 Initializing simple rendering test...');
    
    // Check WebGPU support
    if (!navigator.gpu) {
      throw new Error('WebGPU not supported');
    }

    // Get adapter and device
    this.adapter = await navigator.gpu.requestAdapter();
    if (!this.adapter) {
      throw new Error('Failed to get WebGPU adapter');
    }

    this.device = await this.adapter.requestDevice();
    console.log('✅ WebGPU device obtained');

    // Create and run simple test
    const simpleTest = new SimpleWebGPUTest(this.device, this.canvas);
    await simpleTest.initialize();
    
    this.isInitialized = true;
    console.log('✅ Simple rendering test completed');
  }

  /**
   * Get the canvas element
   */
  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    if (this.device) {
      this.device.destroy();
    }
    this.isInitialized = false;
    console.log('🧹 Simple rendering test destroyed');
  }

  /**
   * Check if initialized
   */
  get initialized(): boolean {
    return this.isInitialized;
  }
}