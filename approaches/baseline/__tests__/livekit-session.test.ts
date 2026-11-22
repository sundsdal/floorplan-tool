// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createRoom: vi.fn(),
	deleteRoom: vi.fn(),
	createDispatch: vi.fn(),
	listEgress: vi.fn(),
	startParticipantEgress: vi.fn(),
	stopEgress: vi.fn(),
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
		expect(room).toBe(session.roomName);
		expect(identity).toBe(session.participantIdentity);
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
