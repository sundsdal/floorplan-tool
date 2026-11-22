# Common Geometry Errors and Fixes

This reference covers the most frequent geometry errors in generated floorplans and how to correct them.

## 1. Wall Gaps

**Error:** Two walls that should meet at a corner have a small gap between their endpoints.

**Detection:** Check that for every room, each wall's endpoint matches the next wall's start point exactly. A gap of more than 0.01m indicates an error.

**Fix:** Delete the shorter wall and redraw it so its endpoint meets the adjacent wall's start point exactly. Use the same coordinates for both endpoints.

## 2. Overlapping Rooms

**Error:** Two room polygons overlap, meaning some floor area is claimed by both rooms.

**Detection:** Check if any wall from room A crosses (intersects) any wall from room B that is not a shared wall. If walls cross, the rooms overlap.

**Fix:** Identify the shared wall between the rooms. Adjust the non-shared walls of one room so they stop at the shared wall boundary. Delete and redraw the offending walls.

## 3. Doors Placed Outside Wall Bounds

**Error:** A door's position plus its width exceeds the length of the wall it is placed on.

**Detection:** For each door, verify: `position_along_m + width_m <= wall_length_m`. Also verify: `position_along_m >= 0`.

**Fix:** Delete the door. Recalculate its position so it fits within the wall. Re-place the door with corrected position.

## 4. Mismatched Shared Wall Lengths

**Error:** Room A thinks the shared wall with room B is 4.0m long, but room B's corresponding wall is 3.8m long.

**Detection:** For every pair of adjacent rooms, find walls that should be shared (same position, same orientation). Their lengths must match.

**Fix:** Determine the correct length by checking the video reference. Delete both walls and redraw them at the agreed length. Update dimension annotations.

## 5. Rooms With Only 2 Walls

**Error:** A room is defined with only 2 wall segments, which cannot form a closed polygon.

**Detection:** Count walls per room. Any room with fewer than 3 walls is invalid.

**Fix:** Review the video for the missing walls. Draw the missing wall segments to close the polygon. Rooms typically have 4 walls (rectangular) but can have 3 (triangular corner), 5, or more (L-shaped rooms are decomposed into rectangles).

## 6. Non-Orthogonal Walls (Unintentional)

**Error:** Walls that should be perfectly horizontal or vertical are slightly angled due to imprecise coordinate placement.

**Detection:** Check if a wall's angle is within 5 degrees of 0, 90, 180, or 270 degrees. If so, it was likely intended to be axis-aligned.

**Fix:** Snap the wall endpoints so the wall is perfectly horizontal or vertical. Adjust the endpoint that causes the least disruption to adjacent walls.

## 7. Overlapping Doors or Windows on Same Wall

**Error:** Two doors or windows on the same wall overlap each other.

**Detection:** For each wall, sort all features (doors, windows) by position. Check that `feature_n.position + feature_n.width <= feature_(n+1).position`.

**Fix:** Recalculate positions so features don't overlap. Maintain minimum 0.1m gap between features on the same wall.

## 8. Total Area Implausibility

**Error:** The total computed area is unrealistic for the type of dwelling.

**Detection:** Sum all room areas. Compare against expected ranges for the dwelling type.

**Fix:** Review the largest rooms — these are most likely to have dimension errors. Check if any room's dimensions are roughly double what they should be (common error: using the wrong reference object scale). Correct and re-annotate.

## Error Priority

Fix errors in this order:
1. Wall gaps and unclosed polygons (fundamental geometry)
2. Overlapping rooms (spatial consistency)
3. Mismatched shared walls (room-to-room consistency)
4. Door/window placement (feature placement)
5. Total area check (sanity check)
