import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	allEvents,
	appendEvent,
	bindVisit,
	inspectionEvent,
	page,
	visitSessionId,
} from "@/lib/inspection-events";

vi.mock("google-auth-library", () => ({
	GoogleAuth: class {
		async getRequestHeaders() {
			return new Headers();
		}
	},
}));
vi.mock("@/lib/livekit-session", () => ({
	recordingPlaylist: (id: string) => ({
		bucket: "test",
		object: `captures/${id}/recording.m3u8`,
	}),
}));
const link = {
	job: "1".repeat(32),
	visit: "2".repeat(32),
	token: "3".repeat(64),
	origin: "https://jobs.test",
};
const room = randomUUID(),
	requestId = randomUUID();
beforeEach(() => {
	vi.stubEnv("INSPECTION_PUBLIC_ORIGIN", link.origin);
	vi.stubEnv("LIVEKIT_SESSION_SECRET", "secret");
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});
describe("linked inspection delivery", () => {
	it("accepts another photo for an already saved request without replacing it", async () => {
		let state = "",
			generation = 0,
			lose = false;
		const photos: unknown[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL, init: RequestInit) => {
				const url = new URL(input);
				if (url.origin === link.origin) {
					const { event } = JSON.parse(String(init.body));
					if (event.type === "evidence.saved") {
						photos.push(event);
						if (lose) {
							lose = false;
							throw Error("lost response");
						}
					}
					return new Response(null, { status: 204 });
				}
				if (init.method === "POST") {
					if (+String(url.searchParams.get("ifGenerationMatch")) !== generation)
						return new Response(null, { status: 412 });
					generation++;
					state = String(init.body);
					return new Response(null, { status: 200 });
				}
				return new Response(state, {
					status: state ? 200 : 404,
					headers: { "x-goog-generation": String(generation) },
				});
			}),
		);
		const session = visitSessionId(link);
		await bindVisit(session, link);
		const make = (type: string, data: unknown, roomId = room) =>
			inspectionEvent.parse({
				id: randomUUID(),
				capturedAt: Date.now(),
				type,
				data,
				roomId,
			});
		await appendEvent(session, make("room.upsert", { name: "Kitchen" }));
		await appendEvent(
			session,
			make("evidence.requested", { requestId, target: "under_sink" }),
		);
		const first = make("evidence.saved", {
			requestId,
			target: "under_sink",
			jpeg: "/9j/2Q==",
			seconds: 12,
		});
		const second = make("evidence.saved", {
			requestId,
			target: "under_sink",
			jpeg: "/9gB/9k=",
		});
		lose = true;
		await expect(appendEvent(session, first)).rejects.toThrow("lost response");
		await appendEvent(session, second);
		await appendEvent(session, second);
		expect(photos).toEqual([first, first]);
		expect(
			(await allEvents(session)).filter((e) => e.type === "evidence.saved"),
		).toHaveLength(1);
		await expect(
			appendEvent(
				session,
				make("evidence.saved", {
					requestId,
					target: "ventilation",
					jpeg: "/9j/2Q==",
				}),
			),
		).rejects.toThrow("Unknown request");
		await expect(
			appendEvent(
				session,
				make(
					"evidence.saved",
					{ requestId, target: "under_sink", jpeg: "/9j/2Q==" },
					randomUUID(),
				),
			),
		).rejects.toThrow("Unknown request");
		await expect(
			appendEvent(
				session,
				inspectionEvent.parse({
					...first,
					data: { ...first.data, jpeg: "/9gB/9k=" },
				}),
			),
		).rejects.toThrow("Conflicting event ID");
		await expect(
			appendEvent(
				session,
				inspectionEvent.parse({
					...second,
					data: { ...second.data, jpeg: "/9j/2Q==" },
				}),
			),
		).rejects.toThrow("Conflicting event ID");
	});
	it("recovers the same PATCH after an ambiguous job-card acknowledgement and replays canonical room names", async () => {
		let state = "",
			generation = 0,
			lose = false;
		const patches = new Map<string, string>();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL, init: RequestInit) => {
				const url = new URL(input);
				if (url.origin === link.origin) {
					expect(url.pathname).toBe(
						`/api/jobs/${link.job}/inspections/${link.visit}`,
					);
					const body = String(init.body);
					const { event } = JSON.parse(body);
					expect(Number.isInteger(event.capturedAt)).toBe(true);
					if (patches.has(event.id)) expect(patches.get(event.id)).toBe(body);
					patches.set(event.id, body);
					if (lose) {
						lose = false;
						throw Error("lost response");
					}
					return new Response(null, { status: 204 });
				}
				if (init.method === "POST") {
					if (+String(url.searchParams.get("ifGenerationMatch")) !== generation)
						return new Response(null, { status: 412 });
					generation++;
					state = String(init.body);
					return new Response(null, { status: 200 });
				}
				return new Response(state, {
					status: state ? 200 : 404,
					headers: { "x-goog-generation": String(generation) },
				});
			}),
		);
		const id = visitSessionId(link);
		await bindVisit(id, link);
		await bindVisit(id, link);
		const emit = (type: string, data: unknown) =>
			appendEvent(
				id,
				inspectionEvent.parse({
					id: randomUUID(),
					capturedAt: Date.now(),
					type,
					data,
					roomId: room,
				}),
			);
		await emit("room.upsert", { name: "Rom 1" });
		await emit("room.named", { name: "Loftet", source: "live" });
		await emit("room.named", { name: "Loftstua", source: "user" });
		await emit("room.upsert", { name: "Rom 1" });
		await emit("evidence.requested", { target: "under_sink", requestId });
		lose = true;
		await expect(
			emit("evidence.saved", {
				target: "under_sink",
				requestId,
				jpeg: "/9j/2Q==",
				seconds: 12,
			}),
		).rejects.toThrow("lost response");
		const events = await allEvents(id);
		expect(events[3].data.name).toBe("Loftstua");
		expect(events.at(-1)?.type).toBe("evidence.saved");
		expect(events.at(-1)?.data).not.toHaveProperty("jpeg");
		expect(page(events, 5)).toMatchObject({
			cursor: 6,
			events: [{ type: "evidence.saved" }],
		});
		expect(patches.size).toBe(6);
		await expect(
			emit("evidence.marked", {
				target: "under_sink",
				requestId,
				startSeconds: 10,
				endSeconds: 13,
			}),
		).rejects.toThrow("Already documented");
	});
});
