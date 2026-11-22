import { describe, it, expect, vi, beforeEach } from "vitest";
import { FloorplanCanvas } from "@/lib/server-canvas";
import { createTools } from "@/lib/agent";

// We test the tool execute functions directly by calling them with
// valid/invalid inputs through the FloorplanCanvas instance.

describe("Agent FunctionTools", () => {
  let canvas: FloorplanCanvas;
  let tools: ReturnType<typeof createTools>;

  beforeEach(() => {
    canvas = new FloorplanCanvas();
    tools = createTools(canvas);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function getTool(name: string): any {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`Tool ${name} not found`);
    return tool;
  }

  async function createSimpleRectangleRoom(): Promise<string[]> {
    const wallTool = getTool("draw_wall");
    const walls = [
      await wallTool.execute(
        { start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, thickness_m: 0.15, height_m: 2.7 },
        {} as any
      ),
      await wallTool.execute(
        { start: { x: 4, y: 0 }, end: { x: 4, y: 3 }, thickness_m: 0.15, height_m: 2.7 },
        {} as any
      ),
      await wallTool.execute(
        { start: { x: 4, y: 3 }, end: { x: 0, y: 3 }, thickness_m: 0.15, height_m: 2.7 },
        {} as any
      ),
      await wallTool.execute(
        { start: { x: 0, y: 3 }, end: { x: 0, y: 0 }, thickness_m: 0.15, height_m: 2.7 },
        {} as any
      ),
    ];

    return walls.map((wall) => wall.wall_id);
  }

  describe("draw_wall", () => {
    it("should draw a wall and return id + length", async () => {
      const tool = getTool("draw_wall");
      const result = await tool.execute(
        {
          start: { x: 0, y: 0 },
          end: { x: 3, y: 0 },
          thickness_m: 0.15,
          height_m: 2.7,
        },
        {} as any
      );
      expect(result).toHaveProperty("wall_id");
      expect(result).toHaveProperty("length_m");
      expect((result as any).length_m).toBeCloseTo(3, 1);
    });

    it("should compute diagonal wall length correctly", async () => {
      const tool = getTool("draw_wall");
      const result = await tool.execute(
        {
          start: { x: 0, y: 0 },
          end: { x: 3, y: 4 },
          thickness_m: 0.15,
          height_m: 2.7,
        },
        {} as any
      );
      expect((result as any).length_m).toBeCloseTo(5, 1);
    });

    it("should generate unique wall IDs", async () => {
      const tool = getTool("draw_wall");
      const r1 = await tool.execute(
        { start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, thickness_m: 0.15, height_m: 2.7 },
        {} as any
      );
      const r2 = await tool.execute(
        { start: { x: 1, y: 0 }, end: { x: 1, y: 1 }, thickness_m: 0.15, height_m: 2.7 },
        {} as any
      );
      expect((r1 as any).wall_id).not.toBe((r2 as any).wall_id);
    });
  });

  describe("place_door", () => {
    it("should place a door on an existing wall", async () => {
      const wallTool = getTool("draw_wall");
      const wallResult = await wallTool.execute(
        { start: { x: 0, y: 0 }, end: { x: 5, y: 0 }, thickness_m: 0.15, height_m: 2.7 },
        {} as any
      );
      const wallId = (wallResult as any).wall_id;

      const doorTool = getTool("place_door");
      const result = await doorTool.execute(
        { wall_id: wallId, position_along_m: 2.5, width_m: 0.9, type: "standard" },
        {} as any
      );
      expect(result).toHaveProperty("door_id");
    });

    it("should throw for non-existent wall", async () => {
      const doorTool = getTool("place_door");
      await expect(
        doorTool.execute(
          { wall_id: "wall_999", position_along_m: 1, width_m: 0.9, type: "standard" },
          {} as any
        )
      ).rejects.toThrow("Wall wall_999 not found");
    });
  });

  describe("place_window", () => {
    it("should place a window on an existing wall", async () => {
      const wallTool = getTool("draw_wall");
      const wallResult = await wallTool.execute(
        { start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, thickness_m: 0.15, height_m: 2.7 },
        {} as any
      );
      const wallId = (wallResult as any).wall_id;

      const windowTool = getTool("place_window");
      const result = await windowTool.execute(
        { wall_id: wallId, position_along_m: 2, width_m: 1.2, sill_height_m: 0.9 },
        {} as any
      );
      expect(result).toHaveProperty("window_id");
    });

    it("should throw for non-existent wall", async () => {
      const windowTool = getTool("place_window");
      await expect(
        windowTool.execute(
          { wall_id: "wall_999", position_along_m: 1, width_m: 1.2, sill_height_m: 0.9 },
          {} as any
        )
      ).rejects.toThrow("Wall wall_999 not found");
    });
  });

  describe("label_room", () => {
    it("should infer a closed room from walls and return id", async () => {
      await createSimpleRectangleRoom();

      const tool = getTool("label_room");
      const result = await tool.execute(
        { point: { x: 2, y: 1.5 }, name: "Kitchen", type: "kitchen" },
        {} as any
      );
      expect(result).toHaveProperty("room_id");

      const stateTool = getTool("get_canvas_state");
      const state = await stateTool.execute({}, {} as any);
      expect(state.json.rooms[0].walls.length).toBeGreaterThanOrEqual(3);
    });

    it("should allow explicit polygon and wall IDs", async () => {
      const wallIds = await createSimpleRectangleRoom();

      const tool = getTool("label_room");
      const result = await tool.execute(
        {
          point: { x: 2, y: 1.5 },
          name: "Bedroom",
          type: "bedroom",
          polygon: [
            { x: 0, y: 0 },
            { x: 4, y: 0 },
            { x: 4, y: 3 },
            { x: 0, y: 3 },
          ],
          wall_ids: wallIds,
        },
        {} as any
      );
      expect(result).toHaveProperty("room_id");
    });
  });

  describe("annotate_dimension", () => {
    it("should add a dimension annotation", async () => {
      const tool = getTool("annotate_dimension");
      const result = await tool.execute(
        { start: { x: 0, y: 0 }, end: { x: 3, y: 0 }, label: "3.0m" },
        {} as any
      );
      expect(result).toHaveProperty("dimension_id");
    });
  });

  describe("set_ceiling_height", () => {
    it("should set ceiling height on existing room", async () => {
      await createSimpleRectangleRoom();

      // First create a room
      const labelTool = getTool("label_room");
      await labelTool.execute(
        { point: { x: 2, y: 1.5 }, name: "Bedroom", type: "bedroom" },
        {} as any
      );

      const tool = getTool("set_ceiling_height");
      const result = await tool.execute(
        { room_label: "Bedroom", height_m: 3.0 },
        {} as any
      );
      expect(result).toEqual({ success: true, room: "Bedroom", height_m: 3.0 });
    });

    it("should throw for non-existent room", async () => {
      const tool = getTool("set_ceiling_height");
      await expect(
        tool.execute({ room_label: "NoRoom", height_m: 2.7 }, {} as any)
      ).rejects.toThrow('Room "NoRoom" not found');
    });
  });

  describe("delete_element", () => {
    it("should delete an existing element", async () => {
      const wallTool = getTool("draw_wall");
      const wallResult = await wallTool.execute(
        { start: { x: 0, y: 0 }, end: { x: 3, y: 0 }, thickness_m: 0.15, height_m: 2.7 },
        {} as any
      );
      const wallId = (wallResult as any).wall_id;

      const tool = getTool("delete_element");
      const result = await tool.execute({ element_id: wallId }, {} as any);
      expect(result).toEqual({ success: true, deleted: wallId });
    });

    it("should throw for non-existent element", async () => {
      const tool = getTool("delete_element");
      await expect(
        tool.execute({ element_id: "nope_1" }, {} as any)
      ).rejects.toThrow("Element nope_1 not found");
    });
  });

  describe("get_canvas_state", () => {
    it("should return JSON state and png_base64", async () => {
      // Add some elements first
      const wallTool = getTool("draw_wall");
      await wallTool.execute(
        { start: { x: 0, y: 0 }, end: { x: 3, y: 0 }, thickness_m: 0.15, height_m: 2.7 },
        {} as any
      );

      const tool = getTool("get_canvas_state");
      const result = await tool.execute({}, {} as any);
      expect(result).toHaveProperty("json");
      expect(result).toHaveProperty("png_base64");
      expect((result as any).json).toHaveProperty("walls");
      expect((result as any).json.walls).toHaveLength(1);
      expect(typeof (result as any).png_base64).toBe("string");
      // Check it's valid base64
      expect(() => Buffer.from((result as any).png_base64, "base64")).not.toThrow();
    });

    it("should return empty state when no elements added", async () => {
      const tool = getTool("get_canvas_state");
      const result = await tool.execute({}, {} as any);
      expect((result as any).json.walls).toHaveLength(0);
      expect((result as any).json.doors).toHaveLength(0);
      expect((result as any).json.windows).toHaveLength(0);
      expect((result as any).json.rooms).toHaveLength(0);
    });
  });

  describe("tool names", () => {
    it("should have all 9 tools registered", () => {
      expect(tools).toHaveLength(9);
      const names = tools.map((t) => t.name);
      expect(names).toContain("draw_wall");
      expect(names).toContain("move_wall");
      expect(names).toContain("place_door");
      expect(names).toContain("place_window");
      expect(names).toContain("label_room");
      expect(names).toContain("annotate_dimension");
      expect(names).toContain("set_ceiling_height");
      expect(names).toContain("delete_element");
      expect(names).toContain("get_canvas_state");
    });
  });
});
