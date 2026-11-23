// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	events: vi.fn(),
	review: vi.fn(),
	stop: vi.fn(),
	wait: vi.fn(),
	close: vi.fn(),
	append: vi.fn(),
}));
vi.mock("@/lib/inspection-events", () => ({
	allEvents: mocks.events,
	appendEvent: mocks.append,
	Unlinked: class Unlinked extends Error {},
}));
vi.mock("@/lib/livekit-session", () => ({
	authorizeSession: () => true,
	bearer: () => "token",
	stopRecording: mocks.stop,
	closeSession: mocks.close,
}));
vi.mock("@/lib/livekit-media", () => ({
	RecordingNotReady: class RecordingNotReady extends Error {},
	waitForFinalRecording: mocks.wait,
}));
vi.mock("@/lib/inspection-review", async (original) => ({
	...(await original<typeof import("@/lib/inspection-review")>()),
	reviewInspection: mocks.review,
}));

import { POST } from "@/app/api/livekit/session/[sessionId]/inspection/finalize/route";
import { Unlinked } from "@/lib/inspection-events";

const id = "9e04f6b1-7f90-42d9-9f65-7c405e5b1897";
const other = "304bf0d3-8a48-482c-bb8f-034fa5767cf4";
function call(rooms: unknown[]) {
	return POST(
		new Request("http://localhost", {
			method: "POST",
			body: JSON.stringify({ work: "male", rooms, evidence: [] }),
		}),
		{ params: Promise.resolve({ sessionId: crypto.randomUUID() }) },
	);
}
beforeEach(() => {
	vi.resetAllMocks();
	mocks.review.mockResolvedValue({ summary: "Done", requests: [] });
	mocks.close.mockResolvedValue(undefined);
});
it("recovers linked rooms and preserves local offsets with latest durable names", async () => {
	mocks.events.mockResolvedValue([
		{ type: "room.upsert", roomId: id, data: { name: "Old" } },
		{ type: "room.named", roomId: id, data: { name: "Kitchen" } },
		{ type: "room.upsert", roomId: other, data: { name: "Hall" } },
	]);
	expect(
		(await call([{ roomId: id, name: "Local", seconds: 12 }])).status,
	).toBe(200);
	expect(mocks.review.mock.calls[0][1].rooms).toEqual([
		{ roomId: id, name: "Kitchen", seconds: 12 },
		{ roomId: other, name: "Hall" },
	]);
	expect((await call([])).status).toBe(200);
	expect(mocks.review.mock.calls[1][1].rooms).toHaveLength(2);
});
it("rejects empty unlinked or linked sessions without rooms", async () => {
	mocks.events.mockRejectedValueOnce(new Unlinked()).mockResolvedValueOnce([]);
	expect((await call([])).status).toBe(400);
	expect((await call([])).status).toBe(400);
	expect(mocks.stop).not.toHaveBeenCalled();
});
