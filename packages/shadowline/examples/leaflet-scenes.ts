import L from "leaflet";
import {
  EclipseEngine,
  toGeoJson,
} from "@found-in-space/shadowline";
import {
  astronomyEngineCapabilities,
} from "@found-in-space/shadowline-astronomy-engine";

const engine = new EclipseEngine(astronomyEngineCapabilities());
const events = engine.events({
  startUtc: "2025-01-01T00:00:00Z",
  endUtc: "2027-01-01T00:00:00Z",
});
const central = events.find((event) => event.id.startsWith("solar-2026-08-12"))!;
const partial = events.find((event) => event.id.startsWith("solar-2025-03-29"))!;
const map = L.map("map").setView([45, -20], 2);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "© OpenStreetMap contributors",
}).addTo(map);
for (const [event, color] of [[central, "#8f56aa"], [partial, "#2d9b59"]] as const) {
  const scene = engine.calculateEvent(event, {
    centralPath: true,
    globalVisibility: true,
    instantaneousAtUtc: [event.peakUtc],
  });
  L.geoJSON(toGeoJson(scene) as never, {
    style: { color, weight: 2, fillOpacity: 0.16 },
  }).addTo(map);
}
