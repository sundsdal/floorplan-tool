import { inspectionContext, reviewInspection } from "@/lib/inspection-review";
import { RecordingNotReady, waitForFinalRecording } from "@/lib/livekit-media";
import {
	authorizeSession,
	bearer,
	closeSession,
	stopRecording,
} from "@/lib/livekit-session";

export const runtime = "nodejs";
export const maxDuration = 300;

const finalizing = new Map<
	string,
	Promise<Awaited<ReturnType<typeof reviewInspection>>>
>();

export async function POST(
	request: Request,
	context: { params: Promise<{ sessionId: string }> },
) {
	const { sessionId } = await context.params;
	if (!authorizeSession(sessionId, bearer(request)))
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	const input = inspectionContext.safeParse(
		await request.json().catch(() => null),
	);
	if (!input.success)
		return Response.json(
			{ error: "Invalid inspection context" },
			{ status: 400 },
		);
	const payload = input.data;
	let result = finalizing.get(sessionId);
	if (!result) {
		result = (async () => {
			await stopRecording(sessionId);
			await closeSession(sessionId).catch(() => {});
			await waitForFinalRecording(sessionId);
			return reviewInspection(sessionId, payload);
		})();
		finalizing.set(sessionId, result);
	}
	try {
		return Response.json(await result, {
			headers: { "Cache-Control": "no-store" },
		});
	} catch (error) {
		return Response.json(
			{ error: "Inspection review unavailable" },
			{ status: error instanceof RecordingNotReady ? 425 : 503 },
		);
	} finally {
		if (finalizing.get(sessionId) === result) finalizing.delete(sessionId);
	}
}
