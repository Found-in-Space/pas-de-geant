import { describe, expect, it } from "vitest";
import {
  TileHorizonCulling,
  classifyTilesWithinHorizon,
  geometricHorizonRadians,
  plannerHorizonCandidates,
  minimumAngularDistanceToTile,
  referenceObserverPosition,
} from "../packages/pas-de-geant/src/worlds/tile-horizon-culling.js";
import { tileIdentityKey } from "../packages/pas-de-geant/src/worlds/tile-transition-planner.js";
import { TileOnionLayoutSource } from "../packages/pas-de-geant/src/worlds/tile-layout-source.js";
import { EARTH_SURFACE_MODEL, MOON_SURFACE_MODEL } from "../packages/pas-de-geant/src/worlds/surface-model.js";
import { surfaceDisplacementBounds } from "../packages/pas-de-geant/src/worlds/surface-visibility-geometry.js";

describe("planner horizon culling", () => {
  it.each([EARTH_SURFACE_MODEL, MOON_SURFACE_MODEL])(
    "covers the $id stereo union with an orientation-independent observer sphere",
    (model) => {
      const view = { latitudeDegrees: 0, longitudeDegrees: 0, displayRadiusM: 1_000,
        observerHeightWorldM: 1, projection: model.projection, surfaceGeometry: model.visibilityGeometry,
        displacementBounds: surfaceDisplacementBounds(model.visibilityGeometry,
          model.elevationMetadata.elevationBoundsMetres, 1, 1_000) };
      const cut = new TileOnionLayoutSource().calculate({ ...view, maxZoom: 12 });
      const centre = referenceObserverPosition(view);
      const radius = 0.000032;
      const envelope = classifyTilesWithinHorizon(cut, { ...view, observerPositions: [centre], observerRadius: radius });
      for (const direction of [{ x: 0, y: 0, z: radius }, { x: 0, y: radius, z: 0 }, { x: radius, y: 0, z: 0 }]) {
        const eyes = [-1, 1].map((side) => ({ x: centre.x + side * direction.x,
          y: centre.y + side * direction.y, z: centre.z + side * direction.z }));
        const union = classifyTilesWithinHorizon(cut, { ...view, observerPositions: eyes });
        for (const key of union) expect(envelope.has(key)).toBe(true);
      }
    },
  );

  it.each(["web-mercator", "geographic"] as const)(
    "includes the whole-body %s tile and correctly wraps antimeridian intervals",
    (projection) => {
      for (const longitude of [-179, -10, 10, 179]) {
        expect(minimumAngularDistanceToTile({ z: 0, x: 0, y: 0 }, 0, longitude * Math.PI / 180, projection)).toBe(0);
      }
      expect(minimumAngularDistanceToTile({ z: 2, x: 0, y: 2 }, 0, 179 * Math.PI / 180, projection)).toBeCloseTo(Math.PI / 180);
    },
  );

  it.each([EARTH_SURFACE_MODEL, MOON_SURFACE_MODEL])(
    "reconstructs the $id reference observer using its geodetic normal",
    (model) => {
      const view = { latitudeDegrees: 43, longitudeDegrees: 179, displayRadiusM: 1_000,
        observerHeightWorldM: 1.65, surfaceGeometry: model.visibilityGeometry };
      const actual = referenceObserverPosition(view);
      const { position, normal } = model.positionAndNormal(43, 179);
      const expected = position.addScaledVector(normal, 1.65 / 1_000);
      expect(actual.x).toBeCloseTo(expected.x, 14);
      expect(actual.y).toBeCloseTo(expected.y, 14);
      expect(actual.z).toBeCloseTo(expected.z, 14);
    },
  );

  it("admits negative-elevation grazing terrain beyond the reference horizon", () => {
    const model = MOON_SURFACE_MODEL;
    const view = { latitudeDegrees: 0, longitudeDegrees: 0, displayRadiusM: model.referenceRadiusM / 50,
      observerHeightWorldM: 0.771805, projection: model.projection, minimumNormalizedSurfaceRadius: 1 };
    const tile = { z: 10, x: 518, y: 512 }; // roughly 2 degrees east
    expect(classifyTilesWithinHorizon([tile], view).size).toBe(0);
    expect(classifyTilesWithinHorizon([tile], {
      ...view, surfaceGeometry: model.visibilityGeometry,
      displacementBounds: surfaceDisplacementBounds(model.visibilityGeometry, { minimum: -2_000, maximum: 0 }, 1, view.displayRadiusM),
    })).toEqual(new Set([tileIdentityKey(tile)]));
  });

  it("retains all planner candidates when displaced geometry is unknown or the observer is inside its core", () => {
    const model = MOON_SURFACE_MODEL;
    const tiles = [{ z: 1, x: 0, y: 0 }, { z: 1, x: 1, y: 1 }];
    const view = { latitudeDegrees: 0, longitudeDegrees: 0, displayRadiusM: 1_000,
      observerHeightWorldM: 1, surfaceGeometry: model.visibilityGeometry };
    expect(classifyTilesWithinHorizon(tiles, view).size).toBe(2);
    expect(classifyTilesWithinHorizon(tiles, { ...view,
      displacementBounds: surfaceDisplacementBounds(model.visibilityGeometry, { minimum: 0, maximum: 0 }, 1, 1_000),
      observerPositions: [{ x: 0, y: 0, z: 0 }],
    }).size).toBe(2);
  });

  it("considers only committed tiles and planner replacement outputs", () => {
    const committed = [{ z: 1, x: 0, y: 0 }];
    const incoming = { z: 2, x: 0, y: 0 };
    const candidates = plannerHorizonCandidates(committed, [{
      id: "replacement",
      region: committed[0]!,
      before: committed,
      after: [incoming],
    }]);

    expect(candidates.map(tileIdentityKey)).toEqual(["1/0/0", "2/0/0"]);
  });

  it("uses the geometric horizon and excludes the opposite side of the world", () => {
    const local = { z: 3, x: 4, y: 4 };
    const opposite = { z: 3, x: 0, y: 4 };
    const retained = classifyTilesWithinHorizon([local, opposite], {
      latitudeDegrees: -20,
      longitudeDegrees: 22.5,
      displayRadiusM: 1_000,
      observerHeightWorldM: 1.65,
    });

    expect(retained).toEqual(new Set([tileIdentityKey(local)]));
    expect(geometricHorizonRadians(1_000, 0)).toBe(0);
  });

  it("suppresses unchanged horizon sets without any camera-orientation input", () => {
    const tile = { z: 3, x: 4, y: 4 };
    const culling = new TileHorizonCulling();
    const input = {
      revision: 3,
      committedTiles: [tile],
      replacementGroups: [],
      view: {
        latitudeDegrees: -20,
        longitudeDegrees: 22.5,
        displayRadiusM: 1_000,
        observerHeightWorldM: 1.65,
      },
    };

    expect(culling.update(input)).toEqual([tile]);
    expect(culling.update(input)).toBeUndefined();
  });
});
