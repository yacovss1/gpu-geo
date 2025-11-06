# Practical Implementation Guide for Map Active Work

## Project-Specific Adaptations

This guide demonstrates how to implement MapLibre's coordinate system, tile fetching, and interaction patterns in your Map Active Work project.

## 1. Coordinate System Implementation

### Core Transform Class Adaptation

```typescript
// src/core/transform/Transform.ts
export class MapTransform {
  private _center: LngLat;
  private _zoom: number;
  private _bearing: number;
  private _pitch: number;
  private _width: number;
  private _height: number;
  
  // Cached matrices for performance
  private _projectionMatrix: mat4 | null = null;
  private _matrixDirty = true;
  
  constructor(options: TransformOptions = {}) {
    this._center = options.center || new LngLat(0, 0);
    this._zoom = options.zoom || 0;
    this._bearing = options.bearing || 0;
    this._pitch = options.pitch || 0;
    this._width = options.width || 512;
    this._height = options.height || 512;
  }
  
  // Main coordinate conversion methods
  lngLatToScreenPoint(lngLat: LngLat): Point {
    const worldCoord = this.lngLatToWorld(lngLat);
    return this.worldToScreen(worldCoord);
  }
  
  screenPointToLngLat(point: Point): LngLat {
    const worldCoord = this.screenToWorld(point);
    return this.worldToLngLat(worldCoord);
  }
  
  // Geographic to normalized world coordinates [0,1]
  private lngLatToWorld(lngLat: LngLat): Point {
    const x = (lngLat.lng + 180) / 360;
    const lat = lngLat.lat;
    const y = (1 - Math.log(Math.tan(lat * Math.PI / 180) + 
      1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2;
    
    return new Point(x, y);
  }
  
  // World coordinates to screen pixels
  private worldToScreen(worldCoord: Point): Point {
    const scale = this.scale; // 2^zoom
    const centerWorld = this.lngLatToWorld(this._center);
    
    // Apply zoom scaling
    const scaledX = (worldCoord.x - centerWorld.x) * scale;
    const scaledY = (worldCoord.y - centerWorld.y) * scale;
    
    // Apply rotation if bearing is set
    let x = scaledX;
    let y = scaledY;
    
    if (this._bearing !== 0) {
      const angle = this._bearing * Math.PI / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      x = scaledX * cos - scaledY * sin;
      y = scaledX * sin + scaledY * cos;
    }
    
    // Translate to screen center
    return new Point(
      x + this._width / 2,
      y + this._height / 2
    );
  }
  
  // Screen pixels to world coordinates
  private screenToWorld(screenPoint: Point): Point {
    // Translate from screen center
    let x = screenPoint.x - this._width / 2;
    let y = screenPoint.y - this._height / 2;
    
    // Reverse rotation
    if (this._bearing !== 0) {
      const angle = -this._bearing * Math.PI / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const rotX = x * cos - y * sin;
      const rotY = x * sin + y * cos;
      x = rotX;
      y = rotY;
    }
    
    // Reverse zoom scaling
    const scale = this.scale;
    const centerWorld = this.lngLatToWorld(this._center);
    
    return new Point(
      centerWorld.x + x / scale,
      centerWorld.y + y / scale
    );
  }
  
  // World coordinates to geographic
  private worldToLngLat(worldCoord: Point): LngLat {
    const lng = worldCoord.x * 360 - 180;
    const n = Math.PI - 2 * Math.PI * worldCoord.y;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    
    return new LngLat(lng, lat);
  }
  
  // Utility getters
  get scale(): number {
    return Math.pow(2, this._zoom);
  }
  
  get center(): LngLat { return this._center; }
  get zoom(): number { return this._zoom; }
  get bearing(): number { return this._bearing; }
  get pitch(): number { return this._pitch; }
  
  // Transformation methods
  setCenter(center: LngLat): void {
    this._center = center;
    this._matrixDirty = true;
  }
  
  setZoom(zoom: number): void {
    this._zoom = Math.max(0, Math.min(22, zoom));
    this._matrixDirty = true;
  }
  
  setBearing(bearing: number): void {
    this._bearing = bearing % 360;
    this._matrixDirty = true;
  }
  
  translateBy(offset: Point): void {
    const centerScreen = new Point(this._width / 2, this._height / 2);
    const newCenterScreen = centerScreen.add(offset);
    const newCenter = this.screenPointToLngLat(newCenterScreen);
    this.setCenter(newCenter);
  }
}
```

