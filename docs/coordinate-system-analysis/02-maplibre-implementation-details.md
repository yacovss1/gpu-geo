# MapLibre Core Architecture Deep Dive

## Camera and Transform System

### Transform Matrix Pipeline

MapLibre's transform system consists of several key matrix transformations that convert between coordinate spaces:

#### 1. World Matrix
Converts from world coordinates to camera space:
```typescript
// From transform.js - worldMatrix calculation
getWorldMatrix(): mat4 {
  const matrix = mat4.identity();
  
  // Apply zoom scaling
  const scale = this.scale; // 2^zoom
  mat4.scale(matrix, matrix, [scale, scale, 1]);
  
  // Apply center translation
  const centerPoint = this.centerPoint;
  mat4.translate(matrix, matrix, [-centerPoint.x, -centerPoint.y, 0]);
  
  return matrix;
}
```

#### 2. Camera Matrix
Handles 3D perspective and rotation:
```typescript
// 3D perspective projection
getCameraMatrix(): mat4 {
  const matrix = mat4.identity();
  
  // Apply pitch (vertical tilt)
  if (this.pitch) {
    mat4.rotateX(matrix, matrix, this.pitch * Math.PI / 180);
  }
  
  // Apply bearing (horizontal rotation)
  if (this.bearing) {
    mat4.rotateZ(matrix, matrix, -this.bearing * Math.PI / 180);
  }
  
  // Apply perspective projection
  const fov = Math.atan(0.5 / this.cameraToCenterDistance);
  const aspect = this.width / this.height;
  mat4.perspective(matrix, fov, aspect, 0.1, 1000);
  
  return matrix;
}
```

#### 3. Projection Matrix Composition
```typescript
// Complete projection pipeline
calculateProjectionMatrix(): mat4 {
  const projMatrix = mat4.create();
  
  // Combine world and camera transformations
  mat4.multiply(projMatrix, this.getCameraMatrix(), this.getWorldMatrix());
  
  // Add viewport transformation
  const viewportMatrix = this.getViewportMatrix();
  mat4.multiply(projMatrix, viewportMatrix, projMatrix);
  
  return projMatrix;
}
```

### Screen-to-World Coordinate Conversion

#### Forward Projection (LngLat → Screen)
```typescript
projectLngLat(lnglat: LngLat): Point {
  // Convert to world coordinates
  const worldCoord = this.lngLatToWorld(lnglat);
  
  // Apply current transform
  const projected = this.worldToScreen(worldCoord);
  
  return new Point(projected.x, projected.y);
}

lngLatToWorld(lnglat: LngLat): Point {
  const x = (lnglat.lng + 180) / 360;
  const y = (1 - Math.log(Math.tan(lnglat.lat * Math.PI / 180) + 
    1 / Math.cos(lnglat.lat * Math.PI / 180)) / Math.PI) / 2;
  
  return new Point(x, y);
}
```

#### Inverse Projection (Screen → LngLat)
```typescript
screenToLngLat(point: Point): LngLat {
  // Unproject screen coordinates to world space
  const worldCoord = this.screenToWorld(point);
  
  // Convert world coordinates to geographic
  return this.worldToLngLat(worldCoord);
}

worldToLngLat(worldCoord: Point): LngLat {
  const lng = worldCoord.x * 360 - 180;
  const n = Math.PI - 2 * Math.PI * worldCoord.y;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  
  return new LngLat(lng, lat);
}
```

## Tile Fetching Architecture

### Tile Request Pipeline

#### 1. Visibility Calculation
```typescript
// From source_cache.js
getVisibleCoordinates(transform: Transform): Array<TileID> {
  const coords = transform.coveringTiles({
    tileSize: this.tileSize,
    minzoom: this.minzoom,
    maxzoom: this.maxzoom
  });
  
  // Sort by distance from center for loading priority
  const center = transform.centerPoint;
  coords.sort((a, b) => {
    const aDist = this.getTileDistanceFromCenter(a, center);
    const bDist = this.getTileDistanceFromCenter(b, center);
    return aDist - bDist;
  });
  
  return coords;
}
```

#### 2. Tile Loading State Machine
```typescript
class Tile {
  state: 'loading' | 'loaded' | 'reloading' | 'unloaded' | 'errored';
  
  loadVectorData(data: ArrayBuffer, painter: Painter): void {
    this.state = 'loading';
    
    try {
      // Parse vector tile data
      const vectorTile = new VectorTile(new Protobuf(data));
      this.buckets = this.createBuckets(vectorTile, painter.style);
      
      this.state = 'loaded';
      this.timeAdded = Date.now();
    } catch (error) {
      this.state = 'errored';
      this.error = error;
    }
  }
}
```

