import { describe, expect, it, vi } from "vitest";
import {
  GEO_IP_ENDPOINT,
  GLOBAL_FALLBACK_LOCATION,
  locateByDevice,
  locateByIp,
  resolveInitialLocation,
} from "../apps/shared/initial-location.js";

describe("Pas de Géant initial location", () => {
  it("prefers a valid device location without making an IP request", async () => {
    const geolocation = {
      getCurrentPosition: vi.fn(
        (
          success: PositionCallback,
          _error?: PositionErrorCallback | null,
          options?: PositionOptions,
        ) => {
          expect(options).toMatchObject({
            enableHighAccuracy: true,
            maximumAge: 900_000,
            timeout: 1_234,
          });
          success({
            coords: {
              latitude: -33.8688,
              longitude: 151.2093,
            },
          } as GeolocationPosition);
        },
      ),
    };
    const fetcher = vi.fn<typeof fetch>();

    await expect(
      resolveInitialLocation({
        geolocation,
        fetcher,
        deviceTimeoutMs: 1_234,
      }),
    ).resolves.toEqual({
      latitudeDegrees: -33.8688,
      longitudeDegrees: 151.2093,
      source: "device",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("falls back to approximate IP coordinates when device access fails", async () => {
    const geolocation = {
      getCurrentPosition: vi.fn(
        (
          _success: PositionCallback,
          error?: PositionErrorCallback | null,
        ) => error?.({} as GeolocationPositionError),
      ),
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
    expect(fetcher).toHaveBeenCalledWith(
      GEO_IP_ENDPOINT,
      expect.objectContaining({
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      }),
    );
  });

  it("uses a neutral global fallback for unavailable or invalid locations", async () => {
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

  it("rejects invalid device coordinates", async () => {
    const geolocation = {
      getCurrentPosition: (
        success: PositionCallback,
      ) => success({
        coords: { latitude: Number.NaN, longitude: 20 },
      } as GeolocationPosition),
    };
    await expect(locateByDevice(geolocation)).resolves.toBeUndefined();
  });
});
