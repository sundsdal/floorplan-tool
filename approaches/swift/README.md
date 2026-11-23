# Floorplan Scan

Open [Roomplan.xcodeproj](Roomplan.xcodeproj) in Xcode, select a signing team, and run on a LiDAR-equipped iPhone or iPad with iOS/iPadOS 26 or later. Scan adjoining rooms in one session and finish the floor to review and share the drawing. SVG, JSON and USDZ exports are generated on the device.

The [baseline app](../baseline/README.md) supports video walkthroughs and Pascal drafting. Both apps export plan data for the same web viewer.

## Room reports

The live map reads RoomPlan walls, openings and windows and tracks the camera position and heading through the same AR session. Each saved room can have a short Gemini 3.8 Live report. The room name and type appear on the plan and in its exports.

Enable Google Sign-In in the native build with the iOS OAuth client for `com.floorplan.roomplan`, its reversed callback scheme and the Web audience already accepted by the private Cloud Run service. For a local signed build, supply these settings in an ignored `.env.roomplan.xcconfig` with `xcodebuild -xcconfig`.

```xcconfig
ROOMPLAN_GOOGLE_IOS_CLIENT_ID = <iOS OAuth client ID>
ROOMPLAN_GOOGLE_WEB_CLIENT_ID = <Web OAuth client ID>
ROOMPLAN_GOOGLE_REVERSED_CLIENT_ID = <reversed iOS OAuth client ID>
```

After sign-in, the app sends up to 12 sampled images and the RoomPlan object inventory to the report API when a room is saved. The app stores the report beside the scan and shares it as Markdown.

## Guided risk inspection

Set `ROOMPLAN_INSPECTION_ORIGIN` to the authorized Risikovurdering origin when signing the app. The job card opens an inspection in Floorplan Scan. RoomPlan supplies the map and camera pose, while LiveKit carries the AR camera frames and microphone to Gemini 3.8 Live.

The floorplan service sends the committed inspection video and room timestamps to Gemini 4 Hydrogen in the EU. It can ask the live guide for a new close-up in a room that was already scanned. The mobile app keeps the request attached to that room and submits each explicitly captured photo with the plan and inspection report.

Every 15 seconds the app saves the latest RoomPlan map, camera arrow and room polygons to a private file for the active inspection. Live receives the image as conversation context. Smaller position updates keep the current room and camera direction fresh between map snapshots.

Hydrogen can call `read_roomplan` to inspect that file. It can use `send_live_command` to queue a targeted photo request for a known room. Live can call `ask_hydrogen` with the user's question and most recent camera pose, then speak the answer when it arrives.
