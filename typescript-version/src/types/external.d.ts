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

declare module 'webgpu-matrix' {
  export interface Mat4 extends Array<number> {
    readonly length: 16;
  }
  
  export interface Vec3 extends Array<number> {
    readonly length: 3;
  }
  
  export interface Vec2 extends Array<number> {
    readonly length: 2;
  }
  
  export const mat4: {
    create(): Mat4;
    identity(out?: Mat4): Mat4;
    perspective(out: Mat4, fovy: number, aspect: number, near: number, far: number): Mat4;
    ortho(out: Mat4, left: number, right: number, bottom: number, top: number, near: number, far: number): Mat4;
    lookAt(out: Mat4, eye: Vec3, center: Vec3, up: Vec3): Mat4;
    translate(out: Mat4, a: Mat4, v: Vec3): Mat4;
    rotate(out: Mat4, a: Mat4, rad: number, axis: Vec3): Mat4;
    scale(out: Mat4, a: Mat4, v: Vec3): Mat4;
    multiply(out: Mat4, a: Mat4, b: Mat4): Mat4;
    invert(out: Mat4, a: Mat4): Mat4 | null;
  };
  
  export const vec3: {
    create(): Vec3;
    fromValues(x: number, y: number, z: number): Vec3;
    transformMat4(out: Vec3, a: Vec3, m: Mat4): Vec3;
  };
  
  export const vec2: {
    create(): Vec2;
    fromValues(x: number, y: number): Vec2;
  };
}