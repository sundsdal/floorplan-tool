import { z } from "zod";
import { RecordingNotReady, reviewRecording } from "@/lib/livekit-media";
import { authorizeReview, bearer } from "@/lib/livekit-session";
export const runtime = "nodejs";
export const maxDuration = 300;
const schema = z
	.object({
		sessionId: z.string().uuid(),
		requestId: z.string().uuid(),
		revision: z.number().int().nonnegative(),
		room: z.string().trim().min(1).max(200),
		question: z.string().trim().min(1).max(2000),
		startSeconds: z.number().finite().nonnegative(),
		endSeconds: z.number().finite().positive(),
	})
	.strict()
	.refine(
		(v) => v.endSeconds > v.startSeconds && v.endSeconds - v.startSeconds <= 60,
	);
const jobs = new Map<
	string,
	{
		revision: number;
		requestId: string;
		promise: Promise<unknown>;
		expires: number;
	}
>();
export async function POST(request: Request) {
	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return Response.json({ error: "Invalid request." }, { status: 400 });
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success)
		return Response.json({ error: "Invalid request." }, { status: 400 });
	const input = parsed.data;
	if (!authorizeReview(input.sessionId, bearer(request)))
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	const now = Date.now();
	for (const [key, job] of jobs) if (job.expires < now) jobs.delete(key);
	const current = jobs.get(input.sessionId);
	if (
		current &&
		(input.revision < current.revision ||
			(input.revision === current.revision &&
				input.requestId !== current.requestId))
	)
		return Response.json({ error: "Stale review revision." }, { status: 409 });
	let promise =
		current?.revision === input.revision &&
		current.requestId === input.requestId
			? current.promise
			: undefined;
	if (!promise) {
		promise = (async () => {
			let result: Awaited<ReturnType<typeof reviewRecording>> | undefined;
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					result = await reviewRecording(
						input.sessionId,
						[
							{
								startSeconds: input.startSeconds,
								endSeconds: input.endSeconds,
							},
						],
						input.room,
						input.question,
					);
					break;
				} catch (error) {
					if (!(error instanceof RecordingNotReady) || attempt === 2)
						throw error;
					await new Promise((resolve) => setTimeout(resolve, 1000));
				}
			}
			return {
				...result,
				requestId: input.requestId,
				revision: input.revision,
			};
		})();
		jobs.set(input.sessionId, {
			revision: input.revision,
			requestId: input.requestId,
			promise,
			expires: now + 15 * 60_000,
		});
	}
	try {
		const result = await promise;
		if (jobs.get(input.sessionId)?.revision !== input.revision)
			return Response.json(
				{ error: "Stale review revision." },
				{ status: 409 },
			);
		return Response.json(result, { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		if (jobs.get(input.sessionId)?.promise === promise)
			jobs.delete(input.sessionId);
		return Response.json(
			{
				error:
					error instanceof RecordingNotReady
						? "Recording segment is not ready."
						: "Geometry review failed.",
			},
			{ status: error instanceof RecordingNotReady ? 425 : 502 },
		);
	}
}
