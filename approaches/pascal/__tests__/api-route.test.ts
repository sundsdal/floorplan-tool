// @vitest-environment node

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies
vi.mock("@/lib/gemini", () => ({
	deleteUploadedVideo: vi.fn().mockResolvedValue(undefined),
	uploadVideo: vi.fn().mockResolvedValue({
		uri: "https://gemini.example.com/files/test",
		mimeType: "video/mp4",
	}),
	dissectVideo: vi.fn().mockResolvedValue({
		clips: [],
		gaps: [],
		room_bounds: [],
		discrepancies: [],
	}),
	getGeminiModel: vi.fn().mockReturnValue("gemini-test"),
}));

vi.mock("@/lib/managed-agent", () => ({
	managedAgentConfigured: vi.fn().mockReturnValue(true),
	runManagedAgent: vi.fn().mockResolvedValue(
		JSON.stringify({
			walls: [],
			doors: [],
			windows: [],
			rooms: [],
			dimensions: [],
			total_area_m2: 0,
		}),
	),
}));

vi.mock(
	"fs/promises",
	async (importOriginal: () => Promise<typeof import("fs/promises")>) => {
		const actual = await importOriginal();
		return {
			...actual,
			default: actual,
			writeFile: vi.fn().mockResolvedValue(undefined),
			unlink: vi.fn().mockResolvedValue(undefined),
			mkdir: vi.fn().mockResolvedValue(undefined),
		};
	},
);

import { POST } from "@/app/api/floorplan/route";

function createMultipartRequest(
	file?: File,
	captureNotes?: unknown,
): NextRequest {
	const formData = new FormData();
	if (file) {
		formData.append("video", file);
	}
	if (captureNotes !== undefined)
		formData.append("captureNotes", JSON.stringify(captureNotes));
	return new NextRequest("http://localhost:3000/api/floorplan", {
		method: "POST",
		body: formData,
	});
}

function createJsonRequest(): NextRequest {
	return new NextRequest("http://localhost:3000/api/floorplan", {
		method: "POST",
		body: JSON.stringify({ video: "test" }),
		headers: { "content-type": "application/json" },
	});
}

