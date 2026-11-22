import { z } from "zod";
import { draftRecording, RecordingNotReady } from "@/lib/livekit-media";
import {
	propose,
	readScene,
	SceneConflict,
	scopedPlan,
	updateScene,
} from "@/lib/scene";
import { authorized, failure, mutationSchema } from "@/lib/scene-route";
export const runtime = "nodejs";
export const maxDuration = 300;
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
				targetId: z.string().min(1).max(200).optional(),
				startSeconds: z.number().nonnegative(),
				endSeconds: z.number().positive(),
			})
			.refine(
				(x) =>
					x.endSeconds > x.startSeconds && x.endSeconds - x.startSeconds <= 60,
			)
			.parse(await request.json());
		const current = await readScene(sessionId);
		if (current.scene.requests.includes("final-recording"))
			return Response.json(
				{ error: "Capture has been finalized." },
				{ status: 409 },
			);
		if (current.scene.requests.includes(input.requestId))
			return Response.json({ scene: current.scene });
		if (current.scene.revision !== input.baseRevision)
			return Response.json({ error: "Stale scene revision." }, { status: 409 });
		const range = {
			startSeconds: input.startSeconds,
			endSeconds: input.endSeconds,
		};
		const previous = input.targetId
			? (current.scene.elementEvidence[input.targetId] ?? [])
			: [];
		const ranges = [...previous, { ...range, targetId: input.targetId }];
		const draft = await draftRecording(
			sessionId,
			ranges,
			current.scene.floorplan,
			input.targetId,
		);
		const scene = await updateScene(
			sessionId,
			input.baseRevision,
			input.requestId,
			(s) => {
				if (s.requests.includes("final-recording"))
					throw new SceneConflict("Capture finalized");
				if (draft.unresolved) {
					s.finding = draft.finding;
					s.nextView = draft.nextView;
					return;
				}
				delete s.finding;
				delete s.nextView;
				const scoped = scopedPlan(s.floorplan, draft.floorplan, input.targetId);
				if (
					input.targetId &&
					JSON.stringify(scoped) === JSON.stringify(s.floorplan)
				)
					return;
				propose(s, input.requestId, scoped, ranges, input.targetId);
			},
		);
		return Response.json({ scene });
	} catch (e) {
		if (e instanceof RecordingNotReady)
			return Response.json(
				{ error: "Recording is not ready." },
				{ status: 425 },
			);
		return failure(e);
	}
}
