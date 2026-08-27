import {
  parseLocationPin,
  type LocationPin,
} from "./location-pin.js";

export const SUPERVISOR_SAVED_LOCATIONS_KEY =
  "pas-de-geant.supervisor.saved-locations.v1";

export interface SupervisorSavedLocationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function parseStoredPins(value: string | null): readonly LocationPin[] {
  if (!value) return [];
  let candidates: unknown;
  try {
    candidates = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(candidates)) return [];
  const pins = new Map<string, LocationPin>();
  for (const candidate of candidates) {
    try {
      const pin = parseLocationPin(candidate);
      pins.set(pin.pinId, pin);
    } catch {
      // Ignore corrupt entries while preserving the rest of the saved library.
    }
  }
  return [...pins.values()];
}

export class SupervisorSavedLocationStore {
  private readonly pins = new Map<string, LocationPin>();

  constructor(
    private readonly storage: SupervisorSavedLocationStorage,
    private readonly storageKey = SUPERVISOR_SAVED_LOCATIONS_KEY,
  ) {
    let storedValue: string | null = null;
    try {
      storedValue = storage.getItem(storageKey);
    } catch {
      // Browsers may deny storage access. The dashboard remains usable in memory.
    }
    for (const pin of parseStoredPins(storedValue)) {
      this.pins.set(pin.pinId, pin);
    }
  }

  snapshot(): readonly LocationPin[] {
    return [...this.pins.values()];
  }

  set(pinValue: LocationPin): readonly LocationPin[] {
    const pin = parseLocationPin(pinValue);
    const previous = this.pins.get(pin.pinId);
    this.pins.set(pin.pinId, pin);
    try {
      this.persist();
    } catch (error) {
      if (previous) this.pins.set(pin.pinId, previous);
      else this.pins.delete(pin.pinId);
      throw error;
    }
    return this.snapshot();
  }

  remove(pinId: string): readonly LocationPin[] {
    const pin = this.pins.get(pinId);
    if (!pin) return this.snapshot();
    this.pins.delete(pinId);
    try {
      this.persist();
    } catch (error) {
      this.pins.set(pinId, pin);
      throw error;
    }
    return this.snapshot();
  }

  private persist(): void {
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(this.snapshot()));
    } catch {
      throw new Error("Saved locations could not be written to browser storage.");
    }
  }
}
