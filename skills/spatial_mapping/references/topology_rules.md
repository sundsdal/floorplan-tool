# Topology Rules for Room Connectivity

These rules define valid spatial relationships in residential floorplans. Use them to verify and correct the room connectivity map.

## Fundamental Rules

1. **Reachability.** Every room must be reachable from every other room through a chain of doors, openings, or hallways. There must be no isolated rooms.

2. **Door connectivity.** Each door connects exactly 2 rooms. A door is always placed on a shared wall between two adjacent rooms.

3. **Hallway connectivity.** Hallways must connect to at least 2 rooms. A hallway with only one door is invalid — it would be a dead end with no purpose.

4. **Exterior access.** At least one room must have a door to the exterior (entry door). This is typically the entryway, hallway, or living room.

## Common Adjacency Patterns

These patterns describe how rooms typically connect in residential spaces. Use them as soft constraints — deviations are possible but should be verified.

### Bathroom Connectivity
- Bathrooms typically connect to hallways or bedrooms (en-suite)
- Bathrooms rarely connect directly to kitchens or living rooms
- A master bedroom often has a direct door to an en-suite bathroom

### Kitchen Connectivity
- Kitchens typically connect to living rooms, dining rooms, or hallways
- Open-plan kitchens share an open archway or no wall with living/dining area
- Kitchens rarely connect directly to bedrooms

### Bedroom Connectivity
- Bedrooms connect to hallways, other bedrooms (rare), or bathrooms (en-suite)
- Most bedrooms have exactly one door (to a hallway or landing)
- Bedrooms may have a second door to a walk-in closet or en-suite

### Hallway Connectivity
- Hallways are the main arteries — they connect to many rooms
- A central hallway typically has 3-6 doors along its length
- L-shaped or T-shaped hallways are common

### Closet Connectivity
- Closets connect to exactly one room (bedroom, hallway, or entryway)
- Walk-in closets are accessed from a bedroom or hallway

## Validation Checks

After mapping all connections, verify:

1. **Graph connectivity:** Build a room adjacency graph. Run a traversal from any room — all rooms must be visited.
2. **Door count per room:** Most rooms have 1-3 doors. A room with 0 doors is invalid (unreachable). A room with more than 4 doors is unusual and should be verified.
3. **Shared wall consistency:** If room A connects to room B via a door, they must share a wall in the geometry.
4. **No duplicate doors:** The same wall segment should not have overlapping doors.
5. **Window placement:** Windows should only appear on exterior walls (walls that border the outside, not another room).
