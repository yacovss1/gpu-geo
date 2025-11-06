# Performance Optimization Guide

## MapLibre Performance Patterns for Map Active Work

This guide covers the key performance optimization techniques used in MapLibre that should be implemented in your mapping project.

## 1. Coordinate Transformation Optimizations

### Matrix Caching Strategy

```typescript
// src/core/transform/TransformCache.ts
export class TransformCache {
  private _projectionMatrix: mat4 | null = null;
  private _worldMatrix: mat4 | null = null;
  private _isDirty = true;
  private _lastZoom = -1;
  private _lastCenter: LngLat | null = null;
  private _lastBearing = -1;
  
  constructor(private transform: MapTransform) {}
  
  getProjectionMatrix(): mat4 {
    if (this._isDirty || this.hasTransformChanged()) {
      this._projectionMatrix = this.calculateProjectionMatrix();
      this.updateCacheState();
    }
    return this._projectionMatrix!;
  }
  
  private hasTransformChanged(): boolean {
    return this._lastZoom !== this.transform.zoom ||
           !this._lastCenter?.equals(this.transform.center) ||
           this._lastBearing !== this.transform.bearing;
  }
  
  private updateCacheState(): void {
    this._lastZoom = this.transform.zoom;
    this._lastCenter = this.transform.center;
    this._lastBearing = this.transform.bearing;
    this._isDirty = false;
  }
  
  invalidate(): void {
    this._isDirty = true;
  }
}
```

### Batch Coordinate Transformations

```typescript
// src/core/transform/BatchTransform.ts
export class BatchTransform {
  private static BATCH_SIZE = 1000;
  
  static projectLngLatsBatch(
    lngLats: LngLat[], 
    transform: MapTransform
  ): Point[] {
    const results: Point[] = new Array(lngLats.length);
    
    // Pre-calculate common values
    const scale = transform.scale;
    const centerWorld = transform.lngLatToWorld(transform.center);
    const cos = Math.cos(transform.bearing * Math.PI / 180);
    const sin = Math.sin(transform.bearing * Math.PI / 180);
    const halfWidth = transform.width / 2;
    const halfHeight = transform.height / 2;
    
    // Process in batches to avoid blocking
    for (let i = 0; i < lngLats.length; i += this.BATCH_SIZE) {
      const batchEnd = Math.min(i + this.BATCH_SIZE, lngLats.length);
      
      if (i > 0) {
        // Yield control for large datasets
        setTimeout(() => this.processBatch(
          lngLats, results, i, batchEnd, 
          scale, centerWorld, cos, sin, halfWidth, halfHeight
        ), 0);
      } else {
        this.processBatch(
          lngLats, results, i, batchEnd,
          scale, centerWorld, cos, sin, halfWidth, halfHeight
        );
      }
    }
    
    return results;
  }
  
  private static processBatch(
    lngLats: LngLat[], 
    results: Point[], 
    start: number, 
    end: number,
    scale: number,
    centerWorld: Point,
    cos: number,
    sin: number,
    halfWidth: number,
    halfHeight: number
  ): void {
    for (let i = start; i < end; i++) {
      const lngLat = lngLats[i];
      
      // Convert to world coordinates
      const x = (lngLat.lng + 180) / 360;
      const lat = lngLat.lat;
      const y = (1 - Math.log(Math.tan(lat * Math.PI / 180) + 
        1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2;
      
      // Apply transform
      const scaledX = (x - centerWorld.x) * scale;
      const scaledY = (y - centerWorld.y) * scale;
      
      // Apply rotation
      const rotatedX = scaledX * cos - scaledY * sin;
      const rotatedY = scaledX * sin + scaledY * cos;
      
      // Convert to screen coordinates
      results[i] = new Point(
        rotatedX + halfWidth,
        rotatedY + halfHeight
      );
    }
  }
}
```

### Web Worker for Heavy Calculations