#### 3. Request Queue Management
```typescript
class RequestManager {
  private queue: Array<TileRequest> = [];
  private activeRequests: Set<string> = new Set();
  private maxConcurrentRequests = 16;
  
  requestTile(tileID: TileID, callback: Function): void {
    const request = new TileRequest(tileID, callback);
    
    if (this.activeRequests.size < this.maxConcurrentRequests) {
      this.executeRequest(request);
    } else {
      this.queue.push(request);
    }
  }
  
  private executeRequest(request: TileRequest): void {
    this.activeRequests.add(request.id);
    
    fetch(request.url)
      .then(response => response.arrayBuffer())
      .then(data => {
        request.callback(null, data);
        this.onRequestComplete(request);
      })
      .catch(error => {
        request.callback(error);
        this.onRequestComplete(request);
      });
  }
  
  private onRequestComplete(request: TileRequest): void {
    this.activeRequests.delete(request.id);
    
    // Process next request in queue
    if (this.queue.length > 0) {
      const nextRequest = this.queue.shift();
      this.executeRequest(nextRequest);
    }
  }
}
```

### Tile Caching Strategy

#### LRU Cache Implementation
```typescript
class TileCache {
  private cache: Map<string, Tile> = new Map();
  private maxSize: number = 500;
  
  get(tileID: TileID): Tile | null {
    const tile = this.cache.get(tileID.key);
    if (tile) {
      // Move to end (most recently used)
      this.cache.delete(tileID.key);
      this.cache.set(tileID.key, tile);
    }
    return tile || null;
  }
  
  set(tileID: TileID, tile: Tile): void {
    // Remove oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      const oldTile = this.cache.get(firstKey);
      this.cache.delete(firstKey);
      oldTile?.unload();
    }
    
    this.cache.set(tileID.key, tile);
  }
  
  // Memory pressure handling
  reduceCacheSize(targetSize: number): void {
    const toRemove = this.cache.size - targetSize;
    const entries = Array.from(this.cache.entries());
    
    // Remove oldest tiles first
    for (let i = 0; i < toRemove && i < entries.length; i++) {
      const [key, tile] = entries[i];
      this.cache.delete(key);
      tile.unload();
    }
  }
}
```

## Interaction Handling Deep Dive

### Pan Gesture Implementation

#### Mouse Panning
```typescript
class MousePanHandler {
  private isDragging = false;
  private lastMousePos: Point;
  private velocity: Point = new Point(0, 0);
  private velocityHistory: Array<{pos: Point, time: number}> = [];
  
  onMouseDown(e: MouseEvent): void {
    this.isDragging = true;
    this.lastMousePos = new Point(e.clientX, e.clientY);
    this.velocity = new Point(0, 0);
    this.velocityHistory = [];
  }
  
  onMouseMove(e: MouseEvent): void {
    if (!this.isDragging) return;
    
    const currentPos = new Point(e.clientX, e.clientY);
    const delta = currentPos.sub(this.lastMousePos);
    
    // Update velocity tracking
    this.updateVelocity(delta);
    
    // Apply pan
    this.map.transform.translateBy(delta);
    this.map.triggerRepaint();
    
    this.lastMousePos = currentPos;
  }
  
  onMouseUp(e: MouseEvent): void {
    if (!this.isDragging) return;
    
    this.isDragging = false;
    
    // Apply inertia if velocity is significant
    const currentVelocity = this.calculateAverageVelocity();
    if (currentVelocity.mag() > 5) {
      this.startInertiaAnimation(currentVelocity);
    }
  }
  
  private updateVelocity(delta: Point): void {
    const now = Date.now();
    this.velocityHistory.push({pos: delta, time: now});
    
    // Keep only recent history
    const cutoff = now - 100; // 100ms window
    this.velocityHistory = this.velocityHistory.filter(v => v.time > cutoff);
  }
  
  private calculateAverageVelocity(): Point {
    if (this.velocityHistory.length < 2) return new Point(0, 0);
    
    const totalDelta = this.velocityHistory.reduce(
      (sum, v) => sum.add(v.pos), 
      new Point(0, 0)
    );
    const totalTime = this.velocityHistory[this.velocityHistory.length - 1].time - 
                      this.velocityHistory[0].time;
    
    return totalDelta.mult(1000 / totalTime); // pixels per second
  }
}
```

