// Mathematics utilities for WebGPU mapping system
// Provides matrix operations, polygon triangulation, and geometric calculations

import { mat4, vec3, vec2 } from 'gl-matrix';
import earcut from 'earcut';
import type { LngLat, Point, ClipCoordinates } from '../types/core';

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
   * Convert lng/lat to normalized world coordinates
   */
  lngLatToWorld(lng: number, lat: number): { x: number; y: number } {
    const x = (lng + 180) / 360;
    const latRad = Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180;
    const y = (1 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI) / 2;
    return { x, y };
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
  },

  /**
   * Transform a point by a matrix
   */
  transformPoint(matrix: Float32Array, point: [number, number, number, number]): Float32Array {
    const out = vec3.create();
    vec3.transformMat4(out, [point[0], point[1], point[2]], matrix as mat4);
    return new Float32Array([out[0], out[1], out[2], point[3]]);
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
   * Triangulate multiple polygons
   */
  triangulatePolygons(polygons: { vertices: LngLat[]; holes?: LngLat[][] }[]): {
    triangles: number[];
    vertices: Float32Array;
    offsets: number[];
  } {
    const allTriangles: number[] = [];
    const allVertices: number[] = [];
    const offsets: number[] = [0];
    
    let vertexOffset = 0;
    
    for (const polygon of polygons) {
      const result = this.triangulatePolygon(polygon.vertices, polygon.holes);
      
      // Adjust triangle indices by current vertex offset
      const adjustedTriangles = result.triangles.map(index => index + vertexOffset);
      allTriangles.push(...adjustedTriangles);
      
      // Add vertices
      allVertices.push(...Array.from(result.vertices));
      
      // Update offset
      vertexOffset += result.vertexCount;
      offsets.push(allTriangles.length);
    }
    
    return {
      triangles: allTriangles,
      vertices: new Float32Array(allVertices),
      offsets
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
 * Geometric calculation utilities
 */
export const GeometryUtils = {
  /**
   * Calculate the area of a polygon using the shoelace formula
   */
  calculatePolygonArea(vertices: LngLat[]): number {
    if (vertices.length < 3) return 0;
    
    let area = 0;
    for (let i = 0; i < vertices.length; i++) {
      const j = (i + 1) % vertices.length;
      area += vertices[i].lng * vertices[j].lat;
      area -= vertices[j].lng * vertices[i].lat;
    }
    
    return Math.abs(area) / 2;
  },

  /**
   * Calculate the centroid of a polygon
   */
  calculatePolygonCentroid(vertices: LngLat[]): LngLat {
    if (vertices.length === 0) return { lng: 0, lat: 0 };
    
    let centerLng = 0;
    let centerLat = 0;
    
    for (const vertex of vertices) {
      centerLng += vertex.lng;
      centerLat += vertex.lat;
    }
    
    return {
      lng: centerLng / vertices.length,
      lat: centerLat / vertices.length
    };
  },

  /**
   * Check if a point is inside a polygon
   */
  pointInPolygon(point: LngLat, polygon: LngLat[]): boolean {
    let inside = false;
    
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].lng;
      const yi = polygon[i].lat;
      const xj = polygon[j].lng;
      const yj = polygon[j].lat;
      
      if ((yi > point.lat) !== (yj > point.lat) &&
          point.lng < (xj - xi) * (point.lat - yi) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    
    return inside;
  },

  /**
   * Calculate the bounding box of a set of points
   */
  calculateBounds(points: LngLat[]): {
    min: LngLat;
    max: LngLat;
    center: LngLat;
    width: number;
    height: number;
  } {
    if (points.length === 0) {
      return {
        min: { lng: 0, lat: 0 },
        max: { lng: 0, lat: 0 },
        center: { lng: 0, lat: 0 },
        width: 0,
        height: 0
      };
    }
    
    let minLng = points[0].lng;
    let maxLng = points[0].lng;
    let minLat = points[0].lat;
    let maxLat = points[0].lat;
    
    for (const point of points) {
      minLng = Math.min(minLng, point.lng);
      maxLng = Math.max(maxLng, point.lng);
      minLat = Math.min(minLat, point.lat);
      maxLat = Math.max(maxLat, point.lat);
    }
    
    return {
      min: { lng: minLng, lat: minLat },
      max: { lng: maxLng, lat: maxLat },
      center: { lng: (minLng + maxLng) / 2, lat: (minLat + maxLat) / 2 },
      width: maxLng - minLng,
      height: maxLat - minLat
    };
  },

  /**
   * Simplify a line using the Douglas-Peucker algorithm
   */
  simplifyLine(points: LngLat[], tolerance: number = 0.001): LngLat[] {
    if (points.length <= 2) return points;
    
    const distanceSquared = (p1: LngLat, p2: LngLat): number => {
      const dx = p1.lng - p2.lng;
      const dy = p1.lat - p2.lat;
      return dx * dx + dy * dy;
    };
    
    const perpendicularDistanceSquared = (point: LngLat, lineStart: LngLat, lineEnd: LngLat): number => {
      const dx = lineEnd.lng - lineStart.lng;
      const dy = lineEnd.lat - lineStart.lat;
      
      if (dx === 0 && dy === 0) {
        return distanceSquared(point, lineStart);
      }
      
      const t = ((point.lng - lineStart.lng) * dx + (point.lat - lineStart.lat) * dy) / (dx * dx + dy * dy);
      
      if (t < 0) {
        return distanceSquared(point, lineStart);
      } else if (t > 1) {
        return distanceSquared(point, lineEnd);
      } else {
        const projection = {
          lng: lineStart.lng + t * dx,
          lat: lineStart.lat + t * dy
        };
        return distanceSquared(point, projection);
      }
    };
    
    const simplifyRecursive = (points: LngLat[], first: number, last: number, tolerance: number): LngLat[] => {
      if (last <= first + 1) {
        return [points[first], points[last]];
      }
      
      let maxDistance = 0;
      let maxIndex = first;
      
      for (let i = first + 1; i < last; i++) {
        const distance = perpendicularDistanceSquared(points[i], points[first], points[last]);
        if (distance > maxDistance) {
          maxDistance = distance;
          maxIndex = i;
        }
      }
      
      if (maxDistance > tolerance * tolerance) {
        const left = simplifyRecursive(points, first, maxIndex, tolerance);
        const right = simplifyRecursive(points, maxIndex, last, tolerance);
        return [...left.slice(0, -1), ...right];
      } else {
        return [points[first], points[last]];
      }
    };
    
    return simplifyRecursive(points, 0, points.length - 1, tolerance);
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
   * Create vertex data with position and color attributes
   */
  createVertexData(positions: Float32Array, colors: Float32Array): Float32Array {
    if (positions.length / 2 !== colors.length / 4) {
      throw new Error('Position and color arrays must have matching vertex counts');
    }
    
    const vertexCount = positions.length / 2;
    const vertexData = new Float32Array(vertexCount * 6); // 2 position + 4 color per vertex
    
    for (let i = 0; i < vertexCount; i++) {
      const vertexOffset = i * 6;
      const posOffset = i * 2;
      const colorOffset = i * 4;
      
      // Position (x, y)
      vertexData[vertexOffset] = positions[posOffset];
      vertexData[vertexOffset + 1] = positions[posOffset + 1];
      
      // Color (r, g, b, a)
      vertexData[vertexOffset + 2] = colors[colorOffset];
      vertexData[vertexOffset + 3] = colors[colorOffset + 1];
      vertexData[vertexOffset + 4] = colors[colorOffset + 2];
      vertexData[vertexOffset + 5] = colors[colorOffset + 3];
    }
    
    return vertexData;
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
  Geometry: GeometryUtils,
  WebGPU: WebGPUMathUtils
};