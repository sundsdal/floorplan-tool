import { describe, it, expect } from "vitest";
import { ROOM_COLORS } from "@/lib/types";
import type { FloorplanState, RoomType } from "@/lib/types";

describe("lib/types", () => {
  it("ROOM_COLORS has entries for all room types", () => {
    const roomTypes: RoomType[] = [
      "bedroom", "kitchen", "bathroom", "living_room", "dining_room",
      "hallway", "closet", "balcony", "office", "laundry", "garage",
      "basement", "stairs", "attic", "other",
    ];
    for (const type of roomTypes) {
      expect(ROOM_COLORS[type]).toBeDefined();
      expect(ROOM_COLORS[type]).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("ROOM_COLORS values are unique", () => {
    const values = Object.values(ROOM_COLORS);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it("FloorplanState can be constructed with empty arrays", () => {
    const state: FloorplanState = {
      walls: [],
      doors: [],
      windows: [],
      rooms: [],
      dimensions: [],
      total_area_m2: 0,
    };
    expect(state.walls).toHaveLength(0);
  });
});
