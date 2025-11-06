# Implementation Roadmap: Bringing Map Active Work to Industry Standards

## Overview

This roadmap provides step-by-step implementation guidance to transform your Map Active Work project into a MapLibre-standard mapping library while preserving your innovative GPU acceleration work.

## Phase 1: Core Architecture Foundation (Weeks 1-2)

### 1.1 Transform System Refactor

**Create new file: `src/core/Transform.js`**
```javascript
export class Transform {
    constructor(options = {}) {
        // Core state
        this._center = options.center || { lng: 0, lat: 0 };
        this._zoom = options.zoom || 0;
        this._bearing = options.bearing || 0;
        this._pitch = options.pitch || 0;
        this._viewportWidth = options.width || 512;
        this._viewportHeight = options.height || 512;
        
        // Cached matrices for performance
        this._projMatrix = null;
        this._worldMatrix = null;
        this._matrixDirty = true;
        
        // Coordinate bounds
        this._worldSize = 512; // Base world size at zoom 0
        this._scale = Math.pow(2, this._zoom);
    }
    
    // Geographic to world coordinates (normalized [0,1] space)
    lngLatToWorld(lngLat) {
        const x = (lngLat.lng + 180) / 360;
        const lat = lngLat.lat;
        const y = (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2;
        return { x, y };
    }
    
    // World to geographic coordinates
    worldToLngLat(worldCoord) {
        const lng = worldCoord.x * 360 - 180;
        const n = Math.PI - 2 * Math.PI * worldCoord.y;
        const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
        return { lng, lat };
    }
    
    // World to screen pixels
    worldToScreen(worldCoord) {
        const matrix = this.getProjectionMatrix();
        // Apply transformation using gl-matrix
        const point = vec4.fromValues(worldCoord.x, worldCoord.y, 0, 1);
        vec4.transformMat4(point, point, matrix);
        
        // Convert to screen coordinates
        return {
            x: (point[0] + 1) * this._viewportWidth / 2,
            y: (1 - point[1]) * this._viewportHeight / 2
        };
    }
    
    // Screen to world coordinates
    screenToWorld(screenPoint) {
        // Convert screen to NDC
        const ndcX = (screenPoint.x / this._viewportWidth) * 2 - 1;
        const ndcY = 1 - (screenPoint.y / this._viewportHeight) * 2;
        
        // Inverse transform
        const invMatrix = mat4.create();
        mat4.invert(invMatrix, this.getProjectionMatrix());
        
        const point = vec4.fromValues(ndcX, ndcY, 0, 1);
        vec4.transformMat4(point, point, invMatrix);
        
        return { x: point[0], y: point[1] };
    }
    
    // Main coordinate conversion: Geographic -> Screen
    lngLatToScreen(lngLat) {
        const world = this.lngLatToWorld(lngLat);
        return this.worldToScreen(world);
    }
    
    // Reverse conversion: Screen -> Geographic
    screenToLngLat(screenPoint) {
        const world = this.screenToWorld(screenPoint);
        return this.worldToLngLat(world);
    }
    
    // Get projection matrix with caching
    getProjectionMatrix() {
        if (!this._matrixDirty && this._projMatrix) {
            return this._projMatrix;
        }
        
        this._projMatrix = this._calculateProjectionMatrix();
        this._matrixDirty = false;
        return this._projMatrix;
    }
    
    // Calculate projection matrix
    _calculateProjectionMatrix() {
        const matrix = mat4.create();
        
        // 1. Translate to center
        const worldCenter = this.lngLatToWorld(this._center);
        mat4.translate(matrix, matrix, [-worldCenter.x, -worldCenter.y, 0]);
        
        // 2. Apply zoom scale
        const scale = this._scale;
        const aspectRatio = this._viewportWidth / this._viewportHeight;
        mat4.scale(matrix, matrix, [scale / aspectRatio, scale, 1]);
        
        // 3. Apply bearing rotation
        if (this._bearing !== 0) {
            mat4.rotateZ(matrix, matrix, -this._bearing * Math.PI / 180);
        }
        
        // 4. Apply pitch (3D tilt)
        if (this._pitch !== 0) {
            mat4.rotateX(matrix, matrix, this._pitch * Math.PI / 180);
        }
        
        return matrix;
    }
    
    // Setters that invalidate cache
    setCenter(center) {
        this._center = center;
        this._matrixDirty = true;
    }
    
    setZoom(zoom) {
        this._zoom = zoom;
        this._scale = Math.pow(2, zoom);
        this._matrixDirty = true;
    }
    
    setBearing(bearing) {
        this._bearing = bearing;
        this._matrixDirty = true;
    }
    
    setPitch(pitch) {
        this._pitch = pitch;
        this._matrixDirty = true;
    }
    
    // Viewport management
    resize(width, height) {
        this._viewportWidth = width;
        this._viewportHeight = height;
        this._matrixDirty = true;
    }
    
    // Get current bounds in geographic coordinates
    getBounds() {
        const corners = [
            { x: 0, y: 0 },
            { x: this._viewportWidth, y: 0 },
            { x: this._viewportWidth, y: this._viewportHeight },
            { x: 0, y: this._viewportHeight }
        ];
        
        const lngLatCorners = corners.map(corner => this.screenToLngLat(corner));
        
        const lngs = lngLatCorners.map(c => c.lng);
        const lats = lngLatCorners.map(c => c.lat);
        
        return {
            west: Math.min(...lngs),
            east: Math.max(...lngs),
            south: Math.min(...lats),
            north: Math.max(...lats)
        };
    }
    
    // Getters
    get center() { return this._center; }
    get zoom() { return this._zoom; }
    get bearing() { return this._bearing; }
    get pitch() { return this._pitch; }
    get scale() { return this._scale; }
    get worldSize() { return this._worldSize * this._scale; }
}
```

