// Local type declarations for external libraries

declare module 'earcut' {
  /**
   * Earcut polygon triangulation library
   * @param data - flattened input array of 2D coordinates
   * @param holeIndices - array of hole indices if any
   * @param dim - coordinate dimension (2 for 2D, 3 for 3D)
   */
  function earcut(data: number[], holeIndices?: number[], dim?: number): number[];
  export = earcut;
}