```typescript
// src/workers/transform.worker.ts
interface TransformRequest {
  id: string;
  type: 'batch_project' | 'batch_unproject';
  data: any;
  transform: {
    center: {lng: number, lat: number};
    zoom: number;
    bearing: number;
    width: number;
    height: number;
  };
}

self.onmessage = function(e: MessageEvent<TransformRequest>) {
  const { id, type, data, transform } = e.data;
  
  try {
    let result;
    switch (type) {
      case 'batch_project':
        result = batchProject(data.lngLats, transform);
        break;
      case 'batch_unproject':
        result = batchUnproject(data.points, transform);
        break;
      default:
        throw new Error(`Unknown transform type: ${type}`);
    }
    
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
};

function batchProject(lngLats: any[], transform: any): any[] {
  // Implementation similar to BatchTransform.processBatch
  // but optimized for web worker environment
  return lngLats.map(lngLat => {
    // Transform logic here
    return { x: 0, y: 0 }; // Placeholder
  });
}
```

## 2. Tile Loading Optimizations

### Priority Queue Implementation

```typescript
// src/core/tiles/TilePriorityQueue.ts
interface TileRequest {
  tileID: TileID;
  priority: number;
  timestamp: number;
}

export class TilePriorityQueue {
  private queue: TileRequest[] = [];
  private inProgress: Set<string> = new Set();
  
  enqueue(tileID: TileID, priority: number): void {
    // Remove existing request for same tile
    this.queue = this.queue.filter(req => req.tileID.key !== tileID.key);
    
    this.queue.push({
      tileID,
      priority,
      timestamp: Date.now()
    });
    
    // Sort by priority (lower number = higher priority)
    this.queue.sort((a, b) => a.priority - b.priority);
  }
  
  dequeue(): TileRequest | null {
    while (this.queue.length > 0) {
      const request = this.queue.shift()!;
      
      // Skip if already in progress
      if (this.inProgress.has(request.tileID.key)) {
        continue;
      }
      
      // Skip if request is too old
      if (Date.now() - request.timestamp > 5000) {
        continue;
      }
      
      this.inProgress.add(request.tileID.key);
      return request;
    }
    
    return null;
  }
  
  markComplete(tileID: TileID): void {
    this.inProgress.delete(tileID.key);
  }
  
  updatePriorities(visibleTiles: TileID[], centerTile: TileID): void {
    const visibleKeys = new Set(visibleTiles.map(t => t.key));
    
    for (const request of this.queue) {
      if (visibleKeys.has(request.tileID.key)) {
        // Higher priority for visible tiles
        request.priority = this.calculatePriority(request.tileID, centerTile, true);
      } else {
        // Lower priority for non-visible tiles
        request.priority = this.calculatePriority(request.tileID, centerTile, false);
      }
    }
    
    this.queue.sort((a, b) => a.priority - b.priority);
  }
  
  private calculatePriority(tileID: TileID, centerTile: TileID, isVisible: boolean): number {
    // Distance from center tile
    const dx = tileID.x - centerTile.x;
    const dy = tileID.y - centerTile.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    
    // Zoom level difference penalty
    const zoomDiff = Math.abs(tileID.z - centerTile.z);
    
    let priority = distance + zoomDiff * 10;
    
    if (!isVisible) {
      priority += 1000; // Much lower priority for non-visible tiles
    }
    
    return priority;
  }
}
```

### Adaptive Tile Loading

