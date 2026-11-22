// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	dispatch: vi.fn(),
	update: vi.fn(),
	read: vi.fn(),
}));
vi.mock("livekit-server-sdk", async (importOriginal) => {
	const original = await importOriginal<typeof import("livekit-server-sdk")>();
	return {
		...original,
		RoomServiceClient: class {
			createRoom = vi.fn().mockResolvedValue({});
			deleteRoom = vi.fn();
		},
		AgentDispatchClient: class {
			createDispatch = mocks.dispatch;
		},
		EgressClient: class {},
	};
});
vi.mock("@/lib/scene", () => ({
	SceneConflict: class extends Error {},
	readScene: mocks.read,
	updateScene: mocks.update,
}));

import { POST as edits } from "@/app/api/livekit/session/[sessionId]/scene/edits/route";
import { POST as decide } from "@/app/api/livekit/session/[sessionId]/scene/proposals/[proposalId]/route";
import { GET } from "@/app/api/livekit/session/[sessionId]/scene/route";
import { createSession } from "@/lib/livekit-session";

function request(token: string, method = "GET") {
	return new Request("http://localhost/", {
		method,
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		...(method === "POST"
			? {
					body: JSON.stringify({
						baseRevision: 0,
						requestId: "request",
						decision: "accept",
					}),
				}
			: {}),
	});
}
beforeEach(() => {
	vi.clearAllMocks();
	Object.assign(process.env, {
		LIVEKIT_URL: "wss://livekit.example",
		LIVEKIT_API_KEY: "test-key",
		LIVEKIT_API_SECRET: "test-secret",
		LIVEKIT_AGENT_NAME: "guide",
		LIVEKIT_GCS_BUCKET: "private",
		LIVEKIT_GCS_CREDENTIALS: "{}",
		LIVEKIT_SESSION_SECRET: "a".repeat(32),
	});
	mocks.dispatch.mockResolvedValue({});
	mocks.read.mockResolvedValue({ scene: { revision: 0 } });
});
it("limits worker scene access to its own session and prevents edits or proposal decisions", async () => {
	const session = await createSession();
	const metadata = JSON.parse(mocks.dispatch.mock.calls[0][2].metadata);
	const worker = metadata.reviewToken;
	const own = { params: Promise.resolve({ sessionId: session.sessionId }) };
	const other = { params: Promise.resolve({ sessionId: crypto.randomUUID() }) };
	expect((await GET(request(worker), own)).status).toBe(200);
	expect(mocks.read).toHaveBeenCalledWith(session.sessionId);
	expect((await GET(request(worker), other)).status).toBe(401);
	expect(
		(
			await decide(request(worker, "POST"), {
				params: Promise.resolve({
					sessionId: session.sessionId,
					proposalId: "p",
				}),
			})
		).status,
	).toBe(401);
	expect((await edits(request(worker, "POST"), own)).status).toBe(401);
	expect(mocks.update).not.toHaveBeenCalled();
	expect((await GET(request(session.sessionToken), own)).status).toBe(200);
});
