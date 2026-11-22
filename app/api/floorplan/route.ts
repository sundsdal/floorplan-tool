import { mkdir, unlink, writeFile } from "fs/promises";
import type { NextRequest } from "next/server";
import { tmpdir } from "os";
import { join } from "path";
import { z } from "zod";
import { validateEvidenceGeometry } from "@/lib/evidence";
import {
	deleteUploadedVideo,
	dissectVideo,
	type UploadedVideo,
	uploadVideo,
} from "@/lib/gemini";
import { managedAgentConfigured } from "@/lib/managed-agent";
import { managedFloorplan } from "@/lib/managed-results";

export const runtime = "nodejs";

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
const ALLOWED_TYPES = new Set([
	"video/mp4",
	"video/quicktime",
	"video/x-msvideo",
	"video/webm",
	"video/mpeg",
	"video/x-ms-wmv",
	"video/3gpp",
]);

const captureNotesSchema = z
	.array(
		z.object({
			seconds: z.number().finite().min(0).max(86400),
			speaker: z.enum(["user", "guide"]),
			text: z.string().trim().min(1).max(1000),
		}),
	)
	.max(200);

export async function POST(request: NextRequest) {
	let tempPath: string | null = null;

	try {
		const contentType = request.headers.get("content-type") || "";
		if (!contentType.includes("multipart/form-data")) {
			return new Response(
				JSON.stringify({ error: "Expected multipart/form-data" }),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		}

		const formData = await request.formData();
		const file = formData.get("video");

		if (!file || !(file instanceof File)) {
			return new Response(
				JSON.stringify({
					error: "No video file provided. Send a 'video' field.",
				}),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		}

		const rawNotes = formData.get("captureNotes");
		let captureNotes: z.infer<typeof captureNotesSchema> = [];
		if (rawNotes !== null) {
			try {
				if (typeof rawNotes !== "string" || rawNotes.length > 100_000)
					throw new Error();
				captureNotes = captureNotesSchema.parse(JSON.parse(rawNotes));
			} catch {
				return new Response(
					JSON.stringify({ error: "Invalid capture notes." }),
					{
						status: 400,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
		}

		if (file.size > MAX_FILE_SIZE) {
			return new Response(
				JSON.stringify({
					error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB.`,
				}),
				{ status: 413, headers: { "Content-Type": "application/json" } },
			);
		}

		const mimeType = file.type.split(";")[0].trim().toLowerCase();
		if (!ALLOWED_TYPES.has(mimeType)) {
			return new Response(
				JSON.stringify({
					error: `Unsupported video format: ${file.type}. Supported: MP4, MOV, AVI, WebM, MPEG, WMV, 3GPP.`,
				}),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		}

		if (!managedAgentConfigured() || !process.env.GEMINI_API_KEY) {
			return Response.json(
				{ error: "Floorplan generation is unavailable." },
				{ status: 503 },
			);
		}

		// Save to temp file
		const tempDir = join(tmpdir(), "floorplan-tool");
		await mkdir(tempDir, { recursive: true });
		const ext = file.name.split(".").pop() || "mp4";
		tempPath = join(tempDir, `upload_${Date.now()}.${ext}`);
		const bytes = await file.arrayBuffer();
		await writeFile(tempPath, Buffer.from(bytes));

		// SSE stream
		const encoder = new TextEncoder();
		const startTime = Date.now();
		const stream = new ReadableStream({
			async start(controller) {
				let uploaded: UploadedVideo | undefined;
				const send = (data: Record<string, unknown>) => {
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({
								...data,
								timestamp: new Date().toISOString(),
								elapsed_ms: Date.now() - startTime,
							})}\n\n`,
						),
					);
				};

				try {
					// Upload to Gemini
					send({
						type: "system",
						message: `Saving video to temp file (${(file.size / (1024 * 1024)).toFixed(1)}MB)...`,
						phase: "uploading",
					});
					send({
						type: "system",
						message: `Uploading to Gemini File API...`,
						phase: "uploading",
					});
					uploaded = await uploadVideo(tempPath!, mimeType);
					send({
						type: "system",
						message: `Finished uploading video to Gemini`,
						phase: "uploading",
					});

					send({
						type: "system",
						message: "Analyzing video evidence...",
						phase: "processing",
					});
					const evidence = await dissectVideo(uploaded, captureNotes);
					send({ type: "evidence", evidence });
					send({
						type: "system",
						message: "Generating floorplan from video evidence...",
						phase: "processing",
					});
					const floorplan = await managedFloorplan(evidence);
					evidence.discrepancies = validateEvidenceGeometry(
						evidence,
						floorplan,
					);
					send({ type: "evidence", evidence });

					send({
						type: "result",
						floorplan,
						message: "Floorplan generation complete",
					});
				} catch {
					send({
						type: "error",
						message: "Floorplan generation failed. Please try again.",
					});
				} finally {
					if (uploaded) await deleteUploadedVideo(uploaded).catch(() => {});
					controller.close();
					// Clean up temp file
					if (tempPath) {
						unlink(tempPath).catch(() => {});
					}
				}
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	} catch {
		// Clean up temp file on unexpected errors
		if (tempPath) {
			unlink(tempPath).catch(() => {});
		}

		return new Response(
			JSON.stringify({ error: "Unable to process the upload." }),
			{
				status: 500,
				headers: { "Content-Type": "application/json" },
			},
		);
	}
}