```typescript
// src/core/tiles/AdaptiveTileLoader.ts
export class AdaptiveTileLoader {
  private maxConcurrentRequests = 6;
  private requestTimes: number[] = [];
  private failureCount = 0;
  private lastAdjustment = 0;
  
  adjustConcurrency(): void {
    const now = Date.now();
    
    // Don't adjust too frequently
    if (now - this.lastAdjustment < 2000) return;
    
    const avgRequestTime = this.getAverageRequestTime();
    const failureRate = this.failureCount / (this.requestTimes.length || 1);
    
    if (failureRate > 0.1 || avgRequestTime > 3000) {
      // Reduce concurrency if high failure rate or slow requests
      this.maxConcurrentRequests = Math.max(2, this.maxConcurrentRequests - 1);
    } else if (failureRate < 0.05 && avgRequestTime < 1000) {
      // Increase concurrency if low failure rate and fast requests
      this.maxConcurrentRequests = Math.min(12, this.maxConcurrentRequests + 1);
    }
    
    this.lastAdjustment = now;
    console.log(`Adjusted tile concurrency to ${this.maxConcurrentRequests}`);
  }
  
  recordRequestTime(duration: number): void {
    this.requestTimes.push(duration);
    
    // Keep only recent history
    if (this.requestTimes.length > 50) {
      this.requestTimes = this.requestTimes.slice(-25);
    }
  }
  
  recordFailure(): void {
    this.failureCount++;
    
    // Reset failure count periodically
    setTimeout(() => {
      this.failureCount = Math.max(0, this.failureCount - 1);
    }, 10000);
  }
  
  private getAverageRequestTime(): number {
    if (this.requestTimes.length === 0) return 0;
    return this.requestTimes.reduce((sum, time) => sum + time, 0) / this.requestTimes.length;
  }
  
  getConcurrencyLimit(): number {
    return this.maxConcurrentRequests;
  }
}
```

## 3. Rendering Optimizations

### Viewport Culling

```typescript
// src/core/render/ViewportCuller.ts
export class ViewportCuller {
  private frustumPlanes: Plane[] = [];
  
  updateFrustum(transform: MapTransform): void {
    // Calculate frustum planes for culling
    const corners = [
      new Point(0, 0),
      new Point(transform.width, 0),
      new Point(transform.width, transform.height),
      new Point(0, transform.height)
    ];
    
    // Convert screen corners to world coordinates
    const worldCorners = corners.map(corner => 
      transform.screenPointToLngLat(corner)
    );
    
    // Create bounding planes
    this.frustumPlanes = this.calculateFrustumPlanes(worldCorners);
  }
  
  isTileVisible(tileID: TileID): boolean {
    const tileBounds = this.getTileBounds(tileID);
    
    // Test tile bounds against frustum planes
    for (const plane of this.frustumPlanes) {
      if (!this.intersectsBounds(plane, tileBounds)) {
        return false;
      }
    }
    
    return true;
  }
  
  cullTiles(tiles: TileID[]): TileID[] {
    return tiles.filter(tile => this.isTileVisible(tile));
  }
  
  private getTileBounds(tileID: TileID): LngLatBounds {
    const tileSize = Math.pow(2, tileID.z);
    const minLng = (tileID.x / tileSize) * 360 - 180;
    const maxLng = ((tileID.x + 1) / tileSize) * 360 - 180;
    
    const minLatY = (tileID.y + 1) / tileSize;
    const maxLatY = tileID.y / tileSize;
    
    const minLat = this.yToLat(minLatY);
    const maxLat = this.yToLat(maxLatY);
    
    return new LngLatBounds(
      new LngLat(minLng, minLat),
      new LngLat(maxLng, maxLat)
    );
  }
  
  private yToLat(y: number): number {
    const n = Math.PI - 2 * Math.PI * y;
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }
}
```

### Memory Management

