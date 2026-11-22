import {
	finalizeRecording,
	RecordingNotReady,
	waitForFinalRecording,
} from "@/lib/livekit-media";
import {
	authorizeSession,
	bearer,
	closeSession,
	stopRecording,
} from "@/lib/livekit-session";
import { readScene, reconcileFinalScene, SceneConflict } from "@/lib/scene";
export const runtime = "nodejs";
export const maxDuration = 300;
const jobs = new Map<
	string,
	{ promise: ReturnType<typeof finalizeRecording>; expires: number }
>();
export async function POST(
	request: Request,
	context: { params: Promise<{ sessionId: string }> },
) {
	const { sessionId } = await context.params;
	if (!authorizeSession(sessionId, bearer(request)))
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	const now = Date.now();
	for (const [key, job] of jobs) if (job.expires < now) jobs.delete(key);
	let promise = jobs.get(sessionId)?.promise;
	if (!promise) {
		promise = (async () => {
			await stopRecording(sessionId);
			await waitForFinalRecording(sessionId);
			const { scene: current } = await readScene(sessionId);
			const finalPlan = await finalizeRecording(sessionId, current.floorplan);
			const scene = await reconcileFinalScene(
				sessionId,
				finalPlan,
				current.floorplan,
			);
			const floorplan = scene.floorplan;
			await closeSession(sessionId).catch(() => {});
			return floorplan;
		})();
		jobs.set(sessionId, { promise, expires: now + 24 * 60 * 60_000 });
	}
	try {
		return Response.json(
			{ floorplan: await promise },
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch (error) {
		if (jobs.get(sessionId)?.promise === promise) jobs.delete(sessionId);
		return Response.json(
			{
				error:
					error instanceof RecordingNotReady
						? "Recording is still being finalized. Please retry."
						: error instanceof SceneConflict
							? "The plan changed during analysis. Please retry."
							: "Unable to finalize recording. Please retry.",
			},
			{
				status:
					error instanceof RecordingNotReady
						? 425
						: error instanceof SceneConflict
							? 409
							: 503,
			},
		);
	}
}
