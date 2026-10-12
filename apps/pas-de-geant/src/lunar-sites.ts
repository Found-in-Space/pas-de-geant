export interface ApolloStudySite {
  readonly mission: number;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
}

/** LROC-derived LM coordinates in the ME/PA frame, published by NASA NSSDCA. */
export const APOLLO_STUDY_SITES: readonly ApolloStudySite[] = [
  { mission: 11, name: "Tranquility Base", latitude: 0.67416, longitude: 23.47314 },
  { mission: 12, name: "Ocean of Storms", latitude: -3.0128, longitude: -23.4219 },
  { mission: 14, name: "Fra Mauro", latitude: -3.64589, longitude: -17.47194 },
  { mission: 15, name: "Hadley–Apennine", latitude: 26.13239, longitude: 3.6333 },
  { mission: 16, name: "Descartes Highlands", latitude: -8.9734, longitude: 15.5011 },
  { mission: 17, name: "Taurus–Littrow", latitude: 20.1911, longitude: 30.7723 },
];
