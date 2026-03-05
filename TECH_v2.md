# TECH_v2: Chunked Video Processing & Canvas Feedback Loop

## Problem

V1 sends the entire video to Gemini in one shot. This works for short walkthroughs (<2 min) but breaks down for:
- Long videos (5-30 min apartment tours) — token budget blows up (~300 tokens/sec × 1800s = 540K tokens for 30 min)
- Large apartments where the agent loses spatial context of early rooms by the time it reaches later rooms
- No way to correlate camera position with what's being drawn

## Approach: Chunked Sequential Processing

Split the video into time-based chunks and process each sequentially. Between chunks, send the current canvas state (PNG + JSON) back to Gemini so the agent knows what it's already drawn and where the camera is.

```
Video (10 min walkthrough)
  │
  ├─ Chunk 1: 0:00 - 2:00
  │    Agent sees: raw video frames
  │    Agent draws: living room walls, labels, dimensions
  │    Output: canvas state v1
  │
  ├─ Chunk 2: 2:00 - 4:00
  │    Agent sees: video frames + canvas state v1 (PNG) + camera position estimate
  │    Agent draws: kitchen walls, door connecting to living room
  │    Output: canvas state v2
  │
  ├─ Chunk 3: 4:00 - 6:00
  │    Agent sees: video frames + canvas state v2 (PNG) + camera position estimate
  │    Agent draws: hallway, bedroom entry
  │    Output: canvas state v3
  │
  ├─ ... continues ...
  │
  └─ Final pass: validation
       Agent sees: canvas state vN (PNG) + full video (or key frames)
       Agent validates: geometry, connections, dimensions
       Output: final floorplan
```

## Video Chunking

### Chunk Strategy

- **Default chunk duration:** 2 minutes (configurable)
- **Overlap:** 5 seconds between chunks to avoid missing transitions (doorways, hallway entries)
- **Use Gemini's `videoMetadata`** for clipping — no need to split the video file itself

```javascript
// Upload video once, reuse file URI across chunks
const uploaded = await uploadVideo(videoPath);

for (let i = 0; i < chunks.length; i++) {
  const chunk = chunks[i];
  const videoContent = createPartFromUri(uploaded.uri, uploaded.mimeType);

  // Apply clipping via videoMetadata
  const content = {
    fileData: { fileUri: uploaded.uri, mimeType: uploaded.mimeType },
    videoMetadata: {
      startOffset: `${chunk.startSec}s`,
      endOffset: `${chunk.endSec}s`,
    },
  };

  // Include canvas state from previous chunk
  const canvasContext = i > 0
    ? [canvasPngPart, canvasJsonPart, cameraPositionText]
    : [];

  const response = await agent.run([content, ...canvasContext, chunkPrompt]);
}
```

### Token Budget per Chunk

| Component | Tokens |
|---|---|
| 2 min video at 1fps | ~36,000 |
| Canvas PNG screenshot | ~1,000 |
| Canvas JSON state | ~2,000 |
| Camera position text | ~100 |
| Skill instructions | ~5,000 |
| Agent reasoning + tool calls | ~10,000 |
| **Total per chunk** | **~54,000** |

Well within the 1M context window. A 30-minute video (15 chunks) uses ~54K per chunk sequentially, never exceeding context.

## Canvas State Feedback

### What Gets Sent Between Chunks

After each chunk, capture and send to the next chunk's context:

1. **Canvas PNG screenshot** — The agent can visually see what's been drawn so far. Sent as an inline image part.
2. **Canvas JSON state** — Structured data: list of walls, doors, windows, rooms with coordinates. Lets the agent reference specific element IDs.
3. **Camera position estimate** — Text describing where the camera is at the start of the next chunk.

```javascript
const canvasState = await canvas.getState();

const canvasContext = [
  // PNG for visual inspection
  {
    inlineData: {
      mimeType: "image/png",
      data: canvasState.png.toString("base64"),
    },
  },
  // JSON for structured reference
  createPartFromText(`Current floorplan state:\n${JSON.stringify(canvasState.json, null, 2)}`),
  // Camera position
  createPartFromText(`Camera position at ${chunk.startSec}s: ${cameraEstimate}`),
];
```

