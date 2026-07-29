declare module "@mapbox/martini" {
  interface MartiniMesh {
    vertices: Uint16Array;
    triangles: Uint32Array;
  }

  interface MartiniTile {
    errors: Float32Array;
    martini: Martini;
    update(): void;
    getMesh(maxError?: number): MartiniMesh;
  }

  export default class Martini {
    readonly gridSize: number;
    readonly numTriangles: number;
    readonly numParentTriangles: number;
    readonly coords: Uint16Array;
    constructor(gridSize?: number);
    createTile(terrain: ArrayLike<number>): MartiniTile;
  }
}