### 1.2 Event System Refactor

**Create new file: `src/events/EventManager.js`**
```javascript
export class EventManager {
    constructor(target) {
        this.target = target;
        this.handlers = new Map();
        this.active = true;
    }
    
    addHandler(name, handler) {
        if (!this.handlers.has(name)) {
            this.handlers.set(name, []);
        }
        this.handlers.get(name).push(handler);
        
        // Enable handler
        if (handler.enable) {
            handler.enable();
        }
    }
    
    removeHandler(name) {
        const handlerList = this.handlers.get(name);
        if (handlerList) {
            handlerList.forEach(handler => {
                if (handler.disable) {
                    handler.disable();
                }
            });
            this.handlers.delete(name);
        }
    }
    
    handleEvent(event) {
        if (!this.active) return false;
        
        // Find handlers that can process this event
        for (const [name, handlerList] of this.handlers) {
            for (const handler of handlerList) {
                if (handler.handleEvent && handler.handleEvent(event)) {
                    return true; // Event consumed
                }
            }
        }
        
        return false; // Event not consumed
    }
    
    enable() {
        this.active = true;
        this.handlers.forEach(handlerList => {
            handlerList.forEach(handler => {
                if (handler.enable) handler.enable();
            });
        });
    }
    
    disable() {
        this.active = false;
        this.handlers.forEach(handlerList => {
            handlerList.forEach(handler => {
                if (handler.disable) handler.disable();
            });
        });
    }
}

// Base handler class
export class Handler {
    constructor(map, options = {}) {
        this.map = map;
        this.options = options;
        this.enabled = false;
    }
    
    enable() {
        if (this.enabled) return;
        this.enabled = true;
        this.addEventListeners();
    }
    
    disable() {
        if (!this.enabled) return;
        this.enabled = false;
        this.removeEventListeners();
    }
    
    // Override in subclasses
    addEventListeners() {}
    removeEventListeners() {}
    handleEvent(event) { return false; }
}
```

