---
name: geometry-validation
description: Review the drawn floorplan for geometric errors, validate dimensions, and correct any issues found.
---

# Geometry Validation

The floorplan layout is complete. Your goal is to review it for geometric errors, validate measurements, and fix any issues.

## Process

1. **Get the current state.** Use `get_canvas_state` to retrieve both the JSON representation and a PNG screenshot of the floorplan. You will use both for validation.

2. **Check closed polygons.** Every room must be a closed polygon — all walls must connect end-to-end with no gaps. Look for:
   - Wall endpoints that don't quite meet (small gaps)
   - Rooms with fewer than 3 walls (impossible geometry)
   - Walls that overshoot past their intersection point

3. **Validate shared walls.** When two rooms share a wall, that wall segment must have the same length and position from both rooms' perspectives. Mismatched shared walls are one of the most common errors. Refer to `references/common_errors.md`.

4. **Check for overlaps.** Room polygons must not overlap. No point should be inside two rooms simultaneously. Check that adjacent rooms share a wall boundary but don't extend into each other.

5. **Verify door and window placement.** For each door and window:
   - It must be placed within its wall's length (position + width must not exceed wall length)
   - Doors must not overlap with other doors or windows on the same wall
   - Doors on shared walls should be visible from both rooms

6. **Validate total area.** Sum up all room areas. The total should be plausible for the type of dwelling visible in the video:
   - Studio apartment: 25 - 45 m²
   - 1-bedroom apartment: 40 - 65 m²
   - 2-bedroom apartment: 55 - 90 m²
   - 3-bedroom apartment: 75 - 120 m²
   - Small house: 80 - 150 m²
   - Medium house: 120 - 250 m²

7. **Fix errors.** For each error found:
   - Use `delete_element` to remove the incorrect wall, door, or window
   - Use `draw_wall` to redraw the corrected wall
   - Use `get_canvas_state` again to verify the fix visually

8. **Final visual check.** After all corrections, use `get_canvas_state` one more time. Compare the screenshot against what you observed in the video. The floorplan should look like a reasonable representation of the space.

## Tools

- `get_canvas_state` — Get current floorplan as JSON and PNG screenshot for inspection
- `delete_element` — Remove a wall, door, or window by its element ID
- `draw_wall` — Redraw corrected wall segments
- `annotate_dimension` — Add or update dimension labels after corrections

## Important

- Always verify fixes visually with `get_canvas_state` after making corrections
- Prefer small targeted fixes over redrawing large sections
- If a wall needs to be repositioned, delete it first, then redraw
- Keep dimension annotations up to date after any wall changes
- Log each error found and how it was corrected for transparency
