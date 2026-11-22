// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	stop: vi.fn(),
	wait: vi.fn(),
	finalize: vi.fn(),
	close: vi.fn(),
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
	finalizeRecording: mocks.finalize,
}));

import { POST } from "@/app/api/livekit/session/[sessionId]/finalize/route";
import { RecordingNotReady } from "@/lib/livekit-media";

function call(sessionId: string) {
	return POST(new Request("http://localhost", { method: "POST" }), {
		params: Promise.resolve({ sessionId }),
	});
}
describe("finalization", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.stop.mockResolvedValue(undefined);
		mocks.wait.mockResolvedValue(undefined);
		mocks.close.mockResolvedValue(undefined);
		mocks.finalize.mockResolvedValue({ walls: [] });
	});
	it("coalesces duplicate requests and reuses the completed result", async () => {
		const id = crypto.randomUUID();
		const [first, second] = await Promise.all([call(id), call(id)]);
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect((await call(id)).status).toBe(200);
		expect(mocks.stop).toHaveBeenCalledTimes(1);
		expect(mocks.finalize).toHaveBeenCalledTimes(1);
	});
	it("returns 425 while the completed playlist is pending and permits retry", async () => {
		const id = crypto.randomUUID();
		mocks.wait.mockRejectedValueOnce(new RecordingNotReady());
		expect((await call(id)).status).toBe(425);
		expect((await call(id)).status).toBe(200);
		expect(mocks.finalize).toHaveBeenCalledTimes(1);
	});
});
