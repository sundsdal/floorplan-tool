import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	events: vi.fn(),
	append: vi.fn(),
	range: vi.fn(),
}));
vi.mock("@/lib/inspection-events", () => ({
	allEvents: mocks.events,
	appendEvent: mocks.append,
}));
vi.mock("@/lib/livekit-media", () => ({
	withRecordingRange: mocks.range,
	RecordingNotReady: class extends Error {},
}));
vi.mock("google-auth-library", () => ({
	GoogleAuth: class {
		async getRequestHeaders() {
			return new Headers();
		}
	},
}));

import { extractMarked } from "@/lib/inspection-extract";

let dir: string;
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "inspection-stills-"));
	const path = join(dir, "walk.mp4");
	execFileSync("ffmpeg", [
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		"testsrc=size=160x120:rate=10",
		"-t",
		"2",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		path,
	]);
	mocks.range.mockImplementation(async (_session, _range, callback) =>
		callback(path),
	);
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});
afterEach(() => {
	vi.unstubAllGlobals();
	mocks.append.mockClear();
});
it.each([
	[2, "evidence.saved"],
	[-1, "evidence.retry"],
])("handles the frame selection %s", async (index, type) => {
	const session = randomUUID(),
		id = randomUUID(),
		roomId = randomUUID(),
		requestId = randomUUID();
	const mark = {
		id,
		roomId,
		type: "evidence.marked",
		capturedAt: Date.now(),
		data: { target: "under_sink", requestId, startSeconds: 3, endSeconds: 5 },
	};
	mocks.events.mockResolvedValue([mark]);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url, init) => {
			const images = JSON.parse(init.body).contents[0].parts.filter(
				(p: { inlineData?: unknown }) => p.inlineData,
			);
			expect(images).toHaveLength(5);
			for (const image of images)
				expect(
					Buffer.from(image.inlineData.data, "base64").subarray(0, 2),
				).toEqual(Buffer.from([255, 216]));
			return Response.json({
				candidates: [
					{ content: { parts: [{ text: JSON.stringify({ index }) }] } },
				],
			});
		}),
	);
	await extractMarked(session, id);
	const result = mocks.append.mock.calls[0][1];
	expect(result).toMatchObject({ type, roomId, data: { requestId } });
	if (type === "evidence.saved") {
		expect(result.data.seconds).toBeCloseTo(3.9);
		expect(result.data.jpeg.length).toBeGreaterThan(100);
	}
	mocks.events.mockResolvedValue([mark, result]);
	await extractMarked(session, id);
	expect(mocks.append).toHaveBeenCalledTimes(1);
});