**Create new file: `src/events/PanHandler.js`**
```javascript
import { Handler } from './EventManager.js';

export class PanHandler extends Handler {
    constructor(map, options = {}) {
        super(map, options);
        
        this.isDragging = false;
        this.lastPosition = null;
        this.velocity = { x: 0, y: 0 };
        this.velocityHistory = [];
        this.maxVelocityHistory = 5;
        
        // Bind methods to maintain 'this' context
        this.onMouseDown = this.onMouseDown.bind(this);
        this.onMouseMove = this.onMouseMove.bind(this);
        this.onMouseUp = this.onMouseUp.bind(this);
        this.onTouchStart = this.onTouchStart.bind(this);
        this.onTouchMove = this.onTouchMove.bind(this);
        this.onTouchEnd = this.onTouchEnd.bind(this);
    }
    
    addEventListeners() {
        const canvas = this.map.getCanvas();
        
        // Mouse events
        canvas.addEventListener('mousedown', this.onMouseDown);
        document.addEventListener('mousemove', this.onMouseMove);
        document.addEventListener('mouseup', this.onMouseUp);
        
        // Touch events
        canvas.addEventListener('touchstart', this.onTouchStart, { passive: false });
        canvas.addEventListener('touchmove', this.onTouchMove, { passive: false });
        canvas.addEventListener('touchend', this.onTouchEnd);
    }
    
    removeEventListeners() {
        const canvas = this.map.getCanvas();
        
        canvas.removeEventListener('mousedown', this.onMouseDown);
        document.removeEventListener('mousemove', this.onMouseMove);
        document.removeEventListener('mouseup', this.onMouseUp);
        
        canvas.removeEventListener('touchstart', this.onTouchStart);
        canvas.removeEventListener('touchmove', this.onTouchMove);
        canvas.removeEventListener('touchend', this.onTouchEnd);
    }
    
    onMouseDown(event) {
        if (!this.enabled) return;
        
        this.isDragging = true;
        this.lastPosition = { x: event.clientX, y: event.clientY };
        this.velocity = { x: 0, y: 0 };
        this.velocityHistory = [];
        
        event.preventDefault();
    }
    
    onMouseMove(event) {
        if (!this.enabled || !this.isDragging) return;
        
        const currentPosition = { x: event.clientX, y: event.clientY };
        const delta = {
            x: currentPosition.x - this.lastPosition.x,
            y: currentPosition.y - this.lastPosition.y
        };
        
        // Update velocity tracking
        this.updateVelocity(delta);
        
        // Apply pan transformation
        this.pan(delta);
        
        this.lastPosition = currentPosition;
        event.preventDefault();
    }
    
    onMouseUp(event) {
        if (!this.enabled || !this.isDragging) return;
        
        this.isDragging = false;
        
        // Calculate average velocity for momentum
        const avgVelocity = this.calculateAverageVelocity();
        if (Math.abs(avgVelocity.x) > 1 || Math.abs(avgVelocity.y) > 1) {
            this.startMomentum(avgVelocity);
        }
        
        event.preventDefault();
    }
    
    onTouchStart(event) {
        if (event.touches.length === 1) {
            const touch = event.touches[0];
            this.onMouseDown({
                clientX: touch.clientX,
                clientY: touch.clientY,
                preventDefault: () => event.preventDefault()
            });
        }
    }
    
    onTouchMove(event) {
        if (event.touches.length === 1) {
            const touch = event.touches[0];
            this.onMouseMove({
                clientX: touch.clientX,
                clientY: touch.clientY,
                preventDefault: () => event.preventDefault()
            });
        }
    }
    
    onTouchEnd(event) {
        this.onMouseUp({
            preventDefault: () => event.preventDefault()
        });
    }
    
    updateVelocity(delta) {
        const now = Date.now();
        this.velocityHistory.push({
            delta,
            time: now
        });
        
        // Keep only recent history
        const cutoffTime = now - 100; // 100ms window
        this.velocityHistory = this.velocityHistory.filter(v => v.time > cutoffTime);
        
        if (this.velocityHistory.length > this.maxVelocityHistory) {
            this.velocityHistory.shift();
        }
    }
    
    calculateAverageVelocity() {
        if (this.velocityHistory.length < 2) {
            return { x: 0, y: 0 };
        }
        
        const totalDelta = this.velocityHistory.reduce(
            (sum, v) => ({
                x: sum.x + v.delta.x,
                y: sum.y + v.delta.y
            }),
            { x: 0, y: 0 }
        );
        
        const totalTime = this.velocityHistory[this.velocityHistory.length - 1].time - 
                         this.velocityHistory[0].time;
        
        return {
            x: (totalDelta.x / totalTime) * 1000, // pixels per second
            y: (totalDelta.y / totalTime) * 1000
        };
    }
    
    pan(delta) {
        const transform = this.map.transform;
        const canvas = this.map.getCanvas();
        
        // Convert screen delta to world coordinates
        const currentCenter = transform.center;
        const centerScreen = transform.lngLatToScreen(currentCenter);
        
        const newCenterScreen = {
            x: centerScreen.x - delta.x,
            y: centerScreen.y - delta.y
        };
        
        const newCenter = transform.screenToLngLat(newCenterScreen);
        
        // Apply pan with constraints
        const constrainedCenter = this.applyConstraints(newCenter);
        transform.setCenter(constrainedCenter);
        
        // Fire pan event
        this.map.fire('move');
    }
    
    applyConstraints(center) {
        // Implement world bounds constraints if needed
        const bounds = this.options.bounds;
        if (!bounds) return center;
        
        return {
            lng: Math.max(bounds.west, Math.min(bounds.east, center.lng)),
            lat: Math.max(bounds.south, Math.min(bounds.north, center.lat))
        };
    }
    
    startMomentum(velocity) {
        const deceleration = 2500; // pixels/second²
        const maxDuration = 1400; // milliseconds
        
        const speed = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y);
        const duration = Math.min(speed / deceleration * 1000, maxDuration);
        
        if (duration < 100) return; // Too short to be useful
        
        // Start momentum animation
        this.animateMomentum(velocity, duration);
    }
    
    animateMomentum(initialVelocity, duration) {
        const startTime = Date.now();
        
        const animate = () => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            
            // Quadratic ease out
            const easeProgress = 1 - Math.pow(1 - progress, 2);
            const currentVelocity = {
                x: initialVelocity.x * (1 - easeProgress),
                y: initialVelocity.y * (1 - easeProgress)
            };
            
            if (progress < 1 && this.enabled && !this.isDragging) {
                // Apply momentum pan
                const deltaTime = 16; // Assume 60fps
                const delta = {
                    x: currentVelocity.x * deltaTime / 1000,
                    y: currentVelocity.y * deltaTime / 1000
                };
                
                this.pan(delta);
                requestAnimationFrame(animate);
            }
        };
        
        requestAnimationFrame(animate);
    }
}
```

