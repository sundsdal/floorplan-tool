import {
	authorizeSession,
	bearer,
	startRecording,
} from "@/lib/livekit-session";
export const runtime = "nodejs";
export async function POST(
	request: Request,
	context: { params: Promise<{ sessionId: string }> },
) {
	const { sessionId } = await context.params;
	if (!authorizeSession(sessionId, bearer(request)))
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	try {
		return Response.json(await startRecording(sessionId), {
			headers: { "Cache-Control": "no-store" },
		});
	} catch {
		return Response.json(
			{ error: "Unable to start recording." },
			{ status: 503 },
		);
	}
}
