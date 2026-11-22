import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("google-auth-library", () => ({
	GoogleAuth: class {
		getRequestHeaders() {
			return Promise.resolve({
				Authorization: "Bearer token",
				"x-goog-user-project": "quota",
			});
		}
	},
}));

import { managedAgentConfigured, runManagedAgent } from "../lib/managed-agent";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("managed agent", () => {
	it("requires a project and agent", () => {
		vi.stubEnv("GOOGLE_CLOUD_PROJECT", "");
		expect(managedAgentConfigured()).toBe(false);
	});
	it("sends an authenticated request and reads streamed text", async () => {
		vi.stubEnv("GOOGLE_CLOUD_PROJECT", "project");
		vi.stubEnv("GOOGLE_MANAGED_AGENT_ID", "agent-id");
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				new Response(
					'data: {"event_type":"content.delta","delta":{"type":"text","text":"hello"}}\n\ndata: {"event_type":"interaction.complete","interaction":{"status":"completed"}}\n\n',
				),
			);
		vi.stubGlobal("fetch", fetchMock);
		expect(await runManagedAgent("input")).toBe("hello");
		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
			agent: "agent-id",
			input: [
				{ type: "user_input", content: [{ type: "text", text: "input" }] },
			],
			stream: true,
			background: true,
			store: true,
		});
	});
	it("rejects incomplete streams without leaking server errors", async () => {
		vi.stubEnv("GOOGLE_CLOUD_PROJECT", "project");
		vi.stubEnv("GOOGLE_MANAGED_AGENT_ID", "agent-id");
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					new Response('data: {"event_type":"error","message":"secret"}\n\n'),
				),
		);
		await expect(runManagedAgent("input")).rejects.toThrow(
			"Managed agent request failed",
		);
	});
	it("handles split SSE chunks and multiple model steps", async () => {
		vi.stubEnv("GOOGLE_CLOUD_PROJECT", "project");
		vi.stubEnv("GOOGLE_MANAGED_AGENT_ID", "agent-id");
		const events = [
			{ event_type: "step.start", index: 0, step: { type: "model_output" } },
			{
				event_type: "step.delta",
				index: 0,
				delta: { type: "text", text: "Hello " },
			},
			{ event_type: "step.start", index: 1, step: { type: "model_output" } },
			{
				event_type: "step.delta",
				index: 1,
				delta: { type: "text", text: "world" },
			},
			{
				event_type: "interaction.completed",
				interaction: { status: "completed" },
			},
		];
		const bytes = new TextEncoder().encode(
			events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("") +
				"data: [DONE]\n\n",
		);
		const stream = new ReadableStream({
			start(controller) {
				for (let i = 0; i < bytes.length; i += 7)
					controller.enqueue(bytes.slice(i, i + 7));
				controller.close();
			},
		});
		const fetchMock = vi.fn().mockResolvedValue(new Response(stream));
		vi.stubGlobal("fetch", fetchMock);
		expect(await runManagedAgent("input")).toBe("Hello world");
		expect(fetchMock.mock.calls[0][1].headers["x-goog-user-project"]).toBe(
			"quota",
		);
	});
	it("uses completed model output steps when no deltas were sent", async () => {
		vi.stubEnv("GOOGLE_CLOUD_PROJECT", "project");
		vi.stubEnv("GOOGLE_MANAGED_AGENT_ID", "agent-id");
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					`data: ${JSON.stringify({
						event_type: "interaction.completed",
						interaction: {
							status: "completed",
							steps: [
								{
									type: "thought",
									content: [{ type: "text", text: "private" }],
								},
								{
									type: "model_output",
									content: [{ type: "text", text: "answer" }],
								},
							],
						},
					})}\n\n`,
				),
			),
		);
		expect(await runManagedAgent("input")).toBe("answer");
	});
});
