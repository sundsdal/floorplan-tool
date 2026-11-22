# FloorPlan AI

Record a walkthrough with a camera guide or upload an existing video. During capture, the guide can ask you to revisit a room and show a particular doorway, corner, or wall junction. Keep recording as you return so the backend can trace the connection between rooms.

While the guide is connected, you can type a question and hear its reply. Timestamped questions and guidance accompany the recording so the backend can check them against the footage. If the guide disconnects, the camera keeps recording.

After configuring the managed agent below, select **Generate Floorplan** for an evaluation recording. The backend examines the complete walkthrough, indexes observations by time and room, and uses visible scale cues to estimate ranges for room dimensions. The drawing agent uses those observations to lay out the walls, doors, and windows. Select an evidence timestamp to replay the relevant view and inspect any coverage gaps or dimensions that fall outside the video estimates. Dimensions are approximate.

## Run locally

Install the dependencies and set `GEMINI_API_KEY` in `.env.local` to a Google Gemini API key with access to both models.

```sh
bun install
bun dev
```

Open [localhost:3000](http://localhost:3000). Camera capture requires localhost or HTTPS. The browser requests camera access when you start recording.

| Setting | Default | Purpose |
| --- | --- | --- |
| `GEMINI_LIVE_MODEL` | `gemini-3.8-live` | Guides the person filming through Gemini Live |
| `GEMINI_MODEL` | `gemini-4-hydrogen` | Inspects clips and full recordings for visual evidence |

## Managed geometry agent

Gemini Live handles the conversation. Hydrogen inspects video through the Gemini Developer API. Both the geometry review endpoint and the final floorplan endpoint submit the resulting observations to a custom agent on Google Cloud’s **Managed Agents API**. The server validates its structured answer before returning it. The managed sandbox receives text derived from the walkthrough. Google stores the background interaction.

Use synthetic or public, non-confidential fixtures for this evaluation. Google currently limits this preview to evaluation and excludes commercial and production use and confidential data. [Managed Agents API preview terms](https://docs.cloud.google.com/gemini-enterprise-agent-platform/build/managed-agents)

### Configure a test project

1. Select a billing-enabled Google Cloud project with Managed Agents access and enable the Vertex AI API (`aiplatform.googleapis.com`). The backend needs Application Default Credentials with permission to run interactions in that project. For local development, use `gcloud auth application-default login`.
2. Create a custom agent in the global location using the [agent definition](config/floorplan-agent.json). Submit that JSON as the body of an authenticated `POST` to `https://aiplatform.googleapis.com/v1beta1/projects/PROJECT_ID/locations/global/agents`. Wait for the create operation to finish and verify that getting the agent by ID succeeds. [Google’s provisioning guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/build/managed-agents/create-manage)
3. Set `GOOGLE_CLOUD_PROJECT` and `GOOGLE_MANAGED_AGENT_ID=floorplan-review` in the server’s `.env.local`, alongside `GEMINI_API_KEY`. Restart the backend. Keep these credentials on the server. The Gemini key authenticates Live token creation and video perception. ADC authenticates calls to the deployed agent. [Managed interactions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/build/managed-agents/interact-with-agents)

## Expo walkthrough with LiveKit

The phone publishes its camera and microphone once to a LiveKit room. A Python worker subscribes to those tracks, runs the spoken guide on the Google Cloud Gemini Live API, and publishes guide audio back to the room. Participant Egress writes the operator’s tracks to a private Cloud Storage bucket in two-second HLS segments. A geometry review reads the committed interval, assembles a playable MP4 with FFmpeg, and passes its video evidence to the configured managed agent. Final analysis reads the completed recording. [Mobile setup](mobile/README.md) · [Worker setup](worker/README.md) · [Cloud Live API](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api)

For a local evaluation:

1. Configure LiveKit with agent dispatch and Egress. Set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` and `LIVEKIT_AGENT_NAME=floorplan-guide` for the backend and the worker. Use a LiveKit address reachable by the phone.
2. On the Next.js server, set `LIVEKIT_GCS_BUCKET`, `LIVEKIT_GCS_CREDENTIALS` (Egress writer service-account JSON), and `LIVEKIT_SESSION_SECRET` (a random secret of at least 32 characters). Grant server ADC read access to recording objects and write access to Pascal draft objects. Install FFmpeg with H.264 and AAC support, and complete the managed-agent configuration above. Configure a retention period on the recording bucket.
3. Run the backend and worker as separate processes. The worker needs ADC for a Google Cloud project with access to Gemini 3.8 Live, and `FLOORPLAN_SERVER_URL` pointing to the backend. The Expo client uses `EXPO_PUBLIC_API_URL` for session creation. Use the development build on the phone.
4. Start a walkthrough, ask about a previously filmed detail, and finish to generate the plan. The local evaluation server assumes trusted access to the session-creation endpoint and a single backend instance for in-flight job deduplication. Network outages can leave gaps in the server recording.

## Incremental Pascal capture

Use the Expo client for incremental drafts. The LiveKit guide requests a draft at a room sweep or doorway transition; a recording-time fallback schedules the first check at 30 seconds. The backend inspects committed clips with Hydrogen and runs the managed geometry agent. Scene revisions are persisted alongside the recording and the phone fetches the latest drawing when the worker signals an update. Select a wall or door to revisit it. Review the proposed edit before accepting it. After Finish the phone retrieves the result over HTTP.

For a reproducible two-room comparison and launch settings see the [experiment guide](../../README.md).
