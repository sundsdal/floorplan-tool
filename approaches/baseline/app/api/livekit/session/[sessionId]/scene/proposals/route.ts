import { z } from "zod";
import { authorizeReview, bearer } from "@/lib/livekit-session";
import {
	propose,
	readScene,
	SceneConflict,
	updateScene,
	validatePlan,
} from "@/lib/scene";
import { authorized, failure, mutationSchema } from "@/lib/scene-route";
export const runtime = "nodejs";
const interval = z
	.object({
		startSeconds: z.number().nonnegative(),
		endSeconds: z.number().positive(),
	})
	.refine((x) => x.endSeconds > x.startSeconds);
export async function POST(
	request: Request,
	context: { params: Promise<{ sessionId: string }> },
) {
	const { sessionId } = await context.params;
	if (!authorized(request, sessionId, true))
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	try {
		const input = mutationSchema
			.extend({
				floorplan: z.unknown(),
				evidence: z.array(interval).max(50).default([]),
			})
			.parse(await request.json());
		const plan = validatePlan(input.floorplan);
		const worker = authorizeReview(sessionId, bearer(request));
		if (
			worker &&
			(await readScene(sessionId)).scene.requests.includes("final-recording")
		)
			return Response.json(
				{ error: "Capture has been finalized." },
				{ status: 409 },
			);
		const scene = await updateScene(
			sessionId,
			input.baseRevision,
			input.requestId,
			(s) => {
				if (worker && s.requests.includes("final-recording"))
					throw new SceneConflict("Capture finalized");
				propose(s, input.requestId, plan, input.evidence);
			},
		);
		return Response.json({ scene });
	} catch (e) {
		return failure(e);
	}
}
