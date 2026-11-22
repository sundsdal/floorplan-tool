// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { materializeRecording, RecordingNotReady } from "@/lib/livekit-media";

describe("private recording materializer", () => {
	it("trims a real HLS recording to a playable audio and video clip", async () => {
		const dir = await mkdtemp(join(tmpdir(), "floorplan-test-"));
		const output = join(dir, "clip.mp4");
		try {
			execFileSync("ffmpeg", [
				"-hide_banner",
				"-loglevel",
				"error",
				"-f",
				"lavfi",
				"-i",
				"testsrc=size=160x120:rate=10",
				"-f",
				"lavfi",
				"-i",
				"sine=frequency=440",
				"-t",
				"8",
				"-c:v",
				"libx264",
				"-pix_fmt",
				"yuv420p",
				"-g",
				"20",
				"-c:a",
				"aac",
				"-f",
				"hls",
				"-hls_time",
				"2",
				"-hls_list_size",
				"0",
				"-hls_segment_filename",
				join(dir, "segment%03d.ts"),
				join(dir, "recording.m3u8"),
			]);
			await materializeRecording((name) => readFile(join(dir, name)), output, {
				range: { startSeconds: 2.5, endSeconds: 5.5 },
			});
			const probe = JSON.parse(
				execFileSync(
					"ffprobe",
					[
						"-v",
						"error",
						"-show_entries",
						"format=duration:stream=codec_type",
						"-of",
						"json",
						output,
					],
					{ encoding: "utf8" },
				),
			);
			expect(Number(probe.format.duration)).toBeCloseTo(3, 1);
			expect(
				probe.streams.map(
					(stream: { codec_type: string }) => stream.codec_type,
				),
			).toEqual(expect.arrayContaining(["video", "audio"]));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it("rejects unclosed final playlists and paths outside the session", async () => {
		await expect(
			materializeRecording(
				async () => Buffer.from("#EXTM3U\n#EXTINF:2,\nsegment_00000.ts\n"),
				"/tmp/unused.mp4",
				{ final: true },
			),
		).rejects.toBeInstanceOf(RecordingNotReady);
		await expect(
			materializeRecording(
				async () =>
					Buffer.from(
						"#EXTM3U\n#EXTINF:2,\n../segment_00000.ts\n#EXT-X-ENDLIST\n",
					),
				"/tmp/unused.mp4",
				{ final: true },
			),
		).rejects.toThrow("Invalid segment");
	});
});
