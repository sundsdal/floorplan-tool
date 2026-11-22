import { z } from "zod";
import { updateScene, validatePlan } from "@/lib/scene";
import { authorized, failure, mutationSchema } from "@/lib/scene-route";
export const runtime = "nodejs";
export async function POST(
	request: Request,
	context: { params: Promise<{ sessionId: string }> },
) {
	const { sessionId } = await context.params;
	if (!authorized(request, sessionId))
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	try {
		const input = mutationSchema
			.extend({ floorplan: z.unknown() })
			.parse(await request.json());
		const plan = validatePlan(input.floorplan);
		const scene = await updateScene(
			sessionId,
			input.baseRevision,
			input.requestId,
			(s) => {
				s.floorplan = plan;
			},
		);
		return Response.json({ scene });
	} catch (e) {
		return failure(e);
	}
}
