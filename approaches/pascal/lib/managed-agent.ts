import { GoogleAuth } from "google-auth-library";

const TIMEOUT_MS = 120_000;

export function managedAgentConfigured(): boolean {
	return Boolean(
		process.env.GOOGLE_CLOUD_PROJECT?.trim() &&
			process.env.GOOGLE_MANAGED_AGENT_ID?.trim(),
	);
}

export async function runManagedAgent(input: string): Promise<string> {
	const project = process.env.GOOGLE_CLOUD_PROJECT?.trim();
	const agent = process.env.GOOGLE_MANAGED_AGENT_ID?.trim();
	if (!project || !agent) throw new Error("Managed agent is not configured");
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const auth = new GoogleAuth({
			scopes: ["https://www.googleapis.com/auth/cloud-platform"],
		});
		const authHeaders = await auth.getRequestHeaders();
		const response = await fetch(
			`https://aiplatform.googleapis.com/v1beta1/projects/${encodeURIComponent(project)}/locations/global/interactions`,
			{
				method: "POST",
				headers: {
					...authHeaders,
					"Content-Type": "application/json",
					"Api-Revision": "2026-05-20",
				},
				body: JSON.stringify({
					agent,
					input: [
						{ type: "user_input", content: [{ type: "text", text: input }] },
					],
					stream: true,
					background: true,
					store: true,
				}),
				signal: controller.signal,
			},
		);
		if (!response.ok || !response.body) throw new Error("Request failed");
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let result = "";
		let fallback = "";
		let complete = false;
		const handle = (frame: string) => {
			const data = frame
				.split(/\r?\n/)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n");
			if (!data || data === "[DONE]") return;
			const event = JSON.parse(data);
			if (event.event_type === "error") throw new Error("Agent failed");
			if (
				(event.event_type === "content.delta" ||
					event.event_type === "step.delta") &&
				event.delta?.type === "text" &&
				typeof event.delta.text === "string"
			)
				result += event.delta.text;
			if (
				event.event_type === "interaction.complete" ||
				event.event_type === "interaction.completed"
			) {
				if (event.interaction?.status !== "completed")
					throw new Error("Agent failed");
				fallback = (event.interaction?.steps ?? [])
					.filter((step: { type: string }) => step.type === "model_output")
					.flatMap(
						(step: { content?: Array<{ type: string; text?: string }> }) =>
							step.content ?? [],
					)
					.filter((part: { type: string }) => part.type === "text")
					.map((part: { text?: string }) => part.text ?? "")
					.join("");
				complete = true;
			}
		};
		while (true) {
			const { value, done } = await reader.read();
			buffer += decoder.decode(value, { stream: !done });
			const frames = buffer.split(/\r?\n\r?\n/);
			buffer = frames.pop() ?? "";
			for (const frame of frames) handle(frame);
			if (done) break;
		}
		if (buffer.trim()) handle(buffer);
		result ||= fallback;
		if (!complete || !result.trim()) throw new Error("Incomplete response");
		return result;
	} catch {
		throw new Error(
			controller.signal.aborted
				? "Managed agent request timed out"
				: "Managed agent request failed",
		);
	} finally {
		clearTimeout(timeout);
	}
}
