import { z } from "zod";
import { createSession } from "@/lib/livekit-session";
export const runtime = "nodejs";
const captureOptions = z.union([
	z.object({}).strict(),
	z.object({ mode: z.literal("floorplan") }).strict(),
	z
		.object({ mode: z.literal("inspection"), work: z.enum(["male", "slipe"]) })
		.strict(),
]);

export async function POST(request: Request) {
	let options: z.infer<typeof captureOptions>;
	try {
		const input = await request.text();
		options = captureOptions.parse(input ? JSON.parse(input) : {});
	} catch {
		return Response.json(
			{ error: "Invalid session request." },
			{ status: 400 },
		);
	}
	try {
		return Response.json(await createSession(options), {
			headers: { "Cache-Control": "no-store" },
		});
	} catch {
		return Response.json(
			{ error: "Unable to start capture session." },
			{ status: 503 },
		);
	}
}
