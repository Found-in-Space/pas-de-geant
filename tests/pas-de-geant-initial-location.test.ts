import { describe, expect, it, vi } from "vitest";
import {
  GLOBAL_FALLBACK_LOCATION,
  locateByIp,
  resolveInitialLocation,
} from "../apps/pas-de-geant/src/initial-location.js";

describe("Pas de Géant initial-location regressions", () => {
  it("prefers a valid device location without making an IP request", async () => {
    const geolocation = {
      getCurrentPosition: (
        success: PositionCallback,
      ) => success({
        coords: {
          latitude: -33.8688,
          longitude: 151.2093,
        },
      } as GeolocationPosition),
    };
    const fetcher = vi.fn<typeof fetch>();

    await expect(
      resolveInitialLocation({ geolocation, fetcher }),
    ).resolves.toEqual({
      latitudeDegrees: -33.8688,
      longitudeDegrees: 151.2093,
      source: "device",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("falls back to approximate IP coordinates after device failure", async () => {
    const geolocation = {
      getCurrentPosition: (
        _success: PositionCallback,
        error?: PositionErrorCallback | null,
      ) => error?.({} as GeolocationPositionError),
    };
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          latitude: "35.6762",
          longitude: "139.6503",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    await expect(
      resolveInitialLocation({ geolocation, fetcher }),
    ).resolves.toEqual({
      latitudeDegrees: 35.6762,
      longitudeDegrees: 139.6503,
      source: "ip",
    });
  });

  it("uses a neutral fallback when location services are unavailable or invalid", async () => {
    const failingFetch = vi.fn<typeof fetch>(async () =>
      new Response("Unavailable", { status: 503 }),
    );
    await expect(
      resolveInitialLocation({
        geolocation: undefined,
        fetcher: failingFetch,
      }),
    ).resolves.toEqual(GLOBAL_FALLBACK_LOCATION);

    const invalidFetch = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({ latitude: 91, longitude: 181 }),
        { status: 200 },
      ),
    );
    await expect(locateByIp(invalidFetch)).resolves.toBeUndefined();
  });
});
