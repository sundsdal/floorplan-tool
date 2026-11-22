---
name: room-labeling
description: Detect and classify room types from visual cues in the video, then label each room on the floorplan with its type and name.
---

# Room Labeling

After walls are drawn, label every enclosed area with an appropriate room type and human-readable name. The label should appear inside the room boundaries.

## Detection Strategy

Classify rooms by analyzing visual cues in the video frames:

1. **Scan for fixtures and furniture.** Each room type has distinctive visual indicators. See `references/room_detection_cues.md` for the full mapping.

2. **Assign a room type.** Pick the best-matching type from: `bedroom`, `kitchen`, `bathroom`, `living_room`, `dining_room`, `hallway`, `closet`, `balcony`, `office`, `laundry`, `garage`, `basement`, `stairs`, `attic`, `other`.

3. **Give a descriptive name.** Use contextual names like "Master Bedroom", "Guest Bathroom", "Main Hallway". For duplicates, number them ("Bedroom 1", "Bedroom 2").

4. **Place the label.** Call `label_room` with:
   - A point at the visual center of the room polygon
   - The ordered `polygon` vertices for the room boundary
   - The `wall_ids` that define that boundary
   The label should not overlap walls or doors.

## Rules

- Every enclosed area must be labeled — no unlabeled rooms
- Rooms visible in the video but only partially shown should still be labeled with best-guess type
- If the room type is ambiguous (e.g., a den that could be an office or bedroom), pick the dominant use based on furniture
- Stairs should be labeled even if they're just a passage — use type `stairs`
- Storage areas under stairs or small closets should use type `closet`
- Use `basement` for any below-grade space, `attic` for above-ceiling spaces

## Tools

- `label_room` — Label a room with name, type, center point, boundary polygon, and boundary wall IDs
- `set_ceiling_height` — Set the ceiling height after labeling
