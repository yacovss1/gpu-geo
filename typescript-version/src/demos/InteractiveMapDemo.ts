/**
   * Initialize the interactive map demo
   */
  async initialize(): Promise<void> {
    try {
      console.log('🗺️ Starting Interactive Map Demo initialization...');
      
      // CRITICAL: Create a SEPARATE WebGPU device for the map to avoid conflicts
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) {
        throw new Error('WebGPU not supported - no adapter found');
      }
      
      const mapDevice = await adapter.requestDevice();
      if (!mapDevice) {
        throw new Error('Failed to get WebGPU device for map');
      }
      
      console.log('🔧 MAP DEMO: Created SEPARATE WebGPU device:', mapDevice);
      
      // Get canvas
      this.canvas = document.getElementById('mapCanvas') as HTMLCanvasElement;
      if (!this.canvas) {
        throw new Error('Map canvas not found');
      }
      
      // Log canvas details for debugging
      console.log(`🖼️ Canvas found: ${this.canvas.width}x${this.canvas.height}`);
      console.log(`📐 Canvas client size: ${this.canvas.clientWidth}x${this.canvas.clientHeight}`);
      console.log(`🎨 Canvas style: ${this.canvas.style.cssText || 'none'}`);
      console.log(`👁️ Canvas visible: ${this.canvas.offsetWidth > 0 && this.canvas.offsetHeight > 0}`);
      
      // Set canvas size if it's too small
      if (this.canvas.width < 100 || this.canvas.height < 100) {
        console.log('⚠️ Canvas too small, resizing...');
        this.canvas.width = 800;
        this.canvas.height = 600;
        this.canvas.style.width = '800px';
        this.canvas.style.height = '600px';
        console.log(`📏 Canvas resized to: ${this.canvas.width}x${this.canvas.height}`);
      }
      
      // Initialize map engine with the separate device
      this.mapEngine = new WebGPUMapEngine(mapDevice, this.canvas, {
        center: { lng: -122.4194, lat: 37.7749 }, // San Francisco
        zoom: 10,
        enableInteraction: true
      });
      
      await this.mapEngine.initialize();
      
      this.isInitialized = true;
      console.log('✅ Interactive Map Demo ready');
      
    } catch (error) {
      console.error('❌ Failed to initialize Interactive Map Demo:', error);
      throw error;
    }
  }

// Let me check the actual file content first
console.log('Checking InteractiveMapDemo.ts structure');