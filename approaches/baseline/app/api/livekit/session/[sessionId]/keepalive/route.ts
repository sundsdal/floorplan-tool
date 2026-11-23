import { authorizeSession, bearer } from "@/lib/livekit-session";

export const runtime = "nodejs";

export async function GET(
	request: Request,
	context: { params: Promise<{ sessionId: string }> },
) {
	const { sessionId } = await context.params;
	if (!authorizeSession(sessionId, bearer(request)))
		return new Response(null, { status: 401 });
	await new Promise<void>((resolve) => {
		const timer = setTimeout(done, 240_000);
		function done() {
			clearTimeout(timer);
			request.signal.removeEventListener("abort", done);
			resolve();
		}
		if (request.signal.aborted) done();
		else request.signal.addEventListener("abort", done, { once: true });
	});
	return new Response(null, {
		status: 204,
		headers: { "Cache-Control": "no-store" },
	});
}
