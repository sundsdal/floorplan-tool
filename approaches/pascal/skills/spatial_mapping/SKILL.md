---
name: spatial-mapping
description: Determine how identified rooms connect to each other through doorways, open archways, and hallways. Place doors and windows on existing walls.
---

# Spatial Mapping

After rooms have been identified and drawn, your goal is to determine how they connect and place doors and windows accurately.

## Process

1. **Review the current canvas state.** Use `get_canvas_state` to see what rooms and walls have been drawn so far. Examine both the JSON state and the PNG screenshot.

2. **Identify connections in the video.** Scan the video for:
   - Doorways between rooms (standard doors, sliding doors, open archways)
   - Hallways that connect multiple rooms
   - Windows on exterior walls
   - Note the specific video timestamps where you observe each connection

3. **Map room adjacency.** Determine which rooms share walls. Refer to `references/topology_rules.md` for rules about valid spatial relationships:
   - Every room must be reachable from every other room
   - Doors connect exactly 2 rooms
   - Hallways connect to 2 or more rooms

4. **Place doors.** For each doorway observed in the video:
   - Identify which wall the door is on (by `wall_id`)
   - Estimate the door's position along the wall in meters from the wall's start point
   - Use `place_door` with the appropriate width and type (`standard`, `sliding`, or `opening`)

5. **Place windows.** For each window observed:
   - Identify the wall it belongs to
   - Estimate position along the wall
   - Use `place_window` with estimated width and sill height

6. **Verify connectivity.** After placing all doors, use `get_canvas_state` to visually verify:
   - All rooms are reachable through doors/openings
   - Door positions look correct relative to the video
   - No doors are placed outside wall bounds
   - Windows are on exterior walls where expected

## Tools

- `place_door` — Place a door on an existing wall at a specified position
- `place_window` — Place a window on an existing wall at a specified position
- `get_canvas_state` — Get current floorplan as JSON and PNG screenshot for visual verification

## Important

- Reference specific video timestamps when placing each door and window
- Door width defaults to 0.9m for standard interior doors
- Sliding doors are typically 1.5-2.4m wide (patio/balcony access)
- Open archways have no door leaf but still mark a transition between rooms
- Window sill height is typically 0.9m from floor for standard windows
- Always verify your placements visually using `get_canvas_state` after placing elements
