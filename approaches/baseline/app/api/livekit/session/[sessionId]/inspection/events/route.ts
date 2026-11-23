import {
	allEvents,
	appendEvent,
	Conflict,
	inspectionEvent,
	page,
	Unlinked,
} from "@/lib/inspection-events";
import { enqueueExtraction } from "@/lib/inspection-extract";
import {
	authorizeReview,
	authorizeSession,
	bearer,
} from "@/lib/livekit-session";
export const runtime = "nodejs";
type Context = { params: Promise<{ sessionId: string }> };
function failure(e: unknown) {
	return new Response(null, {
		status: e instanceof Unlinked ? 404 : e instanceof Conflict ? 409 : 503,
	});
}
export async function GET(req: Request, ctx: Context) {
	const { sessionId } = await ctx.params;
	if (
		!authorizeReview(sessionId, bearer(req)) &&
		!authorizeSession(sessionId, bearer(req))
	)
		return new Response(null, { status: 401 });
	const after = Number(new URL(req.url).searchParams.get("after") || 0);
	if (!Number.isSafeInteger(after) || after < 0)
		return new Response(null, { status: 400 });
	try {
		return Response.json(page(await allEvents(sessionId), after), {
			headers: { "Cache-Control": "no-store" },
		});
	} catch (e) {
		return failure(e);
	}
}
export async function POST(req: Request, ctx: Context) {
	const { sessionId } = await ctx.params;
	const device = authorizeSession(sessionId, bearer(req));
	if (!device && !authorizeReview(sessionId, bearer(req)))
		return new Response(null, { status: 401 });
	if (Number(req.headers.get("Content-Length")) > 3000000)
		return new Response(null, { status: 413 });
	const raw = await req.text();
	if (raw.length > 3000000) return new Response(null, { status: 413 });
	let body: unknown;
	try {
		body = JSON.parse(raw);
	} catch {
		return new Response(null, { status: 400 });
	}
	const parsed = inspectionEvent.safeParse(body);
	if (!parsed.success) return new Response(null, { status: 400 });
	const e = parsed.data;
	if (
		!(
			device
				? ["room.upsert", "room.visited", "evidence.saved"]
				: [
						"room.named",
						"transcript",
						"room.visited",
						"evidence.requested",
						"evidence.marked",
					]
		).includes(e.type)
	)
		return new Response(null, { status: 403 });
	try {
		await appendEvent(sessionId, e);
		if (e.type === "evidence.marked") await enqueueExtraction(sessionId, e.id);
		return Response.json({ id: e.id });
	} catch (error) {
		return failure(error);
	}
}