### When to Send Canvas State

- **Between every chunk** — always include the latest PNG + JSON
- **After self-corrections** — if the agent deletes/redraws elements, capture updated state
- **Before the final validation pass** — the agent sees the complete floorplan for final review

## Camera Position Estimation

### How It Works

The agent estimates camera position from visual cues in the video:

1. **Room transitions** — When the camera passes through a doorway, the agent knows it moved to an adjacent room
2. **Orientation cues** — Windows (exterior wall), kitchen appliances (kitchen), bathroom fixtures (bathroom)
3. **Movement direction** — Relative to the floorplan being built, which direction is the camera facing

### Camera Position Format

```
Camera position at 120s: In the hallway, facing south toward bedroom door.
Previously visited: living room (0:00-1:30), kitchen (1:30-2:00).
The camera is about to enter the master bedroom.
```

The agent generates this estimate at the end of each chunk as part of its tool output. A new tool is needed:

| Tool | Parameters | What it does |
|---|---|---|
| `set_camera_position` | `room: string`, `facing: "north"\|"south"\|"east"\|"west"`, `notes: string` | Record estimated camera position for handoff to next chunk |

### Prompt for Camera Tracking

The agent's instructions include:

```
At the end of processing each video segment, call set_camera_position to record
where the camera is. This helps you orient yourself when processing the next segment.
Consider: which room are you in? Which direction are you facing? What room are you
about to enter?
```

## Implementation Plan

### New/Modified Files

| File | Changes |
|---|---|
| `lib/chunker.ts` | **New.** Split video duration into chunks with overlap. Calculate chunk boundaries. |
| `lib/agent.ts` | Modify `generateFloorplan` to process chunks sequentially. Pass canvas state + camera position between chunks. Add `set_camera_position` tool. |
| `lib/types.ts` | Add `CameraPosition`, `VideoChunk`, `ChunkProgress` types. |
| `app/api/floorplan/route.ts` | Update SSE events to include chunk progress (e.g., "Processing chunk 3/7"). |
| `app/page.tsx` | Update debug panel to show chunk boundaries and camera position updates. |
| `skills/room_identification/SKILL.md` | Add instructions for multi-chunk context: "You may receive a canvas screenshot showing rooms already drawn by a previous chunk." |
| `skills/spatial_mapping/SKILL.md` | Add instructions for connecting rooms across chunk boundaries. |

### New Types

```typescript
interface VideoChunk {
  index: number;
  startSec: number;
  endSec: number;
  overlapSec: number;
}

interface CameraPosition {
  room: string;
  facing: "north" | "south" | "east" | "west";
  notes: string;
  timestamp_sec: number;
}

interface ChunkProgress {
  currentChunk: number;
  totalChunks: number;
  phase: "processing" | "capturing_state" | "transitioning";
}
```

### Chunker Logic

```typescript
// lib/chunker.ts
export function createChunks(
  durationSec: number,
  chunkDurationSec = 120,
  overlapSec = 5
): VideoChunk[] {
  const chunks: VideoChunk[] = [];
  let start = 0;
  let index = 0;

  while (start < durationSec) {
    const end = Math.min(start + chunkDurationSec, durationSec);
    chunks.push({ index, startSec: start, endSec: end, overlapSec });
    start = end - overlapSec; // overlap with next chunk
    index++;
  }

  return chunks;
}
```

### Agent Loop (Modified)