## Phase 2: Rendering Pipeline Refactor (Weeks 3-4)

### 2.1 Layer-Based Rendering System

**Create new file: `src/render/LayerRenderer.js`**
```javascript
export class LayerRenderer {
    constructor(device, context, format) {
        this.device = device;
        this.context = context;
        this.format = format;
        
        // Render passes
        this.passes = {
            background: new BackgroundPass(device, format),
            fill: new FillPass(device, format),
            line: new LinePass(device, format),
            symbol: new SymbolPass(device, format)
        };
        
        // Render state
        this.renderState = {
            depthBuffer: null,
            colorTarget: null
        };
    }
    
    render(style, transform, tiles) {
        // Create render targets
        this.setupRenderTargets();
        
        const commandEncoder = this.device.createCommandEncoder();
        
        // 1. Background pass
        this.passes.background.render(commandEncoder, style.background);
        
        // 2. Fill layers (opaque first)
        const fillLayers = style.layers.filter(l => l.type === 'fill');
        fillLayers.forEach(layer => {
            this.passes.fill.render(commandEncoder, layer, tiles, transform);
        });
        
        // 3. Line layers
        const lineLayers = style.layers.filter(l => l.type === 'line');
        lineLayers.forEach(layer => {
            this.passes.line.render(commandEncoder, layer, tiles, transform);
        });
        
        // 4. Symbol layers (always on top)
        const symbolLayers = style.layers.filter(l => l.type === 'symbol');
        symbolLayers.forEach(layer => {
            this.passes.symbol.render(commandEncoder, layer, tiles, transform);
        });
        
        this.device.queue.submit([commandEncoder.finish()]);
    }
    
    setupRenderTargets() {
        const canvas = this.context.getCurrentTexture();
        
        // Create depth buffer if needed
        if (!this.renderState.depthBuffer) {
            this.renderState.depthBuffer = this.device.createTexture({
                size: [canvas.width, canvas.height, 1],
                format: 'depth24plus-stencil8',
                usage: GPUTextureUsage.RENDER_ATTACHMENT
            });
        }
        
        this.renderState.colorTarget = canvas;
    }
}

// Base render pass
class RenderPass {
    constructor(device, format) {
        this.device = device;
        this.format = format;
        this.pipeline = null;
        this.bindGroup = null;
    }
    
    createPipeline(vertexShader, fragmentShader, vertexLayout) {
        this.pipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: this.device.createShaderModule({ code: vertexShader }),
                entryPoint: 'main',
                buffers: vertexLayout
            },
            fragment: {
                module: this.device.createShaderModule({ code: fragmentShader }),
                entryPoint: 'main',
                targets: [{ format: this.format }]
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'none'
            },
            depthStencil: {
                depthWriteEnabled: true,
                depthCompare: 'less',
                format: 'depth24plus-stencil8'
            }
        });
    }
}

// Fill layer renderer
class FillPass extends RenderPass {
    constructor(device, format) {
        super(device, format);
        this.createFillPipeline();
    }
    
    createFillPipeline() {
        const vertexShader = `
            struct VertexInput {
                @location(0) position: vec2<f32>,
                @location(1) color: vec4<f32>
            };
            
            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) color: vec4<f32>
            };
            
            @group(0) @binding(0) var<uniform> transform: mat4x4<f32>;
            
            @vertex
            fn main(input: VertexInput) -> VertexOutput {
                var output: VertexOutput;
                output.position = transform * vec4<f32>(input.position, 0.0, 1.0);
                output.color = input.color;
                return output;
            }
        `;
        
        const fragmentShader = `
            @fragment
            fn main(@location(0) color: vec4<f32>) -> @location(0) vec4<f32> {
                return color;
            }
        `;
        
        const vertexLayout = [{
            arrayStride: 24, // 2 * 4 + 4 * 4 = 24 bytes
            attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x2' },
                { shaderLocation: 1, offset: 8, format: 'float32x4' }
            ]
        }];
        
        this.createPipeline(vertexShader, fragmentShader, vertexLayout);
    }
    
    render(commandEncoder, layer, tiles, transform) {
        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: this.renderState.colorTarget.createView(),
                loadOp: 'load',
                storeOp: 'store'
            }],
            depthStencilAttachment: {
                view: this.renderState.depthBuffer.createView(),
                depthLoadOp: 'load',
                depthStoreOp: 'store',
                stencilLoadOp: 'load',
                stencilStoreOp: 'store'
            }
        });
        
        renderPass.setPipeline(this.pipeline);
        
        // Update transform uniform
        const transformBuffer = this.device.createBuffer({
            size: 64,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        this.device.queue.writeBuffer(transformBuffer, 0, transform.getProjectionMatrix());
        
        const bindGroup = this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: transformBuffer } }]
        });
        
        renderPass.setBindGroup(0, bindGroup);
        
        // Render each tile that has this layer type
        tiles.forEach(tile => {
            const bucket = tile.getBucket(layer.id);
            if (bucket) {
                this.renderBucket(renderPass, bucket);
            }
        });
        
        renderPass.end();
    }
    
    renderBucket(renderPass, bucket) {
        renderPass.setVertexBuffer(0, bucket.vertexBuffer);
        renderPass.setIndexBuffer(bucket.indexBuffer, 'uint16');
        renderPass.drawIndexed(bucket.indexCount);
    }
}
```

