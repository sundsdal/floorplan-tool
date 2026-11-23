import { z } from "zod";
import {
	bindVisit,
	inspectionLink,
	visitSessionId,
} from "@/lib/inspection-events";
import { createSession } from "@/lib/livekit-session";
export const runtime = "nodejs";
const captureOptions = z.union([
	z.object({}).strict(),
	z.object({ mode: z.literal("floorplan") }).strict(),
	z
		.object({
			mode: z.literal("inspection"),
			work: z.enum(["male", "slipe"]),
			inspectionLink: inspectionLink.optional(),
		})
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
		let session: Awaited<ReturnType<typeof createSession>>;
		if (
			"mode" in options &&
			options.mode === "inspection" &&
			options.inspectionLink
		) {
			const link = options.inspectionLink;
			const id = visitSessionId(link);
			await bindVisit(id, link);
			session = await createSession(
				{ mode: "inspection", work: options.work },
				id,
			);
		} else session = await createSession(options);
		return Response.json(session, {
			headers: { "Cache-Control": "no-store" },
		});
	} catch {
		return Response.json(
			{ error: "Unable to start capture session." },
			{ status: 503 },
		);
	}
}