```typescript
// src/core/memory/MemoryManager.ts
export class MemoryManager {
  private memoryUsage = 0;
  private maxMemoryUsage = 100 * 1024 * 1024; // 100MB
  private cleanupCallbacks: (() => void)[] = [];
  
  trackMemoryUsage(bytes: number): void {
    this.memoryUsage += bytes;
    
    if (this.memoryUsage > this.maxMemoryUsage) {
      this.triggerCleanup();
    }
  }
  
  releaseMemory(bytes: number): void {
    this.memoryUsage = Math.max(0, this.memoryUsage - bytes);
  }
  
  addCleanupCallback(callback: () => void): void {
    this.cleanupCallbacks.push(callback);
  }
  
  private triggerCleanup(): void {
    console.log('Memory pressure detected, triggering cleanup');
    
    // Execute cleanup callbacks
    this.cleanupCallbacks.forEach(callback => {
      try {
        callback();
      } catch (error) {
        console.error('Error during memory cleanup:', error);
      }
    });
    
    // Force garbage collection if available
    if (window.gc) {
      window.gc();
    }
  }
  
  getMemoryUsage(): number {
    return this.memoryUsage;
  }
  
  getMemoryPressure(): number {
    return this.memoryUsage / this.maxMemoryUsage;
  }
}
```

## 4. Animation Performance

### RequestAnimationFrame Manager

```typescript
// src/core/animation/AnimationManager.ts
export class AnimationManager {
  private animations: Map<string, Animation> = new Map();
  private rafId: number | null = null;
  private isRunning = false;
  
  addAnimation(id: string, animation: Animation): void {
    this.animations.set(id, animation);
    this.startLoop();
  }
  
  removeAnimation(id: string): void {
    this.animations.delete(id);
    
    if (this.animations.size === 0) {
      this.stopLoop();
    }
  }
  
  private startLoop(): void {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.loop();
  }
  
  private stopLoop(): void {
    this.isRunning = false;
    
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
  
  private loop(): void {
    const now = performance.now();
    const toRemove: string[] = [];
    
    // Update all animations
    for (const [id, animation] of this.animations) {
      const isComplete = animation.update(now);
      
      if (isComplete) {
        toRemove.push(id);
      }
    }
    
    // Remove completed animations
    toRemove.forEach(id => this.removeAnimation(id));
    
    // Continue loop if animations remain
    if (this.isRunning && this.animations.size > 0) {
      this.rafId = requestAnimationFrame(() => this.loop());
    } else {
      this.stopLoop();
    }
  }
}
```

## 5. Performance Monitoring

### Performance Profiler

```typescript
// src/core/profiling/PerformanceProfiler.ts
export class PerformanceProfiler {
  private metrics: Map<string, number[]> = new Map();
  private startTimes: Map<string, number> = new Map();
  
  startTimer(name: string): void {
    this.startTimes.set(name, performance.now());
  }
  
  endTimer(name: string): number {
    const startTime = this.startTimes.get(name);
    if (!startTime) {
      console.warn(`No start time found for timer: ${name}`);
      return 0;
    }
    
    const duration = performance.now() - startTime;
    this.startTimes.delete(name);
    
    // Record metric
    if (!this.metrics.has(name)) {
      this.metrics.set(name, []);
    }
    
    const measurements = this.metrics.get(name)!;
    measurements.push(duration);
    
    // Keep only recent measurements
    if (measurements.length > 100) {
      measurements.splice(0, 50);
    }
    
    return duration;
  }
  
  getAverageTime(name: string): number {
    const measurements = this.metrics.get(name);
    if (!measurements || measurements.length === 0) return 0;
    
    return measurements.reduce((sum, time) => sum + time, 0) / measurements.length;
  }
  
  getMetrics(): Record<string, {avg: number, count: number}> {
    const result: Record<string, {avg: number, count: number}> = {};
    
    for (const [name, measurements] of this.metrics) {
      result[name] = {
        avg: this.getAverageTime(name),
        count: measurements.length
      };
    }
    
    return result;
  }
  
  logMetrics(): void {
    const metrics = this.getMetrics();
    console.table(metrics);
  }
}

// Usage example
const profiler = new PerformanceProfiler();

profiler.startTimer('tile-loading');
// ... tile loading code ...
profiler.endTimer('tile-loading');

profiler.startTimer('coordinate-transform');
// ... transform code ...
profiler.endTimer('coordinate-transform');
```

This performance optimization guide provides the essential techniques used in MapLibre that you should implement in your mapping project to ensure smooth performance at scale.