// Core type definitions for the Map Active Work project
// These types provide the foundation for the entire mapping system

/**
 * Geographic coordinate representation (WGS84)
 */
export interface LngLat {
  /** Longitude in degrees [-180, 180] */
  lng: number;
  /** Latitude in degrees [-90, 90] */
  lat: number;
}

/**
 * Screen/pixel coordinate representation
 */
export interface Point {
  /** X coordinate in pixels */
  x: number;
  /** Y coordinate in pixels */
  y: number;
}

/**
 * WebGPU clip space coordinates
 */
export interface ClipCoordinates {
  /** X coordinate in clip space [-1, 1] */
  x: number;
  /** Y coordinate in clip space [-1, 1] */
  y: number;
}

/**
 * World coordinates (normalized [0,1] space at zoom 0)
 */
export interface WorldCoordinates {
  /** X coordinate in world space [0, 1] */
  x: number;
  /** Y coordinate in world space [0, 1] */
  y: number;
}

/**
 * Bounding box in geographic coordinates
 */
export interface LngLatBounds {
  /** Western boundary */
  west: number;
  /** Southern boundary */
  south: number;
  /** Eastern boundary */
  east: number;
  /** Northern boundary */
  north: number;
}

/**
 * Bounding box in screen coordinates
 */
export interface ScreenBounds {
  /** Left boundary */
  left: number;
  /** Top boundary */
  top: number;
  /** Right boundary */
  right: number;
  /** Bottom boundary */
  bottom: number;
}

/**
 * Geometric feature types
 */
export type GeometryType = 'point' | 'linestring' | 'polygon' | 'multipoint' | 'multilinestring' | 'multipolygon';

/**
 * Generic feature interface
 */
export interface Feature<T = Record<string, unknown>, G extends GeometryType = GeometryType> {
  /** Unique feature identifier */
  id: string;
  /** Feature geometry */
  geometry: Geometry<G>;
  /** Feature properties */
  properties: T;
  /** Geometry type */
  type: G;
}

/**
 * Geometry definitions for different types
 */
export type Geometry<T extends GeometryType = GeometryType> = 
  T extends 'point' ? LngLat :
  T extends 'linestring' ? LngLat[] :
  T extends 'polygon' ? LngLat[][] :
  T extends 'multipoint' ? LngLat[] :
  T extends 'multilinestring' ? LngLat[][] :
  T extends 'multipolygon' ? LngLat[][][] :
  LngLat[];

/**
 * Polygon-specific feature
 */
export interface PolygonFeature<T = Record<string, unknown>> extends Feature<T, 'polygon'> {
  geometry: LngLat[][]; // [exterior, ...holes]
}

/**
 * Point-specific feature
 */
export interface PointFeature<T = Record<string, unknown>> extends Feature<T, 'point'> {
  geometry: LngLat;
}

/**
 * LineString-specific feature
 */
export interface LineStringFeature<T = Record<string, unknown>> extends Feature<T, 'linestring'> {
  geometry: LngLat[];
}

/**
 * Transform/camera state
 */
export interface MapTransform {
  /** Map center in geographic coordinates */
  center: LngLat;
  /** Zoom level */
  zoom: number;
  /** Bearing/rotation in degrees */
  bearing: number;
  /** Pitch/tilt in degrees */
  pitch: number;
}

/**
 * Transform options for updates
 */
export interface TransformOptions extends Partial<MapTransform> {
  /** Canvas dimensions */
  width?: number;
  /** Canvas dimensions */
  height?: number;
}

/**
 * WebGPU context wrapper
 */
export interface WebGPUContext {
  /** WebGPU device */
  device: GPUDevice;
  /** Canvas element */
  canvas: HTMLCanvasElement;
  /** Canvas context */
  context: GPUCanvasContext;
  /** Preferred texture format */
  format: GPUTextureFormat;
}

/**
 * GPU buffer configuration
 */
export interface GPUBufferConfig {
  /** Buffer label for debugging */
  label?: string;
  /** Buffer size in bytes */
  size: number;
  /** Buffer usage flags */
  usage: GPUBufferUsage;
  /** Initial data */
  data?: BufferSource;
  /** Create mapped */
  mappedAtCreation?: boolean;
}

/**
 * GPU texture configuration
 */
export interface GPUTextureConfig {
  /** Texture label for debugging */
  label?: string;
  /** Texture dimensions */
  size: GPUExtent3D;
  /** Texture format */
  format: GPUTextureFormat;
  /** Texture usage flags */
  usage: GPUTextureUsage;
  /** Mip level count */
  mipLevelCount?: number;
  /** Sample count for multisampling */
  sampleCount?: number;
}

/**
 * Render pipeline configuration
 */
export interface RenderPipelineConfig {
  /** Pipeline label */
  label?: string;
  /** Vertex shader */
  vertexShader: string;
  /** Fragment shader */
  fragmentShader: string;
  /** Vertex buffer layouts */
  vertexBuffers?: GPUVertexBufferLayout[];
  /** Render targets */
  targets?: GPUColorTargetState[];
  /** Depth stencil state */
  depthStencil?: GPUDepthStencilState;
  /** Primitive state */
  primitive?: GPUPrimitiveState;
}

