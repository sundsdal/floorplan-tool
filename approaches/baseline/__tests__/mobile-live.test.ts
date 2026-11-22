import { parseDocument } from "@floorplan/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../../../packages/floorplan/fixtures/rotated-l.json";
import { exportReview, reviewDocument } from "../mobile/src/review";
import type { Scene } from "../mobile/src/scene";

const mocks = vi.hoisted(() => ({
	disconnect: vi.fn(),
	stopAudio: vi.fn(),
	stopTrack: vi.fn(),
	stopMicrophone: vi.fn(),
	events: new Map<string, (...args: unknown[]) => void>(),
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
		on(event: string, callback: (...args: unknown[]) => void) {
			mocks.events.set(event, callback);
		}
		registerTextStreamHandler() {}
		connect() {}
		disconnect = mocks.disconnect;
	},
}));

describe("mobile finish", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.events.clear();
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
			if (url.endsWith("/scene"))
				return Response.json({ scene: { revision: 0 } });
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

describe("mobile scene synchronization", () => {
	it("refetches only on scene signals and reconnect, and submits decisions after disconnect", async () => {
		const modulePath = "../mobile/src/live.ts";
		const { LiveGuide } = await import(/* @vite-ignore */ modulePath);
		const scene = {
			revision: 1,
			floorplan: parseDocument(fixture).floorplan,
			nodes: {},
			proposals: [],
			evidence: [],
		};
		const accepted = structuredClone(scene);
		accepted.revision = 2;
		accepted.floorplan.rooms[0].name = "Accepted room";
		const fetchMock = vi.fn(async (url: string, _options?: RequestInit) => {
			if (url.endsWith("/session"))
				return Response.json({
					sessionId: "id",
					serverUrl: "url",
					token: "token",
					sessionToken: "secret",
				});
			if (url.endsWith("/recording"))
				return Response.json({ startedAt: Date.now() });
			if (url.includes("/proposals/"))
				return Response.json({ scene: accepted });
			return Response.json({ scene });
		});
		vi.stubGlobal("fetch", fetchMock);
		let currentScene: Scene | undefined;
		const onScene = vi.fn((next: Scene) => {
			currentScene = next;
		});
		const guide = new LiveGuide("https://example.com", {
			status: vi.fn(),
			preview: vi.fn(),
			transcript: vi.fn(),
			finding: vi.fn(),
			scene: onScene,
		});
		await guide.connect();
		await vi.waitFor(() => expect(onScene).toHaveBeenCalledTimes(1));
		const encode = (value: unknown) =>
			new TextEncoder().encode(JSON.stringify(value));
		mocks.events.get("data")?.(
			encode({ type: "other" }),
			null,
			null,
			"floorplan.scene",
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(onScene).toHaveBeenCalledTimes(1);
		mocks.events.get("data")?.(
			encode({ type: "scene", revision: 1 }),
			null,
			null,
			"floorplan.scene",
		);
		await vi.waitFor(() => expect(onScene).toHaveBeenCalledTimes(2));
		mocks.events.get("reconnected")?.();
		await vi.waitFor(() => expect(onScene).toHaveBeenCalledTimes(3));
		await guide.close();
		await guide.decide("proposal", 1, "accept");
		const call = fetchMock.mock.calls.find(([url]) =>
			url.includes("/proposals/"),
		);
		expect(JSON.parse(call?.[1]?.body as string)).toMatchObject({
			baseRevision: 1,
			decision: "accept",
		});
		expect(onScene).toHaveBeenLastCalledWith(
			expect.objectContaining({ revision: 2 }),
		);
		const result = reviewDocument(currentScene, ["Final warning"]);
		if (!result) throw new Error("Missing final review");
		expect(result.floorplan.rooms[0].name).toBe("Accepted room");
		expect(exportReview(result, "svg")).toContain("Accepted room");
		expect(
			JSON.parse(exportReview(result, "json")).floorplan.rooms[0].name,
		).toBe("Accepted room");
		vi.unstubAllGlobals();
	});
});
