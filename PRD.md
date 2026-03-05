# PRD: Video-to-Floorplan Generator

## Overview

A React web app that takes a walkthrough video of a room/apartment/house and generates a 2D floorplan using Gemini 3.1 Pro Preview's video understanding capabilities. The app estimates dimensions (lengths, heights) in meters and renders an interactive floorplan on a canvas.

**Platform:** Web app (desktop-first, modern browsers)
**Stack:** Next.js (React) with Node.js runtime, JavaScript/TypeScript
**AI:** [Gemini 3.1 Pro Preview](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview) (`gemini-3.1-pro-preview`)
**Model specs:** 1M token context window, 65K output tokens, supports text/image/video/audio/PDF input

### Reference Documentation

- [Gemini 3.1 Pro Preview — Model Card](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview)
- [Gemini Video Understanding API (JavaScript)](https://ai.google.dev/gemini-api/docs/video-understanding#javascript)
- [Google ADK for TypeScript (adk-js)](https://github.com/google/adk-js)
- [ADK Skills — Define Skills with Files](https://google.github.io/adk-docs/skills/#define-skills-with-files)

---

## Problem

Creating floorplans is tedious. You need measuring tools, drawing software, and spatial reasoning skills. A walkthrough video captured on a phone contains all the visual information needed to reconstruct a layout — walls, doors, windows, room dimensions — but extracting that into a structured floorplan requires manual effort.

---

## V1 Scope

### Core Flow

1. User drops or selects a video file (MP4, MOV, etc.)
2. Frontend uploads video to a Next.js API route
3. Server-side route uploads video to Gemini via the File API
4. Gemini analyzes the video and extracts room layout data via ADK agent loop
5. Frontend renders a 2D floorplan on a canvas with estimated dimensions
6. User can export the floorplan as PNG/SVG

### Video Processing

- **Upload:** Use the Gemini File API (`@google/genai` SDK) for videos of any size (up to 2GB free tier)
- **Supported formats:** MP4, MOV, AVI, WebM, MPEG, WMV, 3GPP
- **Frame rate:** Default 1 fps; configurable for fast-panning videos (up to 5 fps)
- **Video clipping:** Allow user to trim start/end offsets before processing
- **Token budget:** ~300 tokens/sec at standard resolution. A 2-minute walkthrough ≈ 36K tokens — well within the 1M context window

```javascript
import { GoogleGenAI, createUserContent, createPartFromUri } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const file = await ai.files.upload({
  file: videoPath,
  config: { mimeType: "video/mp4" },
});

const response = await ai.models.generateContent({
  model: "gemini-3.1-pro-preview",
  contents: createUserContent([
    createPartFromUri(file.uri, file.mimeType),
    FLOORPLAN_EXTRACTION_PROMPT,
  ]),
});
```

### Agentic Loop (via Google ADK)

The agentic loop is powered by [Google Agent Development Kit (ADK) for TypeScript](https://github.com/google/adk-js) — an open-source, code-first framework optimized for Gemini. ADK manages the reasoning loop, tool selection, and multi-step execution natively, so we don't manually orchestrate passes.

**Why ADK:** Gemini 3.1 Pro Preview is specifically optimized for agentic workflows with precise tool usage and multi-step execution. ADK is the official framework that unlocks this — the model decides which tools to call and when, iterating until the floorplan is complete and validated.

**Agent definition:**

```javascript
import { LlmAgent, FunctionTool } from "@google/adk";
import { z } from "zod";

const floorplanAgent = new LlmAgent({
  name: "floorplan_extractor",
  model: "gemini-3.1-pro-preview",
  instructions: `You are a floorplan extraction agent. You analyze walkthrough videos
    of rooms/apartments and produce structured floorplan data. Use the provided tools
    to incrementally build the floorplan. Estimate all dimensions in meters using
    reference objects (standard doors ~0.9m wide, ceiling heights ~2.5-2.7m).
    Call tools in order: identify rooms → map connections → validate geometry.
    Continue until confidence ≥ 0.8 or you've exhausted analysis.`,
  tools: [identifyRoomsTool, mapConnectionsTool, validateGeometryTool, finalizeFloorplanTool],
});
```

**Server-side canvas (dual rendering):**

Since the ADK agent runs server-side (Next.js API route) but the user sees the floorplan client-side (React), canvas rendering happens in two stages:

1. **Server-side (`@napi-rs/canvas`):** The agent draws on a headless Node.js canvas during the agentic loop. This is where `draw_wall`, `place_door`, etc. execute. When the agent calls `get_canvas_state`, the server canvas renders a PNG screenshot and returns it alongside the JSON state — the agent visually inspects its own work without any client round-trip.
2. **Client-side (HTML Canvas / Konva.js):** Once the agent loop completes, the final floorplan data (JSON) is sent to the client. React renders it on an interactive HTML canvas with pan, zoom, and export. The client never participates in the agent loop.

This keeps the agent loop self-contained on the server — no WebSocket round-trips, no latency from client rendering mid-loop. The client is purely for display and interaction after generation.

```
┌─────────────────── Server (Node.js API route) ───────────────────┐
│                                                                   │
│  Video → Gemini → ADK Agent Loop                                  │
│                    ↕                                              │
│              @napi-rs/canvas (headless)                           │
│              - draw_wall, place_door, etc. mutate server canvas   │
│              - get_canvas_state → PNG screenshot + JSON           │
│              - agent visually self-checks via screenshot          │
│                    ↓                                              │
│              Final floorplan JSON                                 │
│                                                                   │
└──────────────────────────┬────────────────────────────────────────┘
                           │ Response (JSON)
                           ▼
┌─────────────────── Client (React) ───────────────────────────────┐
│                                                                   │
│  Floorplan JSON → Konva.js / HTML Canvas                         │
│  - Interactive rendering (pan, zoom, hover)                      │
│  - Export PNG/SVG                                                │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

**Tools (drawing primitives):**

The agent reasons about the video (identifying rooms, estimating dimensions) and expresses its understanding by calling drawing tools. The tools are low-level operations on the server-side canvas — the intelligence is in the model, not the tools.

| Tool | Parameters | What it does |
|---|---|---|
| `draw_wall` | `start: {x, y}`, `end: {x, y}`, `thickness_m: number`, `height_m: number` | Draw a wall segment between two points |
| `place_door` | `wall_id: string`, `position_along_m: number`, `width_m: number`, `type: "standard" \| "sliding" \| "opening"` | Cut a door into an existing wall |
| `place_window` | `wall_id: string`, `position_along_m: number`, `width_m: number`, `sill_height_m: number` | Cut a window into an existing wall |
| `label_room` | `point: {x, y}`, `name: string`, `type: "bedroom" \| "kitchen" \| "bathroom" \| ...` | Label an enclosed area as a room |
| `annotate_dimension` | `start: {x, y}`, `end: {x, y}`, `label: string` | Add a dimension line with measurement text |
| `set_ceiling_height` | `room_label: string`, `height_m: number` | Set the ceiling height for a labeled room |
| `delete_element` | `element_id: string` | Remove a wall, door, or window (for corrections) |
| `get_canvas_state` | — | Returns current floorplan as JSON state **and** a PNG screenshot of the canvas, so the agent can visually inspect its own work |

```javascript
const drawWallTool = new FunctionTool({
  name: "draw_wall",
  description: "Draw a wall segment between two points. Coordinates are in meters. Returns the wall ID.",
  schema: z.object({
    start: z.object({ x: z.number(), y: z.number() }),
    end: z.object({ x: z.number(), y: z.number() }),
    thickness_m: z.number().default(0.15),
    height_m: z.number().default(2.7),
  }),
  execute: async ({ start, end, thickness_m, height_m }) => {
    const wall = canvas.addWall(start, end, thickness_m, height_m);
    return { wall_id: wall.id, length_m: wall.length };
  },
});

const placeDoorTool = new FunctionTool({
  name: "place_door",
  description: "Place a door on an existing wall. Specify position along the wall in meters from the wall's start point.",
  schema: z.object({
    wall_id: z.string(),
    position_along_m: z.number(),
    width_m: z.number().default(0.9),
    type: z.enum(["standard", "sliding", "opening"]).default("standard"),
  }),
  execute: async ({ wall_id, position_along_m, width_m, type }) => {
    const door = canvas.addDoor(wall_id, position_along_m, width_m, type);
    return { door_id: door.id };
  },
});
```

**Skills (high-level workflows):**

ADK [Skills](https://google.github.io/adk-docs/skills/) are self-contained units of functionality that load incrementally — instructions + references + assets — without bloating the context window. The agent's complex reasoning workflows are defined as skills, not tools.

```
skills/
  room_identification/
    SKILL.md              # Instructions for scanning video, identifying rooms,
                          # estimating dimensions using reference objects
    references/
      dimension_guide.md  # Standard object sizes (doors, counters, bathtubs)
      room_types.md       # Room classification taxonomy
    assets/
      room_schema.json    # Expected output schema for room data

  spatial_mapping/
    SKILL.md              # Instructions for determining room connectivity,
                          # door placements, hallway routing
    references/
      topology_rules.md   # Rules for valid spatial relationships
    assets/
      connection_schema.json

  geometry_validation/
    SKILL.md              # Instructions for cross-checking dimensions,
                          # detecting overlaps, ensuring shared walls match
    references/
      common_errors.md    # Typical geometry mistakes and how to fix them
    assets/
      validation_schema.json
```

| Skill | Triggers when | Uses tools |
|---|---|---|
| `room_identification` | Agent starts analyzing a new video | `draw_wall`, `label_room`, `set_ceiling_height`, `annotate_dimension` |
| `spatial_mapping` | Rooms are drawn, agent maps connections | `place_door`, `place_window`, `get_canvas_state` |
| `geometry_validation` | Layout is complete, agent self-checks | `get_canvas_state`, `delete_element`, `draw_wall`, `annotate_dimension` |

**How the loop works:** The agent loads a skill (e.g., `room_identification`), which gives it detailed instructions and reference material. It then uses the drawing tools to express what it sees in the video — wall by wall, door by door. When it transitions to mapping connections, the `spatial_mapping` skill loads with its own instructions. Finally, `geometry_validation` loads to self-check — `get_canvas_state` returns both the JSON state and a **PNG screenshot** of the canvas. The agent visually compares its drawing against the original video frames, spots misaligned walls or missing doors, and uses `delete_element` + `draw_wall` to correct them. This visual feedback loop is key — structured data alone can't catch all spatial errors. ADK manages this loop and context loading automatically.

The `gemini-3.1-pro-preview` model's **thinking mode** is used for spatial reasoning — estimating where walls meet, inferring room dimensions from reference objects, and self-correcting geometry.

**Structured output format (per room):**

```json
{
  "rooms": [
    {
      "id": "room_1",
      "type": "bedroom",
      "width_m": 3.5,
      "length_m": 4.2,
      "height_m": 2.7,
      "walls": [
        { "id": "wall_1", "length_m": 3.5, "features": [
          { "type": "window", "width_m": 1.2, "position_from_left_m": 1.0 },
          { "type": "door", "width_m": 0.9, "position_from_left_m": 0.2, "connects_to": "room_2" }
        ]}
      ],
      "polygon": [[0,0], [3.5,0], [3.5,4.2], [0,4.2]]
    }
  ],
  "total_area_m2": 65.0,
  "confidence": 0.85
}
```

### Canvas Rendering

- Use **HTML Canvas** (or a lightweight lib like Konva.js / Fabric.js) to draw the floorplan
- Render walls, doors (arc symbol), windows (break in wall), room labels, and dimension annotations
- Pan & zoom support
- Grid snapping for clean geometry
- Color-code rooms by type
- Display total area (m²) and per-room dimensions

### UI

Single-page React app:

```
┌──────────────────────────────────────────────┐
│ FloorPlan AI                                 │
├──────────────────────────────────────────────┤
│                                              │
│  [Drop video here or click to browse]        │
│  [Generate Floorplan]                        │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │         Canvas / Floorplan             │  │
│  │         (pan + zoom)                   │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  Status: Analyzing rooms (pass 2/4)...       │
│  [Export PNG] [Export SVG]                   │
└──────────────────────────────────────────────┘
```

**Settings panel (drawer or modal):**
- Gemini API key configured on server (`.env.local` for local dev, server env in deployment)
- Frame rate override (1–5 fps)
- Video trim (start/end seconds)

### Export

- **PNG:** Rasterize canvas at 2x resolution
- **SVG:** Export vector floorplan with dimension labels

---

## Technical Architecture

```
app/
  page.tsx            # Main UI (upload + canvas + status)
  api/
    floorplan/route.ts # Upload + generation endpoint (Node runtime)
components/
  canvas.tsx          # Floorplan rendering engine
lib/
  agent.ts            # ADK agent setup, tool registration, loop execution
  gemini.ts           # Gemini File API client
  server-canvas.ts    # @napi-rs/canvas headless rendering + PNG screenshot
  types.ts            # Room/wall/feature data structures
  export.ts           # PNG/SVG export helpers
  validation.ts       # Schema and geometry checks
skills/
  ...                 # ADK skills (room_identification, spatial_mapping, geometry_validation)
prompts/
  room-identify.txt
  spatial-relations.txt
  refinement.txt
  validation.txt
public/
  ...                 # Static assets
next.config.js
package.json          # App dependencies and scripts
```

**Important runtime note:** Next.js API routes used by ADK must run on `nodejs` runtime (not Edge).

**Key dependencies:**
- `@google/adk` — Google Agent Development Kit (manages agentic loop, tool orchestration)
- `@google/genai` — Gemini SDK (video upload via File API)
- `zod` — Schema validation for ADK tool definitions
- `next` + `react` + `react-dom` — Unified app shell (UI + API routes)
- `@napi-rs/canvas` — Server-side headless canvas for agent drawing + screenshot (Node.js native, no system deps)
- `konva` or `fabric` — Client-side interactive canvas rendering

**Build:** `next build` (Bun/npm/pnpm scripts).
**Runtime:** Node.js 24.13.0+ for Next server runtime (required by ADK) + modern desktop browser frontend.

---

## Run Locally

1. Install Node.js `24.13.0+`
2. Create `.env.local` in the project root:
   - `GEMINI_API_KEY=your_api_key_here`
3. Install dependencies: `npm install`
4. Start dev server: `npm run dev`
5. Open `http://localhost:3000`

**Expected scripts:**
- `npm run dev` → starts Next.js in development mode
- `npm run build` → production build
- `npm run start` → run production server

---

## Estimation Approach

Gemini estimates dimensions using visual cues from the video:
- Standard door widths (~0.8–0.9m) as reference objects
- Standard ceiling heights (~2.5–2.7m) as reference
- Relative proportions between objects (furniture, appliances)
- Pacing speed if the camera moves at walking speed (~1.2m/s)
- Known object sizes (standard bathtubs, kitchen counters, beds)

The prompts instruct Gemini to state its confidence and reasoning for each measurement, and to flag any estimates below 60% confidence.

---

## V2 — Future Scope (not in V1)

### Room Layout Optimization
- Take the extracted floorplan and propose better furniture arrangements
- Suggest bed, desk, closet, bookshelf placements
- Optimize for traffic flow, natural light, and space utilization

### 3D Visualization
- Generate 3D representations of proposed layouts
- Use Gemini's image generation or a 3D rendering library (Three.js)
- Show furniture in realistic proportions
- Multiple layout options per room

### Additional V2 Features
- Before/after comparison view
- Furniture catalog with real dimensions
- Style presets (minimalist, cozy, office)
- Share/export 3D renders

---

## Success Criteria (V1)

1. Can process a 1–3 minute walkthrough video and produce a floorplan within 60 seconds
2. Room count accuracy ≥ 90% for standard apartments (1–4 rooms)
3. Dimension estimates within ±20% of actual measurements
4. All rooms properly connected (doors/openings match)
5. Clean, readable floorplan output with labeled dimensions

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Poor video quality / shaky footage | Prompt instructs Gemini to flag low-confidence areas; suggest re-recording tips |
| Dimension estimates are way off | Use reference objects (doors, standard furniture) as anchors; show confidence scores |
| Complex floor layouts (L-shaped, split-level) | Agentic loop with validation pass catches geometric inconsistencies |
| Gemini API rate limits / costs | Cache file uploads (reuse `file.uri`); minimize passes when confidence is high early |
| Large video files slow upload | Show progress bar; support video trimming to reduce upload size |
