---
name: room-identification
description: Scan a walkthrough video frame by frame to identify distinct rooms, classify them by type, and estimate dimensions in meters using visible reference objects.
---

# Room Identification

You are analyzing a walkthrough video of a residential space. Your goal is to identify every distinct room, classify it, and estimate its dimensions.

## Process

1. **Scan the video systematically.** Step through the video frame by frame. Note timestamps where new rooms appear.

2. **Identify room boundaries.** Look for walls, doorways, changes in flooring material, changes in ceiling texture or height, and transitions through openings. Each enclosed or semi-enclosed area is a distinct room.

3. **Classify each room.** Use visual cues to determine the room type. Refer to `references/room_types.md` for classification guidance. Assign one of: `bedroom`, `kitchen`, `bathroom`, `living_room`, `dining_room`, `hallway`, `closet`, `balcony`, `office`, `laundry`, `garage`, `basement`, `stairs`, `attic`, `other`. Note: entryways/foyers should be classified as `hallway`. Staircases should be labeled as `stairs`.

4. **Estimate dimensions.** Use reference objects visible in the video to anchor your measurements. Refer to `references/dimension_guide.md` for standard object sizes. Common anchors:
   - Interior doors are 0.8-0.9m wide and 2.0-2.1m tall
   - Standard ceiling height is 2.4-2.7m
   - Kitchen counters are 0.9m high and 0.6m deep
   - Beds, bathtubs, and toilets have known standard sizes

5. **Draw each room.** For every room you identify:
   - Use `draw_wall` to draw each wall segment with estimated coordinates in meters
   - Use `label_room` to label the enclosed area with its name and type, including `polygon` vertices and `wall_ids` for the enclosing walls
   - Use `set_ceiling_height` to record the ceiling height
   - Use `annotate_dimension` to add measurement labels on key walls

6. **State your confidence.** For each dimension estimate, note whether you have high confidence (reference object clearly visible), medium confidence (proportional estimate), or low confidence (rough guess). Flag any estimate below 60% confidence.

## Tools

- `draw_wall` — Draw wall segments between coordinate points (meters)
- `label_room` — Label an enclosed area with a name and room type
- `set_ceiling_height` — Set ceiling height for a labeled room
- `annotate_dimension` — Add dimension annotation lines with measurement text

## Important

- Process rooms in the order they appear in the video
- Use consistent coordinate system: origin (0,0) at the first room's corner
- Walls shared between rooms must align exactly at the same coordinates
- Standard wall thickness is 0.15m unless evidence suggests otherwise
