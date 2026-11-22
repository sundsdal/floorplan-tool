# Floorplan walkthrough experiments

Two standalone apps turn recorded walkthroughs into floor plans. Each has its own Next.js server, Expo development build, LiveKit worker, lockfiles and agent definition. Set the deployment working directory to the selected approach.

| Approach | Filmer experience | API | Metro | LiveKit dispatch |
| --- | --- | --- | --- | --- |
| [Baseline](approaches/baseline/README.md) | Live guidance and a floor plan after Finish | 3000 | 8081 | floorplan-guide |
| [Pascal](approaches/pascal/README.md) | Inspect a partial 2D drawing, select an element and reshoot it before Finish | 3001 | 8082 | floorplan-guide-pascal |

## Launch both

From each approach directory, install the server dependencies with `bun install` and run `bun run dev`. In a second terminal at the same directory, run `uv sync --project worker` and `uv run --project worker worker dev`. From its `mobile/` directory run `bun install`, then `bun run android` or `bun run ios`. Each Expo app has its own install identity.

Each stack has a config template at `config/local.env.example`. Follow the linked app README for Google Cloud, FFmpeg, recording storage and LiveKit configuration. Supply server secrets in that server's local environment. Export the worker settings in its process environment. Point each worker's `FLOORPLAN_SERVER_URL` and phone's `EXPO_PUBLIC_API_URL` to the matching server. A physical phone needs its host's LAN address. The Android emulator defaults to 10.0.2.2.

Configure a different `LIVEKIT_SESSION_SECRET` and managed agent ID for each server. Baseline uses `floorplan-review` and writes recordings under `captures/`. Pascal uses `floorplan-pascal-review` and writes scenes and recordings under `approaches/pascal/captures/`. The server and worker for each approach must agree on dispatch name. Pascal's server identity needs read and conditional write access to its scene objects.

## Compare the same space

The [first sweep](comparison/first-sweep.mp4) and [return shot](comparison/doorway-return.mp4) depict the same synthetic apartment. The light room spans x=0–3 m and the tan hall spans x=3–5 m. Both span y=0–4 m. A one-metre doorway connects them at x=3 m between y=1 and y=2. The first clip cuts between rooms. The second crosses the opening continuously. Regenerate both clips with `uv run comparison/generate.py` and FFmpeg.

Play the same clips full-screen for each phone's camera, or use the browser upload for whole-clip analysis. The mobile workflow exercises the live review path. Start timing at the first frame, continue recording through both clips, and record the following for each run:

| Measure | Observation |
| --- | --- |
| First draft | Seconds until geometry is visible, or “final only” |
| Reshoot | Seconds from Check this shot to a visible correction |
| Correct connection | One doorway on the shared wall, approximate location and width, no duplicate rooms |
| Completion | Seconds until the filmer accepts the plan, including waits and retries |

On Pascal, select the uncertain wall or opening before the return shot. Inspect the proposed change, accept or dismiss it, and finish. Repeat with a blank-wall shot and reconnect the phone during review. Confirm the previous accepted draft remains available.
