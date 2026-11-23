import { randomUUID } from "node:crypto";
import { allEvents, appendEvent, Unlinked } from "@/lib/inspection-events";
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
			const events = await allEvents(sessionId).catch((e) => {
				if (e instanceof Unlinked) return null;
				throw e;
			});
			const complete = events?.find((e) => e.type === "inspection.completed");
			if (complete)
				return { summary: String(complete.data.summary), requests: [] };
			if (
				events?.some(
					(e) =>
						e.type === "evidence.marked" &&
						!events.some(
							(out) =>
								(out.type === "evidence.saved" ||
									(out.type === "evidence.retry" &&
										out.capturedAt >= e.capturedAt)) &&
								out.data.requestId === e.data.requestId,
						),
				)
			)
				throw new RecordingNotReady();
			await stopRecording(sessionId);
			await closeSession(sessionId).catch(() => {});
			await waitForFinalRecording(sessionId);
			const saved = events
				?.filter((e) => e.type === "evidence.saved")
				.map((e) => ({
					roomId: e.roomId,
					requestId: e.data.requestId,
					target: e.data.target,
				}));
			const context = events
				? inspectionContext.parse({
						...payload,
						evidence: saved,
						rooms: payload.rooms.map((r) => ({
							...r,
							name:
								events.findLast(
									(e) =>
										e.roomId === r.roomId &&
										(e.type === "room.named" || e.type === "room.upsert"),
								)?.data.name ?? r.name,
						})),
					})
				: payload;
			const result = await reviewInspection(sessionId, context);
			if (events)
				for (const report of result.roomReports ?? []) {
					const room = context.rooms.find(
						(r) => r.roomId.toLowerCase() === report.roomId,
					);
					if (room)
						await appendEvent(sessionId, {
							id: randomUUID(),
							type: "room.upsert",
							roomId: room.roomId,
							capturedAt: Date.now(),
							data: { name: room.name, report: report.report },
						});
				}
			const outstanding =
				events?.filter(
					(e) =>
						e.type === "evidence.requested" &&
						!saved?.some((x) => x.requestId === e.data.requestId),
				) ?? [];
			for (const item of outstanding) {
				const room = context.rooms.find((r) => r.roomId === item.roomId);
				if (
					room &&
					!result.requests.some(
						(r) => r.roomId === room.roomId && r.target === item.data.target,
					)
				) {
					const target =
						inspectionContext.shape.evidence.element.shape.target.parse(
							item.data.target,
						);
					result.requests.push({
						roomId: room.roomId,
						target,
						prompt: `Uavklart i ${room.name}: ${target}`,
					});
				}
			}
			if (events)
				await appendEvent(sessionId, {
					id: randomUUID(),
					type: "inspection.completed",
					capturedAt: Date.now(),
					data: {
						summary: [result.summary, ...result.requests.map((r) => r.prompt)]
							.join("\n")
							.slice(0, 2500),
					},
				});
			return result;
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
