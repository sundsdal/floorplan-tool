# Mobile walkthrough

This Expo app connects camera and microphone tracks to a LiveKit session. It needs a development build: Expo Go cannot load LiveKit's native WebRTC modules.

Install with `bun install`, configure the server's LiveKit and agent settings, and set `EXPO_PUBLIC_API_URL` to a server address reachable from the phone. The default `http://10.0.2.2:3000` targets the host from the Android emulator; a physical phone needs the host's network address. Run `bun run android` or `bun run ios` to build and install. Grant camera and microphone permissions when prompted. Tokens are issued by the server for each session; do not put LiveKit API secrets in the app.

The server records the published tracks and analyzes the recording when the walkthrough is finished. Verify the camera preview, two-way audio, recording, and final analysis on a physical device with a reachable server and configured LiveKit deployment.