```typescript
export async function generateFloorplan(
  videoUri: string,
  mimeType: string,
  durationSec: number,
  onProgress?: ProgressCallback
): Promise<FloorplanState> {
  const canvas = new FloorplanCanvas();
  const tools = createTools(canvas); // includes new set_camera_position
  const chunks = createChunks(durationSec);
  let cameraPosition: CameraPosition | null = null;

  for (const chunk of chunks) {
    onProgress?.({
      type: "chunk",
      current: chunk.index + 1,
      total: chunks.length,
    });

    // Build context for this chunk
    const parts = [];

    // 1. Video segment (clipped)
    parts.push({
      fileData: { fileUri: videoUri, mimeType },
      videoMetadata: {
        startOffset: `${chunk.startSec}s`,
        endOffset: `${chunk.endSec}s`,
      },
    });

    // 2. Canvas state from previous chunks (if any)
    if (chunk.index > 0) {
      const state = await canvas.getState();
      parts.push({
        inlineData: {
          mimeType: "image/png",
          data: state.png.toString("base64"),
        },
      });
      parts.push(createPartFromText(
        `Current floorplan (${state.json.rooms.length} rooms drawn so far):\n` +
        JSON.stringify(state.json, null, 2)
      ));
    }

    // 3. Camera position from previous chunk
    if (cameraPosition) {
      parts.push(createPartFromText(
        `Camera position at start of this segment: ` +
        `In ${cameraPosition.room}, facing ${cameraPosition.facing}. ` +
        `${cameraPosition.notes}`
      ));
    }

    // 4. Chunk-specific prompt
    parts.push(createPartFromText(
      chunk.index === 0
        ? "Analyze this video segment and begin drawing the floorplan."
        : `Continue building the floorplan from this next video segment (${chunk.startSec}s - ${chunk.endSec}s). ` +
          `The canvas screenshot shows what you've drawn so far. Add new rooms and connections visible in this segment. ` +
          `Do not redraw rooms that already exist.`
    ));

    // Run agent for this chunk
    await runAgentOnChunk(agent, parts, session);

    // Capture camera position for next chunk
    cameraPosition = canvas.getLastCameraPosition();

    onProgress?.({
      type: "snapshot",
      message: `Chunk ${chunk.index + 1}/${chunks.length} complete`,
    });
  }

  // Final validation pass — full canvas review
  onProgress?.({ type: "skill", name: "geometry_validation" });
  const finalState = await canvas.getState();
  await runValidationPass(agent, finalState, session);

  return (await canvas.getState()).json;
}
```

### SSE Events (New)

New event types for chunk progress:

```json
{"type": "chunk", "current": 3, "total": 7, "message": "Processing chunk 3/7 (4:00-6:00)", "elapsed_ms": 45000}
{"type": "system", "message": "Capturing canvas state for chunk handoff", "elapsed_ms": 46000}
{"type": "system", "message": "Camera at 6:00: In hallway, facing south", "elapsed_ms": 46500}
```

### Debug Panel Updates

The debug panel should show:
- Chunk boundaries as visual separators: `━━━ Chunk 2/7 (2:00-4:00) ━━━`
- Camera position updates highlighted in a distinct color
- Canvas state captures marked clearly

## Limits Summary

| Parameter | Free Tier | Paid Tier |
|---|---|---|
| Max file size (File API) | 2GB | 20GB |
| Max video duration (practical) | ~1 hour at 1fps | ~1 hour at 1fps |
| Chunk duration | 2 min (default, configurable) | 2 min (default, configurable) |
| Tokens per chunk | ~54K | ~54K |
| Context window | 1M tokens | 1M tokens |
| Max chunks per video | Unlimited (sequential) | Unlimited (sequential) |
| File API retention | 48 hours | 48 hours |

## Open Questions

1. **Video duration detection** — We need to know the video length to calculate chunks. Options: ffprobe (requires ffmpeg), or ask Gemini to report duration from metadata in a quick pre-pass.
2. **Adaptive chunk sizing** — Should we adjust chunk duration based on video content? Slow walkthroughs (one room per minute) could use longer chunks, fast tours shorter.
3. **Parallel chunk processing** — Could we process non-overlapping chunks in parallel for speed? Risk: rooms that span chunk boundaries would be drawn twice. Sequential is safer for V2.
4. **Canvas state compression** — For very complex floorplans, the JSON could get large. Consider sending only deltas (new elements since last chunk) instead of full state.

## References

- [Gemini Video Understanding — Video Clipping](https://ai.google.dev/gemini-api/docs/video-understanding#javascript)
- [Gemini 3.1 Pro Preview](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview) — 1M context, 65K output
- [ADK Skills](https://google.github.io/adk-docs/skills/#define-skills-with-files)