describe("POST /api/floorplan", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.GEMINI_API_KEY = "test";
	});

	describe("input validation", () => {
		it("should return 400 for non-multipart request", async () => {
			const request = createJsonRequest();
			const response = await POST(request);
			expect(response.status).toBe(400);
			const body = await response.json();
			expect(body.error).toContain("multipart/form-data");
		});

		it("should return 400 when no video field is provided", async () => {
			const request = createMultipartRequest(); // no file
			const response = await POST(request);
			expect(response.status).toBe(400);
			const body = await response.json();
			expect(body.error).toContain("No video file");
		});

		it("should return 400 for unsupported video format", async () => {
			const file = new File(["data"], "test.txt", { type: "text/plain" });
			const request = createMultipartRequest(file);
			const response = await POST(request);
			expect(response.status).toBe(400);
			const body = await response.json();
			expect(body.error).toContain("Unsupported video format");
		});

		it("should return 413 for file exceeding size limit", async () => {
			const bigFile = new File(["x"], "big.mp4", { type: "video/mp4" });
			Object.defineProperty(bigFile, "size", {
				value: 600 * 1024 * 1024,
				configurable: true,
			});

			const request = new NextRequest("http://localhost:3000/api/floorplan", {
				method: "POST",
				body: new FormData(), // dummy body to set content-type
			});
			// Mock formData() to return a FormData-like object that preserves our size override
			const mockFd = {
				get: vi.fn((name: string) => (name === "video" ? bigFile : null)),
			} as unknown as FormData;
			vi.spyOn(request, "formData").mockResolvedValue(mockFd);

			const response = await POST(request);
			expect(response.status).toBe(413);
			const body = await response.json();
			expect(body.error).toContain("too large");
		});
	});

	it("returns 503 before upload when managed agent is unavailable", async () => {
		const { managedAgentConfigured } = await import("@/lib/managed-agent");
		const { uploadVideo } = await import("@/lib/gemini");
		vi.mocked(managedAgentConfigured).mockReturnValueOnce(false);
		const response = await POST(
			createMultipartRequest(
				new File(["data"], "test.mp4", { type: "video/mp4" }),
			),
		);
		expect(response.status).toBe(503);
		expect(uploadVideo).not.toHaveBeenCalled();
	});

	describe("SSE response", () => {
		it("should return text/event-stream content type for valid request", async () => {
			const file = new File(["videodata"], "test.mp4", { type: "video/mp4" });
			const request = createMultipartRequest(file);
			const response = await POST(request);

			expect(response.headers.get("Content-Type")).toBe("text/event-stream");
			expect(response.headers.get("Cache-Control")).toBe("no-cache");
		});

		it("should stream SSE events in correct format", async () => {
			const file = new File(["videodata"], "test.mp4", { type: "video/mp4" });
			const request = createMultipartRequest(file);
			const response = await POST(request);

			const text = await response.text();
			const events = text
				.split("\n\n")
				.filter((e) => e.startsWith("data: "))
				.map((e) => JSON.parse(e.replace("data: ", "")));

			expect(events.length).toBeGreaterThanOrEqual(2);
			expect(events[0].type).toBe("system");
			expect(events[0].timestamp).toBeDefined();
			expect(events[0].elapsed_ms).toBeDefined();

			const { deleteUploadedVideo } = await import("@/lib/gemini");
			expect(deleteUploadedVideo).toHaveBeenCalledOnce();
			const lastEvent = events[events.length - 1];
			expect(lastEvent.type).toBe("result");
			expect(lastEvent.floorplan).toBeDefined();
			expect(events.some((event) => event.type === "evidence")).toBe(true);
		});

		it("dissects the uploaded video before generation and emits evidence", async () => {
			const { dissectVideo } = await import("@/lib/gemini");
			const { runManagedAgent } = await import("@/lib/managed-agent");
			const file = new File(["videodata"], "test.mp4", { type: "video/mp4" });

			const response = await POST(createMultipartRequest(file));
			const events = (await response.text())
				.split("\n\n")
				.filter((event) => event.startsWith("data: "))
				.map((event) => JSON.parse(event.slice(6)));

			expect(dissectVideo).toHaveBeenCalledWith(
				{
					uri: "https://gemini.example.com/files/test",
					mimeType: "video/mp4",
				},
				[],
			);
			expect(runManagedAgent).toHaveBeenCalledWith(
				expect.stringContaining("room_bounds"),
			);
			expect(events.filter((event) => event.type === "evidence")).toHaveLength(
				2,
			);
			expect(
				events.find((event) => event.type === "evidence").evidence,
			).toMatchObject({
				clips: [],
				gaps: [],
				room_bounds: [],
				discrepancies: [],
			});
		});

		it("cleans up uploaded video when managed output is invalid", async () => {
			const { runManagedAgent } = await import("@/lib/managed-agent");
			const { deleteUploadedVideo } = await import("@/lib/gemini");
			vi.mocked(runManagedAgent).mockResolvedValueOnce("not JSON");
			const response = await POST(
				createMultipartRequest(
					new File(["data"], "test.mp4", { type: "video/mp4" }),
				),
			);
			expect(await response.text()).toContain('"type":"error"');
			expect(deleteUploadedVideo).toHaveBeenCalledOnce();
		});

		it("rejects malformed capture notes and forwards valid notes for dissection", async () => {
			const file = new File(["videodata"], "test.mp4", { type: "video/mp4" });
			const invalid = await POST(
				createMultipartRequest(file, [
					{ seconds: -1, speaker: "user", text: "door" },
				]),
			);
			expect(invalid.status).toBe(400);

			const notes = [
				{ seconds: 8, speaker: "guide", text: "Revisit the hallway doorway" },
			];
			const response = await POST(createMultipartRequest(file, notes));
			expect(response.status).toBe(200);
			await response.text();
			const { dissectVideo } = await import("@/lib/gemini");
			expect(dissectVideo).toHaveBeenLastCalledWith(
				{ uri: "https://gemini.example.com/files/test", mimeType: "video/mp4" },
				notes,
			);
		});
	});

	describe("supported formats", () => {
		const formats = [
			{ ext: "mp4", mime: "video/mp4" },
			{ ext: "mov", mime: "video/quicktime" },
			{ ext: "webm", mime: "video/webm" },
			{ ext: "avi", mime: "video/x-msvideo" },
			{ ext: "3gp", mime: "video/3gpp" },
		];

		for (const { ext, mime } of formats) {
			it(`should accept .${ext} files (${mime})`, async () => {
				const file = new File(["data"], `test.${ext}`, { type: mime });
				const request = createMultipartRequest(file);
				const response = await POST(request);
				expect(response.headers.get("Content-Type")).toBe("text/event-stream");
			});
		}
	});
});
