# Floorplan LiveKit worker

This separate Python worker joins rooms dispatched to `floorplan-guide-pascal`, receives the operator's audio, camera and chat through LiveKit, and connects them to Gemini 3.8 Live through the Google Cloud Gemini Enterprise Agent Platform Live API. The official Python Google plugin supports native live video input. Agent speech and transcriptions use LiveKit's standard audio and text streams. The Gemini Live plugin runs geometry tool calls without blocking the conversation. The tool returns its validated result to the original model call and publishes `floorplan.finding` packets to the operator. The worker welcomes the operator after the session starts.

Install and run with Python 3.12 and uv:

```sh
uv sync --project worker
uv run --project worker worker dev
# Production: uv run --project worker worker start
uv run --project worker pytest worker/tests
```

Configure `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `GOOGLE_CLOUD_PROJECT`, and `FLOORPLAN_SERVER_URL` to the server's externally reachable base URL. `LIVEKIT_AGENT_NAME` defaults to `floorplan-guide-pascal` and must match server dispatch. The worker uses Application Default Credentials (ADC), not a Gemini Developer API key. Set `GOOGLE_CLOUD_LOCATION` to a supported Gemini 3.8 Live location; the default is `us-central1`. This location is independent of the managed agent location. Enable the relevant Google Cloud API and grant the worker identity access to the model. Keep all credentials server-side. Dispatch metadata carries the session ID, authorized participant identity and a room-scoped review token. The operator sends the recording start time on `floorplan.recording`; until this arrives, the worker will not invent a review timestamp. The guide specifies when the review interval ended and how long it lasted, up to 60 seconds. The worker retries the same request while the newest segments commit. Reviews may be pending while the recording segments become available. Pending, failed and stale reviews are never presented as findings.

A real LiveKit project, Google Cloud ADC with Gemini Live access, recording storage and server are required for an end-to-end run. The tests use a mocked review service and do not call either provider.

The guide calls `capture_milestone` on a completed room sweep or doorway crossing. If no review completes, a fallback begins after 30 seconds of recorded time. Scene updates are published on `floorplan.scene`; the phone can retrieve the authoritative scene after reconnecting. Reshoot `done` messages use recording-relative start and end times. Targeted reviews include available prior evidence associated with the selected element.
