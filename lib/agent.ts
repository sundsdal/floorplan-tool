import { LlmAgent, FunctionTool, InMemoryRunner } from "@google/adk";
import { createPartFromUri, createPartFromText, createUserContent } from "@google/genai";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { FloorplanCanvas } from "./server-canvas";
import type { FloorplanState, RoomType } from "./types";

const SKILL_DIRS = [
  "room_identification",
  "room_labeling",
  "spatial_mapping",
  "geometry_validation",
] as const;

let skillInstructionsCache: string | null = null;

const pointSchema = z.object({
  x: z.number().describe("X coordinate in meters"),
  y: z.number().describe("Y coordinate in meters"),
});

function loadSkillInstructions(): string {
  if (skillInstructionsCache) {
    return skillInstructionsCache;
  }

  const skillsDir = path.join(process.cwd(), "skills");
  const parts: string[] = [];

  for (const skill of SKILL_DIRS) {
    const skillPath = path.join(skillsDir, skill, "SKILL.md");
    if (!fs.existsSync(skillPath)) {
      throw new Error(`Missing required skill file: ${skillPath}`);
    }
    const content = fs.readFileSync(skillPath, "utf-8");
    parts.push(content);

    // Load reference files
    const refsDir = path.join(skillsDir, skill, "references");
    if (!fs.existsSync(refsDir)) {
      continue;
    }

    const refs = fs
      .readdirSync(refsDir)
      .filter((ref) => ref.endsWith(".md"))
      .sort((a, b) => a.localeCompare(b));

    for (const ref of refs) {
      const refPath = path.join(refsDir, ref);
      const refContent = fs.readFileSync(refPath, "utf-8");
      parts.push(`## Reference: ${skill}/${ref}\n\n${refContent}`);
    }
  }

  skillInstructionsCache = parts.join("\n\n---\n\n");
  return skillInstructionsCache;
}

