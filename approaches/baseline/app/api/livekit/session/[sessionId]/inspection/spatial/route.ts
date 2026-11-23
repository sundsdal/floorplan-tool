import {
	readSpatialSnapshot,
	saveSpatialSnapshot,
	spatialSnapshotSchema,
} from "@/lib/inspection-spatial";
import {
	authorizeReview,
	authorizeSession,
	bearer,
} from "@/lib/livekit-session";

export const runtime = "nodejs";
const maxBytes = 1_500_000;
const noStore = { "Cache-Control": "no-store" };

type Context = { params: Promise<{ sessionId: string }> };

export async function GET(request: Request, context: Context) {
	const { sessionId } = await context.params;
	const token = bearer(request);
	if (!authorizeReview(sessionId, token) && !authorizeSession(sessionId, token))
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	try {
		const snapshot = await readSpatialSnapshot(sessionId);
		return snapshot
			? Response.json(snapshot, { headers: noStore })
			: Response.json(
					{ error: "No map received" },
					{ status: 404, headers: noStore },
				);
	} catch {
		return Response.json(
			{ error: "Map unavailable" },
			{ status: 503, headers: noStore },
		);
	}
}

export async function PUT(request: Request, context: Context) {
	const { sessionId } = await context.params;
	if (!authorizeSession(sessionId, bearer(request)))
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	if (
		!request.headers
			.get("content-type")
			?.toLowerCase()
			.startsWith("application/json")
	)
		return Response.json({ error: "Expected JSON" }, { status: 415 });
	if (Number(request.headers.get("content-length")) > maxBytes)
		return Response.json({ error: "Map is too large" }, { status: 413 });
	const reader = request.body?.getReader();
	if (!reader) return Response.json({ error: "Invalid map" }, { status: 400 });
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel();
				return Response.json({ error: "Map is too large" }, { status: 413 });
			}
			chunks.push(value);
		}
	} catch {
		return Response.json({ error: "Invalid map" }, { status: 400 });
	} finally {
		reader.releaseLock();
	}
	let body: unknown;
	try {
		body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return Response.json({ error: "Invalid map" }, { status: 400 });
	}
	const input = spatialSnapshotSchema.safeParse(body);
	if (!input.success)
		return Response.json({ error: "Invalid map" }, { status: 400 });
	try {
		return Response.json(await saveSpatialSnapshot(sessionId, input.data), {
			headers: noStore,
		});
	} catch {
		return Response.json(
			{ error: "Map unavailable" },
			{ status: 503, headers: noStore },
		);
	}
}
