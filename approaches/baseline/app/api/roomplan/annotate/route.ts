import {
	createRoomReport,
	roomReportRequestSchema,
} from "@/lib/roomplan-report";

export const runtime = "nodejs";
export const maxDuration = 75;

const maxBytes = 5_100_000;

export async function POST(request: Request) {
	if (
		!request.headers
			.get("content-type")
			?.toLowerCase()
			.startsWith("application/json")
	)
		return Response.json({ error: "Expected JSON." }, { status: 415 });
	const length = Number(request.headers.get("content-length"));
	if (Number.isFinite(length) && length > maxBytes)
		return Response.json({ error: "Request too large." }, { status: 413 });
	try {
		if (!request.body)
			return Response.json({ error: "Invalid request." }, { status: 400 });
		const reader = request.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel();
				return Response.json({ error: "Request too large." }, { status: 413 });
			}
			chunks.push(value);
		}
		const input = roomReportRequestSchema.safeParse(
			JSON.parse(Buffer.concat(chunks).toString("utf8")),
		);
		if (!input.success)
			return Response.json({ error: "Invalid request." }, { status: 400 });
		const report = await createRoomReport(input.data, request.signal);
		return Response.json(report, { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		if (error instanceof SyntaxError)
			return Response.json({ error: "Invalid request." }, { status: 400 });
		return Response.json(
			{ error: "Room analysis is unavailable." },
			{ status: 503 },
		);
	}
}
