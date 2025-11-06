// Mathematics utilities for WebGPU mapping system
// Provides matrix operations, polygon triangulation, and geometric calculations

import { mat4, vec3, vec2 } from 'gl-matrix';
import earcut from 'earcut';
import type { LngLat } from '../types/core';

/**
 * Matrix utilities for 3D transformations in WebGPU
 */
export const MatrixUtils = {
  /**
   * Create a perspective projection matrix
   */
  createPerspectiveMatrix(
    fovy: number,
    aspect: number,
    near: number,
    far: number
  ): Float32Array {
    const out = mat4.create();
    mat4.perspective(out, fovy, aspect, near, far);
    return new Float32Array(out);
  },

  /**
   * Create a view matrix from position, target, and up vector
   */
  createViewMatrix(
    eye: vec3,
    center: vec3,
    up: vec3
  ): Float32Array {
    const out = mat4.create();
    mat4.lookAt(out, eye, center, up);
    return new Float32Array(out);
  },

  /**
   * Create an orthographic projection matrix
   */
  createOrthographicMatrix(
    left: number,
    right: number,
    bottom: number,
    top: number,
    near: number,
    far: number
  ): Float32Array {
    const out = mat4.create();
    mat4.ortho(out, left, right, bottom, top, near, far);
    return new Float32Array(out);
  },

  /**
   * Create a transformation matrix for map projection
   */
  createMapTransformMatrix(
    centerX: number,
    centerY: number,
    zoom: number,
    bearing: number,
    pitch: number,
    aspectRatio: number
  ): Float32Array {
    const scale = Math.pow(2, zoom);
    const bearingRad = (bearing * Math.PI) / 180;
    const pitchRad = (pitch * Math.PI) / 180;

    // Create transformation matrix
    const transform = mat4.create();
    
    // Apply transformations in order: scale, rotate (bearing), tilt (pitch)
    mat4.translate(transform, transform, [centerX, centerY, 0]);
    mat4.scale(transform, transform, [scale, scale * aspectRatio, 1]);
    mat4.rotateZ(transform, transform, bearingRad);
    mat4.rotateX(transform, transform, pitchRad);

    return new Float32Array(transform);
  },

  /**
   * Multiply two 4x4 matrices
   */
  multiplyMatrices(a: Float32Array, b: Float32Array): Float32Array {
    const out = mat4.create();
    mat4.multiply(out, a as mat4, b as mat4);
    return new Float32Array(out);
  },

  /**
   * Invert a 4x4 matrix
   */
  invertMatrix(matrix: Float32Array): Float32Array | null {
    const out = mat4.create();
    const result = mat4.invert(out, matrix as mat4);
    return result ? new Float32Array(out) : null;
  }
};

/**
 * Polygon triangulation utilities using Earcut
 */
export const TriangulationUtils = {
  /**
   * Triangulate a polygon with holes using Earcut
   */
  triangulatePolygon(
    vertices: LngLat[],
    holes?: LngLat[][]
  ): {
    triangles: number[];
    vertices: Float32Array;
    vertexCount: number;
  } {
    // Flatten coordinates for Earcut
    const flatVertices: number[] = [];
    const holeIndices: number[] = [];
    
    // Add main polygon vertices
    for (const vertex of vertices) {
      flatVertices.push(vertex.lng, vertex.lat);
    }
    
    // Add hole vertices and track hole starts
    if (holes) {
      for (const hole of holes) {
        holeIndices.push(flatVertices.length / 2);
        for (const vertex of hole) {
          flatVertices.push(vertex.lng, vertex.lat);
        }
      }
    }
    
    // Triangulate using Earcut
    const triangles = earcut(flatVertices, holeIndices.length > 0 ? holeIndices : undefined, 2);
    
    return {
      triangles,
      vertices: new Float32Array(flatVertices),
      vertexCount: flatVertices.length / 2
    };
  },

  /**
   * Create triangle strip from polygon outline
   */
  createLineStrip(vertices: LngLat[], width: number = 1): {
    triangles: number[];
    vertices: Float32Array;
  } {
    const stripVertices: number[] = [];
    const triangles: number[] = [];
    
    for (let i = 0; i < vertices.length; i++) {
      const curr = vertices[i];
      const next = vertices[(i + 1) % vertices.length];
      
      // Calculate perpendicular for line width
      const dx = next.lng - curr.lng;
      const dy = next.lat - curr.lat;
      const length = Math.sqrt(dx * dx + dy * dy);
      
      if (length > 0) {
        const perpX = (-dy / length) * width * 0.5;
        const perpY = (dx / length) * width * 0.5;
        
        // Add vertices for both sides of the line
        stripVertices.push(
          curr.lng + perpX, curr.lat + perpY,  // Top
          curr.lng - perpX, curr.lat - perpY   // Bottom
        );
        
        // Create triangles for the strip
        if (i < vertices.length - 1) {
          const baseIndex = i * 2;
          triangles.push(
            baseIndex, baseIndex + 1, baseIndex + 2,
            baseIndex + 1, baseIndex + 3, baseIndex + 2
          );
        }
      }
    }
    
    return {
      triangles,
      vertices: new Float32Array(stripVertices)
    };
  }
};

/**
 * WebGPU-specific mathematical utilities
 */
export const WebGPUMathUtils = {
  /**
   * Create uniform buffer data for transformation matrices
   */
  createTransformUniformData(
    projectionMatrix: Float32Array,
    viewMatrix: Float32Array,
    modelMatrix: Float32Array
  ): Float32Array {
    // Create 16 + 16 + 16 floats for the three 4x4 matrices
    const uniformData = new Float32Array(48);
    
    uniformData.set(projectionMatrix, 0);
    uniformData.set(viewMatrix, 16);
    uniformData.set(modelMatrix, 32);
    
    return uniformData;
  },

  /**
   * Pack color values for WebGPU shaders
   */
  packColor(r: number, g: number, b: number, a: number = 1): Float32Array {
    return new Float32Array([
      Math.max(0, Math.min(1, r)),
      Math.max(0, Math.min(1, g)),
      Math.max(0, Math.min(1, b)),
      Math.max(0, Math.min(1, a))
    ]);
  },

  /**
   * Calculate optimal buffer sizes with alignment
   */
  calculateBufferSize(dataSize: number, alignment: number = 256): number {
    return Math.ceil(dataSize / alignment) * alignment;
  }
};

// Export all utilities as a combined object
export const MathUtils = {
  Matrix: MatrixUtils,
  Triangulation: TriangulationUtils,
  WebGPU: WebGPUMathUtils
};