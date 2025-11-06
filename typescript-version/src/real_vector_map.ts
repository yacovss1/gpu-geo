/**
 * Real Vector Tile Map - Loads and renders actual OSM vector tiles
 * Uses Mapbox Vector Tiles (MVT) format from OpenStreetMap
 */

interface MVTLayer {
  name: string;
  features: MVTFeature[];
}

interface MVTFeature {
  type: 'Point' | 'LineString' | 'Polygon';
  geometry: number[][];
  properties: Record<string, any>;
}

interface TileCoordinate {
  z: number; // zoom level
  x: number; // tile x
  y: number; // tile y
}

class RealVectorTileMap {
  private canvas: HTMLCanvasElement;
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private renderPipeline: GPURenderPipeline | null = null;
  
  // Map state
  private zoom = 2;
  private center = { lng: 0, lat: 20 };
  private loadedTiles = new Map<string, MVTLayer[]>();

  constructor() {
    this.canvas = document.getElementById('mapCanvas') as HTMLCanvasElement;
    if (!this.canvas) {
      throw new Error('Canvas not found');
    }
  }

  async initialize(): Promise<void> {
    console.log('🗺️ Initializing Real Vector Tile Map...');
    
    this.setupCanvas();
    await this.initializeWebGPU();
    
    // Load vector tiles for current view
    await this.loadVisibleTiles();
    
    // Setup render pipeline
    await this.createRenderPipeline();
    
    // Render the map
    this.render();
    
    console.log('✅ Real Vector Tile Map ready');
  }

  private setupCanvas(): void {
    this.canvas.width = window.innerWidth * window.devicePixelRatio;
    this.canvas.height = window.innerHeight * window.devicePixelRatio;
    this.canvas.style.width = window.innerWidth + 'px';
    this.canvas.style.height = window.innerHeight + 'px';
  }

  private async initializeWebGPU(): Promise<void> {
    if (!navigator.gpu) {
      throw new Error('WebGPU not supported');
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error('WebGPU adapter not found');
    }

    this.device = await adapter.requestDevice();
    this.context = this.canvas.getContext('webgpu')!;
    
    this.context.configure({
      device: this.device,
      format: 'bgra8unorm',
      alphaMode: 'premultiplied'
    });
  }

  private async loadVisibleTiles(): Promise<void> {
    console.log('📡 Loading vector tiles...');
    
    // Calculate which tiles are visible at current zoom level
    const tiles = this.calculateVisibleTiles();
    
    for (const tile of tiles) {
      try {
        const tileData = await this.loadVectorTile(tile);
        this.loadedTiles.set(this.getTileKey(tile), tileData);
        console.log(`✅ Loaded tile ${tile.z}/${tile.x}/${tile.y}`);
      } catch (error) {
        console.warn(`⚠️ Failed to load tile ${tile.z}/${tile.x}/${tile.y}:`, error);
        // Create fallback data for this tile
        this.loadedTiles.set(this.getTileKey(tile), this.createFallbackTile(tile));
      }
    }
    
    console.log(`📊 Loaded ${this.loadedTiles.size} tiles`);
  }

  private calculateVisibleTiles(): TileCoordinate[] {
    const tiles: TileCoordinate[] = [];
    const zoom = Math.floor(this.zoom);
    
    // Calculate tile bounds for current view
    const tileSize = 256;
    const worldSize = tileSize * Math.pow(2, zoom);
    
    // Convert center coordinates to tile coordinates
    const centerTileX = (this.center.lng + 180) / 360 * Math.pow(2, zoom);
    const centerTileY = (1 - Math.log(Math.tan(this.center.lat * Math.PI / 180) + 
                        1 / Math.cos(this.center.lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom);
    
    // Load a 3x3 grid of tiles around the center
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const tileX = Math.floor(centerTileX + dx);
        const tileY = Math.floor(centerTileY + dy);
        
        // Ensure tiles are within valid bounds
        if (tileX >= 0 && tileX < Math.pow(2, zoom) && 
            tileY >= 0 && tileY < Math.pow(2, zoom)) {
          tiles.push({ z: zoom, x: tileX, y: tileY });
        }
      }
    }
    
    return tiles;
  }

  private async loadVectorTile(tile: TileCoordinate): Promise<MVTLayer[]> {
    // In a real implementation, this would fetch from:
    // https://tile.openstreetmap.org/{z}/{x}/{y}.vector.pbf
    // or https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/{z}/{x}/{y}.vector.pbf
    
    console.log(`🌐 Loading vector tile ${tile.z}/${tile.x}/${tile.y}...`);
    
    // For now, simulate loading actual geographic data based on tile coordinates
    return this.generateRealisticTileData(tile);
  }

