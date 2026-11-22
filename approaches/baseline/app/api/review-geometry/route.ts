import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	deleteUploadedVideo,
	reviewGeometry,
	type UploadedVideo,
	uploadVideo,
} from "@/lib/gemini";

import { managedAgentConfigured } from "@/lib/managed-agent";
import { managedReview } from "@/lib/managed-results";

export const runtime = "nodejs";
const range = z
	.object({
		startSeconds: z.number().finite().min(0),
		endSeconds: z.number().finite().min(0),
	})
	.refine((v) => v.endSeconds > v.startSeconds);
const metadata = z
	.object({
		room: z.string().trim().min(1).max(200),
		question: z.string().trim().min(1).max(2000),
		sessionId: z.string().trim().min(1).max(200),
		requestId: z.string().trim().min(1).max(200),
		revision: z.number().int().nonnegative(),
		startSeconds: z.number().finite().min(0),
		endSeconds: z.number().finite().min(0),
	})
	.refine((v) => v.endSeconds > v.startSeconds);
const jobs = new Map<
	string,
	{
		revision: number;
		requestId: string;
		promise: Promise<unknown>;
		expires: number;
	}
>();

export async function POST(request: Request) {
	const paths: string[] = [];
	const uploaded: UploadedVideo[] = [];
	try {
		if (!request.headers.get("content-type")?.includes("multipart/form-data"))
			return Response.json(
				{ error: "Expected multipart/form-data." },
				{ status: 400 },
			);
		const form = await request.formData();
		const values = metadata.safeParse({
			room: form.get("room"),
			question: form.get("question"),
			sessionId: form.get("sessionId"),
			requestId: form.get("requestId"),
			revision: Number(form.get("revision")),
			startSeconds: Number(form.get("startSeconds")),
			endSeconds: Number(form.get("endSeconds")),
		});
		const video = form.get("video");
		let earlierRanges: z.infer<typeof range>[];
		try {
			earlierRanges = z
				.array(range)
				.max(3)
				.parse(JSON.parse(String(form.get("earlierRanges") || "[]")));
		} catch {
			return Response.json(
				{ error: "Invalid earlier ranges." },
				{ status: 400 },
			);
		}
		const earlier = form.getAll("earlierVideos");
		if (
			!values.success ||
			!(video instanceof File) ||
			earlier.length !== earlierRanges.length ||
			![video, ...earlier].every(
				(f) =>
					f instanceof File &&
					f.size > 0 &&
					f.size <= 100 * 1024 * 1024 &&
					["video/mp4", "video/quicktime", "video/webm"].includes(
						f.type.split(";")[0].toLowerCase(),
					),
			)
		)
			return Response.json(
				{ error: "Invalid review request or video." },
				{ status: 400 },
			);
		if (!process.env.GEMINI_API_KEY || !managedAgentConfigured())
			return Response.json(
				{ error: "Review is unavailable." },
				{ status: 503 },
			);
		const input = values.data;
		const now = Date.now();
		for (const [key, job] of jobs) if (job.expires < now) jobs.delete(key);
		const current = jobs.get(input.sessionId);
		if (current && input.revision < current.revision)
			return Response.json(
				{ error: "Stale review revision." },
				{ status: 409 },
			);
		if (
			current &&
			input.revision === current.revision &&
			current.requestId !== input.requestId
		)
			return Response.json(
				{ error: "Revision already requested." },
				{ status: 409 },
			);
		if (
			current &&
			input.revision === current.revision &&
			current.requestId === input.requestId
		)
			return Response.json(await current.promise);
		const promise = (async () => {
			const dir = join(tmpdir(), "floorplan-review");
			await mkdir(dir, { recursive: true });
			const files = [...(earlier as File[]), video];
			for (const file of files) {
				const path = join(dir, `${randomUUID()}.video`);
				paths.push(path);
				await writeFile(path, Buffer.from(await file.arrayBuffer()));
				uploaded.push(await uploadVideo(path, file.type));
			}
			const evidence = await reviewGeometry(
				uploaded,
				[
					...earlierRanges,
					{ startSeconds: input.startSeconds, endSeconds: input.endSeconds },
				],
				input.room,
				input.question,
			);
			const result = await managedReview(evidence, input.room, input.question);
			return {
				...result,
				revision: input.revision,
				requestId: input.requestId,
			};
		})();
		jobs.set(input.sessionId, {
			revision: input.revision,
			requestId: input.requestId,
			promise,
			expires: now + 15 * 60_000,
		});
		try {
			const result = await promise;
			if (jobs.get(input.sessionId)?.revision !== input.revision)
				return Response.json(
					{ error: "Stale review revision." },
					{ status: 409 },
				);
			return Response.json(result);
		} catch (error) {
			if (jobs.get(input.sessionId)?.promise === promise)
				jobs.delete(input.sessionId);
			throw error;
		}
	} catch {
		return Response.json(
			{ error: "Geometry review failed. Please try again." },
			{ status: 502 },
		);
	} finally {
		await Promise.all([
			...paths.map((path) => unlink(path).catch(() => {})),
			...uploaded.map((video) => deleteUploadedVideo(video).catch(() => {})),
		]);
	}
}
