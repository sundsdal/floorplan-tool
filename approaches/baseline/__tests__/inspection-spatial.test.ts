// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("google-auth-library", () => ({
	GoogleAuth: class {
		async getRequestHeaders() {
			return new Headers();
		}
	},
}));
vi.mock("@/lib/livekit-session", () => ({
	recordingPlaylist: () => ({
		bucket: "test",
		object: "captures/test/recording.m3u8",
	}),
}));

import {
	readSpatialSnapshot,
	saveSpatialSnapshot,
	spatialSnapshotSchema,
} from "@/lib/inspection-spatial";

const now = 1_795_430_000_000;
const fixture = {
	capturedAt: now,
	seconds: 15,
	location: {
		capturedAt: now,
		tracking: "tracked" as const,
		roomId: "9c0b46d0-d753-42dd-bc30-4508204eb446",
		roomName: "Bad",
		position: { x: 2, y: 1 },
		forward: { x: 0, y: -1 },
	},
	walls: [],
	windows: [],
	doors: [],
	rooms: [],
	image: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"),
};

afterEach(() => vi.unstubAllGlobals());

describe("inspection spatial snapshots", () => {
	it("writes only on matching storage generation and keeps the most recent map", async () => {
		let current: typeof fixture | null = null;
		let generation = 0;
		const fetch = vi.fn(async (url: string, init: RequestInit) => {
			if (init.method !== "POST")
				return current
					? Response.json(current, {
							headers: { "x-goog-generation": String(generation) },
						})
					: new Response(null, { status: 404 });
			expect(new URL(url).searchParams.get("ifGenerationMatch")).toBe(
				String(generation),
			);
			expect(new URL(url).searchParams.get("name")).toBe(
				"captures/test/spatial-latest.json",
			);
			generation++;
			current = JSON.parse(String(init.body));
			return new Response(null, { status: 200 });
		});
		vi.stubGlobal("fetch", fetch);
		expect(await saveSpatialSnapshot("test", fixture)).toEqual({
			capturedAt: now,
			accepted: true,
		});
		expect(
			await saveSpatialSnapshot("test", {
				...fixture,
				capturedAt: now - 1,
				location: { ...fixture.location, capturedAt: now - 1 },
			}),
		).toEqual({ capturedAt: now, accepted: false });
		expect(await readSpatialSnapshot("test")).toEqual(fixture);
		expect(generation).toBe(1);
	});

	it("rejects image-like text and inconsistent sensor timestamps", () => {
		expect(
			spatialSnapshotSchema.safeParse({ ...fixture, image: "abcd" }).success,
		).toBe(false);
		expect(
			spatialSnapshotSchema.safeParse({ ...fixture, capturedAt: now + 1 })
				.success,
		).toBe(false);
	});
});
