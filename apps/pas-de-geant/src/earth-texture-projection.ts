export interface EarthTextureUv {
  readonly u: number;
  readonly v: number;
}

/** Geographic coordinates in the north-at-v=0 equirectangular globe layout. */
export function earthTextureUv(
  latitudeDegrees: number,
  longitudeDegrees: number,
): EarthTextureUv {
  return {
    u: (longitudeDegrees + 180) / 360,
    v: (90 - latitudeDegrees) / 180,
  };
}