### Supporting Classes

```typescript
// src/core/geo/LngLat.ts
export class LngLat {
  constructor(public lng: number, public lat: number) {}
  
  equals(other: LngLat): boolean {
    return Math.abs(this.lng - other.lng) < 1e-10 && 
           Math.abs(this.lat - other.lat) < 1e-10;
  }
  
  distanceTo(other: LngLat): number {
    // Haversine formula for great circle distance
    const R = 6371000; // Earth's radius in meters
    const φ1 = this.lat * Math.PI / 180;
    const φ2 = other.lat * Math.PI / 180;
    const Δφ = (other.lat - this.lat) * Math.PI / 180;
    const Δλ = (other.lng - this.lng) * Math.PI / 180;
    
    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    
    return R * c;
  }
}

// src/core/geo/Point.ts
export class Point {
  constructor(public x: number, public y: number) {}
  
  add(other: Point): Point {
    return new Point(this.x + other.x, this.y + other.y);
  }
  
  sub(other: Point): Point {
    return new Point(this.x - other.x, this.y - other.y);
  }
  
  mult(factor: number): Point {
    return new Point(this.x * factor, this.y * factor);
  }
  
  div(factor: number): Point {
    return new Point(this.x / factor, this.y / factor);
  }
  
  dist(other: Point): number {
    const dx = this.x - other.x;
    const dy = this.y - other.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  
  mag(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }
  
  normalize(): Point {
    const m = this.mag();
    return m > 0 ? this.div(m) : new Point(0, 0);
  }
}
```

## 2. Tile System Implementation

### Tile ID and Management

```typescript
// src/core/tiles/TileID.ts
export class TileID {
  constructor(
    public z: number,
    public x: number, 
    public y: number
  ) {}
  
  get key(): string {
    return `${this.z}/${this.x}/${this.y}`;
  }
  
  getParent(): TileID | null {
    if (this.z === 0) return null;
    return new TileID(this.z - 1, Math.floor(this.x / 2), Math.floor(this.y / 2));
  }
  
  getChildren(): TileID[] {
    return [
      new TileID(this.z + 1, this.x * 2, this.y * 2),
      new TileID(this.z + 1, this.x * 2 + 1, this.y * 2),
      new TileID(this.z + 1, this.x * 2, this.y * 2 + 1),
      new TileID(this.z + 1, this.x * 2 + 1, this.y * 2 + 1)
    ];
  }
  
  isChildOf(parent: TileID): boolean {
    const zoomDiff = this.z - parent.z;
    if (zoomDiff <= 0) return false;
    
    const factor = Math.pow(2, zoomDiff);
    return Math.floor(this.x / factor) === parent.x &&
           Math.floor(this.y / factor) === parent.y;
  }
}

// src/core/tiles/TileCalculator.ts
export class TileCalculator {
  static getVisibleTiles(
    transform: MapTransform, 
    tileSize: number = 256,
    minZoom: number = 0,
    maxZoom: number = 18
  ): TileID[] {
    const zoom = Math.floor(transform.zoom);
    const constrainedZoom = Math.max(minZoom, Math.min(maxZoom, zoom));
    
    // Calculate world bounds of visible area
    const bounds = this.getWorldBounds(transform);
    
    // Convert to tile coordinates
    const scale = Math.pow(2, constrainedZoom);
    const minTileX = Math.floor(bounds.minX * scale);
    const maxTileX = Math.floor(bounds.maxX * scale);
    const minTileY = Math.floor(bounds.minY * scale);
    const maxTileY = Math.floor(bounds.maxY * scale);
    
    const tiles: TileID[] = [];
    for (let x = minTileX; x <= maxTileX; x++) {
      for (let y = minTileY; y <= maxTileY; y++) {
        // Handle world wrapping
        const normalizedX = ((x % scale) + scale) % scale;
        tiles.push(new TileID(constrainedZoom, normalizedX, y));
      }
    }
    
    return tiles;
  }
  
  private static getWorldBounds(transform: MapTransform): {
    minX: number, maxX: number, minY: number, maxY: number
  } {
    const corners = [
      new Point(0, 0),
      new Point(transform.width, 0),
      new Point(transform.width, transform.height),
      new Point(0, transform.height)
    ];
    
    const worldCorners = corners.map(corner => 
      transform.screenToWorld ? transform.screenToWorld(corner) : corner
    );
    
    return {
      minX: Math.min(...worldCorners.map(p => p.x)),
      maxX: Math.max(...worldCorners.map(p => p.x)),
      minY: Math.min(...worldCorners.map(p => p.y)),
      maxY: Math.max(...worldCorners.map(p => p.y))
    };
  }
}
```

