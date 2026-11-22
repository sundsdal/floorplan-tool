import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted ensures these are available during vi.mock hoisting
const mockUpload = vi.hoisted(() => vi.fn());
const mockGet = vi.hoisted(() => vi.fn());

vi.mock("@google/genai", () => {
	return {
		GoogleGenAI: class {
			files = {
				upload: mockUpload,
				get: mockGet,
			};
		},
	};
});

import { dissectVideo, uploadVideo } from "@/lib/gemini";

describe("uploadVideo", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("should upload a video and return uri + mimeType when immediately ACTIVE", async () => {
		mockUpload.mockResolvedValue({
			uri: "https://gemini.example.com/files/abc123",
			name: "files/abc123",
			state: "ACTIVE",
			mimeType: "video/mp4",
		});

		const result = await uploadVideo("/tmp/test.mp4");
		expect(result).toEqual({
			uri: "https://gemini.example.com/files/abc123",
			mimeType: "video/mp4",
			name: "files/abc123",
		});
		expect(mockUpload).toHaveBeenCalledWith({
			file: "/tmp/test.mp4",
			config: { mimeType: "video/mp4" },
		});
	});

	it("should poll until file is ACTIVE", async () => {
		mockUpload.mockResolvedValue({
			uri: "https://gemini.example.com/files/poll1",
			name: "files/poll1",
			state: "PROCESSING",
		});

		mockGet
			.mockResolvedValueOnce({ state: "PROCESSING", name: "files/poll1" })
			.mockResolvedValueOnce({
				state: "ACTIVE",
				uri: "https://gemini.example.com/files/poll1",
				name: "files/poll1",
			});

		const result = await uploadVideo("/tmp/test.mp4");
		expect(result.uri).toBe("https://gemini.example.com/files/poll1");
		expect(mockGet).toHaveBeenCalledTimes(2);
	});

	it("should throw when upload returns no URI", async () => {
		mockUpload.mockResolvedValue({
			name: "files/noUri",
			state: "ACTIVE",
		});

		await expect(uploadVideo("/tmp/test.mp4")).rejects.toThrow(
			"Upload failed: no file URI returned",
		);
	});

	it("should throw when file processing fails", async () => {
		mockUpload.mockResolvedValue({
			uri: "https://gemini.example.com/files/fail1",
			name: "files/fail1",
			state: "PROCESSING",
		});

		mockGet.mockResolvedValueOnce({
			state: "FAILED",
			name: "files/fail1",
		});

		await expect(uploadVideo("/tmp/test.mp4")).rejects.toThrow(
			"Video processing failed",
		);
	});

	it("should detect correct MIME types from file extensions", async () => {
		const testCases = [
			{ file: "/tmp/video.mov", expected: "video/quicktime" },
			{ file: "/tmp/video.webm", expected: "video/webm" },
			{ file: "/tmp/video.avi", expected: "video/x-msvideo" },
			{ file: "/tmp/video.3gp", expected: "video/3gpp" },
			{ file: "/tmp/video.unknown", expected: "video/mp4" }, // default
		];

		for (const { file, expected } of testCases) {
			mockUpload.mockResolvedValue({
				uri: "https://gemini.example.com/files/test",
				name: "files/test",
				state: "ACTIVE",
			});

			await uploadVideo(file);
			expect(mockUpload).toHaveBeenLastCalledWith({
				file,
				config: { mimeType: expected },
			});
		}
	});
});

describe("dissectVideo", () => {
	const evidence = {
		clips: [
			{
				start_s: 2,
				end_s: 5,
				room: "Kitchen",
				observation: "Window beside a door",
			},
		],
		gaps: ["Hall connection not shown"],
		room_bounds: [
			{
				room: "Kitchen",
				width_m: { min: 3, max: 4 },
				length_m: { min: 4, max: 5 },
			},
		],
	};

	beforeEach(() => {
		vi.stubEnv("GEMINI_API_KEY", "test-key");
		vi.stubEnv("GEMINI_MODEL", "test-model");
	});

	it("requests agentic processing and parses text from interaction steps", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				steps: [
					{
						type: "model_output",
						content: [{ type: "text", text: JSON.stringify(evidence) }],
					},
				],
			}),
		});
		vi.stubGlobal("fetch", fetchMock);

		const notes = [
			{ seconds: 8, speaker: "guide" as const, text: "Revisit hall" },
		];
		const result = await dissectVideo(
			{ uri: "files/walkthrough", mimeType: "video/mp4; codecs=h264" },
			notes,
		);
		const [url, options] = fetchMock.mock.calls[0];
		expect(url).toContain("/v1beta/interactions");
		expect(options.headers["x-goog-api-key"]).toBe("test-key");
		const body = JSON.parse(options.body);
		expect(body).toMatchObject({ model: "test-model" });
		expect(body.input[0]).toEqual({
			type: "video",
			uri: "files/walkthrough",
			mime_type: "video/mp4",
			processing: "agentic",
		});
		expect(body.input[2].text).toContain(JSON.stringify(notes));
		expect(body.input[2].text).toContain("untrusted leads");
		expect(result).toMatchObject({
			clips: evidence.clips,
			gaps: evidence.gaps,
			room_bounds: evidence.room_bounds,
			discrepancies: [],
		});
	});

	it("parses legacy text outputs", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					outputs: [{ type: "text", text: JSON.stringify(evidence) }],
				}),
			}),
		);
		await expect(
			dissectVideo({ uri: "file", mimeType: "video/mp4" }),
		).resolves.toMatchObject({ clips: evidence.clips });
	});

	it("does not leak raw response content on HTTP or JSON failures", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 502,
				text: async () => "sensitive upstream body",
			}),
		);
		await expect(
			dissectVideo({ uri: "file", mimeType: "video/mp4" }),
		).rejects.toThrow("HTTP 502");

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({ output_text: "not valid secret data" }),
			}),
		);
		await expect(
			dissectVideo({ uri: "file", mimeType: "video/mp4" }),
		).rejects.toThrow("invalid evidence");
		await expect(
			dissectVideo({ uri: "file", mimeType: "video/mp4" }),
		).rejects.not.toThrow("secret");
	});
});
