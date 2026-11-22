# A walkthrough you can finish on site

**Product proposal · 21 November 2026**

A person filming an apartment should know whether they have enough footage **before they leave**. They should be able to open the resulting plan, tap a questionable wall, see the views that support it, and correct it once. The first product bet is that one well-chosen return shot can save a second visit or several minutes of redrawing.

Start with a property surveyor or renovation estimator preparing a single-floor, two-to-four-room layout for a site discussion. That audience and use case are working assumptions. In the first five field sessions, watch what the recipient actually does with the drawing. Record which missing fact forces them to call back, redraw, or visit again. Those decisions set the accuracy and export requirements.

## What the experience feels like

In the hallway, the operator sees three rooms on a small map. The white bathroom has a dashed left wall. Tapping it shows the doorway view and the reason for the gap. The vanity hides the corner where the left wall meets the back wall.

The guide says, “Go back to the white bathroom. From the doorway, move one step right and keep the vanity and the left floor corner in view.” The operator can film it, skip it, or say the corner is inaccessible. A return shot joins the same bathroom. When the evidence resolves the corner, the wall becomes solid and the guide stops asking. If the corner stays hidden, it remains dashed. The operator can finish with that gap.

At review, the operator enters a tape measurement between two identifiable endpoints. The plan updates its scale, shows which dimensions still have wide ranges, and retains the measured value on export. A recipient can tell what was measured, what was inferred, and what needs checking.

## Managed agent architecture

Use Google Cloud’s Managed Agents API for the geometry reviewer and final drawing agent. The mobile Live session issues a tool call. Hydrogen inspects the relevant footage and extracts observations. The server passes the text evidence to the configured managed agent, validates the returned geometry or review, and delivers the result to the client. Use independent interactions per request with explicit evidence. The application owns recording and revision IDs. A future cross-request memory feature would require deliberate session isolation and a retention policy.