### Tile Loading and Caching

```typescript
// src/core/tiles/TileManager.ts
export class TileManager {
  private cache: Map<string, Tile> = new Map();
  private loading: Set<string> = new Set();
  private maxCacheSize = 500;
  private loadQueue: TileRequest[] = [];
  private activeRequests = 0;
  private maxConcurrentRequests = 6;
  
  constructor(
    private tileSource: TileSource,
    private onTileLoaded: (tile: Tile) => void
  ) {}
  
  requestTiles(tileIDs: TileID[]): void {
    // Sort by priority (distance from center)
    const sortedTiles = this.sortTilesByPriority(tileIDs);
    
    for (const tileID of sortedTiles) {
      if (!this.cache.has(tileID.key) && !this.loading.has(tileID.key)) {
        this.requestTile(tileID);
      }
    }
  }
  
  private requestTile(tileID: TileID): void {
    const request = new TileRequest(tileID, this.tileSource.getURL(tileID));
    
    if (this.activeRequests < this.maxConcurrentRequests) {
      this.loadTile(request);
    } else {
      this.loadQueue.push(request);
    }
  }
  
  private async loadTile(request: TileRequest): Promise<void> {
    this.loading.add(request.tileID.key);
    this.activeRequests++;
    
    try {
      const data = await this.tileSource.fetchTile(request.url);
      const tile = new Tile(request.tileID, data);
      
      this.addToCache(tile);
      this.onTileLoaded(tile);
    } catch (error) {
      console.error(`Failed to load tile ${request.tileID.key}:`, error);
    } finally {
      this.loading.delete(request.tileID.key);
      this.activeRequests--;
      
      // Process next in queue
      if (this.loadQueue.length > 0) {
        const nextRequest = this.loadQueue.shift()!;
        this.loadTile(nextRequest);
      }
    }
  }
  
  private addToCache(tile: Tile): void {
    // Remove oldest tiles if cache is full
    while (this.cache.size >= this.maxCacheSize) {
      const oldestKey = this.cache.keys().next().value;
      const oldTile = this.cache.get(oldestKey)!;
      this.cache.delete(oldestKey);
      oldTile.dispose();
    }
    
    this.cache.set(tile.id.key, tile);
  }
  
  getTile(tileID: TileID): Tile | null {
    const tile = this.cache.get(tileID.key);
    if (tile) {
      // Move to end (LRU behavior)
      this.cache.delete(tileID.key);
      this.cache.set(tileID.key, tile);
    }
    return tile || null;
  }
  
  private sortTilesByPriority(tileIDs: TileID[]): TileID[] {
    // Simple priority: prefer tiles closer to center and current zoom level
    return tileIDs.sort((a, b) => {
      // Prefer current zoom level
      const aZoomDiff = Math.abs(a.z - this.getCurrentZoom());
      const bZoomDiff = Math.abs(b.z - this.getCurrentZoom());
      if (aZoomDiff !== bZoomDiff) return aZoomDiff - bZoomDiff;
      
      // Then prefer tiles closer to center
      const aDistToCenter = this.getTileDistanceToCenter(a);
      const bDistToCenter = this.getTileDistanceToCenter(b);
      return aDistToCenter - bDistToCenter;
    });
  }
}

// src/core/tiles/Tile.ts
export class Tile {
  public isLoaded = false;
  public error: Error | null = null;
  public lastUsed = Date.now();
  
  constructor(
    public id: TileID,
    public data: ArrayBuffer | null = null
  ) {}
  
  dispose(): void {
    this.data = null;
    this.isLoaded = false;
  }
}
```

