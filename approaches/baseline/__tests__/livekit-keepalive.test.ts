// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/livekit/session/[sessionId]/keepalive/route";

vi.mock("@/lib/livekit-session", () => ({
	authorizeSession: (id: string, token: string) =>
		id === "session" && token === "valid",
	bearer: (request: Request) =>
		request.headers.get("authorization")?.replace("Bearer ", "") ?? "",
}));

const context = { params: Promise.resolve({ sessionId: "session" }) };
afterEach(() => vi.useRealTimers());
describe("capture keepalive", () => {
	it("requires the session capability", async () => {
		const response = await GET(new Request("http://localhost"), context);
		expect(response.status).toBe(401);
	});
	it("ends after four minutes or when cancelled", async () => {
		vi.useFakeTimers();
		const request = new Request("http://localhost", {
			headers: { Authorization: "Bearer valid" },
		});
		const response = GET(request, context);
		await vi.advanceTimersByTimeAsync(240_000);
		expect((await response).status).toBe(204);
		const controller = new AbortController();
		const cancelled = GET(
			new Request("http://localhost", {
				headers: { Authorization: "Bearer valid" },
				signal: controller.signal,
			}),
			context,
		);
		await Promise.resolve();
		controller.abort();
		expect((await cancelled).status).toBe(204);
		expect(vi.getTimerCount()).toBe(0);
	});
});
