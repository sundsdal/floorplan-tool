// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/gemini", () => ({
	uploadVideo: vi.fn().mockResolvedValue({
		uri: "file:clip",
		mimeType: "video/mp4",
		name: "files/clip",
	}),
	deleteUploadedVideo: vi.fn().mockResolvedValue(undefined),
	reviewGeometry: vi.fn().mockResolvedValue({
		finding: "Door visible",
		supportingTimestamps: [12],
		resolved: true,
	}),
}));

vi.mock("@/lib/managed-agent", () => ({
	managedAgentConfigured: vi.fn().mockReturnValue(true),
	runManagedAgent: vi.fn().mockResolvedValue(
		JSON.stringify({
			finding: "Door visible",
			supportingTimestamps: [12],
			resolved: true,
		}),
	),
}));

import { POST } from "@/app/api/review-geometry/route";
import { deleteUploadedVideo, reviewGeometry, uploadVideo } from "@/lib/gemini";
import { managedAgentConfigured, runManagedAgent } from "@/lib/managed-agent";

function request(sessionId: string, revision = 1, requestId = "call-1") {
	const form = new FormData();
	form.set("video", new File(["clip"], "clip.mp4", { type: "video/mp4" }));
	for (const [key, value] of Object.entries({
		sessionId,
		revision,
		requestId,
		room: "Kitchen",
		question: "Where is the door?",
		startSeconds: 10,
		endSeconds: 20,
	}))
		form.set(key, String(value));
	return new Request("http://localhost/api/review-geometry", {
		method: "POST",
		body: form,
	});
}
describe("review geometry", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.GEMINI_API_KEY = "test";
	});
	it("reviews the clip and cleans up its uploaded file", async () => {
		const response = await POST(request("review-success"));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			finding: "Door visible",
			supportingTimestamps: [12],
			revision: 1,
			requestId: "call-1",
		});
		expect(reviewGeometry).toHaveBeenCalledWith(
			expect.any(Array),
			[{ startSeconds: 10, endSeconds: 20 }],
			"Kitchen",
			"Where is the door?",
		);
		expect(deleteUploadedVideo).toHaveBeenCalledOnce();
	});
	it("reuses duplicate requests and rejects older revisions", async () => {
		expect((await POST(request("review-duplicate", 2))).status).toBe(200);
		expect((await POST(request("review-duplicate", 2))).status).toBe(200);
		expect(uploadVideo).toHaveBeenCalledOnce();
		expect((await POST(request("review-duplicate", 1))).status).toBe(409);
		expect((await POST(request("review-duplicate", 2, "another"))).status).toBe(
			409,
		);
	});
	it("returns 503 before uploading when managed agent is unavailable", async () => {
		vi.mocked(managedAgentConfigured).mockReturnValueOnce(false);
		expect((await POST(request("review-unavailable"))).status).toBe(503);
		expect(uploadVideo).not.toHaveBeenCalled();
	});
	it("rejects timestamps not supported by video evidence", async () => {
		vi.mocked(runManagedAgent).mockResolvedValueOnce(
			JSON.stringify({
				finding: "Door visible",
				supportingTimestamps: [15],
				resolved: true,
			}),
		);
		expect((await POST(request("review-invented"))).status).toBe(502);
	});
	it("rejects invalid uploads before review", async () => {
		const response = await POST(
			new Request("http://localhost", { method: "POST", body: new FormData() }),
		);
		expect(response.status).toBe(400);
		expect(reviewGeometry).not.toHaveBeenCalled();
	});
});