/**
 * Compute pipeline configuration
 */
export interface ComputePipelineConfig {
  /** Pipeline label */
  label?: string;
  /** Compute shader */
  computeShader: string;
  /** Workgroup size */
  workgroupSize?: [number, number?, number?];
}

/**
 * Feature picking result
 */
export interface PickingResult<T = Record<string, unknown>> {
  /** Picked feature */
  feature: Feature<T>;
  /** Screen coordinates where picked */
  screenPoint: Point;
  /** World coordinates */
  worldCoordinates: LngLat;
  /** Distance from pick point (for sorting) */
  distance?: number;
}

/**
 * Hidden buffer configuration
 */
export interface HiddenBufferConfig {
  /** Buffer width */
  width: number;
  /** Buffer height */
  height: number;
  /** Texture format for feature IDs */
  featureIdFormat: GPUTextureFormat;
  /** Texture format for depth */
  depthFormat?: GPUTextureFormat;
  /** Enable multi-target rendering */
  enableMultiTarget?: boolean;
  /** Enable depth testing */
  enableDepthTest?: boolean;
}

/**
 * Translation layer configuration
 */
export interface TranslationLayerConfig {
  /** Cache size for coordinate transformations */
  cacheSize?: number;
  /** Batch size for GPU operations */
  batchSize?: number;
  /** Enable GPU compute shaders */
  enableCompute?: boolean;
  /** Precision settings */
  precision?: {
    /** Precision threshold for reference point updates */
    threshold?: number;
    /** Use high precision calculations */
    useHighPrecision?: boolean;
  };
}

/**
 * Animation/easing configuration
 */
export interface AnimationConfig {
  /** Animation duration in milliseconds */
  duration: number;
  /** Easing function */
  easing?: (t: number) => number;
  /** Animation delay */
  delay?: number;
}

/**
 * Map view change options
 */
export interface ViewChangeOptions extends AnimationConfig {
  /** Target transform state */
  transform: Partial<MapTransform>;
  /** Padding around bounds */
  padding?: number;
  /** Maximum zoom level */
  maxZoom?: number;
  /** Minimum zoom level */
  minZoom?: number;
}

/**
 * Event types for map interactions
 */
export type MapEventType = 
  | 'click'
  | 'dblclick'
  | 'mousedown'
  | 'mouseup'
  | 'mousemove'
  | 'mouseenter'
  | 'mouseleave'
  | 'wheel'
  | 'touchstart'
  | 'touchmove'
  | 'touchend'
  | 'resize'
  | 'zoom'
  | 'rotate'
  | 'pitch'
  | 'move';

/**
 * Map event data
 */
export interface MapEvent {
  /** Event type */
  type: MapEventType;
  /** Original DOM event */
  originalEvent: Event;
  /** Geographic coordinates */
  lngLat: LngLat;
  /** Screen coordinates */
  point: Point;
  /** Current map transform */
  target: MapTransform;
  /** Prevent default behavior */
  preventDefault(): void;
}

/**
 * Error types for the mapping system
 */
export type MapErrorType = 
  | 'webgpu-not-supported'
  | 'device-creation-failed'
  | 'shader-compilation-failed'
  | 'buffer-creation-failed'
  | 'texture-creation-failed'
  | 'coordinate-conversion-failed'
  | 'feature-rendering-failed'
  | 'picking-failed';

/**
 * Map error interface
 */
export interface MapError extends Error {
  /** Error type */
  type: MapErrorType;
  /** Additional error context */
  context?: Record<string, unknown>;
}

/**
 * Performance metrics
 */
export interface PerformanceMetrics {
  /** Frames per second */
  fps: number;
  /** Frame time in milliseconds */
  frameTime: number;
  /** GPU memory usage in bytes */
  gpuMemoryUsage: number;
  /** Number of rendered features */
  featureCount: number;
  /** Cache hit ratio */
  cacheHitRatio: number;
  /** Translation operations per frame */
  translationsPerFrame: number;
}

/**
 * Utility type for making properties optional recursively
 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

/**
 * Utility type for readonly properties
 */
export type ReadonlyDeep<T> = {
  readonly [P in keyof T]: T[P] extends object ? ReadonlyDeep<T[P]> : T[P];
};

/**
 * Coordinate system type safety
 */
export const enum CoordinateSpace {
  Geographic = 'geographic',
  World = 'world',
  Screen = 'screen',
  Clip = 'clip'
}

/**
 * Type-safe coordinate with space annotation
 */
export interface TypedCoordinate<T extends CoordinateSpace> {
  space: T;
  coordinates: T extends CoordinateSpace.Geographic ? LngLat :
                T extends CoordinateSpace.World ? WorldCoordinates :
                T extends CoordinateSpace.Screen ? Point :
                T extends CoordinateSpace.Clip ? ClipCoordinates :
                never;
}