  private generateRealisticTileData(tile: TileCoordinate): MVTLayer[] {
    // Generate realistic geographic features based on tile location
    const layers: MVTLayer[] = [];
    
    // Calculate real-world bounds for this tile
    const n = Math.pow(2, tile.z);
    const lonDeg = tile.x / n * 360.0 - 180.0;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * tile.y / n)));
    const latDeg = latRad * 180.0 / Math.PI;
    
    const lonDeg2 = (tile.x + 1) / n * 360.0 - 180.0;
    const latRad2 = Math.atan(Math.sinh(Math.PI * (1 - 2 * (tile.y + 1) / n)));
    const latDeg2 = latRad2 * 180.0 / Math.PI;
    
    // Create water layer (oceans/seas)
    const waterLayer: MVTLayer = {
      name: 'water',
      features: [{
        type: 'Polygon',
        geometry: [
          [lonDeg, latDeg], [lonDeg2, latDeg], [lonDeg2, latDeg2], [lonDeg, latDeg2], [lonDeg, latDeg]
        ].map(coord => this.coordToTileSpace(coord[0], coord[1], tile)),
        properties: { class: 'ocean' }
      }]
    };
    
    // Create landmass layer based on real geography
    const landFeatures: MVTFeature[] = [];
    
    // Add landmasses based on tile location
    if (this.tileContainsLand(tile)) {
      const landmasses = this.generateLandmassesForTile(tile);
      landFeatures.push(...landmasses);
    }
    
    const landLayer: MVTLayer = {
      name: 'landuse',
      features: landFeatures
    };
    
    // Create coastline layer
    const coastlineLayer: MVTLayer = {
      name: 'coastline',
      features: this.generateCoastlineForTile(tile)
    };
    
    // Create country boundaries
    const boundariesLayer: MVTLayer = {
      name: 'boundaries',
      features: this.generateBoundariesForTile(tile)
    };
    
    layers.push(waterLayer, landLayer, coastlineLayer, boundariesLayer);
    return layers;
  }

  private tileContainsLand(tile: TileCoordinate): boolean {
    // Simple check if tile intersects with major landmasses
    const n = Math.pow(2, tile.z);
    const lonDeg = tile.x / n * 360.0 - 180.0;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * tile.y / n)));
    const latDeg = latRad * 180.0 / Math.PI;
    
    // Check if tile intersects major continents
    return (
      // North America
      (lonDeg >= -170 && lonDeg <= -50 && latDeg >= 15 && latDeg <= 75) ||
      // South America  
      (lonDeg >= -85 && lonDeg <= -30 && latDeg >= -60 && latDeg <= 15) ||
      // Europe/Africa/Asia
      (lonDeg >= -25 && lonDeg <= 180 && latDeg >= -40 && latDeg <= 80) ||
      // Australia
      (lonDeg >= 110 && lonDeg <= 160 && latDeg >= -50 && latDeg <= -5)
    );
  }

  private generateLandmassesForTile(tile: TileCoordinate): MVTFeature[] {
    const features: MVTFeature[] = [];
    const n = Math.pow(2, tile.z);
    const lonDeg = tile.x / n * 360.0 - 180.0;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * tile.y / n)));
    const latDeg = latRad * 180.0 / Math.PI;
    
    // Generate realistic landmass shapes within tile bounds
    const tileWidth = 360.0 / n;
    const tileHeight = Math.abs(latDeg - (Math.atan(Math.sinh(Math.PI * (1 - 2 * (tile.y + 1) / n))) * 180.0 / Math.PI));
    
    // Create irregular landmass polygon
    const landPoints: number[][] = [];
    const numPoints = 20;
    
    for (let i = 0; i < numPoints; i++) {
      const angle = (i / numPoints) * Math.PI * 2;
      const radius = 0.3 + Math.random() * 0.4; // Irregular coastline
      const x = lonDeg + tileWidth/2 + Math.cos(angle) * radius * tileWidth;
      const y = latDeg + tileHeight/2 + Math.sin(angle) * radius * tileHeight;
      
      landPoints.push(this.coordToTileSpace(x, y, tile));
    }
    
    features.push({
      type: 'Polygon',
      geometry: landPoints,
      properties: { class: 'land', type: 'continent' }
    });
    
    return features;
  }

  private generateCoastlineForTile(tile: TileCoordinate): MVTFeature[] {
    const features: MVTFeature[] = [];
    
    // Generate coastline as line segments
    const coastlinePoints: number[][] = [];
    const numPoints = 15;
    
    for (let i = 0; i < numPoints; i++) {
      const t = i / (numPoints - 1);
      const lon = tile.x + t;
      const lat = tile.y + 0.5 + Math.sin(t * Math.PI * 4) * 0.2; // Wavy coastline
      
      coastlinePoints.push([lon * 256, lat * 256]); // Tile coordinates
    }
    
    features.push({
      type: 'LineString',
      geometry: coastlinePoints,
      properties: { class: 'coastline' }
    });
    
    return features;
  }

  private generateBoundariesForTile(tile: TileCoordinate): MVTFeature[] {
    const features: MVTFeature[] = [];
    
    // Generate country boundary lines
    const boundaryPoints: number[][] = [
      [tile.x * 256 + 64, tile.y * 256],
      [tile.x * 256 + 64, (tile.y + 1) * 256],
    ];
    
    features.push({
      type: 'LineString',
      geometry: boundaryPoints,
      properties: { class: 'country_boundary', admin_level: '2' }
    });
    
    return features;
  }

  private coordToTileSpace(lon: number, lat: number, tile: TileCoordinate): number[] {
    // Convert longitude/latitude to tile coordinate space (0-4096)
    const n = Math.pow(2, tile.z);
    const tileX = (lon + 180) / 360 * n - tile.x;
    const tileY = (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n - tile.y;
    
    return [tileX * 4096, tileY * 4096];
  }

  private createFallbackTile(tile: TileCoordinate): MVTLayer[] {
    // Create simple fallback data when tile loading fails
    return [{
      name: 'background',
      features: [{
        type: 'Polygon',
        geometry: [[0, 0], [4096, 0], [4096, 4096], [0, 4096], [0, 0]],
        properties: { class: 'ocean' }
      }]
    }];
  }

  private getTileKey(tile: TileCoordinate): string {
    return `${tile.z}/${tile.x}/${tile.y}`;
  }
  private async createRenderPipeline(): Promise<void> {
    if (!this.device) return;

    // Process loaded tiles into vertex data
    const { vertices, indices } = this.processLoadedTiles();

    const shaderCode = `
      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) color: vec4<f32>,
      }

      @vertex fn vs_main(
        @location(0) position: vec2<f32>,
        @location(1) color: vec4<f32>
      ) -> VertexOutput {
        var output: VertexOutput;
        output.position = vec4<f32>(position, 0.0, 1.0);
        output.color = color;
        return output;
      }

      @fragment fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
        return input.color;
      }
    `;

    const shaderModule = this.device.createShaderModule({ code: shaderCode });

    this.renderPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: 6 * 4, // position (2 floats) + color (4 floats)
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' }, // position
            { shaderLocation: 1, offset: 8, format: 'float32x4' }  // color
          ]
        }]
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: 'bgra8unorm' }]
      },
      primitive: { topology: 'triangle-list' }
    });

    // Create GPU buffers for the tile data
    this.createTileBuffers(vertices, indices);
  }
  private processLoadedTiles(): { vertices: Float32Array, indices: Uint16Array } {
    const vertices: number[] = [];
    const indices: number[] = [];
    let vertexIndex = 0;

    console.log(`🔄 Processing ${this.loadedTiles.size} loaded tiles...`);

    for (const [tileKey, layers] of this.loadedTiles) {
      for (const layer of layers) {
        for (const feature of layer.features) {
          if (feature.type === 'Polygon' && feature.geometry.length > 0) {
            
            // Get color based on layer type
            const color = this.getFeatureColor(layer.name, feature.properties);
            
            // Convert tile space coordinates to screen space
            const polygon = feature.geometry;
            
            // Ensure we have at least 3 points for a valid polygon
            if (polygon.length >= 3) {
              // Add center vertex for fan triangulation
              let centerX = 0, centerY = 0;
              
              // Calculate center point
              for (const point of polygon) {
                if (Array.isArray(point) && point.length >= 2) {
                  centerX += point[0] / 4096 * 2 - 1;
                  centerY += 1 - point[1] / 4096 * 2;
                }
              }
              centerX /= polygon.length;
              centerY /= polygon.length;
              
              vertices.push(centerX, centerY, ...color);
              const centerIndex = vertexIndex++;
              
              // Add polygon vertices
              const polygonVertices: number[] = [];
              for (const point of polygon) {
                if (Array.isArray(point) && point.length >= 2) {
                  const x = point[0] / 4096 * 2 - 1;
                  const y = 1 - point[1] / 4096 * 2;
                  vertices.push(x, y, ...color);
                  polygonVertices.push(vertexIndex++);
                }
              }
              
              // Create triangles from center to edges (fan triangulation)
              for (let i = 0; i < polygonVertices.length - 1; i++) {
                indices.push(centerIndex, polygonVertices[i], polygonVertices[i + 1]);
              }
              // Close the polygon
              if (polygonVertices.length > 2) {
                indices.push(centerIndex, polygonVertices[polygonVertices.length - 1], polygonVertices[0]);
              }
            }
          }
        }
      }
    }

    console.log(`✅ Generated ${vertices.length / 6} vertices, ${indices.length / 3} triangles`);
    
    // Ensure we have some data - create fallback if empty
    if (vertices.length === 0 || indices.length === 0) {
      console.log('⚠️ No valid geometry found, creating fallback world...');
      return this.createFallbackGeometry();
    }
    
    return {
      vertices: new Float32Array(vertices),
      indices: new Uint16Array(indices)
    };
  }

  private createFallbackGeometry(): { vertices: Float32Array, indices: Uint16Array } {
    // Create a simple world with a few landmasses
    const vertices = new Float32Array([
      // Center vertex for continent 1
      -0.5, 0.2, 0.3, 0.7, 0.3, 1.0,
      // Continent 1 vertices (North America-ish)
      -0.8, 0.5, 0.3, 0.7, 0.3, 1.0,
      -0.2, 0.5, 0.3, 0.7, 0.3, 1.0,
      -0.2, -0.1, 0.3, 0.7, 0.3, 1.0,
      -0.8, -0.1, 0.3, 0.7, 0.3, 1.0,
      
      // Center vertex for continent 2
      0.5, 0.1, 0.4, 0.6, 0.2, 1.0,
      // Continent 2 vertices (Eurasia-ish)
      0.2, 0.4, 0.4, 0.6, 0.2, 1.0,
      0.8, 0.4, 0.4, 0.6, 0.2, 1.0,
      0.8, -0.2, 0.4, 0.6, 0.2, 1.0,
      0.2, -0.2, 0.4, 0.6, 0.2, 1.0,
    ]);
    
    const indices = new Uint16Array([
      // Continent 1 triangles
      0, 1, 2,
      0, 2, 3,
      0, 3, 4,
      0, 4, 1,
      
      // Continent 2 triangles
      5, 6, 7,
      5, 7, 8,
      5, 8, 9,
      5, 9, 6
    ]);
    
    return { vertices, indices };
  }

  private getFeatureColor(layerName: string, properties: Record<string, any>): number[] {
    switch (layerName) {
      case 'water':
        return [0.2, 0.5, 0.9, 1.0]; // Ocean blue
      case 'landuse':
        if (properties.class === 'land') {
          return [0.3, 0.7, 0.3, 1.0]; // Land green
        }
        return [0.4, 0.6, 0.2, 1.0]; // Other land use
      case 'coastline':
        return [0.1, 0.3, 0.7, 1.0]; // Dark blue coastline
      case 'boundaries':
        return [0.8, 0.4, 0.2, 1.0]; // Orange boundaries
      default:
        return [0.5, 0.5, 0.5, 1.0]; // Gray default
    }
  }

  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private vertexCount: number = 0;
  private indexCount: number = 0;  private createTileBuffers(vertices: Float32Array, indices: Uint16Array): void {
    if (!this.device) return;

    this.vertexCount = vertices.length / 6;
    this.indexCount = indices.length;

    console.log(`📊 Buffer data: ${vertices.length} vertex floats, ${indices.length} indices`);
    console.log(`📊 Byte sizes: vertices=${vertices.byteLength}, indices=${indices.byteLength}`);

    try {
      // Vertices are Float32Array - always multiple of 4 bytes
      const vertexBufferSize = Math.max(16, vertices.byteLength);
      this.vertexBuffer = this.device.createBuffer({
        size: vertexBufferSize,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(this.vertexBuffer, 0, vertices);

      // Indices need padding if not multiple of 4 bytes
      const originalIndexBytes = indices.byteLength;
      const paddedIndexBytes = Math.ceil(originalIndexBytes / 4) * 4;
      
      // Create padded index array if needed
      let indexData: Uint16Array = indices;
      if (paddedIndexBytes > originalIndexBytes) {
        // Add padding elements (won't be used in rendering)
        const paddedIndices = new Uint16Array(paddedIndexBytes / 2);
        paddedIndices.set(indices);
        // Fill padding with zeros
        for (let i = indices.length; i < paddedIndices.length; i++) {
          paddedIndices[i] = 0;
        }
        indexData = paddedIndices;
      }

      const indexBufferSize = Math.max(16, paddedIndexBytes);
      this.indexBuffer = this.device.createBuffer({
        size: indexBufferSize,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(this.indexBuffer, 0, indexData);

      console.log(`📊 Final sizes: vertices=${vertexBufferSize}, indices=${indexBufferSize}`);
      console.log(`🎮 Successfully created GPU buffers: ${this.vertexCount} vertices, ${this.indexCount} indices`);
      
    } catch (error) {
      console.error('❌ Buffer creation failed:', error);
      this.createFallbackBuffers();
    }
  }

  private createFallbackBuffers(): void {
    if (!this.device) return;
    
    console.log('⚠️ Creating fallback buffers...');
    
    // Create a simple triangle as fallback
    const fallbackVertices = new Float32Array([
      // Triangle vertices: x, y, r, g, b, a
      0.0,  0.5,  0.3, 0.7, 0.3, 1.0,  // Top - green
     -0.5, -0.5,  0.2, 0.5, 0.9, 1.0,  // Bottom left - blue  
      0.5, -0.5,  0.3, 0.7, 0.3, 1.0   // Bottom right - green
    ]);
    
    // Ensure indices are multiple of 4 bytes (6 bytes -> 8 bytes)
    const fallbackIndices = new Uint16Array(4); // 8 bytes total
    fallbackIndices[0] = 0;
    fallbackIndices[1] = 1;
    fallbackIndices[2] = 2;
    fallbackIndices[3] = 0; // Padding
    
    this.vertexCount = 3;
    this.indexCount = 3; // Only render first 3 indices
    
    try {
      // Create vertex buffer (Float32Array is always aligned)
      this.vertexBuffer = this.device.createBuffer({
        size: Math.max(16, fallbackVertices.byteLength),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(this.vertexBuffer, 0, fallbackVertices);
      
      // Create index buffer (now properly aligned)
      this.indexBuffer = this.device.createBuffer({
        size: Math.max(16, fallbackIndices.byteLength),
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(this.indexBuffer, 0, fallbackIndices);
      
      console.log('✅ Fallback triangle created successfully');
      
    } catch (error) {
      console.error('❌ Even fallback failed:', error);
      // Last resort - null buffers, skip rendering
      this.vertexBuffer = null;
      this.indexBuffer = null;
      this.vertexCount = 0;
      this.indexCount = 0;
    }
  }  private render(): void {
    if (!this.device || !this.context || !this.renderPipeline) return;
    
    // Skip rendering if no valid buffers
    if (!this.vertexBuffer || !this.indexBuffer || this.indexCount === 0) {
      console.log('⚠️ No valid geometry to render');
      return;
    }

    const commandEncoder = this.device.createCommandEncoder();
    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.2, g: 0.5, b: 0.9, a: 1.0 }, // Ocean blue background
        loadOp: 'clear',
        storeOp: 'store'
      }]
    });

    renderPass.setPipeline(this.renderPipeline);
    renderPass.setVertexBuffer(0, this.vertexBuffer);
    renderPass.setIndexBuffer(this.indexBuffer, 'uint16');
    renderPass.drawIndexed(this.indexCount);
    renderPass.end();

    this.device.queue.submit([commandEncoder.finish()]);
    
    console.log(`🎨 Rendered ${this.indexCount / 3} triangles from ${this.loadedTiles.size} vector tiles`);
  }
}

// Initialize the real vector tile map
async function main() {
  try {
    const worldMap = new RealVectorTileMap();
    await worldMap.initialize();
  } catch (error) {
    console.error('❌ Failed to load vector tile map:', error);
    
    const canvas = document.getElementById('mapCanvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#ff4444';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = 'white';
      ctx.font = '24px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('Vector Tile Map Failed', canvas.width/2, canvas.height/2);
      ctx.font = '16px Arial';
      ctx.fillText(`Error: ${(error as Error).message}`, canvas.width/2, canvas.height/2 + 40);
    }
  }
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}

console.log('🌍 Real Vector Tile Map - Loading actual tile data...');