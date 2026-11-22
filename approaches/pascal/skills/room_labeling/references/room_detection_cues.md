# Room Detection Cues

Use these visual indicators to classify rooms from video frames.

| Room Type | Key Visual Cues | Confirming Details |
|---|---|---|
| `bedroom` | Bed, pillows, bedside tables | Wardrobe/closet, dresser, soft lighting |
| `kitchen` | Countertops, stove/oven, sink | Cabinets, refrigerator, backsplash, range hood |
| `bathroom` | Toilet, shower/bathtub, vanity sink | Tile walls, mirror, towel racks |
| `living_room` | Sofa, TV/entertainment center | Coffee table, armchairs, large windows |
| `dining_room` | Dining table with chairs | Pendant light/chandelier, sideboard |
| `hallway` | Narrow passage, multiple doors | No furniture, connects rooms, coat hooks |
| `closet` | Shelving, hanging rods, small space | Single door access, no windows |
| `balcony` | Outdoor railing, exterior exposure | Sliding door access, plants, outdoor furniture |
| `office` | Desk, office chair, computer | Bookshelves, filing cabinets |
| `laundry` | Washing machine, dryer | Laundry sink, ironing board, detergent |
| `garage` | Garage door, concrete floor | Car/space for car, tools, storage |
| `basement` | Below-grade access (stairs down) | Concrete walls/floor, utility equipment, low ceilings |
| `stairs` | Staircase treads and risers | Handrail/banister, landing, vertical transition |
| `attic` | Sloped ceiling, roof structure visible | Dormer windows, exposed beams, storage |

## Ambiguous Cases

- **Open-plan kitchen/living**: Label kitchen zone separately from living zone based on where counters end
- **Bedroom used as office**: If a bed is present, classify as `bedroom`; if only a desk, classify as `office`
- **Utility room with washer**: Classify as `laundry` even if it has other storage
- **Landing at top of stairs**: Classify as `hallway` unless it's a distinct room
- **Entryway/foyer**: Classify as `hallway`