## 3. Interaction System

### Unified Interaction Handler

```typescript
// src/core/interaction/InteractionManager.ts
export class InteractionManager {
  private panHandler: PanHandler;
  private zoomHandler: ZoomHandler;
  private isEnabled = true;
  
  constructor(
    private canvas: HTMLCanvasElement,
    private transform: MapTransform,
    private onMapUpdate: () => void
  ) {
    this.panHandler = new PanHandler(transform, onMapUpdate);
    this.zoomHandler = new ZoomHandler(transform, onMapUpdate);
    
    this.setupEventListeners();
  }
  
  private setupEventListeners(): void {
    // Mouse events
    this.canvas.addEventListener('mousedown', this.onMouseDown.bind(this));
    this.canvas.addEventListener('mousemove', this.onMouseMove.bind(this));
    this.canvas.addEventListener('mouseup', this.onMouseUp.bind(this));
    this.canvas.addEventListener('wheel', this.onWheel.bind(this));
    
    // Touch events
    this.canvas.addEventListener('touchstart', this.onTouchStart.bind(this));
    this.canvas.addEventListener('touchmove', this.onTouchMove.bind(this));
    this.canvas.addEventListener('touchend', this.onTouchEnd.bind(this));
    
    // Prevent context menu
    this.canvas.addEventListener('contextmenu', e => e.preventDefault());
  }
  
  private onMouseDown(e: MouseEvent): void {
    if (!this.isEnabled) return;
    this.panHandler.onMouseDown(e);
  }
  
  private onMouseMove(e: MouseEvent): void {
    if (!this.isEnabled) return;
    this.panHandler.onMouseMove(e);
  }
  
  private onMouseUp(e: MouseEvent): void {
    if (!this.isEnabled) return;
    this.panHandler.onMouseUp(e);
  }
  
  private onWheel(e: WheelEvent): void {
    if (!this.isEnabled) return;
    e.preventDefault();
    this.zoomHandler.onWheel(e);
  }
  
  private onTouchStart(e: TouchEvent): void {
    if (!this.isEnabled) return;
    e.preventDefault();
    
    if (e.touches.length === 1) {
      this.panHandler.onTouchStart(e);
    } else if (e.touches.length === 2) {
      this.zoomHandler.onPinchStart(e);
    }
  }
  
  private onTouchMove(e: TouchEvent): void {
    if (!this.isEnabled) return;
    e.preventDefault();
    
    if (e.touches.length === 1) {
      this.panHandler.onTouchMove(e);
    } else if (e.touches.length === 2) {
      this.zoomHandler.onPinchMove(e);
    }
  }
  
  private onTouchEnd(e: TouchEvent): void {
    if (!this.isEnabled) return;
    e.preventDefault();
    
    this.panHandler.onTouchEnd(e);
    this.zoomHandler.onPinchEnd(e);
  }
  
  enable(): void {
    this.isEnabled = true;
  }
  
  disable(): void {
    this.isEnabled = false;
    this.panHandler.reset();
    this.zoomHandler.reset();
  }
}
```

This implementation guide provides the concrete classes and patterns you can use directly in your Map Active Work project, adapted from MapLibre's proven coordinate system, tile management, and interaction handling approaches.