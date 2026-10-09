import { describe, expect, it } from "vitest";
import {
  localTilePath,
} from "../apps/pas-de-geant/src/local-tile-directory-server.js";

describe("local tile directory server", () => {
  it("maps canonical extensionless and explicit PNG routes to the same tile", () => {
    const root = "/textures/moon";
    const canonical = localTilePath(
      "lunar-imagery",
      root,
      "/api/tiles/lunar-imagery/8/132/91",
    );
    const explicit = localTilePath(
      "lunar-imagery",
      root,
      "/api/tiles/lunar-imagery/8/132/91.png?cache=ignored",
    );

    expect(canonical).toBe("/textures/moon/8/132/91.png");
    expect(explicit).toBe(canonical);
  });

  it("ignores unrelated and malformed paths", () => {
    expect(
      localTilePath(
        "lunar-imagery",
        "/textures/moon",
        "/api/tiles/elevation/8/132/91",
      ),
    ).toBeUndefined();
    expect(
      localTilePath(
        "lunar-imagery",
        "/textures/moon",
        "/api/tiles/lunar-imagery/8/132/../91",
      ),
    ).toBeUndefined();
  });
});
