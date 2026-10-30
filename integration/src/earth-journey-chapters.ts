import { defineGuidedJourney } from "@found-in-space/guided-journey";
import type { GeantJourneyScene, GeantJourneyServices } from "@found-in-space/pas-de-geant/journey";

export const earthJourney = defineGuidedJourney<GeantJourneyScene, GeantJourneyServices>({
  id: "earth-landscapes", title: "Earth landscapes", transition: { durationSecs: 5 },
  chapters: [
    { id: "overview", title: "A whole Earth", scene: { camera: { kind: "surface", body: "earth",
      latitudeDegrees: 20, longitudeDegrees: 15, altitudeM: 18_000_000, altitudeReference: "reference", scaleDenominator: 7_000_000 } } },
    { id: "himalaya", title: "Himalaya and Tibetan Plateau", scene: { camera: { kind: "surface", body: "earth",
      latitudeDegrees: 28, longitudeDegrees: 86, altitudeM: 1_500_000, altitudeReference: "reference", scaleDenominator: 900_000 } } },
    { id: "andes", title: "Andes and Atacama", scene: { camera: { kind: "surface", body: "earth",
      latitudeDegrees: -24, longitudeDegrees: -69, altitudeM: 1_500_000, altitudeReference: "reference", scaleDenominator: 900_000 } } },
    { id: "night", title: "Across the terminator", scene: { camera: { kind: "surface", body: "earth",
      latitudeDegrees: 10, longitudeDegrees: 95, altitudeM: 18_000_000, altitudeReference: "reference", scaleDenominator: 7_000_000 },
      time: { atMs: Date.parse("2026-10-30T12:00:00Z"), rate: 600 } } },
  ],
});
