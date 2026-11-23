import {
	inspectionReviewInput,
	reviewInspection,
} from "@/lib/inspection-review";
import { RecordingNotReady } from "@/lib/livekit-media";
import { authorizeReview, bearer } from "@/lib/livekit-session";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(
	request: Request,
	context: { params: Promise<{ sessionId: string }> },
) {
	const { sessionId } = await context.params;
	if (!authorizeReview(sessionId, bearer(request)))
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	const input = inspectionReviewInput.safeParse(
		await request.json().catch(() => null),
	);
	if (!input.success)
		return Response.json(
			{ error: "Invalid inspection context" },
			{ status: 400 },
		);
	try {
		const result = await reviewInspection(
			sessionId,
			input.data,
			input.data.endSeconds,
		);
		return Response.json(result, { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		return Response.json(
			{ error: "Inspection review unavailable" },
			{ status: error instanceof RecordingNotReady ? 425 : 503 },
		);
	}
}
