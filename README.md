# Floorplan apps

The [baseline app](approaches/baseline/README.md) combines Expo capture, LiveKit guidance, Hydrogen video analysis and Pascal floor-plan drafting. Its Next.js server, mobile app and Python worker live together in `approaches/baseline/`. Set the server deployment root to that directory.

[Floorplan Scan](approaches/swift/) uses Apple RoomPlan on a LiDAR-equipped iPhone or iPad running iOS/iPadOS 26 or later. Both apps export SVG drawings and JSON plan data for the web viewer. Floorplan Scan also exports USDZ locally.

Open [Roomplan.xcodeproj](approaches/swift/Roomplan.xcodeproj) in Xcode, select a signing team and a physical LiDAR device, and run the app.

## Run the baseline

1. Install dependencies from the repository root with `bun install`. From `approaches/baseline/`, configure the services using `config/local.env.example`, and start the API with `bun run dev` (port 3000).
2. From the same directory, start the worker with `uv run --project worker worker dev`. Set its `FLOORPLAN_SERVER_URL` to the baseline server.
3. From `approaches/baseline/mobile/`, run `bun run android` or `bun run ios`. Set `EXPO_PUBLIC_API_URL` to an address reachable from your phone. The Android emulator defaults to `http://10.0.2.2:3000`.

## Shared comparison footage

The [first sweep](comparison/first-sweep.mp4) and [return shot](comparison/doorway-return.mp4) depict the same synthetic apartment. The light room spans x=0–3 m and the hall spans x=3–5 m. Both span y=0–4 m. A one-metre doorway connects them at x=3 m between y=1 and y=2. The first clip cuts between rooms. The second crosses the opening continuously. Regenerate both with `uv run comparison/generate.py` and FFmpeg.

On the baseline, inspect the first draft, select the uncertain wall or door, then capture the return shot. Compare time to first draft, time to correction, doorway placement and time to an accepted plan across implementations.

## Plan exchange format

Version 1 documents contain `version`, `source` (`video` or `roomplan`), `warnings`, and `floorplan`. Plan coordinates and lengths use metres, and area uses square metres. Positive x runs right and positive y runs down in the drawing. Apple maps world X and Z onto those axes. Doors and windows reference their wall by ID and give the distance from the wall start to the opening centre. Room boundaries are ordered polygon vertices. The source identifies video estimates or LiDAR-derived geometry. See the [rotated L-shaped room fixture](packages/floorplan/fixtures/rotated-l.json).
