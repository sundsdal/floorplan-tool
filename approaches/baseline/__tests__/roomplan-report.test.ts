// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	options: undefined as
		| {
				model: string;
				callbacks: {
					onmessage: (message: {
						toolCall: { functionCalls: { name: string; args: unknown }[] };
					}) => void;
				};
		  }
		| undefined,
	inputs: [] as { text?: string; video?: unknown }[],
	close: vi.fn(),
	failConnect: false,
	report: undefined as unknown,
}));
vi.mock("@google/genai", () => ({
	GoogleGenAI: class {
		live = {
			connect: async (options: NonNullable<typeof mocks.options>) => {
				mocks.options = options;
				if (mocks.failConnect) throw new Error("private failure");
				return {
					sendRealtimeInput: (input: { text?: string; video?: unknown }) => {
						mocks.inputs.push(input);
						if (input.text)
							queueMicrotask(() =>
								options.callbacks.onmessage({
									toolCall: {
										functionCalls: [
											{ name: "submit_room_report", args: mocks.report },
										],
									},
								}),
							);
					},
					close: mocks.close,
				};
			},
		};
	},
	Modality: { AUDIO: "AUDIO" },
	Type: { OBJECT: "OBJECT", STRING: "STRING" },
}));

import { POST } from "@/app/api/roomplan/annotate/route";
import {
	createRoomReport,
	roomReportRequestSchema,
} from "@/lib/roomplan-report";

const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]).toString("base64");
const input = {
	frames: [jpeg, jpeg],
	roomPlan: { objects: ["toilet"], windowCount: 1 },
};
const valid = {
	name: "Bad",
	type: "bathroom",
	features: {
		fireplace: "not_observed",
		toilet: "observed",
		ventilation: "uncertain",
		windows: "not_observed",
	},
	summary: "Et bad med toalett.",
};

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv("GOOGLE_CLOUD_PROJECT", "test-project");
	mocks.inputs = [];
	mocks.failConnect = false;
	mocks.report = structuredClone(valid);
	mocks.close.mockReset();
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("RoomPlan room report", () => {
	it("sends sampled JPEGs to Gemini Live and returns the structured report", async () => {
		const pending = createRoomReport(input);
		await vi.advanceTimersByTimeAsync(2500);
		const report = await pending;
		expect(mocks.options?.model).toBe("gemini-3.8-live");
		expect(mocks.inputs.filter((item) => item.video)).toHaveLength(2);
		expect(mocks.inputs.at(-1)?.text).toContain("RoomPlan");
		expect(report).toEqual({
			...valid,
			features: { ...valid.features, windows: "observed" },
		});
		expect(mocks.close).toHaveBeenCalledOnce();
	});

	it("rejects invalid model output and closes the session", async () => {
		mocks.report = { ...valid, features: { ...valid.features, toilet: "yes" } };
		const pending = createRoomReport(input);
		const assertion = expect(pending).rejects.toThrow();
		await vi.advanceTimersByTimeAsync(2500);
		await assertion;
		expect(mocks.close).toHaveBeenCalledOnce();
	});

	it("bounds JPEG images and rejects malformed data", () => {
		expect(roomReportRequestSchema.safeParse(input).success).toBe(true);
		expect(
			roomReportRequestSchema.safeParse({ ...input, frames: [] }).success,
		).toBe(false);
		expect(
			roomReportRequestSchema.safeParse({ ...input, frames: ["not-an-image"] })
				.success,
		).toBe(false);
		expect(
			roomReportRequestSchema.safeParse({
				...input,
				frames: Array(13).fill(jpeg),
			}).success,
		).toBe(false);
	});

	it("validates input and does not expose model errors", async () => {
		mocks.failConnect = true;
		const response = await POST(
			new Request("http://localhost/api/roomplan/annotate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(input),
			}),
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: "Room analysis is unavailable.",
		});
	});
});
