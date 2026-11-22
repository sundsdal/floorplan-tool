import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	disconnect: vi.fn(),
	stopAudio: vi.fn(),
	stopTrack: vi.fn(),
	stopMicrophone: vi.fn(),
}));
vi.mock("@livekit/react-native", () => ({
	AudioSession: {
		startAudioSession: vi.fn(),
		stopAudioSession: mocks.stopAudio,
	},
}));
vi.mock("livekit-client", () => ({
	ParticipantKind: { AGENT: "agent" },
	RoomEvent: {
		Disconnected: "disconnected",
		ParticipantConnected: "connected",
		ParticipantDisconnected: "left",
		Reconnected: "reconnected",
		DataReceived: "data",
	},
	Room: class {
		remoteParticipants = new Map();
		localParticipant = {
			identity: "local",
			trackPublications: new Map([
				["camera", { track: { stop: mocks.stopTrack } }],
				["microphone", { track: { stop: mocks.stopMicrophone } }],
			]),
			setCameraEnabled: vi.fn().mockResolvedValue({}),
			setMicrophoneEnabled: vi.fn(),
			publishData: vi.fn(),
		};
		on() {}
		registerTextStreamHandler() {}
		connect() {}
		disconnect = mocks.disconnect;
	},
}));

describe("mobile finish", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});
	it("disconnects immediately, waits for an in-flight recording start, and allows finalization retry", async () => {
		const modulePath = "../mobile/src/live.ts";
		const { LiveGuide } = await import(/* @vite-ignore */ modulePath);
		let finishStart!: (value: Response) => void;
		const inFlight = new Promise<Response>((resolve) => {
			finishStart = resolve;
		});
		let recordingCalls = 0;
		let finalCalls = 0;
		const fetchMock = vi.fn(async (url: string) => {
			if (url.endsWith("/session"))
				return Response.json({
					sessionId: "id",
					serverUrl: "url",
					token: "token",
					sessionToken: "secret",
				});
			if (url.endsWith("/recording")) {
				recordingCalls++;
				return recordingCalls === 1
					? Response.json({ startedAt: null })
					: inFlight;
			}
			finalCalls++;
			return finalCalls === 1
				? new Response("pending", { status: 425 })
				: Response.json({ floorplan: {} });
		});
		vi.stubGlobal("fetch", fetchMock);
		const guide = new LiveGuide("https://example.com", {
			status: vi.fn(),
			preview: vi.fn(),
			transcript: vi.fn(),
			finding: vi.fn(),
		});
		await guide.connect();
		expect(recordingCalls).toBe(2);
		const finalizing = guide.finalize();
		expect(mocks.stopTrack).toHaveBeenCalledOnce();
		expect(mocks.stopMicrophone).toHaveBeenCalledOnce();
		expect(mocks.disconnect).toHaveBeenCalledOnce();
		expect(finalCalls).toBe(0);
		finishStart(Response.json({ startedAt: 123 }));
		await expect(finalizing).rejects.toThrow("pending");
		await expect(guide.finalize()).resolves.toContain("floorplan");
		expect(recordingCalls).toBe(2);
		vi.unstubAllGlobals();
	});
});
