import { describe, expect, it } from "vitest";
import type { LocationPin } from "../apps/pas-de-geant/src/location-pin.js";
import {
  SUPERVISOR_SAVED_LOCATIONS_KEY,
  SupervisorSavedLocationStore,
  type SupervisorSavedLocationStorage,
} from "../apps/pas-de-geant/src/supervisor-saved-locations.js";

const florence: LocationPin = {
  pinId: "florence",
  label: "Florence",
  latitudeDegrees: 43.7696,
  longitudeDegrees: 11.2558,
};

class MemoryStorage implements SupervisorSavedLocationStorage {
  readonly values = new Map<string, string>();
  failWrites = false;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("Storage unavailable");
    this.values.set(key, value);
  }
}

describe("Pas de Géant supervisor saved locations", () => {
  it("persists, updates and deletes reusable pins across store instances", () => {
    const storage = new MemoryStorage();
    const store = new SupervisorSavedLocationStore(storage);
    expect(store.set(florence)).toEqual([florence]);
    expect(new SupervisorSavedLocationStore(storage).snapshot()).toEqual([florence]);

    const renamed = { ...florence, label: "Firenze" };
    expect(store.set(renamed)).toEqual([renamed]);
    expect(store.remove(florence.pinId)).toEqual([]);
    expect(new SupervisorSavedLocationStore(storage).snapshot()).toEqual([]);
  });

  it("loads valid entries while ignoring corrupt browser data", () => {
    const storage = new MemoryStorage();
    storage.values.set(SUPERVISOR_SAVED_LOCATIONS_KEY, JSON.stringify([
      { ...florence, latitudeDegrees: 100 },
      florence,
      null,
      { ...florence, label: "Firenze" },
    ]));
    expect(new SupervisorSavedLocationStore(storage).snapshot()).toEqual([
      { ...florence, label: "Firenze" },
    ]);
  });

  it("rolls back in-memory changes when browser storage rejects a write", () => {
    const storage = new MemoryStorage();
    const store = new SupervisorSavedLocationStore(storage);
    storage.failWrites = true;
    expect(() => store.set(florence)).toThrow(/browser storage/i);
    expect(store.snapshot()).toEqual([]);

    storage.failWrites = false;
    store.set(florence);
    storage.failWrites = true;
    expect(() => store.remove(florence.pinId)).toThrow(/browser storage/i);
    expect(store.snapshot()).toEqual([florence]);
  });
});