export function createTools(canvas: FloorplanCanvas): FunctionTool[] {
  const drawWallTool = new FunctionTool({
    name: "draw_wall",
    description:
      "Draw a wall segment between two points. Coordinates are in meters. Returns the wall ID and its computed length.",
    parameters: z.object({
      start: pointSchema.describe("Start point of the wall"),
      end: pointSchema.describe("End point of the wall"),
      thickness_m: z.number().default(0.15).describe("Wall thickness in meters"),
      height_m: z.number().default(2.7).describe("Wall height in meters"),
    }),
    execute: async ({ start, end, thickness_m, height_m }) => {
      const result = canvas.addWall(start, end, thickness_m, height_m);
      return { wall_id: result.id, length_m: result.length_m };
    },
  });

  const placeDoorTool = new FunctionTool({
    name: "place_door",
    description:
      "Place a door on an existing wall. Specify position along the wall in meters from the wall's start point.",
    parameters: z.object({
      wall_id: z.string().describe("ID of the wall to place the door on"),
      position_along_m: z
        .number()
        .describe("Position along the wall in meters from start"),
      width_m: z.number().default(0.9).describe("Door width in meters"),
      type: z
        .enum(["standard", "sliding", "opening"])
        .default("standard")
        .describe("Door type"),
    }),
    execute: async ({ wall_id, position_along_m, width_m, type }) => {
      const result = canvas.addDoor(wall_id, position_along_m, width_m, type);
      return { door_id: result.id };
    },
  });

  const placeWindowTool = new FunctionTool({
    name: "place_window",
    description:
      "Place a window on an existing wall. Specify position along the wall in meters from the wall's start point.",
    parameters: z.object({
      wall_id: z.string().describe("ID of the wall to place the window on"),
      position_along_m: z
        .number()
        .describe("Position along the wall in meters from start"),
      width_m: z.number().default(1.2).describe("Window width in meters"),
      sill_height_m: z
        .number()
        .default(0.9)
        .describe("Window sill height from floor in meters"),
    }),
    execute: async ({ wall_id, position_along_m, width_m, sill_height_m }) => {
      const result = canvas.addWindow(
        wall_id,
        position_along_m,
        width_m,
        sill_height_m
      );
      return { window_id: result.id };
    },
  });

  const labelRoomTool = new FunctionTool({
    name: "label_room",
    description:
      "Label an enclosed area as a room with its detected type. Always provide a point inside the room. Prefer providing polygon and wall_ids so room topology stays consistent.",
    parameters: z.object({
      point: pointSchema.describe("Point inside the room to place the label"),
      name: z.string().describe("Room name (e.g. 'Master Bedroom', 'Kitchen')"),
      type: z
        .enum([
          "bedroom",
          "kitchen",
          "bathroom",
          "living_room",
          "dining_room",
          "hallway",
          "closet",
          "balcony",
          "office",
          "laundry",
          "garage",
          "basement",
          "stairs",
          "attic",
          "other",
        ] as const)
        .describe("Room type for color coding"),
      polygon: z
        .array(pointSchema)
        .min(3)
        .optional()
        .describe("Optional ordered polygon vertices for the room boundary"),
      wall_ids: z
        .array(z.string())
        .optional()
        .describe("Optional wall IDs forming the room boundary in polygon order"),
    }),
    execute: async ({ point, name, type, polygon, wall_ids }) => {
      const result = canvas.labelRoom(point, name, type as RoomType, {
        polygon,
        wallIds: wall_ids,
      });
      return { room_id: result.id };
    },
  });

  const annotateDimensionTool = new FunctionTool({
    name: "annotate_dimension",
    description:
      "Add a dimension annotation line with measurement text between two points.",
    parameters: z.object({
      start: pointSchema.describe("Start point of the dimension line"),
      end: pointSchema.describe("End point of the dimension line"),
      label: z.string().describe("Dimension label text (e.g. '3.5m')"),
    }),
    execute: async ({ start, end, label }) => {
      const result = canvas.annotateDimension(start, end, label);
      return { dimension_id: result.id };
    },
  });

  const setCeilingHeightTool = new FunctionTool({
    name: "set_ceiling_height",
    description: "Set the ceiling height for a previously labeled room.",
    parameters: z.object({
      room_label: z.string().describe("Name of the room (as used in label_room)"),
      height_m: z.number().describe("Ceiling height in meters"),
    }),
    execute: async ({ room_label, height_m }) => {
      canvas.setCeilingHeight(room_label, height_m);
      return { success: true, room: room_label, height_m };
    },
  });

  const moveWallTool = new FunctionTool({
    name: "move_wall",
    description:
      "Reposition an existing wall by setting new start and end coordinates. Use this to correct misaligned walls without deleting and redrawing them.",
    parameters: z.object({
      wall_id: z.string().describe("ID of the wall to move"),
      new_start: pointSchema.describe("New start point of the wall"),
      new_end: pointSchema.describe("New end point of the wall"),
    }),
    execute: async ({ wall_id, new_start, new_end }) => {
      const result = canvas.moveWall(wall_id, new_start, new_end);
      return { wall_id, length_m: result.length_m };
    },
  });

  const deleteElementTool = new FunctionTool({
    name: "delete_element",
    description:
      "Remove an element (wall, door, window, room label, or dimension) from the floorplan by its ID.",
    parameters: z.object({
      element_id: z.string().describe("ID of the element to delete"),
    }),
    execute: async ({ element_id }) => {
      canvas.deleteElement(element_id);
      return { success: true, deleted: element_id };
    },
  });

  const getCanvasStateTool = new FunctionTool({
    name: "get_canvas_state",
    description:
      "Get the current floorplan state as JSON and a PNG screenshot. Use this to visually inspect your work and verify the layout is correct.",
    parameters: z.object({}),
    execute: async () => {
      const state = await canvas.getState();
      const pngBase64 = state.png.toString("base64");
      return {
        json: state.json,
        png_base64: pngBase64,
      };
    },
  });

  return [
    drawWallTool,
    moveWallTool,
    placeDoorTool,
    placeWindowTool,
    labelRoomTool,
    annotateDimensionTool,
    setCeilingHeightTool,
    deleteElementTool,
    getCanvasStateTool,
  ];
}

export type ProgressEvent =
  | { type: "skill"; name: string }
  | { type: "tool"; name: string; params?: Record<string, unknown> }
  | { type: "status"; name: string }
  | { type: "canvas_update"; state: FloorplanState };