#### Touch Panning with Momentum
```typescript
class TouchPanHandler {
  private touches: Map<number, Touch> = new Map();
  private lastCentroid: Point;
  
  onTouchStart(e: TouchEvent): void {
    // Track all touches
    Array.from(e.changedTouches).forEach(touch => {
      this.touches.set(touch.identifier, touch);
    });
    
    this.lastCentroid = this.calculateCentroid();
  }
  
  onTouchMove(e: TouchEvent): void {
    // Update touch positions
    Array.from(e.changedTouches).forEach(touch => {
      this.touches.set(touch.identifier, touch);
    });
    
    const centroid = this.calculateCentroid();
    const delta = centroid.sub(this.lastCentroid);
    
    // Apply pan
    this.map.transform.translateBy(delta);
    this.map.triggerRepaint();
    
    this.lastCentroid = centroid;
  }
  
  private calculateCentroid(): Point {
    const touches = Array.from(this.touches.values());
    const sum = touches.reduce(
      (acc, touch) => acc.add(new Point(touch.clientX, touch.clientY)),
      new Point(0, 0)
    );
    return sum.div(touches.length);
  }
}
```

### Zoom Implementation

#### Scroll Wheel Zooming
```typescript
class ScrollZoomHandler {
  private wheelZoomTimer: number;
  private lastWheelEvent: WheelEvent;
  
  onWheel(e: WheelEvent): void {
    e.preventDefault();
    
    // Normalize wheel delta across browsers
    const normalizedDelta = this.normalizeWheelDelta(e);
    
    // Calculate zoom change
    const zoomDelta = -normalizedDelta * 0.01;
    const newZoom = this.map.transform.zoom + zoomDelta;
    
    // Zoom around mouse position
    const mousePoint = new Point(e.clientX, e.clientY);
    this.zoomAroundPoint(newZoom, mousePoint);
    
    // Debounce for smooth scrolling
    clearTimeout(this.wheelZoomTimer);
    this.wheelZoomTimer = setTimeout(() => {
      this.onWheelEnd();
    }, 100);
  }
  
  private normalizeWheelDelta(e: WheelEvent): number {
    let delta = e.deltaY;
    
    // Handle different wheel modes
    if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      delta *= 16; // Approximate line height
    } else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      delta *= 480; // Approximate page height
    }
    
    return Math.max(-100, Math.min(100, delta));
  }
  
  private zoomAroundPoint(zoom: number, point: Point): void {
    const transform = this.map.transform;
    
    // Convert screen point to world coordinates at current zoom
    const worldPoint = transform.screenToWorld(point);
    
    // Update zoom
    transform.zoom = Math.max(transform.minZoom, 
                             Math.min(transform.maxZoom, zoom));
    
    // Convert world point back to screen at new zoom
    const newScreenPoint = transform.worldToScreen(worldPoint);
    
    // Adjust center to keep world point under cursor
    const offset = point.sub(newScreenPoint);
    transform.translateBy(offset);
  }
}
```

#### Pinch-to-Zoom
```typescript
class PinchZoomHandler {
  private initialDistance: number;
  private initialZoom: number;
  private initialCenter: Point;
  
  onTouchStart(touches: TouchList): void {
    if (touches.length !== 2) return;
    
    const touch1 = new Point(touches[0].clientX, touches[0].clientY);
    const touch2 = new Point(touches[1].clientX, touches[1].clientY);
    
    this.initialDistance = touch1.dist(touch2);
    this.initialZoom = this.map.transform.zoom;
    this.initialCenter = touch1.add(touch2).div(2);
  }
  
  onTouchMove(touches: TouchList): void {
    if (touches.length !== 2) return;
    
    const touch1 = new Point(touches[0].clientX, touches[0].clientY);
    const touch2 = new Point(touches[1].clientX, touches[1].clientY);
    
    const currentDistance = touch1.dist(touch2);
    const currentCenter = touch1.add(touch2).div(2);
    
    // Calculate zoom change
    const zoomChange = Math.log2(currentDistance / this.initialDistance);
    const newZoom = this.initialZoom + zoomChange;
    
    // Apply zoom around pinch center
    this.zoomAroundPoint(newZoom, this.initialCenter);
    
    // Handle simultaneous pan
    const panDelta = currentCenter.sub(this.initialCenter);
    this.map.transform.translateBy(panDelta);
  }
}
```

This detailed analysis provides the implementation patterns from MapLibre that can be directly adapted for your mapping project's camera system, tile management, and user interactions.