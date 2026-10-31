import { defineGuidedJourney, type JourneyContext } from "@found-in-space/guided-journey";
import { waitForGeantSurface, type GeantJourneyScene, type GeantJourneyServices } from "@found-in-space/pas-de-geant/journey";
import type { SurfaceLayer } from "@found-in-space/pas-de-geant/worlds";

const detail = (...required: SurfaceLayer[]) => async (context: JourneyContext<GeantJourneyScene, GeantJourneyServices>) => {
  await waitForGeantSurface({ browser: context.services.browser, body: context.scene.camera.body,
    required, onDegraded: "continue", signal: context.signal, onProgress: context.reportProgress });
};

export const earthJourney = defineGuidedJourney<GeantJourneyScene, GeantJourneyServices>({
  id: "earth-landscapes", title: "Earth landscapes", transition: { durationSecs: 5 },
  chapters: [
    { id: "overview", title: "A whole Earth", arrive: detail("imagery"), scene: { camera: { kind: "surface", body: "earth",
      latitudeDegrees: 20, longitudeDegrees: 15, altitudeM: 18_000_000, altitudeReference: "reference", scaleDenominator: 7_000_000 },
      time: { atMs: Date.parse("2026-10-30T12:00:00Z"), rate: 0 } } },
    { id: "himalaya", title: "Himalaya and Tibetan Plateau", arrive: detail("imagery", "terrain"), scene: { camera: { kind: "surface", body: "earth",
      latitudeDegrees: 28, longitudeDegrees: 86, altitudeM: 1_500_000, altitudeReference: "reference", scaleDenominator: 900_000 },
      time: { atMs: Date.parse("2026-10-30T06:00:00Z"), rate: 0 } } },
    { id: "andes", title: "Andes and Atacama", arrive: detail("imagery", "terrain"), scene: { camera: { kind: "surface", body: "earth",
      latitudeDegrees: -24, longitudeDegrees: -69, altitudeM: 1_500_000, altitudeReference: "reference", scaleDenominator: 900_000 },
      time: { atMs: Date.parse("2026-10-30T18:00:00Z"), rate: 0 } } },
    { id: "night", title: "Across the terminator", arrive: detail("imagery", "nightImagery"), scene: { camera: { kind: "surface", body: "earth",
      latitudeDegrees: 10, longitudeDegrees: 95, altitudeM: 18_000_000, altitudeReference: "reference", scaleDenominator: 7_000_000 },
      time: { atMs: Date.parse("2026-10-30T12:00:00Z"), rate: 600 } } },
  ],
});
