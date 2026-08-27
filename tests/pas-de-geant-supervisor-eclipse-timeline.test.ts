import { describe, expect, it } from "vitest";
import {
  supervisorEclipseTimelineFraction,
  supervisorEclipseTimelineUtc,
} from "../apps/pas-de-geant/src/supervisor-eclipse-timeline.js";

const eclipse = {
  contactStartUtc: "2026-08-12T15:34:00.000Z",
  contactEndUtc: "2026-08-12T19:58:00.000Z",
};

describe("supervisor eclipse timeline", () => {
  it("maps the slider endpoints and midpoint across the whole contact period", () => {
    expect(supervisorEclipseTimelineUtc(eclipse, 0)).toBe(
      eclipse.contactStartUtc,
    );
    expect(supervisorEclipseTimelineUtc(eclipse, 0.5)).toBe(
      "2026-08-12T17:46:00.000Z",
    );
    expect(supervisorEclipseTimelineUtc(eclipse, 1)).toBe(
      eclipse.contactEndUtc,
    );
  });

  it("round-trips an exact UTC through the slider fraction", () => {
    const utc = "2026-08-12T18:29:30.000Z";
    const fraction = supervisorEclipseTimelineFraction(eclipse, utc);
    expect(fraction).toBeDefined();
    expect(supervisorEclipseTimelineUtc(eclipse, fraction!)).toBe(utc);
  });

  it("keeps supervisor positions within the contact period", () => {
    expect(supervisorEclipseTimelineUtc(eclipse, -1)).toBe(
      eclipse.contactStartUtc,
    );
    expect(supervisorEclipseTimelineUtc(eclipse, 2)).toBe(
      eclipse.contactEndUtc,
    );
  });
});
