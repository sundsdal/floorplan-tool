import { GoogleAuth } from "google-auth-library";
import { z } from "zod";
import { recordingPlaylist } from "./livekit-session";

const capturedAt = z
	.number()
	.int()
	.min(1_000_000_000_000)
	.max(4_200_000_000_000);
const coordinate = z.number().min(-10_000).max(10_000);
const point = z.object({ x: coordinate, y: coordinate }).strict();
const heading = z
	.object({
		x: z.number().min(-1.01).max(1.01),
		y: z.number().min(-1.01).max(1.01),
	})
	.strict();
const id = z.uuid();
const roomName = z.string().trim().min(1).max(200);

export const spatialLocationSchema = z
	.object({
		capturedAt,
		tracking: z.enum(["tracked", "uncertain", "unavailable"]),
		roomId: id.optional(),
		roomName: roomName.optional(),
		position: point.optional(),
		forward: heading.optional(),
	})
	.strict();

const segment = z
	.object({ id: z.string().min(1).max(200), start: point, end: point })
	.strict();
const mapRoom = z
	.object({
		id,
		name: roomName,
		polygon: z.array(point).min(3).max(1000),
	})
	.strict();
const jpeg = z
	.string()
	.max(350_000)
	.refine((value) => {
		if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
			return false;
		const bytes = Buffer.from(value, "base64");
		return (
			bytes.length >= 4 &&
			bytes.length <= 260_000 &&
			bytes[0] === 0xff &&
			bytes[1] === 0xd8 &&
			bytes[bytes.length - 2] === 0xff &&
			bytes[bytes.length - 1] === 0xd9
		);
	});

export const spatialSnapshotSchema = z
	.object({
		capturedAt,
		seconds: z.number().min(0).max(86_400),
		location: spatialLocationSchema,
		walls: z.array(segment).max(2000),
		doors: z.array(segment).max(1000),
		windows: z.array(segment).max(1000),
		rooms: z.array(mapRoom).max(100),
		image: jpeg,
	})
	.strict()
	.refine((value) => value.location.capturedAt === value.capturedAt);

export type SpatialSnapshot = z.infer<typeof spatialSnapshotSchema>;

const auth = new GoogleAuth({
	scopes: ["https://www.googleapis.com/auth/devstorage.read_write"],
});

function spatialObject(sessionId: string) {
	const { bucket, object } = recordingPlaylist(sessionId);
	const key = object.replace(/recording\.m3u8$/, "spatial-latest.json");
	const bucketPath = encodeURIComponent(bucket);
	const data = `https://storage.googleapis.com/storage/v1/b/${bucketPath}/o/${encodeURIComponent(key)}?alt=media`;
	return { key, bucketPath, data };
}

async function readCurrent(url: string, headers: Headers) {
	const result = await fetch(url, {
		headers,
		cache: "no-store",
		signal: AbortSignal.timeout(10_000),
	});
	if (result.status === 404) return { generation: "0", snapshot: null };
	if (!result.ok) throw new Error("Spatial snapshot unavailable");
	const generation = result.headers.get("x-goog-generation");
	if (!generation || !/^\d+$/.test(generation))
		throw new Error("Missing snapshot generation");
	return {
		generation,
		snapshot: spatialSnapshotSchema.parse(await result.json()),
	};
}

export async function readSpatialSnapshot(
	sessionId: string,
): Promise<SpatialSnapshot | null> {
	const resource = spatialObject(sessionId);
	return (
		await readCurrent(
			resource.data,
			new Headers(await auth.getRequestHeaders()),
		)
	).snapshot;
}

export async function saveSpatialSnapshot(
	sessionId: string,
	snapshot: SpatialSnapshot,
) {
	const resource = spatialObject(sessionId);
	const readHeaders = new Headers(await auth.getRequestHeaders());
	const writeHeaders = new Headers(readHeaders);
	writeHeaders.set("Content-Type", "application/json");
	for (let attempt = 0; attempt < 3; attempt++) {
		const current = await readCurrent(resource.data, readHeaders);
		const last = current.snapshot?.capturedAt ?? 0;
		if (last >= snapshot.capturedAt)
			return { capturedAt: last, accepted: false };
		const query = new URLSearchParams({
			uploadType: "media",
			name: resource.key,
			ifGenerationMatch: current.generation,
		});
		const response = await fetch(
			`https://storage.googleapis.com/upload/storage/v1/b/${resource.bucketPath}/o?${query}`,
			{
				method: "POST",
				headers: writeHeaders,
				body: JSON.stringify(snapshot),
				signal: AbortSignal.timeout(10_000),
			},
		);
		await response.body?.cancel();
		if (response.ok) return { capturedAt: snapshot.capturedAt, accepted: true };
		if (response.status !== 412)
			throw new Error("Could not store spatial snapshot");
	}
	throw new Error("Spatial snapshot changed during write");
}
