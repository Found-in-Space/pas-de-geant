import { describe, expect, it } from "vitest";
import { ImageTexturePool } from "../apps/pas-de-geant/src/image-texture-pool.js";

describe("Image texture pool", () => {
  it("shares a texture until its final mesh binding is released", () => {
    const image = {};
    const texture = {
      dispose: () => {
        disposed += 1;
      },
    };
    let created = 0;
    let disposed = 0;
    const pool = new ImageTexturePool<object, typeof texture>();
    const first = pool.acquire(image, () => {
      created += 1;
      return texture;
    });
    const second = pool.acquire(image, () => {
      created += 1;
      return texture;
    });

    expect(second).toBe(first);
    expect(created).toBe(1);
    pool.release(image);
    expect(disposed).toBe(0);
    pool.release(image);
    expect(disposed).toBe(1);
  });

  it("does not acquire another reference when identical fallback becomes final", () => {
    const image = {};
    let created = 0;
    let disposed = 0;
    const pool = new ImageTexturePool<object, { dispose(): void }>();
    pool.acquire(image, () => ({
      dispose: () => {
        disposed += 1;
      },
      ...((created += 1), {}),
    }));
    // Identical promotion keeps the existing mesh binding, so it performs no acquire.
    pool.release(image);

    expect(created).toBe(1);
    expect(disposed).toBe(1);
  });
});
