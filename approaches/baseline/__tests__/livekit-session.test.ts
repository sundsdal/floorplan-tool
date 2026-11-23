// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createRoom: vi.fn(),
	deleteRoom: vi.fn(),
	createDispatch: vi.fn(),
	listEgress: vi.fn(),
	listDispatch: vi.fn(),
	hasFinalRecording: vi.fn(),
	startParticipantEgress: vi.fn(),
	stopEgress: vi.fn(),
}));
vi.mock("@/lib/livekit-media", () => ({
	hasFinalRecording: mocks.hasFinalRecording,
}));
vi.mock("livekit-server-sdk", async (importOriginal) => {
	const original = await importOriginal<typeof import("livekit-server-sdk")>();
	return {
		...original,
		RoomServiceClient: class {
			createRoom = mocks.createRoom;
			deleteRoom = mocks.deleteRoom;
		},
		AgentDispatchClient: class {
			createDispatch = mocks.createDispatch;
			listDispatch = mocks.listDispatch;
		},
		EgressClient: class {
			listEgress = mocks.listEgress;
			startParticipantEgress = mocks.startParticipantEgress;
			stopEgress = mocks.stopEgress;
		},
	};
});

import {
	authorizeReview,
	authorizeSession,
	createSession,
	recordingPlaylist,
	startRecording,
	stopRecording,
} from "@/lib/livekit-session";

describe("LiveKit session lifecycle", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		Object.assign(process.env, {
			LIVEKIT_URL: "wss://livekit.example",
			LIVEKIT_API_KEY: "test-key",
			LIVEKIT_API_SECRET: "test-secret",
			LIVEKIT_AGENT_NAME: "floorplan-guide",
			LIVEKIT_GCS_BUCKET: "private-bucket",
			LIVEKIT_GCS_CREDENTIALS: "{}",
			LIVEKIT_SESSION_SECRET: "a".repeat(32),
		});
		mocks.createRoom.mockResolvedValue({});
		mocks.createDispatch.mockResolvedValue({});
		mocks.listEgress.mockResolvedValue([]);
		mocks.listDispatch.mockResolvedValue([]);
		mocks.hasFinalRecording.mockResolvedValue(false);
	});
	it("issues isolated operator and review capabilities and dispatches the guide", async () => {
		const session = await createSession();
		const metadata = JSON.parse(mocks.createDispatch.mock.calls[0][2].metadata);
		expect(metadata.sessionId).toBe(session.sessionId);
		expect(authorizeReview(session.sessionId, metadata.reviewToken)).toBe(true);
		expect(authorizeSession(session.sessionId, metadata.reviewToken)).toBe(
			false,
		);
		expect(authorizeReview(session.sessionId, session.sessionToken)).toBe(
			false,
		);
		expect(authorizeSession(session.sessionId, session.sessionToken)).toBe(
			true,
		);
		expect(authorizeSession(crypto.randomUUID(), session.sessionToken)).toBe(
			false,
		);
		expect(recordingPlaylist(session.sessionId)).toEqual({
			bucket: "private-bucket",
			object: `captures/${session.sessionId}/recording.m3u8`,
		});
	});
	it("dispatches an inspection with the selected work context", async () => {
		const session = await createSession({ mode: "inspection", work: "slipe" });
		const metadata = JSON.parse(mocks.createDispatch.mock.calls[0][2].metadata);
		expect(metadata.mode).toBe("inspection");
		expect(metadata.work).toBe("slipe");
		expect(authorizeReview(session.sessionId, metadata.reviewToken)).toBe(true);
	});
	it("returns only finalization credentials for ended linked recordings", async () => {
		const id = crypto.randomUUID();
		for (const status of [2, 3]) {
			mocks.listEgress.mockResolvedValue([{ egressId: "EG_1", status }]);
			const session = await createSession(
				{ mode: "inspection", work: "male" },
				id,
			);
			expect(session).toEqual({
				sessionId: id,
				sessionToken: expect.any(String),
				finalizeOnly: true,
			});
			expect(authorizeSession(id, session.sessionToken)).toBe(true);
		}
		expect(mocks.createRoom).not.toHaveBeenCalled();
		expect(mocks.createDispatch).not.toHaveBeenCalled();
	});
	it("recovers a final playlist after egress history expires without overwriting it", async () => {
		const id = crypto.randomUUID();
		mocks.hasFinalRecording.mockResolvedValue(true);
		expect(await createSession({}, id)).toMatchObject({
			sessionId: id,
			finalizeOnly: true,
		});
		await stopRecording(id);
		await expect(startRecording(id)).rejects.toThrow("Recording already ended");
		expect(mocks.startParticipantEgress).not.toHaveBeenCalled();
	});
	it("reopens active and new linked recordings normally", async () => {
		const id = crypto.randomUUID();
		for (const items of [[], [{ egressId: "EG_1", status: 1 }]]) {
			mocks.listEgress.mockResolvedValue(items);
			const session = await createSession({}, id);
			expect(session).toMatchObject({
				sessionId: id,
				token: expect.any(String),
			});
		}
		expect(mocks.createRoom).toHaveBeenCalledTimes(2);
	});
	it("starts participant HLS and stops active recording only once", async () => {
		const session = await createSession();
		mocks.startParticipantEgress.mockResolvedValue({
			egressId: "EG_1",
			segmentResults: [{ startedAt: BigInt("1700000000000000000") }],
		});
		expect(await startRecording(session.sessionId)).toEqual({
			egressId: "EG_1",
			startedAt: 1700000000000,
		});
		const [room, identity, output] = mocks.startParticipantEgress.mock.calls[0];
		expect(room).toBe(`capture-${session.sessionId}`);
		expect(identity).toBe(`capture-user-${session.sessionId}`);
		expect(output.segments.playlistName).toBe(
			`captures/${session.sessionId}/recording.m3u8`,
		);
		expect(output.segments.output.value.bucket).toBe("private-bucket");
		mocks.listEgress.mockResolvedValue([{ egressId: "EG_1", status: 1 }]);
		await stopRecording(session.sessionId);
		expect(mocks.stopEgress).toHaveBeenCalledWith("EG_1");
		mocks.listEgress.mockResolvedValue([{ egressId: "EG_1", status: 3 }]);
		await stopRecording(session.sessionId);
		expect(mocks.stopEgress).toHaveBeenCalledTimes(1);
	});
	it("coalesces simultaneous starts for the same session", async () => {
		const session = await createSession();
		mocks.startParticipantEgress.mockResolvedValue({
			egressId: "EG_1",
			segmentResults: [],
		});
		await Promise.all([
			startRecording(session.sessionId),
			startRecording(session.sessionId),
		]);
		expect(mocks.startParticipantEgress).toHaveBeenCalledTimes(1);
	});
});
