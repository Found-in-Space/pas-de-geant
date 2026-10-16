import { describe, expect, it } from "vitest";
import { createRealtimeGreetingEvent as realtimeGreetingEvent } from '@found-in-space/voice-os/openai';
import {
  realtimeExperienceFromUrl,
  realtimeSessionConfiguration,
} from "../apps/pas-de-geant/src/realtime-token-server.js";

describe("Eclipse Realtime profile", () => {
  it("selects only known experience profiles and preserves Earth by default", () => {
    expect(realtimeExperienceFromUrl(new URL("http://local/api/realtime/token")))
      .toBe("earth");
    expect(realtimeExperienceFromUrl(
      new URL("http://local/api/realtime/token?experience=eclipse"),
    )).toBe("eclipse");
    expect(realtimeExperienceFromUrl(
      new URL("http://local/api/realtime/token?experience=moon"),
    )).toBeNull();
    expect(realtimeSessionConfiguration()).toEqual(
      realtimeSessionConfiguration("earth"),
    );
  });

  it("exposes the verified eclipse commands and discovery-first policy", () => {
    const configuration = realtimeSessionConfiguration("eclipse") as {
      session: {
        instructions: string;
        tools: Array<{
          name: string;
          parameters: {
            required?: string[];
            properties?: Record<string, {
              enum?: string[];
              type?: string;
              exclusiveMinimum?: number;
            }>;
          };
        }>;
      };
    };
    expect(configuration.session.tools.map(({ name }) => name)).toEqual([
      "get_eclipse_state",
      "find_solar_eclipses",
      "select_solar_eclipse",
      "set_eclipse_time",
      "set_eclipse_playback",
      "set_eclipse_scale",
      "reset_eclipse_stage",
      "search_wikipedia",
      "search_web",
    ]);
    expect(configuration.session.instructions).toContain(
      "first call find_solar_eclipses",
    );
    expect(configuration.session.instructions).toContain(
      "Never invent an eclipse or scientific geometry",
    );
    expect(configuration.session.instructions).toContain("Earth-orbital");
    expect(configuration.session.tools.some(
      ({ name }) => name === "set_eclipse_view"
    )).toBe(false);
    expect(configuration.session.tools.find(({ name }) => name === "set_eclipse_time")
      ?.parameters.required).toEqual(["utc"]);
    const scaleTool = configuration.session.tools.find(
      ({ name }) => name === "set_eclipse_scale",
    );
    expect(scaleTool?.parameters.required).toEqual(["scale_denominator"]);
    expect(scaleTool?.parameters.properties?.scale_denominator).toMatchObject({
      type: "number",
      exclusiveMinimum: 0,
    });
    expect(scaleTool?.parameters.properties?.metres_per_earth_radius)
      .toBeUndefined();
  });

  it("lets the eclipse page supply its own one-turn greeting", () => {
    const greeting = realtimeGreetingEvent(
      "Invite the user to choose or explore a solar eclipse.",
    ) as { response: { instructions: string; output_modalities: string[] } };
    expect(greeting.response).toEqual({
      instructions: "Invite the user to choose or explore a solar eclipse.",
      output_modalities: ["audio"],
    });
  });
});