### 2.2 Shader Program Management

**Create new file: `src/render/ShaderManager.js`**
```javascript
export class ShaderManager {
    constructor(device) {
        this.device = device;
        this.programs = new Map();
        this.shaderModules = new Map();
    }
    
    // Create and cache shader module
    createShaderModule(name, code) {
        if (this.shaderModules.has(name)) {
            return this.shaderModules.get(name);
        }
        
        const module = this.device.createShaderModule({ code });
        this.shaderModules.set(name, module);
        return module;
    }
    
    // Create render pipeline with caching
    createRenderPipeline(name, descriptor) {
        if (this.programs.has(name)) {
            return this.programs.get(name);
        }
        
        const pipeline = this.device.createRenderPipeline(descriptor);
        this.programs.set(name, pipeline);
        return pipeline;
    }
    
    // Get cached pipeline
    getPipeline(name) {
        return this.programs.get(name);
    }
    
    // Preload common shaders
    async preloadShaders() {
        const shaders = {
            fillVertex: this.getFillVertexShader(),
            fillFragment: this.getFillFragmentShader(),
            lineVertex: this.getLineVertexShader(),
            lineFragment: this.getLineFragmentShader(),
            symbolVertex: this.getSymbolVertexShader(),
            symbolFragment: this.getSymbolFragmentShader()
        };
        
        for (const [name, code] of Object.entries(shaders)) {
            this.createShaderModule(name, code);
        }
    }
    
    getFillVertexShader() {
        return `
            struct VertexInput {
                @location(0) position: vec2<f32>,
                @location(1) color: vec4<f32>,
                @location(2) opacity: f32
            };
            
            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) color: vec4<f32>,
                @location(1) opacity: f32
            };
            
            struct Uniforms {
                transform: mat4x4<f32>,
                zoom: f32,
                devicePixelRatio: f32
            };
            
            @group(0) @binding(0) var<uniform> uniforms: Uniforms;
            
            @vertex
            fn main(input: VertexInput) -> VertexOutput {
                var output: VertexOutput;
                output.position = uniforms.transform * vec4<f32>(input.position, 0.0, 1.0);
                output.color = input.color;
                output.opacity = input.opacity;
                return output;
            }
        `;
    }
    
    getFillFragmentShader() {
        return `
            struct FragmentInput {
                @location(0) color: vec4<f32>,
                @location(1) opacity: f32
            };
            
            @fragment
            fn main(input: FragmentInput) -> @location(0) vec4<f32> {
                return vec4<f32>(input.color.rgb, input.color.a * input.opacity);
            }
        `;
    }
    
    getLineVertexShader() {
        return `
            struct VertexInput {
                @location(0) position: vec2<f32>,
                @location(1) normal: vec2<f32>,
                @location(2) width: f32,
                @location(3) color: vec4<f32>
            };
            
            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) color: vec4<f32>
            };
            
            @group(0) @binding(0) var<uniform> transform: mat4x4<f32>;
            @group(0) @binding(1) var<uniform> lineWidth: f32;
            
            @vertex
            fn main(input: VertexInput) -> VertexOutput {
                // Extrude line by width along normal
                let extrudedPos = input.position + input.normal * input.width * lineWidth;
                
                var output: VertexOutput;
                output.position = transform * vec4<f32>(extrudedPos, 0.0, 1.0);
                output.color = input.color;
                return output;
            }
        `;
    }
    
    getLineFragmentShader() {
        return `
            @fragment
            fn main(@location(0) color: vec4<f32>) -> @location(0) vec4<f32> {
                return color;
            }
        `;
    }
    
    getSymbolVertexShader() {
        return `
            struct VertexInput {
                @location(0) position: vec2<f32>,
                @location(1) texCoord: vec2<f32>,
                @location(2) offset: vec2<f32>
            };
            
            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) texCoord: vec2<f32>
            };
            
            @group(0) @binding(0) var<uniform> transform: mat4x4<f32>;
            
            @vertex
            fn main(input: VertexInput) -> VertexOutput {
                let offsetPos = input.position + input.offset;
                
                var output: VertexOutput;
                output.position = transform * vec4<f32>(offsetPos, 0.0, 1.0);
                output.texCoord = input.texCoord;
                return output;
            }
        `;
    }
    
    getSymbolFragmentShader() {
        return `
            @group(1) @binding(0) var symbolTexture: texture_2d<f32>;
            @group(1) @binding(1) var symbolSampler: sampler;
            
            @fragment
            fn main(@location(0) texCoord: vec2<f32>) -> @location(0) vec4<f32> {
                return textureSample(symbolTexture, symbolSampler, texCoord);
            }
        `;
    }
}
```