export type ProgressCallback = (event: ProgressEvent) => void;

export async function generateFloorplan(
  videoUri: string,
  videoMimeType: string,
  onProgress?: ProgressCallback
): Promise<FloorplanState> {
  const canvas = new FloorplanCanvas();

  if (onProgress) {
    canvas.setOnUpdate((state) => {
      onProgress({ type: "canvas_update", state });
    });
  }

  const tools = createTools(canvas);
  const skillInstructions = loadSkillInstructions();

  const agent = new LlmAgent({
    name: "floorplan_extractor",
    model: "gemini-3.1-pro-preview",
    instruction: `You are a floorplan extraction agent. You analyze walkthrough videos
of rooms/apartments and produce structured floorplan data.

Use the provided tools to incrementally build the floorplan on a server-side canvas.
Estimate all dimensions in meters using reference objects visible in the video
(standard doors ~0.9m wide, ceiling heights ~2.5-2.7m, kitchen counters ~0.9m high).

## Workflow

Follow these phases in order:

### Phase 1: Spatial Mapping
Scan the entire video and build the structural layout:
- Draw all walls using draw_wall (coordinates in meters, origin at first room corner)
- Place doors using place_door on the appropriate walls
- Place windows using place_window on exterior walls
- Annotate key dimensions using annotate_dimension
- Ensure shared walls between adjacent rooms align exactly

### Phase 2: Visual Inspection
Take a snapshot to see the current state of the canvas:
- Call get_canvas_state to capture the floorplan as a PNG screenshot
- Carefully inspect the layout — check for misaligned walls, missing doors, wrong room sizes

### Phase 3: Reprocessing
Based on your visual inspection, correct any issues:
- Use delete_element to remove incorrect elements
- Use draw_wall, place_door, place_window to fix the layout
- Call get_canvas_state again to confirm your corrections are accurate
- Repeat corrections until the structural layout matches the video

### Phase 4: Room Naming
Now that the geometry is correct, identify and label each enclosed area:
- Use label_room for each distinct room/space, placing the point inside the room's boundaries
- Include polygon vertices and wall_ids when labeling so topology is explicit and verifiable
- Classify room types from visual cues (furniture, fixtures, appliances)
- Set ceiling heights using set_ceiling_height

Continue iterating until you are confident the floorplan accurately represents the video.

## Reference Material

${skillInstructions}`,
    tools,
    beforeToolCallback: async ({ tool, args }) => {
      if (onProgress) {
        onProgress({
          type: "tool",
          name: tool.name,
          params: args as Record<string, unknown>,
        });
      }
      return undefined;
    },
  });

  const runner = new InMemoryRunner({
    agent,
    appName: "floorplan-tool",
  });

  const session = await runner.sessionService.getOrCreateSession({
    appName: "floorplan-tool",
    userId: "system",
    sessionId: `session_${Date.now()}`,
  });

  if (onProgress) {
    onProgress({ type: "skill", name: "spatial_mapping" });
  }

  const userMessage = createUserContent([
    createPartFromUri(videoUri, videoMimeType),
    createPartFromText(
      `Analyze this walkthrough video and create a complete 2D floorplan.

Please follow your workflow phases: first build the full structural layout (walls, doors, windows), then inspect the canvas snapshot, then reprocess/correct any issues, and finally label each room.

Start with Phase 1: Spatial Mapping.`
    ),
  ]);

  for await (const event of runner.runAsync({
    userId: "system",
    sessionId: session.id,
    newMessage: userMessage,
  })) {
    // Track phase transitions from agent responses
    if (event.content?.parts) {
      for (const part of event.content.parts) {
        if ("text" in part && part.text) {
          const text = part.text.toLowerCase();
          if (text.includes("phase 2") || text.includes("visual inspection")) {
            onProgress?.({ type: "skill", name: "geometry_validation" });
          } else if (text.includes("phase 3") || text.includes("reprocessing")) {
            onProgress?.({ type: "skill", name: "geometry_validation" });
          } else if (text.includes("phase 4") || text.includes("room naming")) {
            onProgress?.({ type: "skill", name: "room_labeling" });
          }
        }
      }
    }
  }

  // Get final state
  const state = await canvas.getState();
  return state.json;
}
