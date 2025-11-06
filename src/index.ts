// Main entry point for the Map Active Work TypeScript project
// Exports all core functionality for the WebGPU mapping system

// Core type definitions
export type {
  LngLat,
  Point,
  ClipCoordinates,
  WorldCoordinates,
  LngLatBounds,
  ScreenBounds,
  GeometryType,
  Feature,
  PolygonFeature,
  PointFeature,
  LineStringFeature,
  Geometry,
  MapTransform,
  TransformOptions,
  WebGPUContext,
  GPUBufferConfig,
  GPUTextureConfig,
  RenderPipelineConfig,
  ComputePipelineConfig,
  PickingResult,
  HiddenBufferConfig,
  TranslationLayerConfig,
  AnimationConfig,
  ViewChangeOptions,
  MapEventType,
  MapEvent,
  MapErrorType,
  MapError,
  PerformanceMetrics,
  CoordinateSpace,
  TypedCoordinate,
  DeepPartial,
  ReadonlyDeep
} from './types/core';

// Import types for use in utility functions
import type { LngLat, MapError, MapErrorType } from './types/core';

// Translation layer
export {
  WebGPUTranslationLayer,
  type TranslationResult,
  type BatchTranslationResult
} from './core/translation/WebGPUTranslationLayer';

// Hidden buffer integration
export {
  HiddenBufferIntegration,
  type TranslatedFeature,
  type RenderStatistics,
  type ColorRGBA
} from './core/translation/HiddenBufferIntegration';

// Examples and utilities
export {
  MapRenderer,
  YourExistingSystemIntegration,
  exampleUsage,
  checkWebGPUSupport,
  type MapRendererConfig,
  type LegacyCoordinate,
  type LegacyFeature
} from './examples/TranslationLayerExample';

// Utility functions for coordinate conversion
export const CoordinateUtils = {
  /**
   * Convert degrees to radians
   */
  degToRad(degrees: number): number {
    return degrees * Math.PI / 180;
  },

  /**
   * Convert radians to degrees
   */
  radToDeg(radians: number): number {
    return radians * 180 / Math.PI;
  },

  /**
   * Calculate distance between two geographic points using Haversine formula
   */
  distanceHaversine(point1: LngLat, point2: LngLat): number {
    const R = 6371000; // Earth radius in meters
    const lat1Rad = this.degToRad(point1.lat);
    const lat2Rad = this.degToRad(point2.lat);
    const deltaLatRad = this.degToRad(point2.lat - point1.lat);
    const deltaLngRad = this.degToRad(point2.lng - point1.lng);

    const a = Math.sin(deltaLatRad / 2) * Math.sin(deltaLatRad / 2) +
              Math.cos(lat1Rad) * Math.cos(lat2Rad) *
              Math.sin(deltaLngRad / 2) * Math.sin(deltaLngRad / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  },

  /**
   * Calculate bearing between two geographic points
   */
  bearing(point1: LngLat, point2: LngLat): number {
    const lat1Rad = this.degToRad(point1.lat);
    const lat2Rad = this.degToRad(point2.lat);
    const deltaLngRad = this.degToRad(point2.lng - point1.lng);

    const y = Math.sin(deltaLngRad) * Math.cos(lat2Rad);
    const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) -
              Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(deltaLngRad);

    return this.radToDeg(Math.atan2(y, x));
  },

  /**
   * Validate LngLat coordinates
   */
  isValidLngLat(coord: LngLat): boolean {
    return coord.lng >= -180 && coord.lng <= 180 &&
           coord.lat >= -90 && coord.lat <= 90;
  },

  /**
   * Clamp LngLat coordinates to valid ranges
   */
  clampLngLat(coord: LngLat): LngLat {
    return {
      lng: Math.max(-180, Math.min(180, coord.lng)),
      lat: Math.max(-90, Math.min(90, coord.lat))
    };
  }
};

// WebGPU utility functions
export const WebGPUUtils = {
  /**
   * Check if WebGPU is supported
   */
  isSupported(): boolean {
    return 'gpu' in navigator;
  },

  /**
   * Get optimal buffer size (aligned to 4 bytes)
   */
  getAlignedBufferSize(size: number): number {
    return Math.ceil(size / 4) * 4;
  },

  /**
   * Create a simple vertex buffer with position and color
   */
  createVertexBuffer(
    device: GPUDevice,
    vertices: Float32Array,
    label?: string
  ): GPUBuffer {
    const buffer = device.createBuffer({
      label: label ?? 'Vertex Buffer',
      size: this.getAlignedBufferSize(vertices.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true
    });

    new Float32Array(buffer.getMappedRange()).set(vertices);
    buffer.unmap();

    return buffer;
  },

  /**
   * Create a uniform buffer
   */
  createUniformBuffer(
    device: GPUDevice,
    data: Float32Array,
    label?: string
  ): GPUBuffer {
    const buffer = device.createBuffer({
      label: label ?? 'Uniform Buffer',
      size: this.getAlignedBufferSize(data.byteLength),
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true
    });

    new Float32Array(buffer.getMappedRange()).set(data);
    buffer.unmap();

    return buffer;
  }
};

// Performance monitoring utilities
export const PerformanceMonitor = {
  /**
   * Create a performance timer
   */
  createTimer(label: string) {
    const startTime = performance.now();
    return {
      end(): number {
        const endTime = performance.now();
        const duration = endTime - startTime;
        console.log(`${label}: ${duration.toFixed(2)}ms`);
        return duration;
      }
    };
  },

  /**
   * Monitor frame rate
   */
  createFPSMonitor() {
    let frameCount = 0;
    let lastTime = performance.now();

    return {
      tick(): number {
        frameCount++;
        const currentTime = performance.now();
        
        if (currentTime - lastTime >= 1000) {
          const fps = frameCount;
          frameCount = 0;
          lastTime = currentTime;
          return fps;
        }
        
        return 0; // No update this frame
      }
    };
  }
};

// Error handling utilities
export const ErrorUtils = {
  /**
   * Create a typed map error
   */
  createMapError(type: MapErrorType, message: string, context?: Record<string, unknown>): MapError {
    const error = new Error(message) as MapError;
    error.type = type;
    error.context = context;
    return error;
  },

  /**
   * Check if an error is a map error
   */
  isMapError(error: unknown): error is MapError {
    return error instanceof Error && 'type' in error;
  }
};