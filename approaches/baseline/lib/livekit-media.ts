import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { GoogleAuth } from "google-auth-library";
import { validateEvidenceGeometry } from "./evidence";
import {
	deleteUploadedVideo,
	dissectVideo,
	reviewGeometry,
	type UploadedVideo,
	uploadVideo,
} from "./gemini";
import { recordingPlaylist } from "./livekit-session";
import { managedFloorplan, managedReview } from "./managed-results";

const exec = promisify(execFile);
export class RecordingNotReady extends Error {}
type Range = { startSeconds: number; endSeconds: number };
type Reader = (name: string) => Promise<Buffer>;

/** Materialize only committed, session-scoped segments into a playable MP4. */
export async function materializeRecording(
	read: Reader,
	output: string,
	options: { range?: Range; final?: boolean } = {},
) {
	const source = (await read("recording.m3u8")).toString("utf8");
	if (
		!source.startsWith("#EXTM3U") ||
		(options.final && !source.includes("#EXT-X-ENDLIST"))
	)
		throw new RecordingNotReady();
	const lines = source.split(/\r?\n/);
	const entries: { name: string; duration: number; start: number }[] = [];
	let duration = 0;
	let pending: number | undefined;
	for (const line of lines) {
		if (line.startsWith("#EXTINF:")) {
			pending = Number.parseFloat(line.slice(8));
			if (!Number.isFinite(pending) || pending <= 0)
				throw new Error("Invalid playlist");
		} else if (line && !line.startsWith("#")) {
			if (
				pending === undefined ||
				!/^segment_?[0-9]+\.ts$/.test(basename(line)) ||
				line.includes("..") ||
				line.startsWith("/") ||
				line.includes(":")
			)
				throw new Error("Invalid segment");
			entries.push({
				name: basename(line),
				duration: pending,
				start: duration,
			});
			duration += pending;
			pending = undefined;
		}
	}
	if (!entries.length || pending !== undefined) throw new RecordingNotReady();
	const range = options.range;
	if (
		range &&
		(range.startSeconds < 0 ||
			range.endSeconds <= range.startSeconds ||
			range.endSeconds > duration + 0.001)
	)
		throw new RecordingNotReady();
	const selected = range
		? entries.filter(
				(e) =>
					e.start < range.endSeconds &&
					e.start + e.duration > range.startSeconds,
			)
		: entries;
	const dir = await mkdtemp(join(tmpdir(), "floorplan-hls-"));
	try {
		for (const segment of selected)
			await writeFile(join(dir, segment.name), await read(segment.name));
		const playlist = [
			"#EXTM3U",
			"#EXT-X-VERSION:3",
			`#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...selected.map((s) => s.duration)))}`,
			"#EXT-X-MEDIA-SEQUENCE:0",
			...selected.flatMap((s) => [`#EXTINF:${s.duration},`, s.name]),
			"#EXT-X-ENDLIST",
			"",
		].join("\n");
		await writeFile(join(dir, "input.m3u8"), playlist);
		const args = [
			"-hide_banner",
			"-loglevel",
			"error",
			"-protocol_whitelist",
			"file,crypto,data",
			"-i",
			join(dir, "input.m3u8"),
		];
		if (range)
			args.push(
				"-ss",
				String(Math.max(0, range.startSeconds - selected[0].start)),
				"-t",
				String(range.endSeconds - range.startSeconds),
			);
		args.push(
			"-map",
			"0:v:0",
			"-map",
			"0:a:0?",
			"-c:v",
			"libx264",
			"-preset",
			"veryfast",
			"-c:a",
			"aac",
			"-movflags",
			"+faststart",
			"-y",
			output,
		);
		await exec("ffmpeg", args, { timeout: 300_000, maxBuffer: 1024 * 1024 });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
function reader(sessionId: string): Reader {
	const { bucket, object } = recordingPlaylist(sessionId);
	const prefix = object.slice(0, -"recording.m3u8".length);
	const auth = new GoogleAuth({
		scopes: ["https://www.googleapis.com/auth/devstorage.read_only"],
	});
	return async (name) => {
		if (name !== "recording.m3u8" && !/^segment_?[0-9]+\.ts$/.test(name))
			throw new Error("Invalid object");
		const headers = await auth.getRequestHeaders();
		const res = await fetch(
			`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(prefix + name)}?alt=media`,
			{ headers },
		);
		if (res.status === 404) throw new RecordingNotReady();
		if (!res.ok) throw new Error("Storage read failed");
		return Buffer.from(await res.arrayBuffer());
	};
}
export async function waitForFinalRecording(sessionId: string) {
	const read = reader(sessionId);
	for (let attempt = 0; attempt < 6; attempt++) {
		try {
			const playlist = (await read("recording.m3u8")).toString("utf8");
			if (playlist.startsWith("#EXTM3U") && playlist.includes("#EXT-X-ENDLIST"))
				return;
		} catch (error) {
			if (!(error instanceof RecordingNotReady)) throw error;
		}
		if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	throw new RecordingNotReady();
}
async function usingMedia<T>(
	sessionId: string,
	ranges: Range[] | null,
	callback: (files: string[]) => Promise<T>,
) {
	const dir = await mkdtemp(join(tmpdir(), "floorplan-media-"));
	try {
		const files = (ranges || [null]).map((_, i) => join(dir, `${i}.mp4`));
		for (let i = 0; i < files.length; i++)
			await materializeRecording(
				reader(sessionId),
				files[i],
				ranges ? { range: ranges[i] } : { final: true },
			);
		return await callback(files);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
/** Materialize the full committed video up to the requested inspection checkpoint. */
export function withInspectionVideo<T>(
	sessionId: string,
	endSeconds: number | undefined,
	review: (file: string) => Promise<T>,
) {
	return usingMedia(
		sessionId,
		endSeconds === undefined ? null : [{ startSeconds: 0, endSeconds }],
		([file]) => review(file),
	);
}

async function withUploads<T>(
	files: string[],
	callback: (videos: UploadedVideo[]) => Promise<T>,
) {
	const videos: UploadedVideo[] = [];
	try {
		for (const file of files) videos.push(await uploadVideo(file, "video/mp4"));
		return await callback(videos);
	} finally {
		await Promise.all(
			videos.map((video) => deleteUploadedVideo(video).catch(() => {})),
		);
	}
}
export async function finalizeRecording(
	sessionId: string,
	existing?: import("./types").FloorplanState,
) {
	return usingMedia(sessionId, null, (files) =>
		withUploads(files, async ([video]) => {
			const evidence = await dissectVideo(video);
			const floorplan = await managedFloorplan(evidence, existing);
			evidence.discrepancies = validateEvidenceGeometry(evidence, floorplan);
			return floorplan;
		}),
	);
}
export async function reviewRecording(
	sessionId: string,
	ranges: Range[],
	room: string,
	question: string,
) {
	return usingMedia(sessionId, ranges, (files) =>
		withUploads(files, async (videos) =>
			managedReview(
				await reviewGeometry(videos, ranges, room, question),
				room,
				question,
			),
		),
	);
}

export async function draftRecording(
	sessionId: string,
	ranges: Range[],
	existing?: import("./types").FloorplanState,
	targetId?: string,
) {
	return usingMedia(sessionId, ranges, (files) =>
		withUploads(files, async (videos) => {
			const parts = await Promise.all(
				videos.map((video) => dissectVideo(video)),
			);
			if (targetId && existing) {
				const target = [
					...existing.walls,
					...existing.doors,
					...existing.windows,
					...existing.rooms,
					...existing.dimensions,
				].find((x) => x.id === targetId);
				if (!target) throw new Error("Invalid target");
				const latestIndex = videos.length - 1;
				const observation = await reviewGeometry(
					[videos[latestIndex]],
					[ranges[latestIndex]],
					"target geometry",
					`Is this exact existing target visibly identifiable in the new take, with enough evidence to assess its geometry or wall association? Target: ${JSON.stringify(target)}. Return unresolved if the target or its association is not visible.`,
				);
				if (
					!observation.resolved ||
					observation.supportingTimestamps.length === 0
				)
					return {
						floorplan: existing,
						unresolved: true,
						finding:
							observation.finding ||
							observation.unresolvedQuestion ||
							"The target is not visible in this take.",
						nextView:
							observation.nextView ||
							parts.at(-1)?.gaps[0] ||
							"Film the target and its surroundings clearly.",
					};
			}
			const evidence = {
				clips: parts.flatMap((x, i) =>
					x.clips
						.filter(
							(c) =>
								c.start_s <= ranges[i].endSeconds - ranges[i].startSeconds &&
								c.end_s <= ranges[i].endSeconds - ranges[i].startSeconds,
						)
						.map((c) => ({
							...c,
							start_s: c.start_s + ranges[i].startSeconds,
							end_s: c.end_s + ranges[i].startSeconds,
						})),
				),
				gaps: parts.flatMap((x) => x.gaps),
				room_bounds: parts.flatMap((x) => x.room_bounds),
				discrepancies: parts.flatMap((x) => x.discrepancies),
			};
			const latest = parts.at(-1);
			if (
				existing &&
				latest &&
				latest.clips.length === 0 &&
				latest.room_bounds.length === 0
			)
				return {
					floorplan: existing,
					unresolved: true,
					finding:
						latest.gaps[0] || "No usable geometry was visible in this take.",
					nextView: latest.gaps[0] || "Film the room and its walls clearly.",
				};
			const floorplan = await managedFloorplan(evidence, existing);
			if (
				!floorplan.walls.length &&
				!floorplan.doors.length &&
				!floorplan.windows.length &&
				!floorplan.rooms.length
			)
				return {
					floorplan,
					unresolved: true,
					finding: evidence.gaps[0] || "No floorplan geometry was identified.",
					nextView: evidence.gaps[0] || "Film the room and its walls clearly.",
				};
			return { floorplan, unresolved: false };
		}),
	);
}
