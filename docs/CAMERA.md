# Camera System

The camera controls viewport, zoom, and transformations.

## Camera Class (`camera.js`)

### Core Properties

```javascript
position: [x, y]         // Mercator world coordinates
zoom: number             // Zoom level (0-22), scale = 2^zoom
viewportWidth: number    // Canvas width in pixels
viewportHeight: number   // Canvas height in pixels
velocity: [vx, vy]       // Momentum for drift
friction: 0.92           // Drift friction coefficient
```

### Zoom System

**Exponential zoom** (like MapLibre):
- `effectiveZoom = Math.pow(2, zoom)`
- Zoom 0 = 1x scale (world fits in viewport)
- Zoom 6 = 64x scale (tiles native resolution)
- Zoom 22 = 4,194,304x scale (extreme close-up)

### Matrix Calculation

The camera generates a view-projection matrix for rendering:

```javascript
getMatrix() {
  const effectiveZoom = Math.pow(2, this.zoom);
  const aspectRatio = this.viewportWidth / this.viewportHeight;
  
  // Order matters! Scale then translate
  mat4.scale(matrix, [effectiveZoom / aspectRatio, effectiveZoom, 1]);
  mat4.translate(matrix, [-this.position[0], -this.position[1], 0]);
  
  return matrix;
}
```

**Why this order?**
- Vertices are multiplied: `output = matrix * vertex`
- Operations apply in reverse: translate first, then scale
- Result: vertex → translate by -camera → scale by zoom

### Zoom-to-Mouse

When zooming, the point under the mouse cursor stays fixed:

```javascript
zoomIn() {
  // 1. Calculate world point under mouse BEFORE zoom
  const worldX = position[0] + (mouseClipX * aspect) / prevEffectiveZoom;
  const worldY = position[1] + mouseClipY / prevEffectiveZoom;
  
  // 2. Change zoom level
  zoom = prevZoom + 1;
  const nextEffectiveZoom = Math.pow(2, zoom);
  
  // 3. Reposition camera so world point stays under mouse
  position[0] = worldX - (mouseClipX * aspect) / nextEffectiveZoom;
  position[1] = worldY - mouseClipY / nextEffectiveZoom;
}
```

### Pan System

Pan speed is inversely proportional to zoom:

```javascript
pan(dx, dy) {
  const effectiveZoom = Math.pow(2, this.zoom);
  const panSpeed = this.velocityFactor / effectiveZoom;
  
  this.position[0] -= dx * panSpeed;
  this.position[1] += dy * panSpeed;
  
  // Set velocity for momentum/drift
  this.velocity[0] = dx * panSpeed;
  this.velocity[1] = -dy * panSpeed;
}
```

At higher zoom levels:
- Same pixel drag = smaller world movement
- Feels natural (you're "closer" to the map)

### Viewport Calculation

The camera calculates visible world bounds:

```javascript
getViewport() {
  const effectiveZoom = Math.pow(2, this.zoom);
  const aspectRatio = this.viewportWidth / this.viewportHeight;
  
  // Account for aspect ratio in X because matrix scales by (zoom/aspect)
  const halfWidth = (this.viewportWidth / 2) / (effectiveZoom / aspectRatio);
  const halfHeight = (this.viewportHeight / 2) / effectiveZoom;
  
  return {
    left: this.position[0] - halfWidth,
    right: this.position[0] + halfWidth,
    top: this.position[1] + halfHeight,
    bottom: this.position[1] - halfHeight
  };
}
```

Used for tile culling - only load tiles in viewport.

### Mouse Tracking

Mouse position stored in **normalized screen coordinates** (0-1):

```javascript
updateMousePosition(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  this.mouseScreenX = (event.clientX - rect.left) / rect.width;
  this.mouseScreenY = (event.clientY - rect.top) / rect.height;
}
```

Convert to clip space (-1 to 1) for zoom calculations:
```javascript
const mouseClipX = this.mouseScreenX * 2 - 1;
const mouseClipY = this.mouseScreenY * 2 - 1;
```

### Drift/Momentum

Smooth camera movement with friction:

```javascript
updatePosition() {
  // Apply velocity
  this.position[0] -= this.velocity[0];
  this.position[1] -= this.velocity[1];
  
  // Apply friction
  this.velocity[0] *= this.friction;  // 0.92
  this.velocity[1] *= this.friction;
  
  // Stop when velocity is negligible
  if (Math.abs(this.velocity[0]) < 0.01) this.velocity[0] = 0;
  if (Math.abs(this.velocity[1]) < 0.01) this.velocity[1] = 0;
}
```

Called every frame in the render loop.

### Events

Camera extends `EventTarget` and emits:
- `zoom`: When zoom changes
- `pan`: When position changes
- `zoomend`: After zoom completes (250ms debounce)

Used to trigger tile loading.

## Configuration

```javascript
maxZoom: 22           // 2^22 = 4.2M scale
minZoom: 0            // 2^0 = 1x scale
maxFetchZoom: 6       // Max tile zoom from server
friction: 0.92        // Drift/momentum (1.0 = no drift)
velocityFactor: 0.5   // Pan speed multiplier
```
