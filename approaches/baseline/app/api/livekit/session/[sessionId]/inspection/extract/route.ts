import { z } from "zod";
import { extractMarked, permitsTask } from "@/lib/inspection-extract";
export const runtime = "nodejs";
export async function POST(
	request: Request,
	ctx: { params: Promise<{ sessionId: string }> },
) {
	const { sessionId } = await ctx.params;
	const input = z
		.object({ id: z.uuid() })
		.safeParse(await request.json().catch(() => null));
	if (
		!input.success ||
		!permitsTask(
			sessionId,
			input.data.id,
			request.headers.get("X-Inspection-Task") ?? "",
		)
	)
		return new Response(null, { status: 403 });
	try {
		await extractMarked(sessionId, input.data.id);
		return new Response(null, { status: 204 });
	} catch {
		return new Response(null, { status: 503 });
	}
}
