/**
 * Map Active Work - Main Application
 * Uses existing WebGPU translation layer and map engine
 */

import { WebGPUMapEngine } from './core/map/WebGPUMapEngine';
import { TranslationLayer } from './core/translation/TranslationLayer';
import type { LngLat, MapConfig } from './types/core';

console.log('🗺️ Map Active Work - Loading with Translation Layer...');

class MapApplication {
  private mapEngine: WebGPUMapEngine | null = null;
  private translationLayer: TranslationLayer | null = null;
  private canvas: HTMLCanvasElement;

  constructor() {
    this.canvas = document.getElementById('mapCanvas') as HTMLCanvasElement;
    if (!this.canvas) {
      throw new Error('Canvas not found');
    }
  }

  async initialize(): Promise<void> {
    console.log('🚀 Initializing Map Application with Translation Layer...');

    // Setup canvas
    this.setupCanvas();

    // Initialize WebGPU device
    const device = await this.initializeWebGPU();

    // Create translation layer (CPU ↔ GPU bridge)
    this.translationLayer = new TranslationLayer(device);
    await this.translationLayer.initialize();

    // Create map engine with translation layer
    const mapConfig: MapConfig = {
      center: { lng: 0, lat: 20 },
      zoom: 2,
      bearing: 0,
      pitch: 0,
      enableInteraction: true,
      enablePerformanceMonitoring: true,
      translationLayer: this.translationLayer
    };

    this.mapEngine = new WebGPUMapEngine(device, this.canvas, mapConfig);
    await this.mapEngine.initialize();

    // Load world tiles using MapLibre integration
    await this.loadWorldTiles();

    console.log('✅ Map Application ready with translation layer');
  }

  private setupCanvas(): void {
    this.canvas.width = window.innerWidth * window.devicePixelRatio;
    this.canvas.height = window.innerHeight * window.devicePixelRatio;
    this.canvas.style.width = window.innerWidth + 'px';
    this.canvas.style.height = window.innerHeight + 'px';
  }

  private async initializeWebGPU(): Promise<GPUDevice> {
    if (!navigator.gpu) {
      throw new Error('WebGPU not supported');
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error('WebGPU adapter not found');
    }

    const device = await adapter.requestDevice();
    console.log('🎮 WebGPU device initialized');
    return device;
  }

  private async loadWorldTiles(): Promise<void> {
    if (!this.mapEngine || !this.translationLayer) return;

    console.log('🌍 Loading world tiles through translation layer...');

    // Use translation layer to load MapLibre tiles
    const currentView = this.mapEngine.getMapState();
    const tiles = await this.translationLayer.loadTilesForView(
      currentView.transform.center,
      currentView.transform.zoom
    );

    console.log(`📊 Loaded ${tiles.length} tiles through translation layer`);

    // Translation layer handles:
    // - CPU feature data → GPU buffer conversion
    // - Feature merging on GPU
    // - Hidden buffer setup for picking
    // - Coordinate transformations on GPU
    // - Label placement pipeline
  }
}

// Start the application
async function main() {
  try {
    const app = new MapApplication();
    await app.initialize();
  } catch (error) {
    console.error('❌ Map application failed:', error);
    
    // Show error on canvas
    const canvas = document.getElementById('mapCanvas') as HTMLCanvasElement;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#ff4444';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'white';
        ctx.font = '24px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('Translation Layer Failed', canvas.width/2, canvas.height/2);
        ctx.font = '16px Arial';
        ctx.fillText(`Error: ${(error as Error).message}`, canvas.width/2, canvas.height/2 + 40);
      }
    }
  }
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}

console.log('🌍 Map Active Work - Translation Layer Integration Starting...');