## Phase 3: Style System Implementation (Month 2)

### 3.1 Style Specification Support

**Create new file: `src/style/Style.js`**
```javascript
export class Style {
    constructor(styleSpec) {
        this.version = styleSpec.version || 8;
        this.sources = new Map();
        this.layers = [];
        this.sprites = null;
        this.glyphs = null;
        
        this.loadStyle(styleSpec);
    }
    
    loadStyle(styleSpec) {
        // Load sources
        if (styleSpec.sources) {
            for (const [id, sourceSpec] of Object.entries(styleSpec.sources)) {
                this.addSource(id, sourceSpec);
            }
        }
        
        // Load layers
        if (styleSpec.layers) {
            styleSpec.layers.forEach(layerSpec => {
                this.addLayer(layerSpec);
            });
        }
        
        // Load sprites and glyphs
        this.sprites = styleSpec.sprite;
        this.glyphs = styleSpec.glyphs;
    }
    
    addSource(id, sourceSpec) {
        const source = this.createSource(sourceSpec);
        this.sources.set(id, source);
        return source;
    }
    
    createSource(sourceSpec) {
        switch (sourceSpec.type) {
            case 'vector':
                return new VectorSource(sourceSpec);
            case 'raster':
                return new RasterSource(sourceSpec);
            case 'geojson':
                return new GeoJSONSource(sourceSpec);
            default:
                throw new Error(`Unknown source type: ${sourceSpec.type}`);
        }
    }
    
    addLayer(layerSpec, beforeId) {
        const layer = this.createLayer(layerSpec);
        
        if (beforeId) {
            const beforeIndex = this.layers.findIndex(l => l.id === beforeId);
            this.layers.splice(beforeIndex, 0, layer);
        } else {
            this.layers.push(layer);
        }
        
        return layer;
    }
    
    createLayer(layerSpec) {
        switch (layerSpec.type) {
            case 'fill':
                return new FillLayer(layerSpec);
            case 'line':
                return new LineLayer(layerSpec);
            case 'symbol':
                return new SymbolLayer(layerSpec);
            case 'circle':
                return new CircleLayer(layerSpec);
            case 'background':
                return new BackgroundLayer(layerSpec);
            default:
                throw new Error(`Unknown layer type: ${layerSpec.type}`);
        }
    }
    
    getLayer(id) {
        return this.layers.find(layer => layer.id === id);
    }
    
    removeLayer(id) {
        const index = this.layers.findIndex(layer => layer.id === id);
        if (index !== -1) {
            return this.layers.splice(index, 1)[0];
        }
    }
    
    getSource(id) {
        return this.sources.get(id);
    }
    
    removeSource(id) {
        const source = this.sources.get(id);
        if (source) {
            this.sources.delete(id);
            // Remove layers using this source
            this.layers = this.layers.filter(layer => layer.source !== id);
        }
        return source;
    }
    
    // Evaluate style for rendering
    evaluateLayer(layer, zoom, feature) {
        const paint = this.evaluatePaintProperties(layer, zoom, feature);
        const layout = this.evaluateLayoutProperties(layer, zoom, feature);
        
        return {
            ...layer,
            paint,
            layout
        };
    }
    
    evaluatePaintProperties(layer, zoom, feature) {
        const paint = {};
        
        for (const [property, value] of Object.entries(layer.paint || {})) {
            paint[property] = this.evaluateProperty(value, zoom, feature);
        }
        
        return paint;
    }
    
    evaluateLayoutProperties(layer, zoom, feature) {
        const layout = {};
        
        for (const [property, value] of Object.entries(layer.layout || {})) {
            layout[property] = this.evaluateProperty(value, zoom, feature);
        }
        
        return layout;
    }
    
    evaluateProperty(value, zoom, feature) {
        if (typeof value === 'object' && value !== null) {
            // Handle expressions, stops, etc.
            if (Array.isArray(value)) {
                // Expression format
                return this.evaluateExpression(value, zoom, feature);
            } else if (value.stops) {
                // Legacy stops format
                return this.evaluateStops(value.stops, zoom);
            }
        }
        
        return value;
    }
    
    evaluateExpression(expression, zoom, feature) {
        const [operator, ...args] = expression;
        
        switch (operator) {
            case 'interpolate':
                return this.evaluateInterpolate(args, zoom);
            case 'step':
                return this.evaluateStep(args, zoom);
            case 'case':
                return this.evaluateCase(args, zoom, feature);
            case 'get':
                return feature.properties[args[0]];
            case 'zoom':
                return zoom;
            default:
                return expression;
        }
    }
    
    evaluateInterpolate([interpolation, input, ...stops], zoom) {
        const inputValue = this.evaluateProperty(input, zoom);
        
        // Find the stops that bracket the input value
        for (let i = 0; i < stops.length - 2; i += 2) {
            const stop1 = stops[i];
            const value1 = stops[i + 1];
            const stop2 = stops[i + 2];
            const value2 = stops[i + 3];
            
            if (inputValue >= stop1 && inputValue <= stop2) {
                const progress = (inputValue - stop1) / (stop2 - stop1);
                
                if (interpolation[0] === 'linear') {
                    if (typeof value1 === 'number' && typeof value2 === 'number') {
                        return value1 + (value2 - value1) * progress;
                    }
                }
                
                return value1; // Fallback
            }
        }
        
        // Return first or last value if outside range
        return inputValue < stops[0] ? stops[1] : stops[stops.length - 1];
    }
    
    evaluateStops(stops, zoom) {
        for (let i = 0; i < stops.length - 1; i++) {
            if (zoom >= stops[i][0] && zoom < stops[i + 1][0]) {
                return stops[i][1];
            }
        }
        
        return stops[stops.length - 1][1];
    }
}

// Base layer class
class Layer {
    constructor(spec) {
        this.id = spec.id;
        this.type = spec.type;
        this.source = spec.source;
        this.sourceLayer = spec['source-layer'];
        this.layout = spec.layout || {};
        this.paint = spec.paint || {};
        this.filter = spec.filter;
        this.minzoom = spec.minzoom || 0;
        this.maxzoom = spec.maxzoom || 24;
    }
    
    isVisible(zoom) {
        return zoom >= this.minzoom && zoom < this.maxzoom;
    }
    
    matchesFilter(feature) {
        if (!this.filter) return true;
        return this.evaluateFilter(this.filter, feature);
    }
    
    evaluateFilter(filter, feature) {
        // Implement filter evaluation logic
        // This is a simplified version
        const [operator, ...args] = filter;
        
        switch (operator) {
            case '==':
                return feature.properties[args[0]] === args[1];
            case '!=':
                return feature.properties[args[0]] !== args[1];
            case 'in':
                return args.slice(1).includes(feature.properties[args[0]]);
            case 'all':
                return args.every(subFilter => this.evaluateFilter(subFilter, feature));
            case 'any':
                return args.some(subFilter => this.evaluateFilter(subFilter, feature));
            default:
                return true;
        }
    }
}

// Specific layer types
class FillLayer extends Layer {
    constructor(spec) {
        super(spec);
        this.type = 'fill';
    }
}

class LineLayer extends Layer {
    constructor(spec) {
        super(spec);
        this.type = 'line';
    }
}

class SymbolLayer extends Layer {
    constructor(spec) {
        super(spec);
        this.type = 'symbol';
    }
}
```

This roadmap provides a systematic approach to bringing your Map Active Work project up to MapLibre industry standards. Each phase builds upon the previous one, allowing you to maintain your innovative GPU acceleration while adding the sophisticated architecture that professional mapping libraries require.

The key is to implement these changes incrementally, testing each component as you go, and preserving the GPU acceleration work that makes your project unique.