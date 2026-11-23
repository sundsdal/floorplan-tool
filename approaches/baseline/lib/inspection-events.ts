import { createHash, createHmac } from "node:crypto";
import { GoogleAuth } from "google-auth-library";
import { z } from "zod";
import { recordingPlaylist } from "./livekit-session";

export const inspectionLink = z
	.object({
		origin: z.string().url(),
		job: z.string().regex(/^[a-f0-9]{32}$/),
		visit: z.string().regex(/^[a-f0-9]{32}$/),
		token: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
type Link = z.infer<typeof inspectionLink>;
const name = z.string().trim().min(1).max(80);
const target = z.enum([
	"under_sink",
	"shaft_access",
	"ventilation",
	"surface_detail",
]);
const request = z.object({ requestId: z.uuid(), target });
const base = z.object({
	id: z.uuid(),
	capturedAt: z.number().int().positive(),
	roomId: z
		.uuid()
		.transform((v) => v.toLowerCase())
		.optional(),
});
const room = base.extend({
	roomId: z.uuid().transform((v) => v.toLowerCase()),
});
const seconds = z.number().min(0).max(86400);
export const inspectionEvent = z.discriminatedUnion("type", [
	room.extend({
		type: z.literal("room.upsert"),
		data: z.object({
			name,
			document: z
				.object({
					version: z.literal(1),
					source: z.literal("roomplan"),
					floorplan: z.record(z.string(), z.unknown()),
				})
				.passthrough()
				.optional(),
			report: z.string().max(10000).nullish(),
		}),
	}),
	room.extend({
		type: z.literal("room.named"),
		data: z.object({ name, source: z.enum(["user", "live"]) }),
	}),
	base.extend({ type: z.literal("room.visited"), data: z.object({}) }),
	base.extend({
		type: z.literal("transcript"),
		data: z.object({
			role: z.enum(["assistant", "user"]),
			text: z.string().trim().min(1).max(16000),
			interrupted: z.boolean().optional(),
			seconds: seconds.optional(),
			endSeconds: seconds.optional(),
		}),
	}),
	room.extend({ type: z.literal("evidence.requested"), data: request }),
	room.extend({
		type: z.literal("evidence.marked"),
		data: request
			.extend({ startSeconds: seconds, endSeconds: seconds })
			.refine(
				(d) =>
					d.endSeconds > d.startSeconds && d.endSeconds - d.startSeconds <= 15,
			),
	}),
	room.extend({
		type: z.literal("evidence.saved"),
		data: request.extend({
			seconds: seconds.optional(),
			jpeg: z
				.string()
				.max(2000000)
				.min(4)
				.refine((v) => {
					const b = Buffer.from(v, "base64");
					return (
						b.length >= 4 &&
						b[0] === 255 &&
						b[1] === 216 &&
						b.at(-2) === 255 &&
						b.at(-1) === 217
					);
				}),
		}),
	}),
	room.extend({ type: z.literal("evidence.retry"), data: request }),
	base.extend({
		type: z.literal("inspection.completed"),
		data: z.object({ summary: z.string().max(2500) }),
	}),
]);
export type Event = z.infer<typeof inspectionEvent>;
export type Entry = {
	id: string;
	type: Event["type"];
	capturedAt: number;
	roomId?: string;
	data: Record<string, unknown>;
};
type StoredEntry = Entry & { digest?: string };
function digest(e: Event) {
	return createHash("sha256").update(JSON.stringify(e)).digest("hex");
}
type Journal = {
	link: Link;
	events: StoredEntry[];
	pending?: Event;
	boundAt: number;
};
export class Unlinked extends Error {}
export class Conflict extends Error {}
const auth = new GoogleAuth({
	scopes: ["https://www.googleapis.com/auth/devstorage.read_write"],
});
export function checkOrigin(link: Link) {
	const configured = process.env.INSPECTION_PUBLIC_ORIGIN;
	const origin = new URL(link.origin);
	if (
		!configured ||
		origin.origin !== new URL(configured).origin ||
		origin.href !== `${origin.origin}/` ||
		(origin.protocol !== "https:" &&
			!(
				origin.protocol === "http:" &&
				["localhost", "127.0.0.1"].includes(origin.hostname)
			))
	)
		throw new Error("Unrecognized job service");
}
function objectPath(sessionId: string) {
	const { bucket, object } = recordingPlaylist(sessionId);
	return {
		bucket: encodeURIComponent(bucket),
		key: object.replace(/recording\.m3u8$/, "inspection-journal.json"),
	};
}
async function current(sessionId: string) {
	const { bucket, key } = objectPath(sessionId);
	const res = await fetch(
		`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(key)}?alt=media`,
		{
			headers: await auth.getRequestHeaders(),
			cache: "no-store",
			signal: AbortSignal.timeout(15000),
		},
	);
	if (res.status === 404) return { generation: "0", state: null };
	const generation = res.headers.get("x-goog-generation");
	if (!res.ok || !generation || !/^\d+$/.test(generation))
		throw new Error("Cannot read inspection");
	return { generation, state: (await res.json()) as Journal };
}
async function store(sessionId: string, state: Journal, generation: string) {
	const { bucket, key } = objectPath(sessionId);
	const query = new URLSearchParams({
		name: key,
		uploadType: "media",
		ifGenerationMatch: generation,
	});
	const headers = new Headers(await auth.getRequestHeaders());
	headers.set("Content-Type", "application/json");
	const res = await fetch(
		`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?${query}`,
		{
			method: "POST",
			headers,
			body: JSON.stringify(state),
			signal: AbortSignal.timeout(15000),
		},
	);
	await res.body?.cancel();
	if (res.status === 412) return false;
	if (!res.ok) throw new Error("Cannot persist inspection");
	return true;
}
async function patchJob(sessionId: string, link: Link, event: unknown) {
	checkOrigin(link);
	const res = await fetch(
		new URL(`/api/jobs/${link.job}/inspections/${link.visit}`, link.origin),
		{
			method: "PATCH",
			redirect: "error",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${link.token}`,
			},
			body: JSON.stringify({ sessionId, event }),
			signal: AbortSignal.timeout(15000),
		},
	);
	await res.body?.cancel();
	if (res.status === 422 || res.status === 409)
		throw new Conflict("Job card rejected event");
	if (!res.ok) throw new Error("Job card did not acknowledge event");
}
export function visitSessionId(link: Link) {
	const secret = process.env.LIVEKIT_SESSION_SECRET;
	if (!secret) throw new Error("Missing session secret");
	const hex = createHmac("sha256", secret)
		.update(
			[
				"visit",
				new URL(link.origin).origin,
				link.job,
				link.visit,
				link.token,
			].join("/"),
		)
		.digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export async function bindVisit(sessionId: string, link: Link) {
	checkOrigin(link);
	const initial = { link, events: [], boundAt: Date.now() };
	const state = (await store(sessionId, initial, "0"))
		? initial
		: (await current(sessionId)).state;
	if (!state || state.events.some((e) => e.type === "inspection.completed"))
		throw new Conflict("Visit complete");
	await patchJob(sessionId, link, {
		id: sessionId,
		type: "session.bound",
		capturedAt: state.boundAt,
		data: {},
	});
}
export async function allEvents(sessionId: string) {
	const { state } = await current(sessionId);
	if (!state) throw new Unlinked();
	if (state.pending) {
		await appendEvent(sessionId, state.pending);
		return (await current(sessionId)).state?.events;
	}
	return state.events;
}
export function page(events: Entry[], after: number) {
	const batch = events
		.slice(after, after + 100)
		.map(({ id, type, roomId, capturedAt, data }) => ({
			id,
			type,
			roomId,
			capturedAt,
			data,
		}));
	return { cursor: after + batch.length, events: batch };
}
export function validateTransition(events: Entry[], e: Event) {
	if (events.some((x) => x.type === "inspection.completed"))
		throw new Conflict("Inspection complete");
	if (
		(e.type === "room.named" || e.type === "evidence.requested") &&
		!events.some((x) => x.roomId === e.roomId && x.type === "room.upsert")
	)
		throw new Conflict("Unknown room");
	if (e.type.startsWith("evidence.") && e.type !== "evidence.requested") {
		const requestId = "requestId" in e.data && e.data.requestId;
		const req = events.find(
			(x) => x.type === "evidence.requested" && x.data.requestId === requestId,
		);
		if (
			!req ||
			req.roomId !== e.roomId ||
			!("target" in e.data) ||
			req.data.target !== e.data.target
		)
			throw new Conflict("Unknown request");
		if (
			events.some(
				(x) => x.type === "evidence.saved" && x.data.requestId === requestId,
			)
		)
			throw new Conflict("Already documented");
	}
}
function compact(e: Event, events: Entry[]): StoredEntry {
	const data: Record<string, unknown> = { ...e.data };
	delete data.jpeg;
	delete data.document;
	if (
		e.type === "room.upsert" ||
		(e.type === "room.named" && e.data.source === "live")
	) {
		const confirmed = events.findLast(
			(x) =>
				x.roomId === e.roomId &&
				x.type === "room.named" &&
				(e.type === "room.upsert" || x.data.source === "user"),
		);
		if (confirmed) {
			data.name = confirmed.data.name;
			if (e.type === "room.named") data.source = confirmed.data.source;
		}
	}
	return { ...e, data, digest: digest(e) };
}
export async function appendEvent(sessionId: string, e: Event) {
	for (let i = 0; i < 10; i++) {
		const { state, generation } = await current(sessionId);
		if (!state) throw new Unlinked();
		if (state.pending) {
			const pending = state.pending;
			try {
				await patchJob(sessionId, state.link, pending);
			} catch (error) {
				if (error instanceof Conflict) {
					delete state.pending;
					await store(sessionId, state, generation);
				}
				throw error;
			}
			state.events.push(compact(pending, state.events));
			delete state.pending;
			if ((await store(sessionId, state, generation)) && e.id === pending.id) {
				if (digest(e) !== digest(pending))
					throw new Conflict("Conflicting event ID");
				return compact(pending, state.events);
			}
			continue;
		}
		const existing = state.events.find((x) => x.id === e.id);
		if (existing) {
			if (
				(existing.digest && existing.digest !== digest(e)) ||
				existing.type !== e.type ||
				existing.roomId !== e.roomId
			)
				throw new Conflict("Conflicting event ID");
			return existing;
		}
		validateTransition(state.events, e);
		if (
			[
				"room.upsert",
				"room.named",
				"evidence.saved",
				"inspection.completed",
			].includes(e.type)
		) {
			state.pending = e;
			await store(sessionId, state, generation);
			continue;
		}
		const entry = compact(e, state.events);
		state.events.push(entry);
		if (await store(sessionId, state, generation)) return entry;
	}
	throw new Error("Concurrent inspection updates");
}
