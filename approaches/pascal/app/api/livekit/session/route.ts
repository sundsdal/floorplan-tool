import { createSession } from "@/lib/livekit-session";
export const runtime = "nodejs";
export async function POST() {
	try {
		return Response.json(await createSession(), {
			headers: { "Cache-Control": "no-store" },
		});
	} catch {
		return Response.json(
			{ error: "Unable to start capture session." },
			{ status: 503 },
		);
	}
}
