// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const createToken = vi.fn();
vi.mock("@google/genai", () => ({
	Modality: { AUDIO: "AUDIO" },
	Behavior: { NON_BLOCKING: "NON_BLOCKING" },
	Type: { OBJECT: "OBJECT", STRING: "STRING", NUMBER: "NUMBER" },
	GoogleGenAI: class {
		authTokens = { create: createToken };
	},
}));

import { POST } from "@/app/api/capture-guide/route";

describe("POST /api/capture-guide", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		createToken.mockReset();
	});

	it("requires an API key before creating a short-lived token", async () => {
		const response = await POST();
		expect(response.status).toBe(503);
		expect(createToken).not.toHaveBeenCalled();
	});

	it("creates a one-use token constrained to the configured Live model", async () => {
		vi.stubEnv("GEMINI_API_KEY", "test-key");
		vi.stubEnv("GEMINI_LIVE_MODEL", "gemini-live-test");
		createToken.mockResolvedValue({ name: "auth_tokens/test-token" });

		const response = await POST();

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			token: "auth_tokens/test-token",
			model: "gemini-live-test",
		});
		const [request] = createToken.mock.calls[0];
		expect(request.config).toMatchObject({
			uses: 1,
			liveConnectConstraints: {
				model: "gemini-live-test",
				config: { responseModalities: ["AUDIO"] },
			},
		});
		expect(Date.parse(request.config.expireTime)).toBeGreaterThan(Date.now());
		expect(Date.parse(request.config.newSessionExpireTime)).toBeGreaterThan(
			Date.now(),
		);
	});

	it("constrains mobile tokens to the review tool", async () => {
		vi.stubEnv("GEMINI_API_KEY", "test-key");
		createToken.mockResolvedValue({ name: "auth_tokens/mobile" });
		const response = await POST(
			new Request("http://localhost/api/capture-guide", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ mobile: true }),
			}),
		);
		expect(response.status).toBe(200);
		expect(
			createToken.mock.calls[0][0].config.liveConnectConstraints.config.tools[0]
				.functionDeclarations[0],
		).toMatchObject({
			name: "review_geometry",
			parameters: {
				required: ["room", "question", "startSeconds", "endSeconds"],
			},
		});
	});

	it("returns a recoverable error when token creation fails", async () => {
		vi.stubEnv("GEMINI_API_KEY", "test-key");
		vi.spyOn(console, "error").mockImplementation(() => {});
		createToken.mockRejectedValue(new Error("service unavailable"));
		const response = await POST();
		expect(response.status).toBe(502);
		await expect(response.json()).resolves.toMatchObject({
			error: expect.stringContaining("continue recording"),
		});
	});
});