Run the managed-agent evaluation on synthetic or public, non-confidential walkthroughs. The field pilot below depends on terms permitting its intended data and use. [Google preview terms](https://docs.cloud.google.com/gemini-enterprise-agent-platform/build/managed-agents) · [Agent setup](../../README.md#managed-geometry-agent)

## Where the current tool stops

| The current working tree | The opportunity |
| --- | --- |
| The browser records a continuous video. Gemini Live sees sampled frames, offers guidance, and accepts typed replies. The component asks for guidance on a timer. | Let a specific unresolved question trigger a prompt. Show when the new view answers it. |
| After recording, the backend inspects the full video with Gemini 4 Hydrogen in agentic mode. It receives timestamped capture notes and returns clips, gaps, and per-room dimension ranges. | Give each room, doorway, observation, and gap a stable identity across visits. Make the backend available while the operator can still act. |
| The drawing agent builds a 2D plan. Validation compares room extents and ceiling heights to the model’s estimated ranges. A user can seek to an evidence clip. | Check a wall against independent geometry or a measurement. Connect the wall to its supporting views and preserve human corrections. |
| The app exports SVG and PNG. Current automated tests exercise the application and model contracts. | Measure field accuracy, correction time, and unnecessary revisits against independently measured layouts. |

Implementation entry points are [live capture](../../components/live-capture.tsx), the [analysis route](../../app/api/floorplan/route.ts), [video dissection](../../lib/gemini.ts), [evidence checks](../../lib/evidence.ts), the [managed drawing and review adapter](../../lib/managed-results.ts), and the [canvas geometry](../../lib/server-canvas.ts). The existing [chunking proposal](../../TECH_v2.md) supplies an overlap strategy. A chunk boundary should preserve a doorway crossing even when the operator pauses there.

## First release slice — resolve one missing doorway

Build this before general-purpose 3D reconstruction. Use one apartment, two rooms, one doorway, and two takes. In take one, a cut makes it unclear whether the bathroom opens onto the hall or the bedroom. In take two, the operator walks continuously from the hall through the bathroom doorway. Success means the software asks for that discriminating view, revises the correct connection, and lets a reviewer verify the change.

1. **Index the first take.** Extend the existing evidence output with segment IDs, time spans, candidate room IDs, and doorway observations. Split around transitions and revisits, with overlapping frames on each side. Preserve conflicting interpretations. Visually similar bathrooms can have separate provisional IDs.
2. **Open one question.** Associate the competing connections with an unresolved doorway. The question records its target, the views already seen, one filming instruction, and a closure condition. Here the condition is a continuous transition showing both the hall landmark and the bathroom entrance.
3. **Ask while the person is there.** For the first slice, the live guide calls its geometry review tool, or the operator taps “Check this room”. The media service selects the requested interval from its recording while the phone continues streaming. Give the live model the backend question and a thumbnail so it can direct the operator. Acknowledge the request immediately and let filming continue during analysis.
4. **Reconcile the return shot.** Associate the new clip with the same question. A backend check can resolve it, leave it open, or mark contradictory evidence. A user’s “done” marks a shot ready for review. It does not establish a physical connection. Ignore late responses for superseded revisions.
5. **Show the difference.** Highlight the affected doorway on the plan. Tapping it plays the supporting transition. Let the reviewer confirm or correct its connected rooms, then regenerate and export with that correction intact.

**Acceptance run.** Replay the two takes through the real upload and capture interfaces. After the first, the doorway is unresolved. After the second, the plan has one bathroom, one verified connection and a seekable transition. Repeat with a clip of the same blank tile wall, a duplicate upload, an out-of-order response, and a disconnected guide. The blank view leaves the question open, retries produce one revision, and recording remains usable. An uploaded video can enter the same workflow and accept a supplemental take.

## How the two models cooperate

| Decision | Owner | Evidence and timing |
| --- | --- | --- |
| What should the person do now? | Live guide | Current frames, latest plan revision, open questions, prior requests and skips. Speak once per actionable gap. Give an orientation cue visible from where the person stands. |
| What actually happened in the footage? | Backend video agent | Inspect transitions, revisit earlier timestamps, compare alternative room identities, and return observations with source intervals. Treat a spoken or typed claim as a lead with its own provenance. |
| Which geometry fits those observations? | Geometry process | Fit shared walls, camera views, planes and measurement constraints. Return geometry plus residuals, conflicting evidence and unresolved alternatives. |
| Is another shot worth the interruption? | Capture controller | Rank open questions by downstream impact, likelihood that another view will resolve them, and walking effort. Prefer a nearby doorway that determines two rooms over a distant detail. The operator can skip or finish. |

Persist recordings and their revisions by session. Each clip carries a source ID, a capture-clock offset, and a retry key. Each question carries the evidence revision that produced it. Reconnecting a guide restores open questions and skipped requests. Store the complete upload once and analyze only affected intervals on a revisit. An explicit finish runs a whole-walkthrough consistency pass to catch contradictions across rooms. Compare guide-triggered checks with operator-triggered checks on the same recordings. Track backend calls and elapsed time per resolved gap.

## Expo 58 capture and the live feedback loop

Build one React Native client with Expo SDK 58 for Android and iOS. Android is required. Prove the core loop on a physical Android phone first. The same session protocol and review jobs serve both platforms. Keep the browser upload and review flow for people who already have footage. The first device milestone is one useful geometry finding relayed aloud by Gemini Live while the same recording is still running.

**Capture transport.** Expo publishes the camera and microphone to LiveKit over WebRTC. A room worker bridges the conversation to the Google Cloud Gemini Live API. Participant Egress records the operator’s tracks in private Google Cloud Storage. Next.js handles session setup, review and final plan generation. [Cloud Live API](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api)

1. **Converse and record concurrently.** Derive sampled frames and microphone PCM for Live and return its spoken guidance to the phone. Record the incoming tracks to private storage in keyframe-aligned, independently playable segments. Maintain a session manifest with each segment’s capture timestamps and readiness. Keep the guide’s return audio on its own path. [Live API capabilities](https://aistudio.google.com/docs/live-api/capabilities)
2. **Review a window while capture continues.** Live calls the non-blocking geometry review tool with the room, question and time window. Resolve that interval against the manifest, assemble a playable clip across segment boundaries, upload it to the Gemini Files API and wait for readiness. Hydrogen inspects the footage and the managed agent reviews its timestamped observations. The worker publishes the finding to the phone and returns the validated evidence on the original non-blocking Live tool call. Request and revision IDs associate each review with its trigger. [Gemini video understanding](https://aistudio.google.com/docs/video-understanding) · [Live tool calls](https://aistudio.google.com/docs/live-api/tools)
3. **Prove the split.** Request a five-second interval spanning two segments and play the clip with sound while ingest continues. Assemble the complete recording and check A/V continuity and timestamp alignment. Drop the uplink and mark the missing interval. Evaluate local recording for later backfill if offline coverage is required. Measure spoken-response latency and clip-ready-to-review latency separately.
4. **Manage delayed findings.** Deduplicate requests for the same gap and revision. If the operator has moved on, retain the finding on the map and ask for the return shot when practical. If a later view already resolved it, suppress the stale prompt. After reconnection, restore outstanding questions into the new Live session. On finish, use the complete recording for the final consistency pass.
5. **Verify on Android first, then on iPhone for the iOS release.** Record the hall-to-bathroom case, induce a slow backend response and continue speaking to Live during the wait. Confirm the local movie plays across the request, the targeted instruction is delivered once, and a return shot resolves the original gap. Repeat with Wi-Fi disconnected. Measure request-to-spoken-feedback latency on Wi-Fi and cellular, plus the fraction of answers that arrive while the operator can still act.

## Give geometry an independent vote

1. **Recover relative structure.** Sample sharp, overlapping keyframes around translations and door crossings. Keep lens changes and video cuts as boundaries. In a small offline experiment, recover relative camera poses and sparse points using structure from motion. Track which views matched and their reprojection errors. A pan from one spot, a mirror, or two blank white walls may supply too little parallax or texture. Request a short sideways move with a fixed landmark in view when that would help. [COLMAP reconstruction guide](https://colmap.github.io/tutorial.html)
2. **Fit a room envelope.** Estimate a floor plane, vertical wall planes, shared corners, openings, and a ceiling-height interval wherever evidence supports them. Project their intersections into the existing 2D canvas. Use right angles as a soft preference. Keep angled walls and alcoves when multiple views support them. Check closed boundaries, openings inside host walls, compatible shared door positions, and competing room overlaps.
3. **Set scale deliberately.** Ask for one measured span with identifiable endpoints, such as the inside width of a doorway. Store its value, unit, endpoints, source and uncertainty. Apply scale only to the connected reconstruction it anchors. Hold a second measured span out of the fit to check error. Without a reliable scale anchor, show a relative plan and visibly label model-derived dimension ranges.
4. **Make disagreement actionable.** When two layouts fit, find a view whose predicted wall or doorway location differs between them. Show the target on a saved frame. When footage contradicts an entered measurement, show both sources and ask the reviewer which endpoints were measured. Preserve their edit across subsequent solves and exports.

Run a separate depth-sensing trial only if the benchmark identifies metric error as the main obstacle and field users have suitable devices. On a LiDAR-equipped iPhone or iPad, compare Apple RoomPlan surfaces against the same measured rooms. Both capture paths should feed the same evidence and review screens. [Apple RoomPlan](https://developer.apple.com/augmented-reality/roomplan/)

## Build sequence and investment gates

| Increment | Ship to the operator | Decision before expanding |
| --- | --- | --- |
| 1. Establish the baseline | Replay an existing walkthrough, inspect the current draft, and time a reviewer correcting it against a measured reference. Freeze inputs, model IDs, outputs and failures. | Identify whether missing footage, room identity, dimensional error, or editing consumes the most time. A real provider run requires a working Gemini key, a provisioned custom agent and Cloud credentials. |
| 2. Close one doorway question | Deliver the two-take slice above through the Expo Android client and backend. Extend the evidence panel and existing SSE flow. | Compare the recovered connection against a single-take baseline. Count repeated prompts, missed revisits and duplicate rooms. |
| 3. Produce a calibrated, editable plan | Add a measured span, per-element evidence links, and edits to wall endpoints and door connections. Keep accepted edits as revisioned constraints. Export a scale legend and unresolved geometry. | A reviewer can fix the highest-impact error once, regenerate, and hand off the drawing without tracing it again. |
| 4. Test multi-view geometry | Run pose and plane fitting on the same footage in shadow mode. Overlay its projected boundaries on held-out frames. | Promote it only if it improves measured geometry or lowers repair time at acceptable latency and cost. Keep the existing agent path available for low-texture clips. |
| 5. Automate capture checkpoints | Trigger backend checks from observed transitions, restore a session after interruption, and permit a next-day supplemental clip. | Field-test whether automatic prompts outperform user-triggered checkpoints on successful first visits and operator time. |

Keep old uploads readable. Add evidence and revision IDs as optional fields first. Put the new solver behind a per-session setting and keep the last accepted plan if a solve fails. Update the README and historical PRD assumptions as each increment ships. For the pilot, use consented recordings, restrict access by project, and give operators deletion of source footage and derived frames.

## Measure whether the product helps

The primary field measure is **time from the first camera frame to a plan a reviewer accepts for the intended job**. Count capture, revisits, waiting, review, and manual repairs. Also count abandoned sessions and trips back to the property. A fast but unusable draft counts as a failure.

Start with 12 consented single-floor properties and independently measured references. Include repeated bathrooms, mirrors, open-plan rooms, diagonal walls, clipped transitions and weak lighting. Split by property before tuning. For each property, preserve an initial take and a deliberately targeted supplemental take. Replay the same takes across software variants to isolate reconstruction improvements. In separate field sessions, rotate the order of guided and unguided capture to measure the effect of guidance on the footage itself. Compare against the current pipeline and a timed manual sketch. Have a reviewer score the results without seeing which system produced them.

| Measure | How to score |
| --- | --- |
| Room connectivity | Compare matched room pairs and connecting doorways to the reference. Report missing, invented and duplicate connections. |
| Metric geometry | Align origin and heading, fix scale from the user’s anchor, and report median and 90th-percentile error on withheld wall lengths. Report unscaled sessions separately. |
| Honest coverage | Count unsupported walls or doors shown as confirmed, and reference features left unresolved. Report both so omitting difficult rooms cannot improve the score. |
| Prompt value | Count resolved gaps per request, time spent revisiting, skipped requests, repeated prompts and false declarations of completion. |
| Operating cost | Record provider calls and cost per accepted plan, checkpoint-to-instruction latency, and time to recover from a dropped connection. |

**Proposed pilot gate.** Continue investment if median time to an accepted plan drops by at least 25% against the current tool, at least two thirds of requested return shots resolve their intended gap, and unsupported confirmed connections do not increase. These are decision thresholds, not measured results. With 12 properties, publish individual failures and raw counts alongside the medians. Use the pilot to set an accuracy threshold with the intended recipient before offering measured drawings for a more demanding job.

**First field exercise.** Take a phone and a tape measure to one apartment with a hallway and two similar doors. Collect a deliberately ambiguous first take, one measured doorway width, a continuous return shot, and a separate wall length for evaluation. Run the baseline and record the exact mistake and repair time. That case becomes the first replay fixture and the acceptance test for the two-model handoff.
