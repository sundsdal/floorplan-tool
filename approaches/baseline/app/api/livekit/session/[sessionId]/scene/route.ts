import { readScene } from "@/lib/scene";
import { authorized, failure } from "@/lib/scene-route";
export const runtime = "nodejs";
export async function GET(
	request: Request,
	context: { params: Promise<{ sessionId: string }> },
) {
	const { sessionId } = await context.params;
	if (!authorized(request, sessionId, true))
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	try {
		const { scene } = await readScene(sessionId);
		return Response.json(
			{ scene },
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch (e) {
		return failure(e);
	}
}
