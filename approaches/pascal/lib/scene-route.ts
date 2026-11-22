import { z } from "zod";
import { authorizeReview, authorizeSession, bearer } from "./livekit-session";
import { SceneConflict } from "./scene";
export const mutationSchema = z.object({
	baseRevision: z.number().int().nonnegative(),
	requestId: z.string().min(1).max(200),
});
export function authorized(request: Request, id: string, review = false) {
	const token = bearer(request);
	return authorizeSession(id, token) || (review && authorizeReview(id, token));
}
export function failure(error: unknown) {
	if (error instanceof SceneConflict)
		return Response.json({ error: "Stale scene revision." }, { status: 409 });
	if (
		error instanceof z.ZodError ||
		error instanceof SyntaxError ||
		(error instanceof Error && /Invalid|Duplicate/.test(error.message))
	)
		return Response.json({ error: "Invalid scene request." }, { status: 400 });
	return Response.json({ error: "Scene unavailable." }, { status: 503 });
}
